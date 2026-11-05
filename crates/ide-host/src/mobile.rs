use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use base64::Engine as _;
use crypto_box::aead::Aead as _;
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
/// v2 made E2EE mandatory: after a plaintext `e2ee_hello` / `e2ee_ready` every
/// frame is NaCl-box encrypted. Bump on breaking changes; additive commands do not bump it.
pub const MOBILE_PROTOCOL: u32 = 2;

/// Default bind when `--mobile` is passed without `--mobile-bind`.
pub const DEFAULT_BIND: &str = "127.0.0.1:6768";

/// A pairing code is single-use and expires quickly (same idea as Orca's one-time code).
const PAIRING_TTL: Duration = Duration::from_secs(300);

/// One paired phone. `seen` flips on the first `initialize`: rows that never
/// finished pairing back the QR offer and are reused across restarts (Orca
/// reuses never-scanned pending tokens instead of orphaning credentials).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileDevice {
    pub name: String,
    pub created_at: u64,
    #[serde(default)]
    pub seen: bool,
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

    /// Mark a token used after its first `initialize`.
    pub fn mark_seen(&self, token: &str) {
        let mut devices = self.devices.lock();
        if let Some(device) = devices.get_mut(token) {
            device.seen = true;
        }
        drop(devices);
        self.save();
    }

    /// The token baked into the QR pairing offer: reuse one that never
    /// completed `initialize` so restarts do not orphan credentials.
    pub fn pending_token(&self, name: String) -> String {
        if let Some(token) =
            self.devices.lock().iter().find_map(|(token, device)| (!device.seen).then(|| token.clone()))
        {
            return token;
        }
        self.add(name)
    }

    pub fn add(&self, name: String) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        self.devices.lock().insert(token.clone(), MobileDevice { name, created_at: now, seen: false });
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

/// E2EE: NaCl `crypto_box` (Curve25519-XSalsa20-Poly1305), wire-compatible with
/// tweetnacl's `box.before` / `box.after`, which is what the Expo app uses (the
/// same construction as Orca's `mock-server-encryption.ts`).
const KEY_FILE: &str = "server.key";

/// The server's long-term identity key. Its public half is pinned by the phone
/// through the pairing URL, so a network attacker cannot MITM the hello.
pub struct ServerKeys {
    secret: crypto_box::SecretKey,
}

impl ServerKeys {
    pub fn load_or_create(config_dir: &std::path::Path) -> Self {
        let path = config_dir.join("mobile").join(KEY_FILE);
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(text.trim())
                && raw.len() == 32
            {
                let mut bytes = [0u8; 32];
                bytes.copy_from_slice(&raw);
                return Self { secret: crypto_box::SecretKey::from(bytes) };
            }
            tracing::warn!("mobile server key unreadable; minting a fresh one (phones must re-pair)");
        }
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("OS randomness for mobile E2EE");
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, base64::engine::general_purpose::STANDARD.encode(bytes));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Self { secret: crypto_box::SecretKey::from(bytes) }
    }

    pub fn public_b64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.secret.public_key().as_bytes())
    }
}

fn shared_box(secret: &crypto_box::SecretKey, client_pub_b64: &str) -> Result<crypto_box::SalsaBox, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(client_pub_b64.trim())
        .map_err(|_| "publicKeyB64 is not valid base64".to_owned())?;
    if raw.len() != 32 {
        return Err(format!("publicKeyB64 must decode to 32 bytes, got {}", raw.len()));
    }
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&raw);
    Ok(crypto_box::SalsaBox::new(&crypto_box::PublicKey::from(bytes), secret))
}

/// One encrypted frame: `base64(nonce24 || box_after(plaintext))`, the same layout
/// as Orca's `e2eeEncrypt`, so any NaCl-box client (tweetnacl, libsodium) interops.
fn e2ee_encrypt(shared: &crypto_box::SalsaBox, plaintext: &str) -> String {
    let mut nonce_raw = [0u8; 24];
    let _ = getrandom::fill(&mut nonce_raw);
    let nonce = *crypto_box::Nonce::from_slice(&nonce_raw);
    let mut out = Vec::with_capacity(24 + plaintext.len() + 16);
    out.extend_from_slice(&nonce_raw);
    out.extend_from_slice(&shared.encrypt(&nonce, plaintext.as_bytes()).unwrap_or_default());
    base64::engine::general_purpose::STANDARD.encode(out)
}

fn e2ee_decrypt(shared: &crypto_box::SalsaBox, frame: &str) -> Option<String> {
    let raw = base64::engine::general_purpose::STANDARD.decode(frame.trim()).ok()?;
    if raw.len() < 24 + 16 {
        return None;
    }
    let nonce = *crypto_box::Nonce::from_slice(&raw[..24]);
    let plain = shared.decrypt(&nonce, &raw[24..]).ok()?;
    String::from_utf8(plain).ok()
}

