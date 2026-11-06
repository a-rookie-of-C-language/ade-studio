//! IPC types: tasks, their timeline entries and the events streamed to the UI.

use ide_core::IpcPath;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentStatus {
    /// Creating the worktree / starting the agent.
    Starting,
    Running,
    /// Waiting for a permission answer.
    NeedsInput,
    /// The turn ended; the result can be reviewed or the conversation continued.
    Ready,
    Failed,
    /// The account's usage limit was reached; the conversation can go on once it resets.
    Limited,
    Archived,
}

/// What a task's agent can do beyond a plain conversation, as it reported when its
/// session started.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentCapabilities {
    /// Images in messages.
    pub images: bool,
    /// The conversation can be copied into a new task (`session/fork`).
    pub fork: bool,
    /// Its latest turns can be dropped.
    pub rollback: bool,
    /// A message can join the running turn instead of waiting for it.
    pub steer: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Isolation {
    /// A new git worktree on its own branch.
    Worktree,
    /// The project's own checkout.
    Local,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    /// Original project folder; absent in tasks saved before per-task roots.
    #[serde(default)]
    pub project_root: Option<IpcPath>,
    pub id: String,
    pub title: String,
    /// [`AgentProvider::id`].
    pub provider: String,
    /// Model the task runs on (its `model` setting), when known.
    pub model: Option<String>,
    pub status: AgentStatus,
    pub isolation: Isolation,
    /// Directory the agent works in (the worktree, or the project root).
    pub cwd: IpcPath,
    /// Branch of the task's worktree.
    pub branch: Option<String>,
    /// Branch (or revision) the worktree was created from.
    pub base: Option<String>,
    /// Commit the task's changes are compared against (worktree tasks; local ones use `HEAD`).
    pub base_commit: Option<String>,
    /// Why the task failed, when it did.
    pub error: Option<String>,
    pub created_ms: f64,
    pub updated_ms: f64,
    /// The session's settings (model, mode, thinking effort…) as last reported, with the
    /// user's choices applied.
    pub config: Vec<AgentConfigOption>,
    /// Slash commands the agent offers.
    pub commands: Vec<AgentCommand>,
    /// Context window use, when the agent reports it.
    /// Boxed so that `AgentEvent::Task` stays within clippy's `large_enum_variant` bound.
    pub usage: Option<Box<AgentUsage>>,
    /// Cumulative session statistics: token totals, request outcomes and timing.
    /// Saved with the task, so the numbers survive restarts; a fork starts over.
    /// Boxed so that `AgentEvent::Task` stays within clippy's `large_enum_variant` bound.
    #[serde(default)]
    pub stats: Box<AgentSessionStats>,
    /// Messages waiting for the current turn to end, oldest first.
    pub queue: Vec<AgentQueued>,
    #[serde(default)]
    pub capabilities: AgentCapabilities,
    /// When a [`AgentStatus::Limited`] task's limit resets (ms since the epoch), if the agent said.
    #[serde(default)]
    pub resets_ms: Option<f64>,
    /// The agent is retrying a failed API request (connection lost, overloaded…); cleared
    /// by its next output or any status change.
    #[serde(default)]
    pub retry: Option<AgentRetry>,
    /// How the task was launched: which agent binary, on which surface, and why it
    /// fell back when it did. Absent on tasks saved before this was tracked.
    /// Boxed so that `AgentEvent::Task` stays within clippy's `large_enum_variant` bound.
    #[serde(default)]
    pub launch: Option<Box<AgentLaunchReceipt>>,
}

/// An API request the agent is about to retry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRetry {
    pub attempt: u32,
    pub max_retries: Option<u32>,
    /// When the next attempt starts (ms since the epoch).
    pub retry_at_ms: f64,
    pub error: Option<String>,
}

/// Where a task runs. Today every task runs in-process behind the chat surface;
/// `Terminal` exists so a future fallback can be reported honestly instead of
/// being invented by the UI.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentSurface {
    /// In-process agent session driving the chat UI.
    #[default]
    Chat,
    /// The agent's own CLI in a terminal.
    Terminal,
}

