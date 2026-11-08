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
    let open_turn: Option<(String, String, String, i64, String)> = sqlx::query_as(
        r#"SELECT t.id, t.space_message_id, m.space_id, m.seq, m.created_at
           FROM collaboration_turns t
           JOIN collaboration_space_messages m ON m.id = t.space_message_id
           WHERE (t.space_id = ? OR m.space_id = ?) AND t.conversation_id = ? AND t.state = 'running'
           ORDER BY t.created_at DESC, m.seq DESC
           LIMIT 1"#,
    )
    .bind(thread_id)
    .bind(thread_id)
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db_err)?;
    let Some((turn_id, trigger_msg_id, origin_space_id, origin_seq, origin_created_at)) = open_turn
    else {
        return Ok(None);
    };
    let trigger_seq = crate::collaboration::resolve_turn_trigger_seq_in_space(
        pool,
        thread_id,
        &origin_space_id,
        &trigger_msg_id,
        origin_seq,
        &origin_created_at,
    )
    .await?;
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
                crate::jsonl_history::load_all_turns(pool, conversation_id)
                    .await
                    .ok()
                    .flatten()
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
    if dm_cutover_info(pool, conversation_id, thread_id)
        .await?
        .is_some()
    {
        let space_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(thread_id)
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
        if space_count > 0 {
            let unread: i64 = sqlx::query_scalar(
                r#"SELECT COUNT(*)
                   FROM collaboration_space_messages
                   WHERE space_id = ? AND seq > ? AND origin = 'agent'"#,
            )
            .bind(thread_id)
            .bind(read)
            .fetch_one(pool)
            .await
            .map_err(db_err)?;
            return Ok(unread);
        }
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
    i64,
);

