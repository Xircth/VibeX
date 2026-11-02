use agents::ConversationEvent;
use chrono::{Duration, Utc};
use db::models::{
    collaboration_identity::{self as identity},
    conversation_event::AppendConversationEvent,
};
use serde::Serialize;
use serde_json::{Map, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::*;
use crate::ConversationEventAppender;

#[derive(Debug, Clone)]
pub struct PostToSpace {
    pub caller_id: Option<Uuid>,
    pub space_id: String,
    pub content: String,
    pub summary: Option<String>,
    pub to: Vec<String>,
    pub in_reply_to: Option<String>,
    pub operation_id: Uuid,
}

pub async fn post_to_space(
    pool: &SqlitePool,
    input: PostToSpace,
) -> Result<SpacePostResult, CollaborationError> {
    post_to_space_with(pool, input, &DeliveryContext::default()).await
}

pub async fn post_to_space_with(
    pool: &SqlitePool,
    input: PostToSpace,
    turn_delivery: &DeliveryContext,
) -> Result<SpacePostResult, CollaborationError> {
    post_to_space_inner(pool, input, turn_delivery, true).await
}

pub(crate) async fn post_to_space_inner(
    pool: &SqlitePool,
    mut input: PostToSpace,
    turn_delivery: &DeliveryContext,
    mirror_direct_to_events: bool,
) -> Result<SpacePostResult, CollaborationError> {
    if parse_unassigned_space_id(input.space_id.trim()).is_some() {
        return Err(CollaborationError::new(
            "invalid_space_for_direct_chat",
            "当前会话属于一对一私聊会话，无需调用 post_space_message 等群空间消息工具；请直接输出回复文本与用户交流。",
        ));
    }
    let content = input.content.trim().to_string();
    let content = content.as_str();
    if content.is_empty() {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "content must not be empty",
        ));
    }
    if let Some(caller_id) = input.caller_id {
        require_caller_thread(pool, caller_id, &input.space_id).await?;
    }
    let mut sender_nickname = None;
    let mut sender_member_id = None;
    let (actor, sender) = match input.caller_id {
        Some(caller_id) => {
            let member = caller_seat(pool, &input.space_id, caller_id).await?;
            let seat = seat_conversation(&member).unwrap_or(caller_id);
            sender_nickname = Some(member.nickname.clone());
            sender_member_id = Some(member.member_id.clone());
            (envelope_member_name(&member.nickname), Some(seat))
        }
        None => {
            ensure_user_member(pool, &input.space_id).await?;
            (ENVELOPE_USER_ACTOR.to_string(), None)
        }
    };
    let mut message_id = input.operation_id.to_string();
    let request = post_fingerprint(&input, content, &actor);
    if let Some(head) = load_message_head(pool, &message_id).await? {
        if head.space_id != input.space_id {
            return Err(CollaborationError::new(
                "not_found",
                "message was not found",
            ));
        }
        if same_post_request(
            pool,
            &message_id,
            &input.space_id,
            &request,
            &head.envelope_json,
        )
        .await?
        {
            return deliver_pending(pool, &input.space_id, &message_id, turn_delivery).await;
        }
        let head_parsed = parse_space_envelope_str(&head.envelope_json);
        if input.caller_id.is_some()
            && head_parsed.sender == envelope_member_name(&actor)
            && head_parsed.content != content
        {
            let derived_op_id = Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!("{}:{}:{}", input.operation_id, actor, digest_text(content)).as_bytes(),
            );
            input.operation_id = derived_op_id;
            message_id = derived_op_id.to_string();
            if let Some(derived_head) = load_message_head(pool, &message_id).await? {
                if derived_head.space_id != input.space_id {
                    return Err(CollaborationError::new(
                        "not_found",
                        "message was not found",
                    ));
                }
                if !same_post_request(
                    pool,
                    &message_id,
                    &input.space_id,
                    &request,
                    &derived_head.envelope_json,
                )
                .await?
                {
                    return Err(operation_conflict());
                }
                return deliver_pending(pool, &input.space_id, &message_id, turn_delivery).await;
            }
        } else {
            return Err(operation_conflict());
        }
    }
    let mut targets = resolve_targets(pool, &input.space_id, sender, &input.to, content).await?;
    if targets
        .iter()
        .any(|target| target.conversation_id.is_none())
    {
        let _ = ensure_user_member(pool, &input.space_id).await;
    }
    let wakes_agents = targets
        .iter()
        .any(|target| target.conversation_id.is_some());
    let (root_id, hop) = resolve_root_and_hop(
        pool,
        &input.space_id,
        &message_id,
        sender,
        input.in_reply_to.as_deref(),
        wakes_agents,
    )
    .await?;
    let hop_exceeded = sender.is_some() && wakes_agents && hop > MAX_ASSISTANT_HOPS_PER_ROOT;
    let is_real_group_space = !input.space_id.starts_with(identity::DIRECT_PREFIX)
        && parse_unassigned_space_id(&input.space_id).is_none();
    let agent_target_count = if hop_exceeded {
        0
    } else {
        targets
            .iter()
            .filter(|t| t.conversation_id.is_some())
            .count()
    };
    if is_real_group_space && !hop_exceeded && sender.is_none() {
        let _ = advance_open_rounds_for_space(pool, &input.space_id, turn_delivery).await;
    }
    let open_round = if is_real_group_space && !hop_exceeded {
        load_open_round(pool, &input.space_id).await?
    } else {
        None
    };
    let explicit_agent_wake = post_has_explicit_agent_wake(&input.to, content, &targets);
    let is_broadcast = post_is_broadcast(&input.to, content);
    // Person @two-or-more still opens a replacement round (and supersedes).
    // A bot @two-or-more only opens a round when the space has none to splice into.
    // Broadcast stays parallel: it is not a named handoff list.
    let is_round = is_real_group_space
        && agent_target_count >= 2
        && (sender.is_none() || (open_round.is_none() && !is_broadcast));
    let splice_into_open =
        is_real_group_space && !hop_exceeded && open_round.is_some() && !is_round;
    if is_round {
        sort_round_agent_targets(pool, &input.space_id, &input.to, content, &mut targets).await?;
    }
    let round_id = is_round.then(|| Uuid::new_v4().to_string());
    let round_deadline =
        is_round.then(|| stamp(Utc::now() + Duration::minutes(collab_round_timeout_minutes())));
    let mut queued_deliveries = Vec::new();
    let mut splice_ordinal_updates = Vec::new();
    let mut next_ordinal = 1_i64;
    if !hop_exceeded {
        if let (true, Some(open)) = (splice_into_open, open_round.as_ref()) {
            if explicit_agent_wake && !is_broadcast {
                let plan = plan_round_splice(
                    pool,
                    open,
                    sender,
                    &input.to,
                    content,
                    &targets,
                    input.operation_id,
                )
                .await?;
                splice_ordinal_updates = plan.updates;
                queued_deliveries = plan.inserts;
            } else if is_broadcast {
                for target in &targets {
                    let Some(target_id) = target.conversation_id else {
                        continue;
                    };
                    queued_deliveries.push(QueuedSpaceDelivery {
                        conversation_id: target_id,
                        operation_id: delivery_operation_id(input.operation_id, target_id),
                        round_id: None,
                        round_ordinal: None,
                    });
                }
            } else if sender.is_none() {
                queued_deliveries =
                    plan_untargeted_round_tail_append(pool, open, &targets, input.operation_id)
                        .await?;
            }
        } else {
            for target in &targets {
                let Some(target_id) = target.conversation_id else {
                    continue;
                };
                let ordinal = if round_id.is_some() {
                    let current = next_ordinal;
                    next_ordinal += 1;
                    Some(current)
                } else {
                    None
                };
                queued_deliveries.push(QueuedSpaceDelivery {
                    conversation_id: target_id,
                    operation_id: delivery_operation_id(input.operation_id, target_id),
                    round_id: round_id.clone(),
                    round_ordinal: ordinal,
                });
            }
        }
    }
    let summary = input
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| content.lines().next().unwrap_or(content).trim().to_string());
    let published = now_stamp();
    let sent_to = unique_cross_chat_peers(&input.space_id, &targets);
    let mut extra = Map::new();
    if !sent_to.is_empty() {
        extra.insert("crossChatSentTo".to_string(), json!(sent_to));
    }
    let envelope = build_space_envelope(NewSpaceEnvelope {
        id: &message_id,
        sender: &actor,
        to: targets
            .iter()
            .map(|target| {
                if target.conversation_id.is_none() {
                    ENVELOPE_PERSON_SENDER.to_string()
                } else {
                    envelope_member_name(&target.nickname)
                }
            })
            .collect(),
        content,
        reply_to: input.in_reply_to.as_deref(),
        published: &published,
        summary: Some(summary.as_str()),
        conversation_id: sender,
        extra,
    });
    let origin = if sender.is_some() { "agent" } else { "user" };
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let inserted = async {
        if sender.is_none() && is_real_group_space && is_round {
            supersede_open_rounds_tx(&mut conn, &input.space_id, &published).await?;
        }
        if let (Some(rid), Some(deadline)) = (&round_id, &round_deadline) {
            sqlx::query(
                r#"INSERT INTO collaboration_rounds
                   (id, space_id, root_message_id, state, current_ordinal, deadline_at, created_at, updated_at)
                   VALUES (?, ?, ?, 'open', 1, ?, ?, ?)"#,
            )
            .bind(rid)
            .bind(&input.space_id)
            .bind(&message_id)
            .bind(deadline)
            .bind(&published)
            .bind(&published)
            .execute(&mut *conn)
            .await?;
        }
        let seq = insert_space_message_tx(
            &mut conn,
            &input.space_id,
            &message_id,
            &envelope,
            &published,
            origin,
            &root_id,
            hop,
            &queued_deliveries,
        )
        .await?;
        for (conversation_id, space_message_id, ordinal, rebind_to_new_message) in
            &splice_ordinal_updates
        {
            if *rebind_to_new_message
                && let Ok(target_uuid) = Uuid::parse_str(conversation_id)
            {
                let new_op_id = delivery_operation_id(input.operation_id, target_uuid).to_string();
                sqlx::query(
                    r#"UPDATE collaboration_space_deliveries
                       SET round_ordinal = ?, space_message_id = ?, operation_id = ?
                       WHERE round_id = ? AND conversation_id = ? AND space_message_id = ?"#,
                )
                .bind(ordinal)
                .bind(&message_id)
                .bind(new_op_id)
                .bind(open_round.as_ref().map(|round| round.id.as_str()))
                .bind(conversation_id)
                .bind(space_message_id)
                .execute(&mut *conn)
                .await?;
            } else {
                sqlx::query(
                    r#"UPDATE collaboration_space_deliveries
                       SET round_ordinal = ?
                       WHERE round_id = ? AND conversation_id = ? AND space_message_id = ?"#,
                )
                .bind(ordinal)
                .bind(open_round.as_ref().map(|round| round.id.as_str()))
                .bind(conversation_id)
                .bind(space_message_id)
                .execute(&mut *conn)
                .await?;
            }
        }
        if let Some(rid) = &round_id
            && space_tracks_events(&input.space_id)
        {
            let event_seq: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM collaboration_space_events WHERE space_id = ?",
            )
            .bind(&input.space_id)
            .fetch_one(&mut *conn)
            .await?;
            let payload = json!({
                "action": "round_opened",
                "round_id": rid,
                "state": "open",
                "current_ordinal": 1,
                "total": queued_deliveries.len(),
            });
            sqlx::query(
                r#"INSERT INTO collaboration_space_events
                   (space_id, seq, kind, message_id, payload_json, created_at)
                   VALUES (?, ?, 'turn', ?, ?, ?)"#,
            )
            .bind(&input.space_id)
            .bind(event_seq)
            .bind(&message_id)
            .bind(payload.to_string())
            .bind(&published)
            .execute(&mut *conn)
            .await?;
        }
        let is_card_post = content.trim_start().starts_with("<card ");
        let is_pure_cross_chat_post = !sent_to.is_empty()
            && !targets.is_empty()
            && targets.iter().all(|target| {
                target
                    .dest_thread_id
                    .as_deref()
                    .is_some_and(|dest| dest != input.space_id)
            });
        if let Some(sender) = sender
            && !is_card_post
            && !is_pure_cross_chat_post
        {
            // Mid-turn posts in an open sequential round (and interactive <card>
            // posts such as ask/approval, or pure cross-space deliveries to
            // another space) are progress, not the slot's closing reply in this
            // space. Those deliveries stay processing so
            // finalize_space_turn_deliveries can still post the implicit text.
            let closed_deliveries: Vec<String> = sqlx::query_scalar(
                r#"SELECT d.space_message_id FROM collaboration_space_deliveries d
                   WHERE d.conversation_id = ?
                     AND (
                       d.receipt_state = 'processing'
                       OR (
                         d.receipt_state = 'queued'
                         AND (
                           d.status = 'dispatched'
                           OR NOT EXISTS (
                             SELECT 1 FROM collaboration_space_deliveries d2
                             WHERE d2.conversation_id = d.conversation_id
                               AND (d2.receipt_state = 'processing' OR d2.status = 'dispatched')
                           )
                         )
                       )
                     )
                     AND (
                       d.space_message_id IN (
                         SELECT id FROM collaboration_space_messages
                         WHERE space_id = ? AND seq < ?
                       )
                       OR EXISTS (
                         SELECT 1 FROM collaboration_turns ct
                         WHERE ct.id = d.turn_id
                           AND ct.space_id = ?
                           AND ct.state <> 'finished'
                       )
                     )
                     AND (d.round_id IS NULL OR d.round_id NOT IN (
                       SELECT id FROM collaboration_rounds
                       WHERE state IN ('open', 'closing')
                     ))"#,
            )
            .bind(sender.to_string())
            .bind(&input.space_id)
            .bind(seq)
            .bind(&input.space_id)
            .fetch_all(&mut *conn)
            .await?;
            for closed_msg_id in &closed_deliveries {
                sqlx::query(
                    r#"UPDATE collaboration_space_deliveries
                       SET receipt_state = 'replied', receipt_updated_at = ?
                       WHERE conversation_id = ?
                         AND space_message_id = ?
                         AND receipt_state IN ('queued', 'processing')"#,
                )
                .bind(&published)
                .bind(sender.to_string())
                .bind(closed_msg_id)
                .execute(&mut *conn)
                .await?;
                sqlx::query(
                    r#"UPDATE collaboration_turns
                       SET outcome = 'sent', state = 'finished', updated_at = ?
                       WHERE conversation_id = ?
                         AND space_message_id = ?
                         AND state <> 'finished'"#,
                )
                .bind(&published)
                .bind(sender.to_string())
                .bind(closed_msg_id)
                .execute(&mut *conn)
                .await?;
            }
            if space_tracks_events(&input.space_id) {
                for closed_msg_id in closed_deliveries {
                    let event_seq: i64 = sqlx::query_scalar(
                        "SELECT COALESCE(MAX(seq), 0) + 1 FROM collaboration_space_events WHERE space_id = ?",
                    )
                    .bind(&input.space_id)
                    .fetch_one(&mut *conn)
                    .await?;
                    let payload = json!({
                        "action": "finished",
                        "conversation_id": sender,
                        "outcome": "sent",
                        "receipt_state": "replied",
                    });
                    sqlx::query(
                        r#"INSERT INTO collaboration_space_events
                           (space_id, seq, kind, message_id, payload_json, created_at)
                           VALUES (?, ?, 'turn', ?, ?, ?)"#,
                    )
                    .bind(&input.space_id)
                    .bind(event_seq)
                    .bind(&closed_msg_id)
                    .bind(payload.to_string())
                    .bind(&published)
                    .execute(&mut *conn)
                    .await?;
                }
            }
        }
        Ok::<i64, sqlx::Error>(seq)
    }
    .await;
    let seq = match inserted {
        Ok(seq) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(db)?;
            seq
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(db(error));
        }
    };
    drop(conn);
    store_operation(
        pool,
        &message_id,
        Some(&input.space_id),
        &request,
        &json!({ "message_id": message_id }),
    )
    .await?;
    let dests = unique_cross_chat_dests(&input.space_id, &targets);
    if !dests.is_empty() {
        let received_from = sender_received_from_peer(
            pool,
            &input.space_id,
            sender,
            sender_nickname.as_deref(),
            sender_member_id.as_deref(),
        )
        .await?;
        project_cross_chat_receipts(
            pool,
            &message_id,
            &actor,
            sender,
            &published,
            origin,
            &received_from,
            &dests,
            turn_delivery,
        )
        .await?;
    }
    let result = deliver_pending(pool, &input.space_id, &message_id, turn_delivery)
        .await
        .map(|mut result| {
            result.seq = seq;
            result
        })?;
    let concurrency_held = !is_round
        && !splice_into_open
        && result.receipts.iter().any(|receipt| {
            receipt.delivered == "queued"
                && receipt.input_id.is_none()
                && receipt.error_code.is_none()
        });
    if hop_exceeded || concurrency_held {
        insert_collaboration_limit_notice(pool, &input.space_id).await?;
    }
    let is_card_post = content.starts_with("<card kind=\"");
    if mirror_direct_to_events
        && !is_card_post
        && input.space_id.starts_with(identity::DIRECT_PREFIX)
        && let Some(sender) = sender
    {
        project_direct_space_post(pool, sender, &message_id, content).await?;
    }
    if sender.is_some() && !is_card_post {
        advance_open_rounds_for_space(pool, &input.space_id, turn_delivery).await?;
    }
    Ok(result)
}