/// Why a launch did not stay on its preferred surface. Never constructed today:
/// kept so the first real fallback reports its cause instead of silently changing surface.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchFallback {
    pub from: AgentSurface,
    pub to: AgentSurface,
    pub reason: String,
}

/// How a task was launched: the exact binary, the surface it landed on, and the
/// idempotency key that created it. Only what the backend knows is filled in;
/// the UI renders anything missing as unknown.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchReceipt {
    pub provider: String,
    pub program: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub surface: AgentSurface,
    pub installed: bool,
    #[serde(default)]
    pub fallback: Option<AgentLaunchFallback>,
    #[serde(default)]
    pub operation_id: Option<String>,
}

/// One value of a select-type session setting.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigValue {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

/// How a setting is changed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentConfigVia {
    /// `session/set_config_option`.
    #[default]
    Option,
    /// `session/set_mode` (agents that report `modes` instead of a mode config option).
    Mode,
    /// `session/set_model` (agents that report `models` instead of a model config option).
    Model,
}

/// A session setting: an ACP select config option, or the older `modes` / `models`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// ACP category: `model`, `mode`, `thought_level`, or agent-specific.
    pub category: Option<String>,
    pub current: Option<String>,
    pub values: Vec<AgentConfigValue>,
    pub via: AgentConfigVia,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    /// Without the leading `/`.
    pub name: String,
    pub description: String,
    /// What to type after the command, when it takes input.
    pub hint: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    /// Tokens in the context window.
    pub used: u32,
    /// Size of the context window.
    pub size: u32,
    /// Where the numbers come from: the provider's own report, or our estimate
    /// from its message-level token counts. Absent on tasks saved before this
    /// was tracked; those read as `Report`.
    #[serde(default)]
    pub kind: AgentContextKind,
    /// The model the numbers were measured for, when the provider names it.
    #[serde(default)]
    pub model: Option<String>,
    /// The provider's own per-category breakdown, when it reports one.
    #[serde(default)]
    pub categories: Vec<AgentContextCategory>,
    /// What the session has cost so far (ACP `usage_update.cost`), when the agent reports it.
    // Boxed so that `AgentEvent::Task` stays within clippy's `large_enum_variant` bound on Windows.
    #[serde(default)]
    pub cost: Option<Box<AgentCost>>,
    /// Tokens the last request sent, when the agent reports the split.
    #[serde(default)]
    pub input_tokens: Option<u32>,
    /// Tokens the last request produced, when reported.
    #[serde(default)]
    pub output_tokens: Option<u32>,
    /// Tokens served from cache, when reported (Codex `cachedInputTokens`,
    /// Claude `cache_read_input_tokens`).
    #[serde(default)]
    pub cache_read_tokens: Option<u32>,
    /// Tokens written to cache, when reported (Codex `cacheWriteInputTokens`,
    /// Claude `cache_creation_input_tokens`).
    #[serde(default)]
    pub cache_write_tokens: Option<u32>,
    /// Reasoning tokens, when reported (Codex `reasoningOutputTokens`).
    #[serde(default)]
    pub reasoning_tokens: Option<u32>,
}

/// Where a context-window reading comes from. `None` (no `AgentUsage` at all)
/// means unknown: nothing reported yet, or the last reading was invalidated by
/// a compaction or a model change.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentContextKind {
    /// The provider's own answer (Codex `tokenUsage`, ACP `usage_update`).
    #[default]
    Report,
    /// Derived from message-level token counts (Claude stream-json `usage`).
    Estimate,
}

/// One row of the provider's own context breakdown, as it names and counts it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextCategory {
    /// Display name as the provider renders it.
    pub name: String,
    pub tokens: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCost {
    pub amount: f64,
    /// ISO 4217 code, e.g. `USD`.
    pub currency: String,
}

