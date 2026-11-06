//! Cindy driven through the `cindy-bridge` sidecar: `node <bridge>` speaks the
//! private v0 NDJSON protocol over stdio, behind an in-process ACP endpoint.
//!
//! Each ACP session maps to one bridge session (`start` on `session/new`,
//! `close` on `session/close`); all sessions share the shim's bridge process.
//! The task owns entries and worktrees; the bridge only holds live SDK handles.
//!
//! Failure semantics (spec §2, B3): the bridge dying fails in-flight turns and
//! marks their tool calls failed — the task keeps its entries and reports the
//! error. Nothing is silently rebuilt.

mod frames;
mod translate;

#[cfg(test)]
mod e2e;
#[cfg(test)]
mod tests;

use frames::{InFrame, OutFrame, parse_out_frame};
use ide_core::CancellationToken;
use ide_jsonrpc::{Handler, Peer, RpcError, codes};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::provider::ProviderSpec;

use translate::{TurnText, Update};

/// How long `session/new` waits for the bridge's `started` (node boot plus SDK init).
const START_TIMEOUT: Duration = Duration::from_secs(120);
/// A stop that arrives this long before its prompt (the two race) still stops it.
const EARLY_CANCEL: Duration = Duration::from_secs(2);
/// After `cancel`, a turn with no `done` is settled as cancelled.
const CANCEL_GRACE: Duration = Duration::from_secs(30);
/// Stderr lines kept for crash reports.
const STDERR_TAIL: usize = 20;

/// The default model sent in `start` frames (the bridge refuses to choose one).
const DEFAULT_MODEL: &str = "sonnet";
/// `spec.env` override for the default model (B4's `cindy.toml` supplies it).
const MODEL_ENV: &str = "CINDY_MODEL";
/// Models v0 offers (Claude aliases the vendored SDK accepts).
const MODELS: &[(&str, &str)] = &[("sonnet", "Sonnet"), ("opus", "Opus"), ("haiku", "Haiku")];
const MODEL_OPTION: &str = "model";

pub(crate) fn connect(
    spec: &ProviderSpec,
    cwd: &Path,
    client: Arc<dyn Handler>,
    on_stderr: Box<dyn Fn(String) + Send + Sync>,
) -> io::Result<Peer> {
    connect_with(spec, cwd, client, on_stderr, Arc::new(ProcessLauncher))
}

pub(crate) fn connect_with(
    spec: &ProviderSpec,
    cwd: &Path,
    client: Arc<dyn Handler>,
    on_stderr: Box<dyn Fn(String) + Send + Sync>,
    launcher: Arc<dyn Launcher>,
) -> io::Result<Peer> {
    if spec.args.is_empty() {
        return Err(io::Error::other("Cindy needs the bridge entry in its args"));
    }
    let shim = Shim::new(build_config(spec, cwd), launcher, Arc::from(on_stderr));
    Ok(super::serve(shim, client))
}

fn build_config(spec: &ProviderSpec, cwd: &Path) -> Config {
    Config {
        program: spec.resolve_command(),
        args: spec.args.clone(),
        env: spec.env.clone(),
        cwd: cwd.to_path_buf(),
        start_timeout: millis(&spec.env, "CINDY_START_TIMEOUT_MS", START_TIMEOUT),
        cancel_grace: millis(&spec.env, "CINDY_CANCEL_GRACE_MS", CANCEL_GRACE),
        default_model: default_model(spec),
    }
}
/// Tuning knob from the agent file env (also handy for slow first boots).
fn millis(env: &[(String, String)], key: &str, default: Duration) -> Duration {
    env.iter()
        .find(|(k, _)| k == key)
        .and_then(|(_, v)| v.parse::<u64>().ok())
        .filter(|&ms| ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(default)
}

fn default_model(spec: &ProviderSpec) -> String {
    let wanted = spec.env.iter().find(|(k, _)| k == MODEL_ENV).map(|(_, v)| v.as_str()).unwrap_or(DEFAULT_MODEL);
    if MODELS.iter().any(|(v, _)| *v == wanted) { wanted.to_owned() } else { DEFAULT_MODEL.to_owned() }
}

struct Config {
    program: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: PathBuf,
    start_timeout: Duration,
    cancel_grace: Duration,
    default_model: String,
}

/// How the shim starts its bridge. Production spawns `node <bridge>`; tests
/// inject a scripted fake. The trait only crosses `connect_with`, so no test
/// global leaks into production.
pub(crate) trait Launcher: Send + Sync + 'static {
    fn spawn(
        &self,
        program: &str,
        args: &[String],
        cwd: &Path,
        env: &[(String, String)],
        stderr: mpsc::UnboundedSender<String>,
    ) -> io::Result<Spawned>;
}

