//! Peel Agent operational notices out of conversation transcript.
//!
//! ACP currently has no stable `sessionUpdate: "notice"` in the v1 SDK, so
//! adapters such as Codex-ACP forward Codex `warning` / `configWarning` /
//! context-compaction notifications as complete `agent_message_chunk`s. Those
//! are not assistant replies. This module recognizes that adapter wire format
//! and the ACP session-notice RFD shape, so the host can persist them as
//! [`ConversationSessionNotice`] instead of message text.

use agent_client_protocol::schema::v1::{ContentBlock, ContentChunk};
use serde_json::{Value, json};

use crate::conversation::ConversationSessionNotice;

pub const AGENT_SESSION_NOTICE_KIND: &str = "agent_session_notice";
pub const SESSION_RECONNECT_PROGRESS_KIND: &str = "session_reconnect_progress";
pub const SESSION_CONNECT_ERROR_KIND: &str = "session_connect_error";

const CODEX_WARNING_PREFIX: &str = "Warning: ";
const CODEX_CONFIG_WARNING_PREFIX: &str = "Config warning: ";
const CODEX_CONTEXT_COMPACTED: &str = "*Context compacted to fit the model's context window.*";

pub fn from_agent_message_chunk(chunk: &ContentChunk) -> Option<ConversationSessionNotice> {
    if chunk.message_id.is_some() {
        return None;
    }
    let ContentBlock::Text(text) = &chunk.content else {
        return None;
    };
    from_adapter_message(&text.text)
}

pub fn from_session_update_value(update: &Value) -> Option<ConversationSessionNotice> {
    let session_update = update
        .get("sessionUpdate")
        .or_else(|| update.get("session_update"))
        .and_then(Value::as_str)?;
    if session_update != "notice" {
        return None;
    }
    let title = update
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let description = update
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    Some(ConversationSessionNotice {
        title,
        message: description,
        severity: notice_severity(update.get("severity").and_then(Value::as_str)),
        ..Default::default()
    })
}

pub fn from_session_notification_params(params: &Value) -> Option<ConversationSessionNotice> {
    params
        .get("update")
        .and_then(from_session_update_value)
        .or_else(|| from_session_update_value(params))
}

pub fn diagnostic_payload(notice: &ConversationSessionNotice) -> Value {
    json!({
        "kind": AGENT_SESSION_NOTICE_KIND,
        "title": notice.title,
        "message": notice.message,
        "severity": notice.severity,
    })
}

pub fn notice_from_diagnostic_payload(payload: &Value) -> Option<ConversationSessionNotice> {
    if payload.get("kind").and_then(Value::as_str) != Some(AGENT_SESSION_NOTICE_KIND) {
        return None;
    }
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    Some(ConversationSessionNotice {
        title,
        message,
        severity: notice_severity(payload.get("severity").and_then(Value::as_str)),
        ..Default::default()
    })
}