/// Cumulative session statistics: what the task spent and how fast it went.
/// Every `usage_update` the task's own session reports adds its per-request
/// splits to the totals (like the provider CLIs count API calls); turns add
/// timing. Rolling the conversation back never refunds the spend.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionStats {
    /// Completed turns (user requests the agent answered, failed or stopped).
    #[serde(default)]
    pub requests: u32,
    /// Turns that ended in an error.
    #[serde(default)]
    pub failures: u32,
    /// Retried API requests that later produced output.
    #[serde(default)]
    pub retries: u32,
    /// Sum of the per-request input tokens agents reported.
    #[serde(default)]
    pub input_tokens: u64,
    /// Sum of the per-request output tokens agents reported.
    #[serde(default)]
    pub output_tokens: u64,
    /// Tokens served from cache, summed as reported.
    #[serde(default)]
    pub cache_read_tokens: u64,
    /// Tokens written to cache, summed as reported.
    #[serde(default)]
    pub cache_write_tokens: u64,
    /// Reasoning tokens, summed as reported.
    #[serde(default)]
    pub reasoning_tokens: u64,
    /// What the session has cost so far in USD, as last reported.
    #[serde(default)]
    pub cost_usd: Option<f64>,
    /// Sum of completed-turn durations (ms).
    #[serde(default)]
    pub active_ms: u64,
    /// Sum of first-output latencies (ms) over `ttft_samples` turns.
    #[serde(default)]
    pub ttft_ms: u64,
    /// Turns whose first output was timed.
    #[serde(default)]
    pub ttft_samples: u32,
}

/// One usage-limit window of an agent's account.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLimit {
    /// The window as the agent names it: `five_hour`, `seven_day`, `seven_day_opus`…
    pub window: String,
    /// Share of the window used, 0–100.
    pub used_percent: f64,
    /// When the window resets (ms since the epoch), if the agent said.
    pub resets_ms: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentImage {
    pub mime_type: String,
    /// Base64, without a `data:` prefix.
    pub data: String,
    pub name: Option<String>,
}

/// A message to the agent: text, plus files to look at and images.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPrompt {
    pub text: String,
    pub files: Vec<IpcPath>,
    pub images: Vec<AgentImage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentQueued {
    pub id: String,
    pub prompt: AgentPrompt,
}