/// QR pairing offer, mirroring Orca's `PairingOffer` shape minus relay: the phone
/// pins `publicKeyB64` before deriving the shared secret, so pairing is TOFU-safe
/// on a LAN the user trusts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingOffer {
    v: u32,
    endpoint: String,
    #[serde(rename = "deviceToken")]
    pub device_token: String,
    #[serde(rename = "publicKeyB64")]
    pub public_key_b64: String,
}

pub fn pairing_url(endpoint: &str, device_token: &str, public_key_b64: &str) -> String {
    let offer = PairingOffer {
        v: 1,
        endpoint: endpoint.to_owned(),
        device_token: device_token.to_owned(),
        public_key_b64: public_key_b64.to_owned(),
    };
    let json = serde_json::to_string(&offer).unwrap_or_default();
    let code = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
    format!("openidea://pair?code={code}")
}

pub fn decode_pairing_url(url: &str) -> Option<PairingOffer> {
    let code = url.strip_prefix("openidea://pair?code=")?;
    let json = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(code).ok()?;
    serde_json::from_slice(&json).ok()
}

/// What goes into the QR: `ws://<reachable host>:<port>`. A `0.0.0.0` bind is
/// replaced with the default-route LAN address (UDP trick, no traffic is sent);
/// loopback binds stay loopback (emulator) with a hint to rebind for phones.
fn advertise_endpoint(bind: &str) -> (String, Option<String>) {
    let port = bind.rsplit(':').next().unwrap_or("6768");
    let host = bind.rsplit_once(':').map(|(h, _)| h.trim_matches(|c| c == '[' || c == ']').trim()).unwrap_or(bind);
    if host == "0.0.0.0" || host == "::" || host == "*" {
        if let Some(lan) = lan_ip() {
            return (format!("ws://{lan}:{port}"), None);
        }
        return (
            format!("ws://{host}:{port}"),
            Some("no LAN address found; the phone must reach this host explicitly".to_owned()),
        );
    }
    if host == "127.0.0.1" || host == "localhost" || host == "::1" {
        return (
            format!("ws://{host}:{port}"),
            Some(
                "loopback only reaches this machine (an emulator uses 10.0.2.2); for a phone use --mobile-bind <lan-ip>:6768"
                    .to_owned(),
            ),
        );
    }
    (format!("ws://{host}:{port}"), None)
}

fn lan_ip() -> Option<std::net::IpAddr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // `connect` on UDP only selects the route; nothing is sent.
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|addr| addr.ip())
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
    pub keys: ServerKeys,
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
            keys: ServerKeys::load_or_create(config_dir),
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
    let listener = TcpListener::bind(bind).await.map_err(|e| IdeError::internal(format!("mobile bind {bind}: {e}")))?;
    let state = Arc::new(MobileState::new(host, dispatcher, &config_dir));
    serve_mobile_on(listener, state).await
}