pub(crate) struct Spawned {
    /// The bridge's stdout (lines); EOF means the bridge is gone.
    pub stdout: Box<dyn AsyncRead + Unpin + Send>,
    /// Frames for the bridge's stdin; the launcher forwards them.
    pub stdin_tx: mpsc::UnboundedSender<String>,
    /// Kills the bridge (the whole process tree).
    pub kill: Box<dyn FnOnce() + Send + 'static>,
    /// Resolves with the exit code once the bridge reaps.
    pub exited: oneshot::Receiver<Option<i32>>,
}

/// `node <bridge>` as a `Launcher`.
struct ProcessLauncher;

impl Launcher for ProcessLauncher {
    fn spawn(
        &self,
        program: &str,
        args: &[String],
        cwd: &Path,
        env: &[(String, String)],
        stderr: mpsc::UnboundedSender<String>,
    ) -> io::Result<Spawned> {
        use tokio::process::Command;
        let resolved = crate::provider::resolve(program, &[])
            .filter(|p| Path::new(p).components().count() > 1)
            .unwrap_or_else(|| program.to_owned());
        let mut cmd = Command::new(&resolved);
        ide_core::process::prepare(cmd.as_std_mut());
        ide_core::process::own_group(cmd.as_std_mut());
        cmd.args(args)
            .current_dir(cwd)
            .envs(ide_core::process::shell_env())
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn()?;
        let pid = child.id().unwrap_or(0);
        let mut stdin = child.stdin.take().ok_or_else(|| io::Error::other("bridge stdin unavailable"))?;
        let stdout = child.stdout.take().ok_or_else(|| io::Error::other("bridge stdout unavailable"))?;
        let stderr_pipe = child.stderr.take().ok_or_else(|| io::Error::other("bridge stderr unavailable"))?;
        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(line) = stdin_rx.recv().await {
                if stdin.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        let (exit_tx, exit_rx) = oneshot::channel();
        tokio::spawn(async move {
            let mut err = BufReader::new(stderr_pipe).lines();
            let forward = async {
                while let Ok(Some(line)) = err.next_line().await {
                    if stderr.send(line).is_err() {
                        break;
                    }
                }
            };
            tokio::select! {
                _ = forward => {},
                status = child.wait() => {
                    let _ = exit_tx.send(status.ok().and_then(|s| s.code()));
                }
            }
        });
        Ok(Spawned {
            stdout: Box::new(stdout),
            stdin_tx,
            kill: Box::new(move || {
                std::mem::drop(tokio::task::spawn_blocking(move || ide_core::process::kill_tree_of(pid)));
            }),
            exited: exit_rx,
        })
    }
}

pub(super) struct Shim {
    me: Weak<Shim>,
    rt: tokio::runtime::Handle,
    config: Config,
    launcher: Arc<dyn Launcher>,
    on_stderr: Arc<dyn Fn(String) + Send + Sync>,
    client: OnceLock<Peer>,
    bridge: Mutex<Option<Arc<Bridge>>>,
    /// Spawning (or respawning) the bridge is serialized.
    spawning: tokio::sync::Mutex<()>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    closed: AtomicBool,
}

struct Bridge {
    stdin_tx: mpsc::UnboundedSender<String>,
    kill: Mutex<Option<Box<dyn FnOnce() + Send + 'static>>>,
    /// `started` waiters, by ACP session id.
    starting: Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    dead: AtomicBool,
}

struct Session {
    id: String,
    cwd: PathBuf,
    shim: Weak<Shim>,
    st: Mutex<State>,
}

struct State {
    /// The bridge session exists (`started` arrived).
    started: bool,
    failed: Option<String>,
    model: String,
    text: HashMap<bool, TurnText>,
    tools: translate::ToolTracker,
    turn: Option<Turn>,
    /// A stop that came while no turn ran.
    cancel_at: Option<Instant>,
    /// Turns sent so far (a model change after the first needs a new task).
    turns: u64,
    /// Client permission prompts in flight, by bridge permission id.
    asks: HashMap<String, CancellationToken>,
    /// Dismissed permissions: the client answer is dropped, not responded.
    dismissed: HashSet<String>,
}

struct Turn {
    done: Option<oneshot::Sender<TurnEnd>>,
    cancelled: bool,
}

#[derive(Debug, Clone, PartialEq)]
enum TurnEnd {
    Stop(String),
    Fail { message: String, data: Option<Value> },
}

type RpcResult = Result<Value, (i64, String, Option<Value>)>;

fn invalid(message: impl Into<String>) -> (i64, String, Option<Value>) {
    (codes::INVALID_PARAMS, message.into(), None)
}

fn internal(message: impl Into<String>) -> (i64, String, Option<Value>) {
    (codes::INTERNAL_ERROR, message.into(), None)
}

fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Shim {
    fn new(config: Config, launcher: Arc<dyn Launcher>, on_stderr: Arc<dyn Fn(String) + Send + Sync>) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            rt: tokio::runtime::Handle::current(),
            config,
            launcher,
            on_stderr,
            client: OnceLock::new(),
            bridge: Mutex::new(None),
            spawning: tokio::sync::Mutex::new(()),
            sessions: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        })
    }

    fn self_arc(&self) -> Option<Arc<Self>> {
        self.me.upgrade()
    }

    fn notify(&self, updates: Vec<Update>) {
        let Some(client) = self.client.get() else { return };
        for u in updates {
            let _ = client.notify("session/update", json!({ "sessionId": u.session, "update": u.update }));
        }
    }

    fn session(&self, params: &Value) -> Result<Arc<Session>, (i64, String, Option<Value>)> {
        let id = params.get("sessionId").and_then(Value::as_str).unwrap_or_default();
        self.sessions.lock().get(id).cloned().ok_or_else(|| invalid(format!("unknown session {id}")))
    }

    /// The live bridge, spawning (or respawning after a crash) it first.
    async fn ensure_bridge(self: &Arc<Self>) -> Result<Arc<Bridge>, String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("closed".into());
        }
        if let Some(b) = self.bridge.lock().as_ref().filter(|b| !b.dead.load(Ordering::Acquire)).cloned() {
            return Ok(b);
        }
        let _guard = self.spawning.lock().await;
        if let Some(b) = self.bridge.lock().as_ref().filter(|b| !b.dead.load(Ordering::Acquire)).cloned() {
            return Ok(b);
        }
        // Resolve late, so a `node` installed after the IDE started is found too.
        let program =
            crate::provider::resolve(&self.config.program, &[]).unwrap_or_else(|| self.config.program.clone());
        let (err_tx, mut err_rx) = mpsc::unbounded_channel::<String>();
        let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        let tail_writer = stderr_tail.clone();
        let forward_stderr = self.on_stderr.clone();
        tokio::spawn(async move {
            while let Some(line) = err_rx.recv().await {
                {
                    let mut tail = tail_writer.lock();
                    if tail.len() >= STDERR_TAIL {
                        tail.pop_front();
                    }
                    tail.push_back(line.clone());
                }
                forward_stderr(line);
            }
        });
        let spawned = self
            .launcher
            .spawn(&program, &self.config.args, &self.config.cwd, &self.config.env, err_tx)
            .map_err(|e| format!("Couldn't start Cindy (`{program}`): {e}"))?;
        let bridge = Arc::new(Bridge {
            stdin_tx: spawned.stdin_tx,
            kill: Mutex::new(Some(spawned.kill)),
            starting: Mutex::new(HashMap::new()),
            stderr_tail,
            dead: AtomicBool::new(false),
        });
        *self.bridge.lock() = Some(bridge.clone());
        let weak = Arc::downgrade(self);
        let reader_bridge = bridge.clone();
        self.rt.spawn(async move {
            let mut lines = BufReader::new(spawned.stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if let Some(me) = weak.upgrade() {
                            me.on_bridge_line(&reader_bridge, &line);
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        tracing::warn!("cindy bridge stdout: {e}");
                        break;
                    }
                }
            }
            if let Some(me) = weak.upgrade() {
                let code = spawned.exited.await.unwrap_or(None);
                me.on_bridge_gone(&reader_bridge, code);
            }
        });
        Ok(bridge)
    }

    fn send(&self, bridge: &Bridge, frame: InFrame) {
        if bridge.stdin_tx.send(frame.line()).is_err() {
            tracing::warn!("cindy bridge gone, dropping {} for {}", frame_line_type(&frame), frame.session());
        }
    }

    fn on_bridge_line(self: &Arc<Self>, bridge: &Arc<Bridge>, line: &str) {
        let Some(frame) = parse_out_frame(line) else {
            if !line.trim().is_empty() {
                tracing::warn!("cindy bridge: ignoring malformed line");
            }
            return;
        };
        match &frame {
            OutFrame::Started { session, sdk_session_id } => {
                if let Some(tx) = bridge.starting.lock().remove(session) {
                    let _ = tx.send(Ok(sdk_session_id.clone()));
                } else {
                    tracing::warn!("cindy bridge: started for unknown session {session}");
                }
            }
            OutFrame::Done { session, stop_reason } => {
                if let Some(s) = self.sessions.lock().get(session).cloned() {
                    s.turn_done(stop_reason.clone());
                }
            }
            OutFrame::Error { session, message, terminal } => {
                if *terminal {
                    if let Some(tx) = bridge.starting.lock().remove(session) {
                        let _ = tx.send(Err(message.clone()));
                    }
                    if let Some(s) = self.sessions.lock().get(session).cloned() {
                        s.turn_fail(message);
                    }
                } else if let Some(s) = self.sessions.lock().get(session).cloned() {
                    s.fold(&frame, self);
                }
            }
            OutFrame::Permission { session, id, tool_name, summary } => {
                if let Some(s) = self.sessions.lock().get(session).cloned() {
                    s.fold(&frame, self);
                    s.ask(self, id.clone(), tool_name.clone(), summary.clone());
                }
            }
            OutFrame::PermissionDismissed { session, id } => {
                if let Some(s) = self.sessions.lock().get(session).cloned() {
                    s.dismiss(id);
                }
            }
            OutFrame::Text { .. } | OutFrame::Tool { .. } => {
                if let Some(s) = self.sessions.lock().get(frame.session()).cloned() {
                    s.fold(&frame, self);
                }
            }
        }
    }

    /// The bridge exited or its stdout ended: fail every in-flight turn, keep the
    /// entries, and drop the dead sessions. The client connection stays up with
    /// its detailed error, and the next `session/new` respawns the bridge.
    fn on_bridge_gone(&self, bridge: &Arc<Bridge>, code: Option<i32>) {
        if bridge.dead.swap(true, Ordering::AcqRel) {
            return;
        }
        if self.bridge.lock().as_ref().is_some_and(|b| Arc::ptr_eq(b, bridge)) {
            *self.bridge.lock() = None;
        }
        let tail: Vec<String> = bridge.stderr_tail.lock().iter().cloned().collect();
        let mut report = match code {
            Some(c) => format!("the Cindy bridge exited (code {c})"),
            None => "the Cindy bridge exited".to_owned(),
        };
        if let Some(last) = tail.last() {
            report.push_str(": ");
            report.push_str(last);
        }
        for tx in bridge.starting.lock().drain().map(|(_, tx)| tx) {
            let _ = tx.send(Err(report.clone()));
        }
        let sessions: Vec<Arc<Session>> = self.sessions.lock().drain().map(|(_, s)| s).collect();
        for s in &sessions {
            let updates = s.st.lock().tools.fail_all(&s.id);
            self.notify(updates);
            s.turn_fail(&report);
        }
    }

    /// The client went away: the bridge and every session go with it.
    fn shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        if let Some(bridge) = self.bridge.lock().take() {
            bridge.dead.store(true, Ordering::Release);
            if let Some(kill) = bridge.kill.lock().take() {
                kill();
            }
            for tx in bridge.starting.lock().drain().map(|(_, tx)| tx) {
                let _ = tx.send(Err("closed".into()));
            }
        }
        let sessions: Vec<Arc<Session>> = self.sessions.lock().drain().map(|(_, s)| s).collect();
        for s in sessions {
            s.turn_fail("closed");
        }
    }

    fn handle(self: &Arc<Self>, method: &str, params: Value) -> RpcResult {
        let rt = &self.rt;
        match method {
            "initialize" => Ok(json!({
                "protocolVersion": 1,
                "agentCapabilities": {
                    "loadSession": false,
                    "promptCapabilities": { "image": false, "embeddedContext": false },
                    "sessionCapabilities": {},
                    "_meta": { "openidea": {} },
                },
                "agentInfo": { "name": "cindy", "title": "Cindy (Claude)" },
                "authMethods": [],
            })),
            "session/new" => {
                let id = new_uuid();
                let cwd =
                    params.get("cwd").and_then(Value::as_str).map_or_else(|| self.config.cwd.clone(), PathBuf::from);
                let cwd = std::fs::canonicalize(&cwd).unwrap_or(cwd);
                let session = Arc::new(Session::new(&id, cwd, self.config.default_model.clone(), Arc::downgrade(self)));
                if self.sessions.lock().insert(id.clone(), session.clone()).is_some() {
                    unreachable!("uuid collision");
                }
                rt.block_on(session.start(self)).map_err(|e| self.start_error(&id, e))?;
                Ok(json!({ "sessionId": id, "configOptions": session.st.lock().options() }))
            }
            "session/load" | "session/resume" => Err(invalid("Cindy sessions can't be loaded")),
            "session/fork" => Err((codes::METHOD_NOT_FOUND, "Cindy sessions can't be forked".into(), None)),
            "session/set_config_option" => {
                let session = self.session(&params)?;
                let option = params.get("configId").and_then(Value::as_str).unwrap_or_default().to_owned();
                let value = params.get("value").and_then(Value::as_str).ok_or_else(|| invalid("no value"))?.to_owned();
                rt.block_on(session.set(self, &option, &value)).map_err(invalid)?;
                Ok(json!({ "configOptions": session.st.lock().options() }))
            }
            "session/set_mode" => Err((codes::METHOD_NOT_FOUND, "Cindy has no modes in v0".into(), None)),
            "session/prompt" => {
                let session = self.session(&params)?;
                let prompt = params.get("prompt").cloned().unwrap_or_default();
                match rt.block_on(session.prompt(self, &prompt))? {
                    TurnEnd::Stop(reason) => Ok(json!({ "stopReason": reason })),
                    TurnEnd::Fail { message, data } => Err((codes::INTERNAL_ERROR, message, data)),
                }
            }
            "_openidea/steer" => Err((codes::METHOD_NOT_FOUND, "Cindy can't steer a running turn in v0".into(), None)),
            "_openidea/rollback" => Err((codes::METHOD_NOT_FOUND, "Cindy can't roll back turns in v0".into(), None)),
            "session/close" => {
                if let Ok(s) = self.session(&params) {
                    self.sessions.lock().remove(&s.id);
                    s.close(self);
                }
                Ok(json!({}))
            }
            _ => Err((codes::METHOD_NOT_FOUND, format!("unsupported method {method}"), None)),
        }
    }

    /// Why a session could not start; it is dropped. Auth text is preserved so the
    /// task maps it to the sign-in hint (like the Claude driver's).
    fn start_error(&self, id: &str, e: String) -> (i64, String, Option<Value>) {
        self.sessions.lock().remove(id);
        internal(e)
    }

    fn cancel(self: &Arc<Self>, params: &Value) {
        let id = params.get("sessionId").and_then(Value::as_str).unwrap_or_default();
        if let Some(s) = self.sessions.lock().get(id) {
            s.cancel(self);
        }
    }
}

