use agents::CollaborationSpaceOrigin;
use chrono::{Duration, Utc};
use db::models::collaboration_identity::{self as identity};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendReceipt {
    pub delivered: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delayed_input_id: Option<String>,
    #[serde(default, skip_serializing_if = "super::is_false")]
    pub idempotent_replay: bool,
}

#[derive(Debug, Clone)]
pub struct SendSessionInput {
    pub caller_id: Uuid,
    pub conversation_id: Uuid,
    pub operation_id: Uuid,
    pub text: String,
    pub policy: CompanionWritePolicy,
    pub steer: bool,
    pub steer_supported: bool,
    pub expected_turn_id: Option<Uuid>,
    pub delay_seconds: Option<i64>,
    pub deliver_at: Option<String>,
    pub delay_cap_hours: i64,
}

pub(crate) enum ClaimGate {
    Replay(SendReceipt),
    InProgress,
    Reserved,
}

pub(crate) async fn reserve_send_claim(
    pool: &SqlitePool,
    conversation_id: &str,
    operation_id: &str,
    digest: &str,
    principal: &str,
) -> Result<ClaimGate, CollaborationError> {
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome =
        reserve_send_claim_locked(&mut conn, conversation_id, operation_id, digest, principal)
            .await;
    finish_immediate(&mut conn, outcome).await
}

pub(crate) async fn reserve_send_claim_locked(
    conn: &mut sqlx::SqliteConnection,
    conversation_id: &str,
    operation_id: &str,
    digest: &str,
    principal: &str,
) -> Result<ClaimGate, CollaborationError> {
    let existing = sqlx::query_as::<_, (String, String, Option<String>)>(
        r#"SELECT payload_digest, principal_json, receipt_json
           FROM collaboration_send_claim
           WHERE conversation_id = ? AND operation_id = ?"#,
    )
    .bind(conversation_id)
    .bind(operation_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    if let Some((stored_digest, stored_principal, receipt)) = existing {
        if stored_digest != digest || stored_principal != principal {
            return Err(operation_conflict());
        }
        if let Some(raw) = receipt {
            return Ok(ClaimGate::Replay(replay_receipt(&raw)?));
        }
        return Ok(ClaimGate::InProgress);
    }
    let replay_after = stamp(Utc::now() - Duration::seconds(5));
    let digest_hit = sqlx::query_as::<_, (String,)>(
        r#"SELECT receipt_json FROM collaboration_send_claim
           WHERE conversation_id = ? AND payload_digest = ? AND principal_json = ? AND counts = 1
             AND receipt_json IS NOT NULL AND created_at >= ?
           ORDER BY created_at ASC LIMIT 1"#,
    )
    .bind(conversation_id)
    .bind(digest)
    .bind(principal)
    .bind(&replay_after)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    if let Some((raw,)) = digest_hit {
        sqlx::query(
            r#"INSERT INTO collaboration_send_claim
               (conversation_id, operation_id, payload_digest, principal_json, receipt_json,
                counts, created_at)
               VALUES (?, ?, ?, ?, ?, 0, ?)"#,
        )
        .bind(conversation_id)
        .bind(operation_id)
        .bind(digest)
        .bind(principal)
        .bind(&raw)
        .bind(now_stamp())
        .execute(&mut *conn)
        .await
        .map_err(db)?;
        return Ok(ClaimGate::Replay(replay_receipt(&raw)?));
    }
    let in_flight_digest: Option<i64> = sqlx::query_scalar(
        r#"SELECT 1 FROM collaboration_send_claim
           WHERE conversation_id = ? AND payload_digest = ? AND principal_json = ? AND counts = 1
             AND receipt_json IS NULL AND created_at >= ?
           LIMIT 1"#,
    )
    .bind(conversation_id)
    .bind(digest)
    .bind(principal)
    .bind(&replay_after)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    if in_flight_digest.is_some() {
        return Ok(ClaimGate::InProgress);
    }
    let hour_ago = stamp(Utc::now() - Duration::hours(1));
    let recent: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM collaboration_send_claim
           WHERE conversation_id = ? AND counts = 1 AND created_at >= ?"#,
    )
    .bind(conversation_id)
    .bind(&hour_ago)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    if recent >= SUBMIT_HOURLY_CAP {
        return Err(CollaborationError::new(
            "limit_exceeded",
            "this conversation can accept 60 new messages per hour",
        ));
    }
    sqlx::query(
        r#"INSERT INTO collaboration_send_claim
           (conversation_id, operation_id, payload_digest, principal_json, receipt_json,
            counts, created_at)
           VALUES (?, ?, ?, ?, NULL, 1, ?)"#,
    )
    .bind(conversation_id)
    .bind(operation_id)
    .bind(digest)
    .bind(principal)
    .bind(now_stamp())
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    Ok(ClaimGate::Reserved)
}

