use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::*;

/// Person sender written on new envelopes. `User` and legacy URIs still parse.
pub(crate) const ENVELOPE_PERSON_SENDER: &str = "Person";
/// Compact Person actor alias kept so existing call sites keep compiling.
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

pub(crate) fn bare_envelope_id(raw: &str) -> &str {
    raw.trim()
        .strip_prefix("vibex://space-message/")
        .unwrap_or(raw.trim())
}

pub(crate) fn envelope_member_name(nickname: &str) -> String {
    let trimmed = nickname.trim();
    if is_person_ref(trimmed) {
        ENVELOPE_PERSON_SENDER.to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn user_actor(space_id: &str) -> String {
    format!("vibex://space/{space_id}/user")
}

pub(crate) fn is_stored_user_actor(space_id: &str, actor: &str) -> bool {
    actor == user_actor(space_id) || is_person_ref(actor)
}

pub(crate) fn parse_space_envelope(value: &Value) -> ParsedSpaceEnvelope {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .map(bare_envelope_id)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let sender_raw = value
        .get("sender")
        .and_then(Value::as_str)
        .or_else(|| value.get("actor").and_then(Value::as_str))
        .unwrap_or_default();
    let sender = normalize_stored_sender(sender_raw);
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
    let reply_to = value
        .get("reply_to")
        .and_then(Value::as_str)
        .or_else(|| value.get("inReplyTo").and_then(Value::as_str))
        .or_else(|| value.get("in_reply_to").and_then(Value::as_str))
        .map(bare_envelope_id)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
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
        .and_then(|raw| Uuid::parse_str(raw.trim()).ok())
        .or_else(|| {
            value
                .get("attributedTo")
                .and_then(Value::as_str)
                .and_then(conversation_id_from_uri)
        });
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

pub(crate) fn conversation_id_from_uri(raw: &str) -> Option<Uuid> {
    let trimmed = raw.trim();
    let id = trimmed
        .strip_prefix("vibex://conversation/")
        .unwrap_or_else(|| trimmed.rsplit('/').next().unwrap_or(trimmed));
    Uuid::parse_str(id).ok()
}

fn normalize_stored_sender(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if is_person_ref(trimmed) {
        return ENVELOPE_PERSON_SENDER.to_string();
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.ends_with("/system") || lower == ENVELOPE_SYSTEM_SENDER {
        return ENVELOPE_SYSTEM_SENDER.to_string();
    }
    actor_display_name(trimmed)
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
        "id": bare_envelope_id(input.id),
        "sender": envelope_member_name(input.sender),
        "to": input
            .to
            .iter()
            .map(|name| envelope_member_name(name))
            .collect::<Vec<_>>(),
        "content": input.content,
        "published": input.published,
    });
    if let Some(reply_to) = input
        .reply_to
        .map(bare_envelope_id)
        .filter(|id| !id.is_empty())
    {
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

/// Overlay parsed fields onto stored JSON so Host/UI keep `actor` / `inReplyTo`.
pub(crate) fn project_listed_envelope(
    mut envelope: Value,
    parsed: &ParsedSpaceEnvelope,
    audience: MessageAudience,
    space_id: &str,
) -> Value {
    envelope["id"] = json!(parsed.id.clone().unwrap_or_default());
    envelope["sender"] = json!(parsed.sender.clone());
    envelope["actor"] = json!(parsed.sender.clone());
    envelope["to"] = json!(parsed.to.clone());
    envelope["content"] = json!(parsed.content.clone());
    if let Some(reply_to) = &parsed.reply_to {
        envelope["reply_to"] = json!(reply_to);
        envelope["inReplyTo"] = json!(reply_to);
    }
    if let Some(published) = &parsed.published {
        envelope["published"] = json!(published);
    }
    if audience == MessageAudience::Agent {
        let user_uri = user_actor(space_id);
        if let Some(to) = envelope.get_mut("to").and_then(Value::as_array_mut) {
            to.retain(|item| {
                item.as_str()
                    .is_none_or(|value| value != user_uri.as_str() && !is_person_ref(value))
            });
        }
        if is_person_ref(&parsed.sender) {
            envelope["sender"] = json!("user");
            envelope["actor"] = json!("user");
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
    fn parse_reads_flat_and_activitystreams_envelopes() {
        let flat = json!({
            "id": "msg-1",
            "sender": "Person",
            "to": ["小A"],
            "content": "hello",
            "reply_to": "parent",
            "published": "2026-01-01T00:00:00Z",
        });
        let parsed = parse_space_envelope(&flat);
        assert_eq!(parsed.sender, "Person");
        assert_eq!(parsed.to, vec!["小A".to_string()]);
        assert_eq!(parsed.reply_to.as_deref(), Some("parent"));

        let legacy = json!({
            "@context": "https://www.w3.org/ns/activitystreams",
            "type": "Note",
            "id": "vibex://space-message/msg-1",
            "actor": "vibex://space/s/user",
            "attributedTo": "vibex://conversation/11111111-1111-1111-1111-111111111111",
            "to": ["vibex://space/s/member/小A"],
            "inReplyTo": "vibex://space-message/parent",
            "content": "hello",
            "published": "2026-01-01T00:00:00Z",
        });
        let parsed = parse_space_envelope(&legacy);
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
    fn build_writes_flat_json_without_activitystreams_wrapper() {
        let envelope = build_space_envelope(NewSpaceEnvelope {
            id: "vibex://space-message/msg-1",
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