fn frame_line_type(frame: &InFrame) -> &'static str {
    match frame {
        InFrame::Start { .. } => "start",
        InFrame::Prompt { .. } => "prompt",
        InFrame::Respond { .. } => "respond",
        InFrame::Cancel { .. } => "cancel",
        InFrame::Close { .. } => "close",
    }
}

impl super::Shim for Shim {
    fn attach(&self, client: Peer) {
        let _ = self.client.set(client.clone());
        let weak = self.me.clone();
        tokio::spawn(async move {
            client.closed().await;
            if let Some(me) = weak.upgrade() {
                me.shutdown();
            }
        });
    }
}

impl Handler for Shim {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "session/cancel"
            && let Some(me) = self.self_arc()
        {
            me.cancel(&params);
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        self.on_request_with_data(method, params).map_err(|(c, m, _)| (c, m))
    }

    fn on_request_with_data(&self, method: &str, params: Value) -> RpcResult {
        let me = self.self_arc().ok_or_else(|| internal("closed"))?;
        me.handle(method, params)
    }
}

impl Session {
    fn new(id: &str, cwd: PathBuf, model: String, shim: Weak<Shim>) -> Self {
        Self {
            id: id.to_owned(),
            cwd,
            shim,
            st: Mutex::new(State {
                started: false,
                failed: None,
                model,
                text: HashMap::new(),
                tools: translate::ToolTracker::default(),
                turn: None,
                cancel_at: None,
                turns: 0,
                asks: HashMap::new(),
                dismissed: HashSet::new(),
            }),
        }
    }

