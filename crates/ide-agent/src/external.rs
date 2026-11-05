//! Sessions created outside OpenIDEA (another Codex or Claude client): read-only
//! discovery from the agents' own history on disk, so they can be imported as tasks
//! and resumed under their own session id.
//!
//! The discovery never writes: it reads `session_index.jsonl` for Codex and the
//! `<config>/projects/<escaped cwd>/<id>.jsonl` transcripts for Claude Code, taking
//! only file metadata plus small head/tail slices (transcripts can be hundreds of MB).

use crate::model::ExternalSession;
use ide_core::IpcPath;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// How many sessions are listed at most, newest first.
pub(crate) const MAX_SESSIONS: usize = 200;
/// How much of a transcript is read from its start (for `cwd` and the first message)
/// and from its end (for a late title entry).
const SLICE_BYTES: u64 = 64 * 1024;
/// How many head lines are parsed for `cwd` and the first message.
const HEAD_LINES: usize = 200;

/// Value of `key` in `env` (a provider's own environment), else the process environment.
fn env_value(env: &[(String, String)], key: &str) -> Option<PathBuf> {
    env.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| PathBuf::from(v))
        .or_else(|| std::env::var_os(key).map(PathBuf::from))
}

/// Codex's home (`CODEX_HOME`, else `~/.codex`): `session_index.jsonl` lives there.
pub(crate) fn codex_home(home: Option<&Path>, env: &[(String, String)]) -> Option<PathBuf> {
    if let Some(dir) = env_value(env, "CODEX_HOME") {
        return Some(dir);
    }
    home.map(|h| h.join(".codex"))
}

/// Claude Code's configuration directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`).
pub(crate) fn claude_dir(home: Option<&Path>, env: &[(String, String)]) -> Option<PathBuf> {
    if let Some(dir) = env_value(env, "CLAUDE_CONFIG_DIR") {
        return Some(dir);
    }
    home.map(|h| h.join(".claude"))
}

/// Sessions of `provider` (`codex` or `claude`) on this machine, newest first;
/// `imported` is left false for the caller (which knows the tasks) to fill in.
pub(crate) fn list(provider: &str, home: Option<&Path>, env: &[(String, String)]) -> Vec<ExternalSession> {
    match provider {
        "codex" => codex_home(home, env).as_deref().map(list_codex).unwrap_or_default(),
        "claude" => claude_dir(home, env).as_deref().map(list_claude).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Whether `session_id` still exists on this machine and can be resumed.
pub(crate) fn exists(provider: &str, session_id: &str, home: Option<&Path>, env: &[(String, String)]) -> bool {
    match provider {
        "codex" => codex_home(home, env).is_some_and(|h| index_contains(&h, session_id)),
        "claude" => claude_dir(home, env).is_some_and(|d| transcript_exists(&d, session_id)),
        _ => false,
    }
}

/// Whether Codex's index still names the thread.
fn index_contains(home: &Path, session_id: &str) -> bool {
    let text = std::fs::read_to_string(home.join("session_index.jsonl")).unwrap_or_default();
    text.lines().any(|line| {
        serde_json::from_str::<Value>(line).ok().and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_owned))
            == Some(session_id.to_owned())
    })
}

