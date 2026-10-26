//! Flat collaboration sidebar: group chats and direct chats in one list,
//! most recent activity first. Members are identities
//! (`collaboration_members`). Each thread has a per-member session: the
//! contact list opens the chat; the workspace session list shows that
//! session with a bot badge. `member.session.resolve` still opens the
//! hidden conversation from a chat.

use std::collections::HashMap;

use ::db::models::collaboration_identity as identity;
use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::collaboration::{CollaborationError, db as db_err, now_stamp};

/// Group avatars show at most this many members.
pub const MEMBERS_PREVIEW_LIMIT: usize = 4;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SidebarMember {
    /// Identity id (`collaboration_members.id`), the `memberId` for `member.*`.
    pub member_id: String,
    pub name: String,
    pub avatar: Option<String>,
    pub color: Option<String>,
    /// This member's hidden session inside the thread.
    pub conversation_id: String,
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SidebarLastMessage {
    pub id: Option<String>,
    pub seq: Option<i64>,
    pub preview: Option<String>,
    pub origin: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SidebarItem {
    /// `group` or `dm`.
    pub kind: String,
    /// Group: the space id. Direct: `direct:<member_id>`.
    pub thread_id: String,
    /// Group only: same as `thread_id` (for `space.*` calls).
    pub space_id: Option<String>,
    pub name: String,
    pub tag_color: Option<String>,
    /// Group: first 4 non-user members in join order. Direct: the one member.
    pub members_preview: Vec<SidebarMember>,
    pub member_count: usize,
    /// Direct only: the member on the other side.
    pub member: Option<SidebarMember>,
    pub last_message: Option<SidebarLastMessage>,
    pub last_activity_at: String,
    pub unread_count: i64,
    /// Contact group (`contactGroup.*`) the chat is filed under; null = 未分组.
    pub group_id: Option<String>,
}

type MemberJoinRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

async fn thread_members(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<Vec<SidebarMember>, CollaborationError> {
    let rows = sqlx::query_as::<_, MemberJoinRow>(
        r#"SELECT m.id, m.name, m.avatar, m.color, tm.conversation_id, m.agent
           FROM collaboration_thread_members tm
           JOIN collaboration_members m ON m.id = tm.member_id
           WHERE tm.thread_id = ? AND tm.status = 'active'
           ORDER BY tm.joined_at, tm.member_id"#,
    )
    .bind(thread_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows
        .into_iter()
        .map(
            |(member_id, name, avatar, color, conversation_id, agent)| SidebarMember {
                member_id,
                name,
                avatar,
                color,
                conversation_id,
                agent,
            },
        )
        .collect())
}

fn preview_text(envelope: &Value) -> Option<String> {
    let pick = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let text = pick(envelope.get("summary"))
        .or_else(|| pick(envelope.get("content")))
        .or_else(|| pick(envelope.pointer("/object/content")))
        .or_else(|| pick(envelope.pointer("/content/text")))
        .or_else(|| pick(envelope.get("text")))?;
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(flat.chars().take(120).collect())
}

fn sidebar_last_from_group_row(
    id: String,
    seq: i64,
    envelope: String,
    origin: String,
    created_at: String,
) -> SidebarLastMessage {
    let envelope: Value = serde_json::from_str(&envelope).unwrap_or(Value::Null);
    SidebarLastMessage {
        id: Some(id),
        seq: Some(seq),
        preview: preview_text(&envelope),
        origin: Some(origin),
        created_at,
    }
}

fn sidebar_last_from_dm(message: DmMessage) -> SidebarLastMessage {
    SidebarLastMessage {
        id: Some(message.id),
        seq: Some(message.seq),
        preview: Some(flatten_preview(&message.text)),
        origin: Some(message.origin),
        created_at: message.created_at,
    }
}

async fn baseline_thread_read(
    pool: &SqlitePool,
    thread_id: &str,
    tail_seq: Option<i64>,
) -> Result<(), CollaborationError> {
    sqlx::query(
        r#"INSERT INTO collaboration_thread_reads (thread_id, last_read_seq, updated_at)
           VALUES (?, ?, ?) ON CONFLICT(thread_id) DO NOTHING"#,
    )
    .bind(thread_id)
    .bind(tail_seq.unwrap_or(0))
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(())
}

async fn session_updated_at(pool: &SqlitePool, conversation_id: &str) -> Option<String> {
    let id = Uuid::parse_str(conversation_id).ok()?;
    sqlx::query_scalar::<_, String>("SELECT CAST(updated_at AS TEXT) FROM sessions WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

/// One visible message of a direct chat, read from the member's DM
/// conversation events. `seq` is the `conversation_events.sequence` of the
/// message's first event: stable, monotonic, and the value `thread.markRead`
/// takes for `direct:<id>` threads.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DmMessage {
    pub id: String,
    pub seq: i64,
    /// `user` or `agent` (same vocabulary as group messages).
    pub origin: String,
    pub text: String,
    pub created_at: String,
    /// Present on user messages that arrived through `conversation_input`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    /// User-message delivery: `queued`, `claimed`, or `dispatched`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cross_chat_sent_to: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cross_chat_received_from: Option<Value>,
}

const DM_VISIBLE_EVENT_KINDS: &str =
    "'user_turn_created', 'assistant_text_delta', 'conversation_input'";
const DM_USER_EVENT_KINDS: &str = "'user_turn_created', 'conversation_input'";

/// Hidden first user turn after creating a bot. Session tab keeps it; the
/// collaboration message area and sidebar preview skip it so the bot greets first.
pub const PRIVATE_BOOTSTRAP_PREFIX: &str = "<vibex-private-bootstrap>";

fn is_private_bootstrap_prompt(text: &str) -> bool {
    text.trim_start().starts_with(PRIVATE_BOOTSTRAP_PREFIX)
}

fn flatten_preview(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(120).collect()
}

/// The DM thread's hidden conversation and its member, for `direct:<id>`.
pub async fn dm_conversation(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<Option<(Uuid, SidebarMember)>, CollaborationError> {
    if !thread_id.starts_with("direct:") {
        return Ok(None);
    }
    let Some(member) = thread_members(pool, thread_id).await?.into_iter().next() else {
        return Ok(None);
    };
    Ok(Uuid::parse_str(&member.conversation_id)
        .ok()
        .map(|conversation| (conversation, member)))
}

fn visible_user_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty()
        || crate::session_info::is_host_history_prompt(trimmed)
        || is_private_bootstrap_prompt(trimmed)
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn dm_user_message(
    conversation_id: Uuid,
    sequence: i64,
    text: String,
    created_at: String,
    operation_id: Option<String>,
    delivered: &str,
) -> DmMessage {
    DmMessage {
        id: format!("{conversation_id}:{sequence}"),
        seq: sequence,
        origin: "user".into(),
        text,
        created_at,
        operation_id,
        delivered: Some(delivered.to_string()),
        cross_chat_sent_to: None,
        cross_chat_received_from: None,
    }
}

fn collab_origin_is_foreign(space_id: Option<&str>, thread_id: &str) -> bool {
    match space_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(space) if !thread_id.is_empty() => space != thread_id,
        _ => false,
    }
}

fn protocol_collab_space_id(blocks: &[agents::ConversationInputBlock]) -> Option<String> {
    use agents::ConversationInputBlock;
    for block in blocks {
        let ConversationInputBlock::Protocol { content } = block else {
            continue;
        };
        if content.get("kind").and_then(Value::as_str) != Some("collaboration_space_origin") {
            continue;
        }
        return content
            .get("spaceId")
            .or_else(|| content.get("space_id"))
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    None
}

async fn conversation_thread_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<String, CollaborationError> {
    Ok(sqlx::query_scalar(
        "SELECT thread_id FROM collaboration_thread_members WHERE conversation_id = ? LIMIT 1",
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db_err)?
    .unwrap_or_default())
}

fn cross_chat_field_present(value: &Option<Value>) -> bool {
    match value {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => true,
    }
}

fn dm_row_is_visible(message: &DmMessage) -> bool {
    !message.text.is_empty()
        || cross_chat_field_present(&message.cross_chat_sent_to)
        || cross_chat_field_present(&message.cross_chat_received_from)
}

fn last_previewable_dm(messages: Vec<DmMessage>) -> Option<DmMessage> {
    messages
        .into_iter()
        .rev()
        .find(|message| !message.text.trim().is_empty())
}

async fn grouped_dm_rows(
    pool: &SqlitePool,
    conversation_id: Uuid,
    rows: Vec<(i64, String, String)>,
) -> Result<Vec<DmMessage>, CollaborationError> {
    let thread_id = conversation_thread_id(pool, conversation_id).await?;
    let mut messages = group_dm_rows(conversation_id, &thread_id, rows);
    overlay_dm_cross_chat(pool, conversation_id, &mut messages).await?;
    messages.retain(dm_row_is_visible);
    Ok(messages)
}

async fn overlay_dm_cross_chat(
    pool: &SqlitePool,
    conversation_id: Uuid,
    messages: &mut [DmMessage],
) -> Result<(), CollaborationError> {
    let thread_id = conversation_thread_id(pool, conversation_id).await?;
    if thread_id.is_empty() {
        return Ok(());
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, envelope_json FROM collaboration_space_messages WHERE space_id = ?",
    )
    .bind(&thread_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut by_id = HashMap::new();
    for (id, raw) in rows {
        if let Ok(env) = serde_json::from_str::<Value>(&raw) {
            by_id.insert(id, env);
        }
    }
    for message in messages {
        let env = by_id
            .get(&message.id)
            .or_else(|| message.operation_id.as_ref().and_then(|op| by_id.get(op)));
        let Some(env) = env else {
            continue;
        };
        if let Some(sent) = env.get("crossChatSentTo").cloned() {
            message.cross_chat_sent_to = Some(sent);
        }
        if let Some(received) = env.get("crossChatReceivedFrom").cloned() {
            message.cross_chat_received_from = Some(received);
        }
    }
    Ok(())
}

/// Group user-turn, queued conversation-input, and assistant-delta events
/// into visible messages. Tool calls, reasoning, usage and system events
/// are never selected. Bootstrap prompts stay off this list.
fn group_dm_rows(
    conversation_id: Uuid,
    thread_id: &str,
    rows: Vec<(i64, String, String)>,
) -> Vec<DmMessage> {
    use agents::{ConversationEvent, ConversationInputBlock, ConversationInputEvent};

    struct Grouped {
        message: DmMessage,
        assistant_id: Option<String>,
        input_id: Option<Uuid>,
        matched_turn: bool,
    }

    let mut out: Vec<Grouped> = Vec::new();
    let mut by_input: HashMap<Uuid, usize> = HashMap::new();
    for (sequence, normalized, created_at) in rows {
        let Ok(event) = serde_json::from_str::<ConversationEvent>(&normalized) else {
            continue;
        };
        match event {
            ConversationEvent::ConversationInput { event } => match event {
                ConversationInputEvent::Submitted {
                    input_id,
                    operation_id,
                    payload,
                    ..
                } => {
                    if collab_origin_is_foreign(
                        payload
                            .collaboration_origin
                            .as_ref()
                            .map(|origin| origin.space_id.as_str()),
                        thread_id,
                    ) {
                        continue;
                    }
                    let raw = payload
                        .display_text
                        .as_deref()
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                        .unwrap_or(payload.text.trim());
                    let Some(text) = visible_user_text(raw) else {
                        continue;
                    };
                    by_input.insert(input_id, out.len());
                    out.push(Grouped {
                        message: dm_user_message(
                            conversation_id,
                            sequence,
                            text,
                            created_at,
                            Some(operation_id.to_string()),
                            "queued",
                        ),
                        assistant_id: None,
                        input_id: Some(input_id),
                        matched_turn: false,
                    });
                }
                ConversationInputEvent::Claimed { input_id, .. } => {
                    if let Some(&idx) = by_input.get(&input_id) {
                        out[idx].message.delivered = Some("claimed".into());
                    }
                }
                ConversationInputEvent::Dispatched { input_id, .. } => {
                    if let Some(&idx) = by_input.get(&input_id) {
                        out[idx].message.delivered = Some("dispatched".into());
                    }
                }
                _ => {}
            },
            ConversationEvent::UserTurnCreated { blocks, .. } => {
                if collab_origin_is_foreign(protocol_collab_space_id(&blocks).as_deref(), thread_id)
                {
                    continue;
                }
                let text = blocks
                    .into_iter()
                    .filter_map(|block| match block {
                        ConversationInputBlock::Text { text } => Some(text),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let Some(text) = visible_user_text(&text) else {
                    continue;
                };
                if let Some(row) = out.iter_mut().find(|row| {
                    row.message.origin == "user"
                        && row.input_id.is_some()
                        && !row.matched_turn
                        && row.message.text == text
                }) {
                    row.matched_turn = true;
                    if row.message.delivered.as_deref() == Some("queued") {
                        row.message.delivered = Some("dispatched".into());
                    }
                    continue;
                }
                out.push(Grouped {
                    message: dm_user_message(
                        conversation_id,
                        sequence,
                        text,
                        created_at,
                        None,
                        "dispatched",
                    ),
                    assistant_id: None,
                    input_id: None,
                    matched_turn: true,
                });
            }
            ConversationEvent::AssistantTextDelta { text, message_id } => {
                let append = out.last().is_some_and(|current| {
                    current.message.origin == "agent"
                        && (message_id.is_none()
                            || current.assistant_id.is_none()
                            || current.assistant_id == message_id)
                });
                if append {
                    let current = out.last_mut().expect("checked");
                    current.message.text.push_str(&text);
                    current.message.created_at = created_at;
                    if current.assistant_id.is_none() {
                        current.assistant_id = message_id;
                    }
                } else {
                    out.push(Grouped {
                        message: DmMessage {
                            id: message_id
                                .clone()
                                .unwrap_or_else(|| format!("{conversation_id}:{sequence}")),
                            seq: sequence,
                            origin: "agent".into(),
                            text,
                            created_at,
                            operation_id: None,
                            delivered: None,
                            cross_chat_sent_to: None,
                            cross_chat_received_from: None,
                        },
                        assistant_id: message_id,
                        input_id: None,
                        matched_turn: false,
                    });
                }
            }
            _ => {}
        }
    }
    out.into_iter()
        .map(|mut row| {
            row.message.text = row.message.text.trim().to_string();
            row.message
        })
        .collect()
}

/// Fetch visible DM event rows in `(after_seq, upper_seq)` in ascending order.
/// When `after_seq > 0` and new rows exist, prepends up to 8 preceding visible
/// events so continuation deltas or `Submitted -> UserTurnCreated` pairs that
/// straddle `after_seq` stay attached to their `<= after_seq` origin.
async fn dm_rows_since(
    pool: &SqlitePool,
    conversation_id: Uuid,
    after_seq: i64,
    upper_seq: Option<i64>,
) -> Result<Vec<(i64, String, String)>, CollaborationError> {
    let mut rows = match upper_seq {
        Some(upper) => {
            let sql = format!(
                r#"SELECT sequence, normalized_json, CAST(created_at AS TEXT)
                   FROM conversation_events
                   WHERE conversation_id = ? AND sequence > ? AND sequence < ?
                     AND event_kind IN ({DM_VISIBLE_EVENT_KINDS})
                   ORDER BY sequence ASC"#
            );
            sqlx::query_as::<_, (i64, String, String)>(&sql)
                .bind(conversation_id)
                .bind(after_seq)
                .bind(upper)
                .fetch_all(pool)
                .await
                .map_err(db_err)?
        }
        None => {
            let sql = format!(
                r#"SELECT sequence, normalized_json, CAST(created_at AS TEXT)
                   FROM conversation_events
                   WHERE conversation_id = ? AND sequence > ?
                     AND event_kind IN ({DM_VISIBLE_EVENT_KINDS})
                   ORDER BY sequence ASC"#
            );
            sqlx::query_as::<_, (i64, String, String)>(&sql)
                .bind(conversation_id)
                .bind(after_seq)
                .fetch_all(pool)
                .await
                .map_err(db_err)?
        }
    };
    if rows.is_empty() {
        return Ok(rows);
    }
    if after_seq > 0 {
        let previous_sql = format!(
            r#"SELECT sequence, normalized_json, CAST(created_at AS TEXT)
               FROM conversation_events
               WHERE conversation_id = ? AND sequence <= ?
                 AND event_kind IN ({DM_VISIBLE_EVENT_KINDS})
               ORDER BY sequence DESC LIMIT 8"#
        );
        let mut previous = sqlx::query_as::<_, (i64, String, String)>(&previous_sql)
            .bind(conversation_id)
            .bind(after_seq)
            .fetch_all(pool)
            .await
            .map_err(db_err)?;
        if !previous.is_empty() {
            previous.reverse();
            previous.extend(rows);
            rows = previous;
        }
    }
    Ok(rows)
}

/// Locate the sequence boundary before the last `limit` messages by stepping
/// back over non-streaming user events (`user_turn_created` / `conversation_input`),
/// so streaming `assistant_text_delta` chunks never crowd out earlier turns.
async fn dm_tail_window_start_seq(
    pool: &SqlitePool,
    conversation_id: Uuid,
    limit: usize,
) -> Result<i64, CollaborationError> {
    let user_event_offset = (limit.saturating_mul(4).saturating_add(4)) as i64;
    let boundary_sql = format!(
        r#"SELECT sequence
           FROM conversation_events
           WHERE conversation_id = ?
             AND event_kind IN ({DM_USER_EVENT_KINDS})
           ORDER BY sequence DESC
           LIMIT 1 OFFSET ?"#
    );
    let Some(boundary_seq) = sqlx::query_scalar::<_, i64>(&boundary_sql)
        .bind(conversation_id)
        .bind(user_event_offset)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?
    else {
        return Ok(0);
    };
    let prev_delta_seq: Option<i64> = sqlx::query_scalar(
        r#"SELECT MAX(sequence)
           FROM conversation_events
           WHERE conversation_id = ? AND sequence < ?
             AND event_kind = 'assistant_text_delta'"#,
    )
    .bind(conversation_id)
    .bind(boundary_seq)
    .fetch_one(pool)
    .await
    .map_err(db_err)?;
    Ok(prev_delta_seq.unwrap_or(0))
}

/// DM history. `since_seq`: messages after that ordinal (oldest first);
/// otherwise the latest `limit` messages.
pub async fn list_dm_messages(
    pool: &SqlitePool,
    conversation_id: Uuid,
    since_seq: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<DmMessage>, CollaborationError> {
    let limit = usize::try_from(limit.unwrap_or(200).clamp(1, 1000)).unwrap_or(200);
    match since_seq {
        Some(since) => {
            let user_event_offset = (limit.saturating_mul(4).saturating_add(4)) as i64;
            let upper_sql = format!(
                r#"SELECT sequence
                   FROM conversation_events
                   WHERE conversation_id = ? AND sequence > ?
                     AND event_kind IN ({DM_USER_EVENT_KINDS})
                   ORDER BY sequence ASC
                   LIMIT 1 OFFSET ?"#
            );
            let upper_seq = sqlx::query_scalar::<_, i64>(&upper_sql)
                .bind(conversation_id)
                .bind(since)
                .bind(user_event_offset)
                .fetch_optional(pool)
                .await
                .map_err(db_err)?;
            let mut messages = grouped_dm_rows(
                pool,
                conversation_id,
                dm_rows_since(pool, conversation_id, since, upper_seq).await?,
            )
            .await?;
            messages.retain(|message| message.seq > since);
            if messages.len() < limit && upper_seq.is_some() {
                messages = grouped_dm_rows(
                    pool,
                    conversation_id,
                    dm_rows_since(pool, conversation_id, since, None).await?,
                )
                .await?;
                messages.retain(|message| message.seq > since);
            }
            messages.truncate(limit);
            Ok(messages)
        }
        None => {
            let start_seq = dm_tail_window_start_seq(pool, conversation_id, limit).await?;
            let mut messages = grouped_dm_rows(
                pool,
                conversation_id,
                dm_rows_since(pool, conversation_id, start_seq, None).await?,
            )
            .await?;
            if messages.len() < limit && start_seq > 0 {
                messages = grouped_dm_rows(
                    pool,
                    conversation_id,
                    dm_rows_since(pool, conversation_id, 0, None).await?,
                )
                .await?;
            }
            let skip = messages.len().saturating_sub(limit);
            Ok(messages.into_iter().skip(skip).collect())
        }
    }
}

/// Assemble the last visible DM message by locating the latest user-turn
/// boundary and reading only the trailing turn's events.
async fn dm_last_message(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<SidebarLastMessage>, CollaborationError> {
    let user_sql = format!(
        r#"SELECT sequence, normalized_json, CAST(created_at AS TEXT)
           FROM conversation_events
           WHERE conversation_id = ?
             AND event_kind IN ({DM_USER_EVENT_KINDS})
           ORDER BY sequence DESC
           LIMIT 32"#
    );
    let user_rows = sqlx::query_as::<_, (i64, String, String)>(&user_sql)
        .bind(conversation_id)
        .fetch_all(pool)
        .await
        .map_err(db_err)?;
    let latest_user_seq = user_rows.first().map(|row| row.0).unwrap_or(0);

    let delta_rows = sqlx::query_as::<_, (i64, String, String)>(
        r#"SELECT sequence, normalized_json, CAST(created_at AS TEXT)
           FROM conversation_events
           WHERE conversation_id = ? AND sequence > ?
             AND event_kind = 'assistant_text_delta'
           ORDER BY sequence ASC"#,
    )
    .bind(conversation_id)
    .bind(latest_user_seq)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    if !delta_rows.is_empty()
        && let Some(message) =
            last_previewable_dm(grouped_dm_rows(pool, conversation_id, delta_rows).await?)
    {
        return Ok(Some(sidebar_last_from_dm(message)));
    }
    if user_rows.is_empty() {
        return Ok(None);
    }

    let max_delta_seq = sqlx::query_scalar::<_, Option<i64>>(
        r#"SELECT MAX(sequence)
           FROM conversation_events
           WHERE conversation_id = ? AND event_kind = 'assistant_text_delta'"#,
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .map_err(db_err)?
    .unwrap_or(0);

    let trailing_user_rows: Vec<(i64, String, String)> = user_rows
        .iter()
        .filter(|row| row.0 > max_delta_seq)
        .cloned()
        .rev()
        .collect();
    if !trailing_user_rows.is_empty()
        && let Some(message) =
            last_previewable_dm(grouped_dm_rows(pool, conversation_id, trailing_user_rows).await?)
    {
        return Ok(Some(sidebar_last_from_dm(message)));
    }

    if max_delta_seq > 0 {
        let prev_user_seq = user_rows
            .iter()
            .map(|row| row.0)
            .find(|&seq| seq < max_delta_seq)
            .unwrap_or(0);
        let prev_deltas = sqlx::query_as::<_, (i64, String, String)>(
            r#"SELECT sequence, normalized_json, CAST(created_at AS TEXT)
               FROM conversation_events
               WHERE conversation_id = ? AND sequence > ? AND sequence <= ?
                 AND event_kind = 'assistant_text_delta'
               ORDER BY sequence ASC"#,
        )
        .bind(conversation_id)
        .bind(prev_user_seq)
        .bind(max_delta_seq)
        .fetch_all(pool)
        .await
        .map_err(db_err)?;
        if let Some(message) =
            last_previewable_dm(grouped_dm_rows(pool, conversation_id, prev_deltas).await?)
        {
            return Ok(Some(sidebar_last_from_dm(message)));
        }
    }

    Ok(
        last_previewable_dm(list_dm_messages(pool, conversation_id, None, Some(20)).await?)
            .map(sidebar_last_from_dm),
    )
}

async fn read_mark(pool: &SqlitePool, thread_id: &str) -> Result<Option<i64>, CollaborationError> {
    sqlx::query_scalar("SELECT last_read_seq FROM collaboration_thread_reads WHERE thread_id = ?")
        .bind(thread_id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

/// DM unread = agent messages whose ordinal is past the read mark. First sight
/// baselines at the current tail (upgrades start at zero), like groups.
async fn dm_unread_count_with_read(
    pool: &SqlitePool,
    thread_id: &str,
    conversation_id: Uuid,
    read: Option<i64>,
    tail_seq: Option<i64>,
) -> Result<i64, CollaborationError> {
    let Some(read) = read else {
        baseline_thread_read(pool, thread_id, tail_seq).await?;
        return Ok(0);
    };
    if tail_seq.is_some_and(|tail| tail <= read) {
        return Ok(0);
    }
    let rows = dm_rows_since(pool, conversation_id, read, None).await?;
    if rows.is_empty() {
        return Ok(0);
    }
    let messages = grouped_dm_rows(pool, conversation_id, rows).await?;
    Ok(messages
        .iter()
        .filter(|message| message.seq > read && message.origin == "agent")
        .count() as i64)
}

async fn dm_tail_seq(pool: &SqlitePool, conversation_id: Uuid) -> Result<i64, CollaborationError> {
    Ok(dm_last_message(pool, conversation_id)
        .await?
        .and_then(|message| message.seq)
        .unwrap_or(0))
}

type ThreadMemberJoinRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

async fn workspace_thread_members(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<HashMap<String, Vec<SidebarMember>>, CollaborationError> {
    let rows = sqlx::query_as::<_, ThreadMemberJoinRow>(
        r#"SELECT tm.thread_id, m.id, m.name, m.avatar, m.color, tm.conversation_id, m.agent
           FROM collaboration_thread_members tm
           JOIN collaboration_members m ON m.id = tm.member_id
           WHERE tm.status = 'active'
             AND (
               tm.thread_id IN (SELECT id FROM collaboration_spaces WHERE workspace_id = ?1)
               OR tm.thread_id IN (SELECT id FROM collaboration_threads WHERE kind = 'direct' AND workspace_id = ?1)
             )
           ORDER BY tm.joined_at, tm.member_id"#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut by_thread: HashMap<String, Vec<SidebarMember>> = HashMap::new();
    for (thread_id, member_id, name, avatar, color, conversation_id, agent) in rows {
        by_thread.entry(thread_id).or_default().push(SidebarMember {
            member_id,
            name,
            avatar,
            color,
            conversation_id,
            agent,
        });
    }
    Ok(by_thread)
}

async fn workspace_group_last_messages(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<HashMap<String, SidebarLastMessage>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, String, i64, String, String, String)>(
        r#"SELECT m.space_id, m.id, m.seq, m.envelope_json, m.origin, m.created_at
           FROM collaboration_space_messages m
           JOIN (
               SELECT space_id, MAX(seq) AS max_seq
               FROM collaboration_space_messages
               WHERE space_id IN (SELECT id FROM collaboration_spaces WHERE workspace_id = ?1)
               GROUP BY space_id
           ) latest ON latest.space_id = m.space_id AND latest.max_seq = m.seq"#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows
        .into_iter()
        .map(|(space_id, id, seq, envelope, origin, created_at)| {
            (
                space_id,
                sidebar_last_from_group_row(id, seq, envelope, origin, created_at),
            )
        })
        .collect())
}

async fn workspace_read_marks(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<HashMap<String, i64>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT thread_id, last_read_seq
           FROM collaboration_thread_reads
           WHERE thread_id IN (SELECT id FROM collaboration_spaces WHERE workspace_id = ?1)
              OR thread_id IN (SELECT id FROM collaboration_threads WHERE kind = 'direct' AND workspace_id = ?1)"#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows.into_iter().collect())
}

async fn workspace_group_unreads(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<HashMap<String, i64>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT m.space_id, COUNT(*)
           FROM collaboration_space_messages m
           JOIN collaboration_thread_reads r ON r.thread_id = m.space_id
           WHERE m.space_id IN (SELECT id FROM collaboration_spaces WHERE workspace_id = ?1)
             AND m.seq > r.last_read_seq
             AND m.origin = 'agent'
           GROUP BY m.space_id"#,
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows.into_iter().collect())
}

pub async fn list_sidebar(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Vec<SidebarItem>, CollaborationError> {
    let workspace_str = workspace_id.to_string();
    let mut items = Vec::new();
    let groups = sqlx::query_as::<_, (String, String, Option<String>, String)>(
        r#"SELECT id, name, tag_color, created_at FROM collaboration_spaces
           WHERE workspace_id = ? ORDER BY created_at, id"#,
    )
    .bind(&workspace_str)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let directs = sqlx::query_as::<_, (String, String, String)>(
        r#"SELECT id, title, created_at FROM collaboration_threads
           WHERE kind = 'direct' AND workspace_id = ? ORDER BY created_at, id"#,
    )
    .bind(&workspace_str)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;

    let mut members_by_thread = workspace_thread_members(pool, &workspace_str).await?;
    let mut group_last_by_space = workspace_group_last_messages(pool, &workspace_str).await?;
    let read_marks = workspace_read_marks(pool, &workspace_str).await?;
    let group_unreads = workspace_group_unreads(pool, &workspace_str).await?;

    for (space_id, name, tag_color, created_at) in groups {
        let members = members_by_thread.remove(&space_id).unwrap_or_default();
        let last = group_last_by_space.remove(&space_id);
        let tail_seq = last.as_ref().and_then(|m| m.seq);
        let unread = if read_marks.contains_key(&space_id) {
            *group_unreads.get(&space_id).unwrap_or(&0)
        } else {
            baseline_thread_read(pool, &space_id, tail_seq).await?;
            0
        };
        let last_activity_at = last
            .as_ref()
            .map(|m| m.created_at.clone())
            .unwrap_or(created_at);
        items.push(SidebarItem {
            kind: "group".into(),
            thread_id: space_id.clone(),
            space_id: Some(space_id),
            name,
            tag_color,
            member_count: members.len(),
            members_preview: members.into_iter().take(MEMBERS_PREVIEW_LIMIT).collect(),
            member: None,
            last_message: last,
            last_activity_at,
            unread_count: unread,
            group_id: None,
        });
    }

    for (thread_id, title, created_at) in directs {
        let members = members_by_thread.remove(&thread_id).unwrap_or_default();
        let Some(member) = members.into_iter().next() else {
            continue;
        };
        let read_mark = read_marks.get(&thread_id).copied();
        let (last, unread) = match Uuid::parse_str(&member.conversation_id) {
            Ok(conversation) => {
                let last = dm_last_message(pool, conversation).await?;
                let unread = dm_unread_count_with_read(
                    pool,
                    &thread_id,
                    conversation,
                    read_mark,
                    last.as_ref().and_then(|m| m.seq),
                )
                .await?;
                (last, unread)
            }
            Err(_) => (None, 0),
        };
        let last_activity_at = match last.as_ref() {
            Some(message) => message.created_at.clone(),
            None => session_updated_at(pool, &member.conversation_id)
                .await
                .unwrap_or(created_at),
        };
        let name = if member.name.trim().is_empty() {
            title
        } else {
            member.name.clone()
        };
        items.push(SidebarItem {
            kind: "dm".into(),
            thread_id,
            space_id: None,
            name,
            tag_color: None,
            members_preview: vec![member.clone()],
            member_count: 1,
            member: Some(member),
            last_message: last,
            last_activity_at,
            unread_count: unread,
            group_id: None,
        });
    }

    let assigned = sqlx::query_as::<_, (String, String)>(
        r#"SELECT tg.thread_id, tg.group_id FROM collaboration_thread_contact_groups tg
           JOIN collaboration_contact_groups g ON g.id = tg.group_id
           WHERE g.workspace_id = ?"#,
    )
    .bind(workspace_str)
    .fetch_all(pool)
    .await
    .map_err(db_err)?
    .into_iter()
    .collect::<HashMap<_, _>>();
    for item in &mut items {
        item.group_id = assigned.get(&item.thread_id).cloned();
    }
    items.sort_by(|a, b| {
        normalize(&b.last_activity_at)
            .cmp(&normalize(&a.last_activity_at))
            .then_with(|| a.thread_id.cmp(&b.thread_id))
    });
    Ok(items)
}

/// Comparable instant for mixed RFC3339 / SQLite datetime strings.
fn normalize(stamp: &str) -> i64 {
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(stamp) {
        return parsed.timestamp_millis();
    }
    for format in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(parsed) = chrono::NaiveDateTime::parse_from_str(stamp, format) {
            return parsed.and_utc().timestamp_millis();
        }
    }
    0
}

/// Mark a thread read up to `seq` (default: its current tail). Never moves back.
pub async fn mark_thread_read(
    pool: &SqlitePool,
    thread_id: &str,
    seq: Option<i64>,
) -> Result<i64, CollaborationError> {
    let dm = dm_conversation(pool, thread_id).await?;
    let seq = match (seq, dm) {
        (Some(seq), _) => seq,
        (None, Some((conversation, _))) => dm_tail_seq(pool, conversation).await?,
        (None, None) => sqlx::query_scalar::<_, Option<i64>>(
            "SELECT MAX(seq) FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(thread_id)
        .fetch_one(pool)
        .await
        .map_err(db_err)?
        .unwrap_or(0),
    };
    sqlx::query(
        r#"INSERT INTO collaboration_thread_reads (thread_id, last_read_seq, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             last_read_seq = MAX(last_read_seq, excluded.last_read_seq),
             updated_at = excluded.updated_at"#,
    )
    .bind(thread_id)
    .bind(seq)
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db_err)?;
    sqlx::query_scalar("SELECT last_read_seq FROM collaboration_thread_reads WHERE thread_id = ?")
        .bind(thread_id)
        .fetch_one(pool)
        .await
        .map_err(db_err)
}

/// Move the read cursor before the tail so the thread shows as unread.
/// A fully-read thread becomes unread by one (the last message).
pub async fn mark_thread_unread(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<i64, CollaborationError> {
    let dm = dm_conversation(pool, thread_id).await?;
    let tail = match dm {
        Some((conversation, _)) => dm_tail_seq(pool, conversation).await?,
        None => sqlx::query_scalar::<_, Option<i64>>(
            "SELECT MAX(seq) FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(thread_id)
        .fetch_one(pool)
        .await
        .map_err(db_err)?
        .unwrap_or(0),
    };
    let current = read_mark(pool, thread_id).await?.unwrap_or(tail);
    let seq = if tail <= 0 {
        0
    } else if current >= tail {
        tail - 1
    } else {
        current.min(tail - 1)
    };
    sqlx::query(
        r#"INSERT INTO collaboration_thread_reads (thread_id, last_read_seq, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             last_read_seq = excluded.last_read_seq,
             updated_at = excluded.updated_at"#,
    )
    .bind(thread_id)
    .bind(seq)
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(seq)
}

pub async fn set_space_tag_color(
    pool: &SqlitePool,
    space_id: &str,
    tag_color: Option<&str>,
) -> Result<(), CollaborationError> {
    let updated = sqlx::query("UPDATE collaboration_spaces SET tag_color = ? WHERE id = ?")
        .bind(tag_color)
        .bind(space_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    if updated.rows_affected() == 0 {
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MemberSummary {
    pub member_id: String,
    pub name: String,
    pub avatar: Option<String>,
    pub color: Option<String>,
    pub agent: Option<String>,
    pub role_id: Option<String>,
    pub direct_thread_id: String,
    /// Threads (direct + group) the member is active in, join order.
    pub thread_ids: Vec<String>,
}

/// Members that have a session in `workspace_id` (any thread), by creation.
pub async fn list_members(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Vec<MemberSummary>, CollaborationError> {
    type Row = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let workspace_str = workspace_id.to_string();
    let rows = sqlx::query_as::<_, Row>(
        r#"SELECT DISTINCT m.id, m.name, m.avatar, m.color, m.agent, m.role_id
           FROM collaboration_members m
           JOIN collaboration_thread_members tm ON tm.member_id = m.id AND tm.status = 'active'
           JOIN collaboration_threads t ON t.id = tm.thread_id
           WHERE t.workspace_id = ?
           ORDER BY m.created_at, m.id"#,
    )
    .bind(&workspace_str)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let thread_rows = sqlx::query_as::<_, (String, String)>(
        r#"SELECT tm.member_id, tm.thread_id
           FROM collaboration_thread_members tm
           WHERE tm.status = 'active'
             AND tm.member_id IN (
               SELECT DISTINCT tm2.member_id
               FROM collaboration_thread_members tm2
               JOIN collaboration_threads t ON t.id = tm2.thread_id
               WHERE tm2.status = 'active' AND t.workspace_id = ?
             )
           ORDER BY tm.joined_at, tm.thread_id"#,
    )
    .bind(&workspace_str)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut threads_by_member: HashMap<String, Vec<String>> = HashMap::new();
    for (member_id, thread_id) in thread_rows {
        threads_by_member
            .entry(member_id)
            .or_default()
            .push(thread_id);
    }
    let mut out = Vec::new();
    for (member_id, name, avatar, color, agent, role_id) in rows {
        let thread_ids = threads_by_member.remove(&member_id).unwrap_or_default();
        out.push(MemberSummary {
            direct_thread_id: identity::direct_thread_id(&member_id),
            member_id,
            name,
            avatar,
            color,
            agent,
            role_id,
            thread_ids,
        });
    }
    Ok(out)
}

/// Update identity display fields. `None` leaves a field unchanged; an empty
/// string clears avatar / color.
pub async fn update_member_profile(
    pool: &SqlitePool,
    member_id: &str,
    name: Option<&str>,
    avatar: Option<&str>,
    color: Option<&str>,
) -> Result<(), CollaborationError> {
    let exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM collaboration_members WHERE id = ?")
            .bind(member_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    if exists.is_none() {
        return Err(CollaborationError::new("not_found", "member was not found"));
    }
    if let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) {
        sqlx::query("UPDATE collaboration_members SET name = ? WHERE id = ?")
            .bind(name)
            .bind(member_id)
            .execute(pool)
            .await
            .map_err(db_err)?;
        let direct_tid = identity::direct_thread_id(member_id);
        sqlx::query("UPDATE collaboration_threads SET title = ? WHERE id = ?")
            .bind(name)
            .bind(&direct_tid)
            .execute(pool)
            .await
            .map_err(db_err)?;
        sqlx::query(
            r#"UPDATE collaboration_space_members
               SET nickname = ?
               WHERE member_id = ?
                  OR conversation_id IN (
                       SELECT conversation_id FROM collaboration_thread_members WHERE member_id = ?
                  )"#,
        )
        .bind(name)
        .bind(member_id)
        .bind(member_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
        sqlx::query(
            r#"UPDATE conversation_personas
               SET name = ?
               WHERE conversation_id IN (
                   SELECT conversation_id FROM collaboration_thread_members WHERE member_id = ?
               )"#,
        )
        .bind(name)
        .bind(member_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    }
    let blank = |v: &str| {
        let v = v.trim();
        if v.is_empty() {
            None
        } else {
            Some(v.to_string())
        }
    };
    if let Some(avatar) = avatar {
        sqlx::query("UPDATE collaboration_members SET avatar = ? WHERE id = ?")
            .bind(blank(avatar))
            .bind(member_id)
            .execute(pool)
            .await
            .map_err(db_err)?;
    }
    if let Some(color) = color {
        sqlx::query("UPDATE collaboration_members SET color = ? WHERE id = ?")
            .bind(blank(color))
            .bind(member_id)
            .execute(pool)
            .await
            .map_err(db_err)?;
    }
    Ok(())
}

/// Identity id behind a seat conversation (`space.createMember` result).
pub async fn identity_member_of_conversation(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Option<String>, CollaborationError> {
    sqlx::query_scalar(
        "SELECT member_id FROM collaboration_thread_members WHERE conversation_id = ?",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ContactGroup {
    pub group_id: String,
    pub workspace_id: String,
    pub name: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

type ContactGroupRow = (String, String, String, i64, String, String);

fn contact_group(row: ContactGroupRow) -> ContactGroup {
    let (group_id, workspace_id, name, sort_order, created_at, updated_at) = row;
    ContactGroup {
        group_id,
        workspace_id,
        name,
        sort_order,
        created_at,
        updated_at,
    }
}

fn contact_group_name(name: &str) -> Result<String, CollaborationError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CollaborationError::new(
            "invalid_input",
            "group name is required",
        ));
    }
    Ok(name.to_string())
}

pub async fn list_contact_groups(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Vec<ContactGroup>, CollaborationError> {
    let rows = sqlx::query_as::<_, ContactGroupRow>(
        r#"SELECT id, workspace_id, name, sort_order, created_at, updated_at
           FROM collaboration_contact_groups WHERE workspace_id = ?
           ORDER BY sort_order, created_at, id"#,
    )
    .bind(workspace_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows.into_iter().map(contact_group).collect())
}

pub async fn get_contact_group(
    pool: &SqlitePool,
    group_id: &str,
) -> Result<ContactGroup, CollaborationError> {
    sqlx::query_as::<_, ContactGroupRow>(
        r#"SELECT id, workspace_id, name, sort_order, created_at, updated_at
           FROM collaboration_contact_groups WHERE id = ?"#,
    )
    .bind(group_id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?
    .map(contact_group)
    .ok_or_else(|| CollaborationError::new("not_found", "contact group was not found"))
}

/// New group goes last.
pub async fn create_contact_group(
    pool: &SqlitePool,
    workspace_id: Uuid,
    name: &str,
) -> Result<ContactGroup, CollaborationError> {
    let name = contact_group_name(name)?;
    let id = Uuid::new_v4().to_string();
    let now = now_stamp();
    sqlx::query(
        r#"INSERT INTO collaboration_contact_groups
           (id, workspace_id, name, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1
                             FROM collaboration_contact_groups WHERE workspace_id = ?), ?, ?)"#,
    )
    .bind(&id)
    .bind(workspace_id.to_string())
    .bind(&name)
    .bind(workspace_id.to_string())
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    get_contact_group(pool, &id).await
}

pub async fn rename_contact_group(
    pool: &SqlitePool,
    group_id: &str,
    name: &str,
) -> Result<ContactGroup, CollaborationError> {
    let name = contact_group_name(name)?;
    let updated = sqlx::query(
        "UPDATE collaboration_contact_groups SET name = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&name)
    .bind(now_stamp())
    .bind(group_id)
    .execute(pool)
    .await
    .map_err(db_err)?;
    if updated.rows_affected() == 0 {
        return Err(CollaborationError::new(
            "not_found",
            "contact group was not found",
        ));
    }
    get_contact_group(pool, group_id).await
}

/// Deletes the group; its chats fall back to ungrouped. Returns those thread ids.
pub async fn delete_contact_group(
    pool: &SqlitePool,
    group_id: &str,
) -> Result<Vec<String>, CollaborationError> {
    get_contact_group(pool, group_id).await?;
    let mut tx = pool.begin().await.map_err(db_err)?;
    let threads = sqlx::query_scalar::<_, String>(
        "SELECT thread_id FROM collaboration_thread_contact_groups WHERE group_id = ? ORDER BY thread_id",
    )
    .bind(group_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    sqlx::query("DELETE FROM collaboration_thread_contact_groups WHERE group_id = ?")
        .bind(group_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    sqlx::query("DELETE FROM collaboration_contact_groups WHERE id = ?")
        .bind(group_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(threads)
}

/// `group_ids` is the new order; it must list every group of the workspace once.
pub async fn reorder_contact_groups(
    pool: &SqlitePool,
    workspace_id: Uuid,
    group_ids: &[String],
) -> Result<Vec<ContactGroup>, CollaborationError> {
    let existing = list_contact_groups(pool, workspace_id).await?;
    let mut want: Vec<&str> = group_ids.iter().map(String::as_str).collect();
    let mut have: Vec<&str> = existing.iter().map(|g| g.group_id.as_str()).collect();
    want.sort_unstable();
    have.sort_unstable();
    if want != have {
        return Err(CollaborationError::new(
            "invalid_input",
            "groupIds must list every contact group of the workspace exactly once",
        ));
    }
    let now = now_stamp();
    let mut tx = pool.begin().await.map_err(db_err)?;
    for (index, id) in group_ids.iter().enumerate() {
        sqlx::query(
            "UPDATE collaboration_contact_groups SET sort_order = ?, updated_at = ? WHERE id = ?",
        )
        .bind(index as i64)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    list_contact_groups(pool, workspace_id).await
}

/// Workspace of a sidebar thread: a group (space id) or `direct:<member>`.
async fn thread_workspace(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<String, CollaborationError> {
    let workspace: Option<Option<String>> = sqlx::query_scalar(
        r#"SELECT workspace_id FROM collaboration_spaces WHERE id = ?
           UNION ALL
           SELECT workspace_id FROM collaboration_threads WHERE id = ?
           LIMIT 1"#,
    )
    .bind(thread_id)
    .bind(thread_id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?;
    match workspace {
        Some(Some(workspace)) => Ok(workspace),
        Some(None) => Ok(String::new()),
        None => Err(CollaborationError::new("not_found", "thread was not found")),
    }
}

/// File a chat under a contact group, or `None` for ungrouped.
pub async fn set_thread_contact_group(
    pool: &SqlitePool,
    thread_id: &str,
    group_id: Option<&str>,
) -> Result<(), CollaborationError> {
    let workspace = thread_workspace(pool, thread_id).await?;
    match group_id {
        None => {
            sqlx::query("DELETE FROM collaboration_thread_contact_groups WHERE thread_id = ?")
                .bind(thread_id)
                .execute(pool)
                .await
                .map_err(db_err)?;
        }
        Some(group_id) => {
            let group = get_contact_group(pool, group_id).await?;
            if !workspace.is_empty() && group.workspace_id != workspace {
                return Err(CollaborationError::new(
                    "invalid_input",
                    "contact group belongs to another workspace",
                ));
            }
            sqlx::query(
                r#"INSERT INTO collaboration_thread_contact_groups (thread_id, group_id, updated_at)
                   VALUES (?, ?, ?)
                   ON CONFLICT(thread_id) DO UPDATE SET
                     group_id = excluded.group_id,
                     updated_at = excluded.updated_at"#,
            )
            .bind(thread_id)
            .bind(group_id)
            .bind(now_stamp())
            .execute(pool)
            .await
            .map_err(db_err)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::{ConversationEvent, ConversationInputBlock};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    async fn setup_test_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        pool
    }

    async fn seed_dm_session(
        pool: &SqlitePool,
        workspace: Uuid,
        conversation: Uuid,
        name: &str,
    ) -> String {
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspaces (id, task_id, branch) VALUES (?, ?, 'main')")
            .bind(workspace)
            .bind(Uuid::new_v4())
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (id, workspace_id, name) VALUES (?, ?, ?)")
            .bind(conversation)
            .bind(workspace)
            .bind(name)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(pool)
            .await
            .unwrap();
        let member_id = identity::member_id_for_conversation(conversation);
        let thread_id = identity::direct_thread_id(&member_id);
        sqlx::query(
            "INSERT INTO collaboration_members (id, name, created_at) VALUES (?, ?, '2026-10-24T00:00:00Z')",
        )
        .bind(&member_id)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO collaboration_threads (id, kind, workspace_id, title, created_at) VALUES (?, 'direct', ?, ?, '2026-10-24T00:00:00Z')",
        )
        .bind(&thread_id)
        .bind(workspace.to_string())
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO collaboration_thread_members (thread_id, member_id, conversation_id, status, joined_at) VALUES (?, ?, ?, 'active', '2026-10-24T00:00:00Z')",
        )
        .bind(&thread_id)
        .bind(&member_id)
        .bind(conversation.to_string())
        .execute(pool)
        .await
        .unwrap();
        thread_id
    }

    #[tokio::test]
    async fn long_streaming_dm_preserves_all_turns_and_sidebar_state() {
        let pool = setup_test_pool().await;
        let workspace = Uuid::new_v4();
        let conversation = Uuid::new_v4();
        let thread_id = seed_dm_session(&pool, workspace, conversation, "Bot").await;

        // 10 turns where each reply has 500 streaming deltas = 5,010 events (> 4,000 old scan cap).
        let mut seq = 0_i64;
        let mut tx = pool.begin().await.unwrap();
        for turn in 1..=10 {
            seq += 1;
            let user_json = serde_json::to_string(&ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: format!("user turn {turn}"),
                }],
                workflow_refs: Vec::new(),
            })
            .unwrap();
            sqlx::query(
                r#"INSERT INTO conversation_events
                   (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
                   VALUES (?, ?, ?, 'user', 'user_turn_created', ?, ?)"#,
            )
            .bind(Uuid::new_v4())
            .bind(conversation)
            .bind(seq)
            .bind(user_json)
            .bind(format!("2026-10-24T00:{turn:02}:00.000Z"))
            .execute(&mut *tx)
            .await
            .unwrap();

            for chunk in 1..=500 {
                seq += 1;
                let delta_json = serde_json::to_string(&ConversationEvent::AssistantTextDelta {
                    text: if chunk == 1 {
                        format!("reply {turn}: ")
                    } else {
                        "x".to_string()
                    },
                    message_id: None,
                })
                .unwrap();
                sqlx::query(
                    r#"INSERT INTO conversation_events
                       (id, conversation_id, sequence, source, event_kind, normalized_json, created_at)
                       VALUES (?, ?, ?, 'acp', 'assistant_text_delta', ?, ?)"#,
                )
                .bind(Uuid::new_v4())
                .bind(conversation)
                .bind(seq)
                .bind(delta_json)
                .bind(format!("2026-10-24T00:{turn:02}:30.000Z"))
                .execute(&mut *tx)
                .await
                .unwrap();
            }
        }
        tx.commit().await.unwrap();

        let history = list_dm_messages(&pool, conversation, None, Some(200))
            .await
            .unwrap();
        assert_eq!(
            history.len(),
            20,
            "all 10 user + 10 agent messages must be preserved"
        );
        assert_eq!(history[0].text, "user turn 1");
        assert!(history[1].text.starts_with("reply 1: "));
        assert_eq!(history[18].text, "user turn 10");
        assert!(history[19].text.starts_with("reply 10: "));

        // First sidebar load baselines read mark at tail (0 unread) and extracts full last message preview.
        let sidebar = list_sidebar(&pool, workspace).await.unwrap();
        assert_eq!(sidebar.len(), 1);
        assert_eq!(sidebar[0].thread_id, thread_id);
        assert_eq!(sidebar[0].unread_count, 0);
        let last = sidebar[0].last_message.as_ref().expect("last message");
        assert_eq!(last.seq, Some(history[19].seq));
        assert!(
            last.preview
                .as_deref()
                .unwrap_or_default()
                .starts_with("reply 10: "),
            "preview must start from the beginning of turn 10's reply: {:?}",
            last.preview
        );

        // Mark unread moves cursor before tail -> 1 unread message.
        mark_thread_unread(&pool, &thread_id).await.unwrap();
        let sidebar = list_sidebar(&pool, workspace).await.unwrap();
        assert_eq!(sidebar[0].unread_count, 1);

        // Mark read clears unread count.
        mark_thread_read(&pool, &thread_id, None).await.unwrap();
        let sidebar = list_sidebar(&pool, workspace).await.unwrap();
        assert_eq!(sidebar[0].unread_count, 0);
    }
}
