use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use ide_core::IdeError;
use ide_core::{CancellationToken, IdeResult};

use crate::Host;
use crate::rpc::{Call, Dispatcher, MobileChannelSender};

/// Version of the mobile companion protocol (Orca-style `MOBILE_PROTOCOL_VERSION`).
/// Bump on breaking changes; additive commands do not bump it.
pub const MOBILE_PROTOCOL: u32 = 1;

/// Default bind when `--mobile` is passed without `--mobile-bind`.
pub const DEFAULT_BIND: &str = "127.0.0.1:6768";

/// A pairing code is single-use and expires quickly (same idea as Orca's one-time code).
const PAIRING_TTL: Duration = Duration::from_secs(300);

/// One paired phone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileDevice {
    pub name: String,
    pub created_at: u64,
}

/// `config_dir/mobile/devices.json`: token -> device.
#[derive(Debug, Default)]
pub struct DeviceStore {
    path: PathBuf,
    devices: parking_lot::Mutex<HashMap<String, MobileDevice>>,
}

impl DeviceStore {
    pub fn load(config_dir: &std::path::Path) -> Self {
        let path = config_dir.join("mobile").join("devices.json");
        let devices =
            std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Self { path, devices: parking_lot::Mutex::new(devices) }
    }

    fn save(&self) {
        let devices = self.devices.lock();
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&*devices) {
            let _ = std::fs::write(&self.path, text);
        }
    }

    pub fn contains(&self, token: &str) -> bool {
        self.devices.lock().contains_key(token)
    }

    pub fn add(&self, name: String) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        self.devices.lock().insert(token.clone(), MobileDevice { name, created_at: now });
        self.save();
        token
    }

    pub fn remove(&self, token: &str) -> bool {
        let hit = self.devices.lock().remove(token).is_some();
        if hit {
            self.save();
        }
        hit
    }
}

/// Single-use pairing codes: code -> expiry.
#[derive(Debug, Default)]
pub struct PairingCodes {
    codes: parking_lot::Mutex<HashMap<String, SystemTime>>,
}

impl PairingCodes {
    /// Mint a 6-digit code valid for [`PAIRING_TTL`].
    pub fn mint(&self) -> String {
        let code = {
            let bytes = uuid::Uuid::new_v4().into_bytes();
            let n = u32::from_ne_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) % 900_000 + 100_000;
            format!("{n:06}")
        };
        self.codes.lock().insert(code.clone(), SystemTime::now() + PAIRING_TTL);
        code
    }

    /// Consume a code; expired or unknown codes fail.
    pub fn consume(&self, code: &str) -> bool {
        let mut codes = self.codes.lock();
        match codes.remove(code.trim()) {
            Some(expiry) => SystemTime::now() <= expiry,
            None => false,
        }
    }
}
#[derive(Debug, Deserialize)]
struct WireReq {
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct WireError {
    code: i64,
    message: String,
}

/// Shared mobile state across connections.
pub struct MobileState {
    pub host: Arc<Host>,
    pub dispatcher: Dispatcher,
    pub devices: DeviceStore,
    pub codes: PairingCodes,
    logcat: parking_lot::Mutex<HashMap<u64, CancellationToken>>,
    sub_next: AtomicU64,
}

impl MobileState {
    pub fn new(host: Arc<Host>, dispatcher: Dispatcher, config_dir: &std::path::Path) -> Self {
        Self {
            host,
            dispatcher,
            devices: DeviceStore::load(config_dir),
            codes: PairingCodes::default(),
            logcat: parking_lot::Mutex::new(HashMap::new()),
            sub_next: AtomicU64::new(1),
        }
    }
}

fn ok(id: &Option<Value>, result: Value) -> String {
    let id = id.clone().unwrap_or(Value::Null);
    serde_json::json!({ "id": id, "result": result }).to_string()
}

fn err(id: &Option<Value>, code: i64, message: impl Into<String>) -> String {
    let id = id.clone().unwrap_or(Value::Null);
    let error = WireError { code, message: message.into() };
    serde_json::json!({ "id": id, "error": error }).to_string()
}

fn event_line(method: &str, params: Value) -> String {
    serde_json::json!({ "method": method, "params": params }).to_string()
}

fn param<T: serde::de::DeserializeOwned>(params: &Value, name: &str) -> IdeResult<T> {
    let v = params.get(name).cloned().unwrap_or(Value::Null);
    serde_json::from_value(v).map_err(|e| IdeError::invalid(format!("argument {name}: {e}")))
}

/// Serves the mobile companion protocol on `bind` until the process exits.
pub async fn serve_mobile(host: Arc<Host>, dispatcher: Dispatcher, bind: &str, config_dir: PathBuf) -> IdeResult<()> {
    let state = Arc::new(MobileState::new(host, dispatcher, &config_dir));
    // A fresh pairing code on every start: the phone uses it once, then its token.
    let code = state.codes.mint();
    tracing::info!("mobile companion listening on {bind}");
    eprintln!("openidea-server mobile on {bind} (pairing code {code}, valid 5 min)");
    let listener = TcpListener::bind(bind).await.map_err(|e| IdeError::internal(format!("mobile bind {bind}: {e}")))?;
    loop {
        let (stream, _peer) = listener.accept().await.map_err(|e| IdeError::internal(format!("mobile accept: {e}")))?;
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(state, stream).await {
                tracing::debug!("mobile connection ended: {e}");
            }
        });
    }
}