/// A setting chosen for a new task, by [`AgentConfigOption::id`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigChoice {
    pub id: String,
    pub value: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentToolStatus {
    Pending,
    Running,
    Completed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolDiff {
    pub path: IpcPath,
    pub added: u32,
    pub removed: u32,
}

/// What a subagent is doing, as its parent reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentSubagentStatus {
    Running,
    /// One of its requests (a permission) waits for an answer.
    NeedsInput,
    Done,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanItem {
    pub content: String,
    /// `pending`, `in_progress` or `completed`.
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionOption {
    pub id: String,
    pub name: String,
    /// `allow_once`, `allow_always`, `reject_once` or `reject_always`.
    pub kind: String,
}

/// One item of a task's conversation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEntry {
    User {
        text: String,
        /// Names of the files and images sent with it.
        attachments: Vec<String>,
        /// The images sent with it, shown in the conversation.
        #[serde(default)]
        images: Vec<AgentImage>,
        /// When it was sent (ms since the epoch); `None` in tasks saved before this was kept.
        #[serde(default)]
        sent_ms: Option<f64>,
        /// When the turn it started ended; `None` while it runs or when it was cut off.
        #[serde(default)]
        done_ms: Option<f64>,
        /// Sent into a running turn rather than starting one.
        #[serde(default)]
        steered: bool,
    },
    Agent {
        text: String,
    },
    Thought {
        text: String,
    },
    Tool {
        id: String,
        title: String,
        /// ACP tool kind: `read`, `edit`, `execute`, `search`, `fetch`, `think`…
        kind: String,
        status: AgentToolStatus,
        locations: Vec<IpcPath>,
        /// Text the tool reported (command output…), truncated.
        output: Option<String>,
        diffs: Vec<AgentToolDiff>,
        /// When the tool call started (ms since the epoch).
        #[serde(default)]
        started_ms: Option<f64>,
        /// When the tool call finished; `None` while it runs.
        #[serde(default)]
        ended_ms: Option<f64>,
    },
    Plan {
        items: Vec<AgentPlanItem>,
    },
    /// A subagent the agent started: its own session, whose entries are listed separately.
    Subagent {
        /// The subagent's session id.
        id: String,
        title: Option<String>,
        description: Option<String>,
        status: AgentSubagentStatus,
        error: Option<String>,
        /// What it was asked to do, last.
        prompt: Option<String>,
        /// Its answer.
        reply: Option<String>,
        /// Tool calls it made.
        tools: u32,
        /// Title of its latest tool call.
        activity: Option<String>,
        started_ms: f64,
        /// When it last stopped working; `None` while it works.
        ended_ms: Option<f64>,
        /// Whether it can be stopped on its own.
        cancellable: bool,
    },
    /// A message between sessions in a subagent's conversation: its task (`incoming`) or its report.
    Message {
        incoming: bool,
        text: String,
    },
    Permission {
        id: u32,
        title: String,
        options: Vec<AgentPermissionOption>,
        /// Name of the chosen option, or `None` while pending. Cancelled requests read "Cancelled".
        chosen: Option<String>,
    },
    Error {
        message: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentProvider {
    pub id: String,
    pub name: String,
    /// The command line that starts its ACP server.
    pub command: String,
    /// Executable and arguments actually launched, without flattening paths containing spaces.
    pub program: String,
    pub args: Vec<String>,
    pub default_program: Option<String>,
    pub default_args: Vec<String>,
    pub login_hint: Option<String>,
    pub command_overridden: bool,
    pub command_editable: bool,
    pub command_read_only_reason: Option<AgentCommandReadOnlyReason>,
    /// Whether the command was found (on `PATH`).
    pub installed: bool,
    /// Environment variables it starts with (from its agent file).
    pub env: BTreeMap<String, String>,
    /// Settings (models, modes…) the agent offered last time it ran; empty before its first session.
    pub config: Vec<AgentConfigOption>,
    /// Slash commands it offered last time.
    pub commands: Vec<AgentCommand>,
    pub source: AgentSource,
}

/// Why the executable cannot be changed in built-in agent settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentCommandReadOnlyReason {
    PackageRunner,
    Registry,
    CustomAgent,
}

/// Where an agent comes from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentSource {
    Builtin,
    /// Defined by the user in `<config>/agents/<id>.toml`.
    Custom,
    /// Installed from the ACP Registry.
    Registry {
        version: String,
        /// A newer version the registry offers.
        update: Option<String>,
    },
}

/// What an agent says about itself when it starts (`initialize` only: no session, so no
/// MCP servers, hooks or sign-in run).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentProbe {
    pub provider: String,
    /// The agent's own name and version, when it reports them.
    pub name: Option<String>,
    pub version: Option<String>,
    /// How it is driven: `ACP v1`, `ACP v2` or `native`.
    pub protocol: String,
    pub capabilities: AgentCapabilities,
    /// Ways to sign in it offers.
    pub auth_methods: Vec<String>,
    /// Models it lists in its `initialize` reply (Claude's native CLI does);
    /// empty for agents that only offer models once a session runs.
    pub models: Vec<AgentConfigValue>,
    /// Why it could not be started.
    pub error: Option<String>,
}

/// Models from an agent's `initialize` reply: `models: [{value, displayName?,
/// description?}]`, as Claude's native CLI reports. Empty when the reply
/// lists none (agents whose models only materialize per session).
pub fn init_models(reply: &Value) -> Vec<AgentConfigValue> {
    reply
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let text = |k: &str| m.get(k).and_then(Value::as_str).and_then(clean_text);
            let value = text("value")?;
            Some(AgentConfigValue {
                name: text("displayName").or_else(|| text("name")).unwrap_or_else(|| value.clone()),
                description: text("description"),
                value,
            })
        })
        .collect()
}