pub(crate) fn bare_message_id(raw: &str) -> &str {
    raw.trim()
}

pub(crate) async fn load_hop_parent(
    pool: &SqlitePool,
    space_id: &str,
    in_reply_to: Option<&str>,
) -> Result<Option<HopHead>, CollaborationError> {
    if let Some(parent_id) = in_reply_to.map(bare_message_id).filter(|id| !id.is_empty()) {
        if let Some(head) = HopHead::find_by_id_in_space(pool, parent_id, space_id)
            .await
            .map_err(db)?
        {
            return Ok(Some(head));
        }
        let recv_id = cross_chat_receipt_message_id(parent_id, space_id);
        return HopHead::find_by_id_in_space(pool, &recv_id, space_id)
            .await
            .map_err(db);
    }
    HopHead::find_latest_non_system_in_space(pool, space_id)
        .await
        .map_err(db)
}
pub(crate) async fn resolve_root_and_hop(
    pool: &SqlitePool,
    space_id: &str,
    message_id: &str,
    sender: Option<Uuid>,
    in_reply_to: Option<&str>,
    wakes_agents: bool,
) -> Result<(String, i64), CollaborationError> {
    if sender.is_none() {
        return Ok((message_id.to_string(), 0));
    }
    let Some(parent) = load_hop_parent(pool, space_id, in_reply_to).await? else {
        return Ok((message_id.to_string(), 0));
    };
    let root_id = parent
        .root_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or(parent.id);
    let hop = if wakes_agents {
        parent.hop.saturating_add(1)
    } else {
        parent.hop
    };
    Ok((root_id, hop))
}

