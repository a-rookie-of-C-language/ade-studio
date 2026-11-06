//! Against the real `cindy-bridge`: `connect()` spawns
//! `node <dist>/agent/cindy-bridge/src/index.js` and drives it over ACP.
//!
//! Needs node on `PATH` and the built bridge (`pnpm --filter cindy-bridge build`
//! from the workspace root). When this machine holds a Claude login (the same
//! check the bridge uses: `~/.claude/.credentials.json` or `ANTHROPIC_API_KEY`),
//! runs create → prompt → cancel end to end; otherwise asserts the auth-error
//! path, which is the bridge's honest answer without a login.

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
    let spec = ProviderSpec {
        id: "cindy".into(),
        name: "Cindy".into(),
        driver: crate::provider::Driver::Cindy,
        command: node,
        args: vec![entry.to_string_lossy().into_owned()],
        env: Vec::new(),
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
    if !signed_in() {
        // The honest answer without a login: the sign-in hint mapping keys on it.
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
    assert_eq!(turn["stopReason"], "end_turn");
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
}
