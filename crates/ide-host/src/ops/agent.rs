//! Agents tool window: coding agent tasks of the project (over ACP). In a remote
//! window they run on the host, next to the project they work on.
use super::{Channel, Emit};
use crate::Host;
use crate::rpc::Dispatcher;
use ide_agent::registry::{AgentRegistry, RegistryPaths};
use ide_agent::{
    AgentChange, AgentCommand, AgentEntry, AgentEvent, AgentProbe, AgentPrompt, AgentProvider, AgentQueued, AgentTask,
    NewAgentTask,
};
use ide_core::error::ErrorKind;
use ide_core::{IdeError, IdeEvent, IdeResult, IpcPath, RequestId, SharedSink, TaskId};
use ide_tools::InstallEvent;
use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

/// Streams the project's agent events to this window; returns every task.
pub fn subscribe(host: &Host, window: &str, on_event: Emit<AgentEvent>) -> IdeResult<Vec<AgentTask>> {
    Ok(host.project_or_default(window)?.agents.subscribe(on_event))
}

pub fn providers(host: &Host, window: &str) -> IdeResult<Vec<AgentProvider>> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    let mut providers = project.agents.providers();
    ide_agent::registry::mark_updates(&registry_paths(host), &mut providers);
    Ok(providers)
}

/// Overrides built-in agent `id`'s command with `command` (its agent file keeps the
/// built-in's driver and arguments), or returns it to auto-detection with `None`.
pub fn set_command(host: &Host, window: &str, id: String, command: Option<String>) -> IdeResult<()> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    project.agents.set_builtin_command(&id, command)
}

/// Environment variables built-in agent `id` starts with; empty clears them.
pub fn set_env(
    host: &Host,
    window: &str,
    id: String,
    env: std::collections::BTreeMap<String, String>,
) -> IdeResult<()> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    project.agents.set_builtin_env(&id, env)
}

/// Where ACP Registry agents are saved (`<config>/agents`, like the user's own) and installed.
pub(crate) fn registry_paths(host: &Host) -> RegistryPaths {
    RegistryPaths::new(&host.config_dir, &host.local_data_dir)
}

fn join_err(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(e.to_string())
}

/// Agents of the ACP Registry this machine can run, with what is installed; the list
/// saved earlier when the registry is unreachable. Cancel with `cancel_request(request)`.
pub async fn registry_list(host: &Host, _window: &str, request: RequestId) -> IdeResult<AgentRegistry> {
    let paths = registry_paths(host);
    let cancel = host.begin_request(request);
    let result =
        tokio::task::spawn_blocking(move || ide_agent::registry::list(&paths, &cancel)).await.map_err(join_err);
    host.end_request(request);
    let mut registry = result??;
    let installing = installing();
    for agent in &mut registry.agents {
        agent.installing = installing.contains(&agent.id);
    }
    Ok(registry)
}

/// Registry installs in progress, by agent id. An install outlives the Settings page
/// that started it, so a second one of the same agent is refused rather than racing it
/// for the same folder.
static INSTALLING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

fn installing() -> std::sync::MutexGuard<'static, HashSet<String>> {
    INSTALLING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Marks agent `id` as installing until dropped.
struct Installing(String);

impl Installing {
    fn begin(id: &str) -> IdeResult<Self> {
        if !installing().insert(id.to_owned()) {
            return Err(IdeError::new(ErrorKind::AlreadyExists, format!("{id} is already being installed")));
        }
        Ok(Self(id.to_owned()))
    }
}

impl Drop for Installing {
    fn drop(&mut self) {
        installing().remove(&self.0);
    }
}