struct OpenRound {
    id: String,
    current_ordinal: i64,
}

struct RoundSplicePlan {
    updates: Vec<(String, String, i64, bool)>,
    inserts: Vec<QueuedSpaceDelivery>,
}

fn post_is_broadcast(to: &[String], content: &str) -> bool {
    crate::collaboration::routing::contains_broadcast_mention(content)
        || to.iter().any(|raw| is_broadcast_target_name(raw))
}

fn post_has_explicit_agent_wake(
    to: &[String],
    content: &str,
    targets: &[super::ResolvedTarget],
) -> bool {
    let explicit_to = to.iter().any(|raw| {
        let name = raw.trim().trim_start_matches('@').trim();
        !name.is_empty() && !crate::collaboration::routing::is_user_target_name(name)
    });
    if explicit_to || crate::collaboration::routing::contains_broadcast_mention(content) {
        return true;
    }
    targets.iter().any(|target| {
        target.conversation_id.is_some()
            && crate::collaboration::routing::contains_mention_token(content, &target.nickname)
    })
}

async fn load_open_round(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<Option<OpenRound>, CollaborationError> {
    let row: Option<(String, i64)> = sqlx::query_as(
        r#"SELECT id, current_ordinal FROM collaboration_rounds
           WHERE space_id = ? AND state IN ('open', 'closing')
           ORDER BY created_at ASC LIMIT 1"#,
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    Ok(row.map(|(id, current_ordinal)| OpenRound {
        id,
        current_ordinal,
    }))
}

fn sort_splice_targets(to: &[String], content: &str, targets: &mut [super::ResolvedTarget]) {
    let explicit_to: Vec<String> = to
        .iter()
        .map(|name| name.trim().trim_start_matches('@').trim().to_string())
        .filter(|name| {
            !name.is_empty()
                && !is_broadcast_target_name(name)
                && !crate::collaboration::routing::is_user_target_name(name)
        })
        .collect();
    targets.sort_by(|a, b| {
        let a_to = explicit_to
            .iter()
            .position(|name| {
                name == &a.nickname || a.conversation_id.is_some_and(|id| id.to_string() == *name)
            })
            .unwrap_or(usize::MAX);
        let b_to = explicit_to
            .iter()
            .position(|name| {
                name == &b.nickname || b.conversation_id.is_some_and(|id| id.to_string() == *name)
            })
            .unwrap_or(usize::MAX);
        let a_mention = first_mention_offset(content, &a.nickname).unwrap_or(usize::MAX);
        let b_mention = first_mention_offset(content, &b.nickname).unwrap_or(usize::MAX);
        (a_to, a_mention, &a.nickname).cmp(&(b_to, b_mention, &b.nickname))
    });
}

async fn plan_untargeted_round_tail_append(
    pool: &SqlitePool,
    open: &OpenRound,
    targets: &[super::ResolvedTarget],
    operation_id: Uuid,
) -> Result<Vec<QueuedSpaceDelivery>, CollaborationError> {
    let waiting_count: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM collaboration_space_deliveries
           WHERE round_id = ? AND round_ordinal > ? AND receipt_state IN ('queued', 'processing')"#,
    )
    .bind(&open.id)
    .bind(open.current_ordinal)
    .fetch_one(pool)
    .await
    .map_err(db)?;
    if waiting_count > 0 {
        return Ok(Vec::new());
    }
    let speaking: Vec<String> = sqlx::query_scalar(
        r#"SELECT conversation_id FROM collaboration_space_deliveries
           WHERE round_id = ? AND (round_ordinal = ? OR receipt_state = 'processing')"#,
    )
    .bind(&open.id)
    .bind(open.current_ordinal)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let max_ordinal: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(round_ordinal), ?) FROM collaboration_space_deliveries WHERE round_id = ?",
    )
    .bind(open.current_ordinal)
    .bind(&open.id)
    .fetch_one(pool)
    .await
    .map_err(db)?;
    let mut next_ordinal = max_ordinal + 1;
    let mut inserts = Vec::new();
    for target in targets {
        if target.dest_thread_id.is_some() {
            continue;
        }
        let Some(target_id) = target.conversation_id else {
            continue;
        };
        if speaking.iter().any(|cid| cid == &target_id.to_string()) {
            continue;
        }
        inserts.push(QueuedSpaceDelivery {
            conversation_id: target_id,
            operation_id: delivery_operation_id(operation_id, target_id),
            round_id: Some(open.id.clone()),
            round_ordinal: Some(next_ordinal),
        });
        next_ordinal += 1;
    }
    Ok(inserts)
}

