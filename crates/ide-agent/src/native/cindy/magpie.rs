//! The local Magpie gateway catalog (B5): model discovery for the picker and the
//! wire ids the bridge executes. Plain HTTP on loopback, no new dependencies.

use serde_json::Value;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// `MAGPIE_BASE_URL`, defaulting to the local gateway (no credentials needed).
pub(crate) const DEFAULT_MAGPIE_BASE_URL: &str = "http://127.0.0.1:3425";
pub(crate) const MAGPIE_BASE_URL_ENV: &str = "MAGPIE_BASE_URL";
/// Bundled fallback when the gateway is down (the pre-magpie static list).
pub(crate) const FALLBACK_MODELS: &[(&str, &str)] = &[("sonnet", "Sonnet"), ("opus", "Opus"), ("haiku", "Haiku")];

pub(crate) fn magpie_base_url(env: &[(String, String)]) -> String {
    env.iter()
        .find(|(k, _)| k == MAGPIE_BASE_URL_ENV)
        .map(|(_, v)| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            std::env::var_os(MAGPIE_BASE_URL_ENV)
                .and_then(|v| v.into_string().ok())
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_MAGPIE_BASE_URL.into())
}

/// A magpie wire id (`auto/…`, `provider/…`); bare SDK aliases route legacy.
pub(crate) fn is_magpie_id(id: &str) -> bool {
    id.contains('/')
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MagpieModel {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub label: Option<String>,
}

fn text(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().filter_map(|k| v.get(k)).filter_map(Value::as_str).find_map(|s| {
        let s = s.trim();
        (!s.is_empty()).then(|| s.to_owned())
    })
}

/// Parses a magpie `/v1/models` body (`{data:[…]}` or a bare array).
pub(crate) fn parse_models(body: &Value) -> Vec<MagpieModel> {
    let list = match body {
        Value::Array(items) => items.as_slice(),
        v => v.get("data").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]),
    };
    list.iter()
        .filter_map(|m| {
            let id = text(m, &["id"])?;
            Some(MagpieModel {
                name: text(m, &["display_name", "displayName", "name"]).unwrap_or_else(|| id.clone()),
                provider: text(m, &["owned_by", "ownedBy", "providerId", "provider"]).unwrap_or_default(),
                label: text(m, &["magpie_label", "magpieLabel", "label"]),
                id,
            })
        })
        .collect()
}

/// Whether the model belongs to the Claude family (the only engine v0 runs).
fn is_claude_family(m: &MagpieModel) -> bool {
    [&m.id, &m.name, m.label.as_deref().unwrap_or_default()].iter().any(|s| s.to_lowercase().contains("claude"))
}

/// A model row offered to the picker.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OfferedModel {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

/// Picker rows from a magpie catalog.
pub(crate) fn offered(models: &[MagpieModel]) -> Vec<OfferedModel> {
    models
        .iter()
        .map(|m| OfferedModel {
            value: m.id.clone(),
            name: m.name.clone(),
            description: m.label.clone().or_else(|| (!m.provider.is_empty()).then(|| m.provider.clone())),
        })
        .collect()
}

/// Picker rows when the gateway is down (the pre-magpie static list).
pub(crate) fn fallback_offered() -> Vec<OfferedModel> {
    FALLBACK_MODELS
        .iter()
        .map(|(v, n)| OfferedModel { value: (*v).into(), name: (*n).into(), description: None })
        .collect()
}

/// The default model: an exact `CINDY_MODEL` match, else a Claude-family entry
/// (the only engine this driver runs), else the first entry.
pub(crate) fn pick_default(models: &[MagpieModel], preferred: Option<&str>) -> Option<String> {
    let preferred = preferred.map(str::trim).filter(|s| !s.is_empty());
    if let Some(want) = preferred
        && let Some(hit) = models.iter().find(|m| m.id == want)
    {
        return Some(hit.id.clone());
    }
    models.iter().find(|m| is_claude_family(m)).or_else(|| models.first()).map(|m| m.id.clone())
}

/// Fetches the gateway catalog. Plain HTTP only (`http://…` loopback);
/// anything else is refused rather than guessed.
pub(crate) async fn fetch_models(base_url: &str, timeout: Duration) -> Result<Vec<MagpieModel>, String> {
    let (status, body) = http_json(base_url, "GET", "/v1/models", None, timeout).await?;
    if status != 200 {
        return Err(format!("magpie catalog failed at {base_url}: HTTP {status}"));
    }
    Ok(parse_models(&body))
}

/// POSTs a minimal Anthropic message; `Ok(())` means the model serves right now.
/// Quota/auth failures surface as `Err` (the caller picks another model).
/// Test-only for now: runtime selection rides `fetch_models` + `pick_default`.
#[cfg(test)]
pub(crate) async fn probe_model(base_url: &str, model: &str, timeout: Duration) -> Result<(), String> {
    let body =
        serde_json::json!({ "model": model, "max_tokens": 1, "messages": [{ "role": "user", "content": "hi" }] });
    let (status, body) = http_json(base_url, "POST", "/v1/messages", Some(&body.to_string()), timeout).await?;
    if (200..300).contains(&status) {
        return Ok(());
    }
    let detail = format!("{body}");
    Err(format!("magpie model {model} not serving: HTTP {status}: {}", detail.chars().take(160).collect::<String>()))
}