/// Installs the registry's current version of agent `id` (also to update it), streaming
/// progress through `on_event`; the agent then shows in `agent_providers`. Cancel with
/// `cancel_request(request)`.
pub async fn registry_install(
    host: &Host,
    _window: &str,
    id: String,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<()> {
    let paths = registry_paths(host);
    let installing = Installing::begin(&id)?;
    let cancel = host.begin_request(request);
    // Also a background task of every project window, so it stays visible and can be
    // stopped there once the Settings page is closed.
    let task = TaskId::next();
    let title = format!("Installing {id}");
    let sinks: Vec<SharedSink> = host.projects().iter().map(|p| p.sink.clone()).collect();
    let report = move |message: Option<String>, fraction: Option<f32>, done: bool| {
        for sink in &sinks {
            sink.emit(IdeEvent::Task {
                id: task,
                title: title.clone(),
                message: message.clone(),
                fraction,
                done,
                cancellable: !done,
            });
        }
    };
    let result = tokio::task::spawn_blocking(move || {
        let _installing = installing;
        let _cancel = ide_core::task::on_cancel(task, {
            let cancel = cancel.clone();
            move || cancel.cancel()
        });
        report(None, None, false);
        let result = ide_agent::registry::install(&paths, &id, &cancel, &|e| {
            match &e {
                InstallEvent::Line { text } => report(Some(text.clone()), None, false),
                InstallEvent::Progress { fraction, message } => {
                    report(Some(message.clone()), fraction.map(|f| f as f32), false)
                }
            }
            let _ = on_event.send(e);
        });
        report(None, Some(1.0), true);
        result
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    result??;
    for project in host.projects() {
        project.agents.reload_providers();
    }
    Ok(())
}

/// Removes a registry agent: its agent file and installed files.
pub async fn registry_remove(host: &Host, _window: &str, id: String) -> IdeResult<()> {
    let paths = registry_paths(host);
    tokio::task::spawn_blocking(move || ide_agent::registry::remove(&paths, &id)).await.map_err(join_err)??;
    for project in host.projects() {
        project.agents.reload_providers();
    }
    Ok(())
}

/// Slash commands to complete for `provider` in `task`'s directory, or in the project
/// before a task exists (skills and custom commands on disk included).
pub async fn commands(
    host: &Host,
    window: &str,
    provider: String,
    task: Option<String>,
) -> IdeResult<Vec<AgentCommand>> {
    host.project_or_default(window)?.agents.commands(&provider, task.as_deref()).await
}

/// Entries of `task`'s conversation, or of its subagent `subagent`'s.
pub fn entries(host: &Host, window: &str, task: String, subagent: Option<String>) -> IdeResult<Vec<AgentEntry>> {
    host.project_or_default(window)?.agents.entries(&task, subagent)
}

pub async fn create(host: &Host, window: &str, mut request: NewAgentTask) -> IdeResult<AgentTask> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    // The agent-first home has no explicit project: the user picks the workspace
    // folder itself, so anything on disk goes (trust is checked below). The
    // default workspace is not an explicit project: `project_or_default` opens
    // it for the listing/probe calls that run before the first Start, and that
    // must not flip validation into window-project-only mode.
    let explicit = host.project(window).is_ok_and(|p| !is_default_project(&p.root));
    let root = project.root.clone();
    let requested = request.project_root.take();
    // Canonicalized once here so the trust check below can skip the window root itself.
    let window_root = dunce::canonicalize(&root).unwrap_or_else(|_| root.clone());
    let probe = window_root.clone();
    let resolved = host
        .blocking(move || validate_project_root(&probe, requested.as_ref().map(|p| p.0.as_path()), explicit))
        .await?;
    if resolved != window_root && !host.trust.trusted(&resolved)? {
        return Err(IdeError::unavailable("This folder is in Restricted Mode. Trust it to run agents here."));
    }
    request.project_root = Some(IpcPath(resolved));
    project.agents.create(request).await
}

/// Sends a message; while the agent works it is queued, or with `now` it interrupts the turn.
pub async fn prompt(host: &Host, window: &str, task: String, prompt: AgentPrompt, now: bool) -> IdeResult<()> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    project.agents.prompt(&task, prompt, now).await
}

/// Drops a queued message and returns it (to edit it).
pub fn unqueue(host: &Host, window: &str, task: String, queued: String) -> IdeResult<AgentQueued> {
    host.project_or_default(window)?.agents.unqueue(&task, &queued)
}

/// Sends a queued message now, interrupting the current turn.
pub fn send_queued_now(host: &Host, window: &str, task: String, queued: String) -> IdeResult<()> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    project.agents.send_queued_now(&task, &queued)
}

/// Changes a session setting (model, mode, thinking effort…).
pub async fn set_config(host: &Host, window: &str, task: String, option: String, value: String) -> IdeResult<()> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    project.agents.set_config(&task, &option, value).await
}

/// Copies the task's conversation into a new task, up to its first `turns` turns (all when `None`).
pub async fn fork(host: &Host, window: &str, task: String, turns: Option<u32>) -> IdeResult<AgentTask> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    project.agents.fork(&task, turns).await
}

/// Drops the task's turns after its first `turns`; returns the message of the first dropped one.
pub async fn rollback(host: &Host, window: &str, task: String, turns: u32) -> IdeResult<Option<AgentPrompt>> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    project.agents.rollback(&task, turns).await
}

/// What the agent reports about itself when it starts, without opening a session.
pub async fn probe(host: &Host, window: &str, provider: String, refresh: bool) -> IdeResult<AgentProbe> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    project.agents.probe(&provider, refresh).await
}