    fn shim(&self) -> Option<Arc<Shim>> {
        self.shim.upgrade()
    }

    fn check(&self) -> Result<(), String> {
        let st = self.st.lock();
        if let Some(e) = &st.failed {
            return Err(e.clone());
        }
        if !st.started {
            return Err("the Cindy session never started".into());
        }
        Ok(())
    }

    fn config_options(model: &str) -> Value {
        Value::Array(vec![json!({
            "id": MODEL_OPTION,
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": model,
            "options": MODELS.iter().map(|(v, n)| json!({ "value": v, "name": n })).collect::<Vec<_>>(),
        })])
    }

    /// Sends `start` and waits for `started`.
    async fn start(self: &Arc<Self>, shim: &Arc<Shim>) -> Result<(), String> {
        let bridge = shim.ensure_bridge().await?;
        let (model, cwd) = {
            let st = self.st.lock();
            (st.model.clone(), self.cwd.clone())
        };
        let (tx, rx) = oneshot::channel();
        bridge.starting.lock().insert(self.id.clone(), tx);
        shim.send(&bridge, InFrame::Start { session: self.id.clone(), cwd: cwd.to_string_lossy().into_owned(), model });
        let timeout = shim.config.start_timeout;
        let sdk = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(id))) => id,
            Ok(Ok(Err(e))) => return Err(e),
            Ok(Err(_)) => return Err("the Cindy bridge exited".into()),
            Err(_) => {
                bridge.starting.lock().remove(&self.id);
                return Err(format!("the Cindy bridge did not answer within {}s", timeout.as_secs()));
            }
        };
        let _ = sdk;
        self.st.lock().started = true;
        Ok(())
    }

    /// Sends `close`, fails the turn, drops the permission prompts.
    fn close(&self, shim: &Arc<Shim>) {
        if let Some(bridge) = shim.bridge.lock().as_ref().filter(|b| !b.dead.load(Ordering::Acquire)).cloned() {
            shim.send(&bridge, InFrame::Close { session: self.id.clone() });
        }
        self.turn_fail("the Cindy session closed");
        let mut st = self.st.lock();
        for (_, token) in st.asks.drain() {
            token.cancel();
        }
        st.dismissed.clear();
    }

    async fn set(self: &Arc<Self>, shim: &Arc<Shim>, option: &str, value: &str) -> Result<(), String> {
        if option != MODEL_OPTION {
            return Err(format!("no setting {option}"));
        }
        if !MODELS.iter().any(|(v, _)| *v == value) {
            return Err(format!("{option} has no value {value}"));
        }
        let restart = {
            let st = self.st.lock();
            if st.model == value {
                return Ok(());
            }
            if st.turns > 0 {
                return Err("changing the model needs a new task once a turn ran".into());
            }
            st.started
        };
        if restart {
            // No turn ran yet: replace the bridge session before any history exists.
            if let Some(bridge) = shim.bridge.lock().as_ref().filter(|b| !b.dead.load(Ordering::Acquire)).cloned() {
                shim.send(&bridge, InFrame::Close { session: self.id.clone() });
            }
            {
                let mut st = self.st.lock();
                st.started = false;
                st.failed = None;
                st.model = value.to_owned();
                st.text.clear();
                st.tools = translate::ToolTracker::default();
            }
            self.start(shim).await?;
        } else {
            self.st.lock().model = value.to_owned();
        }
        Ok(())
    }

    async fn prompt(
        self: &Arc<Self>,
        shim: &Arc<Shim>,
        prompt: &Value,
    ) -> Result<TurnEnd, (i64, String, Option<Value>)> {
        self.check().map_err(internal)?;
        let text = translate::prompt_text(prompt);
        if text.trim().is_empty() {
            return Err(invalid("the prompt has no text"));
        }
        let rx = {
            let mut st = self.st.lock();
            if st.turn.is_some() {
                return Err(invalid("a turn is already running"));
            }
            // Stopped before it got here.
            if st.cancel_at.take().is_some_and(|t| t.elapsed() < EARLY_CANCEL) {
                return Ok(TurnEnd::Stop("cancelled".into()));
            }
            let (tx, rx) = oneshot::channel();
            st.turn = Some(Turn { done: Some(tx), cancelled: false });
            st.turns += 1;
            st.text.clear();
            rx
        };
        let bridge = shim.ensure_bridge().await.map_err(internal)?;
        if bridge.stdin_tx.send(InFrame::Prompt { session: self.id.clone(), text }.line()).is_err() {
            self.turn_fail("the Cindy bridge is gone");
            return Err(internal("the Cindy bridge is gone"));
        }
        Ok(rx.await.unwrap_or_else(|_| TurnEnd::Fail { message: "the Cindy bridge exited".into(), data: None }))
    }

    /// Asks the client about a permission frame (spawned by the reader, once per
    /// bridge id); answers `deny` when the client is gone or dismisses, and
    /// skips `respond` when the bridge already settled the permission.
    fn ask(self: &Arc<Self>, shim: &Arc<Shim>, id: String, tool_name: Option<String>, summary: Option<String>) {
        let Some(own) = self.shim() else { return };
        if !Arc::ptr_eq(&own, shim) {
            return;
        }
        let shim = own;
        let token = {
            let mut st = self.st.lock();
            if st.failed.is_some() || st.asks.contains_key(&id) || st.dismissed.contains(&id) {
                return;
            }
            let token = CancellationToken::new();
            st.asks.insert(id.clone(), token.clone());
            token
        };
        let me = Arc::clone(self);
        let rt = shim.rt.clone();
        rt.spawn(async move {
            let answer = match shim.client.get() {
                Some(client) => client
                    .request(
                        "session/request_permission",
                        json!({
                            "sessionId": me.id,
                            "toolCall": translate::permission_tool_call(&id, tool_name.as_deref(), summary.as_deref()),
                            "options": translate::permission_options(),
                        }),
                        Some(token),
                    )
                    .await,
                None => Err(RpcError::Timeout),
            };
            let allow = answer.as_ref().is_ok_and(translate::answer_allows);
            let mut st = me.st.lock();
            st.asks.remove(&id);
            if st.dismissed.contains(&id) {
                return;
            }
            drop(st);
            if let Some(shim) = me.shim()
                && let Some(bridge) = shim.bridge.lock().as_ref().filter(|b| !b.dead.load(Ordering::Acquire)).cloned()
            {
                shim.send(&bridge, InFrame::Respond { session: me.id.clone(), permission_id: id, allow });
            }
        });
    }

    fn dismiss(&self, id: &str) {
        let mut st = self.st.lock();
        st.dismissed.insert(id.to_owned());
        if let Some(token) = st.asks.remove(id) {
            token.cancel();
        }
    }

    fn fold(&self, frame: &OutFrame, shim: &Arc<Shim>) {
        // Copied out: the translator's closure also needs the session cwd.
        let cwd = self.cwd.clone();
        let updates = {
            let mut st = self.st.lock();
            if st.failed.is_some() {
                return;
            }
            let State { text, tools, .. } = &mut *st;
            translate::fold(frame, text, tools, |name| super::claude::tools::call_fields(name, &json!({}), &cwd))
        };
        shim.notify(updates);
    }

    /// Ends the turn with the bridge's `done`.
    fn turn_done(&self, reason: String) {
        let turn = self.st.lock().turn.take();
        if let Some(mut t) = turn
            && let Some(done) = t.done.take()
        {
            let end = if t.cancelled { TurnEnd::Stop("cancelled".into()) } else { TurnEnd::Stop(reason) };
            let _ = done.send(end);
        }
    }

    /// Fails the turn (bridge crash, terminal error, close).
    fn turn_fail(&self, message: &str) {
        let (turn, failed) = {
            let mut st = self.st.lock();
            if st.failed.is_none() {
                st.failed = Some(message.to_owned());
            }
            (st.turn.take(), st.failed.clone())
        };
        let _ = failed;
        if let Some(mut t) = turn
            && let Some(done) = t.done.take()
        {
            let end = if t.cancelled {
                TurnEnd::Stop("cancelled".into())
            } else {
                TurnEnd::Fail { message: message.into(), data: None }
            };
            let _ = done.send(end);
        }
        let mut st = self.st.lock();
        for (_, token) in st.asks.drain() {
            token.cancel();
        }
    }

    fn cancel(&self, shim: &Arc<Shim>) {
        let bridge = {
            let mut st = self.st.lock();
            match st.turn.as_mut() {
                Some(t) => {
                    t.cancelled = true;
                    shim.bridge.lock().as_ref().filter(|b| !b.dead.load(Ordering::Acquire)).cloned()
                }
                None => {
                    st.cancel_at = Some(Instant::now());
                    None
                }
            }
        };
        if let Some(bridge) = bridge {
            let me = self.shim();
            let id = self.id.clone();
            shim.send(&bridge, InFrame::Cancel { session: self.id.clone() });
            let grace = shim.config.cancel_grace;
            shim.rt.spawn(async move {
                tokio::time::sleep(grace).await;
                if let Some(me) = me
                    && let Some(s) = me.sessions.lock().get(&id)
                {
                    let turn = s.st.lock().turn.take();
                    if let Some(mut t) = turn
                        && t.cancelled
                        && let Some(done) = t.done.take()
                    {
                        let _ = done.send(TurnEnd::Stop("cancelled".into()));
                    }
                }
            });
        }
    }
}

impl State {
    fn options(&self) -> Value {
        Session::config_options(&self.model)
    }
}
