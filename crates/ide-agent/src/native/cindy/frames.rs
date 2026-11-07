//! The cindy-bridge v0 NDJSON frames, mirroring `agent/cindy-bridge/src/protocol.ts`.
//!
//! Rust → bridge (stdin, one frame per line); bridge → Rust (stdout).
//! stderr never carries frames, only logs.

use serde_json::Value;

/// A frame Rust sends to the bridge (serialized as one NDJSON line).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum InFrame {
    Start { session: String, cwd: String, model: String },
    Prompt { session: String, text: String },
    Respond { session: String, permission_id: String, allow: bool },
    Cancel { session: String },
    Close { session: String },
}

impl InFrame {
    pub fn session(&self) -> &str {
        match self {
            InFrame::Start { session, .. }
            | InFrame::Prompt { session, .. }
            | InFrame::Respond { session, .. }
            | InFrame::Cancel { session }
            | InFrame::Close { session } => session,
        }
    }

    /// One NDJSON line (no trailing newline; the writer adds it).
    pub fn line(&self) -> String {
        let v = match self {
            InFrame::Start { session, cwd, model } => {
                serde_json::json!({ "type": "start", "session": session, "cwd": cwd, "model": model })
            }
            InFrame::Prompt { session, text } => {
                serde_json::json!({ "type": "prompt", "session": session, "text": text })
            }
            InFrame::Respond { session, permission_id, allow } => serde_json::json!({
                "type": "respond",
                "session": session,
                "permissionId": permission_id,
                "decision": if *allow { "allow" } else { "deny" },
            }),
            InFrame::Cancel { session } => serde_json::json!({ "type": "cancel", "session": session }),
            InFrame::Close { session } => serde_json::json!({ "type": "close", "session": session }),
        };
        serde_json::to_string(&v).unwrap_or_default()
    }
}

/// A frame the bridge sent (one stdout line).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum OutFrame {
    Started {
        session: String,
        sdk_session_id: String,
    },
    Text {
        session: String,
        delta: String,
        thinking: bool,
        final_: bool,
    },
    Tool {
        session: String,
        name: String,
        completed: bool,
        tool_use_id: Option<String>,
    },
    Permission {
        session: String,
        id: String,
        tool_name: Option<String>,
        summary: Option<String>,
    },
    PermissionDismissed {
        session: String,
        id: String,
    },
    Done {
        session: String,
        stop_reason: String,
    },
    /// `terminal` absent counts as terminal (the session is unusable).
    Error {
        session: String,
        message: String,
        terminal: bool,
    },
}

impl OutFrame {
    pub fn session(&self) -> &str {
        match self {
            OutFrame::Started { session, .. }
            | OutFrame::Text { session, .. }
            | OutFrame::Tool { session, .. }
            | OutFrame::Permission { session, .. }
            | OutFrame::PermissionDismissed { session, .. }
            | OutFrame::Done { session, .. }
            | OutFrame::Error { session, .. } => session,
        }
    }
}

