//! Bridge v0 out-frames as ACP `session/update`s, the only language the task
//! understands. Pure functions plus two small per-session states, both unit
//! tested here; the process plumbing lives in `super`.
//!
//! Text framing: the bridge sends deltas, then the full text (`final`). The
//! timeline only appends, so the translator keeps a per-turn buffer per kind
//! and emits just the unseen tail: exact final text, no duplication.

use super::frames::OutFrame;
use serde_json::{Value, json};
use std::collections::HashMap;

/// One `session/update`: the session it belongs to and the update object.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Update {
    pub session: String,
    pub update: Value,
}

fn update(session: &str, update: Value) -> Update {
    Update { session: session.to_owned(), update }
}

const TEXT_CHUNK: &str = "agent_message_chunk";
const THOUGHT_CHUNK: &str = "agent_thought_chunk";

fn chunk(session: &str, thinking: bool, text: &str) -> Update {
    let kind = if thinking { THOUGHT_CHUNK } else { TEXT_CHUNK };
    update(session, json!({ "sessionUpdate": kind, "content": { "type": "text", "text": text } }))
}

/// ACP content blocks of a `session/prompt` as the plain text the bridge sends.
pub(crate) fn prompt_text(prompt: &Value) -> String {
    prompt
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| match b.get("type").and_then(Value::as_str) {
            Some("text") => b.get("text").and_then(Value::as_str).map(str::to_owned),
            Some("resource") => {
                let r = b.get("resource")?;
                r.get("text")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| r.get("uri").and_then(Value::as_str).map(str::to_owned))
            }
            Some("resource_link") => b
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| b.get("uri").and_then(Value::as_str).map(str::to_owned)),
            _ => None,
        })
        .filter(|t| !t.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The text of one turn so far: what arrived (`buffer`) and what the timeline
/// already shows (`emitted`). A `final` full text replaces the buffer; only the
/// unseen tail goes out, so deltas + final never duplicate.
#[derive(Debug, Default)]
pub(crate) struct TurnText {
    buffer: String,
    emitted: usize,
}

impl TurnText {
    /// Folds a `text` frame; `None` when the timeline learns nothing new.
    pub fn push(&mut self, session: &str, thinking: bool, delta: &str, final_: bool) -> Option<Update> {
        if final_ {
            self.buffer = delta.to_owned();
        } else {
            self.buffer.push_str(delta);
        }
        let tail = common_tail(&self.buffer, self.emitted);
        if tail.is_empty() {
            return None;
        }
        self.emitted += tail.len();
        Some(chunk(session, thinking, tail))
    }
}

/// The unseen tail of `buffer`: the suffix after `emitted` bytes when that is a
/// char boundary of a prefix, else the whole buffer (the vendor drifted; the
/// timeline shows the correction rather than nothing).
fn common_tail(buffer: &str, emitted: usize) -> &str {
    if emitted == 0 {
        return buffer;
    }
    match buffer.get(..emitted) {
        Some(_) => buffer.get(emitted..).unwrap_or(""),
        None => buffer,
    }
}

/// In-flight tool calls of a session, correlating the bridge's `tool` frames
/// (which may lack ids) to timeline entries.
#[derive(Debug, Default)]
pub(crate) struct ToolTracker {
    /// Tool-call id → tool name, in start order.
    order: Vec<(String, String)>,
    next: u64,
}

impl ToolTracker {
    /// Folds a `tool` frame into `tool_call` / `tool_call_update` updates.
    /// `fields` builds the call's title/kind from its name (shared with the
    /// Claude driver, so both show the same titles).
    pub fn push(
        &mut self,
        session: &str,
        name: &str,
        completed: bool,
        tool_use_id: Option<&str>,
        fields: impl Fn(&str) -> Value,
    ) -> Vec<Update> {
        if !completed {
            let id = tool_use_id
                .filter(|id| !self.order.iter().any(|(known, _)| known == id))
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    self.next += 1;
                    format!("cindy-tool-{}", self.next)
                });
            self.order.push((id.clone(), name.to_owned()));
            let mut call = fields(name);
            call["sessionUpdate"] = json!("tool_call");
            call["toolCallId"] = json!(id);
            call["status"] = json!("in_progress");
            return vec![update(session, call)];
        }
        let pos = tool_use_id
            .and_then(|id| self.order.iter().position(|(known, _)| known == id))
            .or_else(|| self.order.iter().rposition(|(_, n)| n == name))
            .or_else(|| self.order.last().map(|_| self.order.len() - 1));
        match pos {
            Some(i) => {
                let (id, _) = self.order.remove(i);
                vec![update(
                    session,
                    json!({
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": id,
                        "status": "completed",
                    }),
                )]
            }
            // Completed without a start (a stale frame after a restart): show it
            // as an already-finished call rather than dropping it silently.
            None => {
                let mut call = fields(name);
                call["sessionUpdate"] = json!("tool_call");
                call["toolCallId"] = json!(tool_use_id.unwrap_or(name));
                call["status"] = json!("completed");
                vec![update(session, call)]
            }
        }
    }

    /// Marks every in-flight call failed (the bridge died mid-turn).
    pub fn fail_all(&mut self, session: &str) -> Vec<Update> {
        let ids: Vec<String> = self.order.drain(..).map(|(id, _)| id).collect();
        ids.into_iter()
            .map(|id| {
                update(
                    session,
                    json!({
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": id,
                        "status": "failed",
                    }),
                )
            })
            .collect()
    }

    /// Test introspection: no call is in flight.
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
}