async fn plan_round_splice(
    pool: &SqlitePool,
    open: &OpenRound,
    sender: Option<Uuid>,
    to: &[String],
    content: &str,
    targets: &[super::ResolvedTarget],
    operation_id: Uuid,
) -> Result<RoundSplicePlan, CollaborationError> {
    let slots: Vec<(String, i64, String, String)> = sqlx::query_as(
        r#"SELECT conversation_id, COALESCE(round_ordinal, 0), receipt_state, space_message_id
           FROM collaboration_space_deliveries
           WHERE round_id = ?
           ORDER BY COALESCE(round_ordinal, 0) ASC"#,
    )
    .bind(&open.id)
    .fetch_all(pool)
    .await
    .map_err(db)?;

    let mut local_targets: Vec<super::ResolvedTarget> = targets
        .iter()
        .filter(|target| {
            target.dest_thread_id.is_none()
                && target.conversation_id.is_some_and(|id| Some(id) != sender)
        })
        .cloned()
        .collect();
    sort_splice_targets(to, content, &mut local_targets);

    let speaking: std::collections::HashSet<String> = slots
        .iter()
        .filter(|(_, ordinal, state, _)| *ordinal == open.current_ordinal || state == "processing")
        .map(|(conversation_id, _, _, _)| conversation_id.clone())
        .collect();
    let waiting_by_conversation: std::collections::HashMap<String, (i64, String, String)> = slots
        .iter()
        .filter(|(_, ordinal, state, _)| *ordinal > open.current_ordinal && state == "queued")
        .map(|(conversation_id, ordinal, state, message_id)| {
            (
                conversation_id.clone(),
                (*ordinal, state.clone(), message_id.clone()),
            )
        })
        .collect();

    let mut next_ordinal = open.current_ordinal + 1;
    let mut updates = Vec::new();
    let mut inserts = Vec::new();
    let mut placed = std::collections::HashSet::new();

    for target in &local_targets {
        let Some(target_id) = target.conversation_id else {
            continue;
        };
        let key = target_id.to_string();
        if speaking.contains(&key) {
            if sender.is_none() {
                inserts.push(QueuedSpaceDelivery {
                    conversation_id: target_id,
                    operation_id: delivery_operation_id(operation_id, target_id),
                    round_id: None,
                    round_ordinal: None,
                });
            }
            continue;
        }
        placed.insert(key.clone());
        if let Some((_, _, message_id)) = waiting_by_conversation.get(&key) {
            updates.push((key, message_id.clone(), next_ordinal, true));
        } else {
            inserts.push(QueuedSpaceDelivery {
                conversation_id: target_id,
                operation_id: delivery_operation_id(operation_id, target_id),
                round_id: Some(open.id.clone()),
                round_ordinal: Some(next_ordinal),
            });
        }
        next_ordinal += 1;
    }

    let mut remaining: Vec<(String, String, i64)> = slots
        .iter()
        .filter(|(conversation_id, ordinal, state, _)| {
            !placed.contains(conversation_id)
                && !speaking.contains(conversation_id)
                && *ordinal > open.current_ordinal
                && (state == "queued" || state == "processing")
        })
        .map(|(conversation_id, ordinal, _, message_id)| {
            (conversation_id.clone(), message_id.clone(), *ordinal)
        })
        .collect();
    remaining.sort_by_key(|(_, _, ordinal)| *ordinal);
    for (conversation_id, message_id, _) in remaining {
        updates.push((conversation_id, message_id, next_ordinal, false));
        next_ordinal += 1;
    }

    for target in targets {
        if target.dest_thread_id.is_none() {
            continue;
        }
        let Some(target_id) = target.conversation_id else {
            continue;
        };
        if Some(target_id) == sender {
            continue;
        }
        inserts.push(QueuedSpaceDelivery {
            conversation_id: target_id,
            operation_id: delivery_operation_id(operation_id, target_id),
            round_id: None,
            round_ordinal: None,
        });
    }

    Ok(RoundSplicePlan { updates, inserts })
}