fn session_of(v: &Value) -> Option<String> {
    v.get("session").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn required_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Parses one stdout line; `None` for blank lines, invalid JSON, unknown frame
/// types or missing fields (the caller logs and ignores it, like the bridge
/// does for malformed stdin).
pub(crate) fn parse_out_frame(line: &str) -> Option<OutFrame> {
    if line.trim().is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let session = session_of(&v)?;
    match v.get("type").and_then(Value::as_str) {
        Some("started") => {
            let sdk = required_str(&v, "sdkSessionId").filter(|s| !s.is_empty())?;
            Some(OutFrame::Started { session, sdk_session_id: sdk })
        }
        Some("text") => {
            let delta = required_str(&v, "delta")?;
            let thinking = v.get("kind").and_then(Value::as_str) == Some("thinking");
            if let Some(kind) = v.get("kind").and_then(Value::as_str)
                && kind != "text"
                && kind != "thinking"
            {
                return None;
            }
            let final_ = v.get("final").and_then(Value::as_bool).unwrap_or(false);
            Some(OutFrame::Text { session, delta, thinking, final_ })
        }
        Some("tool") => {
            let name = required_str(&v, "name").filter(|s| !s.is_empty())?;
            let completed = match v.get("status").and_then(Value::as_str) {
                Some("started") => false,
                Some("completed") => true,
                _ => return None,
            };
            let tool_use_id = v.get("toolUseId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
            Some(OutFrame::Tool { session, name, completed, tool_use_id })
        }
        Some("permission") => {
            let id = required_str(&v, "id").filter(|s| !s.is_empty())?;
            let tool_name = v.get("toolName").and_then(Value::as_str).map(str::to_owned);
            let summary = v.get("summary").and_then(Value::as_str).map(str::to_owned);
            Some(OutFrame::Permission { session, id, tool_name, summary })
        }
        Some("permission_dismissed") => {
            let id = required_str(&v, "id").filter(|s| !s.is_empty())?;
            Some(OutFrame::PermissionDismissed { session, id })
        }
        Some("done") => {
            let stop_reason = required_str(&v, "stopReason").unwrap_or_else(|| "end_turn".to_owned());
            Some(OutFrame::Done { session, stop_reason })
        }
        Some("error") => {
            let message = required_str(&v, "message").unwrap_or_default();
            let terminal = v.get("terminal").and_then(Value::as_bool).unwrap_or(true);
            Some(OutFrame::Error { session, message, terminal })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_frames_serialize_like_protocol_ts() {
        assert_eq!(
            InFrame::Start { session: "s".into(), cwd: "/w".into(), model: "sonnet".into() }.line(),
            r#"{"cwd":"/w","model":"sonnet","session":"s","type":"start"}"#
        );
        assert_eq!(
            InFrame::Respond { session: "s".into(), permission_id: "p".into(), allow: false }.line(),
            r#"{"decision":"deny","permissionId":"p","session":"s","type":"respond"}"#
        );
        assert_eq!(InFrame::Cancel { session: "s".into() }.line(), r#"{"session":"s","type":"cancel"}"#);
    }

    #[test]
    fn out_frames_reject_malformed_lines() {
        assert_eq!(parse_out_frame(""), None);
        assert_eq!(parse_out_frame("  \n"), None);
        assert_eq!(parse_out_frame("not json"), None);
        assert_eq!(parse_out_frame(r#"{"type":"started"}"#), None);
        assert_eq!(parse_out_frame(r#"{"type":"nope","session":"s"}"#), None);
        assert_eq!(parse_out_frame(r#"{"type":"started","session":"s"}"#), None);
        assert_eq!(parse_out_frame(r#"{"type":"tool","session":"s","name":"Read","status":"running"}"#), None);
        assert_eq!(parse_out_frame(r#"{"type":"text","session":"s","delta":"x","kind":"weird"}"#), None);
        // An empty tool name carries nothing to show.
        assert_eq!(parse_out_frame(r#"{"type":"tool","session":"s","name":"","status":"started"}"#), None);
    }

    #[test]
    fn out_frames_parse_and_default() {
        assert_eq!(
            parse_out_frame(r#"{"type":"started","session":"s","sdkSessionId":"abc"}"#),
            Some(OutFrame::Started { session: "s".into(), sdk_session_id: "abc".into() })
        );
        assert_eq!(
            parse_out_frame(r#"{"type":"text","session":"s","delta":"hi"}"#),
            Some(OutFrame::Text { session: "s".into(), delta: "hi".into(), thinking: false, final_: false })
        );
        assert_eq!(
            parse_out_frame(r#"{"type":"text","session":"s","delta":"hmm","kind":"thinking","final":true}"#),
            Some(OutFrame::Text { session: "s".into(), delta: "hmm".into(), thinking: true, final_: true })
        );
        // `terminal` absent counts as terminal.
        assert_eq!(
            parse_out_frame(r#"{"type":"error","session":"s","message":"boom"}"#),
            Some(OutFrame::Error { session: "s".into(), message: "boom".into(), terminal: true })
        );
        assert_eq!(
            parse_out_frame(r#"{"type":"error","session":"s","message":"late","terminal":false}"#),
            Some(OutFrame::Error { session: "s".into(), message: "late".into(), terminal: false })
        );
        assert_eq!(
            parse_out_frame(r#"{"type":"done","session":"s"}"#),
            Some(OutFrame::Done { session: "s".into(), stop_reason: "end_turn".into() })
        );
    }
}
