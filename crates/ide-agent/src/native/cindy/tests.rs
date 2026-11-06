//! The shim against a scripted fake bridge: the test drives the ACP side and
//! plays the bridge's stdout, asserting every in-frame the shim sends.

use super::frames::InFrame;
use super::*;
use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;
use tokio::io::AsyncWriteExt;

const WAIT: Duration = Duration::from_secs(20);

// ---------- the client side ----------

#[derive(Default)]
struct Seen {
    /// `(sessionId, update)`.
    updates: Vec<(String, Value)>,
    /// `session/request_permission` params.
    asked: Vec<Value>,
}

struct TestClient {
    seen: Arc<Mutex<Seen>>,
    /// Option ids to choose, in order (`None`: cancel the prompt).
    answers: Arc<Mutex<VecDeque<Option<&'static str>>>>,
    /// When set, `on_request` spins until released: lets the test land a
    /// dismissal before the answer is consumed (deterministic races only).
    hold: Arc<AtomicBool>,
}

impl Handler for TestClient {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "session/update" {
            let session = params["sessionId"].as_str().unwrap_or_default().to_owned();
            self.seen.lock().updates.push((session, params["update"].clone()));
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        assert_eq!(method, "session/request_permission");
        self.seen.lock().asked.push(params);
        let mut spins = 0;
        while self.hold.load(Ordering::SeqCst) && spins < 500 {
            std::thread::sleep(Duration::from_millis(10));
            spins += 1;
        }
        Ok(match self.answers.lock().pop_front().flatten() {
            Some(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
            None => json!({ "outcome": { "outcome": "cancelled" } }),
        })
    }
}

// ---------- the fake bridge ----------

/// The test's end of a scripted bridge: receives in-frames, plays out-frames.
struct FakeBridge {
    /// Lines the shim reads as the bridge's stdout.
    out: tokio::io::DuplexStream,
    /// In-frames the shim sent.
    inbox: mpsc::UnboundedReceiver<String>,
    exit_tx: Option<oneshot::Sender<Option<i32>>>,
}

impl FakeBridge {
    async fn send(&mut self, line: &str) {
        self.out.write_all(format!("{line}\n").as_bytes()).await.unwrap();
    }

    /// The next in-frame the shim sent.
    async fn next_in(&mut self) -> Value {
        let line =
            tokio::time::timeout(WAIT, self.inbox.recv()).await.expect("shim sent nothing").expect("bridge gone");
        serde_json::from_str(&line).expect("in-frame is JSON")
    }

    async fn expect_in(&mut self, type_: &str) -> Value {
        let v = self.next_in().await;
        assert_eq!(v["type"], type_, "{v}");
        v
    }

    /// EOF without an exit code: a killed process.
    fn crash(&mut self) {
        self.exit_tx.take();
    }
}

#[derive(Default)]
struct FakeLauncher {
    bridges: Mutex<VecDeque<FakeBridge>>,
}

impl Launcher for FakeLauncher {
    fn spawn(
        &self,
        _program: &str,
        _args: &[String],
        _cwd: &Path,
        _env: &[(String, String)],
        _stderr: mpsc::UnboundedSender<String>,
    ) -> io::Result<Spawned> {
        let (shim_side, test_side) = tokio::io::duplex(1 << 20);
        let (tx, rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = oneshot::channel();
        self.bridges.lock().push_back(FakeBridge { out: test_side, inbox: rx, exit_tx: Some(exit_tx) });
        Ok(Spawned { stdout: Box::new(shim_side), stdin_tx: tx, kill: Box::new(|| {}), exited: exit_rx })
    }
}

struct Harness {
    client: Peer,
    shim: Arc<Shim>,
    launcher: Arc<FakeLauncher>,
    seen: Arc<Mutex<Seen>>,
    answers: Arc<Mutex<VecDeque<Option<&'static str>>>>,
    hold: Arc<AtomicBool>,
    bridge: Option<FakeBridge>,
    cwd: PathBuf,
}

fn spec(env: Vec<(String, String)>) -> ProviderSpec {
    ProviderSpec {
        id: "cindy-test".into(),
        name: "Cindy".into(),
        driver: crate::provider::Driver::Cindy,
        command: "node".into(),
        args: vec!["bridge.js".into()],
        env,
        install_dirs: Vec::new(),
        login_hint: "Run `claude` in a terminal and sign in.".into(),
        model_discovery: crate::provider::ModelDiscovery::None,
        source: crate::AgentSource::Builtin,
    }
}

impl Harness {
    async fn connect(env: Vec<(String, String)>) -> Self {
        let launcher = Arc::new(FakeLauncher::default());
        let seen = Arc::new(Mutex::new(Seen::default()));
        let answers = Arc::new(Mutex::new(VecDeque::new()));
        let hold = Arc::new(AtomicBool::new(false));
        let cwd = std::env::temp_dir().join("openidea-cindy-test");
        let shim = Shim::new(
            build_config(&spec(env), &cwd),
            launcher.clone(),
            Arc::new(|line: String| eprintln!("[cindy] {line}")),
        );
        let client = super::super::serve(
            shim.clone(),
            Arc::new(TestClient { seen: seen.clone(), answers: answers.clone(), hold: hold.clone() }),
        );
        let init: Value = client
            .request("initialize", json!({ "protocolVersion": 1, "clientCapabilities": {} }), None)
            .await
            .unwrap();
        assert_eq!(init["agentInfo"]["name"], "cindy");
        assert_eq!(init["agentCapabilities"]["loadSession"], false);
        Self { client, shim, launcher, seen, answers, hold, bridge: None, cwd }
    }