/// Serves on an already-bound listener (tests bind an ephemeral port).
pub async fn serve_mobile_on(listener: TcpListener, state: Arc<MobileState>) -> IdeResult<()> {
    let bind = listener.local_addr().map(|addr| addr.to_string()).unwrap_or_default();
    // A fresh pairing code on every start: the phone uses it once, then its token.
    let code = state.codes.mint();
    // The QR path: a never-used token, reused across restarts until first use.
    let pending = state.devices.pending_token("phone".to_owned());
    let (endpoint, hint) = advertise_endpoint(&bind);
    let url = pairing_url(&endpoint, &pending, &state.keys.public_b64());
    tracing::info!("mobile companion listening on {bind}");
    eprintln!("openidea-server mobile on {bind}");
    eprintln!("pairing url: {url}");
    if let Some(hint) = hint {
        eprintln!("mobile note: {hint}");
    }
    eprintln!("manual pairing code {code} (valid 5 min)");
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

/// First frame (plaintext): `{"type":"e2ee_hello","publicKeyB64":"..."}`.
/// Answers plaintext `e2ee_ready` carrying this server's public key, so a phone
/// pairing with a typed-in code (no QR to pin) can still derive the shared
/// secret (TOFU: the UI must warn the network is trusted). QR phones ignore the
/// advertised key and use the pinned one from the pairing URL instead; anything
/// else closes the connection, since v2 has no plaintext protocol to fall back to.
async fn read_hello(
    state: &Arc<MobileState>,
    ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
) -> IdeResult<Option<crypto_box::SalsaBox>> {
    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| IdeError::internal(format!("mobile read: {e}")))?;
        if !msg.is_text() {
            continue;
        }
        let text = msg.into_text().map_err(|e| IdeError::internal(format!("mobile text: {e}")))?;
        let hello: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if hello.get("type").and_then(Value::as_str) != Some("e2ee_hello") {
            let _ = ws.send(Message::text(r#"{"type":"e2ee_error","message":"expected e2ee_hello"}"#)).await;
            return Ok(None);
        }
        let pub_b64 = hello.get("publicKeyB64").and_then(Value::as_str).unwrap_or("");
        match shared_box(&state.keys.secret, pub_b64) {
            Ok(shared) => {
                let ready = serde_json::json!({"type": "e2ee_ready", "publicKeyB64": state.keys.public_b64()});
                let _ = ws.send(Message::text(ready.to_string())).await;
                return Ok(Some(shared));
            }
            Err(detail) => {
                let _ = ws.send(Message::text(format!(r#"{{"type":"e2ee_error","message":{detail:?}}}"#))).await;
                return Ok(None);
            }
        }
    }
    Ok(None)
}

async fn handle_conn(state: Arc<MobileState>, stream: tokio::net::TcpStream) -> IdeResult<()> {
    let mut ws = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| IdeError::internal(format!("mobile handshake: {e}")))?;
    // Phase 1 (plaintext): `e2ee_hello` carries the phone's Curve25519 public key.
    // Nothing else is accepted before the shared secret exists (protocol v2).
    let shared = match read_hello(&state, &mut ws).await? {
        Some(shared) => shared,
        None => return Ok(()),
    };
    let shared = std::sync::Arc::new(shared);
    let (mut sink, mut input) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    // One ordered queue for replies, `$channel` streams and subscription batches;
    // the writer encrypts every frame, so handlers stay plaintext.
    let read_shared = std::sync::Arc::clone(&shared);
    let writer = tokio::spawn(async move {
        while let Some(plain) = rx.recv().await {
            if sink.send(Message::text(e2ee_encrypt(&shared, &plain))).await.is_err() {
                break;
            }
        }
    });
    // `$channel` values and subscription batches share one ordered queue with replies.
    let tx_for_sender = tx.clone();
    let sender: MobileChannelSender = Arc::new(move |id: u64, data: Value| {
        let _ = tx_for_sender.send(event_line("channel", serde_json::json!({ "id": id, "data": data })));
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
        let plain = match e2ee_decrypt(&read_shared, &text) {
            Some(plain) => plain,
            None => continue,
        };
        let req: WireReq = match serde_json::from_str(&plain) {
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
        // First encrypted frame: the phone proves token possession (Orca: `e2ee_auth`).
        // Manual pairing also happens here: `pair.exchange` runs on the encrypted
        // channel before the phone owns a token.
        "e2ee_auth" => {
            let token: String = param(&req.params, "deviceToken").unwrap_or_default();
            if state.devices.contains(token.trim()) {
                *authed = true;
                let _ = tx.send(ok(&id, serde_json::json!({ "authenticated": true })));
            } else {
                let _ = tx.send(err(&id, 401, "unknown device: pair again from the desktop"));
            }
        }
        // Handshake: both sides check the protocol version, then the token counts as used.
        "initialize" => {
            if !*authed {
                let _ = tx.send(err(&id, 401, "call e2ee_auth first"));
                return;
            }
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
            state.devices.mark_seen(token.trim());
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
            let _ = tx.send(err(&id, 401, "pair this phone first (e2ee_auth, then initialize)"));
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

    #[test]
    fn e2ee_frame_roundtrip_between_two_parties() {
        // Server and phone each hold their own key; both derive the same secret.
        let mut server_raw = [0u8; 32];
        getrandom::fill(&mut server_raw).unwrap();
        let server_secret = crypto_box::SecretKey::from(server_raw);
        let mut client_raw = [0u8; 32];
        getrandom::fill(&mut client_raw).unwrap();
        let client_secret = crypto_box::SecretKey::from(client_raw);
        let client_pub_b64 = base64::engine::general_purpose::STANDARD.encode(client_secret.public_key().as_bytes());

        let server_shared = shared_box(&server_secret, &client_pub_b64).unwrap();
        let server_pub_b64 = base64::engine::general_purpose::STANDARD.encode(server_secret.public_key().as_bytes());
        let client_shared = {
            let raw = base64::engine::general_purpose::STANDARD.decode(&server_pub_b64).unwrap();
            let mut bytes = [0u8; 32];
            bytes.copy_from_slice(&raw);
            crypto_box::SalsaBox::new(&crypto_box::PublicKey::from(bytes), &client_secret)
        };

        let frame = e2ee_encrypt(&server_shared, r#"{"id":1,"result":{"pong":true}}"#);
        assert_eq!(e2ee_decrypt(&client_shared, &frame).unwrap(), r#"{"id":1,"result":{"pong":true}}"#);
        let back = e2ee_encrypt(&client_shared, "ping");
        assert_eq!(e2ee_decrypt(&server_shared, &back).unwrap(), "ping");

        assert!(e2ee_decrypt(&server_shared, "not-base64!!").is_none());
        // A frame from a stranger's secret does not open.
        let mut other_raw = [0u8; 32];
        getrandom::fill(&mut other_raw).unwrap();
        let stranger = crypto_box::SalsaBox::new(&crypto_box::PublicKey::from(other_raw), &client_secret);
        assert!(e2ee_decrypt(&stranger, &frame).is_none());
    }

    #[test]
    fn pairing_url_roundtrip() {
        let url = pairing_url("ws://192.168.1.20:6768", "tok-123", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=");
        assert!(url.starts_with("openidea://pair?code="));
        let offer = decode_pairing_url(&url).unwrap();
        assert_eq!(offer.endpoint, "ws://192.168.1.20:6768");
        assert_eq!(offer.device_token, "tok-123");
        assert_eq!(offer.public_key_b64, "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=");
        assert!(decode_pairing_url("orca://pair?code=abc").is_none());
        assert!(decode_pairing_url("openidea://pair?code=!!!").is_none());
    }

    #[test]
    fn pending_token_is_reused_until_seen() {
        let dir = tempfile::tempdir().unwrap();
        let store = DeviceStore::load(dir.path());
        let first = store.pending_token("phone".to_owned());
        assert_eq!(store.pending_token("phone".to_owned()), first);
        store.mark_seen(&first);
        let second = store.pending_token("phone".to_owned());
        assert_ne!(second, first);
    }

    async fn next_decrypted(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        shared: &crypto_box::SalsaBox,
    ) -> Value {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next()).await.unwrap().unwrap().unwrap();
        let text = msg.into_text().unwrap();
        let plain = e2ee_decrypt(shared, &text).expect("server frame decrypts");
        serde_json::from_str(&plain).unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn e2e_encrypted_handshake_pair_and_ping() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("app");
        let host = Arc::new(crate::Host::new(crate::HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        let state = Arc::new(MobileState::new(host, Dispatcher::standard(), &base.join("config")));
        let code = state.codes.mint();
        let server_pub_b64 = state.keys.public_b64();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve_mobile_on(listener, state));

        // The phone: fresh Curve25519 identity, server key pinned from the QR.
        let mut client_raw = [0u8; 32];
        getrandom::fill(&mut client_raw).unwrap();
        let client_secret = crypto_box::SecretKey::from(client_raw);
        let client_pub_b64 = base64::engine::general_purpose::STANDARD.encode(client_secret.public_key().as_bytes());
        let raw = base64::engine::general_purpose::STANDARD.decode(&server_pub_b64).unwrap();
        let mut server_raw = [0u8; 32];
        server_raw.copy_from_slice(&raw);
        let shared = crypto_box::SalsaBox::new(&crypto_box::PublicKey::from(server_raw), &client_secret);

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}")).await.unwrap();
        let enc = |value: serde_json::Value| Message::text(e2ee_encrypt(&shared, &value.to_string()));

        ws.send(Message::text(format!(r#"{{"type":"e2ee_hello","publicKeyB64":"{client_pub_b64}"}}"#))).await.unwrap();
        let ready = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        assert!(ready.contains("e2ee_ready"), "unexpected: {ready}");

        ws.send(enc(serde_json::json!({"id": 1, "method": "pair.exchange", "params": {"code": code, "name": "e2e"}})))
            .await
            .unwrap();
        let exchanged = next_decrypted(&mut ws, &shared).await;
        let token = exchanged["result"]["deviceToken"].as_str().unwrap().to_owned();

        ws.send(enc(serde_json::json!({"id": 2, "method": "e2ee_auth", "params": {"deviceToken": token}})))
            .await
            .unwrap();
        let authed = next_decrypted(&mut ws, &shared).await;
        assert_eq!(authed["result"]["authenticated"], true);

        ws.send(enc(
            serde_json::json!({"id": 3, "method": "initialize", "params": {"version": 2, "deviceToken": token}}),
        ))
        .await
        .unwrap();
        let hello = next_decrypted(&mut ws, &shared).await;
        assert_eq!(hello["result"]["protocol"], 2);

        ws.send(enc(serde_json::json!({"id": 4, "method": "ping"}))).await.unwrap();
        let pong = next_decrypted(&mut ws, &shared).await;
        assert_eq!(pong["result"]["pong"], true);

        server.abort();
    }
}