pub(crate) fn replay_receipt(raw: &str) -> Result<SendReceipt, CollaborationError> {
    let mut receipt: SendReceipt = serde_json::from_str(raw).map_err(|error| {
        CollaborationError::new("conversation_control_failed", error.to_string())
    })?;
    receipt.idempotent_replay = true;
    Ok(receipt)
}

pub(crate) async fn finish_immediate<T>(
    conn: &mut sqlx::SqliteConnection,
    outcome: Result<T, CollaborationError>,
) -> Result<T, CollaborationError> {
    match outcome {
        Ok(value) => {
            if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(db(error));
            }
            Ok(value)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(error)
        }
    }
}

pub(crate) async fn release_send_claim(
    pool: &SqlitePool,
    conversation_id: &str,
    operation_id: &str,
) {
    if let Err(error) = sqlx::query(
        r#"DELETE FROM collaboration_send_claim
           WHERE conversation_id = ? AND operation_id = ? AND receipt_json IS NULL"#,
    )
    .bind(conversation_id)
    .bind(operation_id)
    .execute(pool)
    .await
    {
        tracing::warn!(%error, "collaboration claim was not released");
    }
}

pub(crate) async fn record_send_receipt(
    pool: &SqlitePool,
    conversation_id: &str,
    operation_id: &str,
    receipt: &SendReceipt,
) -> Result<(), CollaborationError> {
    let raw = serde_json::to_string(receipt).map_err(|error| {
        CollaborationError::new("conversation_control_failed", error.to_string())
    })?;
    sqlx::query(
        r#"UPDATE collaboration_send_claim
           SET receipt_json = ?
           WHERE conversation_id = ? AND operation_id = ? AND receipt_json IS NULL"#,
    )
    .bind(raw)
    .bind(conversation_id)
    .bind(operation_id)
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

pub(crate) async fn finish_unreceipted_claim(
    pool: &SqlitePool,
    conversation_id: Uuid,
    operation_id: Uuid,
    delivery: &DeliveryContext,
) -> Result<Option<SendReceipt>, CollaborationError> {
    let input_id: Option<Uuid> = sqlx::query_scalar(
        r#"SELECT id FROM conversation_inputs
           WHERE conversation_id = ? AND operation_id = ?"#,
    )
    .bind(conversation_id)
    .bind(operation_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some(input_id) = input_id else {
        return Ok(None);
    };
    let busy = active_turn_id(pool, conversation_id).await?;
    let (delivered, turn_id) = receipt_delivery(conversation_id, busy, delivery).await;
    let receipt = SendReceipt {
        delivered,
        input_id: Some(input_id),
        turn_id,
        delayed_input_id: None,
        idempotent_replay: true,
    };
    record_send_receipt(
        pool,
        &conversation_id.to_string(),
        &operation_id.to_string(),
        &receipt,
    )
    .await?;
    Ok(Some(receipt))
}

pub(crate) async fn active_turn_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<Uuid>, CollaborationError> {
    sqlx::query_scalar(
        r#"SELECT id FROM conversation_turns
           WHERE conversation_id = ?
             AND status IN ('pending', 'queued', 'running', 'blocked')
           ORDER BY ordinal DESC LIMIT 1"#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(db)
}

pub(crate) fn digest_text(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub(crate) fn delivery_operation_id(message_id: Uuid, conversation_id: Uuid) -> Uuid {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("{message_id}:{conversation_id}").as_bytes(),
    )
}

#[derive(Debug, Clone, Serialize)]
pub struct DeliveryReceipt {
    pub conversation_id: Uuid,
    pub nickname: String,
    pub delivered: String,
    /// Seven-state receipt: `queued`, `processing`, `replied`, `passed`,
    /// `timed_out`, `cancelled`, plus projected `failed` / `limit_reached`.
    /// `failed` is derived from transport `status` and is not stored here.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpacePostResult {
    pub message_id: String,
    pub seq: i64,
    pub receipts: Vec<DeliveryReceipt>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageAudience {
    Agent,
    User,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpaceMessage {
    /// Stable message id (the target of a later `in_reply_to`).
    pub id: String,
    pub seq: i64,
    pub envelope: Value,
    /// `user` or `agent`.
    pub origin: String,
    /// Id of the message this one replies to, lifted from the envelope's
    /// `reply_to`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    /// Per-recipient receipts (empty for agent audiences).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub receipts: Vec<MessageReceipt>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MessageReceipt {
    pub conversation_id: String,
    pub state: String,
    pub delivered: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round_ordinal: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round_state: Option<String>,
}

fn resolve_receipt_state(
    status: &str,
    receipt_state: &str,
    wake_deferred_turn_key: Option<&str>,
) -> String {
    if status == "failed" {
        "failed".to_string()
    } else if receipt_state == "queued" && wake_deferred_turn_key.is_some() {
        "limit_reached".to_string()
    } else {
        receipt_state.to_string()
    }
}

/// Receipts of `message_id`, one per recipient conversation.
pub async fn list_message_receipts(
    pool: &SqlitePool,
    message_id: &str,
) -> Result<Vec<MessageReceipt>, CollaborationError> {
    let rows = RawMessageReceiptRow::query_by_message_id(pool, message_id)
        .await
        .map_err(db)?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let state = resolve_receipt_state(
                &row.status,
                &row.receipt_state,
                row.wake_deferred_turn_key.as_deref(),
            );
            row.into_receipt(state)
        })
        .collect())
}

/// Batch fetch receipts for multiple `message_ids` in chunked `IN` queries.
pub async fn list_message_receipts_batch(
    pool: &SqlitePool,
    message_ids: &[String],
) -> Result<std::collections::HashMap<String, Vec<MessageReceipt>>, CollaborationError> {
    let mut grouped: std::collections::HashMap<String, Vec<MessageReceipt>> =
        std::collections::HashMap::with_capacity(message_ids.len());
    for id in message_ids {
        grouped.entry(id.clone()).or_default();
    }
    if message_ids.is_empty() {
        return Ok(grouped);
    }
    for chunk in message_ids.chunks(500) {
        let rows = RawMessageReceiptRow::query_by_message_ids(pool, chunk)
            .await
            .map_err(db)?;
        for row in rows {
            let message_id = row.space_message_id.clone();
            let state = resolve_receipt_state(
                &row.status,
                &row.receipt_state,
                row.wake_deferred_turn_key.as_deref(),
            );
            grouped
                .entry(message_id)
                .or_default()
                .push(row.into_receipt(state));
        }
    }
    Ok(grouped)
}
pub async fn list_space_messages(
    pool: &SqlitePool,
    space_id: &str,
    since_seq: Option<i64>,
    limit: Option<i64>,
    audience: MessageAudience,
) -> Result<Vec<SpaceMessage>, CollaborationError> {
    let space_id_trimmed = space_id.trim();
    if audience == MessageAudience::Agent
        && (parse_unassigned_space_id(space_id_trimmed).is_some()
            || space_id_trimmed.starts_with(identity::DIRECT_PREFIX))
    {
        return Err(CollaborationError::new(
            "invalid_space_for_direct_chat",
            format!(
                "当前会话属于一对一私聊（{space_id_trimmed}）。私聊历史已在当前会话中，不必调用 read_space_messages。回复请直接输出普通文本。"
            ),
        ));
    }
    load_space_or_unassigned(pool, space_id).await?;
    let limit = limit
        .unwrap_or(SPACE_LIST_DEFAULT)
        .clamp(1, SPACE_LIST_HARD_CAP);
    let since = since_seq.unwrap_or(0);
    let rows = sqlx::query_as::<_, (i64, String, String, String)>(
        r#"SELECT seq, envelope_json, origin, id FROM collaboration_space_messages
           WHERE space_id = ? AND seq > ?
           ORDER BY seq ASC LIMIT ?"#,
    )
    .bind(space_id)
    .bind(since)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut receipts_by_message = if audience == MessageAudience::User && !rows.is_empty() {
        let message_ids: Vec<String> = rows.iter().map(|(_, _, _, id)| id.clone()).collect();
        list_message_receipts_batch(pool, &message_ids).await?
    } else {
        std::collections::HashMap::new()
    };
    let mut messages: Vec<SpaceMessage> = rows
        .into_iter()
        .filter_map(|(seq, raw, origin, id)| {
            let stored: Value = serde_json::from_str(&raw).ok()?;
            let mut parsed = parse_space_envelope(&stored);
            if origin == "agent" {
                let stripped = strip_stray_pass_tokens(&parsed.content);
                if is_pass_token(stripped) {
                    return None;
                }
                if stripped != parsed.content {
                    parsed.content = stripped.to_string();
                }
            }
            let envelope = project_listed_envelope(stored, &parsed, audience);
            let receipts = receipts_by_message.remove(&id).unwrap_or_default();
            Some(SpaceMessage {
                id,
                seq,
                envelope,
                origin,
                in_reply_to: parsed.reply_to,
                receipts,
            })
        })
        .collect();
    let reaction_ids: Vec<String> = messages.iter().map(|message| message.id.clone()).collect();
    let reactions_by_message = list_space_reactions_batch(pool, space_id, &reaction_ids).await?;
    for message in &mut messages {
        if let Some(reactions) = reactions_by_message.get(&message.id)
            && !reactions.is_empty()
        {
            message.envelope["reactions"] = json!(reactions);
        }
    }
    if audience == MessageAudience::User && space_tracks_turns(space_id) {
        let max_seq = messages.iter().map(|m| m.seq).max().unwrap_or(since).max(
            sqlx::query_scalar::<_, i64>(
                "SELECT COALESCE(MAX(seq), 0) FROM collaboration_space_messages WHERE space_id = ?",
            )
            .bind(space_id)
            .fetch_one(pool)
            .await
            .unwrap_or(0),
        );
        let raw_running_turns = sqlx::query_as::<_, (String, String, String, String, i64, String)>(
            r#"SELECT t.id, t.conversation_id, t.space_message_id, m.space_id, m.seq, m.created_at
               FROM collaboration_turns t
               JOIN collaboration_space_messages m ON m.id = t.space_message_id
               WHERE t.space_id = ? AND t.state = 'running'
               ORDER BY m.seq ASC, t.created_at ASC"#,
        )
        .bind(space_id)
        .fetch_all(pool)
        .await
        .map_err(db)?;
        let mut running_turns: Vec<(String, String, Option<String>, i64)> =
            Vec::with_capacity(raw_running_turns.len());
        for (turn_id, cid_str, trigger_msg_id, origin_space_id, origin_seq, origin_created_at) in
            raw_running_turns
        {
            let trigger_seq = resolve_turn_trigger_seq_in_space(
                pool,
                space_id,
                &origin_space_id,
                &trigger_msg_id,
                origin_seq,
                &origin_created_at,
            )
            .await?;
            running_turns.push((turn_id, cid_str, Some(trigger_msg_id), trigger_seq));
        }
        let seen_cids: std::collections::HashSet<String> = running_turns
            .iter()
            .map(|(_, cid_str, _, _)| cid_str.clone())
            .collect();
        let member_cids: Vec<String> = sqlx::query_scalar(
            r#"SELECT DISTINCT conversation_id FROM (
                 SELECT conversation_id FROM collaboration_space_members
                 WHERE space_id = ? AND kind = 'agent' AND conversation_id IS NOT NULL
                 UNION
                 SELECT conversation_id FROM collaboration_thread_members
                 WHERE thread_id = ? AND status = 'active' AND conversation_id IS NOT NULL
               )"#,
        )
        .bind(space_id)
        .bind(space_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        for cid_str in member_cids {
            if seen_cids.contains(&cid_str) {
                continue;
            }
            let Ok(cid) = Uuid::parse_str(&cid_str) else {
                continue;
            };
            if space_turn_streaming_step(cid).is_none() {
                continue;
            }
            if let Ok(Some(direct_ctx)) = latest_direct_session_turn(pool, cid, true).await
                && direct_ctx.space_ids.iter().any(|s| s == space_id)
            {
                running_turns.push((direct_ctx.turn_id, cid_str, None, max_seq));
            }
        }
        let mut draft_seq = max_seq;
        for (turn_id, cid_str, trigger_msg_id, trigger_seq) in running_turns {
            let Ok(cid) = Uuid::parse_str(&cid_str) else {
                continue;
            };
            let Some(step) = space_turn_streaming_step(cid) else {
                continue;
            };
            let nickname = member_nickname(pool, space_id, cid)
                .await
                .ok()
                .flatten()
                .unwrap_or_default();
            let body = strip_own_nickname_prefix(step.text.trim(), &nickname);
            if body.is_empty() || is_pass_token(&body) {
                continue;
            }
            let posted_rows: Vec<String> = sqlx::query_scalar(
                r#"SELECT envelope_json FROM collaboration_space_messages
                   WHERE space_id = ? AND seq > ? AND origin = 'agent'
                   ORDER BY seq ASC"#,
            )
            .bind(space_id)
            .bind(trigger_seq)
            .fetch_all(pool)
            .await
            .map_err(db)?;
            let already_posted_same = posted_rows.iter().any(|raw| {
                let parsed = parse_space_envelope_str(raw);
                envelope_sender_is_conversation(&parsed, cid, Some(&nickname))
                    && strip_own_nickname_prefix(parsed.content.trim(), &nickname) == body
            });
            if already_posted_same {
                continue;
            }
            draft_seq += 1;
            let draft_id = if step.step_index == 0 {
                format!("draft:{turn_id}")
            } else {
                format!("draft:{turn_id}:{}", step.step_index)
            };
            let sender_nickname = if nickname.trim().is_empty() {
                "Bot".to_string()
            } else {
                nickname.trim().to_string()
            };
            let sender_label = envelope_member_name(&sender_nickname);
            let envelope = json!({
                "id": draft_id,
                "sender": sender_label,
                "sender_nickname": sender_nickname,
                "actor": sender_nickname,
                "conversation_id": cid.to_string(),
                "to": [ENVELOPE_USER_ACTOR],
                "content": body,
                "display_text": body,
                "in_reply_to": trigger_msg_id,
                "reply_to": trigger_msg_id,
                "created_at": step.updated_at,
                "turn_id": turn_id,
                "streaming": true,
            });
            messages.push(SpaceMessage {
                id: draft_id,
                seq: draft_seq,
                envelope,
                origin: "agent".to_string(),
                in_reply_to: trigger_msg_id,
                receipts: Vec::new(),
            });
        }
    }
    Ok(messages)
}

pub(crate) async fn load_message_head(
    pool: &SqlitePool,
    message_id: &str,
) -> Result<Option<MessageHead>, CollaborationError> {
    MessageHead::find_by_id(pool, message_id).await.map_err(db)
}

pub(crate) fn post_fingerprint(input: &PostToSpace, content: &str, actor: &str) -> Value {
    let mut to: Vec<String> = input
        .to
        .iter()
        .map(|nickname| nickname.trim().to_string())
        .filter(|nickname| !nickname.is_empty())
        .collect();
    to.sort();
    json!({
        "actor": actor,
        "content": content,
        "in_reply_to": input.in_reply_to.as_deref().map(str::trim).filter(|value| !value.is_empty()),
        "space_id": input.space_id,
        "summary": input.summary.as_deref().map(str::trim).filter(|value| !value.is_empty()),
        "to": to,
    })
}

pub(crate) async fn same_post_request(
    pool: &SqlitePool,
    message_id: &str,
    space_id: &str,
    request: &Value,
    envelope_json: &str,
) -> Result<bool, CollaborationError> {
    if let Some(stored) = load_stored_operation(pool, message_id).await? {
        if stored
            .space_id
            .as_deref()
            .is_some_and(|stored_space| stored_space != space_id)
        {
            return Ok(false);
        }
        if !stored.request_json.is_empty() {
            let request_json = request.to_string();
            return Ok(stored.request_json == request_json);
        }
    }
    Ok(envelope_matches(envelope_json, request))
}

pub(crate) fn envelope_matches(raw: &str, request: &Value) -> bool {
    let parsed = parse_space_envelope_str(raw);
    if parsed.content != request.get("content").and_then(Value::as_str).unwrap_or("") {
        return false;
    }
    let request_sender = request
        .get("actor")
        .and_then(Value::as_str)
        .map(envelope_member_name)
        .unwrap_or_default();
    if parsed.sender != request_sender {
        return false;
    }
    let stored_reply = parsed.reply_to.as_deref();
    let requested_reply = request
        .get("in_reply_to")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if stored_reply != requested_reply {
        return false;
    }
    if let Some(summary) = request.get("summary").and_then(Value::as_str)
        && parsed.summary.as_deref() != Some(summary)
    {
        return false;
    }
    let Some(items) = request.get("to").and_then(Value::as_array) else {
        return true;
    };
    if items.is_empty() {
        return true;
    }
    let mut requested: Vec<String> = items
        .iter()
        .filter_map(Value::as_str)
        .map(envelope_member_name)
        .collect();
    let mut stored = parsed.to;
    requested.sort();
    stored.sort();
    requested == stored
}

pub(crate) async fn load_envelope(
    pool: &SqlitePool,
    message_id: &str,
) -> Result<Value, CollaborationError> {
    let raw: String =
        sqlx::query_scalar("SELECT envelope_json FROM collaboration_space_messages WHERE id = ?")
            .bind(message_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?
            .ok_or_else(|| CollaborationError::new("not_found", "message was not found"))?;
    serde_json::from_str(&raw)
        .map_err(|error| CollaborationError::new("conversation_control_failed", error.to_string()))
}

pub(crate) async fn mark_delivery_failed(
    pool: &SqlitePool,
    message_id: &str,
    conversation_id: Uuid,
) -> Result<(), CollaborationError> {
    PendingDelivery::mark_failed(pool, message_id, conversation_id)
        .await
        .map_err(db)
}

pub(crate) async fn load_stored_operation(
    pool: &SqlitePool,
    operation_id: &str,
) -> Result<Option<StoredSpaceOperation>, CollaborationError> {
    let row = StoredSpaceOperation::find_raw_by_id(pool, operation_id)
        .await
        .map_err(db)?;
    let Some((space_id, request_json, result_json)) = row else {
        return Ok(None);
    };
    let result = serde_json::from_str(&result_json).map_err(|error| {
        CollaborationError::new("conversation_control_failed", error.to_string())
    })?;
    Ok(Some(StoredSpaceOperation {
        space_id,
        request_json,
        result,
    }))
}
pub(crate) fn accept_space_replay(
    stored: &StoredSpaceOperation,
    expected_space: Option<&str>,
    request: &Value,
) -> Result<Value, CollaborationError> {
    if let (Some(stored_space), Some(expected)) = (stored.space_id.as_deref(), expected_space)
        && stored_space != expected
    {
        return Err(CollaborationError::new("not_found", "space was not found"));
    }
    let request_json = request.to_string();
    if !stored.request_json.is_empty() && stored.request_json != request_json {
        return Err(operation_conflict());
    }
    Ok(stored.result.clone())
}

pub(crate) fn decode_replay<T: serde::de::DeserializeOwned>(
    value: Value,
) -> Result<T, CollaborationError> {
    serde_json::from_value(value)
        .map_err(|error| CollaborationError::new("conversation_control_failed", error.to_string()))
}

pub(crate) async fn store_operation(
    pool: &SqlitePool,
    operation_id: &str,
    space_id: Option<&str>,
    request: &Value,
    result: &impl Serialize,
) -> Result<(), CollaborationError> {
    let request_json = request.to_string();
    let result_json = serde_json::to_string(result).unwrap_or_else(|_| "{}".to_string());
    StoredSpaceOperation::insert(
        pool,
        operation_id,
        space_id,
        &request_json,
        &result_json,
        &now_stamp(),
    )
    .await
    .map_err(db)
}

pub(crate) fn space_thread_kind(space_id: &str) -> &'static str {
    if space_id.starts_with(identity::DIRECT_PREFIX)
        || parse_unassigned_space_id(space_id).is_some()
    {
        "dm"
    } else {
        "group"
    }
}

pub(crate) fn origin_from_envelope(
    space_id: &str,
    envelope: &Value,
    members: &[MemberRecord],
) -> CollaborationSpaceOrigin {
    let parsed = parse_space_envelope(envelope);
    if is_person_ref(&parsed.sender) {
        return CollaborationSpaceOrigin {
            space_id: space_id.to_string(),
            thread_kind: space_thread_kind(space_id).to_string(),
            sender_kind: "user".to_string(),
            sender_nickname: "你".to_string(),
            sender_conversation_id: None,
            sender_member_id: None,
        };
    }
    let nick = parsed.sender.as_str();
    let sender_conversation_id = parsed.conversation_id.map(|id| id.to_string());
    let sender_member_id = members
        .iter()
        .find(|member| member.nickname == nick)
        .map(|member| member.member_id.clone())
        .or_else(|| {
            sender_conversation_id.as_ref().and_then(|cid| {
                members
                    .iter()
                    .find(|member| member.conversation_id.as_deref() == Some(cid.as_str()))
                    .map(|member| member.member_id.clone())
            })
        });
    CollaborationSpaceOrigin {
        space_id: space_id.to_string(),
        thread_kind: space_thread_kind(space_id).to_string(),
        sender_kind: "member".to_string(),
        sender_nickname: nick.to_string(),
        sender_conversation_id,
        sender_member_id,
    }
}

pub(crate) async fn finish_tx<T>(
    conn: &mut sqlx::SqliteConnection,
    outcome: Result<T, CollaborationError>,
) -> Result<T, CollaborationError> {
    match outcome {
        Ok(value) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(db)?;
            Ok(value)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(error)
        }
    }
}

pub(crate) fn is_polite_ack_only(text: &str) -> bool {
    let trimmed = text
        .trim()
        .trim_matches(|ch: char| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '。' | '！'
                        | '!'
                        | '.'
                        | '，'
                        | ','
                        | '~'
                        | '～'
                        | '❤'
                        | '\u{fe0f}'
                        | '👍'
                        | '👌'
                )
        })
        .trim();
    if trimmed.is_empty() {
        return true;
    }
    let lowered = trimmed.to_ascii_lowercase();
    matches!(
        lowered.as_str(),
        "收到"
            | "已收到"
            | "好的"
            | "好"
            | "明白"
            | "已明白"
            | "知道了"
            | "了解"
            | "已了解"
            | "ok"
            | "okay"
            | "roger"
            | "ack"
            | "noted"
            | "谢谢"
            | "感谢"
            | "好的收到"
            | "收到谢谢"
            | "无需回复"
    )
}