/// Whether any Claude project directory holds the session's transcript.
fn transcript_exists(config: &Path, session_id: &str) -> bool {
    let file = format!("{session_id}.jsonl");
    std::fs::read_dir(config.join("projects"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|d| {
            let path = d.path().join(&file);
            path.is_file().then_some(path)
        })
        .next()
        .is_some()
}

/// Codex's `session_index.jsonl`: one `{"id","thread_name","updated_at"}` line per thread.
fn list_codex(home: &Path) -> Vec<ExternalSession> {
    let text = std::fs::read_to_string(home.join("session_index.jsonl")).unwrap_or_default();
    let mut out: Vec<ExternalSession> = Vec::new();
    let mut seen = HashSet::new();
    for line in text.lines() {
        let entry: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(id) = entry.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
        if !seen.insert(id.to_owned()) {
            continue;
        }
        let title = entry
            .get("thread_name")
            .and_then(Value::as_str)
            .filter(|t| !t.trim().is_empty())
            .map_or_else(|| "Codex session".to_owned(), str::to_owned);
        let updated_ms = entry.get("updated_at").and_then(Value::as_str).map(parse_time).unwrap_or(0.0);
        out.push(ExternalSession {
            provider: "codex".into(),
            session_id: id.to_owned(),
            title,
            cwd: None,
            updated_ms,
            imported: false,
        });
    }
    out.sort_by(|a, b| b.updated_ms.total_cmp(&a.updated_ms));
    out.truncate(MAX_SESSIONS);
    out
}

/// Claude Code transcripts: `<config>/projects/<escaped cwd>/<id>.jsonl`, newest first.
fn list_claude(config: &Path) -> Vec<ExternalSession> {
    let projects = config.join("projects");
    let dirs = std::fs::read_dir(&projects).into_iter().flatten().flatten().filter_map(|d| {
        let path = d.path();
        path.is_dir().then_some(path)
    });
    let mut files: Vec<(PathBuf, f64)> = Vec::new();
    for dir in dirs {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "jsonl") || !path.is_file() {
                continue;
            }
            let updated_ms = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0.0, |d| d.as_millis() as f64);
            files.push((path, updated_ms));
        }
    }
    files.sort_by(|a, b| b.1.total_cmp(&a.1));
    files.truncate(MAX_SESSIONS);
    files
        .into_iter()
        .filter_map(|(path, updated_ms)| {
            let id = path.file_stem()?.to_str()?.to_owned();
            if id.is_empty() {
                return None;
            }
            let (cwd, title) = describe_transcript(&path, &id);
            Some(ExternalSession {
                provider: "claude".into(),
                session_id: id,
                title,
                cwd: cwd.map(IpcPath),
                updated_ms,
                imported: false,
            })
        })
        .collect()
}

/// The `cwd` (from the head) and title of a transcript: its saved custom title, else a
/// late title entry, else its first user message.
fn describe_transcript(path: &Path, id: &str) -> (Option<PathBuf>, String) {
    let head = read_slice(path, 0, SLICE_BYTES);
    let mut cwd = None;
    let mut first_message = None;
    for line in head.lines().take(HEAD_LINES) {
        let entry: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if cwd.is_none() {
            cwd = entry.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()).map(PathBuf::from);
        }
        if first_message.is_none() {
            first_message = user_text(&entry);
        }
        if cwd.is_some() && first_message.is_some() {
            break;
        }
    }
    let mut title = custom_title_of(path, id).or_else(|| tail_title_of(path)).unwrap_or_default();
    if title.trim().is_empty() {
        title = first_message.map_or_else(|| "Claude session".to_owned(), |m| truncate(&m, 60));
    }
    (cwd, title)
}

/// The saved custom title next to the transcript (`<id>/custom-title.json`).
fn custom_title_of(path: &Path, id: &str) -> Option<String> {
    let bytes = std::fs::read(path.parent()?.join(id).join("custom-title.json")).ok()?;
    let title: Value = serde_json::from_slice(&bytes).ok()?;
    title.get("customTitle").and_then(Value::as_str).filter(|t| !t.trim().is_empty()).map(str::to_owned)
}

/// A title entry near the end of the transcript (`ai-title` / `custom-title`).
fn tail_title_of(path: &Path) -> Option<String> {
    let len = std::fs::metadata(path).ok()?.len();
    let tail = read_slice(path, len.saturating_sub(SLICE_BYTES), SLICE_BYTES);
    tail.lines().rev().find_map(|line| {
        let entry: Value = serde_json::from_str(line).ok()?;
        match entry.get("type").and_then(Value::as_str)? {
            "ai-title" => entry.get("aiTitle").and_then(Value::as_str),
            "custom-title" => entry.get("customTitle").and_then(Value::as_str),
            _ => None,
        }
        .filter(|t| !t.trim().is_empty())
        .map(str::to_owned)
    })
}

/// Up to `len` bytes of `path` from `offset`, lossily decoded.
fn read_slice(path: &Path, offset: u64, len: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return String::new();
    }
    let mut buf = vec![0u8; len.min(8 * 1024 * 1024) as usize];
    let mut read = 0;
    while read < buf.len() {
        match file.read(&mut buf[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(_) => break,
        }
    }
    buf.truncate(read);
    String::from_utf8_lossy(&buf).into_owned()
}

