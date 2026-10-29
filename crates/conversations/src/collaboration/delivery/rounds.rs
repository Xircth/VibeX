use chrono::{Duration, Utc};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{routing::ResolvedTarget, *};

pub const DEFAULT_COLLAB_ROUND_TIMEOUT_MINUTES: i64 = 30;
pub const DEFAULT_COLLAB_ROUND_GRACE_SECS: i64 = 3;

pub fn collab_round_timeout_minutes() -> i64 {
    super::routing::env_i64(
        "VIBEX_COLLAB_ROUND_TIMEOUT_MINUTES",
        DEFAULT_COLLAB_ROUND_TIMEOUT_MINUTES,
    )
    .max(1)
}

pub fn collab_round_grace_secs() -> i64 {
    super::routing::env_i64(
        "VIBEX_COLLAB_ROUND_GRACE_SECONDS",
        DEFAULT_COLLAB_ROUND_GRACE_SECS,
    )
    .max(1)
}

pub(crate) fn first_mention_offset(content: &str, name: &str) -> Option<usize> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let needle = format!("@{name}");
    for (idx, _) in content.match_indices(&needle) {
        if idx > 0 {
            let prev = content[..idx].chars().last();
            if prev.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '@') {
                continue;
            }
        }
        let after = content[idx + needle.len()..].chars().next();
        if super::routing::is_valid_mention_boundary(name, after) {
            return Some(idx);
        }
    }
    None
}

pub(crate) async fn sort_round_agent_targets(
    pool: &SqlitePool,
    space_id: &str,
    to: &[String],
    content: &str,
    targets: &mut [ResolvedTarget],
) -> Result<(), CollaborationError> {
    let lead_member_id: Option<String> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT lead_member_id FROM collaboration_spaces WHERE id = ?",
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .flatten()
    .map(|id| id.trim().to_string())
    .filter(|id| !id.is_empty());
    let members = list_space_members(pool, space_id, MessageAudience::Agent)
        .await
        .unwrap_or_default();
    let lead_nickname = lead_member_id.as_deref().and_then(|lead_id| {
        members
            .iter()
            .find(|m| m.member_id == lead_id)
            .map(|m| m.nickname.clone())
    });
    let explicit_to: Vec<String> = to
        .iter()
        .map(|s| s.trim().trim_start_matches('@').trim().to_string())
        .filter(|s| {
            !s.is_empty()
                && !super::routing::is_broadcast_target_name(s)
                && !super::routing::is_user_target_name(s)
        })
        .collect();
    targets.sort_by(|a, b| {
        let a_is_agent = a.conversation_id.is_some();
        let b_is_agent = b.conversation_id.is_some();
        if a_is_agent != b_is_agent {
            return b_is_agent.cmp(&a_is_agent);
        }
        let a_lead = usize::from(
            !(a.dest_thread_id.is_none() && lead_nickname.as_deref() == Some(a.nickname.as_str())),
        );
        let b_lead = usize::from(
            !(b.dest_thread_id.is_none() && lead_nickname.as_deref() == Some(b.nickname.as_str())),
        );
        let a_to = explicit_to
            .iter()
            .position(|n| {
                n == &a.nickname || a.conversation_id.is_some_and(|cid| cid.to_string() == *n)
            })
            .unwrap_or(usize::MAX);
        let b_to = explicit_to
            .iter()
            .position(|n| {
                n == &b.nickname || b.conversation_id.is_some_and(|cid| cid.to_string() == *n)
            })
            .unwrap_or(usize::MAX);
        let a_mention = first_mention_offset(content, &a.nickname).unwrap_or(usize::MAX);
        let b_mention = first_mention_offset(content, &b.nickname).unwrap_or(usize::MAX);
        (a_lead, a_to, a_mention, &a.nickname).cmp(&(b_lead, b_to, b_mention, &b.nickname))
    });
    Ok(())
}