/// The markdown prelude pi-acp reports on `session/new` as `_meta.piAcp.startupInfo`.
/// Matching the later `agent_message_chunk` against this string is how the host
/// drops the banner without guessing from its contents.
pub fn pi_startup_banner_from_meta(
    meta: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    let meta = meta?;
    let pi_acp = meta.get("piAcp").or_else(|| meta.get("pi_acp"))?;
    pi_acp
        .get("startupInfo")
        .or_else(|| pi_acp.get("startup_info"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|banner| !banner.is_empty())
        .map(ToOwned::to_owned)
}

pub fn matches_pi_startup_banner(pending: Option<&str>, text: &str) -> bool {
    pending.is_some_and(|banner| banner == text.trim())
}

fn from_adapter_message(text: &str) -> Option<ConversationSessionNotice> {
    let text = text.trim_end_matches(['\r', '\n']);
    if let Some(body) = text.strip_prefix(CODEX_WARNING_PREFIX) {
        return adapter_notice("Warning", body, "warning");
    }
    if let Some(body) = text.strip_prefix(CODEX_CONFIG_WARNING_PREFIX) {
        return adapter_notice("Config warning", body, "warning");
    }
    if text == CODEX_CONTEXT_COMPACTED {
        return Some(ConversationSessionNotice {
            title: "Context compacted".into(),
            message: Some("Context compacted to fit the model's context window.".into()),
            severity: "info".into(),
            ..Default::default()
        });
    }
    from_pi_acp_lifecycle(text.trim())
}

/// pi-acp puts lifecycle announcements on the same `agent_message_chunk`
/// channel as assistant prose. Match the whole trimmed chunk, never a
/// substring, so slash-command replies and real answers stay in the transcript.
fn from_pi_acp_lifecycle(text: &str) -> Option<ConversationSessionNotice> {
    if text == "Retry finished, resuming."
        || text == "Context nearing limit, running automatic compaction..."
        || text.starts_with("Automatic compaction finished")
        || text == "Cleared queued prompts."
    {
        return Some(ConversationSessionNotice {
            title: text.to_string(),
            message: None,
            severity: "info".into(),
            ..Default::default()
        });
    }
    if let Some(rest) = text.strip_prefix("Retrying")
        && (rest.is_empty() || rest.starts_with(" (") || rest == "...")
    {
        return Some(ConversationSessionNotice {
            title: "Retrying model call".into(),
            message: Some(text.to_string()),
            severity: "info".into(),
            ..Default::default()
        });
    }
    if text.starts_with("Queued message (position ") || text.starts_with("Starting queued message.")
    {
        return Some(ConversationSessionNotice {
            title: text.to_string(),
            message: None,
            severity: "info".into(),
            ..Default::default()
        });
    }
    None
}

fn adapter_notice(
    fallback_title: &str,
    body: &str,
    severity: &str,
) -> Option<ConversationSessionNotice> {
    let body = body.trim();
    if body.is_empty() {
        return None;
    }
    let title = title_from_body(body).unwrap_or(fallback_title);
    Some(ConversationSessionNotice {
        title: title.to_string(),
        message: Some(body.to_string()),
        severity: severity.to_string(),
        ..Default::default()
    })
}

fn title_from_body(text: &str) -> Option<&str> {
    let first_line = text
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())?;
    let bytes = first_line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if matches!(bytes[index], b'.' | b'!' | b'?') {
            let next_is_boundary = bytes
                .get(index + 1)
                .is_none_or(|byte| byte.is_ascii_whitespace());
            if next_is_boundary {
                let sentence = first_line[..=index].trim();
                if sentence.len() >= 12 {
                    return Some(sentence);
                }
            }
        }
        index += 1;
    }
    Some(first_line)
}