/// Folds one out-frame (except `started` / `done` / terminal `error`, which
/// complete RPCs in `super`). Returns the timeline updates for it.
pub(crate) fn fold(
    frame: &OutFrame,
    text: &mut HashMap<bool, TurnText>,
    tools: &mut ToolTracker,
    fields: impl Fn(&str) -> Value,
) -> Vec<Update> {
    match frame {
        OutFrame::Text { session, delta, thinking, final_ } => {
            text.entry(*thinking).or_default().push(session, *thinking, delta, *final_).into_iter().collect()
        }
        OutFrame::Tool { session, name, completed, tool_use_id } => {
            tools.push(session, name, *completed, tool_use_id.as_deref(), fields)
        }
        // Permission prompts and dismissals are answered in `super` (they need
        // the client); the timeline only learns the call exists. `super` calls
        // `ensure_tool_call` for the same update, so folding stays idempotent.
        OutFrame::Permission { session, id, tool_name, summary } => {
            vec![ensure_tool_call(session, id, tool_name.as_deref(), summary.as_deref(), tools, fields)]
        }
        OutFrame::PermissionDismissed { .. } | OutFrame::Started { .. } | OutFrame::Done { .. } => Vec::new(),
        OutFrame::Error { session, message, terminal } if !terminal => {
            vec![chunk(session, true, &format!("Bridge note: {message}"))]
        }
        OutFrame::Error { .. } => Vec::new(),
    }
}

/// A `tool_call` for a permission request, reusing the in-flight call when the
/// bridge already announced it (same id → same timeline entry).
pub(crate) fn ensure_tool_call(
    session: &str,
    id: &str,
    tool_name: Option<&str>,
    summary: Option<&str>,
    tools: &mut ToolTracker,
    fields: impl Fn(&str) -> Value,
) -> Update {
    let known = tools.order.iter().any(|(known, _)| known == id);
    if known {
        let mut call = json!({});
        call["sessionUpdate"] = json!("tool_call");
        call["toolCallId"] = json!(id);
        call["status"] = json!("in_progress");
        if let Some(title) = summary.or(tool_name) {
            call["title"] = json!(title);
        }
        return update(session, call);
    }
    let name = tool_name.unwrap_or("tool");
    tools.order.push((id.to_owned(), name.to_owned()));
    let mut call = fields(name);
    call["sessionUpdate"] = json!("tool_call");
    call["toolCallId"] = json!(id);
    call["status"] = json!("in_progress");
    if let Some(title) = summary {
        call["title"] = json!(title);
    }
    update(session, call)
}

/// The `toolCall` of a permission request, from the ensured call's id.
pub(crate) fn permission_tool_call(id: &str, tool_name: Option<&str>, summary: Option<&str>) -> Value {
    json!({
        "toolCallId": id,
        "title": summary.or(tool_name).unwrap_or("tool"),
        "kind": "other",
    })
}

