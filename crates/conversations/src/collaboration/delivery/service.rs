use std::collections::HashSet;

use agents::{AgentId, CollaborationSpaceOrigin, ConversationInputPayload};
use db::models::collaboration_identity::{self as identity};
use serde_json::{Map, Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{routing::ResolvedTarget, *};
use crate::{ConversationInputControl, SubmitConversationInput};

#[path = "dispatch.rs"]
mod dispatch;
#[path = "post.rs"]
mod post;
#[path = "rounds.rs"]
mod rounds;

pub use dispatch::*;
pub use post::*;
pub use rounds::*;

pub async fn prepare_steer(
    pool: &SqlitePool,
    input: &SendSessionInput,
) -> Result<Uuid, CollaborationError> {
    if !input.steer_supported {
        return Err(CollaborationError::new(
            "steer_unsupported",
            "this conversation cannot accept steering",
        ));
    }
    authorize_write(pool, input.caller_id, input.conversation_id, input.policy).await?;
    let expected = input.expected_turn_id.ok_or_else(|| {
        CollaborationError::new("steer_no_active_turn", "expected_turn_id is required")
    })?;
    let active = active_turn_id(pool, input.conversation_id).await?;
    let Some(active) = active else {
        return Err(CollaborationError::new(
            "steer_no_active_turn",
            "conversation has no active turn",
        ));
    };
    if active != expected {
        return Err(CollaborationError::new(
            "steer_conflict",
            "active turn changed",
        ));
    }
    Ok(expected)
}

/// The user typing into a member's direct chat: queue `text` on that
/// conversation (start a turn when idle). Idempotent per `operation_id`.
/// Returns the receipt and the session's workspace.
pub async fn send_user_text_to_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
    operation_id: Uuid,
    text: &str,
    delivery: &DeliveryContext,
) -> Result<(SendReceipt, Uuid), CollaborationError> {
    if text.trim().is_empty() {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "content must not be empty",
        ));
    }
    let target = live_session(load_session(pool, conversation_id).await?)?;
    let workspace_id = target.workspace_id;
    let binding = sqlx::query_as::<_, (String, String, String)>(
        r#"SELECT tm.thread_id, m.id, m.name
           FROM collaboration_thread_members tm
           JOIN collaboration_members m ON m.id = tm.member_id
           WHERE tm.conversation_id = ? AND tm.status = 'active'
           LIMIT 1"#,
    )
    .bind(conversation_id.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let (agent_text, display_text, origin, principal) =
        if let Some((thread_id, _member_id, nickname)) = binding {
            let origin = CollaborationSpaceOrigin {
                space_id: thread_id.clone(),
                thread_kind: space_thread_kind(&thread_id).to_string(),
                sender_kind: "user".to_string(),
                sender_nickname: "你".to_string(),
                sender_conversation_id: None,
                sender_member_id: None,
            };
            let envelope = json!({
                "sender": ENVELOPE_PERSON_SENDER,
                "to": [envelope_member_name(&nickname)],
                "content": text,
            });
            let display = clean_space_display_text(text, std::slice::from_ref(&nickname));
            let packed = compose_space_delivery_prompt(
                pool,
                conversation_id,
                &thread_id,
                0,
                &envelope,
                None,
                text,
                &display,
            )
            .await?;
            (
                packed,
                Some(display),
                Some(origin),
                json!({
                    "kind": "collaboration_direct_user",
                    "spaceId": thread_id,
                }),
            )
        } else {
            (
                text.to_string(),
                None,
                None,
                json!({ "kind": "collaboration_direct_user" }),
            )
        };
    let receipt = deliver_text(
        pool,
        conversation_id,
        operation_id,
        &agent_text,
        display_text,
        origin,
        &target,
        principal,
        delivery,
    )
    .await?;
    Ok((receipt, workspace_id))
}

pub async fn send_session_input(
    pool: &SqlitePool,
    input: SendSessionInput,
) -> Result<SendReceipt, CollaborationError> {
    send_session_input_with(pool, input, &DeliveryContext::default()).await
}