    fn b(&mut self) -> &mut FakeBridge {
        self.bridge.as_mut().expect("bridge taken")
    }

    /// Takes the bridge the last spawn created (spawn is lazy: first `session/new`).
    async fn take_bridge(&mut self) {
        let bridge = tokio::time::timeout(WAIT, async {
            loop {
                if let Some(b) = self.launcher.bridges.lock().pop_front() {
                    return b;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("bridge spawned");
        self.bridge = Some(bridge);
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        tokio::time::timeout(WAIT, self.client.request(method, params, None)).await.unwrap_or(Err(RpcError::Timeout))
    }

    async fn notify(&self, method: &str, params: Value) {
        self.client.notify(method, params).unwrap();
        tokio::task::yield_now().await;
    }

    async fn new_session(&mut self) -> String {
        let handle = tokio::spawn({
            let client = self.client.clone();
            let cwd = self.cwd.clone();
            async move { client.request::<_, Value>("session/new", json!({ "cwd": cwd, "mcpServers": [] }), None).await }
        });
        self.take_bridge().await;
        let start = self.b().expect_in("start").await;
        // The session id is fresh; the start carries the default model.
        let session = start["session"].as_str().unwrap().to_owned();
        assert!(!session.is_empty());
        assert_eq!(start["model"], "sonnet");
        self.b().send(&format!(r#"{{"type":"started","session":"{session}","sdkSessionId":"sdk-1"}}"#)).await;
        let r = tokio::time::timeout(WAIT, handle).await.expect("join").unwrap().unwrap();
        assert_eq!(r["sessionId"], session);
        assert_eq!(r["configOptions"][0]["currentValue"], "sonnet");
        session
    }

    async fn prompt(&self, session: &str, text: &str) -> tokio::task::JoinHandle<Result<Value, RpcError>> {
        let client = self.client.clone();
        let session = session.to_owned();
        let text = text.to_owned();
        tokio::spawn(async move {
            client
                .request(
                    "session/prompt",
                    json!({ "sessionId": session, "prompt": [{ "type": "text", "text": text }] }),
                    None,
                )
                .await
        })
    }

    /// The session's live record (the tests live in the shim's module tree).
    fn session(&self, id: &str) -> Arc<Session> {
        self.shim.sessions.lock().get(id).cloned().expect("session known")
    }

    fn texts(&self, session: &str) -> String {
        self.seen
            .lock()
            .updates
            .iter()
            .filter(|(s, _)| s == session)
            .filter_map(|(_, u)| u.pointer("/content/text").and_then(Value::as_str))
            .collect()
    }

    async fn settle(&self) {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn session_new_starts_bridge_with_cwd_and_model() {
    let mut h = Harness::connect(vec![]).await;
    let session = h.new_session().await;
    assert!(!session.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn prompt_streams_text_and_tools_then_done() {
    let mut h = Harness::connect(vec![]).await;
    let session = h.new_session().await;
    let turn = h.prompt(&session, "hello").await;
    let got = h.b().expect_in("prompt").await;
    assert_eq!(got["session"], session);
    assert_eq!(got["text"], "hello");
    // Deltas stream, then the full text replaces the buffer without duplication.
    h.b().send(&format!(r#"{{"type":"text","session":"{session}","delta":"hel"}}"#)).await;
    h.b().send(&format!(r#"{{"type":"text","session":"{session}","delta":"lo"}}"#)).await;
    h.b()
        .send(&format!(r#"{{"type":"tool","session":"{session}","name":"Read","status":"started","toolUseId":"u1"}}"#))
        .await;
    h.b()
        .send(&format!(
            r#"{{"type":"tool","session":"{session}","name":"Read","status":"completed","toolUseId":"u1"}}"#
        ))
        .await;
    h.b().send(&format!(r#"{{"type":"text","session":"{session}","delta":"hello","final":true}}"#)).await;
    h.b().send(&format!(r#"{{"type":"done","session":"{session}","stopReason":"end_turn"}}"#)).await;
    let r = tokio::time::timeout(WAIT, turn).await.expect("join").unwrap().unwrap();
    assert_eq!(r["stopReason"], "end_turn");
    h.settle().await;
    assert_eq!(h.texts(&session), "hello");
    let updates: Vec<Value> = h.seen.lock().updates.iter().map(|(_, u)| u.clone()).collect();
    assert!(updates.iter().any(|u| u["sessionUpdate"] == "tool_call" && u["toolCallId"] == "u1"));
    assert!(updates.iter().any(|u| u["sessionUpdate"] == "tool_call_update" && u["status"] == "completed"));
}

#[tokio::test(flavor = "multi_thread")]
async fn permission_allow_sends_respond_allow() {
    let mut h = Harness::connect(vec![]).await;
    h.answers.lock().push_back(Some("allow"));
    let session = h.new_session().await;
    let turn = h.prompt(&session, "edit it").await;
    h.b().expect_in("prompt").await;
    h.b()
        .send(&format!(
            r#"{{"type":"permission","session":"{session}","id":"p1","toolName":"Edit","summary":"Edit a.rs"}}"#
        ))
        .await;
    let respond = h.b().expect_in("respond").await;
    assert_eq!(respond["permissionId"], "p1");
    assert_eq!(respond["decision"], "allow");
    h.b().send(&format!(r#"{{"type":"done","session":"{session}","stopReason":"end_turn"}}"#)).await;
    let r = tokio::time::timeout(WAIT, turn).await.expect("join").unwrap().unwrap();
    assert_eq!(r["stopReason"], "end_turn");
    h.settle().await;
    // The client saw exactly one permission request for p1.
    let asked: Vec<Value> = h.seen.lock().asked.clone();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["toolCall"]["toolCallId"], "p1");
}

#[tokio::test(flavor = "multi_thread")]
async fn permission_reject_sends_respond_deny() {
    let mut h = Harness::connect(vec![]).await;
    h.answers.lock().push_back(None); // cancel the client prompt
    let session = h.new_session().await;
    let turn = h.prompt(&session, "edit it").await;
    h.b().expect_in("prompt").await;
    h.b().send(&format!(r#"{{"type":"permission","session":"{session}","id":"p2","toolName":"Bash"}}"#)).await;
    let respond = h.b().expect_in("respond").await;
    assert_eq!(respond["decision"], "deny");
    h.b().send(&format!(r#"{{"type":"done","session":"{session}","stopReason":"end_turn"}}"#)).await;
    let r = tokio::time::timeout(WAIT, turn).await.expect("join").unwrap().unwrap();
    assert_eq!(r["stopReason"], "end_turn");
}

#[tokio::test(flavor = "multi_thread")]
async fn permission_dismissed_skips_respond() {
    let mut h = Harness::connect(vec![]).await;
    h.hold.store(true, Ordering::SeqCst); // the answer lands only when released
    h.answers.lock().push_back(Some("allow")); // ...too late
    let session = h.new_session().await;
    let turn = h.prompt(&session, "edit it").await;
    h.b().expect_in("prompt").await;
    h.b().send(&format!(r#"{{"type":"permission","session":"{session}","id":"p3","toolName":"Edit"}}"#)).await;
    // Wait until the client prompt is on screen, then dismiss it bridge-side.
    tokio::time::timeout(WAIT, async {
        while h.seen.lock().asked.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("ask reached the client");
    h.b().send(&format!(r#"{{"type":"permission_dismissed","session":"{session}","id":"p3"}}"#)).await;
    // The dismissal is ordered before the text on the same stream: once the
    // text shows, the dismissal was processed, so releasing the late allow
    // must not produce a respond.
    h.b().send(&format!(r#"{{"type":"text","session":"{session}","delta":"note"}}"#)).await;
    tokio::time::timeout(WAIT, async {
        while h.texts(&session) != "note" {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("echo processed");
    h.hold.store(false, Ordering::SeqCst);
    let none = tokio::time::timeout(Duration::from_millis(300), h.b().next_in()).await;
    assert!(none.is_err(), "no respond after dismissal, got {none:?}");
    h.b().send(&format!(r#"{{"type":"done","session":"{session}","stopReason":"end_turn"}}"#)).await;
    let r = tokio::time::timeout(WAIT, turn).await.expect("join").unwrap().unwrap();
    assert_eq!(r["stopReason"], "end_turn");
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_ends_the_turn_as_cancelled() {
    let mut h = Harness::connect(vec![]).await;
    let session = h.new_session().await;
    let turn = h.prompt(&session, "long task").await;
    h.b().expect_in("prompt").await;
    h.b().send(&format!(r#"{{"type":"text","session":"{session}","delta":"working"}}"#)).await;
    h.notify("session/cancel", json!({ "sessionId": session })).await;
    let cancel = h.b().expect_in("cancel").await;
    assert_eq!(cancel["session"], session);
    h.b().send(&format!(r#"{{"type":"done","session":"{session}","stopReason":"aborted"}}"#)).await;
    let r = tokio::time::timeout(WAIT, turn).await.expect("join").unwrap().unwrap();
    assert_eq!(r["stopReason"], "cancelled");
}

#[tokio::test(flavor = "multi_thread")]
async fn early_cancel_stops_a_prompt_that_lost_the_race() {
    let mut h = Harness::connect(vec![]).await;
    let session = h.new_session().await;
    h.notify("session/cancel", json!({ "sessionId": session })).await;
    let r = h
        .request("session/prompt", json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "x" }] }))
        .await
        .unwrap();
    assert_eq!(r["stopReason"], "cancelled");
    // The bridge never saw the prompt.
    let none = tokio::time::timeout(Duration::from_millis(200), h.b().next_in()).await;
    assert!(none.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_prompts_are_rejected() {
    let mut h = Harness::connect(vec![]).await;
    let session = h.new_session().await;
    let first = h.prompt(&session, "one").await;
    h.b().expect_in("prompt").await;
    let err = h
        .request("session/prompt", json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "two" }] }))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("already running"), "{err}");
    h.b().send(&format!(r#"{{"type":"done","session":"{session}","stopReason":"end_turn"}}"#)).await;
    tokio::time::timeout(WAIT, first).await.expect("join").unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn bridge_crash_fails_the_turn_and_marks_tools_failed() {
    let mut h = Harness::connect(vec![]).await;
    let session = h.new_session().await;
    let turn = h.prompt(&session, "work").await;
    h.b().expect_in("prompt").await;
    h.b()
        .send(&format!(r#"{{"type":"tool","session":"{session}","name":"Bash","status":"started","toolUseId":"u9"}}"#))
        .await;
    h.settle().await;
    // A killed process: stdout EOF, no exit code.
    h.b().crash();
    drop(h.bridge.take().unwrap().out);
    let err = tokio::time::timeout(WAIT, turn).await.expect("join").unwrap().unwrap_err();
    assert!(err.to_string().contains("bridge exited"), "{err}");
    h.settle().await;
    let updates: Vec<Value> = h.seen.lock().updates.iter().map(|(_, u)| u.clone()).collect();
    assert!(
        updates
            .iter()
            .any(|u| u["sessionUpdate"] == "tool_call_update" && u["toolCallId"] == "u9" && u["status"] == "failed"),
        "{updates:?}"
    );
    // The dead session stays dead: no silent resurrection.
    let err = h
        .request("session/prompt", json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "again" }] }))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("unknown session"), "{err}");
    // The next session respawns the bridge.
    let session2 = h.new_session().await;
    assert_ne!(session, session2);
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_start_error_keeps_auth_text() {
    let mut h = Harness::connect(vec![]).await;
    let handle = tokio::spawn({
        let client = h.client.clone();
        let cwd = h.cwd.clone();
        async move { client.request::<_, Value>("session/new", json!({ "cwd": cwd, "mcpServers": [] }), None).await }
    });
    h.take_bridge().await;
    let start = h.b().expect_in("start").await;
    let session = start["session"].as_str().unwrap().to_owned();
    h.b()
        .send(&format!(
            r#"{{"type":"error","session":"{session}","message":"start failed: claude-code not authenticated: no_key","terminal":true}}"#
        ))
        .await;
    let err = tokio::time::timeout(WAIT, handle).await.expect("join").unwrap().unwrap_err();
    assert!(err.to_string().contains("not authenticated"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_and_unknown_frames_are_ignored() {
    let mut h = Harness::connect(vec![]).await;
    let session = h.new_session().await;
    let turn = h.prompt(&session, "hi").await;
    h.b().expect_in("prompt").await;
    h.b().send("not json at all").await;
    h.b().send(r#"{"type":"nope","session":"?"}"#).await;
    h.b().send(r#"{"type":"text","session":"ghost","delta":"x"}"#).await;
    h.b().send(&format!(r#"{{"type":"text","session":"{session}","delta":"ok"}}"#)).await;
    h.b().send(&format!(r#"{{"type":"done","session":"{session}","stopReason":"end_turn"}}"#)).await;
    let r = tokio::time::timeout(WAIT, turn).await.expect("join").unwrap().unwrap();
    assert_eq!(r["stopReason"], "end_turn");
    h.settle().await;
    assert_eq!(h.texts(&session), "ok");
}

#[tokio::test(flavor = "multi_thread")]
async fn model_change_restarts_before_the_first_turn_only() {
    let mut h = Harness::connect(vec![]).await;
    let session = h.new_session().await;
    let set = tokio::spawn({
        let client = h.client.clone();
        let session = session.clone();
        async move {
            client
                .request::<_, Value>(
                    "session/set_config_option",
                    json!({ "sessionId": session, "configId": "model", "value": "opus" }),
                    None,
                )
                .await
        }
    });
    // The bridge session was replaced: close, then a start with the new model.
    assert_eq!(h.b().expect_in("close").await["type"], "close");
    let restart = h.b().expect_in("start").await;
    assert_eq!(restart["model"], "opus");
    h.b().send(&format!(r#"{{"type":"started","session":"{session}","sdkSessionId":"sdk-2"}}"#)).await;
    let r = tokio::time::timeout(WAIT, set).await.expect("join").unwrap().unwrap();
    assert_eq!(r["configOptions"][0]["currentValue"], "opus");
    h.settle().await;
    // Unknown settings and models are rejected.
    let err = h
        .request("session/set_config_option", json!({ "sessionId": session, "configId": "mode", "value": "x" }))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no setting"), "{err}");
    let err = h
        .request("session/set_config_option", json!({ "sessionId": session, "configId": "model", "value": "gpt-9" }))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no value"), "{err}");
    assert!(h.session(&session).st.lock().turns == 0);
    // After the first turn, changing the model needs a new task.
    let turn = h.prompt(&session, "go").await;
    h.b().expect_in("prompt").await;
    let err = h
        .request("session/set_config_option", json!({ "sessionId": session, "configId": "model", "value": "haiku" }))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("new task"), "{err}");
    h.b().send(&format!(r#"{{"type":"done","session":"{session}","stopReason":"end_turn"}}"#)).await;
    tokio::time::timeout(WAIT, turn).await.expect("join").unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn silent_bridge_times_out_session_new() {
    let h = Harness::connect(vec![("CINDY_START_TIMEOUT_MS".into(), "150".into())]).await;
    let err = h.request("session/new", json!({ "cwd": h.cwd, "mcpServers": [] })).await.unwrap_err();
    assert!(err.to_string().contains("did not answer"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn session_close_sends_close_and_ends() {
    let mut h = Harness::connect(vec![]).await;
    let session = h.new_session().await;
    h.request("session/close", json!({ "sessionId": session })).await.unwrap();
    assert_eq!(h.b().expect_in("close").await["type"], "close");
}

#[tokio::test(flavor = "multi_thread")]
async fn in_frames_are_single_line_json() {
    let line = InFrame::Prompt { session: "s".into(), text: "multi\nline".into() }.line();
    assert!(!line.contains('\n'));
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["text"], "multi\nline");
}
