//! Flat collaboration sidebar: group chats and direct chats in one list,
//! most recent activity first. Members are identities
//! (`collaboration_members`). Each thread has a per-member session: the
//! contact list opens the chat; the workspace session list shows that
//! session with a bot badge. `member.session.resolve` still opens the
//! hidden conversation from a chat.

use std::collections::{HashMap, HashSet};

use ::db::models::collaboration_identity as identity;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::collaboration::{CollaborationError, append_space_event_tx, db as db_err, now_stamp};

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
    pub is_supervisor: bool,
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
    i64,
);

async fn thread_members(
    pool: &SqlitePool,
    thread_id: &str,
) -> Result<Vec<SidebarMember>, CollaborationError> {
    let rows = sqlx::query_as::<_, MemberJoinRow>(
        r#"SELECT m.id, m.name, m.avatar, m.color, tm.conversation_id, m.agent, m.is_supervisor
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
            |(member_id, name, avatar, color, conversation_id, agent, is_supervisor)| {
                SidebarMember {
                    member_id,
                    name,
                    avatar,
                    color,
                    conversation_id,
                    agent,
                    is_supervisor: is_supervisor != 0,
                }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
}

const DM_VISIBLE_EVENT_KINDS: &str =
    "'user_turn_created', 'assistant_text_delta', 'conversation_input'";
const DM_USER_EVENT_KINDS: &str = "'user_turn_created', 'conversation_input'";

/// Hidden first user turn after creating a bot. Session tab keeps it; the
/// collaboration message area and sidebar preview skip it so the bot greets first.
pub const PRIVATE_BOOTSTRAP_PREFIX: &str = "<vibex-private-bootstrap>";

fn is_private_bootstrap_prompt(text: &str) -> bool {
    text.contains(PRIVATE_BOOTSTRAP_PREFIX)
}

fn flatten_preview(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(120).collect()
}

fn normalize_dm_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
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
        turn_id: None,
        streaming: None,
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
    let is_silent_pass =
        message.origin != "user" && crate::collaboration::is_pass_token(&message.text);
    let has_visible_text = !message.text.is_empty() && !is_silent_pass;
    has_visible_text
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
                            turn_id: None,
                            streaming: None,
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
            if row.message.origin == "agent" {
                let stripped = crate::collaboration::strip_stray_pass_tokens(&row.message.text);
                if crate::collaboration::is_pass_token(stripped) {
                    row.message.text.clear();
                } else {
                    row.message.text = stripped.to_string();
                }
            } else {
                row.message.text = row.message.text.trim().to_string();
            }
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
    cutover_seq: Option<i64>,
) -> Result<i64, CollaborationError> {
    let user_event_offset = (limit.saturating_mul(4).saturating_add(4)) as i64;
    let boundary_seq = match cutover_seq {
        Some(c_seq) => {
            let boundary_sql = format!(
                r#"SELECT sequence
                   FROM conversation_events
                   WHERE conversation_id = ? AND sequence <= ?
                     AND event_kind IN ({DM_USER_EVENT_KINDS})
                   ORDER BY sequence DESC
                   LIMIT 1 OFFSET ?"#
            );
            sqlx::query_scalar::<_, i64>(&boundary_sql)
                .bind(conversation_id)
                .bind(c_seq)
                .bind(user_event_offset)
                .fetch_optional(pool)
                .await
                .map_err(db_err)?
        }
        None => {
            let boundary_sql = format!(
                r#"SELECT sequence
                   FROM conversation_events
                   WHERE conversation_id = ?
                     AND event_kind IN ({DM_USER_EVENT_KINDS})
                   ORDER BY sequence DESC
                   LIMIT 1 OFFSET ?"#
            );
            sqlx::query_scalar::<_, i64>(&boundary_sql)
                .bind(conversation_id)
                .bind(user_event_offset)
                .fetch_optional(pool)
                .await
                .map_err(db_err)?
        }
    };
    let Some(boundary_seq) = boundary_seq else {
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

async fn dm_cutover_info(
    pool: &SqlitePool,
    conversation_id: Uuid,
    thread_id: &str,
) -> Result<Option<i64>, CollaborationError> {
    if thread_id.is_empty() {
        return Ok(None);
    }
    let row = sqlx::query_as::<_, (Option<i64>, Option<String>)>(
        "SELECT space_cutover_seq, space_cutover_at FROM collaboration_threads WHERE id = ?",
    )
    .bind(thread_id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?;
    let Some((cutover_seq, cutover_at)) = row else {
        return Ok(None);
    };
    let Some(cutover_at) = cutover_at.filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    if let Some(seq) = cutover_seq {
        return Ok(Some(seq));
    }
    let inferred: Option<i64> = sqlx::query_scalar(
        r#"SELECT MAX(sequence)
           FROM conversation_events
           WHERE conversation_id = ? AND CAST(created_at AS TEXT) < ?"#,
    )
    .bind(conversation_id)
    .bind(&cutover_at)
    .fetch_one(pool)
    .await
    .map_err(db_err)?;
    Ok(Some(inferred.unwrap_or(0)))
}

type SpaceDmRow = (
    String,
    i64,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn parse_space_dm_row(
    (id, seq, envelope_raw, origin, created_at, status, receipt_state, turn_id): SpaceDmRow,
) -> Option<DmMessage> {
    let envelope: Value = serde_json::from_str(&envelope_raw).unwrap_or(Value::Null);
    let raw_content = envelope
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let cross_chat_sent_to = envelope.get("crossChatSentTo").cloned();
    let cross_chat_received_from = envelope.get("crossChatReceivedFrom").cloned();
    let text = if origin == "user" {
        match visible_user_text(&raw_content) {
            Some(t) => t,
            None if cross_chat_field_present(&cross_chat_sent_to)
                || cross_chat_field_present(&cross_chat_received_from) =>
            {
                String::new()
            }
            None => return None,
        }
    } else {
        let stripped = crate::collaboration::strip_stray_pass_tokens(&raw_content);
        if crate::collaboration::is_pass_token(stripped) {
            String::new()
        } else {
            stripped.to_string()
        }
    };
    let (operation_id, delivered) = if origin == "user" {
        let deliv = if status.as_deref() == Some("failed") {
            Some("failed".to_string())
        } else {
            receipt_state.or(status)
        };
        (Some(id.clone()), deliv)
    } else {
        (None, None)
    };
    // User space bubbles are independent of the member session turn.
    // Attaching `collaboration_turns.id` here lets the IM merge collapse
    // the user message into the streaming draft / agent reply.
    let turn_id = if origin == "user" { None } else { turn_id };
    let message = DmMessage {
        id,
        seq,
        origin,
        text,
        created_at,
        operation_id,
        delivered,
        cross_chat_sent_to,
        cross_chat_received_from,
        turn_id,
        streaming: None,
    };
    dm_row_is_visible(&message).then_some(message)
}

async fn dm_space_messages_since(
    pool: &SqlitePool,
    thread_id: &str,
    after_seq: i64,
) -> Result<Vec<DmMessage>, CollaborationError> {
    let rows = sqlx::query_as::<_, SpaceDmRow>(
        r#"SELECT m.id, m.seq, m.envelope_json, m.origin, m.created_at,
                  d.status, d.receipt_state,
                  CASE
                    WHEN m.origin = 'user' THEN NULL
                    ELSE COALESCE(
                      d.turn_id,
                      (SELECT ct.id FROM collaboration_turns ct
                       WHERE ct.space_message_id = json_extract(m.envelope_json, '$.reply_to')
                         AND (
                           ct.space_id = m.space_id
                           OR ct.conversation_id = json_extract(m.envelope_json, '$.conversation_id')
                         )
                       ORDER BY ct.created_at DESC LIMIT 1)
                    )
                  END AS resolved_turn_id
           FROM collaboration_space_messages m
           LEFT JOIN collaboration_space_deliveries d
             ON d.space_message_id = m.id
           WHERE m.space_id = ? AND m.seq > ?
           ORDER BY m.seq ASC"#,
    )
    .bind(thread_id)
    .bind(after_seq)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        if let Some(message) = parse_space_dm_row(row) {
            out.push(message);
        }
    }
    Ok(out)
}

/// Fetch at most `limit` latest visible post-cutover DM messages in ascending `seq` order
/// using descending tail-window queries instead of scanning all post-cutover rows from `seq > 0`.
async fn dm_space_messages_tail(
    pool: &SqlitePool,
    thread_id: &str,
    limit: usize,
) -> Result<Vec<DmMessage>, CollaborationError> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let batch_size = (limit.saturating_mul(2).max(64)) as i64;
    let mut before_seq: Option<i64> = None;
    let mut collected_rev = Vec::with_capacity(limit);

    loop {
        let rows = match before_seq {
            Some(upper) => {
                sqlx::query_as::<_, SpaceDmRow>(
                    r#"SELECT m.id, m.seq, m.envelope_json, m.origin, m.created_at,
                              d.status, d.receipt_state,
                              CASE
                                WHEN m.origin = 'user' THEN NULL
                                ELSE COALESCE(
                                  d.turn_id,
                                  (SELECT ct.id FROM collaboration_turns ct
                                   WHERE ct.space_message_id = json_extract(m.envelope_json, '$.reply_to')
                                     AND (
                                       ct.space_id = m.space_id
                                       OR ct.conversation_id = json_extract(m.envelope_json, '$.conversation_id')
                                     )
                                   ORDER BY ct.created_at DESC LIMIT 1)
                                )
                              END AS resolved_turn_id
                       FROM collaboration_space_messages m
                       LEFT JOIN collaboration_space_deliveries d
                         ON d.space_message_id = m.id
                       WHERE m.space_id = ? AND m.seq < ?
                       ORDER BY m.seq DESC
                       LIMIT ?"#,
                )
                .bind(thread_id)
                .bind(upper)
                .bind(batch_size)
                .fetch_all(pool)
                .await
                .map_err(db_err)?
            }
            None => {
                sqlx::query_as::<_, SpaceDmRow>(
                    r#"SELECT m.id, m.seq, m.envelope_json, m.origin, m.created_at,
                              d.status, d.receipt_state,
                              CASE
                                WHEN m.origin = 'user' THEN NULL
                                ELSE COALESCE(
                                  d.turn_id,
                                  (SELECT ct.id FROM collaboration_turns ct
                                   WHERE ct.space_message_id = json_extract(m.envelope_json, '$.reply_to')
                                     AND (
                                       ct.space_id = m.space_id
                                       OR ct.conversation_id = json_extract(m.envelope_json, '$.conversation_id')
                                     )
                                   ORDER BY ct.created_at DESC LIMIT 1)
                                )
                              END AS resolved_turn_id
                       FROM collaboration_space_messages m
                       LEFT JOIN collaboration_space_deliveries d
                         ON d.space_message_id = m.id
                       WHERE m.space_id = ?
                       ORDER BY m.seq DESC
                       LIMIT ?"#,
                )
                .bind(thread_id)
                .bind(batch_size)
                .fetch_all(pool)
                .await
                .map_err(db_err)?
            }
        };

        let fetched_count = rows.len();
        let oldest_seq = rows.last().map(|r| r.1);
        for row in rows {
            if let Some(message) = parse_space_dm_row(row) {
                if collected_rev
                    .last()
                    .is_some_and(|prev: &DmMessage| prev.id == message.id)
                {
                    continue;
                }
                collected_rev.push(message);
                if collected_rev.len() >= limit {
                    break;
                }
            }
        }
        if collected_rev.len() >= limit || fetched_count < batch_size as usize {
            break;
        }
        match oldest_seq {
            Some(seq) if seq > 1 => before_seq = Some(seq),
            _ => break,
        }
    }

    collected_rev.reverse();
    Ok(collected_rev)
}

async fn dm_streaming_draft(
    pool: &SqlitePool,
    conversation_id: Uuid,
    thread_id: &str,
    cutover_seq: i64,
) -> Result<Option<DmMessage>, CollaborationError> {
    let open_turns: Vec<(String, String, String, i64, String, Option<String>)> = sqlx::query_as(
        r#"SELECT t.id, t.space_message_id, m.space_id, m.seq, m.created_at, d.receipt_state
           FROM collaboration_turns t
           JOIN collaboration_space_messages m ON m.id = t.space_message_id
           LEFT JOIN collaboration_space_deliveries d
             ON d.space_message_id = t.space_message_id
            AND d.conversation_id = t.conversation_id
           WHERE (t.space_id = ? OR m.space_id = ?) AND t.conversation_id = ? AND t.state = 'running'
           ORDER BY m.seq ASC, t.created_at ASC"#,
    )
    .bind(thread_id)
    .bind(thread_id)
    .bind(conversation_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    if open_turns.is_empty() {
        return Ok(None);
    }
    let mut chosen_turn_id: Option<String> = None;
    let mut chosen_processing = false;
    let mut trigger_seq = i64::MAX;
    for (tid, trigger_msg_id, origin_space_id, origin_seq, origin_created_at, receipt_state) in
        open_turns
    {
        let resolved_seq = crate::collaboration::resolve_turn_trigger_seq_in_space(
            pool,
            thread_id,
            &origin_space_id,
            &trigger_msg_id,
            origin_seq,
            &origin_created_at,
        )
        .await?;
        trigger_seq = trigger_seq.min(resolved_seq);
        let is_processing = receipt_state.as_deref() == Some("processing");
        if chosen_turn_id.is_none() || is_processing || !chosen_processing {
            chosen_turn_id = Some(tid);
            chosen_processing = chosen_processing || is_processing;
        }
    }
    let Some(turn_id) = chosen_turn_id else {
        return Ok(None);
    };
    let posted_rows: Vec<(i64, String)> = sqlx::query_as(
        r#"SELECT seq, envelope_json FROM collaboration_space_messages
           WHERE space_id = ? AND seq > ? AND origin = 'agent'
           ORDER BY seq ASC"#,
    )
    .bind(thread_id)
    .bind(trigger_seq)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let max_seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(seq), 0) FROM collaboration_space_messages WHERE space_id = ?",
    )
    .bind(thread_id)
    .fetch_one(pool)
    .await
    .map_err(db_err)?;
    let draft_seq = max_seq.max(trigger_seq) + 1;

    let draft_candidate: Option<(u32, String, String)> =
        if let Some(step) = crate::collaboration::space_turn_streaming_step(conversation_id) {
            Some((step.step_index, step.text, step.updated_at))
        } else {
            let mut from_deltas = None;
            if posted_rows.is_empty() {
                let user_sql = format!(
                    r#"SELECT COALESCE(MAX(sequence), 0)
                       FROM conversation_events
                       WHERE conversation_id = ?
                         AND event_kind IN ({DM_USER_EVENT_KINDS})"#
                );
                let latest_user_seq: i64 = sqlx::query_scalar(&user_sql)
                    .bind(conversation_id)
                    .fetch_one(pool)
                    .await
                    .map_err(db_err)?;
                let lower_seq = latest_user_seq.max(cutover_seq);
                let delta_rows = sqlx::query_as::<_, (i64, String, String)>(
                    r#"SELECT sequence, normalized_json, CAST(created_at AS TEXT)
                       FROM conversation_events
                       WHERE conversation_id = ? AND sequence > ?
                         AND event_kind = 'assistant_text_delta'
                       ORDER BY sequence ASC"#,
                )
                .bind(conversation_id)
                .bind(lower_seq)
                .fetch_all(pool)
                .await
                .map_err(db_err)?;
                if !delta_rows.is_empty() {
                    let mut text = String::new();
                    let mut created_at = String::new();
                    for (_seq, raw, ts) in delta_rows {
                        if let Ok(agents::ConversationEvent::AssistantTextDelta {
                            text: delta,
                            ..
                        }) = serde_json::from_str::<agents::ConversationEvent>(&raw)
                        {
                            text.push_str(&delta);
                            created_at = ts;
                        }
                    }
                    if !text.trim().is_empty() {
                        from_deltas = Some((0, text, created_at));
                    }
                }
            }
            if from_deltas.is_some() {
                from_deltas
            } else {
                let _ = crate::ensure_legacy_jsonl_migrated_on_pool(pool, conversation_id).await;
                crate::ConversationProjector::project_turns_summary(pool, conversation_id)
                    .await
                    .ok()
                    .and_then(|turns| {
                        let last_turn = turns.last()?;
                        if last_turn.role != agents::TurnRole::Assistant
                            || last_turn.completed_at.is_some()
                        {
                            return None;
                        }
                        let tool_count = last_turn
                            .blocks
                            .iter()
                            .filter(|block| matches!(block, agents::ContentBlock::ToolUse { .. }))
                            .count() as u32;
                        let last_tool = last_turn.blocks.iter().rposition(|block| {
                            matches!(block, agents::ContentBlock::ToolUse { .. })
                        });
                        let slice = match last_tool {
                            Some(idx) => &last_turn.blocks[idx + 1..],
                            None => &last_turn.blocks[..],
                        };
                        let text = slice
                            .iter()
                            .filter_map(|block| match block {
                                agents::ContentBlock::Text { text } => Some(text.as_str()),
                                _ => None,
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        if text.trim().is_empty() {
                            None
                        } else {
                            Some((tool_count, text, last_turn.timestamp.to_rfc3339()))
                        }
                    })
            }
        };

    let Some((step_index, raw_text, created_at)) = draft_candidate else {
        return Ok(None);
    };
    let nickname = identity_member_name_of_conversation(pool, conversation_id)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let text = crate::collaboration::strip_own_nickname_prefix(raw_text.trim(), &nickname);
    if text.is_empty() || crate::collaboration::is_pass_token(&text) {
        return Ok(None);
    }
    let already_posted_same = posted_rows.iter().any(|(_, raw)| {
        let parsed = crate::collaboration::parse_space_envelope_str(raw);
        crate::collaboration::strip_own_nickname_prefix(parsed.content.trim(), &nickname) == text
    });
    if already_posted_same {
        return Ok(None);
    }
    let id = if step_index == 0 {
        format!("draft:{turn_id}")
    } else {
        format!("draft:{turn_id}:{step_index}")
    };
    Ok(Some(DmMessage {
        id,
        seq: draft_seq,
        origin: "agent".into(),
        text,
        created_at,
        operation_id: None,
        delivered: None,
        cross_chat_sent_to: None,
        cross_chat_received_from: None,
        turn_id: Some(turn_id),
        streaming: Some(true),
    }))
}

async fn list_pre_cutover_dm_messages(
    pool: &SqlitePool,
    conversation_id: Uuid,
    since_seq: Option<i64>,
    limit: usize,
    cutover_seq: Option<i64>,
) -> Result<Vec<DmMessage>, CollaborationError> {
    if cutover_seq == Some(0) {
        return Ok(Vec::new());
    }
    let cutover_upper = cutover_seq.map(|seq| seq.saturating_add(1));
    match since_seq {
        Some(since) => {
            if let Some(c_seq) = cutover_seq
                && since >= c_seq
            {
                return Ok(Vec::new());
            }
            let user_event_offset = (limit.saturating_mul(4).saturating_add(4)) as i64;
            let upper_sql = format!(
                r#"SELECT sequence
                   FROM conversation_events
                   WHERE conversation_id = ? AND sequence > ?
                     AND event_kind IN ({DM_USER_EVENT_KINDS})
                   ORDER BY sequence ASC
                   LIMIT 1 OFFSET ?"#
            );
            let mut upper_seq = sqlx::query_scalar::<_, i64>(&upper_sql)
                .bind(conversation_id)
                .bind(since)
                .bind(user_event_offset)
                .fetch_optional(pool)
                .await
                .map_err(db_err)?;
            if let Some(c_upper) = cutover_upper {
                upper_seq = Some(match upper_seq {
                    Some(u) => u.min(c_upper),
                    None => c_upper,
                });
            }
            let mut messages = grouped_dm_rows(
                pool,
                conversation_id,
                dm_rows_since(pool, conversation_id, since, upper_seq).await?,
            )
            .await?;
            messages.retain(|message| {
                message.seq > since && cutover_seq.is_none_or(|c_seq| message.seq <= c_seq)
            });
            if messages.len() < limit && upper_seq != cutover_upper {
                messages = grouped_dm_rows(
                    pool,
                    conversation_id,
                    dm_rows_since(pool, conversation_id, since, cutover_upper).await?,
                )
                .await?;
                messages.retain(|message| {
                    message.seq > since && cutover_seq.is_none_or(|c_seq| message.seq <= c_seq)
                });
            }
            messages.truncate(limit);
            Ok(messages)
        }
        None => {
            let start_seq =
                dm_tail_window_start_seq(pool, conversation_id, limit, cutover_seq).await?;
            let mut messages = grouped_dm_rows(
                pool,
                conversation_id,
                dm_rows_since(pool, conversation_id, start_seq, cutover_upper).await?,
            )
            .await?;
            if let Some(c_seq) = cutover_seq {
                messages.retain(|message| message.seq <= c_seq);
            }
            if messages.len() < limit && start_seq > 0 {
                messages = grouped_dm_rows(
                    pool,
                    conversation_id,
                    dm_rows_since(pool, conversation_id, 0, cutover_upper).await?,
                )
                .await?;
                if let Some(c_seq) = cutover_seq {
                    messages.retain(|message| message.seq <= c_seq);
                }
            }
            let skip = messages.len().saturating_sub(limit);
            Ok(messages.into_iter().skip(skip).collect())
        }
    }
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
    let thread_id = conversation_thread_id(pool, conversation_id).await?;
    let cutover_seq = dm_cutover_info(pool, conversation_id, &thread_id).await?;

    let Some(cutover_seq) = cutover_seq else {
        return list_pre_cutover_dm_messages(pool, conversation_id, since_seq, limit, None).await;
    };

    let (mut pre, post) = match since_seq {
        Some(since) => {
            let mut pre = list_pre_cutover_dm_messages(
                pool,
                conversation_id,
                Some(since),
                limit,
                Some(cutover_seq),
            )
            .await?;
            let post = dm_space_messages_since(pool, &thread_id, since).await?;
            if pre.is_empty() && post.is_empty() && cutover_seq == 0 {
                pre = list_pre_cutover_dm_messages(pool, conversation_id, Some(since), limit, None)
                    .await?;
            }
            (pre, post)
        }
        None => {
            let post = dm_space_messages_tail(pool, &thread_id, limit).await?;
            let mut pre = if post.len() >= limit {
                Vec::new()
            } else {
                let pre_limit = limit
                    .saturating_sub(post.len())
                    .saturating_add(2)
                    .min(limit);
                list_pre_cutover_dm_messages(
                    pool,
                    conversation_id,
                    None,
                    pre_limit,
                    Some(cutover_seq),
                )
                .await?
            };
            if pre.is_empty() && post.is_empty() && cutover_seq == 0 {
                pre =
                    list_pre_cutover_dm_messages(pool, conversation_id, None, limit, None).await?;
            }
            (pre, post)
        }
    };
    let post_keys: HashSet<(String, String)> = post
        .iter()
        .map(|message| (message.origin.clone(), normalize_dm_text(&message.text)))
        .collect();
    pre.retain(|message| {
        !post_keys.contains(&(message.origin.clone(), normalize_dm_text(&message.text)))
    });
    pre.extend(post);
    if let Some(draft) = dm_streaming_draft(pool, conversation_id, &thread_id, cutover_seq).await? {
        let draft_key = (draft.origin.clone(), normalize_dm_text(&draft.text));
        if !pre
            .iter()
            .any(|message| (message.origin.clone(), normalize_dm_text(&message.text)) == draft_key)
        {
            pre.push(draft);
        }
    }
    match since_seq {
        Some(_) => {
            pre.truncate(limit);
            Ok(pre)
        }
        None => {
            let skip = pre.len().saturating_sub(limit);
            Ok(pre.into_iter().skip(skip).collect())
        }
    }
}

/// Assemble the last visible DM message by locating the latest user-turn
/// boundary and reading only the trailing turn's events.
async fn dm_last_message(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<SidebarLastMessage>, CollaborationError> {
    let thread_id = conversation_thread_id(pool, conversation_id).await?;
    if dm_cutover_info(pool, conversation_id, &thread_id)
        .await?
        .is_some()
    {
        let post = dm_space_messages_tail(pool, &thread_id, 1).await?;
        if let Some(last) = last_previewable_dm(post) {
            return Ok(Some(sidebar_last_from_dm(last)));
        }
    }

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

mod groups;
#[cfg(test)]
mod tests;

pub use self::groups::*;
