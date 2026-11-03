use db::models::collaboration_identity::{self as identity};
use serde_json::json;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::*;

#[derive(Debug, Clone, sqlx::FromRow)]
struct PendingDeliveryRow {
    space_message_id: String,
    conversation_id: String,
    operation_id: String,
    input_id: Option<String>,
    status: String,
    receipt_state: String,
    context_from_seq: Option<i64>,
    wake_deferred_turn_key: Option<String>,
    round_id: Option<String>,
    round_ordinal: Option<i64>,
    round_ready: i64,
}

fn pending_row_on_message(message_id: &str, delivery: PendingDelivery) -> PendingDeliveryRow {
    PendingDeliveryRow {
        space_message_id: message_id.to_string(),
        conversation_id: delivery.conversation_id,
        operation_id: delivery.operation_id,
        input_id: delivery.input_id,
        status: delivery.status,
        receipt_state: delivery.receipt_state,
        context_from_seq: delivery.context_from_seq,
        wake_deferred_turn_key: delivery.wake_deferred_turn_key,
        round_id: delivery.round_id,
        round_ordinal: delivery.round_ordinal,
        round_ready: delivery.round_ready,
    }
}

struct PackedDeliveryMessage {
    seq: i64,
    hop: i64,
    envelope: serde_json::Value,
    content: String,
    display_text: String,
}

async fn load_packed_delivery_message(
    pool: &SqlitePool,
    message_id: &str,
    member_nicknames: &[String],
) -> Result<PackedDeliveryMessage, CollaborationError> {
    let envelope = load_envelope(pool, message_id).await?;
    let seq: i64 = sqlx::query_scalar("SELECT seq FROM collaboration_space_messages WHERE id = ?")
        .bind(message_id)
        .fetch_one(pool)
        .await
        .map_err(db)?;
    let hop: i64 = sqlx::query_scalar("SELECT hop FROM collaboration_space_messages WHERE id = ?")
        .bind(message_id)
        .fetch_optional(pool)
        .await
        .map_err(db)?
        .unwrap_or(0);
    let parsed = parse_space_envelope(&envelope);
    let content = parsed.content.clone();
    let display_text = clean_space_display_text(&content, member_nicknames);
    Ok(PackedDeliveryMessage {
        seq,
        hop,
        envelope,
        content,
        display_text,
    })
}