/// The options of a permission request. v0 has no session-scoped allow (the
/// bridge rejects `permissionUpdates`), so only this request is decided.
pub(crate) fn permission_options() -> Value {
    json!([
        { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
        { "optionId": "reject", "name": "Reject", "kind": "reject_once" },
    ])
}

/// Whether the client's answer allows the tool.
pub(crate) fn answer_allows(answer: &Value) -> bool {
    answer.pointer("/outcome/outcome").and_then(Value::as_str) == Some("selected")
        && matches!(
            answer.pointer("/outcome/optionId").and_then(Value::as_str),
            Some("allow") | Some("allow-always") | Some("allow_always")
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::claude::tools::call_fields;
    use std::path::Path;

    fn fields(name: &str) -> Value {
        call_fields(name, &json!({}), Path::new("/w"))
    }

    #[test]
    fn prompt_text_reads_blocks() {
        let prompt = json!([
            { "type": "text", "text": "fix it" },
            { "type": "resource_link", "uri": "file:///w/a.rs", "name": "a.rs" },
            { "type": "resource", "resource": { "uri": "file:///w/b.rs", "text": "code" } },
            { "type": "image", "mimeType": "image/png", "data": "x" },
        ]);
        assert_eq!(prompt_text(&prompt), "fix it\na.rs\ncode");
        assert_eq!(prompt_text(&json!([])), "");
        assert_eq!(prompt_text(&json!({})), "");
    }

    #[test]
    fn text_deltas_then_final_emit_once() {
        let mut text = HashMap::new();
        let run = |text: &mut HashMap<bool, TurnText>, thinking: bool, delta: &str, final_: bool| {
            fold(
                &OutFrame::Text { session: "s".into(), delta: delta.into(), thinking, final_ },
                text,
                &mut ToolTracker::default(),
                fields,
            )
        };
        let bodies: Vec<String> = ["hel", "lo"]
            .into_iter()
            .flat_map(|d| run(&mut text, false, d, false))
            .filter_map(|u| u.update.pointer("/content/text").and_then(Value::as_str).map(str::to_owned))
            .collect();
        assert_eq!(bodies.concat(), "hello");
        // The final full text adds nothing new.
        assert!(run(&mut text, false, "hello", true).is_empty());
        // Thinking is a separate stream.
        let thinking = run(&mut text, true, "hmm", false);
        assert_eq!(thinking.len(), 1);
        assert_eq!(thinking[0].update["sessionUpdate"], "agent_thought_chunk");
    }

    #[test]
    fn final_without_deltas_emits_full_text() {
        let mut text = HashMap::new();
        let updates = fold(
            &OutFrame::Text { session: "s".into(), delta: "all at once".into(), thinking: false, final_: true },
            &mut text,
            &mut ToolTracker::default(),
            fields,
        );
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].update.pointer("/content/text").and_then(Value::as_str), Some("all at once"));
    }

    #[test]
    fn tool_frames_correlate_by_id_then_name() {
        let mut tools = ToolTracker::default();
        let run = |tools: &mut ToolTracker, frame: OutFrame| fold(&frame, &mut HashMap::new(), tools, fields);
        let started = |name: &str, id: Option<&str>| OutFrame::Tool {
            session: "s".into(),
            name: name.into(),
            completed: false,
            tool_use_id: id.map(str::to_owned),
        };
        let done = |name: &str, id: Option<&str>| OutFrame::Tool {
            session: "s".into(),
            name: name.into(),
            completed: true,
            tool_use_id: id.map(str::to_owned),
        };
        let first = run(&mut tools, started("Read", Some("u1")));
        assert_eq!(first[0].update["toolCallId"], "u1");
        assert_eq!(first[0].update["status"], "in_progress");
        // An unnamed completion matches the in-flight call by name.
        let completed = run(&mut tools, done("Read", None));
        assert_eq!(
            completed,
            vec![update(
                "s",
                json!({
                    "sessionUpdate": "tool_call_update", "toolCallId": "u1", "status": "completed",
                })
            )]
        );
        assert!(tools.is_empty());
        // An orphan completion still shows up, finished.
        let orphan = run(&mut tools, done("Bash", None));
        assert_eq!(orphan[0].update["status"], "completed");
        assert_eq!(orphan[0].update["sessionUpdate"], "tool_call");
    }

    #[test]
    fn permission_ensures_one_call_and_non_terminal_errors_note() {
        let mut tools = ToolTracker::default();
        let updates = fold(
            &OutFrame::Permission {
                session: "s".into(),
                id: "p1".into(),
                tool_name: Some("Edit".into()),
                summary: Some("Edit a.rs".into()),
            },
            &mut HashMap::new(),
            &mut tools,
            fields,
        );
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].update["toolCallId"], "p1");
        assert_eq!(updates[0].update["title"], "Edit a.rs");
        // Folding the same permission twice reuses the entry.
        let again = fold(
            &OutFrame::Permission { session: "s".into(), id: "p1".into(), tool_name: None, summary: None },
            &mut HashMap::new(),
            &mut tools,
            fields,
        );
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].update["toolCallId"], "p1");
        let note = fold(
            &OutFrame::Error { session: "s".into(), message: "denied by timeout".into(), terminal: false },
            &mut HashMap::new(),
            &mut tools,
            fields,
        );
        assert_eq!(note[0].update["sessionUpdate"], "agent_thought_chunk");
    }

    #[test]
    fn answers_allow_only_on_selected_allow() {
        assert!(answer_allows(&json!({ "outcome": { "outcome": "selected", "optionId": "allow" } })));
        assert!(!answer_allows(&json!({ "outcome": { "outcome": "selected", "optionId": "reject" } })));
        assert!(!answer_allows(&json!({ "outcome": { "outcome": "cancelled" } })));
        assert!(!answer_allows(&json!({})));
    }
}