/// Visible text of a model id, display name or description reported by an agent.
///
/// Third-party CLIs and routers style their listings with terminal escapes; when the
/// escape byte is lost upstream (JSON transport, table scraping) the `[1m`-style
/// residue stays behind as literal text and poisons remembered ids. Both forms are
/// removed here, with any other control characters. `None` when nothing printable
/// remains.
pub(crate) fn clean_text(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                // CSI: parameters and intermediates, then a final byte.
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC: until BEL or ST.
                Some(']') => {
                    for c in chars.by_ref() {
                        if c == '\x07' {
                            break;
                        }
                        if c == '\x1b' {
                            if chars.next() != Some('\\') {
                                break;
                            }
                            break;
                        }
                    }
                }
                // Charset selection and friends take one more byte.
                Some('(' | ')' | '#' | '%') => {
                    chars.next();
                }
                Some(_) | None => {}
            }
            continue;
        }
        if !c.is_control() {
            out.push(c);
        }
    }
    let mut text = out.as_str();
    loop {
        let stripped = strip_residue(text);
        if stripped.len() == text.len() {
            break;
        }
        text = stripped;
    }
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// One `[…m` styling fragment (whose escape byte was already lost) off either end.
fn strip_residue(text: &str) -> &str {
    let mut text = text;
    if let Some(after) = text.strip_prefix('[')
        && let Some(end) = after.find('m')
    {
        let params = &after[..end];
        if !params.is_empty() && params.chars().all(|c| c.is_ascii_digit() || c == ';') {
            text = after[end + 1..].strip_prefix(']').unwrap_or(&after[end + 1..]);
        }
    }
    if let Some(start) = text.rfind('[') {
        let mut tail = &text[start + 1..];
        tail = tail.strip_suffix(']').unwrap_or(tail);
        if let Some(params) = tail.strip_suffix('m')
            && !params.is_empty()
            && params.chars().all(|c| c.is_ascii_digit() || c == ';')
        {
            text = text[..start].trim_end();
        }
    }
    text
}

/// One model/setting value with terminal styling removed; `None` when its id has
/// nothing printable left.
pub(crate) fn clean_value(value: AgentConfigValue) -> Option<AgentConfigValue> {
    let cleaned = clean_text(&value.value)?;
    Some(AgentConfigValue {
        value: cleaned.clone(),
        name: clean_text(&value.name).unwrap_or(cleaned),
        description: value.description.as_deref().and_then(clean_text),
    })
}