async fn in_flight_delivery_count(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<i64, CollaborationError> {
    sqlx::query_scalar(
        r#"SELECT COUNT(*)
           FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           WHERE m.space_id = ? AND d.receipt_state = 'processing'"#,
    )
    .bind(space_id)
    .fetch_one(pool)
    .await
    .map_err(db)
}

pub(crate) async fn deliver_pending(
    pool: &SqlitePool,
    space_id: &str,
    message_id: &str,
    turn_delivery: &DeliveryContext,
) -> Result<SpacePostResult, CollaborationError> {
    let envelope = load_envelope(pool, message_id).await?;
    let seq: i64 = sqlx::query_scalar("SELECT seq FROM collaboration_space_messages WHERE id = ?")
        .bind(message_id)
        .fetch_one(pool)
        .await
        .map_err(db)?;
    let space_members = list_space_members(pool, space_id, MessageAudience::Agent)
        .await
        .unwrap_or_default();
    let member_nicknames: Vec<String> = space_members
        .iter()
        .map(|member| member.nickname.clone())
        .collect();
    let parsed = parse_space_envelope(&envelope);
    let content = parsed.content.clone();
    let display_text = clean_space_display_text(&content, &member_nicknames);
    let same_message = sqlx::query_as::<_, PendingDelivery>(
        r#"SELECT d.conversation_id, d.operation_id, d.input_id, d.status, d.receipt_state,
                  d.context_from_seq, d.wake_deferred_turn_key, d.round_id, d.round_ordinal,
                  CASE WHEN d.round_id IS NULL
                         OR d.round_ordinal <= (SELECT current_ordinal FROM collaboration_rounds r
                                                WHERE r.id = d.round_id AND r.state IN ('open','closing'))
                         OR EXISTS (SELECT 1 FROM collaboration_rounds r
                                    WHERE r.id = d.round_id AND r.state = 'closed')
                       THEN 1 ELSE 0 END AS round_ready
           FROM collaboration_space_deliveries d
           WHERE d.space_message_id = ?
           ORDER BY COALESCE(d.round_ordinal, 0) ASC, d.rowid ASC"#,
    )
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let other_ready = sqlx::query_as::<_, PendingDeliveryRow>(
        r#"SELECT d.space_message_id, d.conversation_id, d.operation_id, d.input_id, d.status,
                  d.receipt_state, d.context_from_seq, d.wake_deferred_turn_key, d.round_id,
                  d.round_ordinal,
                  CASE WHEN d.round_id IS NULL
                         OR d.round_ordinal <= (SELECT current_ordinal FROM collaboration_rounds r
                                                WHERE r.id = d.round_id AND r.state IN ('open','closing'))
                         OR EXISTS (SELECT 1 FROM collaboration_rounds r
                                    WHERE r.id = d.round_id AND r.state = 'closed')
                       THEN 1 ELSE 0 END AS round_ready
           FROM collaboration_space_deliveries d
           WHERE d.space_message_id != ?
             AND d.round_id IS NOT NULL
             AND TRIM(d.round_id) != ''
             AND d.round_ordinal <= (
                 SELECT r.current_ordinal FROM collaboration_rounds r
                 WHERE r.id = d.round_id
                   AND r.state IN ('open', 'closing')
                   AND r.root_message_id = ?
             )
           ORDER BY COALESCE(d.round_ordinal, 0) ASC, d.rowid ASC"#,
    )
    .bind(message_id)
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut pending: Vec<PendingDeliveryRow> = same_message
        .into_iter()
        .map(|delivery| pending_row_on_message(message_id, delivery))
        .collect();
    pending.extend(other_ready);
    pending.sort_by(|a, b| {
        a.round_ordinal
            .unwrap_or(0)
            .cmp(&b.round_ordinal.unwrap_or(0))
            .then_with(|| a.conversation_id.cmp(&b.conversation_id))
    });
    let mut packed_by_id: std::collections::HashMap<String, PackedDeliveryMessage> =
        std::collections::HashMap::new();
    packed_by_id.insert(
        message_id.to_string(),
        PackedDeliveryMessage {
            seq,
            hop: sqlx::query_scalar("SELECT hop FROM collaboration_space_messages WHERE id = ?")
                .bind(message_id)
                .fetch_optional(pool)
                .await
                .map_err(db)?
                .unwrap_or(0),
            envelope: envelope.clone(),
            content: content.clone(),
            display_text: display_text.clone(),
        },
    );
    let mut in_flight = in_flight_delivery_count(pool, space_id).await?;
    let mut receipts = Vec::new();
    for delivery in pending {
        let Ok(conversation_id) = Uuid::parse_str(&delivery.conversation_id) else {
            continue;
        };
        let delivery_message_id = delivery.space_message_id.clone();
        if !packed_by_id.contains_key(&delivery_message_id) {
            let packed =
                load_packed_delivery_message(pool, &delivery_message_id, &member_nicknames).await?;
            packed_by_id.insert(delivery_message_id.clone(), packed);
        }
        let packed = packed_by_id
            .get(&delivery_message_id)
            .expect("packed delivery message");
        let seq = packed.seq;
        let envelope = &packed.envelope;
        let content = packed.content.as_str();
        let display_text = packed.display_text.as_str();
        let chain_limit_exceeded = packed.hop > MAX_ASSISTANT_HOPS_PER_ROOT;
        let nickname = member_nickname(pool, space_id, conversation_id)
            .await?
            .unwrap_or_else(|| conversation_id.to_string());
        if delivery.input_id.is_some()
            || delivery.status == "failed"
            || delivery.status == "skipped_chain_limit"
        {
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: delivery.status,
                state: delivery.receipt_state,
                input_id: delivery
                    .input_id
                    .as_deref()
                    .and_then(|id| Uuid::parse_str(id).ok()),
                error_code: None,
            });
            continue;
        }
        if delivery.receipt_state == "cancelled" || delivery.round_ready == 0 {
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: delivery.status,
                state: delivery.receipt_state,
                input_id: None,
                error_code: None,
            });
            continue;
        }
        let Ok(operation_id) = Uuid::parse_str(&delivery.operation_id) else {
            continue;
        };
        if chain_limit_exceeded {
            let mut conn = pool.acquire().await.map_err(db)?;
            let _ = sqlx::query("PRAGMA ignore_check_constraints = ON")
                .execute(&mut *conn)
                .await;
            let update_res = sqlx::query(
                r#"UPDATE collaboration_space_deliveries
                   SET status = 'skipped_chain_limit',
                       receipt_state = 'cancelled',
                       wake_deferred_turn_key = NULL,
                       receipt_updated_at = ?
                   WHERE space_message_id = ? AND conversation_id = ?"#,
            )
            .bind(now_stamp())
            .bind(&delivery_message_id)
            .bind(conversation_id.to_string())
            .execute(&mut *conn)
            .await;
            let _ = sqlx::query("PRAGMA ignore_check_constraints = OFF")
                .execute(&mut *conn)
                .await;
            update_res.map_err(db)?;
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: "skipped_chain_limit".to_string(),
                state: "cancelled".to_string(),
                input_id: None,
                error_code: Some("chain_limit_exceeded".to_string()),
            });
            continue;
        }
        let Some(target) = load_session(pool, conversation_id).await? else {
            mark_delivery_failed(pool, &delivery_message_id, conversation_id).await?;
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: "failed".to_string(),
                state: delivery.receipt_state.clone(),
                input_id: None,
                error_code: Some("not_found".to_string()),
            });
            continue;
        };
        if target.deleted_at.is_some() || target.status == "archived" {
            mark_delivery_failed(pool, &delivery_message_id, conversation_id).await?;
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: "failed".to_string(),
                state: delivery.receipt_state.clone(),
                input_id: None,
                error_code: Some("not_found".to_string()),
            });
            continue;
        }
        let current_round_slot = delivery
            .round_id
            .as_deref()
            .is_some_and(|id| !id.trim().is_empty())
            && delivery.round_ready == 1;
        if in_flight >= MAX_IN_FLIGHT_DELIVERIES_PER_SPACE && !current_round_slot {
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: "queued".to_string(),
                state: delivery.receipt_state.clone(),
                input_id: None,
                error_code: None,
            });
            continue;
        }
        if session_is_asleep(pool, conversation_id).await? {
            let released = match delivery.wake_deferred_turn_key.as_deref() {
                // Held earlier over the cap: deliver once the originating
                // turn has ended ("next turn"), never stall.
                Some(key) => !wake_turn_in_flight(pool, key).await?,
                None => false,
            };
            if !released {
                let turn_key = wake_turn_key(pool, &delivery_message_id, envelope).await?;
                if !reserve_wake(
                    pool,
                    &turn_key,
                    conversation_id,
                    &delivery_message_id,
                    wake_cap_per_turn(),
                )
                .await?
                {
                    // Over the per-turn wake cap: held visibly as
                    // 'limit_reached' until the originating turn ends.
                    hold_over_wake_cap(pool, &delivery_message_id, conversation_id, &turn_key)
                        .await?;
                    receipts.push(DeliveryReceipt {
                        conversation_id,
                        nickname,
                        delivered: "deferred".to_string(),
                        state: WAKE_LIMIT_REACHED.to_string(),
                        input_id: None,
                        error_code: Some("wake_limit_exceeded".to_string()),
                    });
                    continue;
                }
            }
        }
        if !try_acquire_member_write(pool, conversation_id).await? {
            receipts.push(DeliveryReceipt {
                conversation_id,
                nickname,
                delivered: "deferred".to_string(),
                state: delivery.receipt_state.clone(),
                input_id: None,
                error_code: Some("write_serialized_busy".to_string()),
            });
            continue;
        }
        if delivery.context_from_seq.is_none() {
            let from = context_window_start(pool, space_id, conversation_id, seq).await?;
            sqlx::query(
                r#"UPDATE collaboration_space_deliveries SET context_from_seq = ?
                   WHERE space_message_id = ? AND conversation_id = ?"#,
            )
            .bind(from)
            .bind(&delivery_message_id)
            .bind(conversation_id.to_string())
            .execute(pool)
            .await
            .map_err(db)?;
        }
        let dest_thread = thread_id_for_conversation(pool, conversation_id)
            .await?
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| space_id.to_string());
        let packed = compose_space_delivery_prompt(
            pool,
            conversation_id,
            &dest_thread,
            seq,
            envelope,
            content,
            display_text,
        )
        .await?;
        let origin = origin_from_envelope(space_id, envelope, &space_members);
        match deliver_text(
            pool,
            conversation_id,
            operation_id,
            &packed,
            Some(display_text.to_string()),
            Some(origin),
            &target,
            json!({
                "kind": "collaboration_space",
                "spaceId": space_id,
                "messageId": delivery_message_id,
            }),
            turn_delivery,
        )
        .await
        {
            Ok(receipt) => {
                let mut delivered_status = receipt.delivered.clone();
                if delivered_status == "queued"
                    && let Some(input_id) = receipt.input_id
                {
                    let input_status: Option<String> =
                        sqlx::query_scalar("SELECT status FROM conversation_inputs WHERE id = ?")
                            .bind(input_id)
                            .fetch_optional(pool)
                            .await
                            .ok()
                            .flatten();
                    if input_status.as_deref() == Some("dispatched") {
                        delivered_status = "dispatched".to_string();
                    }
                }
                let state = if delivered_status == "dispatched" {
                    "processing"
                } else {
                    "queued"
                };
                if state == "processing" {
                    in_flight = in_flight.saturating_add(1);
                }
                let turn_id = if receipt.input_id.is_some() {
                    bind_delivery_turn(
                        pool,
                        &dest_thread,
                        &delivery_message_id,
                        conversation_id,
                        envelope,
                        delivery.round_id.as_deref(),
                        delivery.round_ordinal,
                    )
                    .await?
                } else {
                    None
                };
                // The queue may already have dispatched the input (trigger),
                // so never move a receipt backwards.
                sqlx::query(
                    r#"UPDATE collaboration_space_deliveries
                       SET input_id = ?,
                           status = CASE
                             WHEN ? = 'dispatched' THEN 'dispatched'
                             WHEN ? IS NOT NULL AND EXISTS (
                               SELECT 1 FROM conversation_inputs ci
                               WHERE ci.id = ? AND ci.status = 'dispatched'
                             ) THEN 'dispatched'
                             ELSE ?
                           END,
                           wake_deferred_turn_key = NULL,
                           turn_id = COALESCE(?, turn_id),
                           receipt_state = CASE
                             WHEN ? = 'processing' THEN 'processing'
                             WHEN ? IS NOT NULL AND EXISTS (
                               SELECT 1 FROM conversation_inputs ci
                               WHERE ci.id = ? AND ci.status = 'dispatched'
                             ) THEN 'processing'
                             WHEN receipt_state = 'queued' THEN ?
                             ELSE receipt_state
                           END,
                           receipt_updated_at = ?
                       WHERE space_message_id = ? AND conversation_id = ?"#,
                )
                .bind(receipt.input_id.map(|id| id.to_string()))
                .bind(&delivered_status)
                .bind(receipt.input_id)
                .bind(receipt.input_id)
                .bind(&delivered_status)
                .bind(turn_id.as_deref())
                .bind(state)
                .bind(receipt.input_id)
                .bind(receipt.input_id)
                .bind(state)
                .bind(now_stamp())
                .bind(&delivery_message_id)
                .bind(conversation_id.to_string())
                .execute(pool)
                .await
                .map_err(db)?;
                advance_last_seen(pool, space_id, conversation_id, &delivery_message_id, seq)
                    .await?;
                touch_session_activity(pool, conversation_id).await?;
                let state: String = sqlx::query_scalar(
                    r#"SELECT receipt_state FROM collaboration_space_deliveries
                       WHERE space_message_id = ? AND conversation_id = ?"#,
                )
                .bind(&delivery_message_id)
                .bind(conversation_id.to_string())
                .fetch_one(pool)
                .await
                .map_err(db)?;
                receipts.push(DeliveryReceipt {
                    conversation_id,
                    nickname,
                    delivered: receipt.delivered,
                    state,
                    input_id: receipt.input_id,
                    error_code: None,
                });
            }
            Err(error) => {
                if error.code != "limit_exceeded" {
                    mark_delivery_failed(pool, &delivery_message_id, conversation_id).await?;
                    finish_open_turn(pool, &delivery_message_id, conversation_id, "error").await?;
                }
                receipts.push(DeliveryReceipt {
                    conversation_id,
                    nickname,
                    delivered: "failed".to_string(),
                    state: delivery.receipt_state.clone(),
                    input_id: None,
                    error_code: Some(error.code.to_string()),
                });
            }
        }
    }
    Ok(SpacePostResult {
        message_id: message_id.to_string(),
        seq,
        receipts,
    })
}