pub(crate) async fn insert_collaboration_limit_notice(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<(), CollaborationError> {
    let published = now_stamp();
    let message_id = Uuid::new_v4().to_string();
    let mut extra = Map::new();
    extra.insert(
        "content_en".to_string(),
        json!(COLLABORATION_LIMIT_NOTICE_EN),
    );
    let envelope = build_space_envelope(NewSpaceEnvelope {
        id: &message_id,
        sender: ENVELOPE_SYSTEM_SENDER,
        to: Vec::new(),
        content: COLLABORATION_LIMIT_NOTICE_ZH,
        reply_to: None,
        published: &published,
        summary: Some("collaboration_limit"),
        conversation_id: None,
        extra,
    });
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let inserted = insert_space_message_tx(
        &mut conn,
        space_id,
        &message_id,
        &envelope,
        &published,
        "system",
        &message_id,
        0,
        &[],
    )
    .await;
    match inserted {
        Ok(_) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(db)?;
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(db(error));
        }
    }
    Ok(())
}

/// Private-chat IM is projected from conversation events. Mirror a DM
/// `post_to_space` into the sender's log so the greeting appears there.
pub(crate) async fn project_direct_space_post(
    pool: &SqlitePool,
    conversation_id: Uuid,
    message_id: &str,
    content: &str,
) -> Result<(), CollaborationError> {
    let event = ConversationEvent::AssistantTextDelta {
        text: content.to_string(),
        message_id: Some(message_id.to_string()),
    };
    let normalized = serde_json::to_string(&event).map_err(|error| {
        CollaborationError::new("conversation_control_failed", error.to_string())
    })?;
    let key = format!("space-post:{message_id}");
    ConversationEventAppender::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: None,
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "host",
            event_kind: "assistant_text_delta",
            normalized_json: &normalized,
            raw_json: None,
            idempotency_key: Some(&key),
        },
    )
    .await
    .map_err(db)?;
    Ok(())
}

