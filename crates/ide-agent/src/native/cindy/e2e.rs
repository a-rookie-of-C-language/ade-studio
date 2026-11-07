//! Against the real `cindy-bridge`: `connect()` spawns
//! `node <dist>/agent/cindy-bridge/src/index.js` and drives it over ACP.
//!
//! Needs node on `PATH` and the built bridge (`pnpm build:bridge` from the
//! workspace root). Two live paths:
//! - Claude login present: create → prompt → cancel end to end (direct SDK).
//! - Local magpie gateway up (default http://127.0.0.1:3425) plus a spawnable
//!   `claude` binary (`CINDY_CLAUDE_PATH`, e.g. the SDK's platform exe in dev
//!   node_modules): a full turn through the gateway, no login needed.
//! - Neither: asserts the auth-error path, the bridge's honest answer.

use super::*;
use std::sync::atomic::AtomicUsize;

const WAIT: Duration = Duration::from_secs(300);

#[derive(Default)]
struct Seen {
    texts: Vec<String>,
    asked: AtomicUsize,
}

struct Client {
    seen: Arc<Mutex<Seen>>,
}

impl Handler for Client {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "session/update"
            && let Some(text) = params.pointer("/update/content/text").and_then(Value::as_str)
        {
            self.seen.lock().texts.push(text.to_owned());
        }
    }

    fn on_request(&self, method: &str, _params: Value) -> Result<Value, (i64, String)> {
        assert_eq!(method, "session/request_permission");
        self.seen.lock().asked.fetch_add(1, Ordering::SeqCst);
        // Fail closed, like production UI dismissal.
        Ok(json!({ "outcome": { "outcome": "cancelled" } }))
    }
}

fn bridge_entry() -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).expect("workspace root").to_path_buf();
    let entry = root
        .join("agent")
        .join("cindy-bridge")
        .join("dist")
        .join("agent")
        .join("cindy-bridge")
        .join("src")
        .join("index.js");
    assert!(
        entry.is_file(),
        "build the bridge first: `pnpm --filter cindy-bridge build` (missing {})",
        entry.display()
    );
    entry
}

/// A spawnable Claude binary for the live turn: `CINDY_CLAUDE_PATH`, else the
/// SDK's platform exe in dev node_modules. `None` when neither exists.
fn spawnable_claude() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CINDY_CLAUDE_PATH").map(PathBuf::from)
        && p.is_file()
    {
        return Some(p);
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2)?.to_path_buf();
    // npm's `claude` shim cannot be spawned without a shell; the SDK's own
    // platform binary can (dev only: release prunes it, see prune-deploy.js).
    let plat = if cfg!(windows) { "win32-x64" } else { return None };
    let cand = root
        .join("agent")
        .join("cindy-bridge")
        .join("node_modules")
        .join(".pnpm")
        .join(format!("@anthropic-ai+claude-agent-sdk-{plat}@0.3.292"))
        .join("node_modules")
        .join("@anthropic-ai")
        .join(format!("claude-agent-sdk-{plat}"))
        .join("claude.exe");
    cand.is_file().then_some(cand)
}

/// A magpie model that serves right now (quotas move): Claude family first.
/// `None` when the gateway is down or everything probed is dry.
async fn probe_working_model() -> Option<String> {
    use crate::native::cindy::magpie;
    let base = magpie::DEFAULT_MAGPIE_BASE_URL;
    let models = magpie::fetch_models(base, Duration::from_secs(15)).await.ok()?;
    let mut claude: Vec<_> = models.iter().filter(|m| m.id.contains("claude")).collect();
    claude.truncate(3);
    for m in claude {
        if magpie::probe_model(base, &m.id, Duration::from_secs(20)).await.is_ok() {
            return Some(m.id.clone());
        }
    }
    None
}

/// The bridge's own login check (`local-auth.ts`): existence only, no secrets read.
fn signed_in() -> bool {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let file = home.map(|h| h.join(".claude").join(".credentials.json")).is_some_and(|p| p.is_file());
    let env = std::env::var_os("ANTHROPIC_API_KEY").is_some_and(|v| !v.is_empty());
    file || env
}

