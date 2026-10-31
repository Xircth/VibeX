use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::*;

/// Person sender written on new envelopes.
pub(crate) const ENVELOPE_PERSON_SENDER: &str = "Person";
/// Compact Person alias kept so existing call sites keep compiling.
pub(crate) const ENVELOPE_USER_ACTOR: &str = ENVELOPE_PERSON_SENDER;
pub(crate) const ENVELOPE_SYSTEM_SENDER: &str = "system";

/// Flattened space-message envelope used by Host reads and writes.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct ParsedSpaceEnvelope {
    pub id: Option<String>,
    pub sender: String,
    pub to: Vec<String>,
    pub content: String,
    pub reply_to: Option<String>,
    pub published: Option<String>,
    pub summary: Option<String>,
    pub conversation_id: Option<Uuid>,
}

pub(crate) fn envelope_member_name(nickname: &str) -> String {
    let trimmed = nickname.trim().trim_start_matches('@').trim();
    if is_person_ref(trimmed) {
        ENVELOPE_PERSON_SENDER.to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn parse_space_envelope(value: &Value) -> ParsedSpaceEnvelope {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let sender = normalize_stored_sender(&parse_envelope_sender(value));
    let to = value
        .get("to")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(normalize_stored_sender)
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let content = value
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let reply_to = first_nonempty_str(value, &["reply_to", "inReplyTo"]);
    let published = value
        .get("published")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let summary = value
        .get("summary")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let conversation_id = value
        .get("conversation_id")
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw.trim()).ok());
    ParsedSpaceEnvelope {
        id,
        sender,
        to,
        content,
        reply_to,
        published,
        summary,
        conversation_id,
    }
}

pub(crate) fn parse_space_envelope_str(raw: &str) -> ParsedSpaceEnvelope {
    serde_json::from_str::<Value>(raw)
        .map(|value| parse_space_envelope(&value))
        .unwrap_or_default()
}

fn normalize_stored_sender(raw: &str) -> String {
    envelope_member_name(raw)
}

fn parse_envelope_sender(value: &Value) -> String {
    if let Some(sender) = first_nonempty_str(value, &["sender"]) {
        return decode_legacy_actor(&sender);
    }
    value
        .get("actor")
        .and_then(legacy_actor_value)
        .unwrap_or_default()
}