async fn handle_conn(state: Arc<MobileState>, stream: tokio::net::TcpStream) -> IdeResult<()> {
    let ws = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| IdeError::internal(format!("mobile handshake: {e}")))?;
    let (mut sink, mut input) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    // `$channel` values and subscription batches share one ordered queue with replies.
    let tx_for_sender = tx.clone();
    let sender: MobileChannelSender = Arc::new(move |id: u64, data: Value| {
        let _ = tx_for_sender.send(event_line("channel", serde_json::json!({ "id": id, "data": data })));
    });
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if sink.send(Message::text(line)).await.is_err() {
                break;
            }
        }
    });
    let mut authed = false;
    // No stdio peer on this path; streaming uses `sender` above.
    let peer = Arc::new(std::sync::OnceLock::<ide_jsonrpc::Peer>::new());
    while let Some(msg) = input.next().await {
        let msg = msg.map_err(|e| IdeError::internal(format!("mobile read: {e}")))?;
        if !msg.is_text() {
            continue;
        }
        let text = msg.into_text().map_err(|e| IdeError::internal(format!("mobile text: {e}")))?;
        let req: WireReq = match serde_json::from_str(&text) {
            Ok(req) => req,
            Err(_) => continue,
        };
        handle_req(&state, &mut authed, peer.clone(), &tx, &sender, req).await;
    }
    // The phone is gone: stop its `adb logcat` tails instead of leaking them.
    for cancel in state.logcat.lock().drain().map(|(_, cancel)| cancel) {
        cancel.cancel();
    }
    writer.abort();
    Ok(())
}
/// One request; direct replies go through `tx`, while `invoke` runs in the background
/// so a streaming command never blocks the read loop.
async fn handle_req(
    state: &Arc<MobileState>,
    authed: &mut bool,
    peer: Arc<std::sync::OnceLock<ide_jsonrpc::Peer>>,
    tx: &mpsc::UnboundedSender<String>,
    sender: &MobileChannelSender,
    req: WireReq,
) {
    let id = req.id.clone();
    match req.method.as_str() {
        // Pairing: no token yet. A code is single-use and expires after 5 minutes.
        "pair.exchange" => {
            let code: String = param(&req.params, "code").unwrap_or_default();
            let name: String = param(&req.params, "name").unwrap_or_default();
            let name = if name.trim().is_empty() { "phone".to_owned() } else { name.trim().to_owned() };
            if state.codes.consume(&code) {
                let token = state.devices.add(name);
                let _ = tx.send(ok(&id, serde_json::json!({ "deviceToken": token })));
            } else {
                let _ = tx.send(err(&id, 403, "invalid or expired pairing code"));
            }
        }
        // Handshake: the phone proves its token and both sides check the protocol version.
        "initialize" => {
            let version: u32 = param(&req.params, "version").unwrap_or(0);
            let token: String = param(&req.params, "deviceToken").unwrap_or_default();
            if !state.devices.contains(token.trim()) {
                let _ = tx.send(err(&id, 401, "unknown device: pair again from the desktop"));
                return;
            }
            if version != MOBILE_PROTOCOL {
                let _ = tx.send(err(
                    &id,
                    426,
                    format!("incompatible mobile protocol {version}: server speaks {MOBILE_PROTOCOL}"),
                ));
                return;
            }
            *authed = true;
            let info = crate::rpc::server_info();
            let _ = tx.send(ok(
                &id,
                serde_json::json!({
                    "protocol": MOBILE_PROTOCOL,
                    "serverVersion": info.version,
                    "serverProtocol": info.protocol,
                    "os": info.os,
                    "arch": info.arch,
                }),
            ));
        }
        "ping" => {
            let _ = tx.send(ok(&id, serde_json::json!({ "pong": true })));
        }
        _ if !*authed => {
            let _ = tx.send(err(&id, 401, "pair this phone first (pair.exchange + initialize)"));
        }
        // Mint a code for a second phone without re-pairing this one.
        "pair.code" => {
            let code = state.codes.mint();
            let _ = tx.send(ok(&id, serde_json::json!({ "code": code })));
        }
        "pair.remove" => {
            let token: String = param(&req.params, "deviceToken").unwrap_or_default();
            let removed = state.devices.remove(token.trim());
            let _ = tx.send(ok(&id, serde_json::json!({ "removed": removed })));
        }
        // Windows with an open project: the phone's host list.
        "mobile.projects" => {
            let infos: Vec<Value> = state
                .host
                .projects()
                .iter()
                .map(|p| serde_json::to_value(crate::ops::project::info(p)).unwrap_or(Value::Null))
                .collect();
            let _ = tx.send(ok(&id, Value::Array(infos)));
        }
        // What `adb` sees (needs the Android SDK platform-tools on this machine).
        "android.devices" => {
            let host = state.host.clone();
            let tx2 = tx.clone();
            let id2 = id.clone();
            tokio::spawn(async move {
                match host.blocking(ide_android::devices).await {
                    Ok(devices) => {
                        let _ = tx2.send(ok(&id2, serde_json::to_value(&devices).unwrap_or(Value::Null)));
                    }
                    Err(e) => {
                        let _ = tx2.send(err(&id2, -32000, e.to_string()));
                    }
                }
            });
        }
        "android.logcat_start" => {
            let serial: String = match param(&req.params, "serial") {
                Ok(s) => s,
                Err(e) => {
                    let _ = tx.send(err(&id, -32602, e.to_string()));
                    return;
                }
            };
            let clear: bool = param(&req.params, "clear").unwrap_or(false);
            let channel: u64 = match req.params.get("onBatch").and_then(|v| v.get("$channel")).and_then(Value::as_u64) {
                Some(channel) => channel,
                None => {
                    let _ = tx.send(err(&id, -32602, "argument onBatch: expected a channel"));
                    return;
                }
            };
            let serial = serial.trim().to_owned();
            if serial.is_empty() {
                let _ = tx.send(err(&id, -32602, "argument serial: expected a device serial"));
                return;
            }
            let sub = state.sub_next.fetch_add(1, Ordering::Relaxed);
            let cancel = CancellationToken::new();
            state.logcat.lock().insert(sub, cancel.clone());
            let sender2 = sender.clone();
            let tx2 = tx.clone();
            let state2 = state.clone();
            let id2 = id.clone();
            tokio::spawn(async move {
                let emit_lines = move |lines: Vec<ide_android::LogcatLine>| {
                    if let Ok(data) = serde_json::to_value(&lines) {
                        sender2(channel, data);
                    }
                };
                // `adb logcat` blocks; the daemon thread is freed on cancel or disconnect.
                let _ = tokio::task::spawn_blocking(move || {
                    let mut emit_lines = emit_lines;
                    let _ = ide_android::logcat(&serial, clear, &cancel, &mut emit_lines);
                })
                .await;
                state2.logcat.lock().remove(&sub);
                let _ = tx2.send(event_line("logcat.end", serde_json::json!({ "sub": sub })));
            });
            let _ = tx.send(ok(&id2, serde_json::json!({ "sub": sub })));
        }
        "android.logcat_stop" => {
            let sub: u64 = match param(&req.params, "sub") {
                Ok(s) => s,
                Err(e) => {
                    let _ = tx.send(err(&id, -32602, e.to_string()));
                    return;
                }
            };
            let cancelled = state.logcat.lock().remove(&sub).map(|c| c.cancel()).is_some();
            let _ = tx.send(ok(&id, serde_json::json!({ "stopped": cancelled })));
        }
        // Everything else reuses the remote dispatcher: terminals, runs, search, VCS...
        // Streaming args (`{ "$channel": id }`) arrive on this same socket via `sender`.
        "invoke" => {
            let window: String = param(&req.params, "window").unwrap_or_default();
            let cmd: String = match param(&req.params, "cmd") {
                Ok(cmd) => cmd,
                Err(e) => {
                    let _ = tx.send(err(&id, -32602, e.to_string()));
                    return;
                }
            };
            let args = req.params.get("args").cloned().unwrap_or(Value::Null);
            let state2 = state.clone();
            let tx2 = tx.clone();
            let sender2 = sender.clone();
            tokio::spawn(async move {
                let call = Call::new(state2.host.clone(), window, args, peer, Some(sender2));
                match state2.dispatcher.invoke(call, &cmd).await {
                    Ok(value) => {
                        let _ = tx2.send(ok(&id, value));
                    }
                    Err(e) => {
                        let _ = tx2.send(err(&id, -32000, e.to_string()));
                    }
                }
            });
        }
        other => {
            let _ = tx.send(err(&id, -32601, format!("unknown method {other}")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_code_is_single_use() {
        let codes = PairingCodes::default();
        let code = codes.mint();
        assert_eq!(code.len(), 6);
        assert!(codes.consume(&code));
        assert!(!codes.consume(&code));
    }

    #[test]
    fn pairing_code_rejects_unknown() {
        let codes = PairingCodes::default();
        assert!(!codes.consume("000000"));
    }

    #[test]
    fn device_store_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = DeviceStore::load(dir.path());
        let token = store.add("pixel".to_owned());
        assert!(store.contains(&token));
        assert!(!store.contains("nope"));

        let again = DeviceStore::load(dir.path());
        assert!(again.contains(&token));

        assert!(again.remove(&token));
        assert!(!again.contains(&token));
    }
}