/// Stops the task's current turn, or with `subagent` only that subagent's work.
pub fn cancel(host: &Host, window: &str, task: String, subagent: Option<String>) -> IdeResult<()> {
    host.project_or_default(window)?.agents.cancel(&task, subagent)
}

/// Answers a permission request; `option: None` cancels it.
pub fn respond(host: &Host, window: &str, task: String, permission: u32, option: Option<String>) -> IdeResult<()> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    project.agents.respond(&task, permission, option)
}

pub fn archive(host: &Host, window: &str, task: String) -> IdeResult<()> {
    host.project_or_default(window)?.agents.archive(&task)
}

pub fn unarchive(host: &Host, window: &str, task: String) -> IdeResult<()> {
    host.project_or_default(window)?.agents.unarchive(&task)
}

pub async fn delete(host: &Host, window: &str, task: String, remove_worktree: bool) -> IdeResult<()> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    project.agents.delete(&task, remove_worktree).await
}

pub async fn changes(host: &Host, window: &str, task: String) -> IdeResult<Vec<AgentChange>> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    project.agents.changes(&task).await
}

/// Content of `path` when the task started (left side of its diff).
pub async fn base_text(host: &Host, window: &str, task: String, path: IpcPath) -> IdeResult<Option<String>> {
    let project = host.project_or_default(window)?;
    project.require_trust()?;
    project.agents.base_text(&task, path.into_path_buf()).await
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("agent_subscribe", |c| async move { subscribe(&c.host, &c.window, c.channel("onEvent")?) });
    d.add("agent_providers", |c| async move { providers(&c.host, &c.window) });
    d.add("agent_set_command", |c| async move { set_command(&c.host, &c.window, c.arg("id")?, c.arg("command")?) });
    d.add("agent_set_env", |c| async move { set_env(&c.host, &c.window, c.arg("id")?, c.arg("env")?) });
    d.add("agent_registry_list", |c| async move { registry_list(&c.host, &c.window, c.arg("request")?).await });
    d.add("agent_registry_install", |c| async move {
        registry_install(&c.host, &c.window, c.arg("id")?, c.arg("request")?, c.sender("onEvent")?).await
    });
    d.add("agent_registry_remove", |c| async move { registry_remove(&c.host, &c.window, c.arg("id")?).await });
    d.add("agent_commands", |c| async move { commands(&c.host, &c.window, c.arg("provider")?, c.arg("task")?).await });
    d.add("agent_entries", |c| async move { entries(&c.host, &c.window, c.arg("task")?, c.arg("subagent")?) });
    d.add("agent_create", |c| async move { create(&c.host, &c.window, c.arg("request")?).await });
    d.add("agent_prompt", |c| async move {
        prompt(&c.host, &c.window, c.arg("task")?, c.arg("prompt")?, c.arg("now")?).await
    });
    d.add("agent_unqueue", |c| async move { unqueue(&c.host, &c.window, c.arg("task")?, c.arg("queued")?) });
    d.add(
        "agent_send_queued_now",
        |c| async move { send_queued_now(&c.host, &c.window, c.arg("task")?, c.arg("queued")?) },
    );
    d.add("agent_set_config", |c| async move {
        set_config(&c.host, &c.window, c.arg("task")?, c.arg("option")?, c.arg("value")?).await
    });
    d.add("agent_fork", |c| async move { fork(&c.host, &c.window, c.arg("task")?, c.arg("turns")?).await });
    d.add("agent_rollback", |c| async move { rollback(&c.host, &c.window, c.arg("task")?, c.arg("turns")?).await });
    d.add("agent_probe", |c| async move { probe(&c.host, &c.window, c.arg("provider")?, c.arg("refresh")?).await });
    d.add("agent_cancel", |c| async move { cancel(&c.host, &c.window, c.arg("task")?, c.arg("subagent")?) });
    d.add("agent_respond", |c| async move {
        respond(&c.host, &c.window, c.arg("task")?, c.arg("permission")?, c.arg("option")?)
    });
    d.add("agent_unarchive", |c| async move { unarchive(&c.host, &c.window, c.arg("task")?) });
    d.add("agent_archive", |c| async move { archive(&c.host, &c.window, c.arg("task")?) });
    d.add(
        "agent_delete",
        |c| async move { delete(&c.host, &c.window, c.arg("task")?, c.arg("removeWorktree")?).await },
    );
    d.add("agent_changes", |c| async move { changes(&c.host, &c.window, c.arg("task")?).await });
    d.add("agent_base_text", |c| async move { base_text(&c.host, &c.window, c.arg("task")?, c.arg("path")?).await });
}

