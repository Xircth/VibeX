//! Read-only lookup for a Conversation the user referenced in Composer.
//!
//! `get_session_info` is a query, not a control surface. Any non-deleted
//! Conversation on this Host is visible; ancestry and workspace boundaries
//! belong only to `send_session_input` / `cancel_session_turn` /
//! `wait_for_session`.

use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};

use agents::{ConversationEvent, ConversationInputBlock};
use chrono::{DateTime, Utc};
use db::models::{conversation::DbConversationSummary, workspace::Workspace};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

pub const MAX_SESSION_MESSAGES: u32 = 200;
const PER_TURN_CHARS: usize = 1_500;
const OVERALL_CHARS: usize = 16_000;
const MAX_TOOLS_PER_TURN: usize = 16;
const MAX_TOOL_NAME_CHARS: usize = 64;
const PAGE_SIZE: i64 = 512;
const PARSE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_CONCURRENT_PARSES: usize = 4;

#[derive(Debug, Clone, Serialize)]
pub struct SessionMessageItem {
    pub role: String,
    pub text: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionMessages {
    pub total: u32,
    pub included: u32,
    pub truncated: bool,
    pub items: Vec<SessionMessageItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub found: bool,
    pub conversation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_conversation_id: Option<Uuid>,
    pub is_delegation_child: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<SessionMessages>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl SessionInfo {
    pub fn not_found(conversation_id: &str) -> Self {
        Self {
            found: false,
            conversation_id: conversation_id.to_string(),
            title: None,
            agent_id: None,
            status: None,
            model: None,
            git_branch: None,
            workspace_path: None,
            workspace_name: None,
            workspace_id: None,
            message_count: None,
            created_at: None,
            updated_at: None,
            parent_conversation_id: None,
            is_delegation_child: false,
            stats: None,
            messages: None,
            note: Some(format!(
                "No conversation matches id {conversation_id}. It may have been deleted, or was never created on this Host."
            )),
        }
    }
}

pub fn session_info_value(info: &SessionInfo) -> Value {
    serde_json::to_value(info).unwrap_or_else(|_| {
        json!({
            "found": false,
            "conversation_id": info.conversation_id,
        })
    })
}

pub async fn resolve_referenced_session(
    pool: &SqlitePool,
    conversation_id: &str,
    max_messages: u32,
) -> SessionInfo {
    let Ok(id) = Uuid::parse_str(conversation_id.trim()) else {
        return SessionInfo::not_found(conversation_id);
    };
    let Ok(Some(summary)) = DbConversationSummary::find_by_id(pool, id).await else {
        return SessionInfo::not_found(&id.to_string());
    };

    let workspace = Workspace::find_by_id(pool, summary.workspace_id)
        .await
        .ok()
        .flatten();
    let mut info = SessionInfo {
        found: true,
        conversation_id: summary.id.to_string(),
        title: summary
            .title
            .clone()
            .filter(|title| !title.trim().is_empty()),
        agent_id: summary.agent_id.as_ref().map(|agent| agent.to_string()),
        status: Some(session_status_label(&summary.status)),
        model: summary
            .model
            .clone()
            .filter(|model| !model.trim().is_empty()),
        git_branch: workspace
            .as_ref()
            .map(|workspace| workspace.branch.clone())
            .filter(|branch| !branch.trim().is_empty()),
        workspace_path: workspace
            .as_ref()
            .and_then(|workspace| workspace.container_ref.clone())
            .filter(|path| !path.trim().is_empty()),
        workspace_name: workspace
            .as_ref()
            .and_then(|workspace| workspace.name.clone())
            .filter(|name| !name.trim().is_empty()),
        workspace_id: Some(summary.workspace_id),
        message_count: Some(summary.message_count),
        created_at: Some(summary.created_at),
        updated_at: Some(summary.updated_at),
        parent_conversation_id: summary.parent_session_id,
        is_delegation_child: summary.parent_session_id.is_some(),
        stats: None,
        messages: None,
        note: None,
    };

    if max_messages == 0 {
        return info;
    }

    match bounded_transcript(pool.clone(), id, max_messages).await {
        TranscriptSlot::Ready((messages, stats)) => {
            if let Some(count) = messages.as_ref().map(|slice| i64::from(slice.total)) {
                info.message_count = Some(count);
            }
            info.stats = stats;
            info.messages = messages;
        }
        TranscriptSlot::Busy => {
            info.note = Some(
                "Recent messages are unavailable — too many session reads are in progress. Retry, or call again with max_messages: 0 for metadata only."
                    .to_string(),
            );
        }
        TranscriptSlot::TimedOut => {
            info.note = Some(
                "Recent messages are unavailable — reading the conversation transcript timed out. Retry, or call again with max_messages: 0 for metadata only."
                    .to_string(),
            );
        }
    }
    info
}

enum TranscriptSlot {
    Ready((Option<SessionMessages>, Option<Value>)),
    Busy,
    TimedOut,
}

fn parse_limit() -> Arc<tokio::sync::Semaphore> {
    static LIMIT: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    LIMIT
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_PARSES)))
        .clone()
}