/// Most recent missed group messages packed verbatim into one delivery;
/// older missed messages collapse into a one-line summary.
pub const MISSED_CONTEXT_VERBATIM: usize = 15;
/// Furthest back (in messages) a missed-context window ever reaches.
pub(crate) const MISSED_CONTEXT_LIMIT: i64 = 500;
/// Per-message character cap inside the packed block.
pub(crate) const MISSED_CONTEXT_MESSAGE_CHARS: usize = 1500;

/// Thread binding (`collaboration_thread_members`) of a seat conversation.
pub(crate) async fn seat_binding(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<identity::ThreadMemberRow>, CollaborationError> {
    identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)
}

/// Exclusive lower seq bound of the missed-context window for a delivery of
/// message `seq`: the member's last seen message in this thread, or (never
/// seen) the last `MISSED_CONTEXT_LIMIT` messages.
pub(crate) async fn context_window_start(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    seq: i64,
) -> Result<i64, CollaborationError> {
    let last_seen = match seat_binding(pool, conversation_id).await? {
        Some(binding) => binding_last_seen_seq(pool, space_id, &binding).await?,
        None => None,
    };
    let floor = (seq - 1 - MISSED_CONTEXT_LIMIT).max(0);
    Ok(last_seen
        .map_or(floor, |seen| seen.max(floor))
        .min(seq - 1)
        .max(0))
}