/// Minimal HTTP/1.1 client (loopback gateways only): status + decoded JSON body.
async fn http_json(
    base_url: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
    timeout: Duration,
) -> Result<(u16, Value), String> {
    let url = base_url.trim_end_matches('/');
    let rest =
        url.strip_prefix("http://").ok_or_else(|| format!("magpie URL must be plain loopback http: {base_url}"))?;
    let host_port = match rest.find('/') {
        Some(i) => &rest[..i],
        None => rest,
    };
    // A base URL may carry a prefix (`http://host/gw` → `/gw/v1/models`).
    let prefix = match rest.find('/') {
        Some(i) => rest[i..].trim_end_matches('/').to_owned(),
        None => String::new(),
    };
    let path = format!("{prefix}{path}");
    let mut stream = tokio::time::timeout(timeout, tokio::net::TcpStream::connect(host_port))
        .await
        .map_err(|_| format!("magpie gateway unreachable at {base_url}"))?
        .map_err(|e| format!("magpie gateway unreachable at {base_url}: {e}"))?;
    let host = host_port.split('@').next_back().unwrap_or(host_port);
    let request = match body {
        Some(b) => format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccept: application/json\r\n\r\n{b}",
            b.len()
        ),
        None => {
            format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n")
        }
    };
    tokio::time::timeout(timeout, stream.write_all(request.as_bytes()))
        .await
        .map_err(|_| format!("magpie gateway timed out at {base_url}"))?
        .map_err(|e| format!("magpie gateway write failed at {base_url}: {e}"))?;
    let mut raw = Vec::new();
    tokio::time::timeout(timeout, stream.read_to_end(&mut raw))
        .await
        .map_err(|_| format!("magpie gateway timed out at {base_url}"))?
        .map_err(|e| format!("magpie gateway read failed at {base_url}: {e}"))?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) =
        text.split_once("\r\n\r\n").ok_or_else(|| format!("magpie returned no HTTP body at {base_url}"))?;
    let status: u16 = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| format!("magpie returned no HTTP status at {base_url}"))?;
    let body: Value = if is_chunked(head) {
        serde_json::from_str(&dechunk(body)?).map_err(|e| format!("magpie body is not JSON at {base_url}: {e}"))?
    } else {
        serde_json::from_slice(body.as_bytes()).map_err(|e| format!("magpie body is not JSON at {base_url}: {e}"))?
    };
    Ok((status, body))
}

fn is_chunked(head: &str) -> bool {
    head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    })
}

fn dechunk(body: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let (size_line, chunk) = rest.split_once("\r\n").ok_or("magpie used bad chunked framing")?;
        let size = usize::from_str_radix(size_line.trim().split(';').next().unwrap_or(""), 16)
            .map_err(|_| "magpie used bad chunked framing")?;
        if size == 0 {
            return Ok(out);
        }
        if chunk.len() < size {
            return Err("magpie used bad chunked framing".into());
        }
        out.push_str(&chunk[..size]);
        rest = chunk[size..].strip_prefix("\r\n").ok_or("magpie used bad chunked framing")?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_both_catalog_shapes() {
        let wrapped = json!({ "data": [
            { "id": "auto/a", "display_name": "A", "owned_by": "p", "magpie_label": "A · p" },
            { "id": "", "display_name": "Nameless" },
            { "id": "bare", "name": "Bare" },
        ]});
        let models = parse_models(&wrapped);
        assert_eq!(models.len(), 2);
        assert_eq!(
            models[0],
            MagpieModel { id: "auto/a".into(), name: "A".into(), provider: "p".into(), label: Some("A · p".into()) }
        );
        assert_eq!(models[1].name, "Bare");
        assert_eq!(parse_models(&json!([])).len(), 0);
        assert_eq!(parse_models(&json!({})).len(), 0);
    }

    #[test]
    fn default_prefers_exact_then_claude_family_then_first() {
        let models = vec![
            MagpieModel { id: "auto/g".into(), name: "G".into(), provider: "x".into(), label: None },
            MagpieModel { id: "auto/claude-x".into(), name: "C".into(), provider: "x".into(), label: None },
        ];
        assert_eq!(pick_default(&models, Some("auto/g")), Some("auto/g".into()));
        assert_eq!(pick_default(&models, None), Some("auto/claude-x".into()));
        assert_eq!(pick_default(&models, Some("  ")), Some("auto/claude-x".into()));
        assert_eq!(pick_default(&[], None), None);
        let gpt = vec![MagpieModel { id: "auto/g".into(), name: "G".into(), provider: "x".into(), label: None }];
        assert_eq!(pick_default(&gpt, None), Some("auto/g".into()));
    }

    #[test]
    fn wire_ids_contain_a_slash() {
        assert!(is_magpie_id("auto/x"));
        assert!(!is_magpie_id("sonnet"));
        assert!(!is_magpie_id(""));
    }

    #[test]
    fn base_url_prefers_env() {
        assert_eq!(magpie_base_url(&[]), DEFAULT_MAGPIE_BASE_URL);
        assert_eq!(magpie_base_url(&[("MAGPIE_BASE_URL".into(), "http://gw:9".into())]), "http://gw:9");
    }

    /// Live gateway check (needs the local magpie running; CI skips it).
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn fetch_live_magpie_catalog() {
        let models = fetch_models("http://127.0.0.1:3425", Duration::from_secs(10)).await.unwrap();
        assert!(!models.is_empty());
        assert!(models.iter().any(|m| m.id.contains('/')));
        println!("live catalog: {} models, e.g. {:?}", models.len(), models.first().unwrap());
    }
}