pub async fn send_session_input_with(
    pool: &SqlitePool,
    input: SendSessionInput,
    delivery: &DeliveryContext,
) -> Result<SendReceipt, CollaborationError> {
    if input.text.trim().is_empty() {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "text must not be empty",
        ));
    }
    if input.steer {
        prepare_steer(pool, &input).await?;
        return Err(CollaborationError::new(
            "steer_unsupported",
            "steering is applied by the conversation service, not by queueing",
        ));
    }
    let target =
        authorize_write(pool, input.caller_id, input.conversation_id, input.policy).await?;
    let cap = bounded_delay_cap_hours(input.delay_cap_hours);
    if let Some(when) = scheduled_deadline(&input, cap)? {
        let receipt = schedule_input(pool, &input, &target, when).await?;
        delivery.notify_space_changed(CollaborationSpaceChangedEvent {
            workspace_id: target.workspace_id,
            space_id: format!("session:{}", input.conversation_id),
            seq: None,
            member_id: Some(input.caller_id.to_string()),
            kind: None,
            generation: None,
        });
        return Ok(receipt);
    }
    deliver_text(
        pool,
        input.conversation_id,
        input.operation_id,
        &input.text,
        None,
        None,
        &target,
        json!({
            "kind": "companion",
            "parentConversationId": input.caller_id,
        }),
        delivery,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn deliver_text(
    pool: &SqlitePool,
    conversation_id: Uuid,
    operation_id: Uuid,
    text: &str,
    display_text: Option<String>,
    collaboration_origin: Option<CollaborationSpaceOrigin>,
    target: &SessionHead,
    principal: Value,
    delivery: &DeliveryContext,
) -> Result<SendReceipt, CollaborationError> {
    let digest = digest_text(text);
    let principal_key = principal.to_string();
    let conversation_key = conversation_id.to_string();
    let operation_key = operation_id.to_string();
    let mut reserved = false;
    for attempt in 0..8 {
        match reserve_send_claim(
            pool,
            &conversation_key,
            &operation_key,
            &digest,
            &principal_key,
        )
        .await?
        {
            ClaimGate::Replay(receipt) => return Ok(receipt),
            ClaimGate::Reserved => {
                reserved = true;
                break;
            }
            ClaimGate::InProgress => {
                if attempt == 7 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }
    }
    if !reserved {
        if let Some(receipt) =
            finish_unreceipted_claim(pool, conversation_id, operation_id, delivery).await?
        {
            return Ok(receipt);
        }
        return Err(delivery_in_progress());
    }
    let agent_raw = target.agent_id.clone().ok_or_else(|| {
        CollaborationError::new("conversation_missing_agent", "conversation has no agent")
    })?;
    let agent_id = AgentId::parse(&agent_raw).map_err(|error| {
        CollaborationError::new("conversation_control_failed", error.to_string())
    })?;
    let busy = active_turn_id(pool, conversation_id).await?;
    let inputs = match &delivery.publisher {
        Some(publisher) => {
            ConversationInputControl::with_publisher(pool.clone(), publisher.clone())
        }
        None => ConversationInputControl::new(pool.clone()),
    };
    let submitted = match inputs
        .submit(SubmitConversationInput {
            conversation_id,
            operation_id,
            payload: ConversationInputPayload {
                agent_id,
                workspace_id: target.workspace_id,
                executor_profile_id: None,
                text: text.to_string(),
                display_text,
                images: Vec::new(),
                mode_override: None,
                config_overrides: Vec::new(),
                workflow_refs: Vec::new(),
                file_refs: Vec::new(),
                internal_prompt_contributions: Vec::new(),
                collaboration_origin,
            },
            principal,
        })
        .await
    {
        Ok(submitted) => submitted,
        Err(error) => {
            release_send_claim(pool, &conversation_key, &operation_key).await;
            return Err(CollaborationError::new(
                "conversation_control_failed",
                error.to_string(),
            ));
        }
    };
    let (delivered, turn_id) = receipt_delivery(conversation_id, busy, delivery).await;
    let receipt = SendReceipt {
        delivered,
        input_id: Some(submitted.id),
        turn_id,
        delayed_input_id: None,
        idempotent_replay: false,
    };
    if let Err(error) = record_send_receipt(pool, &conversation_key, &operation_key, &receipt).await
    {
        tracing::warn!(%error, "collaboration receipt was not stored");
    }
    Ok(receipt)
}

pub(crate) async fn receipt_delivery(
    conversation_id: Uuid,
    busy: Option<Uuid>,
    delivery: &DeliveryContext,
) -> (String, Option<Uuid>) {
    if let Some(active) = busy {
        return ("queued".to_string(), Some(active));
    }
    let Some(dispatcher) = &delivery.dispatcher else {
        return ("queued".to_string(), None);
    };
    match dispatcher.start_if_idle(conversation_id).await {
        Ok(Some(turn_id)) => ("dispatched".to_string(), Some(turn_id)),
        Ok(None) => ("queued".to_string(), None),
        Err(error) => {
            tracing::warn!(%error, "idle turn dispatch failed");
            ("queued".to_string(), None)
        }
    }
}

pub(crate) fn cross_chat_peer_json(target: &ResolvedTarget) -> Value {
    json!({
        "kind": target.peer_kind,
        "name": target.nickname,
        "id": target.dest_thread_id,
    })
}

pub(crate) fn unique_cross_chat_peers(
    origin_thread: &str,
    targets: &[ResolvedTarget],
) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut peers = Vec::new();
    for target in targets {
        let Some(dest) = target.dest_thread_id.as_deref() else {
            continue;
        };
        if dest == origin_thread {
            continue;
        }
        let key = if target.peer_kind == "group" {
            format!("group:{dest}")
        } else {
            format!("member:{}", target.nickname)
        };
        if !seen.insert(key) {
            continue;
        }
        peers.push(cross_chat_peer_json(target));
    }
    peers
}

pub(crate) fn unique_cross_chat_dests(
    origin_thread: &str,
    targets: &[ResolvedTarget],
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut dests = Vec::new();
    for target in targets {
        let Some(dest) = target.dest_thread_id.as_deref() else {
            continue;
        };
        if dest == origin_thread {
            continue;
        }
        if seen.insert(dest.to_string()) {
            dests.push(dest.to_string());
        }
    }
    dests
}

pub(crate) async fn sender_received_from_peer(
    pool: &SqlitePool,
    origin_thread: &str,
    sender: Option<Uuid>,
    sender_nickname: Option<&str>,
    sender_member_id: Option<&str>,
) -> Result<Value, CollaborationError> {
    if sender.is_some() {
        let name = sender_nickname.unwrap_or("").trim();
        let id = sender_member_id
            .map(identity::direct_thread_id)
            .unwrap_or_else(|| origin_thread.to_string());
        return Ok(json!({
            "kind": "member",
            "name": name,
            "id": id,
        }));
    }
    if origin_thread.starts_with(identity::DIRECT_PREFIX) {
        let members = list_space_members(pool, origin_thread, MessageAudience::Agent)
            .await
            .unwrap_or_default();
        if let Some(member) = members.into_iter().next() {
            return Ok(json!({
                "kind": "member",
                "name": member.nickname,
                "id": origin_thread,
            }));
        }
        return Ok(json!({
            "kind": "member",
            "name": origin_thread,
            "id": origin_thread,
        }));
    }
    let name: String =
        sqlx::query_scalar("SELECT name FROM collaboration_spaces WHERE id = ? LIMIT 1")
            .bind(origin_thread)
            .fetch_optional(pool)
            .await
            .map_err(db)?
            .unwrap_or_else(|| origin_thread.to_string());
    Ok(json!({
        "kind": "group",
        "name": name,
        "id": origin_thread,
    }))
}

pub(crate) async fn ensure_dm_cutover_tx(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
    now: &str,
) -> Result<(), sqlx::Error> {
    if !space_id.starts_with(identity::DIRECT_PREFIX) {
        return Ok(());
    }
    let current_cutover: Option<Option<String>> =
        sqlx::query_scalar("SELECT space_cutover_at FROM collaboration_threads WHERE id = ?")
            .bind(space_id)
            .fetch_optional(&mut *conn)
            .await?;
    if matches!(current_cutover, Some(None)) {
        let conv_raw: Option<String> = sqlx::query_scalar(
            r#"SELECT conversation_id FROM collaboration_thread_members
               WHERE thread_id = ? AND status = 'active' LIMIT 1"#,
        )
        .bind(space_id)
        .fetch_optional(&mut *conn)
        .await?
        .flatten();
        let cutover_seq = if let Some(conv_id) = conv_raw
            .as_deref()
            .and_then(|raw| Uuid::parse_str(raw).ok())
        {
            sqlx::query_scalar::<_, i64>(
                "SELECT COALESCE(MAX(sequence), 0) FROM conversation_events WHERE conversation_id = ?",
            )
            .bind(conv_id)
            .fetch_one(&mut *conn)
            .await?
        } else {
            0
        };
        sqlx::query(
            r#"UPDATE collaboration_threads
               SET space_cutover_at = ?, space_cutover_seq = ?
               WHERE id = ? AND space_cutover_at IS NULL"#,
        )
        .bind(now)
        .bind(cutover_seq)
        .bind(space_id)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn insert_space_message_tx(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
    message_id: &str,
    envelope: &Value,
    published: &str,
    origin: &str,
    root_id: &str,
    hop: i64,
    deliveries: &[QueuedSpaceDelivery],
) -> Result<i64, sqlx::Error> {
    ensure_dm_cutover_tx(conn, space_id, published).await?;
    let seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM collaboration_space_messages WHERE space_id = ?",
    )
    .bind(space_id)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query(
        r#"INSERT INTO collaboration_space_messages
           (id, space_id, seq, envelope_json, created_at, origin, root_id, hop)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(message_id)
    .bind(space_id)
    .bind(seq)
    .bind(envelope.to_string())
    .bind(published)
    .bind(origin)
    .bind(root_id)
    .bind(hop)
    .execute(&mut *conn)
    .await?;
    for delivery in deliveries {
        sqlx::query(
            r#"INSERT INTO collaboration_space_deliveries
               (space_message_id, conversation_id, operation_id, input_id, status, round_id, round_ordinal)
               VALUES (?, ?, ?, NULL, 'queued', ?, ?)"#,
        )
        .bind(message_id)
        .bind(delivery.conversation_id.to_string())
        .bind(delivery.operation_id.to_string())
        .bind(delivery.round_id.as_deref())
        .bind(delivery.round_ordinal)
        .execute(&mut *conn)
        .await?;
    }
    let actor = parse_space_envelope(envelope).sender;
    if space_tracks_events(space_id) {
        let event_seq: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM collaboration_space_events WHERE space_id = ?",
        )
        .bind(space_id)
        .fetch_one(&mut *conn)
        .await?;
        let payload = json!({
            "message_seq": seq,
            "origin": origin,
            "actor": actor,
        });
        sqlx::query(
            r#"INSERT INTO collaboration_space_events
               (space_id, seq, kind, message_id, payload_json, created_at)
               VALUES (?, ?, 'message', ?, ?, ?)"#,
        )
        .bind(space_id)
        .bind(event_seq)
        .bind(message_id)
        .bind(payload.to_string())
        .bind(published)
        .execute(&mut *conn)
        .await?;
    }
    Ok(seq)
}

pub(crate) async fn insert_space_log(
    pool: &SqlitePool,
    space_id: &str,
    message_id: &str,
    envelope: &Value,
    origin: &str,
    root_id: &str,
    hop: i64,
) -> Result<i64, CollaborationError> {
    let published = envelope
        .get("published")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let inserted = insert_space_message_tx(
        &mut conn,
        space_id,
        message_id,
        envelope,
        &published,
        origin,
        root_id,
        hop,
        &[],
    )
    .await;
    match inserted {
        Ok(seq) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(db)?;
            Ok(seq)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(db(error))
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn project_cross_chat_receipts(
    pool: &SqlitePool,
    message_id: &str,
    actor: &str,
    attributed_to: Option<&str>,
    published: &str,
    origin_kind: &str,
    received_from: &Value,
    dests: &[String],
    turn_delivery: &DeliveryContext,
) -> Result<(), CollaborationError> {
    for dest in dests {
        let recv_id = Uuid::new_v5(
            &Uuid::NAMESPACE_OID,
            format!("cross-chat-recv:{message_id}:{dest}").as_bytes(),
        )
        .to_string();
        let conversation_id = attributed_to.and_then(conversation_id_from_uri);
        let mut extra = Map::new();
        extra.insert(
            "crossChatReceivedFrom".to_string(),
            json!([received_from]),
        );
        let envelope = build_space_envelope(NewSpaceEnvelope {
            id: &recv_id,
            sender: actor,
            to: Vec::new(),
            content: "",
            reply_to: None,
            published,
            summary: None,
            conversation_id,
            extra,
        });
        let _seq =
            insert_space_log(pool, dest, &recv_id, &envelope, origin_kind, &recv_id, 0).await?;
        if dest.starts_with(identity::DIRECT_PREFIX) {
            let dest_conv: Option<String> = sqlx::query_scalar(
                r#"SELECT conversation_id FROM collaboration_thread_members
                   WHERE thread_id = ? AND status = 'active' LIMIT 1"#,
            )
            .bind(dest)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
            if let Some(conversation_id) = dest_conv.and_then(|raw| Uuid::parse_str(&raw).ok()) {
                project_direct_space_post(pool, conversation_id, &recv_id, "").await?;
            }
        }
        if let Ok(workspace_id) = space_workspace_id(pool, dest).await {
            let evt = latest_space_changed_event(pool, workspace_id, dest, None).await;
            turn_delivery.notify_space_changed(evt);
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct PostDirectMessage {
    pub thread_id: String,
    pub content: String,
    pub summary: Option<String>,
    pub in_reply_to: Option<String>,
    pub operation_id: Uuid,
}

pub async fn post_direct_message(
    pool: &SqlitePool,
    input: PostDirectMessage,
) -> Result<
    (
        SpacePostResult,
        Uuid,
        crate::collaboration_sidebar::SidebarMember,
    ),
    CollaborationError,
> {
    post_direct_message_with(pool, input, &DeliveryContext::default()).await
}

pub async fn post_direct_message_with(
    pool: &SqlitePool,
    input: PostDirectMessage,
    turn_delivery: &DeliveryContext,
) -> Result<
    (
        SpacePostResult,
        Uuid,
        crate::collaboration_sidebar::SidebarMember,
    ),
    CollaborationError,
> {
    let content = input.content.trim().to_string();
    let content = content.as_str();
    if content.is_empty() {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "content must not be empty",
        ));
    }
    let Some((conversation_id, member)) =
        crate::collaboration_sidebar::dm_conversation(pool, &input.thread_id).await?
    else {
        return Err(CollaborationError::new(
            "not_found",
            "direct thread was not found",
        ));
    };
    let target = live_session(load_session(pool, conversation_id).await?)?;
    let workspace_id = target.workspace_id;
    ensure_user_member(pool, &input.thread_id).await?;
    let actor = ENVELOPE_USER_ACTOR.to_string();
    let message_id = input.operation_id.to_string();
    let synth_post = PostToSpace {
        caller_id: None,
        space_id: input.thread_id.clone(),
        content: content.to_string(),
        summary: input.summary.clone(),
        to: vec![member.name.clone()],
        in_reply_to: input.in_reply_to.clone(),
        operation_id: input.operation_id,
    };
    let request = post_fingerprint(&synth_post, content, &actor);
    if let Some(head) = load_message_head(pool, &message_id).await? {
        if head.space_id != input.thread_id {
            return Err(CollaborationError::new(
                "not_found",
                "message was not found",
            ));
        }
        if !same_post_request(
            pool,
            &message_id,
            &input.thread_id,
            &request,
            &head.envelope_json,
        )
        .await?
        {
            return Err(operation_conflict());
        }
        let result = deliver_pending(pool, &input.thread_id, &message_id, turn_delivery).await?;
        return Ok((result, workspace_id, member));
    }
    let summary = input
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| content.lines().next().unwrap_or(content).trim().to_string());
    let published = now_stamp();
    let envelope = build_space_envelope(NewSpaceEnvelope {
        id: &message_id,
        sender: &actor,
        to: vec![envelope_member_name(&member.name)],
        content,
        reply_to: input.in_reply_to.as_deref(),
        published: &published,
        summary: Some(summary.as_str()),
        conversation_id: None,
        extra: Map::new(),
    });
    let deliveries = vec![QueuedSpaceDelivery {
        conversation_id,
        operation_id: delivery_operation_id(input.operation_id, conversation_id),
        round_id: None,
        round_ordinal: None,
    }];
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let inserted = insert_space_message_tx(
        &mut conn,
        &input.thread_id,
        &message_id,
        &envelope,
        &published,
        "user",
        &message_id,
        0,
        &deliveries,
    )
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
        Some(&input.thread_id),
        &request,
        &json!({ "message_id": message_id }),
    )
    .await?;
    let result = deliver_pending(pool, &input.thread_id, &message_id, turn_delivery)
        .await
        .map(|mut result| {
            result.seq = seq;
            result
        })?;
    Ok((result, workspace_id, member))
}