pub(crate) async fn binding_last_seen_seq(
    pool: &SqlitePool,
    space_id: &str,
    binding: &identity::ThreadMemberRow,
) -> Result<Option<i64>, CollaborationError> {
    sqlx::query_scalar::<_, i64>(
        r#"SELECT m.seq FROM collaboration_thread_members tm
           JOIN collaboration_space_messages m
             ON m.id = tm.last_seen_message_id AND m.space_id = ?
           WHERE tm.thread_id = ? AND tm.member_id = ?"#,
    )
    .bind(space_id)
    .bind(&binding.thread_id)
    .bind(&binding.member_id)
    .fetch_optional(pool)
    .await
    .map_err(db)
}

/// Highest seq this conversation already finished (`replied` / `passed`)
/// or authored/observed during a completed turn in `space_id`. `None` when it
/// has never completed a delivery.
pub(crate) async fn last_completed_delivery_seq(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
) -> Result<Option<i64>, CollaborationError> {
    let cid = conversation_id.to_string();
    let delivery_max = sqlx::query_scalar::<_, Option<i64>>(
        r#"SELECT MAX(m.seq) FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           WHERE d.conversation_id = ?
             AND m.space_id = ?
             AND d.receipt_state IN ('replied', 'passed')"#,
    )
    .bind(&cid)
    .bind(space_id)
    .fetch_one(pool)
    .await
    .map_err(db)?;
    let Some(mut max_seq) = delivery_max else {
        return Ok(None);
    };

    let nickname = member_nickname(pool, space_id, conversation_id)
        .await
        .ok()
        .flatten();
    let agent_rows = sqlx::query_as::<_, (i64, String)>(
        r#"SELECT seq, envelope_json FROM collaboration_space_messages
           WHERE space_id = ? AND seq > ? AND origin = 'agent'
           ORDER BY seq DESC LIMIT ?"#,
    )
    .bind(space_id)
    .bind(max_seq)
    .bind(MISSED_CONTEXT_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    for (seq, raw) in &agent_rows {
        let parsed = parse_space_envelope_str(raw);
        if envelope_sender_is_conversation(&parsed, conversation_id, nickname.as_deref()) {
            max_seq = max_seq.max(*seq);
            break;
        }
    }

    let earlier_round_peers = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT DISTINCT d_prev.conversation_id, COALESCE(m_root.seq, 0)
           FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m_root ON m_root.id = d.space_message_id
           JOIN collaboration_space_deliveries d_prev ON d_prev.round_id = d.round_id
           WHERE d.conversation_id = ?
             AND m_root.space_id = ?
             AND d.receipt_state IN ('replied', 'passed')
             AND d.round_id IS NOT NULL
             AND COALESCE(d.round_ordinal, 0) > 1
             AND COALESCE(d_prev.round_ordinal, 0) > 0
             AND COALESCE(d_prev.round_ordinal, 0) < COALESCE(d.round_ordinal, 0)"#,
    )
    .bind(&cid)
    .bind(space_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    for (peer_cid_raw, root_seq) in earlier_round_peers {
        let Ok(peer_cid) = Uuid::parse_str(&peer_cid_raw) else {
            continue;
        };
        let peer_nick = member_nickname(pool, space_id, peer_cid)
            .await
            .ok()
            .flatten();
        for (seq, raw) in &agent_rows {
            if *seq <= root_seq {
                continue;
            }
            let parsed = parse_space_envelope_str(raw);
            if envelope_sender_is_conversation(&parsed, peer_cid, peer_nick.as_deref()) {
                max_seq = max_seq.max(*seq);
            }
        }
    }

    Ok(Some(max_seq))
}

/// One-line speaking-order trail for a multi-bot round this delivery belongs
/// to. `None` when the delivery is not part of a round with at least two members.
pub(crate) async fn round_speaking_order_line(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    seq: i64,
) -> Result<Option<String>, CollaborationError> {
    let round_id: Option<String> = sqlx::query_scalar(
        r#"SELECT d.round_id FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           WHERE d.conversation_id = ?
             AND m.space_id = ?
             AND m.seq <= ?
             AND d.round_id IS NOT NULL
             AND TRIM(d.round_id) != ''
           ORDER BY m.seq DESC, COALESCE(d.round_ordinal, 0) DESC
           LIMIT 1"#,
    )
    .bind(conversation_id.to_string())
    .bind(space_id)
    .bind(seq)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some(round_id) = round_id else {
        return Ok(None);
    };
    let current_ordinal: i64 =
        sqlx::query_scalar("SELECT current_ordinal FROM collaboration_rounds WHERE id = ?")
            .bind(&round_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?
            .unwrap_or(1);
    let members: Vec<(String, i64, String, i64)> = sqlx::query_as(
        r#"SELECT d.conversation_id, COALESCE(d.round_ordinal, 0), d.receipt_state, COALESCE(m.seq, 0)
           FROM collaboration_space_deliveries d
           LEFT JOIN collaboration_space_messages m ON m.id = d.space_message_id
           WHERE d.round_id = ?
           ORDER BY COALESCE(d.round_ordinal, 2147483647), d.conversation_id"#,
    )
    .bind(&round_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    if members.len() < 2 {
        return Ok(None);
    }
    let self_cid = conversation_id.to_string();
    let self_has_current = members
        .iter()
        .any(|(cid, ordinal, _, _)| cid == &self_cid && *ordinal == current_ordinal);
    let mut parts = Vec::new();
    for (cid, ordinal, state, slot_seq) in members {
        let cid_uuid = Uuid::parse_str(&cid).ok();
        let nick = match cid_uuid {
            Some(id) => member_nickname(pool, space_id, id)
                .await?
                .unwrap_or_else(|| cid.clone()),
            None => cid.clone(),
        };
        let is_self_active_slot =
            cid_uuid == Some(conversation_id) && (ordinal == current_ordinal || !self_has_current);
        let status = if is_self_active_slot {
            "you, now"
        } else if state == "passed" {
            "passed"
        } else if state == "processing" && ordinal > 0 && ordinal < current_ordinal {
            let posted = match cid_uuid {
                Some(id) => member_posted_after(pool, space_id, id, slot_seq)
                    .await
                    .unwrap_or(false),
                None => false,
            };
            if posted { "posted" } else { "working" }
        } else if matches!(
            state.as_str(),
            "replied" | "timed_out" | "cancelled" | "failed"
        ) || (ordinal > 0 && ordinal < current_ordinal)
        {
            "posted"
        } else {
            "waiting"
        };
        parts.push(format!("@{nick} ({status})"));
    }
    Ok(Some(parts.join(" → ")))
}

/// Nicknames of other Bots currently mid-turn in this GroupSpace.
pub(crate) async fn working_peers_line(
    pool: &SqlitePool,
    space_id: &str,
    exclude_conversation_id: Uuid,
    before_seq: i64,
) -> Result<Option<String>, CollaborationError> {
    if !is_group_space(space_id) {
        return Ok(None);
    }
    let rows: Vec<String> = sqlx::query_scalar(
        r#"SELECT DISTINCT COALESCE(NULLIF(TRIM(sm.nickname), ''), d.conversation_id)
           FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           LEFT JOIN collaboration_space_members sm
             ON sm.space_id = m.space_id AND sm.conversation_id = d.conversation_id
           LEFT JOIN collaboration_turns t ON t.id = d.turn_id
           WHERE m.space_id = ?
             AND m.seq < ?
             AND d.conversation_id != ?
             AND (
               d.receipt_state = 'processing'
               OR t.state = 'running'
               OR EXISTS (
                 SELECT 1 FROM collaboration_turns ct
                 WHERE ct.space_id = m.space_id
                   AND ct.conversation_id = d.conversation_id
                   AND ct.state = 'running'
               )
             )
           ORDER BY COALESCE(NULLIF(TRIM(sm.nickname), ''), d.conversation_id)"#,
    )
    .bind(space_id)
    .bind(before_seq)
    .bind(exclude_conversation_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let extra: Vec<String> = sqlx::query_scalar(
        r#"SELECT DISTINCT COALESCE(NULLIF(TRIM(sm.nickname), ''), t.conversation_id)
           FROM collaboration_turns t
           JOIN collaboration_space_messages m ON m.id = t.space_message_id
           LEFT JOIN collaboration_space_members sm
             ON sm.space_id = t.space_id AND sm.conversation_id = t.conversation_id
           WHERE t.space_id = ?
             AND t.state = 'running'
             AND t.conversation_id != ?
             AND m.seq < ?
           ORDER BY COALESCE(NULLIF(TRIM(sm.nickname), ''), t.conversation_id)"#,
    )
    .bind(space_id)
    .bind(exclude_conversation_id.to_string())
    .bind(before_seq)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut names = Vec::new();
    for name in rows.into_iter().chain(extra) {
        let name = name.trim();
        if name.is_empty() || names.iter().any(|existing: &String| existing == name) {
            continue;
        }
        names.push(name.to_string());
    }
    if names.is_empty() {
        return Ok(None);
    }
    let list = names
        .iter()
        .map(|name| format!("@{name} (working)"))
        .collect::<Vec<_>>()
        .join("、");
    Ok(Some(list))
}

/// Group messages in `(from_seq, before_seq)` that this conversation did not
/// author, rendered as a "while you were away" block. `None` when empty.
#[cfg(test)]
pub(crate) async fn missed_group_context(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    from_seq: i64,
    before_seq: i64,
) -> Result<Option<String>, CollaborationError> {
    let lines =
        fetch_missed_group_lines(pool, space_id, conversation_id, from_seq, before_seq).await?;
    Ok(format_missed_group_block(
        "[上次发言后的群内新消息]",
        &lines,
    ))
}

/// Split incremental group messages since `from_seq` around `trigger_seq` so
/// messages before `#trigger_seq` appear above the trigger envelope and
/// messages after `#trigger_seq` (e.g. earlier speakers' replies in the same
/// sequential round) appear below the trigger envelope in chronological order.
pub(crate) async fn split_missed_group_context(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    from_seq: i64,
    trigger_seq: i64,
) -> Result<(Option<String>, Option<String>), CollaborationError> {
    let lines =
        fetch_missed_group_lines(pool, space_id, conversation_id, from_seq, trigger_seq).await?;
    if lines.is_empty() {
        return Ok((None, None));
    }
    let pre: Vec<(i64, String, String)> = lines
        .iter()
        .filter(|(seq, _, _)| *seq < trigger_seq)
        .cloned()
        .collect();
    let post: Vec<(i64, String, String)> = lines
        .iter()
        .filter(|(seq, _, _)| *seq > trigger_seq)
        .cloned()
        .collect();
    match (pre.is_empty(), post.is_empty()) {
        (true, true) => Ok((None, None)),
        (false, true) => Ok((
            format_missed_group_block("[上次发言后的群内新消息]", &pre),
            None,
        )),
        (true, false) => Ok((
            None,
            format_missed_group_block("[上次发言后的群内新消息]", &post),
        )),
        (false, false) => Ok((
            format_missed_group_block("[上次发言后的群内新消息]", &pre),
            format_missed_group_block("[本轮新增群内消息]", &post),
        )),
    }
}

async fn fetch_missed_group_lines(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    from_seq: i64,
    exclude_seq: i64,
) -> Result<Vec<(i64, String, String)>, CollaborationError> {
    let nickname = member_nickname(pool, space_id, conversation_id)
        .await
        .ok()
        .flatten();
    let rows = sqlx::query_as::<_, (i64, String)>(
        r#"SELECT seq, envelope_json FROM collaboration_space_messages
           WHERE space_id = ? AND seq > ? AND seq != ?
           ORDER BY seq DESC LIMIT ?"#,
    )
    .bind(space_id)
    .bind(from_seq)
    .bind(exclude_seq)
    .bind(MISSED_CONTEXT_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut lines = Vec::new();
    for (seq, raw) in rows {
        let parsed = parse_space_envelope_str(&raw);
        if envelope_sender_is_conversation(&parsed, conversation_id, nickname.as_deref()) {
            continue;
        }
        let who = if parsed.sender.is_empty() {
            "Bot".to_string()
        } else {
            parsed.sender
        };
        lines.push((seq, who, parsed.content));
    }
    lines.reverse();
    Ok(lines)
}

fn format_missed_group_block(header: &str, lines: &[(i64, String, String)]) -> Option<String> {
    if lines.is_empty() {
        return None;
    }
    let older = lines.len().saturating_sub(MISSED_CONTEXT_VERBATIM);
    let mut out = Vec::new();
    if older > 0 {
        let collapsed = &lines[..older];
        let mut who: Vec<&str> = Vec::new();
        for (_, name, _) in collapsed {
            if !who.contains(&name.as_str()) {
                who.push(name);
            }
        }
        out.push(format!(
            "[#{}–#{}] 更早 {older} 条来自 {}（已折叠；完整内容请调用 read_space_messages）",
            collapsed[0].0,
            collapsed[older - 1].0,
            who.join("、")
        ));
    }
    for (seq, who, content) in &lines[older..] {
        let mut content = content.clone();
        if content.chars().count() > MISSED_CONTEXT_MESSAGE_CHARS {
            content = content
                .chars()
                .take(MISSED_CONTEXT_MESSAGE_CHARS)
                .collect::<String>()
                + "…（完整内容请调用 read_space_messages）";
        }
        out.push(format!("[#{seq}] {who}: {content}"));
    }
    Some(format!("{header}\n{}", out.join("\n")))
}

/// Record that the member behind `conversation_id` has now seen `message_id`
/// (seq `seq`) in this thread. Never moves backwards.
pub(crate) async fn advance_last_seen(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    message_id: &str,
    seq: i64,
) -> Result<(), CollaborationError> {
    let Some(binding) = seat_binding(pool, conversation_id).await? else {
        return Ok(());
    };
    let current = binding_last_seen_seq(pool, space_id, &binding).await?;
    if current.is_some_and(|seen| seen >= seq) {
        return Ok(());
    }
    sqlx::query(
        r#"UPDATE collaboration_thread_members SET last_seen_message_id = ?
           WHERE thread_id = ? AND member_id = ?"#,
    )
    .bind(message_id)
    .bind(&binding.thread_id)
    .bind(&binding.member_id)
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

/// Retry deliveries that were deferred (wake cap or write serialization):
/// queued rows with no input yet. Returns how many messages were retried.
pub async fn redeliver_deferred(
    pool: &SqlitePool,
    delivery: &DeliveryContext,
) -> Result<usize, CollaborationError> {
    let pending = sqlx::query_as::<_, (String, String)>(
        r#"SELECT DISTINCT m.space_id, d.space_message_id
           FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           WHERE d.status = 'queued' AND d.input_id IS NULL
             AND (d.round_id IS NULL
                  OR d.round_ordinal <= (SELECT current_ordinal FROM collaboration_rounds r
                                         WHERE r.id = d.round_id AND r.state IN ('open','closing'))
                  OR EXISTS (SELECT 1 FROM collaboration_rounds r
                             WHERE r.id = d.round_id AND r.state = 'closed'))
           LIMIT 100"#,
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut retried = pending.len();
    for (space_id, message_id) in &pending {
        if let Err(error) = deliver_pending(pool, space_id, message_id, delivery).await {
            tracing::warn!(%error, %message_id, "deferred space delivery retry failed");
        }
    }

    let queued_with_input = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        r#"SELECT d.space_message_id, d.conversation_id, d.input_id, ci.status
           FROM collaboration_space_deliveries d
           LEFT JOIN conversation_inputs ci
             ON lower(hex(ci.id)) = replace(lower(d.input_id), '-', '')
           WHERE d.receipt_state = 'queued'
             AND d.input_id IS NOT NULL
             AND TRIM(d.input_id) != ''
           LIMIT 100"#,
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;

    for (space_message_id, cid_raw, _input_id, ci_status) in queued_with_input {
        let Ok(conversation_id) = Uuid::parse_str(&cid_raw) else {
            continue;
        };
        let mut dispatched = ci_status.as_deref() == Some("dispatched");
        if !dispatched
            && ci_status.as_deref() == Some("queued")
            && let Some(dispatcher) = &delivery.dispatcher
        {
            match dispatcher.start_if_idle(conversation_id).await {
                Ok(Some(_)) => {
                    dispatched = true;
                }
                Ok(None) => {
                    let current_status: Option<String> = sqlx::query_scalar(
                        r#"SELECT ci.status
                           FROM collaboration_space_deliveries d
                           JOIN conversation_inputs ci
                             ON lower(hex(ci.id)) = replace(lower(d.input_id), '-', '')
                           WHERE d.space_message_id = ? AND d.conversation_id = ?
                           LIMIT 1"#,
                    )
                    .bind(&space_message_id)
                    .bind(&cid_raw)
                    .fetch_optional(pool)
                    .await
                    .ok()
                    .flatten();
                    if current_status.as_deref() == Some("dispatched") {
                        dispatched = true;
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        %conversation_id,
                        %space_message_id,
                        "deferred queued input start_if_idle failed"
                    );
                }
            }
        }
        if dispatched {
            let now = now_stamp();
            let _ = sqlx::query(
                r#"UPDATE collaboration_space_deliveries
                   SET status = 'dispatched',
                       receipt_state = 'processing',
                       receipt_updated_at = ?
                   WHERE space_message_id = ?
                     AND conversation_id = ?
                     AND receipt_state = 'queued'"#,
            )
            .bind(&now)
            .bind(&space_message_id)
            .bind(&cid_raw)
            .execute(pool)
            .await;
            retried += 1;
        }
    }

    Ok(retried)
}