pub(crate) async fn supersede_open_rounds_tx(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
    now: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let open_rounds: Vec<(String, String)> = sqlx::query_as(
        r#"SELECT id, root_message_id FROM collaboration_rounds
           WHERE space_id = ? AND state IN ('open', 'closing')"#,
    )
    .bind(space_id)
    .fetch_all(&mut *conn)
    .await?;
    if open_rounds.is_empty() {
        return Ok(Vec::new());
    }
    let mut round_ids = Vec::with_capacity(open_rounds.len());
    for (round_id, root_message_id) in open_rounds {
        sqlx::query(
            r#"UPDATE collaboration_rounds
               SET state = 'superseded', updated_at = ?
               WHERE id = ?"#,
        )
        .bind(now)
        .bind(&round_id)
        .execute(&mut *conn)
        .await?;
        sqlx::query(
            r#"UPDATE collaboration_turns
               SET outcome = 'cancelled', error_code = 'superseded', state = 'finished', updated_at = ?
               WHERE round_id = ? AND state <> 'finished'"#,
        )
        .bind(now)
        .bind(&round_id)
        .execute(&mut *conn)
        .await?;
        sqlx::query(
            r#"UPDATE collaboration_space_deliveries
               SET receipt_state = 'cancelled', receipt_updated_at = ?
               WHERE round_id = ? AND receipt_state IN ('queued', 'processing')"#,
        )
        .bind(now)
        .bind(&round_id)
        .execute(&mut *conn)
        .await?;
        if space_tracks_events(space_id) {
            let event_seq: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM collaboration_space_events WHERE space_id = ?",
            )
            .bind(space_id)
            .fetch_one(&mut *conn)
            .await?;
            let payload = json!({
                "action": "round_superseded",
                "round_id": round_id,
                "state": "superseded",
                "outcome": "cancelled",
                "error_code": "superseded",
            });
            sqlx::query(
                r#"INSERT INTO collaboration_space_events
                   (space_id, seq, kind, message_id, payload_json, created_at)
                   VALUES (?, ?, 'turn', ?, ?, ?)"#,
            )
            .bind(space_id)
            .bind(event_seq)
            .bind(&root_message_id)
            .bind(payload.to_string())
            .bind(now)
            .execute(&mut *conn)
            .await?;
        }
        round_ids.push(round_id);
    }
    Ok(round_ids)
}

pub(crate) fn space_tracks_turns(space_id: &str) -> bool {
    parse_unassigned_space_id(space_id).is_none()
}

pub(crate) fn is_unique_violation(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(err) => {
            err.is_unique_violation()
                || err.code().as_deref() == Some("2067")
                || err.message().contains("UNIQUE constraint failed")
                || err.message().contains("collaboration_turns_open")
        }
        _ => false,
    }
}

pub(crate) fn envelope_in_reply_to(envelope: &Value) -> Option<String> {
    parse_space_envelope(envelope).reply_to
}

pub(crate) fn envelope_sender_conversation(envelope: &Value) -> Option<Uuid> {
    parse_space_envelope(envelope).conversation_id
}

pub(crate) async fn parent_turn_row(
    pool: &SqlitePool,
    envelope: &Value,
) -> Result<Option<(String, Option<String>)>, CollaborationError> {
    let Some(parent_message_id) = envelope_in_reply_to(envelope) else {
        return Ok(None);
    };
    let Some(sender) = envelope_sender_conversation(envelope) else {
        return Ok(None);
    };
    sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT id, root_turn_id FROM collaboration_turns
           WHERE space_message_id = ? AND conversation_id = ?
           ORDER BY created_at DESC LIMIT 1"#,
    )
    .bind(parent_message_id)
    .bind(sender.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)
}

