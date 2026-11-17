//! Canonical `EventEnvelope` normalizers for Feishu, Jira (Webhook + JQL watermark delta),
//! GitHub, and Custom SDK / MCP events.

use std::collections::{BTreeMap, BTreeSet};

use api_types::pulse::{
    EventActor, EventEnvelope, EventSourceKind, EventSourceMeta, EventTrace, EventTrustLevel,
    ReplyChannelAddress,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;

use crate::guard::{DEFAULT_MAX_HOP_COUNT, GuardError, derive_child_trace};

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SourceNormalizeError {
    #[error("missing required field `{0}` in source payload")]
    MissingField(&'static str),
    #[error("unsupported source event payload: {0}")]
    UnsupportedEvent(String),
    #[error(transparent)]
    Guard(#[from] GuardError),
}

// =============================================================================
// 1. Feishu Source Normalizer
// =============================================================================

#[derive(Debug, Clone)]
pub struct FeishuSourceNormalizer {
    pub instance_id: String,
    pub bot_open_id: Option<String>,
}

impl FeishuSourceNormalizer {
    pub fn new(instance_id: impl Into<String>, bot_open_id: Option<String>) -> Self {
        Self {
            instance_id: instance_id.into(),
            bot_open_id,
        }
    }

    pub fn normalize(
        &self,
        raw: &Value,
        now: DateTime<Utc>,
    ) -> Result<EventEnvelope, SourceNormalizeError> {
        let header_event_type = raw
            .pointer("/header/event_type")
            .or_else(|| raw.pointer("/event_type"))
            .or_else(|| raw.pointer("/type"))
            .and_then(Value::as_str)
            .unwrap_or("");

        if header_event_type == "card.action.trigger"
            || (raw.get("action").is_some()
                && (raw.get("open_message_id").is_some()
                    || raw.pointer("/event/action").is_some()
                    || raw.pointer("/context/open_message_id").is_some()))
        {
            return self.normalize_card_action(raw, now);
        }

        if header_event_type == "im.message.reaction.created_v1" {
            return self.normalize_reaction(raw, now);
        }

        if header_event_type == "im.message.receive_v1" || raw.pointer("/event/message").is_some() {
            return self.normalize_im_message(raw, now);
        }

        Err(SourceNormalizeError::UnsupportedEvent(
            if header_event_type.is_empty() {
                "unrecognized Feishu payload".to_string()
            } else {
                header_event_type.to_string()
            },
        ))
    }

    fn normalize_im_message(
        &self,
        raw: &Value,
        now: DateTime<Utc>,
    ) -> Result<EventEnvelope, SourceNormalizeError> {
        let event_obj = raw.get("event").unwrap_or(raw);
        let message = event_obj
            .get("message")
            .ok_or(SourceNormalizeError::MissingField("event.message"))?;

        let message_id = message
            .get("message_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(SourceNormalizeError::MissingField(
                "event.message.message_id",
            ))?;

        let chat_id = message
            .get("chat_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(SourceNormalizeError::MissingField("event.message.chat_id"))?;

        let chat_type = message
            .get("chat_type")
            .and_then(Value::as_str)
            .unwrap_or("p2p");
        let message_type = message
            .get("message_type")
            .and_then(Value::as_str)
            .unwrap_or("text");

        let sender = event_obj.get("sender").unwrap_or(&Value::Null);
        let sender_type = sender
            .get("sender_type")
            .and_then(Value::as_str)
            .unwrap_or("user");
        let sender_id = sender
            .pointer("/sender_id/open_id")
            .or_else(|| sender.pointer("/sender_id/user_id"))
            .or_else(|| sender.pointer("/sender_id/union_id"))
            .or_else(|| sender.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");

        let is_self = self
            .bot_open_id
            .as_deref()
            .is_some_and(|bot_id| bot_id == sender_id);
        let is_bot = is_self || sender_type == "app" || sender_id.starts_with("cli_");

        let mentions_arr = message
            .get("mentions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut mentioned_ids = Vec::new();
        let mut mentioned_names = Vec::new();
        for mention in &mentions_arr {
            if let Some(open_id) = mention
                .pointer("/id/open_id")
                .or_else(|| mention.get("open_id"))
                .or_else(|| mention.get("id"))
                .and_then(Value::as_str)
            {
                mentioned_ids.push(open_id.to_string());
            }
            if let Some(name) = mention.get("name").and_then(Value::as_str) {
                mentioned_names.push(name.to_string());
            }
        }

        let bot_mentioned = match self.bot_open_id.as_deref() {
            Some(bot_id) => mentioned_ids.iter().any(|id| id == bot_id),
            None => !mentions_arr.is_empty(),
        };

        let event_type = if bot_mentioned {
            "feishu.im.mention"
        } else {
            "feishu.im.message"
        };

        let raw_content = message.get("content").and_then(Value::as_str).unwrap_or("");
        let parsed_content: Value =
            serde_json::from_str(raw_content).unwrap_or_else(|_| json!({ "raw": raw_content }));
        let extracted_text =
            extract_feishu_message_text(message_type, raw_content, &parsed_content);
        let text = extracted_text.as_str();

        let topic_id = message
            .get("thread_id")
            .or_else(|| message.get("root_id"))
            .or_else(|| message.get("parent_id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let thread_key = match &topic_id {
            Some(tid) => Some(format!("feishu:topic:{tid}")),
            None => Some(format!("feishu:chat:{chat_id}")),
        };

        let delivery_id = raw
            .pointer("/header/event_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(message_id)
            .to_string();

        let event_id = Uuid::new_v4().to_string();
        Ok(EventEnvelope {
            event_id: event_id.clone(),
            delivery_id,
            source: EventSourceMeta {
                kind: EventSourceKind::Feishu,
                instance_id: self.instance_id.clone(),
                trust_level: EventTrustLevel::VerifiedExternal,
            },
            event_type: event_type.to_string(),
            occurred_at: now.to_rfc3339(),
            actor: EventActor {
                id: sender_id.to_string(),
                display_name: sender
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                roles: Vec::new(),
                is_bot,
                is_self,
            },
            thread_key,
            correlations: Vec::new(),
            reply_channels: vec![ReplyChannelAddress {
                source_kind: EventSourceKind::Feishu,
                instance_id: self.instance_id.clone(),
                channel_id: chat_id.to_string(),
                message_id: Some(message_id.to_string()),
                thread_id: topic_id,
            }],
            trace: EventTrace {
                root_event_id: event_id,
                parent_run_id: None,
                hop_count: 0,
            },
            payload: json!({
                "messageId": message_id,
                "chatId": chat_id,
                "chatType": chat_type,
                "messageType": message_type,
                "text": text,
                "content": parsed_content,
                "mentionedIds": mentioned_ids,
                "mentionedNames": mentioned_names,
                "botMentioned": bot_mentioned,
            }),
        })
    }

    fn normalize_card_action(
        &self,
        raw: &Value,
        now: DateTime<Utc>,
    ) -> Result<EventEnvelope, SourceNormalizeError> {
        let event_obj = raw.get("event").unwrap_or(raw);
        let action = event_obj
            .get("action")
            .ok_or(SourceNormalizeError::MissingField("action"))?;

        let operator_id = event_obj
            .pointer("/operator/open_id")
            .or_else(|| event_obj.pointer("/operator/user_id"))
            .or_else(|| raw.get("open_id"))
            .or_else(|| raw.get("user_id"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");

        let message_id = event_obj
            .pointer("/context/open_message_id")
            .or_else(|| raw.get("open_message_id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(SourceNormalizeError::MissingField("open_message_id"))?;

        let chat_id = event_obj
            .pointer("/context/open_chat_id")
            .or_else(|| raw.get("open_chat_id"))
            .and_then(Value::as_str)
            .unwrap_or("direct");

        let delivery_id = raw
            .pointer("/header/event_id")
            .or_else(|| raw.get("uuid"))
            .or_else(|| event_obj.get("token"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!("card:{message_id}:{operator_id}:{}", now.timestamp_millis())
            });

        let is_self = self
            .bot_open_id
            .as_deref()
            .is_some_and(|bot_id| bot_id == operator_id);

        let event_id = Uuid::new_v4().to_string();
        Ok(EventEnvelope {
            event_id: event_id.clone(),
            delivery_id,
            source: EventSourceMeta {
                kind: EventSourceKind::Feishu,
                instance_id: self.instance_id.clone(),
                trust_level: EventTrustLevel::VerifiedExternal,
            },
            event_type: "feishu.card.action".to_string(),
            occurred_at: now.to_rfc3339(),
            actor: EventActor {
                id: operator_id.to_string(),
                display_name: None,
                roles: Vec::new(),
                is_bot: is_self,
                is_self,
            },
            thread_key: Some(format!("feishu:topic:{message_id}")),
            correlations: Vec::new(),
            reply_channels: vec![ReplyChannelAddress {
                source_kind: EventSourceKind::Feishu,
                instance_id: self.instance_id.clone(),
                channel_id: chat_id.to_string(),
                message_id: Some(message_id.to_string()),
                thread_id: Some(message_id.to_string()),
            }],
            trace: EventTrace {
                root_event_id: event_id,
                parent_run_id: None,
                hop_count: 0,
            },
            payload: json!({
                "messageId": message_id,
                "chatId": chat_id,
                "tag": action.get("tag").cloned().unwrap_or(Value::Null),
                "value": action.get("value").cloned().unwrap_or(Value::Null),
                "option": action.get("option").cloned().unwrap_or(Value::Null),
            }),
        })
    }

    fn normalize_reaction(
        &self,
        raw: &Value,
        now: DateTime<Utc>,
    ) -> Result<EventEnvelope, SourceNormalizeError> {
        let event_obj = raw.get("event").unwrap_or(raw);
        let message_id = event_obj
            .get("message_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(SourceNormalizeError::MissingField("event.message_id"))?;
        let emoji_type = event_obj
            .pointer("/reaction_type/emoji_type")
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN");
        let operator_type = event_obj
            .get("operator_type")
            .and_then(Value::as_str)
            .unwrap_or("user");
        let actor_id = event_obj
            .pointer("/user_id/open_id")
            .or_else(|| event_obj.get("app_id"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");

        let is_self = self
            .bot_open_id
            .as_deref()
            .is_some_and(|bot_id| bot_id == actor_id);
        let is_bot = is_self || operator_type == "app";

        let delivery_id = raw
            .pointer("/header/event_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("reaction:{message_id}:{emoji_type}:{actor_id}"));

        let event_id = Uuid::new_v4().to_string();
        Ok(EventEnvelope {
            event_id: event_id.clone(),
            delivery_id,
            source: EventSourceMeta {
                kind: EventSourceKind::Feishu,
                instance_id: self.instance_id.clone(),
                trust_level: EventTrustLevel::VerifiedExternal,
            },
            event_type: "feishu.im.reaction_added".to_string(),
            occurred_at: now.to_rfc3339(),
            actor: EventActor {
                id: actor_id.to_string(),
                display_name: None,
                roles: Vec::new(),
                is_bot,
                is_self,
            },
            thread_key: Some(format!("feishu:topic:{message_id}")),
            correlations: Vec::new(),
            reply_channels: vec![ReplyChannelAddress {
                source_kind: EventSourceKind::Feishu,
                instance_id: self.instance_id.clone(),
                channel_id: message_id.to_string(),
                message_id: Some(message_id.to_string()),
                thread_id: Some(message_id.to_string()),
            }],
            trace: EventTrace {
                root_event_id: event_id,
                parent_run_id: None,
                hop_count: 0,
            },
            payload: json!({
                "messageId": message_id,
                "emojiType": emoji_type,
            }),
        })
    }
}

fn extract_feishu_message_text(
    message_type: &str,
    raw_content: &str,
    parsed_content: &Value,
) -> String {
    if let Some(text) = parsed_content.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    if message_type == "post" {
        let post_root = parsed_content
            .get("content")
            .is_some()
            .then_some(parsed_content)
            .or_else(|| {
                parsed_content
                    .as_object()?
                    .values()
                    .find(|v| v.get("content").is_some())
            });
        if let Some(post) = post_root {
            let mut parts = Vec::new();
            if let Some(title) = post
                .get("title")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            {
                parts.push(title.trim().to_string());
            }
            if let Some(lines) = post.get("content").and_then(Value::as_array) {
                for line in lines {
                    if let Some(nodes) = line.as_array() {
                        let line_str: String = nodes
                            .iter()
                            .filter_map(|node| {
                                node.get("text")
                                    .or_else(|| node.get("user_name"))
                                    .and_then(Value::as_str)
                            })
                            .collect::<Vec<_>>()
                            .join("");
                        if !line_str.trim().is_empty() {
                            parts.push(line_str);
                        }
                    }
                }
            }
            if !parts.is_empty() {
                return parts.join("\n");
            }
        }
    }
    raw_content.to_string()
}

// =============================================================================
// 2. Jira Source Normalizer (Webhook + JQL Watermark Delta)
// =============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssueDigest {
    pub updated: String,
    pub status: Option<String>,
    pub assignee_id: Option<String>,
    pub priority: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraPollWatermark {
    pub cursor_updated_at: Option<String>,
    #[serde(default)]
    pub digests: BTreeMap<String, JiraIssueDigest>,
}

#[derive(Debug, Clone)]
pub struct JiraSourceNormalizer {
    pub instance_id: String,
    pub self_account_id: Option<String>,
}

impl JiraSourceNormalizer {
    pub fn new(instance_id: impl Into<String>, self_account_id: Option<String>) -> Self {
        Self {
            instance_id: instance_id.into(),
            self_account_id,
        }
    }

    pub fn normalize_webhook(
        &self,
        raw: &Value,
        delivery_id_override: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<EventEnvelope, SourceNormalizeError> {
        let webhook_event = raw
            .get("webhookEvent")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(SourceNormalizeError::MissingField("webhookEvent"))?;

        let issue = raw
            .get("issue")
            .ok_or(SourceNormalizeError::MissingField("issue"))?;
        let issue_key = issue
            .get("key")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(SourceNormalizeError::MissingField("issue.key"))?;

        let changelog_items = raw
            .pointer("/changelog/items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let event_type = match webhook_event {
            "jira:issue_created" => "jira.issue.created".to_string(),
            "comment_created" => "jira.issue.commented".to_string(),
            "comment_updated" => "jira.issue.comment_updated".to_string(),
            "jira:issue_updated" => classify_jira_changelog(&changelog_items),
            other => format!(
                "jira.{}",
                other.trim_start_matches("jira:").replace([':', '_'], ".")
            ),
        };

        let user_obj = raw
            .get("user")
            .or_else(|| raw.pointer("/comment/author"))
            .unwrap_or(&Value::Null);
        let actor_id = user_obj
            .get("accountId")
            .or_else(|| user_obj.get("name"))
            .or_else(|| user_obj.get("key"))
            .and_then(Value::as_str)
            .unwrap_or("jira:unknown");
        let display_name = user_obj
            .get("displayName")
            .and_then(Value::as_str)
            .map(str::to_string);

        let is_self = self
            .self_account_id
            .as_deref()
            .is_some_and(|self_id| self_id == actor_id);

        let comment_id = raw
            .pointer("/comment/id")
            .and_then(Value::as_str)
            .map(str::to_string);

        let ts_token = raw
            .get("timestamp")
            .and_then(Value::as_i64)
            .map(|n| n.to_string())
            .unwrap_or_else(|| now.timestamp_millis().to_string());

        let delivery_id = delivery_id_override
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("jira:{issue_key}:{webhook_event}:{ts_token}"));

        let fields = issue.get("fields").unwrap_or(&Value::Null);
        let event_id = Uuid::new_v4().to_string();

        Ok(EventEnvelope {
            event_id: event_id.clone(),
            delivery_id,
            source: EventSourceMeta {
                kind: EventSourceKind::Jira,
                instance_id: self.instance_id.clone(),
                trust_level: EventTrustLevel::VerifiedExternal,
            },
            event_type,
            occurred_at: now.to_rfc3339(),
            actor: EventActor {
                id: actor_id.to_string(),
                display_name,
                roles: Vec::new(),
                is_bot: is_self,
                is_self,
            },
            thread_key: Some(format!("jira:{issue_key}")),
            correlations: Vec::new(),
            reply_channels: vec![ReplyChannelAddress {
                source_kind: EventSourceKind::Jira,
                instance_id: self.instance_id.clone(),
                channel_id: issue_key.to_string(),
                message_id: comment_id,
                thread_id: Some(issue_key.to_string()),
            }],
            trace: EventTrace {
                root_event_id: event_id,
                parent_run_id: None,
                hop_count: 0,
            },
            payload: json!({
                "issue": {
                    "key": issue_key,
                    "summary": fields.get("summary").cloned().unwrap_or(Value::Null),
                    "status": fields.pointer("/status/name").cloned().unwrap_or(Value::Null),
                    "priority": fields.pointer("/priority/name").cloned().unwrap_or(Value::Null),
                    "assignee": fields.pointer("/assignee/accountId").or_else(|| fields.pointer("/assignee/name")).cloned().unwrap_or(Value::Null),
                    "labels": fields.get("labels").cloned().unwrap_or_else(|| json!([])),
                    "project": fields.pointer("/project/key").cloned().unwrap_or(Value::Null),
                },
                "changelog": changelog_items,
                "comment": raw.get("comment").cloned().unwrap_or(Value::Null),
            }),
        })
    }

    /// Normalizes a JQL polling batch against the previous persisted watermark, emitting only
    /// genuine delta events (`created`, `transitioned`, `assigned`, `priority_escalated`, `updated`)
    /// with `jira:{issue_key}` `thread_key` and returning the updated watermark.
    pub fn normalize_jql_poll_batch(
        &self,
        issues: &[Value],
        previous: &JiraPollWatermark,
        now: DateTime<Utc>,
    ) -> Result<(Vec<EventEnvelope>, JiraPollWatermark), SourceNormalizeError> {
        let mut next_watermark = previous.clone();
        let mut envelopes = Vec::new();

        for issue in issues {
            let issue_key = issue
                .get("key")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or(SourceNormalizeError::MissingField("issue.key"))?;
            let fields = issue
                .get("fields")
                .ok_or(SourceNormalizeError::MissingField("issue.fields"))?;

            let updated = fields
                .get("updated")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or(SourceNormalizeError::MissingField("issue.fields.updated"))?
                .to_string();

            let status = fields
                .pointer("/status/name")
                .and_then(Value::as_str)
                .map(str::to_string);
            let assignee_id = fields
                .pointer("/assignee/accountId")
                .or_else(|| fields.pointer("/assignee/name"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let priority = fields
                .pointer("/priority/name")
                .and_then(Value::as_str)
                .map(str::to_string);

            let current_digest = JiraIssueDigest {
                updated: updated.clone(),
                status: status.clone(),
                assignee_id: assignee_id.clone(),
                priority: priority.clone(),
            };

            let prev_digest = previous.digests.get(issue_key);
            if prev_digest == Some(&current_digest) {
                continue;
            }

            let (event_type, delta) = match prev_digest {
                None => (
                    "jira.issue.created",
                    json!({ "from": null, "to": current_digest }),
                ),
                Some(prev) if prev.status != current_digest.status => (
                    "jira.issue.transitioned",
                    json!({
                        "field": "status",
                        "from": prev.status,
                        "to": current_digest.status,
                    }),
                ),
                Some(prev) if prev.assignee_id != current_digest.assignee_id => (
                    "jira.issue.assigned",
                    json!({
                        "field": "assignee",
                        "from": prev.assignee_id,
                        "to": current_digest.assignee_id,
                    }),
                ),
                Some(prev) if prev.priority != current_digest.priority => (
                    "jira.issue.priority_escalated",
                    json!({
                        "field": "priority",
                        "from": prev.priority,
                        "to": current_digest.priority,
                    }),
                ),
                Some(prev) => (
                    "jira.issue.updated",
                    json!({
                        "field": "updated",
                        "from": prev.updated,
                        "to": current_digest.updated,
                    }),
                ),
            };

            if next_watermark
                .cursor_updated_at
                .as_deref()
                .is_none_or(|cursor| updated.as_str() > cursor)
            {
                next_watermark.cursor_updated_at = Some(updated.clone());
            }
            next_watermark
                .digests
                .insert(issue_key.to_string(), current_digest);

            let actor_id = fields
                .pointer("/creator/accountId")
                .or_else(|| fields.pointer("/reporter/accountId"))
                .or_else(|| fields.pointer("/assignee/accountId"))
                .and_then(Value::as_str)
                .unwrap_or("jira:poller");
            let is_self = self
                .self_account_id
                .as_deref()
                .is_some_and(|self_id| self_id == actor_id);

            let event_id = Uuid::new_v4().to_string();
            envelopes.push(EventEnvelope {
                event_id: event_id.clone(),
                delivery_id: format!("jira-poll:{issue_key}:{updated}"),
                source: EventSourceMeta {
                    kind: EventSourceKind::Jira,
                    instance_id: self.instance_id.clone(),
                    trust_level: EventTrustLevel::VerifiedExternal,
                },
                event_type: event_type.to_string(),
                occurred_at: now.to_rfc3339(),
                actor: EventActor {
                    id: actor_id.to_string(),
                    display_name: fields
                        .pointer("/reporter/displayName")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    roles: Vec::new(),
                    is_bot: is_self,
                    is_self,
                },
                thread_key: Some(format!("jira:{issue_key}")),
                correlations: Vec::new(),
                reply_channels: vec![ReplyChannelAddress {
                    source_kind: EventSourceKind::Jira,
                    instance_id: self.instance_id.clone(),
                    channel_id: issue_key.to_string(),
                    message_id: None,
                    thread_id: Some(issue_key.to_string()),
                }],
                trace: EventTrace {
                    root_event_id: event_id,
                    parent_run_id: None,
                    hop_count: 0,
                },
                payload: json!({
                    "issue": {
                        "key": issue_key,
                        "summary": fields.get("summary").cloned().unwrap_or(Value::Null),
                        "status": status,
                        "priority": priority,
                        "assignee": assignee_id,
                        "labels": fields.get("labels").cloned().unwrap_or_else(|| json!([])),
                    },
                    "delta": delta,
                }),
            });
        }

        Ok((envelopes, next_watermark))
    }
}

fn classify_jira_changelog(items: &[Value]) -> String {
    for item in items {
        let field = item
            .get("field")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if field == "status" {
            return "jira.issue.transitioned".to_string();
        }
        if field == "assignee" {
            return "jira.issue.assigned".to_string();
        }
        if field == "priority" {
            return "jira.issue.priority_escalated".to_string();
        }
    }
    "jira.issue.updated".to_string()
}

// =============================================================================
// 3. GitHub Source Normalizer
// =============================================================================

#[derive(Debug, Clone)]
pub struct GitHubSourceNormalizer {
    pub instance_id: String,
    pub self_login: Option<String>,
    pub self_artifacts: BTreeSet<String>,
}

impl GitHubSourceNormalizer {
    pub fn new(instance_id: impl Into<String>, self_login: Option<String>) -> Self {
        Self {
            instance_id: instance_id.into(),
            self_login,
            self_artifacts: BTreeSet::new(),
        }
    }

    pub fn register_self_artifact(&mut self, artifact_id_or_sha: impl Into<String>) {
        self.self_artifacts.insert(artifact_id_or_sha.into());
    }

    pub fn normalize_webhook(
        &self,
        github_event: &str,
        delivery_id: &str,
        raw: &Value,
        now: DateTime<Utc>,
    ) -> Result<EventEnvelope, SourceNormalizeError> {
        let repo = raw
            .pointer("/repository/full_name")
            .or_else(|| raw.pointer("/workflow_run/repository/full_name"))
            .or_else(|| raw.pointer("/check_run/repository/full_name"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or(SourceNormalizeError::MissingField("repository.full_name"))?;

        let action = raw
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("triggered");

        let sender = raw
            .get("sender")
            .filter(|v| !v.is_null())
            .or_else(|| raw.pointer("/workflow_run/triggering_actor"))
            .or_else(|| raw.pointer("/workflow_run/actor"))
            .unwrap_or(&Value::Null);
        let sender_login = sender
            .get("login")
            .and_then(Value::as_str)
            .unwrap_or("github:unknown");
        let sender_type = sender.get("type").and_then(Value::as_str).unwrap_or("User");
        let is_bot = sender_type.eq_ignore_ascii_case("Bot") || sender_login.ends_with("[bot]");
        let mut is_self = self
            .self_login
            .as_deref()
            .is_some_and(|login| login.eq_ignore_ascii_case(sender_login));

        let (event_type, number_opt, message_id, payload) = match github_event {
            "issues" => {
                let issue = raw
                    .get("issue")
                    .ok_or(SourceNormalizeError::MissingField("issue"))?;
                let number = issue
                    .get("number")
                    .and_then(Value::as_u64)
                    .ok_or(SourceNormalizeError::MissingField("issue.number"))?;
                (
                    format!("github.issue.{action}"),
                    Some(number),
                    None,
                    json!({
                        "repository": repo,
                        "action": action,
                        "number": number,
                        "title": issue.get("title").cloned().unwrap_or(Value::Null),
                        "state": issue.get("state").cloned().unwrap_or(Value::Null),
                        "labels": issue.get("labels").cloned().unwrap_or_else(|| json!([])),
                    }),
                )
            }
            "pull_request" => {
                let pr = raw
                    .get("pull_request")
                    .ok_or(SourceNormalizeError::MissingField("pull_request"))?;
                let number = pr
                    .get("number")
                    .or_else(|| raw.get("number"))
                    .and_then(Value::as_u64)
                    .ok_or(SourceNormalizeError::MissingField("pull_request.number"))?;
                let merged = pr.get("merged").and_then(Value::as_bool).unwrap_or(false);
                let head_sha = pr
                    .pointer("/head/sha")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !head_sha.is_empty() && self.self_artifacts.contains(head_sha) {
                    is_self = true;
                }
                let etype = if action == "closed" && merged {
                    "github.pr.merged".to_string()
                } else {
                    format!("github.pr.{action}")
                };
                (
                    etype,
                    Some(number),
                    None,
                    json!({
                        "repository": repo,
                        "action": action,
                        "number": number,
                        "title": pr.get("title").cloned().unwrap_or(Value::Null),
                        "headSha": head_sha,
                        "merged": merged,
                        "draft": pr.get("draft").and_then(Value::as_bool).unwrap_or(false),
                    }),
                )
            }
            "issue_comment" => {
                let issue = raw
                    .get("issue")
                    .ok_or(SourceNormalizeError::MissingField("issue"))?;
                let comment = raw
                    .get("comment")
                    .ok_or(SourceNormalizeError::MissingField("comment"))?;
                let number = issue
                    .get("number")
                    .and_then(Value::as_u64)
                    .ok_or(SourceNormalizeError::MissingField("issue.number"))?;
                let comment_id = comment
                    .get("id")
                    .and_then(Value::as_u64)
                    .map(|id| id.to_string());
                if let Some(cid) = &comment_id
                    && self.self_artifacts.contains(cid)
                {
                    is_self = true;
                }
                let etype = if action == "created" {
                    "github.issue.commented".to_string()
                } else {
                    format!("github.issue.comment_{action}")
                };
                (
                    etype,
                    Some(number),
                    comment_id,
                    json!({
                        "repository": repo,
                        "action": action,
                        "number": number,
                        "isPullRequest": issue.get("pull_request").is_some(),
                        "body": comment.get("body").cloned().unwrap_or(Value::Null),
                    }),
                )
            }
            "check_suite" => {
                let suite = raw
                    .get("check_suite")
                    .ok_or(SourceNormalizeError::MissingField("check_suite"))?;
                let conclusion = suite
                    .get("conclusion")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let head_sha = suite.get("head_sha").and_then(Value::as_str).unwrap_or("");
                if !head_sha.is_empty() && self.self_artifacts.contains(head_sha) {
                    is_self = true;
                }
                let pr_number = suite
                    .pointer("/pull_requests/0/number")
                    .and_then(Value::as_u64);
                let etype = match conclusion {
                    "failure" | "timed_out" | "startup_failure" | "action_required" => {
                        "github.ci.failed".to_string()
                    }
                    "success" => "github.ci.passed".to_string(),
                    "" => format!("github.ci.{action}"),
                    other => format!("github.ci.{other}"),
                };
                (
                    etype,
                    pr_number,
                    None,
                    json!({
                        "repository": repo,
                        "action": action,
                        "conclusion": conclusion,
                        "headSha": head_sha,
                        "headBranch": suite.get("head_branch").cloned().unwrap_or(Value::Null),
                        "number": pr_number,
                    }),
                )
            }
            "workflow_run" => {
                let wf_run = raw
                    .get("workflow_run")
                    .ok_or(SourceNormalizeError::MissingField("workflow_run"))?;
                let normalized_action = match action {
                    "queued" => "requested",
                    other => other,
                };
                let head_sha = wf_run.get("head_sha").and_then(Value::as_str).unwrap_or("");
                if !head_sha.is_empty() && self.self_artifacts.contains(head_sha) {
                    is_self = true;
                }
                let pr_number = wf_run
                    .pointer("/pull_requests/0/number")
                    .and_then(Value::as_u64);
                let name = wf_run
                    .get("name")
                    .or_else(|| wf_run.get("display_title"))
                    .cloned()
                    .unwrap_or(Value::Null);
                let head_branch = wf_run.get("head_branch").cloned().unwrap_or(Value::Null);
                let html_url = wf_run.get("html_url").cloned().unwrap_or(Value::Null);
                let conclusion = wf_run.get("conclusion").cloned().unwrap_or(Value::Null);
                let run_id = wf_run.get("id").cloned().unwrap_or(Value::Null);
                (
                    format!("github.workflow_run.{normalized_action}"),
                    pr_number,
                    None,
                    json!({
                        "repository": repo,
                        "action": normalized_action,
                        "id": run_id,
                        "runId": run_id,
                        "runNumber": wf_run.get("run_number").cloned().unwrap_or(Value::Null),
                        "name": name,
                        "status": wf_run.get("status").cloned().unwrap_or_else(|| json!(normalized_action)),
                        "conclusion": conclusion,
                        "head_branch": head_branch,
                        "headBranch": head_branch,
                        "head_sha": head_sha,
                        "headSha": head_sha,
                        "html_url": html_url,
                        "htmlUrl": html_url,
                        "event": wf_run.get("event").cloned().unwrap_or(Value::Null),
                        "number": pr_number,
                        "workflow_run": wf_run,
                    }),
                )
            }
            "check_run" => {
                let check = raw
                    .get("check_run")
                    .ok_or(SourceNormalizeError::MissingField("check_run"))?;
                let head_sha = check.get("head_sha").and_then(Value::as_str).unwrap_or("");
                if !head_sha.is_empty() && self.self_artifacts.contains(head_sha) {
                    is_self = true;
                }
                let pr_number = check
                    .pointer("/pull_requests/0/number")
                    .and_then(Value::as_u64);
                let html_url = check
                    .get("html_url")
                    .or_else(|| check.get("details_url"))
                    .cloned()
                    .unwrap_or(Value::Null);
                (
                    format!("github.check_run.{action}"),
                    pr_number,
                    None,
                    json!({
                        "repository": repo,
                        "action": action,
                        "id": check.get("id").cloned().unwrap_or(Value::Null),
                        "name": check.get("name").cloned().unwrap_or(Value::Null),
                        "status": check.get("status").cloned().unwrap_or(Value::Null),
                        "conclusion": check.get("conclusion").cloned().unwrap_or(Value::Null),
                        "head_sha": head_sha,
                        "headSha": head_sha,
                        "html_url": html_url,
                        "htmlUrl": html_url,
                        "number": pr_number,
                        "check_run": check,
                    }),
                )
            }
            other => {
                return Err(SourceNormalizeError::UnsupportedEvent(other.to_string()));
            }
        };

        let thread_key = match number_opt {
            Some(number) => Some(format!("github:{repo}#{number}")),
            None => payload
                .get("headSha")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|sha| format!("github:{repo}@{sha}")),
        };

        let channel_id = match number_opt {
            Some(number) => format!("{repo}#{number}"),
            None => thread_key
                .as_deref()
                .and_then(|tk| tk.strip_prefix("github:"))
                .unwrap_or(repo)
                .to_string(),
        };

        let resolved_delivery_id = if delivery_id.trim().is_empty() {
            Uuid::new_v4().to_string()
        } else {
            delivery_id.trim().to_string()
        };

        let event_id = Uuid::new_v4().to_string();
        Ok(EventEnvelope {
            event_id: event_id.clone(),
            delivery_id: resolved_delivery_id,
            source: EventSourceMeta {
                kind: EventSourceKind::Github,
                instance_id: self.instance_id.clone(),
                trust_level: EventTrustLevel::VerifiedExternal,
            },
            event_type,
            occurred_at: now.to_rfc3339(),
            actor: EventActor {
                id: sender_login.to_string(),
                display_name: Some(sender_login.to_string()),
                roles: Vec::new(),
                is_bot: is_bot || is_self,
                is_self,
            },
            thread_key: thread_key.clone(),
            correlations: Vec::new(),
            reply_channels: vec![ReplyChannelAddress {
                source_kind: EventSourceKind::Github,
                instance_id: self.instance_id.clone(),
                channel_id,
                message_id,
                thread_id: thread_key,
            }],
            trace: EventTrace {
                root_event_id: event_id,
                parent_run_id: None,
                hop_count: 0,
            },
            payload,
        })
    }
}

// =============================================================================
// 4. Custom SDK / MCP Event Normalizer
// =============================================================================

#[derive(Debug, Clone)]
pub struct CustomSdkEventInput {
    pub instance_id: String,
    pub event_type: String,
    pub delivery_id: Option<String>,
    pub actor_id: String,
    pub actor_display_name: Option<String>,
    pub trust_level: EventTrustLevel,
    pub thread_key: Option<String>,
    pub correlations: Vec<String>,
    pub reply_channels: Vec<ReplyChannelAddress>,
    pub parent_envelope: Option<EventEnvelope>,
    pub parent_run_id: Option<String>,
    pub payload: Value,
}

pub struct CustomSdkEventNormalizer;

impl CustomSdkEventNormalizer {
    pub fn normalize(
        input: CustomSdkEventInput,
        now: DateTime<Utc>,
    ) -> Result<EventEnvelope, SourceNormalizeError> {
        let event_type = input.event_type.trim();
        if event_type.is_empty() {
            return Err(SourceNormalizeError::MissingField("event_type"));
        }

        let event_id = Uuid::new_v4().to_string();
        let delivery_id = input
            .delivery_id
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| event_id.clone());

        let trace = match &input.parent_envelope {
            Some(parent) => derive_child_trace(parent, input.parent_run_id, DEFAULT_MAX_HOP_COUNT)?,
            None => EventTrace {
                root_event_id: event_id.clone(),
                parent_run_id: input.parent_run_id,
                hop_count: 0,
            },
        };

        let instance_id = if input.instance_id.trim().is_empty() {
            "sdk:default".to_string()
        } else {
            input.instance_id
        };

        Ok(EventEnvelope {
            event_id,
            delivery_id,
            source: EventSourceMeta {
                kind: EventSourceKind::SdkCustom,
                instance_id,
                trust_level: input.trust_level,
            },
            event_type: event_type.to_string(),
            occurred_at: now.to_rfc3339(),
            actor: EventActor {
                id: if input.actor_id.trim().is_empty() {
                    "sdk:anonymous".to_string()
                } else {
                    input.actor_id
                },
                display_name: input.actor_display_name,
                roles: Vec::new(),
                is_bot: false,
                is_self: false,
            },
            thread_key: input.thread_key.filter(|k| !k.trim().is_empty()),
            correlations: input.correlations,
            reply_channels: input.reply_channels,
            trace,
            payload: input.payload,
        })
    }
}