/// Session settings with terminal styling removed: values that clean to nothing or
/// repeat an earlier one are dropped, options left without values are dropped, and a
/// `current` no offered value matches becomes unknown instead of pointing at styling
/// residue a future session would send back to the agent.
pub(crate) fn clean_options(options: Vec<AgentConfigOption>) -> Vec<AgentConfigOption> {
    options
        .into_iter()
        .filter_map(|mut option| {
            let mut seen = HashSet::new();
            option.values =
                option.values.into_iter().filter_map(clean_value).filter(|v| seen.insert(v.value.clone())).collect();
            if option.values.is_empty() {
                return None;
            }
            option.name = clean_text(&option.name).unwrap_or_else(|| option.id.clone());
            option.description = option.description.as_deref().and_then(clean_text);
            let current = option.current.as_deref().and_then(clean_text);
            option.current = current.filter(|c| option.values.iter().any(|v| &v.value == c));
            Some(option)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_text_strips_terminal_styling() {
        assert_eq!(clean_text("\x1b[1mopus\x1b[0m"), Some("opus".to_owned()));
        assert_eq!(
            clean_text("opencode-go/muse-spark-1.3-contributor[1m]"),
            Some("opencode-go/muse-spark-1.3-contributor".to_owned())
        );
        assert_eq!(clean_text("[1mOpus"), Some("Opus".to_owned()));
        assert_eq!(clean_text("plain"), Some("plain".to_owned()));
        assert_eq!(clean_text("\x1b[0m"), None);
        assert_eq!(clean_text("  "), None);
    }

    #[test]
    fn clean_options_drops_poison_and_resets_current() {
        let option = AgentConfigOption {
            id: "model".to_owned(),
            name: "Model".to_owned(),
            description: None,
            category: Some("model".to_owned()),
            current: Some("opencode-go/x[1m]".to_owned()),
            values: vec![
                AgentConfigValue {
                    value: "\x1b[1mopencode-go/x\x1b[0m".to_owned(),
                    name: "X".to_owned(),
                    description: None,
                },
                AgentConfigValue { value: "opus".to_owned(), name: "Opus".to_owned(), description: None },
            ],
            via: AgentConfigVia::Option,
        };
        let cleaned = clean_options(vec![option]);
        assert_eq!(cleaned[0].values.iter().map(|v| v.value.as_str()).collect::<Vec<_>>(), ["opencode-go/x", "opus"]);
        assert_eq!(cleaned[0].current.as_deref(), Some("opencode-go/x"));

        let mut orphan = cleaned[0].clone();
        orphan.current = Some("gone".to_owned());
        let cleaned = clean_options(vec![orphan]);
        assert_eq!(cleaned[0].current, None);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewAgentTask {
    /// Validated by the host; defaults to the window project root.
    #[serde(default)]
    pub project_root: Option<IpcPath>,
    pub prompt: AgentPrompt,
    pub provider: String,
    /// Settings for the new session (model, mode…).
    pub config: Vec<AgentConfigChoice>,
    pub isolation: Isolation,
    /// Branch to start the worktree from; the current branch when `None`.
    pub base: Option<String>,
    /// Idempotency key: replaying the same key returns the first task instead
    /// of creating a duplicate (Orca `operationId` semantics).
    #[serde(default)]
    pub operation_id: Option<String>,
}

/// A file the task changed, relative to [`AgentTask::base_commit`].
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentChange {
    pub path: IpcPath,
    pub rel_path: String,
    pub kind: ide_vcs::ChangeKind,
    pub added: u32,
    pub removed: u32,
}

/// A session created outside OpenIDEA (another Codex or Claude client) that can be
/// imported as a task and resumed under its own session id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSession {
    /// `codex` or `claude`.
    pub provider: String,
    /// The native session/thread id, reused to resume the conversation.
    pub session_id: String,
    pub title: String,
    /// Directory the session worked in, when its history names one.
    pub cwd: Option<IpcPath>,
    /// Last activity (ms since the epoch), newest first.
    pub updated_ms: f64,
    /// An OpenIDEA task already resumes this session.
    pub imported: bool,
}

/// Import an external session as a task of the project.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportExternalTask {
    /// `codex` or `claude`.
    pub provider: String,
    /// The native session/thread id to resume.
    pub session_id: String,
    pub title: Option<String>,
    /// Directory the session worked in, when known; the project root otherwise.
    pub cwd: Option<IpcPath>,
    /// Validated by the host; defaults to the window project root.
    #[serde(default)]
    pub project_root: Option<IpcPath>,
}

/// Streamed to the window that subscribed (`AgentManager::subscribe`).
#[derive(Clone, Debug, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    /// A task was created or its metadata changed.
    Task {
        task: AgentTask,
    },
    Removed {
        id: String,
    },
    /// The task's conversation was cut to its first `length` entries (turns rolled back).
    Truncated {
        task: String,
        length: u32,
    },
    /// Entry `index` of `task` (of its subagent `subagent`) was added or replaced.
    Entry {
        task: String,
        subagent: Option<String>,
        index: u32,
        entry: AgentEntry,
    },
    /// An agent reported the usage limits of its account (shared by every task of `provider`).
    Limits {
        provider: String,
        limits: Vec<AgentLimit>,
    },
    /// The installed or configured agent providers changed.
    Providers,
}