/// Whether `root` is the agent-first home's default workspace
/// (`~/.openidea/workspace`): app-owned, so hosting it is not an explicit project.
fn is_default_project(root: &std::path::Path) -> bool {
    let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let def = Host::default_workspace();
    let def = dunce::canonicalize(&def).unwrap_or(def);
    root == def
}

fn validate_project_root(
    root: &std::path::Path,
    requested: Option<&std::path::Path>,
    explicit: bool,
) -> IdeResult<std::path::PathBuf> {
    let Some(requested) = requested else {
        return Ok(root.to_path_buf());
    };
    if !requested.is_absolute() {
        return Err(IdeError::invalid("Choose an absolute project root"));
    }
    let requested = dunce::canonicalize(requested)?;
    let window_root = dunce::canonicalize(root)?;
    if requested == window_root
        || ide_workspace::workspace::Workspace::load(root)?.is_some_and(|w| w.projects.contains(&requested))
    {
        return Ok(requested);
    }
    // No explicit project (the agent-first home): the user picked this folder as
    // their workspace, so any folder on disk goes; trust is checked by the caller.
    if !explicit && requested.is_dir() {
        return Ok(requested);
    }
    Err(IdeError::invalid("Agent project must be the window project or a workspace member"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agent_installs_once_at_a_time() {
        let first = Installing::begin("test-agent").unwrap();
        assert!(installing().contains("test-agent"));
        let again = Installing::begin("test-agent").err().unwrap();
        assert_eq!(again.kind, ErrorKind::AlreadyExists);
        let other = Installing::begin("test-other-agent").unwrap();
        drop(first);
        assert!(!installing().contains("test-agent"));
        drop(Installing::begin("test-agent").unwrap());
        drop(other);
    }

    #[test]
    fn agent_roots_are_exact_window_or_workspace_members() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("workspace");
        let member = tmp.path().join("member");
        let other = tmp.path().join("other");
        for dir in [&root, &member, &other, &member.join("child")] {
            std::fs::create_dir_all(dir).unwrap();
        }
        assert_eq!(validate_project_root(&root, None, true).unwrap(), root);
        assert_eq!(validate_project_root(&root, Some(&root), true).unwrap(), dunce::canonicalize(&root).unwrap());
        assert!(validate_project_root(&root, Some(&member), true).is_err());
        ide_workspace::workspace::Workspace::save(&root, "Workspace", vec![member.clone()], true).unwrap();
        assert_eq!(validate_project_root(&root, Some(&member), true).unwrap(), dunce::canonicalize(&member).unwrap());
        for rejected in [other, member.join("child"), member.join("../other"), "relative".into()] {
            assert!(validate_project_root(&root, Some(&rejected), true).is_err(), "{rejected:?}");
        }
    }

    #[test]
    fn agent_roots_allow_any_folder_without_an_explicit_project() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("workspace");
        let picked = tmp.path().join("picked");
        let file = tmp.path().join("file.txt");
        for dir in [&root, &picked] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(&file, "x").unwrap();
        // The agent-first home: the user picked this folder as their workspace.
        assert_eq!(validate_project_root(&root, Some(&picked), false).unwrap(), dunce::canonicalize(&picked).unwrap());
        // Files, missing folders and relative paths still fail.
        assert!(validate_project_root(&root, Some(&file), false).is_err());
        assert!(validate_project_root(&root, Some(&tmp.path().join("missing")), false).is_err());
        assert!(validate_project_root(&root, Some(std::path::Path::new("relative")), false).is_err());
    }

    #[test]
    fn default_workspace_project_is_not_explicit() {
        // `project_or_default` opens this for the home window before the first
        // Start; picking another folder must still validate as the home flow.
        // The app creates the dir on startup (`ensure_default_project`), so the
        // test does the same: fresh machines (CI) have no `~/.openidea/workspace`.
        std::fs::create_dir_all(Host::default_workspace()).unwrap();
        assert!(is_default_project(&Host::default_workspace()));
        let tmp = tempfile::tempdir().unwrap();
        assert!(!is_default_project(tmp.path()));
        let picked = tmp.path().join("picked");
        std::fs::create_dir_all(&picked).unwrap();
        let explicit = !is_default_project(&Host::default_workspace());
        assert!(!explicit);
        assert_eq!(
            validate_project_root(&Host::default_workspace(), Some(&picked), explicit).unwrap(),
            dunce::canonicalize(&picked).unwrap()
        );
    }
}