fn first_nonempty_str(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        let Some(raw) = value.get(*key).and_then(Value::as_str) else {
            continue;
        };
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn legacy_actor_value(value: &Value) -> Option<String> {
    let raw = match value {
        Value::String(text) => text.clone(),
        Value::Object(obj) => obj
            .get("name")
            .or_else(|| obj.get("preferredUsername"))
            .or_else(|| obj.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        _ => return None,
    };
    let decoded = decode_legacy_actor(&raw);
    let trimmed = decoded.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn decode_legacy_actor(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("agent:") {
        let rest = rest.trim();
        if !rest.is_empty() {
            return rest.to_string();
        }
    }
    trimmed.to_string()
}

/// Fields written for a new space message. Extra keys (cross-chat, i18n) merge in.
pub(crate) struct NewSpaceEnvelope<'a> {
    pub id: &'a str,
    pub sender: &'a str,
    pub to: Vec<String>,
    pub content: &'a str,
    pub reply_to: Option<&'a str>,
    pub published: &'a str,
    pub summary: Option<&'a str>,
    pub conversation_id: Option<Uuid>,
    pub extra: Map<String, Value>,
}

pub(crate) fn build_space_envelope(input: NewSpaceEnvelope<'_>) -> Value {
    let mut envelope = json!({
        "id": input.id.trim(),
        "sender": envelope_member_name(input.sender),
        "to": input
            .to
            .iter()
            .map(|name| envelope_member_name(name))
            .collect::<Vec<_>>(),
        "content": input.content,
        "published": input.published,
    });
    if let Some(reply_to) = input.reply_to.map(str::trim).filter(|id| !id.is_empty()) {
        envelope["reply_to"] = json!(reply_to);
    }
    if let Some(summary) = input
        .summary
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
    {
        envelope["summary"] = json!(summary);
    }
    if let Some(conversation_id) = input.conversation_id {
        envelope["conversation_id"] = json!(conversation_id.to_string());
    }
    if let Some(obj) = envelope.as_object_mut() {
        for (key, value) in input.extra {
            obj.insert(key, value);
        }
    }
    envelope
}

/// Overlay parsed fields onto stored JSON for Host/UI list payloads.
pub(crate) fn project_listed_envelope(
    mut envelope: Value,
    parsed: &ParsedSpaceEnvelope,
    audience: MessageAudience,
) -> Value {
    envelope["id"] = json!(parsed.id.clone().unwrap_or_default());
    envelope["sender"] = json!(parsed.sender.clone());
    envelope["to"] = json!(parsed.to.clone());
    envelope["content"] = json!(parsed.content.clone());
    if let Some(reply_to) = &parsed.reply_to {
        envelope["reply_to"] = json!(reply_to);
    }
    if let Some(published) = &parsed.published {
        envelope["published"] = json!(published);
    }
    if let Some(obj) = envelope.as_object_mut() {
        obj.remove("actor");
        obj.remove("attributedTo");
        obj.remove("inReplyTo");
        obj.remove("@context");
        obj.remove("type");
    }
    if audience == MessageAudience::Agent {
        if let Some(to) = envelope.get_mut("to").and_then(Value::as_array_mut) {
            to.retain(|item| item.as_str().is_none_or(|value| !is_person_ref(value)));
        }
        if is_person_ref(&parsed.sender) {
            envelope["sender"] = json!("user");
        }
    }
    envelope
}

pub(crate) fn envelope_sender_is_conversation(
    parsed: &ParsedSpaceEnvelope,
    conversation_id: Uuid,
    nickname: Option<&str>,
) -> bool {
    if parsed.conversation_id == Some(conversation_id) {
        return true;
    }
    nickname
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .is_some_and(|name| parsed.sender == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reads_flat_envelopes() {
        let flat = json!({
            "id": "msg-1",
            "sender": "Person",
            "to": ["小A"],
            "content": "hello",
            "reply_to": "parent",
            "published": "2026-01-01T00:00:00Z",
            "conversation_id": "11111111-1111-1111-1111-111111111111",
        });
        let parsed = parse_space_envelope(&flat);
        assert_eq!(parsed.sender, "Person");
        assert_eq!(parsed.to, vec!["小A".to_string()]);
        assert_eq!(parsed.reply_to.as_deref(), Some("parent"));
        assert_eq!(
            parsed.conversation_id,
            Some(Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap())
        );
        assert_eq!(parsed.id.as_deref(), Some("msg-1"));
    }

    #[test]
    fn parse_falls_back_to_legacy_activitystreams_actor_and_in_reply_to() {
        let legacy = json!({
            "actor": "User",
            "to": ["小A"],
            "content": "你好",
            "inReplyTo": "msg-0",
        });
        let parsed = parse_space_envelope(&legacy);
        assert_eq!(parsed.sender, "Person");
        assert_eq!(parsed.to, vec!["小A".to_string()]);
        assert_eq!(parsed.content, "你好");
        assert_eq!(parsed.reply_to.as_deref(), Some("msg-0"));
    }

    #[test]
    fn parse_falls_back_to_legacy_agent_prefixed_actor() {
        let legacy = json!({
            "sender": "",
            "actor": "agent:小A",
            "to": ["User"],
            "content": "ok",
            "inReplyTo": "parent",
        });
        let parsed = parse_space_envelope(&legacy);
        assert_eq!(parsed.sender, "小A");
        assert_eq!(parsed.reply_to.as_deref(), Some("parent"));
    }

    #[test]
    fn parse_prefers_flat_sender_and_reply_to_over_legacy_fields() {
        let mixed = json!({
            "sender": "小A",
            "actor": "User",
            "to": ["小B"],
            "content": "hi",
            "reply_to": "new",
            "inReplyTo": "old",
        });
        let parsed = parse_space_envelope(&mixed);
        assert_eq!(parsed.sender, "小A");
        assert_eq!(parsed.reply_to.as_deref(), Some("new"));
    }

    #[test]
    fn parse_reads_legacy_activitystreams_wrapper_without_using_attributed_to() {
        let legacy = json!({
            "@context": "https://www.w3.org/ns/activitystreams",
            "type": "Note",
            "id": "msg-1",
            "actor": "Person",
            "attributedTo": "11111111-1111-1111-1111-111111111111",
            "to": ["小A"],
            "inReplyTo": "parent",
            "content": "hello",
        });
        let parsed = parse_space_envelope(&legacy);
        assert_eq!(parsed.sender, "Person");
        assert_eq!(parsed.to, vec!["小A".to_string()]);
        assert_eq!(parsed.reply_to.as_deref(), Some("parent"));
        assert_eq!(parsed.conversation_id, None);
    }

    #[test]
    fn build_writes_flat_json_without_activitystreams_wrapper() {
        let envelope = build_space_envelope(NewSpaceEnvelope {
            id: "msg-1",
            sender: "User",
            to: vec!["User".to_string(), "小A".to_string()],
            content: "hi",
            reply_to: Some("parent"),
            published: "2026-01-01T00:00:00Z",
            summary: Some("hi"),
            conversation_id: None,
            extra: Map::new(),
        });
        assert!(envelope.get("@context").is_none());
        assert!(envelope.get("type").is_none());
        assert!(envelope.get("actor").is_none());
        assert!(envelope.get("attributedTo").is_none());
        assert!(envelope.get("inReplyTo").is_none());
        assert_eq!(envelope["id"], json!("msg-1"));
        assert_eq!(envelope["sender"], json!("Person"));
        assert_eq!(envelope["to"], json!(["Person", "小A"]));
        assert_eq!(envelope["reply_to"], json!("parent"));
        assert_eq!(envelope["content"], json!("hi"));
    }
}
