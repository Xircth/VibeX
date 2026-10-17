use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{error::BrowserHostError, types::BrowserAction};

pub const AGENT_BUNDLE: &str = include_str!("../js/agent.bundle.js");
pub const AGENT_GLOBAL: &str = "__codegAgent";
pub const ENGINE_ABSENT: &str = "absent";
pub const CONTENT_WORLD: &str = "codeg";

#[derive(Debug, Clone, Default)]
pub struct SnapshotRequest {
    pub max_chars: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotViewport {
    pub width: f64,
    pub height: f64,
    pub dpr: f64,
}

impl Default for SnapshotViewport {
    fn default() -> Self {
        Self {
            width: 1280.0,
            height: 800.0,
            dpr: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageSnapshot {
    pub generation: String,
    pub url: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<SnapshotViewport>,
    pub tree: String,
    #[serde(default)]
    pub refs_count: usize,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollReport {
    pub by: i64,
    pub top: i64,
    pub max: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActOutcome {
    pub ok: bool,
    #[serde(default)]
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scrolled: Option<ScrollReport>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectAnswer {
    pub ok: bool,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub width: f64,
    #[serde(default)]
    pub height: f64,
    #[serde(default)]
    pub scrolled: bool,
    #[serde(default)]
    pub viewport: Option<SnapshotViewport>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportAnswer {
    pub url: String,
    pub viewport: SnapshotViewport,
}

pub fn epoch(incarnation: u64, nav_epoch: u64) -> String {
    format!("{incarnation}.{nav_epoch}")
}

/// A generation token ends with `.{incarnation}.{nav_epoch}` (4 dot-separated parts).
pub fn ref_is_current(generation: &str, current_epoch: &str) -> bool {
    let mut parts = generation.split('.');
    let Some(doc) = parts.next() else {
        return false;
    };
    let Some(seq) = parts.next() else {
        return false;
    };
    let Some(inc) = parts.next() else {
        return false;
    };
    let Some(nav) = parts.next() else {
        return false;
    };
    if parts.next().is_some() || doc.is_empty() || seq.is_empty() {
        return false;
    }
    format!("{inc}.{nav}") == current_epoch
}

fn snapshot_call(request: &SnapshotRequest, epoch: &str) -> String {
    let options = json!({
        "maxChars": request.max_chars,
        "epoch": epoch,
    });
    format!("JSON.stringify(globalThis.{AGENT_GLOBAL}.snapshot({options}))")
}

pub fn probe_and_snapshot(request: &SnapshotRequest, epoch: &str) -> String {
    format!(
        "typeof globalThis.{AGENT_GLOBAL} === 'undefined' ? {absent} : {call}",
        absent = Value::from(ENGINE_ABSENT),
        call = snapshot_call(request, epoch),
    )
}

pub fn install_and_snapshot(request: &SnapshotRequest, epoch: &str) -> String {
    format!(
        "(function(){{\n{AGENT_BUNDLE}\n;return {call};}})()",
        call = snapshot_call(request, epoch),
    )
}

pub fn act_call(generation: &str, target: Option<&str>, action: &Value) -> String {
    format!(
        "typeof globalThis.{AGENT_GLOBAL} === 'undefined' ? {absent} : \
         JSON.stringify(globalThis.{AGENT_GLOBAL}.act({generation}, {target}, {action}))",
        absent = Value::from(ENGINE_ABSENT),
        generation = Value::from(generation),
        target = match target {
            Some(value) => Value::from(value),
            None => Value::Null,
        },
        action = action,
    )
}

pub fn rect_call(generation: &str, target: &str) -> String {
    format!(
        "typeof globalThis.{AGENT_GLOBAL} === 'undefined' ? {absent} : \
         JSON.stringify(globalThis.{AGENT_GLOBAL}.rectOf({generation}, {target}))",
        absent = Value::from(ENGINE_ABSENT),
        generation = Value::from(generation),
        target = Value::from(target),
    )
}

pub fn viewport_call() -> &'static str {
    "JSON.stringify({ url: String(location.href || ''), viewport: { width: Number(window.innerWidth || 1280), height: Number(window.innerHeight || 800), dpr: Number(window.devicePixelRatio || 1) } })"
}

pub fn action_payload(action: &BrowserAction) -> Result<Value, BrowserHostError> {
    let kind = action.kind.trim();
    let payload = match kind {
        "click" => {
            let mut body = json!({ "kind": "click" });
            if action.double_click == Some(true) {
                body["count"] = json!(2);
            }
            if let Some(button) = action.button.as_deref() {
                body["button"] = json!(button);
            }
            body
        }
        "hover" => json!({ "kind": "hover" }),
        "type" => {
            let mut body = json!({
                "kind": "type",
                "text": action.text.clone().unwrap_or_default(),
            });
            if action.submit == Some(true) {
                body["submit"] = json!(true);
            }
            body
        }
        "press" => {
            let key = action
                .key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| BrowserHostError::new("browser_invalid", "press requires key"))?;
            json!({ "kind": "press", "key": key })
        }
        "select" => json!({
            "kind": "select",
            "values": action.values.clone().unwrap_or_default(),
        }),
        other => {
            return Err(BrowserHostError::new(
                "browser_invalid",
                format!("unknown action {other}"),
            ));
        }
    };
    Ok(payload)
}

pub fn decode_eval_result(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('"')
        && let Ok(inner) = serde_json::from_str::<String>(trimmed)
    {
        return inner;
    }
    trimmed.to_owned()
}

pub fn parse_snapshot(raw: &str) -> Result<PageSnapshot, BrowserHostError> {
    let decoded = decode_eval_result(raw);
    if decoded == ENGINE_ABSENT {
        return Err(BrowserHostError::new(
            "browser_engine_absent",
            "aria engine is not in this document yet",
        ));
    }
    serde_json::from_str(&decoded).map_err(|error| {
        BrowserHostError::new(
            "browser_read_failed",
            format!("snapshot was not a page tree: {error}"),
        )
    })
}

pub fn parse_act(raw: &str) -> Result<ActOutcome, BrowserHostError> {
    let decoded = decode_eval_result(raw);
    if decoded == ENGINE_ABSENT {
        return Err(BrowserHostError::new(
            "browser_stale_ref",
            "no snapshot has been taken on this page; take a snapshot first",
        ));
    }
    let outcome: ActOutcome = serde_json::from_str(&decoded).map_err(|error| {
        BrowserHostError::new(
            "browser_action_failed",
            format!("action result was not JSON: {error}"),
        )
    })?;
    if outcome.ok {
        return Ok(outcome);
    }
    let code = match outcome.error.as_deref() {
        Some("stale") => "browser_stale_ref",
        Some("disabled") => "browser_action_failed",
        Some("not-visible") => "browser_action_failed",
        Some("not-editable") => "browser_action_failed",
        Some("no-option") => "browser_action_failed",
        Some("unsupported") => "browser_invalid",
        _ => "browser_action_failed",
    };
    Err(BrowserHostError::new(
        code,
        outcome
            .detail
            .unwrap_or_else(|| "the page refused this action".to_owned()),
    ))
}

pub fn parse_rect(raw: &str) -> Result<RectAnswer, BrowserHostError> {
    let decoded = decode_eval_result(raw);
    if decoded == ENGINE_ABSENT {
        return Err(BrowserHostError::new(
            "browser_stale_ref",
            "no snapshot has been taken on this page; take a snapshot first",
        ));
    }
    let answer: RectAnswer = serde_json::from_str(&decoded).map_err(|error| {
        BrowserHostError::new(
            "browser_read_failed",
            format!("element rect result was not JSON: {error}"),
        )
    })?;
    if answer.ok {
        return Ok(answer);
    }
    let code = match answer.error.as_deref() {
        Some("stale") => "browser_stale_ref",
        Some("not-visible") => "browser_action_failed",
        _ => "browser_action_failed",
    };
    Err(BrowserHostError::new(
        code,
        answer
            .detail
            .unwrap_or_else(|| "cannot locate element for screenshot".to_owned()),
    ))
}

pub fn parse_viewport(raw: &str) -> Result<ViewportAnswer, BrowserHostError> {
    let decoded = decode_eval_result(raw);
    serde_json::from_str(&decoded).map_err(|error| {
        BrowserHostError::new(
            "browser_read_failed",
            format!("viewport result was not JSON: {error}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_does_not_embed_the_bundle() {
        let js = probe_and_snapshot(&SnapshotRequest::default(), "1.0");
        assert!(js.contains(AGENT_GLOBAL));
        assert!(js.contains("undefined"));
        assert!(!js.contains("Playwright"));
    }

    #[test]
    fn install_wraps_the_bundle_as_an_expression() {
        let js = install_and_snapshot(
            &SnapshotRequest {
                max_chars: Some(2000),
            },
            "1.3",
        );
        assert!(js.starts_with("(function(){"));
        assert!(js.contains(AGENT_BUNDLE));
        assert!(js.contains("maxChars"));
        assert!(js.contains("1.3"));
    }

    #[test]
    fn act_call_serializes_generation_and_ref() {
        let js = act_call("g1", Some("e2"), &json!({ "kind": "click" }));
        assert!(js.contains(r#""g1""#));
        assert!(js.contains(r#""e2""#));
        assert!(js.contains(r#""kind":"click""#));
    }

    #[test]
    fn decode_strips_webview2_string_encoding() {
        let raw = serde_json::to_string("{\"ok\":true}").unwrap();
        assert_eq!(decode_eval_result(&raw), "{\"ok\":true}");
        assert_eq!(decode_eval_result("{\"ok\":true}"), "{\"ok\":true}");
    }

    #[test]
    fn parse_snapshot_and_stale_act() {
        let snap = parse_snapshot(
            r#"{"generation":"a.1.0","url":"https://example.test/","title":"Hi","tree":"- heading \"Hi\" [ref=e1]","refsCount":1,"truncated":false}"#,
        )
        .unwrap();
        assert_eq!(snap.refs_count, 1);
        let err = parse_act(
            r#"{"ok":false,"url":"https://example.test/","error":"stale","detail":"e1 is gone"}"#,
        )
        .unwrap_err();
        assert_eq!(err.code(), "browser_stale_ref");
    }
}