/// Create a running turn for a delivery that obtained an `input_id`.
/// Reuses an existing unfinished turn on unique-index conflict.
pub(crate) async fn bind_delivery_turn(
    pool: &SqlitePool,
    space_id: &str,
    message_id: &str,
    conversation_id: Uuid,
    envelope: &Value,
    round_id: Option<&str>,
    round_ordinal: Option<i64>,
) -> Result<Option<String>, CollaborationError> {
    if !space_tracks_turns(space_id) {
        return Ok(None);
    }
    let now = now_stamp();
    let deadline = stamp(Utc::now() + Duration::minutes(collab_turn_timeout_minutes()));
    let turn_id = Uuid::new_v4().to_string();
    let parent = parent_turn_row(pool, envelope).await?;
    let parent_turn_id = parent.as_ref().map(|(id, _)| id.clone());
    let root_turn_id = parent
        .as_ref()
        .and_then(|(_, root)| root.clone())
        .or_else(|| parent_turn_id.clone())
        .unwrap_or_else(|| turn_id.clone());
    let inserted = sqlx::query(
        r#"INSERT INTO collaboration_turns(
               id, space_id, space_message_id, conversation_id,
               state, deadline_at, parent_turn_id, root_turn_id, round_id, round_ordinal,
               created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&turn_id)
    .bind(space_id)
    .bind(message_id)
    .bind(conversation_id.to_string())
    .bind(&deadline)
    .bind(parent_turn_id.as_deref())
    .bind(&root_turn_id)
    .bind(round_id)
    .bind(round_ordinal)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await;
    match inserted {
        Ok(_) => {
            let _ = append_space_event_pool(
                pool,
                space_id,
                "turn",
                Some(message_id),
                &json!({
                    "action": "started",
                    "turn_id": turn_id,
                    "conversation_id": conversation_id.to_string(),
                    "round_id": round_id,
                    "round_ordinal": round_ordinal,
                }),
            )
            .await;
            Ok(Some(turn_id))
        }
        Err(error) if is_unique_violation(&error) => {
            let existing: Option<String> = sqlx::query_scalar(
                r#"SELECT id FROM collaboration_turns
                   WHERE space_message_id = ? AND conversation_id = ?
                     AND state <> 'finished'
                   LIMIT 1"#,
            )
            .bind(message_id)
            .bind(conversation_id.to_string())
            .fetch_optional(pool)
            .await
            .map_err(db)?;
            tracing::warn!(
                %space_id,
                %message_id,
                %conversation_id,
                existing = existing.as_deref().unwrap_or(""),
                "reusing unfinished collaboration turn instead of inserting a second open turn"
            );
            Ok(existing)
        }
        Err(error) => Err(db(error)),
    }
}