/// The text of a user entry that started a turn: not metadata, a steer, or tool results.
fn user_text(entry: &Value) -> Option<String> {
    if entry.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    if entry.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    if entry.get("uuid").and_then(Value::as_str).is_some_and(|u| u.ends_with("57ee")) {
        return None;
    }
    match entry.pointer("/message/content") {
        Some(Value::String(s)) => {
            (!s.starts_with("<local-command") && !s.starts_with("[Request interrupted")).then(|| s.clone())
        }
        Some(Value::Array(blocks)) => {
            if blocks.is_empty() || blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
            {
                return None;
            }
            blocks
                .iter()
                .find_map(|b| b.get("text").and_then(Value::as_str).filter(|t| !t.starts_with("[Request interrupted")))
                .map(str::to_owned)
        }
        _ => None,
    }
}

fn truncate(text: &str, len: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    match line.char_indices().nth(len) {
        Some((cut, _)) => format!("{}…", &line[..cut]),
        None if line.is_empty() => "Claude session".to_owned(),
        None => line.to_owned(),
    }
}

/// `updated_at` of `session_index.jsonl` (`2026-11-05T18:07:20.3711346Z`, UTC) as ms
/// since the epoch; `0.0` when it doesn't parse.
fn parse_time(text: &str) -> f64 {
    let (date, time) = text.split_once('T').unwrap_or((text, ""));
    let [y, m, d] = parts(date, '-');
    let (time, offset) = split_offset(time);
    let time = time.strip_suffix('Z').unwrap_or(time);
    let (hms, _) = time.split_once('.').map_or((time, ""), |(h, f)| (h, f));
    let [hh, mm, ss] = parts(hms, ':');
    let days = days_from_civil(y, m, d);
    let secs = (days * 86_400 + hh * 3_600 + mm * 60 + ss) as f64 - offset;
    secs * 1000.0
}

fn parts(text: &str, sep: char) -> [i64; 3] {
    let mut out = [0; 3];
    for (i, p) in text.split(sep).enumerate().take(3) {
        out[i] = p.parse().unwrap_or(0);
    }
    out
}

/// Seconds east of UTC of the `+hh:mm` suffix (0 for `Z` or none); split off the time.
fn split_offset(time: &str) -> (&str, f64) {
    let at = time.rfind(['+', '-']).filter(|&i| i > 0);
    match at.and_then(|i| time.split_at_checked(i)) {
        Some((t, zone)) if zone.len() >= 3 => {
            let sign = if zone.starts_with('-') { -1.0 } else { 1.0 };
            let [hh, mm, _] = parts(&zone[1..], ':');
            (t, sign * (hh * 3_600 + mm * 60) as f64)
        }
        _ => (time, 0.0),
    }
}