async fn bounded_transcript(
    pool: SqlitePool,
    conversation_id: Uuid,
    max_messages: u32,
) -> TranscriptSlot {
    let Ok(permit) = parse_limit().try_acquire_owned() else {
        return TranscriptSlot::Busy;
    };
    let handle = tokio::spawn(async move {
        let _permit = permit;
        load_compact_transcript(&pool, conversation_id, max_messages).await
    });
    match tokio::time::timeout(PARSE_TIMEOUT, handle).await {
        Ok(Ok(value)) => TranscriptSlot::Ready(value),
        _ => TranscriptSlot::TimedOut,
    }
}

pub async fn load_compact_transcript(
    pool: &SqlitePool,
    conversation_id: Uuid,
    max_messages: u32,
) -> (Option<SessionMessages>, Option<Value>) {
    if max_messages == 0 {
        return (None, None);
    }
    struct CompactMessage {
        role: &'static str,
        chunks_rev: Vec<String>,
        tools: Vec<String>,
        message_id: Option<String>,
    }
    let keep = usize::try_from(max_messages.min(MAX_SESSION_MESSAGES)).unwrap_or(200);
    let mut before_sequence = i64::MAX;
    let mut messages: Vec<CompactMessage> = Vec::new();
    let mut latest_usage: Option<Value> = None;
    'pages: loop {
        let rows = sqlx::query_as::<_, (i64, String)>(
            r#"SELECT sequence, normalized_json
               FROM conversation_events
               WHERE conversation_id = ?
                 AND event_kind IN (
                   'user_turn_created',
                   'assistant_text_delta',
                   'tool_call_upsert',
                   'usage_updated'
                 )
                 AND sequence < ?
               ORDER BY sequence DESC
               LIMIT ?"#,
        )
        .bind(conversation_id)
        .bind(before_sequence)
        .bind(PAGE_SIZE)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        if rows.is_empty() {
            break;
        }
        let page_len = rows.len();
        for (sequence, normalized) in rows {
            before_sequence = sequence;
            let Ok(event) = serde_json::from_str::<ConversationEvent>(&normalized) else {
                continue;
            };
            match event {
                ConversationEvent::UserTurnCreated { blocks, .. } => {
                    let content = blocks
                        .into_iter()
                        .filter_map(|block| match block {
                            ConversationInputBlock::Text { text } => Some(text),
                            ConversationInputBlock::Image { .. }
                            | ConversationInputBlock::Resource { .. }
                            | ConversationInputBlock::Protocol { .. } => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    if !content.is_empty() {
                        messages.push(CompactMessage {
                            role: "user",
                            chunks_rev: vec![content],
                            tools: Vec::new(),
                            message_id: None,
                        });
                    }
                }
                ConversationEvent::AssistantTextDelta { text, message_id } => {
                    let append_to_current = messages.last().is_some_and(|current| {
                        current.role == "assistant"
                            && (message_id.is_none()
                                || current.message_id.is_none()
                                || current.message_id == message_id)
                    });
                    if append_to_current {
                        let current = messages.last_mut().expect("checked above");
                        if current.message_id.is_none() {
                            current.message_id = message_id;
                        }
                        current.chunks_rev.push(text);
                    } else {
                        messages.push(CompactMessage {
                            role: "assistant",
                            chunks_rev: vec![text],
                            tools: Vec::new(),
                            message_id,
                        });
                    }
                }
                ConversationEvent::ToolCallUpsert { tool_call } => {
                    let name = tool_call
                        .title
                        .filter(|title| !title.trim().is_empty())
                        .or(tool_call.kind)
                        .unwrap_or_else(|| "tool".to_string());
                    let name = truncate_chars(&name, MAX_TOOL_NAME_CHARS);
                    if let Some(current) = messages.last_mut()
                        && current.tools.len() < MAX_TOOLS_PER_TURN
                        && !current.tools.contains(&name)
                    {
                        current.tools.push(name);
                    }
                }
                ConversationEvent::UsageUpdated { usage } => {
                    if latest_usage.is_none() {
                        latest_usage = usage_stats(&usage);
                    }
                }
                _ => {}
            }
            if messages.len() > keep {
                break 'pages;
            }
        }
        if page_len < usize::try_from(PAGE_SIZE).unwrap_or(512) {
            break;
        }
    }

    let total = messages.len() as u32;
    let mut budget = OVERALL_CHARS;
    let mut items: Vec<SessionMessageItem> = Vec::new();
    for message in messages.into_iter().take(keep) {
        let text = truncate_chars(
            &message.chunks_rev.into_iter().rev().collect::<String>(),
            PER_TURN_CHARS,
        );
        let cost = text.chars().count()
            + message
                .tools
                .iter()
                .map(|name| name.chars().count())
                .sum::<usize>();
        if !items.is_empty() && cost > budget {
            break;
        }
        budget = budget.saturating_sub(cost);
        items.push(SessionMessageItem {
            role: message.role.to_string(),
            text,
            tools: message.tools,
        });
    }
    items.reverse();
    let included = items.len() as u32;
    (
        Some(SessionMessages {
            total,
            included,
            truncated: included < total,
            items,
        }),
        latest_usage,
    )
}

fn usage_stats(usage: &agents::ConversationUsage) -> Option<Value> {
    let input = usage.input_tokens;
    let output = usage.output_tokens;
    let total = input
        .saturating_add(output)
        .saturating_add(usage.cache_creation_input_tokens)
        .saturating_add(usage.cache_read_input_tokens);
    if total == 0 && usage.context_used.is_none() {
        return None;
    }
    let mut stats = serde_json::Map::new();
    if total > 0 {
        stats.insert("total_tokens".into(), json!(total));
    }
    if input > 0 {
        stats.insert("input_tokens".into(), json!(input));
    }
    if output > 0 {
        stats.insert("output_tokens".into(), json!(output));
    }
    if let Some(used) = usage.context_used {
        stats.insert("context_used".into(), json!(used));
    }
    if let Some(max) = usage.context_window_max {
        stats.insert("context_window_max".into(), json!(max));
    }
    Some(Value::Object(stats))
}

fn session_status_label(status: &db::models::session::SessionStatus) -> String {
    serde_json::to_value(status)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{status:?}").to_ascii_lowercase())
}

pub async fn host_history_prompt(
    pool: &SqlitePool,
    conversation_id: Uuid,
    current_user_text: &str,
) -> Option<String> {
    let (messages, _) = load_compact_transcript(pool, conversation_id, MAX_SESSION_MESSAGES).await;
    format_host_history_prompt(messages.as_ref()?, current_user_text)
}

pub fn format_host_history_prompt(
    messages: &SessionMessages,
    current_user_text: &str,
) -> Option<String> {
    let mut items = messages.items.clone();
    if items
        .last()
        .is_some_and(|item| item.role == "user" && item.text.trim() == current_user_text.trim())
    {
        items.pop();
    }
    if items.is_empty() {
        return None;
    }
    let mut body = String::from("Previous conversation:\n");
    for item in items {
        let role = match item.role.as_str() {
            "user" => "User",
            "assistant" => "Assistant",
            other => other,
        };
        body.push_str(role);
        body.push_str(": ");
        body.push_str(item.text.trim());
        body.push('\n');
    }
    Some(body)
}

fn truncate_chars(value: &str, cap: usize) -> String {
    if value.chars().count() <= cap {
        return value.to_string();
    }
    let mut out: String = value.chars().take(cap).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::{ConversationEvent, ConversationInputBlock};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    use super::*;

    #[test]
    fn host_history_prompt_omits_the_current_user_message() {
        let messages = SessionMessages {
            total: 3,
            included: 3,
            truncated: false,
            items: vec![
                SessionMessageItem {
                    role: "user".into(),
                    text: "first question".into(),
                    tools: Vec::new(),
                },
                SessionMessageItem {
                    role: "assistant".into(),
                    text: "first answer".into(),
                    tools: Vec::new(),
                },
                SessionMessageItem {
                    role: "user".into(),
                    text: "second question".into(),
                    tools: Vec::new(),
                },
            ],
        };
        let prompt = format_host_history_prompt(&messages, "second question").expect("history");
        assert!(prompt.contains("User: first question"));
        assert!(prompt.contains("Assistant: first answer"));
        assert!(!prompt.contains("second question"));
        assert!(format_host_history_prompt(&messages, "first question").is_some());
        assert!(
            format_host_history_prompt(
                &SessionMessages {
                    total: 1,
                    included: 1,
                    truncated: false,
                    items: vec![SessionMessageItem {
                        role: "user".into(),
                        text: "only".into(),
                        tools: Vec::new(),
                    }],
                },
                "only"
            )
            .is_none()
        );
    }

    async fn pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:").unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE conversation_events (
                   conversation_id BLOB NOT NULL,
                   event_kind TEXT NOT NULL,
                   sequence INTEGER NOT NULL,
                   normalized_json TEXT NOT NULL
               )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn insert_event(
        pool: &SqlitePool,
        conversation_id: Uuid,
        sequence: i64,
        event: ConversationEvent,
    ) {
        let kind = match event {
            ConversationEvent::UserTurnCreated { .. } => "user_turn_created",
            ConversationEvent::AssistantTextDelta { .. } => "assistant_text_delta",
            ConversationEvent::ToolCallUpsert { .. } => "tool_call_upsert",
            ConversationEvent::UsageUpdated { .. } => "usage_updated",
            _ => "unknown",
        };
        let normalized = serde_json::to_string(&event).unwrap();
        sqlx::query(
            "INSERT INTO conversation_events \
             (conversation_id, event_kind, sequence, normalized_json) VALUES (?, ?, ?, ?)",
        )
        .bind(conversation_id)
        .bind(kind)
        .bind(sequence)
        .bind(normalized)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn compact_transcript_honors_message_limit_and_zero() {
        let pool = pool().await;
        let conversation_id = Uuid::new_v4();
        insert_event(
            &pool,
            conversation_id,
            1,
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "first".to_string(),
                }],
                workflow_refs: Vec::new(),
            },
        )
        .await;
        insert_event(
            &pool,
            conversation_id,
            2,
            ConversationEvent::AssistantTextDelta {
                text: "second".to_string(),
                message_id: Some("assistant-1".to_string()),
            },
        )
        .await;
        insert_event(
            &pool,
            conversation_id,
            3,
            ConversationEvent::AssistantTextDelta {
                text: " third".to_string(),
                message_id: Some("assistant-1".to_string()),
            },
        )
        .await;

        let (one, _) = load_compact_transcript(&pool, conversation_id, 1).await;
        let (none, _) = load_compact_transcript(&pool, conversation_id, 0).await;
        let items = one.expect("messages");
        assert_eq!(items.items.len(), 1);
        assert_eq!(items.items[0].role, "assistant");
        assert_eq!(items.items[0].text, "second third");
        assert!(none.is_none());
    }

    #[tokio::test]
    async fn compact_transcript_does_not_cut_a_long_streamed_message() {
        let pool = pool().await;
        let conversation_id = Uuid::new_v4();
        let mut transaction = pool.begin().await.unwrap();
        for sequence in 1..=10_001_i64 {
            let text = match sequence {
                1 => "start|",
                10_001 => "|end",
                _ => "x",
            };
            let normalized = serde_json::to_string(&ConversationEvent::AssistantTextDelta {
                text: text.to_string(),
                message_id: Some("one-long-message".to_string()),
            })
            .unwrap();
            sqlx::query(
                "INSERT INTO conversation_events \
                 (conversation_id, event_kind, sequence, normalized_json) VALUES (?, ?, ?, ?)",
            )
            .bind(conversation_id)
            .bind("assistant_text_delta")
            .bind(sequence)
            .bind(normalized)
            .execute(&mut *transaction)
            .await
            .unwrap();
        }
        transaction.commit().await.unwrap();

        let (messages, _) = load_compact_transcript(&pool, conversation_id, 1).await;
        let slice = messages.expect("messages");
        assert_eq!(slice.items.len(), 1);
        let content = &slice.items[0].text;
        assert!(content.starts_with("start|"));
        assert!(
            content.ends_with('…'),
            "over-budget turns truncate, not split"
        );
    }

    #[tokio::test]
    async fn invalid_id_is_soft_not_found() {
        let options = SqliteConnectOptions::from_str("sqlite::memory:").unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let info = resolve_referenced_session(&pool, "not-a-uuid", 20).await;
        assert!(!info.found);
        assert!(info.note.unwrap().contains("not-a-uuid"));
    }
}