pub(crate) async fn finish_open_turn(
    pool: &SqlitePool,
    message_id: &str,
    conversation_id: Uuid,
    outcome: &str,
) -> Result<(), CollaborationError> {
    sqlx::query(
        r#"UPDATE collaboration_turns
           SET outcome = ?, state = 'finished', updated_at = ?
           WHERE space_message_id = ? AND conversation_id = ? AND state <> 'finished'"#,
    )
    .bind(outcome)
    .bind(now_stamp())
    .bind(message_id)
    .bind(conversation_id.to_string())
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

pub(crate) async fn close_processing_delivery(
    pool: &SqlitePool,
    conversation_id: Uuid,
    message_id: &str,
    turn_id: Option<&str>,
    outcome: &str,
    receipt_state: &str,
) -> Result<(), CollaborationError> {
    let now = now_stamp();
    sqlx::query(
        r#"UPDATE collaboration_space_deliveries
           SET receipt_state = ?, receipt_updated_at = ?
           WHERE conversation_id = ?
             AND space_message_id = ?
             AND receipt_state IN ('queued', 'processing')"#,
    )
    .bind(receipt_state)
    .bind(&now)
    .bind(conversation_id.to_string())
    .bind(message_id)
    .execute(pool)
    .await
    .map_err(db)?;
    if let Some(turn_id) = turn_id {
        sqlx::query(
            r#"UPDATE collaboration_turns
               SET outcome = ?, state = 'finished', updated_at = ?
               WHERE id = ? AND state <> 'finished'"#,
        )
        .bind(outcome)
        .bind(&now)
        .bind(turn_id)
        .execute(pool)
        .await
        .map_err(db)?;
    } else {
        finish_open_turn(pool, message_id, conversation_id, outcome).await?;
    }
    if let Ok(Some(space_id)) = sqlx::query_scalar::<_, String>(
        "SELECT space_id FROM collaboration_space_messages WHERE id = ?",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await
    {
        let _ = append_space_event_pool(
            pool,
            &space_id,
            "turn",
            Some(message_id),
            &json!({
                "action": "finished",
                "turn_id": turn_id,
                "conversation_id": conversation_id.to_string(),
                "outcome": outcome,
                "receipt_state": receipt_state,
            }),
        )
        .await;
    }
    Ok(())
}

pub async fn advance_round(
    pool: &SqlitePool,
    round_id: &str,
    delivery_ctx: &DeliveryContext,
) -> Result<bool, CollaborationError> {
    let row: Option<(String, String, String, i64, String)> = sqlx::query_as(
        r#"SELECT space_id, root_message_id, state, current_ordinal, deadline_at
           FROM collaboration_rounds
           WHERE id = ?"#,
    )
    .bind(round_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some((space_id, root_message_id, state, mut current_ordinal, deadline_at)) = row else {
        return Ok(false);
    };
    if state != "open" && state != "closing" {
        return Ok(false);
    }
    let now = now_stamp();
    if deadline_at <= now {
        sqlx::query(
            r#"UPDATE collaboration_rounds
               SET state = 'closed', updated_at = ?
               WHERE id = ? AND state IN ('open', 'closing')"#,
        )
        .bind(&now)
        .bind(round_id)
        .execute(pool)
        .await
        .map_err(db)?;
        sqlx::query(
            r#"UPDATE collaboration_turns
               SET state = 'finished', outcome = 'timeout', error_code = 'round_timeout', updated_at = ?
               WHERE round_id = ? AND state <> 'finished'"#,
        )
        .bind(&now)
        .bind(round_id)
        .execute(pool)
        .await
        .map_err(db)?;
        sqlx::query(
            r#"UPDATE collaboration_space_deliveries
               SET receipt_state = 'timed_out', receipt_updated_at = ?
               WHERE round_id = ? AND receipt_state IN ('queued', 'processing')"#,
        )
        .bind(&now)
        .bind(round_id)
        .execute(pool)
        .await
        .map_err(db)?;
        let _ = append_space_event_pool(
            pool,
            &space_id,
            "turn",
            Some(&root_message_id),
            &json!({
                "action": "round_timeout",
                "round_id": round_id,
            }),
        )
        .await;
        return Ok(true);
    }

    let mut progressed = false;
    loop {
        let cur_deliv: Option<(String, Option<String>)> = sqlx::query_as(
            r#"SELECT receipt_state, turn_id
               FROM collaboration_space_deliveries
               WHERE round_id = ? AND round_ordinal = ?
               LIMIT 1"#,
        )
        .bind(round_id)
        .bind(current_ordinal)
        .fetch_optional(pool)
        .await
        .map_err(db)?;
        let Some((receipt_state, turn_id)) = cur_deliv else {
            break;
        };
        let mut is_terminal = matches!(
            receipt_state.as_str(),
            "replied" | "passed" | "timed_out" | "cancelled" | "failed"
        );
        if !is_terminal && let Some(tid) = turn_id.as_deref() {
            let turn_state: Option<String> =
                sqlx::query_scalar("SELECT state FROM collaboration_turns WHERE id = ?")
                    .bind(tid)
                    .fetch_optional(pool)
                    .await
                    .map_err(db)?;
            if turn_state.as_deref() == Some("finished") {
                is_terminal = true;
            }
        }
        if !is_terminal
            && !round_slot_is_detachable(
                pool,
                &space_id,
                round_id,
                current_ordinal,
                &receipt_state,
                turn_id.as_deref(),
            )
            .await?
        {
            return Ok(progressed);
        }

        let next_ordinal: Option<i64> = sqlx::query_scalar(
            r#"SELECT MIN(round_ordinal)
               FROM collaboration_space_deliveries
               WHERE round_id = ? AND round_ordinal > ?"#,
        )
        .bind(round_id)
        .bind(current_ordinal)
        .fetch_optional(pool)
        .await
        .map_err(db)?
        .flatten();

        if let Some(next_ord) = next_ordinal {
            let res = sqlx::query(
                r#"UPDATE collaboration_rounds
                   SET current_ordinal = ?, updated_at = ?
                   WHERE id = ? AND current_ordinal = ? AND state IN ('open', 'closing')"#,
            )
            .bind(next_ord)
            .bind(&now)
            .bind(round_id)
            .bind(current_ordinal)
            .execute(pool)
            .await
            .map_err(db)?;
            if res.rows_affected() == 0 {
                return Ok(progressed);
            }
            progressed = true;
            current_ordinal = next_ord;
            let _ = deliver_pending(pool, &space_id, &root_message_id, delivery_ctx).await;
            let next_state: Option<(String, Option<String>)> = sqlx::query_as(
                r#"SELECT receipt_state, input_id
                   FROM collaboration_space_deliveries
                   WHERE round_id = ? AND round_ordinal = ?
                   LIMIT 1"#,
            )
            .bind(round_id)
            .bind(current_ordinal)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
            if let Some((rs, inp)) = next_state
                && (rs == "processing" || (rs == "queued" && inp.is_some()))
            {
                return Ok(true);
            }
        } else if round_has_unfinished_slots(pool, round_id).await? {
            return Ok(progressed);
        } else {
            break;
        }
    }

    sqlx::query(
        r#"UPDATE collaboration_rounds
           SET state = 'closed', updated_at = ?
           WHERE id = ? AND state IN ('open', 'closing')"#,
    )
    .bind(&now)
    .bind(round_id)
    .execute(pool)
    .await
    .map_err(db)?;
    let _ = append_space_event_pool(
        pool,
        &space_id,
        "turn",
        Some(&root_message_id),
        &json!({
            "action": "round_closed",
            "round_id": round_id,
        }),
    )
    .await;
    Ok(true)
}

async fn round_slot_is_detachable(
    pool: &SqlitePool,
    space_id: &str,
    round_id: &str,
    ordinal: i64,
    receipt_state: &str,
    turn_id: Option<&str>,
) -> Result<bool, CollaborationError> {
    if !matches!(receipt_state, "queued" | "processing") {
        return Ok(false);
    }
    let row: Option<(String, Option<String>, Option<String>, String)> = sqlx::query_as(
        r#"SELECT d.conversation_id, d.receipt_updated_at, t.created_at, d.space_message_id
           FROM collaboration_space_deliveries d
           LEFT JOIN collaboration_turns t ON t.id = d.turn_id
           WHERE d.round_id = ? AND d.round_ordinal = ?
           LIMIT 1"#,
    )
    .bind(round_id)
    .bind(ordinal)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some((conversation_id, receipt_updated_at, turn_created_at, space_message_id)) = row else {
        return Ok(false);
    };
    let Ok(cid) = Uuid::parse_str(&conversation_id) else {
        return Ok(false);
    };
    let trigger_seq: i64 =
        sqlx::query_scalar("SELECT seq FROM collaboration_space_messages WHERE id = ?")
            .bind(&space_message_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?
            .unwrap_or(0);
    if member_posted_after(pool, space_id, cid, trigger_seq).await? {
        return Ok(true);
    }
    if conversation_has_open_tool_calls(pool, cid).await? {
        return Ok(true);
    }
    let started = turn_created_at
        .as_deref()
        .or(receipt_updated_at.as_deref())
        .and_then(parse_stamp);
    if let Some(started) = started {
        let elapsed = Utc::now().signed_duration_since(started);
        if elapsed.num_seconds() >= collab_round_grace_secs() {
            return Ok(true);
        }
    }
    let _ = turn_id;
    Ok(false)
}

async fn conversation_has_open_tool_calls(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<bool, CollaborationError> {
    let found: Option<i64> = sqlx::query_scalar(
        r#"SELECT 1 FROM conversation_tool_calls tc
           JOIN conversation_turns t ON t.id = tc.turn_id
           WHERE t.conversation_id = ?
             AND t.status IN ('running', 'blocked', 'pending', 'queued')
           LIMIT 1"#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    Ok(found.is_some())
}

fn parse_stamp(raw: &str) -> Option<chrono::DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(raw.trim())
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

async fn round_has_unfinished_slots(
    pool: &SqlitePool,
    round_id: &str,
) -> Result<bool, CollaborationError> {
    let open: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM collaboration_space_deliveries
           WHERE round_id = ? AND receipt_state IN ('queued', 'processing')"#,
    )
    .bind(round_id)
    .fetch_one(pool)
    .await
    .map_err(db)?;
    Ok(open > 0)
}

pub async fn sweep_round_grace_detach(
    pool: &SqlitePool,
    delivery: &DeliveryContext,
) -> Result<usize, CollaborationError> {
    let round_ids: Vec<String> = sqlx::query_scalar(
        r#"SELECT id FROM collaboration_rounds
           WHERE state IN ('open', 'closing')
           ORDER BY created_at ASC"#,
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut advanced = 0usize;
    for round_id in round_ids {
        if advance_round(pool, &round_id, delivery).await? {
            advanced += 1;
        }
    }
    Ok(advanced)
}

pub(crate) async fn advance_open_rounds_for_space(
    pool: &SqlitePool,
    space_id: &str,
    delivery_ctx: &DeliveryContext,
) -> Result<(), CollaborationError> {
    let round_ids: Vec<String> = sqlx::query_scalar(
        r#"SELECT id FROM collaboration_rounds
           WHERE space_id = ? AND state IN ('open', 'closing')
           ORDER BY created_at ASC"#,
    )
    .bind(space_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    for round_id in round_ids {
        let _ = advance_round(pool, &round_id, delivery_ctx).await?;
    }
    Ok(())
}

pub(crate) async fn member_posted_after(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    after_seq: i64,
) -> Result<bool, CollaborationError> {
    let nickname = member_nickname(pool, space_id, conversation_id)
        .await
        .ok()
        .flatten();
    let rows: Vec<String> = sqlx::query_scalar(
        r#"SELECT envelope_json FROM collaboration_space_messages
           WHERE space_id = ? AND seq > ? AND origin = 'agent'
           ORDER BY seq ASC"#,
    )
    .bind(space_id)
    .bind(after_seq)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    Ok(rows.iter().any(|raw| {
        envelope_sender_is_conversation(
            &parse_space_envelope_str(raw),
            conversation_id,
            nickname.as_deref(),
        )
    }))
}

async fn member_posted_content_equals(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    after_seq: i64,
    body: &str,
    nickname: &str,
) -> Result<bool, CollaborationError> {
    let rows: Vec<String> = sqlx::query_scalar(
        r#"SELECT envelope_json FROM collaboration_space_messages
           WHERE space_id = ? AND seq > ? AND origin = 'agent'
           ORDER BY seq ASC"#,
    )
    .bind(space_id)
    .bind(after_seq)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    Ok(rows.iter().any(|raw| {
        let parsed = parse_space_envelope_str(raw);
        envelope_sender_is_conversation(&parsed, conversation_id, Some(nickname))
            && strip_own_nickname_prefix(&parsed.content, nickname) == body
    }))
}

pub(crate) async fn message_actor_conversation(
    pool: &SqlitePool,
    message_id: &str,
) -> Result<Option<Uuid>, CollaborationError> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT envelope_json FROM collaboration_space_messages WHERE id = ?")
            .bind(message_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let envelope: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    Ok(envelope_sender_conversation(&envelope))
}

/// Finalize any unclosed `receipt_state = 'processing'` deliveries for `conversation_id`
/// when its turn completes without having called `post_to_space`.
pub async fn finalize_space_turn_deliveries(
    pool: &SqlitePool,
    conversation_id: Uuid,
    turn_assistant_text: &str,
    delivery: &DeliveryContext,
) -> Result<Vec<CollaborationSpaceChangedEvent>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, String, i64, Option<String>)>(
        r#"SELECT m.space_id, d.space_message_id, m.seq, d.turn_id
           FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           LEFT JOIN collaboration_turns t ON t.id = d.turn_id
           WHERE d.conversation_id = ?
             AND (d.receipt_state = 'processing'
                  OR (d.receipt_state = 'queued' AND d.turn_id IS NOT NULL AND t.state <> 'finished'))
           ORDER BY m.seq ASC"#,
    )
    .bind(conversation_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db)?;

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let mut grouped: std::collections::BTreeMap<String, Vec<(String, i64, Option<String>)>> =
        std::collections::BTreeMap::new();
    for (space_id, message_id, seq, turn_id) in rows {
        grouped
            .entry(space_id)
            .or_default()
            .push((message_id, seq, turn_id));
    }

    let trimmed = turn_assistant_text.trim();
    let mut events = Vec::new();

    for (space_id, deliveries) in grouped {
        let Some((trigger_message_id, trigger_seq, _)) = deliveries.last().cloned() else {
            continue;
        };
        if !space_tracks_turns(&space_id) {
            sqlx::query(
                r#"UPDATE collaboration_space_deliveries
                   SET receipt_state = 'replied', receipt_updated_at = ?
                   WHERE conversation_id = ?
                     AND receipt_state = 'processing'
                     AND space_message_id IN (
                       SELECT id FROM collaboration_space_messages WHERE space_id = ?
                     )"#,
            )
            .bind(now_stamp())
            .bind(conversation_id.to_string())
            .bind(&space_id)
            .execute(pool)
            .await
            .map_err(db)?;
            continue;
        }

        let earliest_seq = deliveries
            .iter()
            .map(|(_, seq, _)| *seq)
            .min()
            .unwrap_or(trigger_seq);
        let already_posted =
            member_posted_after(pool, &space_id, conversation_id, earliest_seq).await?;

        let nickname = finalize_nickname(pool, &space_id, conversation_id).await;
        let body = strip_own_nickname_prefix(trimmed, &nickname);
        let posted_same_body = already_posted
            && member_posted_content_equals(
                pool,
                &space_id,
                conversation_id,
                earliest_seq,
                &body,
                &nickname,
            )
            .await?;
        let passed = body.is_empty() || is_pass_token(&body) || is_polite_ack_only(&body);
        if body.is_empty() {
            tracing::info!(
                %conversation_id,
                reason = "empty_assistant_text",
                "collaboration turn passed"
            );
        } else if is_pass_token(&body) {
            tracing::info!(
                %conversation_id,
                reason = "pass_token",
                "collaboration turn passed"
            );
        } else if is_polite_ack_only(&body) {
            tracing::info!(
                %conversation_id,
                reason = "polite_ack_only",
                "collaboration turn passed"
            );
        }

        let mut fallback_posted = false;
        if !passed && !posted_same_body {
            let prefix = if is_bot_space(&space_id) {
                "finalize-dm-turn"
            } else {
                "finalize-space-turn"
            };
            let op_id = Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!(
                    "{}:{}:{}:{}",
                    prefix,
                    conversation_id,
                    trigger_message_id,
                    digest_text(&body)
                )
                .as_bytes(),
            );
            let to = implicit_space_recipients(pool, &space_id, conversation_id, &body).await?;
            match post_to_space_inner(
                pool,
                PostToSpace {
                    caller_id: Some(conversation_id),
                    space_id: space_id.clone(),
                    content: body,
                    summary: None,
                    to,
                    in_reply_to: Some(trigger_message_id.clone()),
                    operation_id: op_id,
                },
                delivery,
                false,
            )
            .await
            {
                Ok(_) => {
                    fallback_posted = true;
                    if let Ok(space) = load_space_or_unassigned(pool, &space_id).await
                        && let Ok(ws_id) = Uuid::parse_str(&space.workspace_id)
                    {
                        let evt = latest_space_changed_event(pool, ws_id, &space_id, None).await;
                        events.push(evt);
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        %conversation_id,
                        %space_id,
                        "fallback post_to_space on turn completion failed; marking receipt passed"
                    );
                }
            }
        }

        let sent = fallback_posted || already_posted;
        let (outcome, receipt_state) = if sent {
            ("sent", "replied")
        } else {
            ("pass", "passed")
        };

        for (message_id, _, turn_id) in &deliveries {
            close_processing_delivery(
                pool,
                conversation_id,
                message_id,
                turn_id.as_deref(),
                outcome,
                receipt_state,
            )
            .await?;
        }

        advance_open_rounds_for_space(pool, &space_id, delivery).await?;

        if !fallback_posted
            && let Ok(space) = load_space_or_unassigned(pool, &space_id).await
            && let Ok(ws_id) = Uuid::parse_str(&space.workspace_id)
        {
            let evt = latest_space_changed_event(pool, ws_id, &space_id, None).await;
            delivery.notify_space_changed(evt.clone());
            events.push(evt);
        }
    }

    Ok(events)
}

async fn finalize_nickname(pool: &SqlitePool, space_id: &str, conversation_id: Uuid) -> String {
    if let Ok(Some(name)) = member_nickname(pool, space_id, conversation_id).await {
        let name = name.trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }
    let Ok(Some(binding)) = seat_binding(pool, conversation_id).await else {
        return String::new();
    };
    sqlx::query_scalar::<_, String>("SELECT name FROM collaboration_members WHERE id = ?")
        .bind(&binding.member_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_default()
}

async fn implicit_space_recipients(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    content: &str,
) -> Result<Vec<String>, CollaborationError> {
    if is_bot_space(space_id) {
        return Ok(vec![ENVELOPE_USER_ACTOR.to_string()]);
    }
    let members = list_space_members(pool, space_id, MessageAudience::Agent)
        .await
        .unwrap_or_default();
    let mentioned = mentioned_local_bot_nicknames(content, &members, Some(conversation_id));
    if mentioned.is_empty() {
        Ok(vec![ENVELOPE_USER_ACTOR.to_string()])
    } else {
        Ok(mentioned)
    }
}