/// Days since the Unix epoch (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn codex_index(index: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".codex")).unwrap();
        std::fs::write(dir.path().join(".codex").join("session_index.jsonl"), index).unwrap();
        dir
    }

    #[test]
    fn codex_sessions_come_newest_first_and_skip_bad_lines() {
        let dir = codex_index(&[
            "{\"id\":\"019d0d60-ae65-7be1-bf7d-3a41e74904c4\",\"thread_name\":\"Fix mojibake\",\"updated_at\":\"2026-03-20T22:32:27.919Z\"}",
            "not json",
            "{\"id\":\"019ccc4d-802c-7b02-aa07-e2262faffd6a\",\"thread_name\":\"\",\"updated_at\":\"2026-03-08T07:16:03.5177426Z\"}",
            "{\"id\":\"019d0d60-ae65-7be1-bf7d-3a41e74904c4\",\"thread_name\":\"dup\",\"updated_at\":\"2026-03-21T00:00:00Z\"}",
            "{\"id\":\"\",\"thread_name\":\"empty id\",\"updated_at\":\"2026-03-22T00:00:00Z\"}",
        ].join("\n"));
        let found = list("codex", Some(dir.path()), &[]);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].session_id, "019d0d60-ae65-7be1-bf7d-3a41e74904c4");
        assert_eq!(found[0].title, "Fix mojibake");
        assert!(found[0].updated_ms > found[1].updated_ms);
        assert_eq!(found[1].title, "Codex session", "an empty name falls back");
        assert!(found.iter().all(|s| s.provider == "codex" && s.cwd.is_none() && !s.imported));
    }

    #[test]
    fn codex_times_parse_with_fractions_and_offsets() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), 0.0);
        // Fractions are dropped: the index only orders sessions, it never shows the time.
        assert_eq!(parse_time("2026-03-20T22:32:27.919Z"), parse_time("2026-03-20T22:32:27Z"));
        assert!(parse_time("2026-03-20T22:32:27Z") > 0.0);
        // `+08:00` is eight hours east: the same instant as 14:32 UTC.
        assert_eq!(parse_time("2026-03-21T22:32:27+08:00"), parse_time("2026-03-21T14:32:27Z"));
        assert!(parse_time("garbage").is_finite(), "unparseable input stays a number");
    }

    fn claude_projects() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        // `list` reads transcripts under the home's `.claude`.
        let projects = dir.path().join(".claude").join("projects").join("D--code-openidea");
        std::fs::create_dir_all(&projects).unwrap();
        (dir, projects)
    }

    fn write_transcript(dir: &Path, id: &str, lines: &[Value]) {
        let mut text = String::new();
        for l in lines {
            text.push_str(&serde_json::to_string(l).unwrap());
            text.push('\n');
        }
        let mut file = std::fs::File::create(dir.join(format!("{id}.jsonl"))).unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    fn user(uuid: &str, parent: Option<&str>, text: &str) -> Value {
        serde_json::json!({"type": "user", "uuid": uuid, "parentUuid": parent, "cwd": "D:\\code\\openidea",
            "message": {"role": "user", "content": text}})
    }

    #[test]
    fn claude_lists_transcripts_with_custom_title_and_cwd() {
        let (dir, projects) = claude_projects();
        let id = "2b3681d2-ffb4-4f5b-955a-023c2ce3ba8a";
        write_transcript(
            &projects,
            id,
            &[
                serde_json::json!({"type": "attachment", "uuid": "h", "cwd": "D:\\code\\openidea"}),
                user("u1", None, "Compress the Docker disk usage"),
            ],
        );
        std::fs::create_dir_all(projects.join(id)).unwrap();
        std::fs::write(projects.join(id).join("custom-title.json"), "{\"customTitle\":\"Docker disk usage\"}").unwrap();
        let found = list("claude", Some(dir.path()), &[]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].session_id, id);
        assert_eq!(found[0].title, "Docker disk usage");
        assert_eq!(found[0].cwd, Some(IpcPath(PathBuf::from("D:\\code\\openidea"))));
        assert!(found[0].updated_ms > 0.0);
    }

    #[test]
    fn claude_falls_back_to_first_message_and_tail_title() {
        let (dir, projects) = claude_projects();
        write_transcript(
            &projects,
            "aaa",
            &[user("u1", None, "First line"), serde_json::json!({"type": "ai-title", "aiTitle": "Late title"})],
        );
        write_transcript(&projects, "bbb", &[serde_json::json!({"type": "system", "cwd": "C:\\work"})]);
        let mut found = list("claude", Some(dir.path()), &[]);
        found.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        assert_eq!(found[0].title, "Late title");
        assert_eq!(found[1].title, "Claude session");
        assert_eq!(found[1].cwd, Some(IpcPath(PathBuf::from("C:\\work"))));
    }

    #[test]
    fn unknown_providers_and_missing_dirs_list_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list("opencode", Some(dir.path()), &[]).is_empty());
        assert!(list("codex", Some(dir.path()), &[]).is_empty());
        assert!(list("claude", Some(dir.path()), &[]).is_empty());
        assert!(list("codex", None, &[]).is_empty());
    }

    #[test]
    fn home_overrides_come_from_the_environment() {
        let codex = tempfile::tempdir().unwrap();
        let claude = tempfile::tempdir().unwrap();
        let env = vec![
            ("CODEX_HOME".to_owned(), codex.path().to_string_lossy().into_owned()),
            ("CLAUDE_CONFIG_DIR".to_owned(), claude.path().to_string_lossy().into_owned()),
        ];
        assert_eq!(codex_home(None, &env), Some(codex.path().to_path_buf()));
        assert_eq!(claude_dir(None, &env), Some(claude.path().to_path_buf()));
        assert_eq!(claude_dir(None, &[]), None);
    }

    #[test]
    fn existence_checks_match_what_listing_finds() {
        let dir = codex_index("{\"id\":\"abc\",\"thread_name\":\"t\",\"updated_at\":\"2026-03-20T22:32:27Z\"}\n");
        assert!(exists("codex", "abc", Some(dir.path()), &[]));
        assert!(!exists("codex", "missing", Some(dir.path()), &[]));
        let (cdir, projects) = claude_projects();
        write_transcript(&projects, "aaa", &[user("u1", None, "hi")]);
        assert!(exists("claude", "aaa", Some(cdir.path()), &[]));
        assert!(!exists("claude", "missing", Some(cdir.path()), &[]));
        assert!(!exists("opencode", "aaa", Some(cdir.path()), &[]));
    }
}