async fn workspace_thread_members(
    pool: &SqlitePool,
    workspace_id: &str,
) -> Result<HashMap<String, Vec<SidebarMember>>, CollaborationError> {
    let rows = sqlx::query_as::<_, ThreadMemberJoinRow>(
        r#"SELECT tm.thread_id, m.id, m.name, m.avatar, m.color, tm.conversation_id, m.agent, m.is_supervisor
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
    for (thread_id, member_id, name, avatar, color, conversation_id, agent, is_supervisor) in rows {
        by_thread.entry(thread_id).or_default().push(SidebarMember {
            member_id,
            name,
            avatar,
            color,
            conversation_id,
            agent,
            is_supervisor: is_supervisor != 0,
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
    items.sort_by_cached_key(|item| {
        (
            std::cmp::Reverse(normalize(&item.last_activity_at)),
            item.thread_id.clone(),
        )
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
    let mut conn = pool.acquire().await.map_err(db_err)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db_err)?;
    let res = async {
        let updated = sqlx::query("UPDATE collaboration_spaces SET tag_color = ? WHERE id = ?")
            .bind(tag_color)
            .bind(space_id)
            .execute(&mut *conn)
            .await
            .map_err(db_err)?;
        if updated.rows_affected() == 0 {
            return Err(CollaborationError::new("not_found", "space was not found"));
        }
        append_space_event_tx(
            &mut conn,
            space_id,
            "space",
            None,
            &json!({
                "action": "tag_color_updated",
                "tag_color": tag_color,
            }),
            &now_stamp(),
        )
        .await
        .map_err(db_err)?;
        Ok::<(), CollaborationError>(())
    }
    .await;
    match res {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
            Ok(())
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(err)
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MemberSummary {
    pub member_id: String,
    pub name: String,
    pub avatar: Option<String>,
    pub color: Option<String>,
    pub agent: Option<String>,
    pub role_id: Option<String>,
    pub is_supervisor: bool,
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
        i64,
    );
    let workspace_str = workspace_id.to_string();
    let rows = sqlx::query_as::<_, Row>(
        r#"SELECT DISTINCT m.id, m.name, m.avatar, m.color, m.agent, m.role_id, m.is_supervisor
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
    for (member_id, name, avatar, color, agent, role_id, is_supervisor) in rows {
        let thread_ids = threads_by_member.remove(&member_id).unwrap_or_default();
        out.push(MemberSummary {
            direct_thread_id: identity::direct_thread_id(&member_id),
            member_id,
            name,
            avatar,
            color,
            agent,
            role_id,
            is_supervisor: is_supervisor != 0,
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
    let mut conn = pool.acquire().await.map_err(db_err)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db_err)?;
    let res = async {
        let exists: Option<String> =
            sqlx::query_scalar("SELECT id FROM collaboration_members WHERE id = ?")
                .bind(member_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db_err)?;
        if exists.is_none() {
            return Err(CollaborationError::new("not_found", "member was not found"));
        }
        if let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) {
            sqlx::query("UPDATE collaboration_members SET name = ? WHERE id = ?")
                .bind(name)
                .bind(member_id)
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
            let direct_tid = identity::direct_thread_id(member_id);
            sqlx::query("UPDATE collaboration_threads SET title = ? WHERE id = ?")
                .bind(name)
                .bind(&direct_tid)
                .execute(&mut *conn)
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
            .execute(&mut *conn)
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
            .execute(&mut *conn)
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
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
        }
        if let Some(color) = color {
            sqlx::query("UPDATE collaboration_members SET color = ? WHERE id = ?")
                .bind(blank(color))
                .bind(member_id)
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
        }
        let threads: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT thread_id FROM collaboration_thread_members WHERE member_id = ? AND status = 'active'",
        )
        .bind(member_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(db_err)?;
        let now = now_stamp();
        let payload = json!({
            "action": "member_updated",
            "member_id": member_id,
            "name": name,
        });
        for tid in threads {
            append_space_event_tx(&mut conn, &tid, "roster", None, &payload, &now)
                .await
                .map_err(db_err)?;
        }
        Ok::<(), CollaborationError>(())
    }
    .await;
    match res {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
            Ok(())
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(err)
        }
    }
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

/// Batch lookup `(identity_member_id, is_supervisor, avatar, color)` keyed by `conversation_id`.
pub async fn identity_members_for_conversations_batch(
    pool: &SqlitePool,
    conversation_ids: &[String],
) -> Result<HashMap<String, (String, bool, Option<String>, Option<String>)>, CollaborationError> {
    let mut unique: Vec<&str> = Vec::new();
    for cid in conversation_ids {
        let trimmed = cid.trim();
        if !trimmed.is_empty() && !unique.contains(&trimmed) {
            unique.push(trimmed);
        }
    }
    if unique.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = std::iter::repeat_n("?", unique.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        r#"SELECT tm.conversation_id, tm.member_id, COALESCE(m.is_supervisor, 0), m.avatar, m.color
           FROM collaboration_thread_members tm
           LEFT JOIN collaboration_members m ON m.id = tm.member_id
           WHERE tm.conversation_id IN ({placeholders})
           ORDER BY CASE WHEN tm.status = 'active' THEN 0 ELSE 1 END"#
    );
    let mut query =
        sqlx::query_as::<_, (Option<String>, String, i64, Option<String>, Option<String>)>(&sql);
    for cid in &unique {
        query = query.bind(*cid);
    }
    let rows = query.fetch_all(pool).await.map_err(db_err)?;
    let mut out = HashMap::with_capacity(rows.len());
    for (conv_id, member_id, is_sup, avatar, color) in rows {
        if let Some(cid) = conv_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            out.entry(cid)
                .or_insert((member_id, is_sup != 0, avatar, color));
        }
    }

    let mut derived_to_conv: Vec<(String, String)> = Vec::new();
    for cid in &unique {
        if !out.contains_key(*cid)
            && let Ok(uuid) = Uuid::parse_str(cid)
        {
            derived_to_conv.push((
                identity::member_id_for_conversation(uuid),
                (*cid).to_string(),
            ));
        }
    }
    if !derived_to_conv.is_empty() {
        let derived_placeholders = std::iter::repeat_n("?", derived_to_conv.len())
            .collect::<Vec<_>>()
            .join(", ");
        let derived_sql = format!(
            "SELECT id, is_supervisor, avatar, color FROM collaboration_members WHERE id IN ({derived_placeholders})"
        );
        let mut derived_query =
            sqlx::query_as::<_, (String, i64, Option<String>, Option<String>)>(&derived_sql);
        for (mid, _) in &derived_to_conv {
            derived_query = derived_query.bind(mid);
        }
        let derived_rows = derived_query.fetch_all(pool).await.map_err(db_err)?;
        let derived_map: HashMap<String, (bool, Option<String>, Option<String>)> = derived_rows
            .into_iter()
            .map(|(id, sup, avatar, color)| (id, (sup != 0, avatar, color)))
            .collect();
        for (mid, cid) in derived_to_conv {
            if let Some((is_sup, avatar, color)) = derived_map.get(&mid) {
                out.entry(cid)
                    .or_insert((mid, *is_sup, avatar.clone(), color.clone()));
            }
        }
    }
    Ok(out)
}

/// Enrich `MemberRecord` items in batch with resolved group `conversation_id`,
/// `identity_member_id`, `is_supervisor`, `avatar`, and `color` in O(1) SQL queries for initialized group spaces.
pub async fn enrich_space_members_batch(
    pool: &SqlitePool,
    space_id: &str,
    mut members: Vec<crate::collaboration::MemberRecord>,
) -> Result<Vec<serde_json::Value>, CollaborationError> {
    if members.is_empty() {
        return Ok(Vec::new());
    }
    let is_group_space = !space_id.starts_with("unassigned:") && !space_id.starts_with("direct:");
    let mut identity_by_conv: HashMap<String, (String, bool, Option<String>, Option<String>)> =
        HashMap::new();

    if is_group_space {
        let bound_rows =
            sqlx::query_as::<_, (Option<String>, String, i64, Option<String>, Option<String>)>(
                r#"SELECT tm.conversation_id, tm.member_id, COALESCE(m.is_supervisor, 0), m.avatar, m.color
                   FROM collaboration_thread_members tm
                   JOIN collaboration_threads t ON t.id = tm.thread_id
                   LEFT JOIN collaboration_members m ON m.id = tm.member_id
                   WHERE tm.thread_id = ? AND tm.conversation_id IS NOT NULL"#,
            )
            .bind(space_id)
            .fetch_all(pool)
            .await
            .map_err(db_err)?;

        for (conv_id, identity_id, is_sup, avatar, color) in bound_rows {
            if let Some(cid) = conv_id
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            {
                identity_by_conv
                    .entry(cid)
                    .or_insert((identity_id, is_sup != 0, avatar, color));
            }
        }

        for member in &mut members {
            if member.kind != "agent" {
                continue;
            }
            let already_bound = member
                .conversation_id
                .as_deref()
                .map(str::trim)
                .is_some_and(|cid| identity_by_conv.contains_key(cid));
            if !already_bound
                && let Ok(resolved) =
                    crate::collaboration::resolve_thread_session(pool, &member.member_id, space_id)
                        .await
            {
                member.conversation_id = Some(resolved.to_string());
            }
        }
    }

    let unresolved_convs: Vec<String> = members
        .iter()
        .filter_map(|m| m.conversation_id.as_deref())
        .map(str::trim)
        .filter(|cid| !cid.is_empty() && !identity_by_conv.contains_key(*cid))
        .map(str::to_string)
        .collect();

    if !unresolved_convs.is_empty() {
        let extra = identity_members_for_conversations_batch(pool, &unresolved_convs).await?;
        for (cid, info) in extra {
            identity_by_conv.entry(cid).or_insert(info);
        }
    }

    let mut listed = Vec::with_capacity(members.len());
    for member in members {
        let (identity_member_id, is_supervisor, avatar, color) = member
            .conversation_id
            .as_deref()
            .map(str::trim)
            .and_then(|cid| identity_by_conv.get(cid))
            .map(|(mid, sup, av, col)| (Some(mid.clone()), *sup, av.clone(), col.clone()))
            .unwrap_or((None, false, None, None));
        let mut value = serde_json::to_value(&member).map_err(|error| {
            CollaborationError::new("conversation_control_failed", error.to_string())
        })?;
        if let Some(object) = value.as_object_mut() {
            object.insert("identity_member_id".into(), json!(identity_member_id));
            object.insert("is_supervisor".into(), json!(is_supervisor));
            if let Some(av) = avatar {
                object.insert("avatar".into(), json!(av));
            }
            if let Some(col) = color {
                object.insert("color".into(), json!(col));
            }
        }
        listed.push(value);
    }
    Ok(listed)
}

/// Display name of the identity member behind a seat conversation.
pub async fn identity_member_name_of_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<String>, CollaborationError> {
    sqlx::query_scalar(
        r#"SELECT m.name
           FROM collaboration_members m
           JOIN collaboration_thread_members tm ON tm.member_id = m.id
           WHERE tm.conversation_id = ? AND tm.status = 'active'
           LIMIT 1"#,
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db_err)
}

/// Returns `(member_id, name)` of the active supervisor bot in `workspace_id`, if any.
pub async fn workspace_supervisor_member(
    pool: &SqlitePool,
    workspace_id: Uuid,
) -> Result<Option<(String, String)>, CollaborationError> {
    sqlx::query_as::<_, (String, String)>(
        r#"SELECT m.id, m.name
           FROM collaboration_members m
           JOIN collaboration_thread_members tm ON tm.member_id = m.id AND tm.status = 'active'
           JOIN collaboration_threads t ON t.id = tm.thread_id
           WHERE t.workspace_id = ? AND m.is_supervisor != 0
           ORDER BY m.created_at, m.id
           LIMIT 1"#,
    )
    .bind(workspace_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db_err)
}

/// Assign, replace, or clear (`None` / `Some("")`) the supervisor bot for `workspace_id`.
/// `member_ref` may be a `collaboration_members.id`, `direct:<member_id>`, or a session `conversation_id`.
/// Returns the new supervisor `member_id` (or `None` when cleared).
pub async fn set_workspace_supervisor(
    pool: &SqlitePool,
    workspace_id: Uuid,
    member_ref: Option<&str>,
) -> Result<Option<String>, CollaborationError> {
    let workspace_str = workspace_id.to_string();
    let target_member_id = match member_ref.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let stripped = raw.strip_prefix(identity::DIRECT_PREFIX).unwrap_or(raw);
            let direct_match: Option<String> = sqlx::query_scalar(
                r#"SELECT m.id
                   FROM collaboration_members m
                   JOIN collaboration_thread_members tm ON tm.member_id = m.id AND tm.status = 'active'
                   JOIN collaboration_threads t ON t.id = tm.thread_id
                   WHERE t.workspace_id = ?1
                     AND (m.id = ?2 OR tm.conversation_id = ?2 OR LOWER(TRIM(m.name)) = LOWER(?2))
                   ORDER BY CASE
                     WHEN m.id = ?2 THEN 0
                     WHEN tm.conversation_id = ?2 THEN 1
                     ELSE 2
                   END
                   LIMIT 1"#,
            )
            .bind(&workspace_str)
            .bind(stripped)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
            let resolved = match direct_match {
                Some(id) => Some(id),
                None => {
                    let fallback_conv: Option<(Option<String>, String)> = sqlx::query_as(
                        r#"SELECT sm.conversation_id, sm.nickname
                           FROM collaboration_space_members sm
                           JOIN collaboration_spaces s ON s.id = sm.space_id
                           WHERE s.workspace_id = ?1
                             AND sm.kind = 'agent'
                             AND (sm.id = ?2 OR sm.conversation_id = ?2 OR LOWER(TRIM(sm.nickname)) = LOWER(?2))
                           ORDER BY CASE
                             WHEN sm.id = ?2 THEN 0
                             WHEN sm.conversation_id = ?2 THEN 1
                             ELSE 2
                           END
                           LIMIT 1"#,
                    )
                    .bind(&workspace_str)
                    .bind(stripped)
                    .fetch_optional(pool)
                    .await
                    .map_err(db_err)?;
                    if let Some((Some(conv_raw), nickname)) = fallback_conv
                        && let Ok(conv_id) = Uuid::parse_str(conv_raw.trim())
                    {
                        Some(
                            identity::ensure_member_for_conversation(
                                pool,
                                conv_id,
                                Some(&nickname),
                            )
                            .await
                            .map_err(|e| {
                                CollaborationError::new(
                                    "conversation_control_failed",
                                    e.to_string(),
                                )
                            })?,
                        )
                    } else {
                        None
                    }
                }
            };
            let Some(resolved) = resolved else {
                return Err(CollaborationError::new(
                    "not_found",
                    "member was not found in this workspace",
                ));
            };
            Some(resolved)
        }
        None => None,
    };

    let mut conn = pool.acquire().await.map_err(db_err)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db_err)?;
    let res = async {
        sqlx::query(
            r#"UPDATE collaboration_members
               SET is_supervisor = 0
               WHERE is_supervisor != 0
                 AND id IN (
                   SELECT DISTINCT tm.member_id
                   FROM collaboration_thread_members tm
                   JOIN collaboration_threads t ON t.id = tm.thread_id
                   WHERE t.workspace_id = ?
                 )"#,
        )
        .bind(&workspace_str)
        .execute(&mut *conn)
        .await
        .map_err(db_err)?;
        if let Some(ref mid) = target_member_id {
            sqlx::query("UPDATE collaboration_members SET is_supervisor = 1 WHERE id = ?")
                .bind(mid)
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
        }
        Ok::<Option<String>, CollaborationError>(target_member_id)
    }
    .await;
    match res {
        Ok(out) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(db_err)?;
            Ok(out)
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(err)
        }
    }
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

fn input_optional_text(input: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| input.get(*key).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn input_required_text(
    input: &serde_json::Value,
    keys: &[&str],
) -> Result<String, CollaborationError> {
    let field = keys.first().copied().unwrap_or("value");
    input_optional_text(input, keys)
        .ok_or_else(|| CollaborationError::new("invalid_input", format!("{field} is required")))
}

fn input_required_uuid(
    input: &serde_json::Value,
    keys: &[&str],
) -> Result<Uuid, CollaborationError> {
    let raw = input_required_text(input, keys)?;
    let field = keys.first().copied().unwrap_or("id");
    Uuid::parse_str(&raw)
        .map_err(|err| CollaborationError::new("invalid_input", format!("invalid {field}: {err}")))
}

/// Execute a sidebar / contactGroup / member list host operation and return `(payload, changed_space_id)`.
pub async fn execute_sidebar_op(
    pool: &SqlitePool,
    op: &str,
    input: &serde_json::Value,
) -> Result<(serde_json::Value, Option<String>), CollaborationError> {
    match op {
        "contactGroup.list" => {
            let workspace_id = input_required_uuid(input, &["workspaceId", "workspace_id"])?;
            let groups = list_contact_groups(pool, workspace_id).await?;
            Ok((serde_json::json!({ "groups": groups }), None))
        }
        "contactGroup.create" => {
            let workspace_id = input_required_uuid(input, &["workspaceId", "workspace_id"])?;
            let name = input_required_text(input, &["name"])?;
            let group = create_contact_group(pool, workspace_id, &name).await?;
            Ok((serde_json::json!({ "group": group }), None))
        }
        "contactGroup.rename" => {
            let group_id = input_required_text(input, &["groupId", "group_id"])?;
            let name = input_required_text(input, &["name"])?;
            let group = rename_contact_group(pool, &group_id, &name).await?;
            Ok((serde_json::json!({ "group": group }), None))
        }
        "contactGroup.delete" => {
            let group_id = input_required_text(input, &["groupId", "group_id"])?;
            let ungrouped = delete_contact_group(pool, &group_id).await?;
            Ok((
                serde_json::json!({ "groupId": group_id, "deleted": true, "ungroupedThreadIds": ungrouped }),
                None,
            ))
        }
        "contactGroup.reorder" => {
            let workspace_id = input_required_uuid(input, &["workspaceId", "workspace_id"])?;
            let group_ids = input
                .get("groupIds")
                .or_else(|| input.get("group_ids"))
                .and_then(serde_json::Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .ok_or_else(|| CollaborationError::new("invalid_input", "groupIds is required"))?;
            let groups = reorder_contact_groups(pool, workspace_id, &group_ids).await?;
            Ok((serde_json::json!({ "groups": groups }), None))
        }
        "thread.setGroup" => {
            let thread_id = input_required_text(input, &["threadId", "thread_id"])?;
            let group_id = input_optional_text(input, &["groupId", "group_id"]);
            set_thread_contact_group(pool, &thread_id, group_id.as_deref()).await?;
            Ok((
                serde_json::json!({ "threadId": thread_id, "groupId": group_id }),
                None,
            ))
        }
        "thread.listSidebar" => {
            let workspace_id = input_required_uuid(input, &["workspaceId", "workspace_id"])?;
            let items = list_sidebar(pool, workspace_id).await?;
            Ok((serde_json::json!({ "items": items }), None))
        }
        "thread.markRead" => {
            let thread_id =
                input_required_text(input, &["threadId", "thread_id", "spaceId", "space_id"])?;
            let seq = input.get("seq").and_then(serde_json::Value::as_i64);
            let last_read_seq = mark_thread_read(pool, &thread_id, seq).await?;
            Ok((
                serde_json::json!({ "threadId": thread_id, "lastReadSeq": last_read_seq }),
                None,
            ))
        }
        "thread.markUnread" => {
            let thread_id =
                input_required_text(input, &["threadId", "thread_id", "spaceId", "space_id"])?;
            let last_read_seq = mark_thread_unread(pool, &thread_id).await?;
            Ok((
                serde_json::json!({ "threadId": thread_id, "lastReadSeq": last_read_seq }),
                None,
            ))
        }
        "thread.update" => {
            let space_id =
                input_required_text(input, &["threadId", "thread_id", "spaceId", "space_id"])?;
            let tag_color = input_optional_text(input, &["tagColor", "tag_color"]);
            set_space_tag_color(pool, &space_id, tag_color.as_deref()).await?;
            Ok((
                serde_json::json!({ "threadId": space_id, "tagColor": tag_color }),
                Some(space_id),
            ))
        }
        "member.list" => {
            let workspace_id = input_required_uuid(input, &["workspaceId", "workspace_id"])?;
            let members = list_members(pool, workspace_id).await?;
            Ok((serde_json::json!({ "members": members }), None))
        }
        _ => Err(CollaborationError::new(
            "invalid_input",
            format!("unknown sidebar op: {op}"),
        )),
    }
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

    #[tokio::test]
    async fn dm_streaming_draft_streams_live_step_and_continues_after_mid_turn_tool_step() {
        let pool = crate::collaboration::test_support::setup_pool().await;
        let workspace = Uuid::new_v4();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspaces (id, task_id, branch) VALUES (?, ?, 'main')")
            .bind(workspace)
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();
        let created = crate::collaboration::host_create_space_member(
            &pool,
            crate::collaboration::HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "Lander".to_string(),
                role_id: None,
                agent_id: Some("codex".to_string()),
                team_id: None,
                persona_prompt: Some("主管 Bot".to_string()),
                mode_id: None,
                config_values: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let conversation_id = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
        let member_id = identity_member_of_conversation(&pool, &conversation_id.to_string())
            .await
            .unwrap()
            .unwrap();
        let thread_id = format!("direct:{member_id}");

        crate::collaboration::post_direct_message(
            &pool,
            crate::collaboration::PostDirectMessage {
                thread_id: thread_id.clone(),
                content: "创建一个新Bot，名叫Hailer，帮我做邮件管理".to_string(),
                summary: None,
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();

        // Step 0 streaming before tool call:
        crate::collaboration::reset_space_turn_streaming_step(conversation_id);
        crate::collaboration::append_space_turn_streaming_text(
            conversation_id,
            "我先查看一下 vibex-bot 规范和 manage_bot 工具参数",
            false,
        );
        crate::collaboration::append_space_turn_streaming_text(
            conversation_id,
            "，接着为你创建专门负责邮件管理的 Bot「Hailer」。",
            false,
        );

        let messages_step0 = list_dm_messages(&pool, conversation_id, None, Some(50))
            .await
            .unwrap();
        assert_eq!(messages_step0.len(), 2);
        assert_eq!(messages_step0[1].streaming, Some(true));
        assert_eq!(
            messages_step0[1].text,
            "我先查看一下 vibex-bot 规范和 manage_bot 工具参数，接着为你创建专门负责邮件管理的 Bot「Hailer」。"
        );
        assert!(messages_step0[1].seq > messages_step0[0].seq);

        // ToolCallUpsert bubbles mid-turn step 0 and advances streaming step to step 1:
        let step0_text = messages_step0[1].text.clone();
        crate::collaboration::advance_space_turn_streaming_step(conversation_id);
        crate::collaboration::on_space_turn_tool_call(
            &pool,
            conversation_id,
            &step0_text,
            &crate::collaboration::DeliveryContext::default(),
        )
        .await
        .unwrap();

        let messages_after_tool = list_dm_messages(&pool, conversation_id, None, Some(50))
            .await
            .unwrap();
        assert_eq!(messages_after_tool.len(), 2);
        assert_eq!(messages_after_tool[1].streaming, None);
        assert_eq!(messages_after_tool[1].text, step0_text);

        // Step 1 streaming after tool call:
        crate::collaboration::append_space_turn_streaming_text(
            conversation_id,
            "已经为你创建好负责邮件管理的 Bot「Hailer」了！",
            false,
        );
        let messages_step1 = list_dm_messages(&pool, conversation_id, None, Some(50))
            .await
            .unwrap();
        assert_eq!(
            messages_step1.len(),
            3,
            "both mid-turn persisted bubble and step 1 streaming draft must be returned"
        );
        assert_eq!(messages_step1[1].streaming, None);
        assert_eq!(messages_step1[1].text, step0_text);
        assert_eq!(messages_step1[2].streaming, Some(true));
        assert_eq!(
            messages_step1[2].text,
            "已经为你创建好负责邮件管理的 Bot「Hailer」了！"
        );
        assert!(messages_step1[2].id.ends_with(":1"));

        crate::collaboration::reset_space_turn_streaming_step(conversation_id);
    }

    #[tokio::test]
    async fn enrich_space_members_batch_resolves_group_seats_and_supervisor_in_batch() {
        let pool = crate::collaboration::test_support::setup_pool().await;
        let workspace = Uuid::new_v4();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspaces (id, task_id, branch) VALUES (?, ?, 'main')")
            .bind(workspace)
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();

        let space = crate::collaboration::create_workspace_space(
            &pool,
            workspace,
            "Perf Group",
            Uuid::new_v4(),
        )
        .await
        .unwrap();

        let bot_a = crate::collaboration::host_create_space_member(
            &pool,
            crate::collaboration::HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: Some(space.space_id.clone()),
                nickname: "Alpha".to_string(),
                role_id: None,
                agent_id: Some("codex".to_string()),
                team_id: None,
                persona_prompt: None,
                mode_id: None,
                config_values: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let bot_b = crate::collaboration::host_create_space_member(
            &pool,
            crate::collaboration::HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: Some(space.space_id.clone()),
                nickname: "Beta".to_string(),
                role_id: None,
                agent_id: Some("claude_code".to_string()),
                team_id: None,
                persona_prompt: None,
                mode_id: None,
                config_values: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();

        set_workspace_supervisor(&pool, workspace, bot_a.conversation_id.as_deref())
            .await
            .unwrap();

        let raw_members = crate::collaboration::list_space_members(
            &pool,
            &space.space_id,
            crate::collaboration::MessageAudience::User,
        )
        .await
        .unwrap();
        let enriched_first = enrich_space_members_batch(&pool, &space.space_id, raw_members)
            .await
            .unwrap();

        let raw_members_again = crate::collaboration::list_space_members(
            &pool,
            &space.space_id,
            crate::collaboration::MessageAudience::User,
        )
        .await
        .unwrap();
        let enriched_second = enrich_space_members_batch(&pool, &space.space_id, raw_members_again)
            .await
            .unwrap();
        assert_eq!(enriched_first, enriched_second);

        let alpha = enriched_second
            .iter()
            .find(|v| v.get("nickname").and_then(|s| s.as_str()) == Some("Alpha"))
            .expect("Alpha member");
        let beta = enriched_second
            .iter()
            .find(|v| v.get("nickname").and_then(|s| s.as_str()) == Some("Beta"))
            .expect("Beta member");
        assert!(
            alpha
                .get("identity_member_id")
                .and_then(|v| v.as_str())
                .is_some()
        );
        assert_eq!(
            alpha.get("is_supervisor").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(
            beta.get("identity_member_id")
                .and_then(|v| v.as_str())
                .is_some()
        );
        assert_eq!(
            beta.get("is_supervisor").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_ne!(
            alpha.get("identity_member_id"),
            beta.get("identity_member_id")
        );
        let _ = bot_b;
    }

    #[tokio::test]
    async fn dm_post_cutover_tail_window_truncates_and_merges_with_pre_cutover() {
        let pool = setup_test_pool().await;
        let workspace = Uuid::new_v4();
        let conversation = Uuid::new_v4();
        let thread_id = seed_dm_session(&pool, workspace, conversation, "Bot").await;

        let mut seq = 0_i64;
        for turn in 1..=3 {
            seq += 1;
            let user_json = serde_json::to_string(&ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: format!("pre user {turn}"),
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
            .bind(format!("2026-10-24T00:0{turn}:00.000Z"))
            .execute(&pool)
            .await
            .unwrap();

            seq += 1;
            let delta_json = serde_json::to_string(&ConversationEvent::AssistantTextDelta {
                text: format!("pre reply {turn}"),
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
            .bind(format!("2026-10-24T00:0{turn}:30.000Z"))
            .execute(&pool)
            .await
            .unwrap();
        }

        // Cutover at seq = 6, then insert 4 post-cutover space messages (seq 7..=10).
        sqlx::query(
            "UPDATE collaboration_threads SET space_cutover_seq = ?, space_cutover_at = '2026-10-24T00:04:00.000Z' WHERE id = ?",
        )
        .bind(seq)
        .bind(&thread_id)
        .execute(&pool)
        .await
        .unwrap();

        for idx in 1..=4 {
            let post_seq = seq + idx;
            let origin = if idx % 2 == 1 { "user" } else { "agent" };
            let msg_id = Uuid::new_v4().to_string();
            let envelope = json!({
                "content": format!("post msg {idx}"),
                "sender": if origin == "user" { "Person" } else { "Bot" },
            });
            sqlx::query(
                r#"INSERT INTO collaboration_space_messages
                   (id, space_id, seq, envelope_json, created_at, origin, root_id, hop)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 0)"#,
            )
            .bind(&msg_id)
            .bind(&thread_id)
            .bind(post_seq)
            .bind(envelope.to_string())
            .bind(format!("2026-10-24T00:1{idx}:00.000Z"))
            .bind(origin)
            .bind(&msg_id)
            .execute(&pool)
            .await
            .unwrap();
        }

        // Case 1: limit = 3 (smaller than post-cutover count 4) -> only tail 3 post-cutover messages returned.
        let tail_three = list_dm_messages(&pool, conversation, None, Some(3))
            .await
            .unwrap();
        assert_eq!(tail_three.len(), 3);
        assert_eq!(tail_three[0].text, "post msg 2");
        assert_eq!(tail_three[1].text, "post msg 3");
        assert_eq!(tail_three[2].text, "post msg 4");

        // Case 2: limit = 6 (spans 2 pre-cutover + 4 post-cutover messages).
        let tail_six = list_dm_messages(&pool, conversation, None, Some(6))
            .await
            .unwrap();
        assert_eq!(tail_six.len(), 6);
        assert_eq!(tail_six[0].text, "pre user 3");
        assert_eq!(tail_six[1].text, "pre reply 3");
        assert_eq!(tail_six[2].text, "post msg 1");
        assert_eq!(tail_six[5].text, "post msg 4");
    }
}