fn notice_severity(severity: Option<&str>) -> String {
    match severity.map(str::to_ascii_lowercase).as_deref() {
        Some("error" | "critical" | "danger") => "error",
        Some("warning" | "warn") => "warning",
        _ => "info",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::v1::{ContentBlock, ContentChunk, MessageId};
    use serde_json::json;

    use super::{
        from_agent_message_chunk, from_session_notification_params, from_session_update_value,
        matches_pi_startup_banner, notice_from_diagnostic_payload, pi_startup_banner_from_meta,
    };

    fn text_chunk(text: &str, message_id: Option<&str>) -> ContentChunk {
        let mut chunk = ContentChunk::new(ContentBlock::from(text));
        if let Some(id) = message_id {
            chunk = chunk.message_id(MessageId::new(id));
        }
        chunk
    }

    #[test]
    fn peels_codex_adapter_warning_without_message_id() {
        let chunk = text_chunk(
            "Warning: Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.\n\n",
            None,
        );
        let notice = from_agent_message_chunk(&chunk).expect("warning notice");
        assert_eq!(
            notice.title,
            "Skill descriptions were shortened to fit the skills context budget."
        );
        assert_eq!(notice.severity, "warning");
        assert!(
            notice
                .message
                .as_deref()
                .is_some_and(|message| message.contains("Disable unused skills"))
        );
    }

    #[test]
    fn peels_codex_config_warning() {
        let chunk = text_chunk(
            "Config warning: Unknown key `skills.listing_budget_fraction`\n\nIgnored extra settings.\n\n",
            None,
        );
        let notice = from_agent_message_chunk(&chunk).expect("config warning");
        assert_eq!(notice.title, "Unknown key `skills.listing_budget_fraction`");
        assert_eq!(notice.severity, "warning");
        assert!(
            notice
                .message
                .as_deref()
                .is_some_and(|message| message.contains("Ignored extra settings"))
        );
    }

    #[test]
    fn peels_context_compaction_notice() {
        let chunk = text_chunk(
            "*Context compacted to fit the model's context window.*\n\n",
            None,
        );
        let notice = from_agent_message_chunk(&chunk).expect("compaction notice");
        assert_eq!(notice.title, "Context compacted");
        assert_eq!(notice.severity, "info");
    }

    #[test]
    fn leaves_streamed_replies_with_message_id_in_the_transcript() {
        let chunk = text_chunk(
            "Warning: this change is destructive. I will ask before deleting files.\n\n",
            Some("item_1"),
        );
        assert!(from_agent_message_chunk(&chunk).is_none());
    }

    #[test]
    fn leaves_ordinary_assistant_text_in_the_transcript() {
        let chunk = text_chunk("I'll inspect the failing test first.", None);
        assert!(from_agent_message_chunk(&chunk).is_none());
    }

    #[test]
    fn reads_pi_acp_startup_banner_from_session_meta() {
        let banner = "# pi 0.0.33\n\n- /tmp/demo/.pi/extensions/hook.js";
        let meta = json!({
            "piAcp": { "startupInfo": format!("{banner}\n") }
        })
        .as_object()
        .cloned()
        .expect("object");
        assert_eq!(
            pi_startup_banner_from_meta(Some(&meta)).as_deref(),
            Some(banner)
        );
        assert!(matches_pi_startup_banner(Some(banner), banner));
        assert!(!matches_pi_startup_banner(
            Some(banner),
            "I'll inspect the failing test first."
        ));
        assert!(pi_startup_banner_from_meta(None).is_none());
    }

    #[test]
    fn peels_pi_acp_lifecycle_announcements_without_eating_prose() {
        let retry = text_chunk("Retrying (attempt 2/5, waiting 3s)...", None);
        let notice = from_agent_message_chunk(&retry).expect("retry notice");
        assert_eq!(notice.title, "Retrying model call");
        assert_eq!(notice.severity, "info");

        let queued = text_chunk("Queued message (position 2).", None);
        assert_eq!(
            from_agent_message_chunk(&queued)
                .expect("queue notice")
                .title,
            "Queued message (position 2)."
        );

        let prose = text_chunk("Retrying this approach with a smaller change.", None);
        assert!(from_agent_message_chunk(&prose).is_none());
    }

    #[test]
    fn recognizes_acp_session_notice_updates() {
        let notice = from_session_update_value(&json!({
            "sessionUpdate": "notice",
            "severity": "warning",
            "title": "MCP server unavailable",
            "description": "Continuing without it."
        }))
        .expect("rfd notice");
        assert_eq!(notice.title, "MCP server unavailable");
        assert_eq!(notice.message.as_deref(), Some("Continuing without it."));
        assert_eq!(notice.severity, "warning");
    }

    #[test]
    fn recognizes_notice_nested_in_session_notification_params() {
        let notice = from_session_notification_params(&json!({
            "sessionId": "sess_1",
            "update": {
                "sessionUpdate": "notice",
                "severity": "error",
                "title": "Auth expired"
            }
        }))
        .expect("nested notice");
        assert_eq!(notice.title, "Auth expired");
        assert_eq!(notice.severity, "error");
        assert_eq!(notice.message, None);
    }

    #[test]
    fn diagnostic_payload_roundtrips() {
        let original = from_session_update_value(&json!({
            "sessionUpdate": "notice",
            "severity": "warn",
            "title": "Skills truncated",
            "description": "Disable unused plugins."
        }))
        .expect("notice");
        let restored = notice_from_diagnostic_payload(&super::diagnostic_payload(&original))
            .expect("roundtrip");
        assert_eq!(restored, original);
    }
}