#[tokio::test(flavor = "multi_thread")]
async fn real_bridge_create_prompt_cancel() {
    let node = crate::provider::resolve("node", &[]).expect("node on PATH for the cindy e2e");
    let entry = bridge_entry();
    // Live prerequisites: a login, or a serving magpie model plus a binary the
    // SDK can spawn. Anything else is the auth-error path.
    let login = signed_in();
    let serving: Option<String> = if login { None } else { probe_working_model().await };
    let live = login || serving.is_some();
    let exe = live.then(spawnable_claude).flatten();
    let mut env: Vec<(String, String)> = Vec::new();
    if let Some(model) = &serving {
        env.push(("CINDY_MODEL".into(), model.clone()));
    }
    if let Some(exe) = &exe {
        // The bridge resolves its binary from the process env; point it at a
        // spawnable one for the live turn (fake-bridge tests never exec it).
        // SAFETY: only this e2e spawns a real bridge.
        unsafe { std::env::set_var("CINDY_CLAUDE_PATH", exe) };
    }
    let spec = ProviderSpec {
        id: "cindy".into(),
        name: "Cindy".into(),
        driver: crate::provider::Driver::Cindy,
        command: node,
        args: vec![entry.to_string_lossy().into_owned()],
        env,
        install_dirs: Vec::new(),
        login_hint: "Run `claude` in a terminal and sign in.".into(),
        model_discovery: crate::provider::ModelDiscovery::None,
        source: crate::AgentSource::Builtin,
    };
    let seen = Arc::new(Mutex::new(Seen::default()));
    let client = connect(
        &spec,
        &std::env::temp_dir(),
        Arc::new(Client { seen: seen.clone() }),
        Box::new(|line| eprintln!("[cindy-e2e] {line}")),
    )
    .expect("spawn the bridge");
    let init: Value = tokio::time::timeout(WAIT, client.request("initialize", json!({}), None))
        .await
        .expect("initialize answers")
        .unwrap();
    assert_eq!(init["agentInfo"]["name"], "cindy");

    let new: Result<Value, RpcError> = tokio::time::timeout(
        WAIT,
        client.request("session/new", json!({ "cwd": std::env::temp_dir(), "mcpServers": [] }), None),
    )
    .await
    .expect("session/new answers");
    if !live {
        // The honest answer without a login or a serving gateway: the sign-in
        // hint mapping keys on it.
        let err = new.unwrap_err();
        assert!(err.to_string().to_lowercase().contains("authent"), "needs auth text, got {err}");
        return;
    }
    let new = new.unwrap();
    let session = new["sessionId"].as_str().expect("session id").to_owned();

    // A turn that needs no tools.
    let turn: Value = tokio::time::timeout(
        WAIT,
        client.request(
            "session/prompt",
            json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "Reply with exactly: READY" }] }),
            None,
        ),
    )
    .await
    .expect("prompt answers")
    .unwrap();
    // The bridge forwards the SDK's turn subtype verbatim (here: "success").
    assert!(turn["stopReason"].as_str().is_some_and(|s| !s.is_empty()), "{turn:?}");
    let texts = seen.lock().texts.join("");
    assert!(texts.to_lowercase().contains("ready"), "agent replied READY, got {texts:?}");

    // A cancel that beats its prompt stops it before the bridge is involved.
    client.notify("session/cancel", json!({ "sessionId": session })).unwrap();
    let cancelled: Value = tokio::time::timeout(
        WAIT,
        client.request(
            "session/prompt",
            json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "x" }] }),
            None,
        ),
    )
    .await
    .expect("cancelled prompt answers")
    .unwrap();
    assert_eq!(cancelled["stopReason"], "cancelled");

    client.request::<_, Value>("session/close", json!({ "sessionId": session }), None).await.unwrap();
    client.kill();
    // SAFETY: see the set_var above.
    unsafe { std::env::remove_var("CINDY_CLAUDE_PATH") };
}