pub(crate) fn caller_may_cancel_turn(
    caller_id: Option<Uuid>,
    turn_conversation_id: Uuid,
    message_actor: Option<Uuid>,
) -> bool {
    match caller_id {
        None => true,
        Some(caller) => caller == turn_conversation_id || message_actor == Some(caller),
    }
}

/// Cancel an open collaboration turn (or every open turn for `message_id`).
pub async fn cancel_space_turn(
    pool: &SqlitePool,
    space_id: &str,
    message_id: Option<&str>,
    turn_id: Option<&str>,
    caller_id: Option<Uuid>,
) -> Result<Vec<String>, CollaborationError> {
    let default_ctx = DeliveryContext::default();
    cancel_space_turn_with(pool, space_id, message_id, turn_id, caller_id, &default_ctx).await
}

/// Cancel an open collaboration turn using the supplied [`DeliveryContext`].
pub async fn cancel_space_turn_with(
    pool: &SqlitePool,
    space_id: &str,
    message_id: Option<&str>,
    turn_id: Option<&str>,
    caller_id: Option<Uuid>,
    ctx: &DeliveryContext,
) -> Result<Vec<String>, CollaborationError> {
    if !space_tracks_turns(space_id) {
        return Err(CollaborationError::new(
            "invalid_space_for_direct_chat",
            "direct chats do not keep collaboration turns",
        ));
    }
    let turn_id = turn_id.map(str::trim).filter(|id| !id.is_empty());
    let message_id = message_id.map(str::trim).filter(|id| !id.is_empty());
    if turn_id.is_none() && message_id.is_none() {
        return Err(CollaborationError::new(
            "not_found",
            "turnId or messageId is required",
        ));
    }
    let rows = sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
        r#"SELECT t.id, t.space_id, t.space_message_id, t.conversation_id, t.round_id
           FROM collaboration_turns t
           LEFT JOIN collaboration_space_messages m ON m.id = t.space_message_id
           WHERE (t.space_id = ? OR m.space_id = ?)
             AND t.state <> 'finished'
             AND (? IS NULL OR t.id = ?)
             AND (? IS NULL OR t.space_message_id = ?)"#,
    )
    .bind(space_id)
    .bind(space_id)
    .bind(turn_id)
    .bind(turn_id)
    .bind(message_id)
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    if rows.is_empty() {
        return Err(CollaborationError::new("not_found", "turn was not found"));
    }
    let now = now_stamp();
    let mut cancelled = Vec::new();
    let mut rounds_to_advance = Vec::new();
    for (id, _turn_space, space_message_id, conversation_raw, round_id) in rows {
        let Ok(turn_conversation_id) = Uuid::parse_str(&conversation_raw) else {
            continue;
        };
        let actor = message_actor_conversation(pool, &space_message_id).await?;
        if !caller_may_cancel_turn(caller_id, turn_conversation_id, actor) {
            continue;
        }
        sqlx::query(
            r#"UPDATE collaboration_turns
               SET outcome = 'cancelled', state = 'finished', updated_at = ?
               WHERE id = ? AND state <> 'finished'"#,
        )
        .bind(&now)
        .bind(&id)
        .execute(pool)
        .await
        .map_err(db)?;
        sqlx::query(
            r#"UPDATE collaboration_space_deliveries
               SET receipt_state = 'cancelled', receipt_updated_at = ?
               WHERE turn_id = ? AND receipt_state IN ('queued', 'processing')"#,
        )
        .bind(&now)
        .bind(&id)
        .execute(pool)
        .await
        .map_err(db)?;
        let _ = append_space_event_pool(
            pool,
            space_id,
            "turn",
            Some(&space_message_id),
            &json!({
                "action": "cancelled",
                "turn_id": id,
                "conversation_id": turn_conversation_id.to_string(),
                "outcome": "cancelled",
                "receipt_state": "cancelled",
            }),
        )
        .await;
        if let Some(rid) = round_id {
            rounds_to_advance.push(rid);
        }
        cancelled.push(id);
    }
    if cancelled.is_empty() {
        return Err(CollaborationError::new(
            "out_of_scope",
            "caller cannot cancel this turn",
        ));
    }
    for rid in rounds_to_advance {
        let _ = advance_round(pool, &rid, ctx).await;
    }
    Ok(cancelled)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceTurnInterrupt {
    pub space_id: String,
    pub member_id: String,
    pub nickname: String,
    pub conversation_id: String,
    pub turn_ids: Vec<String>,
    pub active_turn_id: Option<String>,
    pub interrupted: bool,
}

/// Interrupt a member's in-flight turn in this group. Any agent seat of the
/// group may interrupt another agent seat; the space boundary is the whole
/// permission model, so direct chats and the unassigned space are rejected.
///
/// The Agent turn is the source of truth: it is stopped first, then the
/// collaboration ledger is closed so rounds can advance. A host without a
/// [`TurnInterruptor`] fails before touching the ledger instead of reporting an
/// interruption that never happened.
pub async fn interrupt_space_member_turn(
    pool: &SqlitePool,
    space_id: &str,
    caller_id: Uuid,
    member_ref: &str,
    reason: Option<&str>,
    delivery: &DeliveryContext,
) -> Result<SpaceTurnInterrupt, CollaborationError> {
    let space_id = space_id.trim();
    if space_id.is_empty() {
        return Err(CollaborationError::new(
            "invalid_argument",
            "space_id is required",
        ));
    }
    if space_id.starts_with(identity::DIRECT_PREFIX) {
        return Err(CollaborationError::new(
            "invalid_space_for_direct_chat",
            "direct chats do not keep collaboration turns",
        ));
    }
    roles::require_group_space(space_id)?;
    let space = load_space(pool, space_id).await?;

    let caller = match caller_seat(pool, space_id, caller_id).await {
        Ok(seat) => seat,
        Err(err) => {
            let caller_session = live_session(load_session(pool, caller_id).await?)?;
            if caller_session.workspace_id.to_string() == space.workspace_id
                && roles::is_caller_workspace_supervisor(pool, caller_id).await?
            {
                let caller_identity =
                    identity_member_id_for_conversation(pool, Some(&caller_id.to_string()))
                        .await?
                        .unwrap_or_else(|| caller_id.to_string());
                let nickname: String = sqlx::query_scalar(
                    "SELECT name FROM collaboration_members WHERE id = ? LIMIT 1",
                )
                .bind(&caller_identity)
                .fetch_optional(pool)
                .await
                .map_err(db)?
                .unwrap_or_else(|| "Supervisor".to_string());
                roles::MemberRecord {
                    member_id: caller_identity,
                    conversation_id: Some(caller_id.to_string()),
                    nickname,
                    kind: "agent".to_string(),
                    visible_to_agents: 1,
                }
            } else {
                return Err(err);
            }
        }
    };
    if caller.kind != "agent" {
        return Err(CollaborationError::new(
            "forbidden",
            "only an agent member can interrupt a turn",
        ));
    }
    let target = roles::resolve_space_agent_seat(pool, space_id, member_ref).await?;
    let caller_identity =
        identity_member_id_for_conversation(pool, Some(&caller_id.to_string())).await?;
    let target_identity =
        identity_member_id_for_conversation(pool, target.conversation_id.as_deref()).await?;
    if target.member_id == caller.member_id
        || (caller_identity.is_some() && caller_identity == target_identity)
    {
        return Err(CollaborationError::new(
            "invalid_argument",
            "a member cannot interrupt its own turn",
        ));
    }
    let Some(conversation_id) = target
        .conversation_id
        .as_deref()
        .and_then(|raw| Uuid::parse_str(raw).ok())
    else {
        return Err(CollaborationError::new(
            "not_found",
            "member has no conversation in this space",
        ));
    };
    let Some(interruptor) = delivery.interruptor.clone() else {
        return Err(CollaborationError::new(
            "unavailable",
            "this host cannot interrupt Agent turns",
        ));
    };

    let open_turns = sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT id, round_id FROM collaboration_turns
           WHERE space_id = ? AND conversation_id = ? AND state <> 'finished'
           ORDER BY created_at"#,
    )
    .bind(space_id)
    .bind(conversation_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db)?;
    if open_turns.is_empty() {
        return Err(CollaborationError::new(
            "not_found",
            "member has no running turn in this space",
        ));
    }

    let active_turn_id: Option<String> = sqlx::query_scalar(
        r#"SELECT turn.id FROM sessions conversation
           JOIN conversation_turns turn ON turn.id = conversation.active_turn_id
           WHERE conversation.id = ? AND conversation.deleted_at IS NULL"#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;

    interruptor
        .interrupt_turn(
            conversation_id,
            reason
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .map(str::to_string),
        )
        .await
        .map_err(|error| {
            CollaborationError::new(
                "conversation_control_failed",
                format!("failed to interrupt the Agent turn: {error}"),
            )
        })?;

    let now = now_stamp();
    let mut turn_ids = Vec::with_capacity(open_turns.len());
    for (turn_id, round_id) in &open_turns {
        sqlx::query(
            r#"UPDATE collaboration_turns
               SET outcome = 'cancelled', state = 'finished', updated_at = ?
               WHERE id = ? AND state <> 'finished'"#,
        )
        .bind(&now)
        .bind(turn_id)
        .execute(pool)
        .await
        .map_err(db)?;
        sqlx::query(
            r#"UPDATE collaboration_space_deliveries
               SET receipt_state = 'cancelled', receipt_updated_at = ?
               WHERE turn_id = ? AND receipt_state IN ('queued', 'processing')"#,
        )
        .bind(&now)
        .bind(turn_id)
        .execute(pool)
        .await
        .map_err(db)?;
        turn_ids.push(turn_id.clone());
        if let Some(round_id) = round_id {
            let _ = advance_round(pool, round_id, delivery).await;
        }
    }
    let _ = append_space_event_pool(
        pool,
        space_id,
        "turn",
        None,
        &json!({
            "action": "interrupted",
            "turn_ids": turn_ids,
            "conversation_id": conversation_id.to_string(),
            "member_id": target.member_id,
            "nickname": target.nickname,
            "caller_member_id": caller.member_id,
            "caller_nickname": caller.nickname,
            "reason": reason.map(str::trim).filter(|value| !value.is_empty()),
        }),
    )
    .await;

    Ok(SpaceTurnInterrupt {
        space_id: space_id.to_string(),
        member_id: target.member_id,
        nickname: target.nickname,
        conversation_id: conversation_id.to_string(),
        turn_ids,
        active_turn_id,
        interrupted: true,
    })
}
