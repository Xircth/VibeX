use std::collections::HashSet;

use agents::{AgentId, CollaborationSpaceOrigin, ConversationEvent, ConversationInputPayload};
use chrono::{Duration, Utc};
use db::models::{
    collaboration_identity::{self as identity},
    conversation_event::AppendConversationEvent,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use super::{routing::ResolvedTarget, *};
use crate::{ConversationEventAppender, ConversationInputControl, SubmitConversationInput};

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
                "actor": user_actor(&thread_id),
                "to": [member_actor(&thread_id, &nickname)],
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

pub(crate) enum ClaimGate {
    Replay(SendReceipt),
    InProgress,
    Reserved,
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

fn cross_chat_peer_json(target: &ResolvedTarget) -> Value {
    json!({
        "kind": target.peer_kind,
        "name": target.nickname,
        "id": target.dest_thread_id,
    })
}

fn unique_cross_chat_peers(origin_thread: &str, targets: &[ResolvedTarget]) -> Vec<Value> {
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

fn unique_cross_chat_dests(origin_thread: &str, targets: &[ResolvedTarget]) -> Vec<String> {
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

async fn sender_received_from_peer(
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

async fn insert_space_log(
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
    let inserted = async {
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
        .bind(&published)
        .bind(origin)
        .bind(root_id)
        .bind(hop)
        .execute(&mut *conn)
        .await?;
        Ok::<i64, sqlx::Error>(seq)
    }
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

async fn project_cross_chat_receipts(
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
        let envelope = json!({
            "@context": "https://www.w3.org/ns/activitystreams",
            "type": "Note",
            "id": format!("vibex://space-message/{recv_id}"),
            "actor": actor,
            "attributedTo": attributed_to,
            "to": [],
            "summary": "",
            "content": "",
            "published": published,
            "crossChatReceivedFrom": [received_from],
        });
        let seq =
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
            turn_delivery.notify_space_changed(CollaborationSpaceChangedEvent {
                workspace_id,
                space_id: dest.clone(),
                seq: Some(seq),
                member_id: None,
            });
        }
    }
    Ok(())
}

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

#[derive(Debug, Clone, Serialize)]
pub struct DeliveryReceipt {
    pub conversation_id: Uuid,
    pub nickname: String,
    pub delivered: String,
    /// Three-state receipt: `queued`, `processing` or `replied`
    /// (`failed` deliveries keep `queued` here and report `delivered`).
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

pub async fn post_to_space(
    pool: &SqlitePool,
    input: PostToSpace,
) -> Result<SpacePostResult, CollaborationError> {
    post_to_space_with(pool, input, &DeliveryContext::default()).await
}

pub async fn post_to_space_with(
    pool: &SqlitePool,
    mut input: PostToSpace,
    turn_delivery: &DeliveryContext,
) -> Result<SpacePostResult, CollaborationError> {
    if parse_unassigned_space_id(input.space_id.trim()).is_some() {
        return Err(CollaborationError::new(
            "invalid_space_for_direct_chat",
            "当前会话属于一对一私聊会话，无需调用 post_to_space 等群空间消息工具；请直接输出回复文本与用户交流。",
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
    let mut sender_nickname = None;
    let mut sender_member_id = None;
    let (actor, attributed_to, sender) = match input.caller_id {
        Some(caller_id) => {
            let member = caller_seat(pool, &input.space_id, caller_id).await?;
            let seat = seat_conversation(&member).unwrap_or(caller_id);
            sender_nickname = Some(member.nickname.clone());
            sender_member_id = Some(member.member_id.clone());
            (
                member_actor(&input.space_id, &member.nickname),
                Some(format!("vibex://conversation/{seat}")),
                Some(seat),
            )
        }
        None => {
            ensure_user_member(pool, &input.space_id).await?;
            (user_actor(&input.space_id), None, None)
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
        let head_env = serde_json::from_str::<Value>(&head.envelope_json).ok();
        let head_actor = head_env
            .as_ref()
            .and_then(|env| env.get("actor").and_then(Value::as_str));
        let head_content = head_env
            .as_ref()
            .and_then(|env| env.get("content").and_then(Value::as_str));
        if input.caller_id.is_some()
            && head_actor == Some(actor.as_str())
            && head_content != Some(content)
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
    let targets = resolve_targets(pool, &input.space_id, sender, &input.to, content).await?;
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
    let summary = input
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| content.lines().next().unwrap_or(content).trim().to_string());
    let published = now_stamp();
    let sent_to = unique_cross_chat_peers(&input.space_id, &targets);
    let mut envelope = json!({
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "Note",
        "id": format!("vibex://space-message/{message_id}"),
        "actor": actor,
        "attributedTo": attributed_to,
        "to": targets
            .iter()
            .map(|target| {
                if target.conversation_id.is_none() {
                    user_actor(&input.space_id)
                } else if target.dest_thread_id.is_some() {
                    member_actor(
                        target.dest_thread_id.as_deref().unwrap_or(&input.space_id),
                        &target.nickname,
                    )
                } else {
                    member_actor(&input.space_id, &target.nickname)
                }
            })
            .collect::<Vec<_>>(),
        "inReplyTo": input.in_reply_to,
        "summary": summary,
        "content": content,
        "published": published,
    });
    if !sent_to.is_empty() {
        envelope["crossChatSentTo"] = json!(sent_to);
    }
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let inserted = async {
        let seq: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(&input.space_id)
        .fetch_one(&mut *conn)
        .await?;
        sqlx::query(
            r#"INSERT INTO collaboration_space_messages
               (id, space_id, seq, envelope_json, created_at, origin, root_id, hop)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&message_id)
        .bind(&input.space_id)
        .bind(seq)
        .bind(envelope.to_string())
        .bind(&published)
        .bind(if sender.is_some() { "agent" } else { "user" })
        .bind(&root_id)
        .bind(hop)
        .execute(&mut *conn)
        .await?;
        for target in &targets {
            let Some(target_id) = target.conversation_id else {
                continue;
            };
            if hop_exceeded {
                continue;
            };
            sqlx::query(
                r#"INSERT INTO collaboration_space_deliveries
                   (space_message_id, conversation_id, operation_id, input_id, status)
                   VALUES (?, ?, ?, NULL, 'queued')"#,
            )
            .bind(&message_id)
            .bind(target_id.to_string())
            .bind(delivery_operation_id(input.operation_id, target_id).to_string())
            .execute(&mut *conn)
            .await?;
        }
        if let Some(sender) = sender {
            sqlx::query(
                r#"UPDATE collaboration_thread_members
                   SET last_active_at = ?, asleep_since = NULL
                   WHERE conversation_id = ?"#,
            )
            .bind(&published)
            .bind(sender.to_string())
            .execute(&mut *conn)
            .await?;
            // The member answered in this thread: everything delivered to it
            // here before this message is now replied.
            sqlx::query(
                r#"UPDATE collaboration_space_deliveries
                   SET receipt_state = 'replied', receipt_updated_at = ?
                   WHERE conversation_id = ? AND receipt_state != 'replied'
                     AND space_message_id IN (
                       SELECT id FROM collaboration_space_messages
                       WHERE space_id = ? AND seq < ?)"#,
            )
            .bind(&published)
            .bind(sender.to_string())
            .bind(&input.space_id)
            .bind(seq)
            .execute(&mut *conn)
            .await?;
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
    let result = deliver_pending(pool, &input.space_id, &message_id, turn_delivery)
        .await
        .map(|mut result| {
            result.seq = seq;
            result
        })?;
    let concurrency_held = result.receipts.iter().any(|receipt| {
        receipt.delivered == "queued" && receipt.input_id.is_none() && receipt.error_code.is_none()
    });
    if hop_exceeded || concurrency_held {
        insert_collaboration_limit_notice(pool, &input.space_id).await?;
    }
    if input.space_id.starts_with(identity::DIRECT_PREFIX)
        && let Some(sender) = sender
    {
        project_direct_space_post(pool, sender, &message_id, content).await?;
    }
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
            attributed_to.as_deref(),
            &published,
            if sender.is_some() { "agent" } else { "user" },
            &received_from,
            &dests,
            turn_delivery,
        )
        .await?;
    }
    Ok(result)
}

#[derive(Debug, Clone, FromRow)]
struct HopHead {
    id: String,
    root_id: Option<String>,
    hop: i64,
}

fn bare_message_id(raw: &str) -> &str {
    raw.trim()
        .strip_prefix("vibex://space-message/")
        .unwrap_or(raw.trim())
}

async fn load_hop_parent(
    pool: &SqlitePool,
    space_id: &str,
    in_reply_to: Option<&str>,
) -> Result<Option<HopHead>, CollaborationError> {
    if let Some(parent_id) = in_reply_to.map(bare_message_id).filter(|id| !id.is_empty()) {
        return sqlx::query_as::<_, HopHead>(
            r#"SELECT id, root_id, hop FROM collaboration_space_messages
               WHERE id = ? AND space_id = ?"#,
        )
        .bind(parent_id)
        .bind(space_id)
        .fetch_optional(pool)
        .await
        .map_err(db);
    }
    sqlx::query_as::<_, HopHead>(
        r#"SELECT id, root_id, hop FROM collaboration_space_messages
           WHERE space_id = ? AND origin != 'system'
           ORDER BY seq DESC LIMIT 1"#,
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)
}

async fn resolve_root_and_hop(
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

async fn insert_collaboration_limit_notice(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<(), CollaborationError> {
    let published = now_stamp();
    let message_id = Uuid::new_v4().to_string();
    let envelope = json!({
        "@context": "https://www.w3.org/ns/activitystreams",
        "type": "Note",
        "id": format!("vibex://space-message/{message_id}"),
        "actor": format!("vibex://space/{space_id}/system"),
        "to": [],
        "summary": "collaboration_limit",
        "content": COLLABORATION_LIMIT_NOTICE_ZH,
        "content_en": COLLABORATION_LIMIT_NOTICE_EN,
        "published": published,
    });
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let inserted = async {
        let seq: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(space_id)
        .fetch_one(&mut *conn)
        .await?;
        sqlx::query(
            r#"INSERT INTO collaboration_space_messages
               (id, space_id, seq, envelope_json, created_at, origin, root_id, hop)
               VALUES (?, ?, ?, ?, ?, 'system', ?, 0)"#,
        )
        .bind(&message_id)
        .bind(space_id)
        .bind(seq)
        .bind(envelope.to_string())
        .bind(&published)
        .bind(&message_id)
        .execute(&mut *conn)
        .await?;
        Ok::<(), sqlx::Error>(())
    }
    .await;
    match inserted {
        Ok(()) => {
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

pub(crate) async fn deliver_pending(
    pool: &SqlitePool,
    space_id: &str,
    message_id: &str,
    turn_delivery: &DeliveryContext,
) -> Result<SpacePostResult, CollaborationError> {
    let envelope = load_envelope(pool, message_id).await?;
    let (seq, root_id): (i64, Option<String>) =
        sqlx::query_as("SELECT seq, root_id FROM collaboration_space_messages WHERE id = ?")
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
    let content = envelope
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let display_text = clean_space_display_text(content, &member_nicknames);
    let pending = sqlx::query_as::<_, PendingDelivery>(
        r#"SELECT conversation_id, operation_id, input_id, status, receipt_state, context_from_seq,
                  wake_deferred_turn_key
           FROM collaboration_space_deliveries
           WHERE space_message_id = ?"#,
    )
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let message_hop: i64 =
        sqlx::query_scalar("SELECT hop FROM collaboration_space_messages WHERE id = ?")
            .bind(message_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?
            .unwrap_or(0);
    let chain_limit_exceeded = message_hop > MAX_ASSISTANT_HOPS_PER_ROOT;
    let mut in_flight = in_flight_delivery_count(pool, space_id).await?;
    let mut receipts = Vec::new();
    for delivery in pending {
        let Ok(conversation_id) = Uuid::parse_str(&delivery.conversation_id) else {
            continue;
        };
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
                       receipt_state = 'replied',
                       wake_deferred_turn_key = NULL,
                       receipt_updated_at = ?
                   WHERE space_message_id = ? AND conversation_id = ?"#,
            )
            .bind(now_stamp())
            .bind(message_id)
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
                state: "replied".to_string(),
                input_id: None,
                error_code: None,
            });
            continue;
        }
        let Some(target) = load_session(pool, conversation_id).await? else {
            mark_delivery_failed(pool, message_id, conversation_id).await?;
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
            mark_delivery_failed(pool, message_id, conversation_id).await?;
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
        if in_flight >= MAX_IN_FLIGHT_DELIVERIES_PER_SPACE {
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
                let turn_key = wake_turn_key(pool, message_id, &envelope).await?;
                if !reserve_wake(
                    pool,
                    &turn_key,
                    conversation_id,
                    message_id,
                    wake_cap_per_turn(),
                )
                .await?
                {
                    // Over the per-turn wake cap: held visibly as
                    // 'limit_reached' until the originating turn ends.
                    hold_over_wake_cap(pool, message_id, conversation_id, &turn_key).await?;
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
            .bind(message_id)
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
            &envelope,
            root_id.as_deref(),
            content,
            &display_text,
        )
        .await?;
        let origin = origin_from_envelope(space_id, &envelope, &space_members);
        match deliver_text(
            pool,
            conversation_id,
            operation_id,
            &packed,
            Some(display_text.clone()),
            Some(origin),
            &target,
            json!({
                "kind": "collaboration_space",
                "spaceId": space_id,
                "messageId": message_id,
            }),
            turn_delivery,
        )
        .await
        {
            Ok(receipt) => {
                let state = if receipt.delivered == "dispatched" {
                    "processing"
                } else {
                    "queued"
                };
                if state == "processing" {
                    in_flight = in_flight.saturating_add(1);
                }
                // The queue may already have dispatched the input (trigger),
                // so never move a receipt backwards.
                sqlx::query(
                    r#"UPDATE collaboration_space_deliveries
                       SET input_id = ?, status = ?, wake_deferred_turn_key = NULL,
                           receipt_state = CASE
                             WHEN receipt_state = 'queued' THEN ? ELSE receipt_state END,
                           receipt_updated_at = ?
                       WHERE space_message_id = ? AND conversation_id = ?"#,
                )
                .bind(receipt.input_id.map(|id| id.to_string()))
                .bind(&receipt.delivered)
                .bind(state)
                .bind(now_stamp())
                .bind(message_id)
                .bind(conversation_id.to_string())
                .execute(pool)
                .await
                .map_err(db)?;
                advance_last_seen(pool, space_id, conversation_id, message_id, seq).await?;
                touch_session_activity(pool, conversation_id).await?;
                let state: String = sqlx::query_scalar(
                    r#"SELECT receipt_state FROM collaboration_space_deliveries
                       WHERE space_message_id = ? AND conversation_id = ?"#,
                )
                .bind(message_id)
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
                    mark_delivery_failed(pool, message_id, conversation_id).await?;
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
pub const MISSED_CONTEXT_VERBATIM: usize = 20;
/// Furthest back (in messages) a missed-context window ever reaches.
pub(crate) const MISSED_CONTEXT_LIMIT: i64 = 500;
/// Per-message character cap inside the packed block.
pub(crate) const MISSED_CONTEXT_MESSAGE_CHARS: usize = 600;

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
        Some(binding) => match binding_last_seen_seq(pool, space_id, &binding).await? {
            Some(seen) => Some(seen),
            None => None,
        },
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

/// Group messages in `(from_seq, before_seq)` that this conversation did not
/// author, rendered as a "while you were away" block. `None` when empty.
pub(crate) async fn missed_group_context(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: Uuid,
    from_seq: i64,
    before_seq: i64,
) -> Result<Option<String>, CollaborationError> {
    if before_seq - from_seq <= 1 {
        return Ok(None);
    }
    let rows = sqlx::query_as::<_, (i64, String)>(
        r#"SELECT seq, envelope_json FROM collaboration_space_messages
           WHERE space_id = ? AND seq > ? AND seq < ?
           ORDER BY seq DESC LIMIT ?"#,
    )
    .bind(space_id)
    .bind(from_seq)
    .bind(before_seq)
    .bind(MISSED_CONTEXT_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let own = format!("vibex://conversation/{conversation_id}");
    let user_uri = user_actor(space_id);
    let mut lines = Vec::new();
    for (seq, raw) in rows {
        let Ok(envelope) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if envelope.get("attributedTo").and_then(Value::as_str) == Some(own.as_str()) {
            continue;
        }
        let actor = envelope
            .get("actor")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let who = if actor == user_uri {
            "User".to_string()
        } else {
            actor.rsplit("/member/").next().unwrap_or(actor).to_string()
        };
        let content = envelope
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        lines.push((seq, who, content.to_string()));
    }
    if lines.is_empty() {
        return Ok(None);
    }
    lines.reverse();
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
            "[#{}–#{}] {older} earlier messages from {} (collapsed; use space history to read them)",
            collapsed[0].0,
            collapsed[older - 1].0,
            who.join(", ")
        ));
    }
    for (seq, who, content) in &lines[older..] {
        let mut content = content.clone();
        if content.chars().count() > MISSED_CONTEXT_MESSAGE_CHARS {
            content = content
                .chars()
                .take(MISSED_CONTEXT_MESSAGE_CHARS)
                .collect::<String>()
                + "…";
        }
        out.push(format!("[#{seq}] {who}: {content}"));
    }
    Ok(Some(format!(
        "<missed_group_messages count=\"{}\">\n{}\n</missed_group_messages>",
        lines.len(),
        out.join("\n")
    )))
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

#[derive(Debug, Clone, Serialize)]
pub struct SpaceMessage {
    /// Stable message id (the target of a later `in_reply_to`).
    pub id: String,
    pub seq: i64,
    pub envelope: Value,
    /// `user` or `agent`.
    pub origin: String,
    /// Id of the message this one replies to (cross-chat member-to-member
    /// correlation), lifted from the envelope's `inReplyTo`; a
    /// `vibex://space-message/<id>` URI is reduced to the bare `<id>` so it
    /// matches `id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    /// Per-recipient three-state receipts (empty for agent audiences).
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
}

/// Receipts of `message_id`, one per recipient conversation.
pub async fn list_message_receipts(
    pool: &SqlitePool,
    message_id: &str,
) -> Result<Vec<MessageReceipt>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        r#"SELECT conversation_id,
                  CASE WHEN receipt_state = 'queued' AND wake_deferred_turn_key IS NOT NULL
                       THEN 'limit_reached' ELSE receipt_state END,
                  status, COALESCE(receipt_updated_at, wake_deferred_at)
           FROM collaboration_space_deliveries WHERE space_message_id = ?
           ORDER BY conversation_id"#,
    )
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    Ok(rows
        .into_iter()
        .map(
            |(conversation_id, state, delivered, updated_at)| MessageReceipt {
                conversation_id,
                state,
                delivered,
                updated_at,
            },
        )
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
        let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            r#"SELECT space_message_id,
                      conversation_id,
                      CASE WHEN receipt_state = 'queued' AND wake_deferred_turn_key IS NOT NULL
                           THEN 'limit_reached' ELSE receipt_state END,
                      status,
                      COALESCE(receipt_updated_at, wake_deferred_at)
               FROM collaboration_space_deliveries
               WHERE space_message_id IN ("#,
        );
        let mut separated = builder.separated(", ");
        for mid in chunk {
            separated.push_bind(mid);
        }
        separated.push_unseparated(") ORDER BY space_message_id, conversation_id");
        let rows = builder
            .build_query_as::<(String, String, String, String, Option<String>)>()
            .fetch_all(pool)
            .await
            .map_err(db)?;
        for (message_id, conversation_id, state, delivered, updated_at) in rows {
            grouped.entry(message_id).or_default().push(MessageReceipt {
                conversation_id,
                state,
                delivered,
                updated_at,
            });
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
    if parse_unassigned_space_id(space_id_trimmed).is_some()
        || space_id_trimmed.starts_with(identity::DIRECT_PREFIX)
    {
        return Err(CollaborationError::new(
            "invalid_space_for_direct_chat",
            format!(
                "当前会话属于一对一私聊（{space_id_trimmed}）。私聊历史已在当前会话中，不必调用 list_space_messages。回复用户请调用 `post_to_space`（`space_id: \"{space_id_trimmed}\"`，`to: [\"User\"]`），不要再写一段重复的普通会话回复。"
            ),
        ));
    }
    load_space(pool, space_id).await?;
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
    let user_uri = user_actor(space_id);
    let mut receipts_by_message = if audience == MessageAudience::User && !rows.is_empty() {
        let message_ids: Vec<String> = rows.iter().map(|(_, _, _, id)| id.clone()).collect();
        list_message_receipts_batch(pool, &message_ids).await?
    } else {
        std::collections::HashMap::new()
    };
    Ok(rows
        .into_iter()
        .filter_map(|(seq, raw, origin, id)| {
            let mut envelope: Value = serde_json::from_str(&raw).ok()?;
            if audience == MessageAudience::Agent {
                if let Some(to) = envelope.get_mut("to").and_then(Value::as_array_mut) {
                    to.retain(|item| item.as_str() != Some(user_uri.as_str()));
                }
                if envelope.get("actor").and_then(Value::as_str) == Some(user_uri.as_str()) {
                    envelope["actor"] = json!("user");
                }
            }
            let receipts = receipts_by_message.remove(&id).unwrap_or_default();
            let in_reply_to = envelope
                .get("inReplyTo")
                .and_then(Value::as_str)
                .map(|value| value.trim())
                .map(|value| {
                    value
                        .strip_prefix("vibex://space-message/")
                        .unwrap_or(value)
                })
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            Some(SpaceMessage {
                id,
                seq,
                envelope,
                origin,
                in_reply_to,
                receipts,
            })
        })
        .collect())
}

/// Structured agent-to-agent handoff envelope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HandoffEnvelope {
    /// What the initiator already finished.
    pub done: String,
    /// Inputs, constraints and acceptance criteria the receiver must honour.
    pub inputs_constraints: String,
    /// The concrete ask.
    pub ask: String,
}

#[derive(Debug, Clone)]
pub struct Handoff {
    pub caller_id: Uuid,
    pub space_id: String,
    /// Receiver nickname in the space.
    pub to: String,
    pub envelope: HandoffEnvelope,
    pub operation_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HandoffResult {
    pub handoff_id: String,
    /// `accepted`, `rejected` (limit) or `failed` (delivery error).
    pub status: String,
    pub depth: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Message the initiator posted back into the thread on failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_message_id: Option<String>,
}

/// Longest handoff chain A -> B -> C ... (the first handoff has depth 1).
pub const DEFAULT_HANDOFF_MAX_DEPTH: i64 = 3;
/// Accepted handoffs one conversation may start within one turn.
pub const DEFAULT_HANDOFF_MAX_PER_TURN: i64 = 2;

pub fn handoff_max_depth() -> i64 {
    env_i64("VIBEX_HANDOFF_MAX_DEPTH", DEFAULT_HANDOFF_MAX_DEPTH).max(1)
}

pub fn handoff_max_per_turn() -> i64 {
    env_i64("VIBEX_HANDOFF_MAX_PER_TURN", DEFAULT_HANDOFF_MAX_PER_TURN).max(1)
}

pub(crate) fn render_handoff(envelope: &HandoffEnvelope, depth: i64, handoff_id: &str) -> String {
    format!(
        "<handoff id=\"{handoff_id}\" depth=\"{depth}\">\n<done>\n{}\n</done>\n<inputs_constraints>\n{}\n</inputs_constraints>\n<ask>\n{}\n</ask>\n</handoff>",
        envelope.done.trim(),
        envelope.inputs_constraints.trim(),
        envelope.ask.trim()
    )
}

#[derive(Debug, FromRow)]
pub(crate) struct HandoffRow {
    pub(crate) id: String,
    pub(crate) status: String,
    pub(crate) depth: i64,
    pub(crate) message_id: Option<String>,
    pub(crate) reason: Option<String>,
    pub(crate) report_message_id: Option<String>,
    pub(crate) envelope_json: String,
    pub(crate) to_nickname: String,
    pub(crate) space_id: String,
    pub(crate) from_conversation_id: String,
}

impl HandoffRow {
    fn result(&self) -> HandoffResult {
        HandoffResult {
            handoff_id: self.id.clone(),
            status: self.status.clone(),
            depth: self.depth,
            message_id: self.message_id.clone(),
            reason: self.reason.clone(),
            report_message_id: self.report_message_id.clone(),
        }
    }
}

/// Hand work to another member of the thread with a structured envelope.
///
/// Limits: the chain depth (an accepted handoff received by the caller's
/// seat in this thread is the parent) and the number of accepted handoffs the
/// caller starts in its current turn. Over-limit attempts are recorded as
/// `rejected` and returned as `limit_exceeded`. If delivery fails, the
/// attempt is recorded as `failed` and the initiator posts a failure report
/// back into the originating thread (to the user).
pub async fn handoff_with(
    pool: &SqlitePool,
    input: Handoff,
    turn_delivery: &DeliveryContext,
) -> Result<HandoffResult, CollaborationError> {
    let handoff_id = input.operation_id.to_string();
    if let Some(existing) = load_handoff(pool, &handoff_id).await? {
        let same = existing.space_id == input.space_id
            && existing.to_nickname == input.to.trim().trim_start_matches('@')
            && existing.from_conversation_id == input.caller_id.to_string()
            && serde_json::from_str::<HandoffEnvelope>(&existing.envelope_json).ok()
                == Some(input.envelope.clone());
        if !same {
            return Err(operation_conflict());
        }
        return Ok(existing.result());
    }
    if input.envelope.ask.trim().is_empty() {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "handoff ask must not be empty",
        ));
    }
    let to = input.to.trim().trim_start_matches('@').trim().to_string();
    let caller = caller_seat(pool, &input.space_id, input.caller_id).await?;
    let seat = seat_conversation(&caller).unwrap_or(input.caller_id);
    let members = list_space_members(pool, &input.space_id, MessageAudience::Agent).await?;
    let target = members
        .iter()
        .find(|member| member.nickname == to)
        .ok_or_else(|| CollaborationError::new("not_found", "nickname was not found"))?;
    let target_conversation = seat_conversation(target);
    if target_conversation == Some(seat) {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "cannot hand off to yourself",
        ));
    }
    let parent = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT id, depth FROM collaboration_handoffs
           WHERE space_id = ? AND to_conversation_id = ? AND status = 'accepted'
           ORDER BY created_at DESC, rowid DESC LIMIT 1"#,
    )
    .bind(&input.space_id)
    .bind(seat.to_string())
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let depth = parent.as_ref().map_or(1, |(_, depth)| depth + 1);
    let turn: Option<Option<Uuid>> =
        sqlx::query_scalar("SELECT active_turn_id FROM sessions WHERE id = ?")
            .bind(input.caller_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
    let turn_key = match turn.flatten() {
        Some(turn) => format!("turn:{turn}"),
        None => format!("operation:{handoff_id}"),
    };
    let used: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM collaboration_handoffs
           WHERE turn_key = ? AND from_conversation_id = ? AND status = 'accepted'"#,
    )
    .bind(&turn_key)
    .bind(input.caller_id.to_string())
    .fetch_one(pool)
    .await
    .map_err(db)?;
    let rejection = if depth > handoff_max_depth() {
        Some(format!(
            "handoff depth {depth} exceeds the limit of {}",
            handoff_max_depth()
        ))
    } else if used >= handoff_max_per_turn() {
        Some(format!(
            "this turn already started {used} handoffs (limit {})",
            handoff_max_per_turn()
        ))
    } else {
        None
    };
    let envelope_json = serde_json::to_string(&input.envelope).unwrap_or_default();
    let status = if rejection.is_some() {
        "rejected"
    } else {
        "accepted"
    };
    sqlx::query(
        r#"INSERT INTO collaboration_handoffs
           (id, space_id, from_conversation_id, to_nickname, to_conversation_id,
            parent_handoff_id, depth, turn_key, envelope_json, status, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&handoff_id)
    .bind(&input.space_id)
    .bind(input.caller_id.to_string())
    .bind(&to)
    .bind(target_conversation.map(|id| id.to_string()))
    .bind(parent.as_ref().map(|(id, _)| id.clone()))
    .bind(depth)
    .bind(&turn_key)
    .bind(&envelope_json)
    .bind(status)
    .bind(rejection.as_deref())
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db)?;
    if let Some(reason) = rejection {
        return Err(CollaborationError::new("limit_exceeded", reason));
    }
    let content = format!(
        "@{to} {}",
        render_handoff(&input.envelope, depth, &handoff_id)
    );
    let posted = post_to_space_with(
        pool,
        PostToSpace {
            caller_id: Some(input.caller_id),
            space_id: input.space_id.clone(),
            content,
            summary: Some(format!("handoff → {to}: {}", input.envelope.ask.trim())),
            to: vec![to.clone()],
            in_reply_to: None,
            operation_id: input.operation_id,
        },
        turn_delivery,
    )
    .await;
    let failure = match &posted {
        Err(error) => Some(format!("{}: {}", error.code, error.message)),
        Ok(result) => result
            .receipts
            .iter()
            .find(|receipt| Some(receipt.conversation_id) == target_conversation)
            .and_then(|receipt| receipt.error_code.clone())
            .filter(|code| code != "wake_limit_exceeded")
            .map(|code| format!("delivery failed: {code}")),
    };
    let message_id = posted.as_ref().ok().map(|result| result.message_id.clone());
    if let Some(reason) = failure {
        let report_id = Uuid::new_v5(
            &Uuid::NAMESPACE_OID,
            format!("handoff-report:{handoff_id}").as_bytes(),
        );
        let report = post_to_space_with(
            pool,
            PostToSpace {
                caller_id: Some(input.caller_id),
                space_id: input.space_id.clone(),
                content: format!(
                    "交接给 {to} 失败（{reason}）。待办：{}",
                    input.envelope.ask.trim()
                ),
                summary: Some(format!("handoff to {to} failed")),
                to: vec!["User".to_string()],
                in_reply_to: message_id.clone(),
                operation_id: report_id,
            },
            turn_delivery,
        )
        .await
        .ok()
        .map(|result| result.message_id);
        sqlx::query(
            r#"UPDATE collaboration_handoffs
               SET status = 'failed', reason = ?, message_id = ?, report_message_id = ?
               WHERE id = ?"#,
        )
        .bind(&reason)
        .bind(&message_id)
        .bind(&report)
        .bind(&handoff_id)
        .execute(pool)
        .await
        .map_err(db)?;
    } else {
        sqlx::query("UPDATE collaboration_handoffs SET message_id = ? WHERE id = ?")
            .bind(&message_id)
            .bind(&handoff_id)
            .execute(pool)
            .await
            .map_err(db)?;
    }
    Ok(load_handoff(pool, &handoff_id)
        .await?
        .map(|row| row.result())
        .unwrap_or(HandoffResult {
            handoff_id,
            status: "failed".to_string(),
            depth,
            message_id,
            reason: None,
            report_message_id: None,
        }))
}

pub async fn handoff(
    pool: &SqlitePool,
    input: Handoff,
) -> Result<HandoffResult, CollaborationError> {
    handoff_with(pool, input, &DeliveryContext::default()).await
}

pub(crate) async fn load_handoff(
    pool: &SqlitePool,
    id: &str,
) -> Result<Option<HandoffRow>, CollaborationError> {
    sqlx::query_as::<_, HandoffRow>(
        r#"SELECT id, status, depth, message_id, reason, report_message_id, envelope_json,
                  to_nickname, space_id, from_conversation_id
           FROM collaboration_handoffs WHERE id = ?"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(db)
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
           LIMIT 100"#,
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;
    for (space_id, message_id) in &pending {
        if let Err(error) = deliver_pending(pool, space_id, message_id, delivery).await {
            tracing::warn!(%error, %message_id, "deferred space delivery retry failed");
        }
    }
    Ok(pending.len())
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

/// Finalize any unclosed `receipt_state = 'processing'` deliveries for `conversation_id`
/// when its turn completes without having called `post_to_space` / `handoff` / `ask_person`.
pub async fn finalize_space_turn_deliveries(
    pool: &SqlitePool,
    conversation_id: Uuid,
    turn_assistant_text: &str,
    delivery: &DeliveryContext,
) -> Result<Vec<CollaborationSpaceChangedEvent>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, String, i64)>(
        r#"SELECT m.space_id, d.space_message_id, m.seq
           FROM collaboration_space_deliveries d
           JOIN collaboration_space_messages m ON m.id = d.space_message_id
           WHERE d.conversation_id = ?
             AND d.receipt_state = 'processing'
           ORDER BY m.seq ASC"#,
    )
    .bind(conversation_id.to_string())
    .fetch_all(pool)
    .await
    .map_err(db)?;

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let mut grouped: std::collections::BTreeMap<String, (String, i64)> =
        std::collections::BTreeMap::new();
    for (space_id, message_id, seq) in rows {
        grouped.insert(space_id, (message_id, seq));
    }

    let trimmed = turn_assistant_text.trim();
    let has_substantive_reply = !trimmed.is_empty() && !is_polite_ack_only(trimmed);
    let mut events = Vec::new();

    for (space_id, (trigger_message_id, trigger_seq)) in grouped {
        if parse_unassigned_space_id(&space_id).is_some()
            || space_id.starts_with(identity::DIRECT_PREFIX)
        {
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

        if has_substantive_reply {
            let op_id = Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!(
                    "finalize-space-turn:{}:{}:{}",
                    conversation_id,
                    trigger_message_id,
                    digest_text(trimmed)
                )
                .as_bytes(),
            );
            let content = trimmed.to_string();
            match post_to_space_with(
                pool,
                PostToSpace {
                    caller_id: Some(conversation_id),
                    space_id: space_id.clone(),
                    content,
                    summary: None,
                    to: vec!["User".to_string()],
                    in_reply_to: Some(trigger_message_id.clone()),
                    operation_id: op_id,
                },
                delivery,
            )
            .await
            {
                Ok(posted) => {
                    if let Ok(space) = load_space_or_unassigned(pool, &space_id).await
                        && let Ok(ws_id) = Uuid::parse_str(&space.workspace_id)
                    {
                        events.push(CollaborationSpaceChangedEvent {
                            workspace_id: ws_id,
                            space_id: space_id.clone(),
                            seq: Some(posted.seq),
                            member_id: None,
                        });
                    }
                    continue;
                }
                Err(error) => {
                    tracing::warn!(
                        %error,
                        %conversation_id,
                        %space_id,
                        "fallback post_to_space on turn completion failed; marking receipt replied"
                    );
                }
            }
        }

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

        if let Ok(space) = load_space_or_unassigned(pool, &space_id).await
            && let Ok(ws_id) = Uuid::parse_str(&space.workspace_id)
        {
            let evt = CollaborationSpaceChangedEvent {
                workspace_id: ws_id,
                space_id: space_id.clone(),
                seq: Some(trigger_seq),
                member_id: None,
            };
            delivery.notify_space_changed(evt.clone());
            events.push(evt);
        }
    }

    Ok(events)
}

#[derive(Debug, FromRow)]
pub(crate) struct MessageHead {
    pub(crate) space_id: String,
    pub(crate) envelope_json: String,
}

pub(crate) async fn load_message_head(
    pool: &SqlitePool,
    message_id: &str,
) -> Result<Option<MessageHead>, CollaborationError> {
    sqlx::query_as::<_, MessageHead>(
        "SELECT space_id, envelope_json FROM collaboration_space_messages WHERE id = ?",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(db)
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
    let Ok(envelope) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    if envelope.get("content").and_then(Value::as_str)
        != request.get("content").and_then(Value::as_str)
    {
        return false;
    }
    if envelope.get("actor").and_then(Value::as_str) != request.get("actor").and_then(Value::as_str)
    {
        return false;
    }
    let stored_reply = envelope
        .get("inReplyTo")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let requested_reply = request
        .get("in_reply_to")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    if stored_reply != requested_reply {
        return false;
    }
    if let Some(summary) = request.get("summary").and_then(Value::as_str)
        && envelope.get("summary").and_then(Value::as_str) != Some(summary)
    {
        return false;
    }
    let Some(items) = request.get("to").and_then(Value::as_array) else {
        return true;
    };
    if items.is_empty() {
        return true;
    }
    let mut requested: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
    let mut stored: Vec<&str> = envelope
        .get("to")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|item| item.as_str().and_then(|uri| uri.rsplit('/').next()))
                .collect()
        })
        .unwrap_or_default();
    requested.sort_unstable();
    stored.sort_unstable();
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

#[derive(Debug, FromRow)]
pub(crate) struct PendingDelivery {
    pub(crate) conversation_id: String,
    pub(crate) operation_id: String,
    pub(crate) input_id: Option<String>,
    pub(crate) status: String,
    pub(crate) receipt_state: String,
    pub(crate) context_from_seq: Option<i64>,
    pub(crate) wake_deferred_turn_key: Option<String>,
}

pub(crate) async fn mark_delivery_failed(
    pool: &SqlitePool,
    message_id: &str,
    conversation_id: Uuid,
) -> Result<(), CollaborationError> {
    sqlx::query(
        r#"UPDATE collaboration_space_deliveries
           SET status = 'failed'
           WHERE space_message_id = ? AND conversation_id = ?"#,
    )
    .bind(message_id)
    .bind(conversation_id.to_string())
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

pub(crate) struct StoredSpaceOperation {
    pub(crate) space_id: Option<String>,
    pub(crate) request_json: String,
    pub(crate) result: Value,
}

pub(crate) async fn load_stored_operation(
    pool: &SqlitePool,
    operation_id: &str,
) -> Result<Option<StoredSpaceOperation>, CollaborationError> {
    let row = sqlx::query_as::<_, (Option<String>, String, String)>(
        r#"SELECT space_id, request_json, result_json
           FROM collaboration_space_operations WHERE operation_id = ?"#,
    )
    .bind(operation_id)
    .fetch_optional(pool)
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
    sqlx::query(
        r#"INSERT INTO collaboration_space_operations
           (operation_id, space_id, request_json, result_json, created_at)
           VALUES (?, ?, ?, ?, ?)"#,
    )
    .bind(operation_id)
    .bind(space_id)
    .bind(request_json)
    .bind(result_json)
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

pub(crate) fn member_actor(space_id: &str, nickname: &str) -> String {
    format!("vibex://space/{space_id}/member/{nickname}")
}

pub(crate) fn user_actor(space_id: &str) -> String {
    format!("vibex://space/{space_id}/user")
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
    let actor = envelope
        .get("actor")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let user_uri = user_actor(space_id);
    if actor == user_uri || actor == "user" {
        return CollaborationSpaceOrigin {
            space_id: space_id.to_string(),
            thread_kind: space_thread_kind(space_id).to_string(),
            sender_kind: "user".to_string(),
            sender_nickname: "你".to_string(),
            sender_conversation_id: None,
            sender_member_id: None,
        };
    }
    let nick = actor
        .rsplit("/member/")
        .next()
        .filter(|value| *value != actor)
        .unwrap_or(actor);
    let sender_conversation_id = envelope
        .get("attributedTo")
        .and_then(Value::as_str)
        .and_then(|uri| uri.rsplit('/').next().map(str::to_string))
        .filter(|value| !value.is_empty());
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::test_support::*;

    #[tokio::test]
    async fn workspace_policy_allows_sibling() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let caller = Uuid::new_v4();
        let sibling = Uuid::new_v4();
        create_session(&pool, caller, workspace, None).await;
        create_session(&pool, sibling, workspace, None).await;
        let receipt = send_session_input(
            &pool,
            send_for(caller, sibling, CompanionWritePolicy::SameWorkspace),
        )
        .await
        .unwrap();
        assert_eq!(receipt.delivered, "queued");
        assert_eq!(input_count(&pool, sibling).await, 1);
    }

    struct RecordingDispatcher {
        turn_id: Uuid,
    }

    #[async_trait]
    impl IdleTurnDispatcher for RecordingDispatcher {
        async fn start_if_idle(&self, _conversation_id: Uuid) -> Result<Option<Uuid>, String> {
            Ok(Some(self.turn_id))
        }
    }

    #[tokio::test]
    async fn idle_send_dispatches_only_through_the_dispatcher() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let turn_id = Uuid::new_v4();
        let receipt = send_session_input_with(
            &pool,
            send_for(caller, caller, CompanionWritePolicy::SameWorkspace),
            &DeliveryContext {
                publisher: None,
                dispatcher: Some(Arc::new(RecordingDispatcher { turn_id })),
                space_changed: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(receipt.delivered, "dispatched");
        assert_eq!(receipt.turn_id, Some(turn_id));
        assert!(!receipt.idempotent_replay);
    }

    #[tokio::test]
    async fn same_operation_with_different_text_conflicts() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        send_session_input(&pool, request.clone()).await.unwrap();
        request.text = "different".to_string();
        let error = send_session_input(&pool, request).await.unwrap_err();
        assert_eq!(error.code, "conversation_control_failed");
        assert!(error.message.contains("different content"));
        assert_eq!(input_count(&pool, caller).await, 1);
    }

    #[tokio::test]
    async fn digest_fold_records_the_new_operation() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let first = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        let first_receipt = send_session_input(&pool, first.clone()).await.unwrap();
        let mut second = first.clone();
        second.operation_id = Uuid::new_v4();
        let replay = send_session_input(&pool, second.clone()).await.unwrap();
        assert!(replay.idempotent_replay);
        assert_eq!(replay.input_id, first_receipt.input_id);
        assert_eq!(input_count(&pool, caller).await, 1);
        let aliases: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collaboration_send_claim WHERE conversation_id = ? AND counts = 0",
    )
    .bind(caller.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
        assert_eq!(aliases, 1);
        let stored: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_send_claim WHERE operation_id = ?",
        )
        .bind(second.operation_id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored, 1);
    }

    #[tokio::test]
    async fn hourly_cap_counts_only_new_submits() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        for index in 0..60 {
            sqlx::query(
                r#"INSERT INTO collaboration_send_claim
               (conversation_id, operation_id, payload_digest, principal_json, receipt_json,
                counts, created_at)
               VALUES (?, ?, ?, '{}', '{}', 1, ?)"#,
            )
            .bind(caller.to_string())
            .bind(format!("op-{index}"))
            .bind(format!("digest-{index}"))
            .bind(now_stamp())
            .execute(&pool)
            .await
            .unwrap();
        }
        let error = send_session_input(
            &pool,
            send_for(caller, caller, CompanionWritePolicy::SameWorkspace),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "limit_exceeded");
        assert_eq!(input_count(&pool, caller).await, 0);
    }

    #[tokio::test]
    async fn ancestor_policy_rejects_sibling() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let caller = Uuid::new_v4();
        let sibling = Uuid::new_v4();
        create_session(&pool, caller, workspace, None).await;
        create_session(&pool, sibling, workspace, None).await;
        let error = send_session_input(
            &pool,
            send_for(caller, sibling, CompanionWritePolicy::AncestorTree),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "out_of_scope");
        assert_eq!(input_count(&pool, sibling).await, 0);
    }

    #[tokio::test]
    async fn cross_workspace_is_not_found() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        let target = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        create_session(&pool, target, Uuid::new_v4(), Some("SECRET_TITLE")).await;
        let error = send_session_input(
            &pool,
            send_for(caller, target, CompanionWritePolicy::SameWorkspace),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "not_found");
        assert!(!error.message.contains("SECRET_TITLE"));
        assert!(!error.to_json().to_string().contains("SECRET_TITLE"));
    }

    #[tokio::test]
    async fn self_submit_queues_behind_inflight() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        mark_running(&pool, caller).await;
        let receipt = send_session_input(
            &pool,
            send_for(caller, caller, CompanionWritePolicy::AncestorTree),
        )
        .await
        .unwrap();
        assert_eq!(receipt.delivered, "queued");
        let status: String =
            sqlx::query_scalar("SELECT status FROM conversation_turns WHERE conversation_id = ?")
                .bind(caller)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "running");
        assert_eq!(input_count(&pool, caller).await, 1);
    }

    #[tokio::test]
    async fn steer_unsupported_does_not_queue() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        request.steer = true;
        request.steer_supported = false;
        request.expected_turn_id = Some(Uuid::new_v4());
        let error = send_session_input(&pool, request).await.unwrap_err();
        assert_eq!(error.code, "steer_unsupported");
        assert_eq!(input_count(&pool, caller).await, 0);
    }

    #[tokio::test]
    async fn space_mention_submits_same_text_to_each() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, c, workspace, Some("小C")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
            .await
            .unwrap();
        let posted = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space,
                content: "请评审当前 diff。关注 auth.ts 的错误处理。".to_string(),
                summary: Some("请评审当前 diff".to_string()),
                to: vec!["小B".to_string(), "小C".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        assert_eq!(posted.receipts.len(), 2);
        let texts: Vec<String> = sqlx::query_scalar(
            "SELECT payload_json FROM conversation_inputs WHERE conversation_id IN (?, ?)",
        )
        .bind(b)
        .bind(c)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(texts.len(), 2);
        let payloads: Vec<Value> = texts
            .iter()
            .map(|text| serde_json::from_str(text).unwrap())
            .collect();
        let slim_of = |payload: &Value| -> String {
            payload["text"]
                .as_str()
                .unwrap()
                .split_once("[协作空间消息]")
                .map(|(_, rest)| rest.to_string())
                .unwrap_or_default()
        };
        for payload in &payloads {
            assert_eq!(
                payload["displayText"].as_str(),
                Some("请评审当前 diff。关注 auth.ts 的错误处理。")
            );
            let text = payload["text"].as_str().unwrap();
            assert!(text.contains("请评审当前 diff"));
            assert!(text.contains("auth.ts"));
            assert!(text.contains("[协作空间消息]"));
            assert!(text.contains("来源：小A"));
            assert!(
                text.contains("协同交互规则") || text.contains("协作空间交互规则"),
                "{text}"
            );
        }
        assert_eq!(slim_of(&payloads[0]), slim_of(&payloads[1]));
        let joined = texts.join("\n");
        assert!(joined.contains("你的成员昵称：小B"));
        assert!(joined.contains("你的成员昵称：小C"));
    }

    #[tokio::test]
    async fn member_post_to_own_direct_thread_lists_in_dm() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let seed = Uuid::new_v4();
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
        create_session(&pool, seed, workspace, Some("seed")).await;
        let created = host_create_space_member(
            &pool,
            HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "Builder".to_string(),
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
        let conversation = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
        let member = identity::binding_of_conversation(&pool, conversation)
            .await
            .unwrap()
            .expect("identity")
            .member_id;
        let thread = identity::direct_thread_id(&member);
        let posted = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(conversation),
                space_id: thread,
                content: "@User 你好，我是 Builder 👋 需要我做什么？".to_string(),
                summary: None,
                to: vec!["User".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .expect("post_to_space on the private chat");
        assert!(posted.seq >= 1);
        let messages =
            crate::collaboration_sidebar::list_dm_messages(&pool, conversation, None, Some(50))
                .await
                .unwrap();
        let greeting = messages
            .iter()
            .find(|message| message.origin == "agent" && message.text.contains("我是 Builder"))
            .expect("private-chat IM must list the post_to_space greeting");
        assert!(greeting.text.contains("需要我做什么"));
    }

    #[tokio::test]
    async fn direct_bot_addresses_workspace_peer_keeps_body_on_sender_and_receipt_on_dest() {
        let pool = setup_pool().await;
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
        let created_a = host_create_space_member(
            &pool,
            HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "小A".to_string(),
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
        let created_b = host_create_space_member(
            &pool,
            HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "小B".to_string(),
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
        let a_conv = Uuid::parse_str(created_a.conversation_id.as_deref().unwrap()).unwrap();
        let b_conv = Uuid::parse_str(created_b.conversation_id.as_deref().unwrap()).unwrap();
        let a_member = identity::binding_of_conversation(&pool, a_conv)
            .await
            .unwrap()
            .expect("identity")
            .member_id;
        let a_thread = identity::direct_thread_id(&a_member);
        let posted = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a_conv),
                space_id: a_thread,
                content: "@小B 请支援".to_string(),
                summary: None,
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .expect("workspace DM peers can be addressed from a private chat");
        assert!(
            posted
                .receipts
                .iter()
                .any(|receipt| receipt.conversation_id == b_conv),
            "destination DM conversation is woken"
        );

        let origin_dm =
            crate::collaboration_sidebar::list_dm_messages(&pool, a_conv, None, Some(50))
                .await
                .unwrap();
        let origin = origin_dm
            .iter()
            .find(|message| message.text.contains("请支援"))
            .expect("sender private chat keeps the body");
        assert!(
            origin
                .cross_chat_sent_to
                .as_ref()
                .is_some_and(|value| value.to_string().contains("小B")),
            "sender private chat marks the destination"
        );

        let dest_dm = crate::collaboration_sidebar::list_dm_messages(&pool, b_conv, None, Some(50))
            .await
            .unwrap();
        assert!(
            dest_dm
                .iter()
                .all(|message| !message.text.contains("请支援")),
            "destination private chat hides the foreign body"
        );
        assert!(
            dest_dm.iter().any(|message| {
                message.text.is_empty()
                    && message
                        .cross_chat_received_from
                        .as_ref()
                        .is_some_and(|value| value.to_string().contains("小A"))
            }),
            "destination private chat lists an empty receipt from the sender"
        );
    }

    #[tokio::test]
    async fn direct_user_message_wraps_space_context_for_agent() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
        "INSERT INTO workspaces (id, task_id, branch, created_at, updated_at) VALUES (?, ?, 'main', datetime('now'), datetime('now'))",
    )
        .bind(workspace)
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();
        let created = host_create_space_member(
            &pool,
            HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "私聊助手".to_string(),
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
        let conversation = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
        let member = identity::binding_of_conversation(&pool, conversation)
            .await
            .unwrap()
            .expect("identity")
            .member_id;
        let thread = identity::direct_thread_id(&member);
        send_user_text_to_conversation(
            &pool,
            conversation,
            Uuid::new_v4(),
            "今晚帮我看看登录",
            &DeliveryContext::default(),
        )
        .await
        .expect("deliver dm");

        let raw_payload: String = sqlx::query_scalar(
            "SELECT payload_json FROM conversation_inputs WHERE conversation_id = ?",
        )
        .bind(conversation)
        .fetch_one(&pool)
        .await
        .unwrap();
        let payload: Value = serde_json::from_str(&raw_payload).unwrap();
        assert_eq!(payload["displayText"].as_str(), Some("今晚帮我看看登录"));
        let text = payload["text"].as_str().unwrap();
        assert!(text.contains("[协作空间消息]"), "{text}");
        assert!(text.contains(&thread), "{text}");
        assert!(text.contains("今晚帮我看看登录"), "{text}");
        assert!(text.contains("post_to_space"), "{text}");
        assert_eq!(payload["collaborationOrigin"]["threadKind"], "dm");
        assert_eq!(payload["collaborationOrigin"]["senderKind"], "user");
        assert_eq!(payload["collaborationOrigin"]["spaceId"], thread);
    }

    #[tokio::test]
    async fn receipts_move_queued_processing_replied_and_origin_is_kept() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        // b is busy, so the input waits in its queue.
        mark_running(&pool, b).await;
        let posted = post_as(&pool, None, &space, "@小B 看一下", &[]).await;
        let to_b = posted
            .receipts
            .iter()
            .find(|receipt| receipt.conversation_id == b)
            .unwrap();
        assert_eq!(to_b.state, "queued");
        let input_id = to_b.input_id.unwrap();

        // The queue dispatches the input: receipt becomes processing.
        sqlx::query("UPDATE conversation_inputs SET status = 'dispatched' WHERE id = ?")
            .bind(input_id)
            .execute(&pool)
            .await
            .unwrap();
        let receipts = list_message_receipts(&pool, &posted.message_id)
            .await
            .unwrap();
        let state_of = |receipts: &[MessageReceipt]| {
            receipts
                .iter()
                .find(|r| r.conversation_id == b.to_string())
                .unwrap()
                .state
                .clone()
        };
        assert_eq!(state_of(&receipts), "processing");

        // b answers in the thread: replied.
        let reply = post_as(&pool, Some(b), &space, "看完了", &["User"]).await;
        let receipts = list_message_receipts(&pool, &posted.message_id)
            .await
            .unwrap();
        assert_eq!(state_of(&receipts), "replied");

        let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        let origin_of = |seq: i64| {
            messages
                .iter()
                .find(|m| m.seq == seq)
                .map(|m| m.origin.clone())
                .unwrap()
        };
        assert_eq!(origin_of(posted.seq), "user");
        assert_eq!(origin_of(reply.seq), "agent");
        let user_post = messages.iter().find(|m| m.seq == posted.seq).unwrap();
        assert_eq!(state_of(&user_post.receipts), "replied");
    }

    #[tokio::test]
    async fn listed_messages_expose_id_origin_and_reply_correlation() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let ask = post_as(&pool, Some(a), &space, "@小B 接口好了吗", &["小B"]).await;
        let reply = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(b),
                space_id: space.clone(),
                content: "@小A 好了".to_string(),
                summary: None,
                to: vec!["小A".to_string()],
                in_reply_to: Some(ask.message_id.clone()),
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let user_post = post_as(&pool, None, &space, "收到", &[]).await;

        let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        let by_seq = |seq: i64| messages.iter().find(|m| m.seq == seq).unwrap();
        assert_eq!(by_seq(ask.seq).id, ask.message_id);
        assert_eq!(by_seq(ask.seq).origin, "agent");
        assert_eq!(by_seq(ask.seq).in_reply_to, None);
        assert_eq!(by_seq(reply.seq).id, reply.message_id);
        assert_eq!(by_seq(reply.seq).origin, "agent");
        assert_eq!(
            by_seq(reply.seq).in_reply_to.as_deref(),
            Some(ask.message_id.as_str())
        );
        assert_eq!(by_seq(user_post.seq).origin, "user");

        // Wire shape the frontend reads.
        let wire = serde_json::to_value(by_seq(reply.seq)).unwrap();
        assert_eq!(wire["id"], json!(reply.message_id));
        assert_eq!(wire["origin"], json!("agent"));
        assert_eq!(wire["in_reply_to"], json!(ask.message_id));
        let wire_ask = serde_json::to_value(by_seq(ask.seq)).unwrap();
        assert!(wire_ask.get("in_reply_to").is_none());

        // Agents see the same correlation.
        let agent_view = list_space_messages(&pool, &space, None, None, MessageAudience::Agent)
            .await
            .unwrap();
        let agent_reply = agent_view.iter().find(|m| m.seq == reply.seq).unwrap();
        assert_eq!(
            agent_reply.in_reply_to.as_deref(),
            Some(ask.message_id.as_str())
        );
    }

    #[tokio::test]
    async fn missed_context_keeps_last_20_and_collapses_older_into_one_line() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, c, workspace, Some("小C")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
            .await
            .unwrap();
        for i in 1..=25 {
            post_as(&pool, None, &space, &format!("@小C 第{i:02}条"), &[]).await;
        }
        post_as(&pool, None, &space, "@小B 你来总结", &[]).await;
        let to_b = inputs_of(&pool, b).await;
        let packed: Value = serde_json::from_str(to_b.last().unwrap()).unwrap();
        let packed = packed["text"].as_str().unwrap();
        assert!(
            !packed.contains("missed_group_messages"),
            "history is on-demand via list_space_messages: {packed}"
        );
        assert!(!packed.contains("第06条") && !packed.contains("第25条"));
        let helper = missed_group_context(&pool, &space, b, 0, 26)
            .await
            .unwrap()
            .expect("helper still renders a backlog");
        assert!(helper.contains("count=\"25\""), "{helper}");
        assert_eq!(helper.matches("] User: ").count(), MISSED_CONTEXT_VERBATIM);
        assert!(helper.contains("5 earlier messages from User (collapsed"));
    }

    #[tokio::test]
    async fn mention_packs_missed_group_messages_and_advances_last_seen() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, c, workspace, Some("小C")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
            .await
            .unwrap();
        let first = post_as(&pool, None, &space, "@小C 先看接口", &[]).await;
        post_as(&pool, Some(c), &space, "接口没问题", &["User"]).await;
        let member_b = identity::member_id_for_conversation(b);
        let seen = |member: String| {
            let pool = pool.clone();
            let space = space.clone();
            async move {
                sqlx::query_scalar::<_, Option<String>>(
                "SELECT last_seen_message_id FROM collaboration_thread_members WHERE thread_id = ? AND member_id = ?",
            )
            .bind(space)
            .bind(member)
            .fetch_one(&pool)
            .await
            .unwrap()
            }
        };
        assert_eq!(seen(member_b.clone()).await, None);
        assert_eq!(
            seen(identity::member_id_for_conversation(c)).await,
            Some(first.message_id.clone())
        );

        let mention = post_as(&pool, None, &space, "@小B 你来总结", &[]).await;
        let to_b = inputs_of(&pool, b).await;
        assert_eq!(to_b.len(), 1);
        assert!(
            !to_b[0].contains("missed_group_messages"),
            "history is pulled with list_space_messages: {}",
            to_b[0]
        );
        assert!(
            to_b[0].contains("你来总结") || to_b[0].contains("来总结"),
            "{}",
            to_b[0]
        );
        assert_eq!(
            seen(member_b.clone()).await,
            Some(mention.message_id.clone())
        );

        post_as(&pool, None, &space, "@小B 再补一句", &[]).await;
        let to_b = inputs_of(&pool, b).await;
        assert_eq!(to_b.len(), 2);
        assert!(!to_b[1].contains("missed_group_messages"));
        let first: Value = serde_json::from_str(&to_b[0]).unwrap();
        let second: Value = serde_json::from_str(&to_b[1]).unwrap();
        let first = first["text"].as_str().unwrap();
        let second = second["text"].as_str().unwrap();
        assert!(
            first.contains("协同交互规则") || first.contains("协作空间交互规则"),
            "{first}"
        );
        assert!(
            !second.contains("协同交互规则") && !second.contains("协作空间交互规则"),
            "{second}"
        );
    }

    #[tokio::test]
    async fn handoff_delivers_envelope_and_enforces_depth() {
        let pool = setup_pool().await;
        let (space, ids) = handoff_team(&pool).await;
        let first = hand(&pool, ids[0], &space, "小B", "实现登录")
            .await
            .unwrap();
        assert_eq!((first.status.as_str(), first.depth), ("accepted", 1));
        let to_b = inputs_of(&pool, ids[1]).await;
        assert_eq!(to_b.len(), 1);
        for part in [
            "<done>",
            "接口草案已完成",
            "<inputs_constraints>",
            "<ask>",
            "实现登录",
        ] {
            assert!(to_b[0].contains(part), "missing {part}");
        }
        assert_eq!(
            hand(&pool, ids[1], &space, "小C", "写测试")
                .await
                .unwrap()
                .depth,
            2
        );
        assert_eq!(
            hand(&pool, ids[2], &space, "小D", "跑测试")
                .await
                .unwrap()
                .depth,
            3
        );
        let too_deep = hand(&pool, ids[3], &space, "小A", "再转")
            .await
            .unwrap_err();
        assert_eq!(too_deep.code, "limit_exceeded");
        let recorded: (String, i64, Option<String>) = sqlx::query_as(
        "SELECT status, depth, reason FROM collaboration_handoffs WHERE from_conversation_id = ?",
    )
    .bind(ids[3].to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
        assert_eq!(recorded.0, "rejected");
        assert_eq!(recorded.1, 4);
        assert!(recorded.2.unwrap().contains("depth"));
        // Rejected handoffs deliver nothing.
        assert!(inputs_of(&pool, ids[0]).await.is_empty());
    }

    #[tokio::test]
    async fn handoff_count_is_limited_per_turn() {
        let pool = setup_pool().await;
        let (space, ids) = handoff_team(&pool).await;
        let turn = mark_running(&pool, ids[0]).await;
        hand(&pool, ids[0], &space, "小B", "一").await.unwrap();
        hand(&pool, ids[0], &space, "小C", "二").await.unwrap();
        let third = hand(&pool, ids[0], &space, "小D", "三").await.unwrap_err();
        assert_eq!(third.code, "limit_exceeded");
        let rejected: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM collaboration_handoffs WHERE status = 'rejected' AND turn_key = ?",
    )
    .bind(format!("turn:{turn}"))
    .fetch_one(&pool)
    .await
    .unwrap();
        assert_eq!(rejected, 1);
        assert!(inputs_of(&pool, ids[3]).await.is_empty());
    }

    #[tokio::test]
    async fn failed_handoff_is_reported_back_into_the_thread() {
        let pool = setup_pool().await;
        let (space, ids) = handoff_team(&pool).await;
        sqlx::query("UPDATE sessions SET status = 'archived' WHERE id = ?")
            .bind(ids[1])
            .execute(&pool)
            .await
            .unwrap();
        let operation = Uuid::new_v4();
        let request = Handoff {
            caller_id: ids[0],
            space_id: space.clone(),
            to: "小B".to_string(),
            envelope: envelope("实现登录"),
            operation_id: operation,
        };
        let failed = handoff(&pool, request.clone()).await.unwrap();
        assert_eq!(failed.status, "failed");
        let report = failed.report_message_id.clone().expect("report posted");
        let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        let posted = messages
            .iter()
            .find(|m| m.envelope["id"] == json!(format!("vibex://space-message/{report}")))
            .expect("report in thread");
        assert_eq!(posted.origin, "agent");
        let report_content = posted.envelope["content"].as_str().unwrap();
        assert!(report_content.contains("失败"), "{report_content}");
        assert!(!report_content.starts_with("@User"), "{report_content}");
        // Replaying the same operation returns the recorded outcome.
        assert_eq!(handoff(&pool, request).await.unwrap(), failed);
    }

    #[tokio::test]
    async fn space_broadcast_skips_sender_and_user() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, c, workspace, Some("小C")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
            .await
            .unwrap();
        ensure_user_member(&pool, &space).await.unwrap();
        let posted = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "@所有人 广播".to_string(),
                summary: None,
                to: Vec::new(),
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let recipients: Vec<Uuid> = posted
            .receipts
            .iter()
            .map(|receipt| receipt.conversation_id)
            .collect();
        assert!(recipients.contains(&b));
        assert!(recipients.contains(&c));
        assert!(!recipients.contains(&a));
        assert_eq!(input_count(&pool, a).await, 0);
        let members = list_space_members(&pool, &space, MessageAudience::Agent)
            .await
            .unwrap();
        assert!(members.iter().all(|member| member.kind != "user"));
        let messages = list_space_messages(&pool, &space, None, None, MessageAudience::Agent)
            .await
            .unwrap();
        let encoded = serde_json::to_string(&messages).unwrap();
        assert!(!encoded.contains("/user"));
    }

    #[tokio::test]
    async fn agent_projection_hides_the_user_actor() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        post_to_space(
            &pool,
            PostToSpace {
                caller_id: None,
                space_id: space.clone(),
                content: "请看这里".to_string(),
                summary: None,
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let agent_messages = list_space_messages(&pool, &space, None, None, MessageAudience::Agent)
            .await
            .unwrap();
        let agent_json = serde_json::to_string(&agent_messages).unwrap();
        assert!(!agent_json.contains("/user"));
        assert!(agent_json.contains("\"actor\":\"user\""));
        let user_messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        let user_json = serde_json::to_string(&user_messages).unwrap();
        assert!(user_json.contains("/user"));
    }

    #[tokio::test]
    async fn space_replay_requires_membership_and_the_same_request() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let outsider = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, outsider, workspace, Some("外人")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let operation_id = Uuid::new_v4();
        let request = PostToSpace {
            caller_id: Some(a),
            space_id: space.clone(),
            content: "一次".to_string(),
            summary: Some("一次".to_string()),
            to: vec!["小B".to_string()],
            in_reply_to: None,
            operation_id,
        };
        post_to_space(&pool, request.clone()).await.unwrap();
        let mut outsider_request = request.clone();
        outsider_request.caller_id = Some(outsider);
        let denied = post_to_space(&pool, outsider_request).await.unwrap_err();
        assert_eq!(denied.code, "not_a_member");
        // Same-turn agent reuse of operation_id with different content derives a new message_id
        let mut changed_content = request.clone();
        changed_content.content = "两次".to_string();
        let derived = post_to_space(&pool, changed_content).await.unwrap();
        assert_ne!(derived.message_id, operation_id.to_string());
        assert_eq!(input_count(&pool, b).await, 2);

        // Same content but different recipient list with same operation_id still conflicts
        let mut changed = request.clone();
        changed.to = vec!["User".to_string()];
        let conflict = post_to_space(&pool, changed).await.unwrap_err();
        assert_eq!(conflict.code, "conversation_control_failed");
        let other = create_collaboration_space(&pool, a, "另一空间", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &other.space_id, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let mut wrong_space = request.clone();
        wrong_space.space_id = other.space_id.clone();
        let missing = post_to_space(&pool, wrong_space).await.unwrap_err();
        assert_eq!(missing.code, "not_found");
        let leaked: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_messages WHERE space_id = ?",
        )
        .bind(&other.space_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(leaked, 0);
    }

    #[tokio::test]
    async fn space_inflight_member_is_queued() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        mark_running(&pool, b).await;
        let posted = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space,
                content: "补充".to_string(),
                summary: Some("补充".to_string()),
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        assert_eq!(posted.receipts[0].delivered, "queued");
        let status: String =
            sqlx::query_scalar("SELECT status FROM conversation_turns WHERE conversation_id = ?")
                .bind(b)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "running");
    }

    #[tokio::test]
    async fn space_retry_does_not_double_submit() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let operation_id = Uuid::new_v4();
        let request = PostToSpace {
            caller_id: Some(a),
            space_id: space,
            content: "一次".to_string(),
            summary: Some("一次".to_string()),
            to: vec!["小B".to_string()],
            in_reply_to: None,
            operation_id,
        };
        post_to_space(&pool, request.clone()).await.unwrap();
        post_to_space(&pool, request).await.unwrap();
        assert_eq!(input_count(&pool, b).await, 1);
        let deliveries: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM collaboration_space_deliveries WHERE conversation_id = ?",
        )
        .bind(b.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(deliveries, 1);
    }

    #[tokio::test]
    async fn list_messages_since_seq() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        let first = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "一".to_string(),
                summary: None,
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "二".to_string(),
                summary: None,
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let later =
            list_space_messages(&pool, &space, Some(first.seq), None, MessageAudience::User)
                .await
                .unwrap();
        assert_eq!(later.len(), 1);
        assert!(later[0].seq > first.seq);
        assert!(
            later[0].envelope["content"]
                .as_str()
                .unwrap()
                .contains('二')
        );
    }

    #[tokio::test]
    async fn space_delivery_strips_mention_for_display_and_embeds_protocol_context() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;
        post_to_space(
            &pool,
            PostToSpace {
                caller_id: None,
                space_id: space.clone(),
                content: " @小A 请你分析我当前项目的性能".to_string(),
                summary: None,
                to: vec!["小A".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();

        let raw_payload: String = sqlx::query_scalar(
            "SELECT payload_json FROM conversation_inputs WHERE conversation_id = ?",
        )
        .bind(a)
        .fetch_one(&pool)
        .await
        .unwrap();
        let payload: Value = serde_json::from_str(&raw_payload).unwrap();
        assert_eq!(
            payload["displayText"].as_str(),
            Some("请你分析我当前项目的性能")
        );
        let text = payload["text"].as_str().unwrap();
        assert!(text.contains("[协作空间消息]"));
        assert!(text.contains("评审工作"));
        assert!(text.contains(&space));
        assert!(text.contains("来源：User"));
        assert!(text.contains("协同交互规则") || text.contains("协作空间交互规则"));
        assert!(!text.contains("空间内成员"));
        assert_eq!(text.matches("请你分析我当前项目的性能").count(), 1);
        assert_eq!(payload["collaborationOrigin"]["threadKind"], "group");
        assert_eq!(payload["collaborationOrigin"]["senderKind"], "user");
        assert_eq!(payload["collaborationOrigin"]["senderNickname"], "你");

        let context = persona_prompt_text(&pool, a).await.unwrap().unwrap();
        assert!(context.contains("[协作空间成员身份]"));
        assert!(context.contains("小A"));
        assert!(context.contains(&space));

        // Member can reply to @User in the space and query spaces & members
        let reply = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "@User 性能分析已完成".to_string(),
                summary: None,
                to: vec!["User".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        assert_eq!(reply.seq, 2);
        assert!(reply.receipts.is_empty());

        let spaces_view = list_collaboration_spaces_for_caller(&pool, a)
            .await
            .unwrap();
        assert_eq!(spaces_view["spaces"][0]["space_id"], space);
        assert_eq!(spaces_view["spaces"][0]["is_member"], true);
        assert_eq!(spaces_view["spaces"][0]["my_nickname"], "小A");

        let members_view = list_space_members_detailed(&pool, a, &space).await.unwrap();
        assert_eq!(members_view["my_nickname"], "小A");
        assert_eq!(members_view["members"][0]["nickname"], "小A");
        assert_eq!(members_view["members"][0]["is_self"], true);
    }

    #[tokio::test]
    async fn member_space_post_labels_origin_sender_on_peer_input() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "@小B 请核对接口".to_string(),
                summary: None,
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();

        let raw_payload: String = sqlx::query_scalar(
            "SELECT payload_json FROM conversation_inputs WHERE conversation_id = ?",
        )
        .bind(b)
        .fetch_one(&pool)
        .await
        .unwrap();
        let payload: Value = serde_json::from_str(&raw_payload).unwrap();
        assert_eq!(payload["displayText"].as_str(), Some("请核对接口"));
        let text = payload["text"].as_str().unwrap();
        assert!(text.contains("[协作空间消息]"), "{text}");
        assert!(text.contains("小A"), "{text}");
        assert_eq!(payload["collaborationOrigin"]["threadKind"], "group");
        assert_eq!(payload["collaborationOrigin"]["senderKind"], "member");
        assert_eq!(payload["collaborationOrigin"]["senderNickname"], "小A");
        assert_eq!(
            payload["collaborationOrigin"]["senderConversationId"].as_str(),
            Some(a.to_string().as_str())
        );
    }

    #[tokio::test]
    async fn post_to_space_on_unassigned_space_returns_invalid_space_for_direct_chat() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let bot = Uuid::new_v4();
        create_session(&pool, bot, workspace, Some("私聊Bot")).await;
        let unassigned = unassigned_space_id(workspace);

        let err = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(bot),
                space_id: unassigned.clone(),
                content: "你好".to_string(),
                summary: None,
                to: vec!["User".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "invalid_space_for_direct_chat");

        let delayed_err = post_to_space_delayed_with(
            &pool,
            PostToSpace {
                caller_id: Some(bot),
                space_id: unassigned,
                content: "延时你好".to_string(),
                summary: None,
                to: vec!["User".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
            Some(60),
            &DeliveryContext::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(delayed_err.code, "invalid_space_for_direct_chat");
    }

    #[tokio::test]
    async fn group_bot_post_to_space_broadcast_all_default_user_and_no_cross_space_pull() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, c, workspace, Some("小C")).await;

        let space1 = space_of(&pool, a).await;
        add_space_member(&pool, a, &space1, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &space1, c, "小C", Uuid::new_v4())
            .await
            .unwrap();

        // 1. Bot omits `to: []` and content has no `@` -> delivers ONLY to User (0 agent receipts/wakes)
        let to_user_only = post_as(&pool, Some(a), &space1, "我已经完成初步分析", &[]).await;
        assert!(
            to_user_only.receipts.is_empty(),
            "bot post without `to` or `@` must default to User and not wake other agents"
        );
        assert_eq!(input_count(&pool, b).await, 0);
        assert_eq!(input_count(&pool, c).await, 0);

        // 2. Bot passes `@所有人` in content (or `to: ["所有人"]`) -> broadcasts to all other agents in group
        let broadcast_by_content =
            post_as(&pool, Some(a), &space1, "@所有人 请看最新方案", &[]).await;
        let woken_ids: Vec<Uuid> = broadcast_by_content
            .receipts
            .iter()
            .map(|r| r.conversation_id)
            .collect();
        assert_eq!(woken_ids.len(), 2);
        assert!(woken_ids.contains(&b));
        assert!(woken_ids.contains(&c));

        let broadcast_by_to = post_as(&pool, Some(a), &space1, "请大家同步进度", &["所有人"]).await;
        assert_eq!(broadcast_by_to.receipts.len(), 2);

        // 3. Bot addresses a workspace DM peer: deliver to that DM, do not add them to this group.
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
        let expert = host_create_space_member(
            &pool,
            HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "外部专家".to_string(),
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
        let expert_conv = Uuid::parse_str(expert.conversation_id.as_deref().unwrap()).unwrap();
        let cross = post_to_space(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space1.clone(),
                content: "@外部专家 请支援".to_string(),
                summary: None,
                to: vec!["外部专家".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .expect("workspace DM peers can be addressed from a group");
        assert!(
            cross
                .receipts
                .iter()
                .any(|receipt| receipt.conversation_id == expert_conv),
            "external bot's DM conversation is woken"
        );
        let space1_members = list_space_members(&pool, &space1, MessageAudience::Agent)
            .await
            .unwrap();
        assert!(space1_members.iter().all(|m| m.nickname != "外部专家"));
        let origin_messages =
            list_space_messages(&pool, &space1, None, None, MessageAudience::User)
                .await
                .unwrap();
        let origin = origin_messages
            .iter()
            .find(|message| {
                message.envelope["content"]
                    .as_str()
                    .is_some_and(|text| text.contains("请支援"))
            })
            .expect("origin group keeps the body");
        assert!(origin.envelope.get("crossChatSentTo").is_some());
        let dm = crate::collaboration_sidebar::list_dm_messages(&pool, expert_conv, None, Some(50))
            .await
            .unwrap();
        assert!(
            dm.iter().all(|message| !message.text.contains("请支援")),
            "target DM does not list the foreign body"
        );
        assert!(
            dm.iter().any(|message| {
                message.text.is_empty()
                    && message
                        .cross_chat_received_from
                        .as_ref()
                        .is_some_and(|value| value.to_string().contains("小A"))
            }),
            "target DM lists an empty receipt from the sender"
        );
    }

    #[tokio::test]
    async fn finalize_space_turn_deliveries_posts_fallback_reply_and_clears_processing() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();

        // User sends a message mentioning 小B -> receipt enters `processing` once dispatched
        let user_msg = post_as(&pool, None, &space, "@小B 请汇报鉴权模块状态", &[]).await;
        let b_receipt = user_msg
            .receipts
            .iter()
            .find(|r| r.conversation_id == b)
            .unwrap();
        sqlx::query("UPDATE conversation_inputs SET status = 'dispatched' WHERE id = ?")
            .bind(b_receipt.input_id.unwrap())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
        "UPDATE collaboration_space_deliveries SET receipt_state = 'processing' WHERE space_message_id = ? AND conversation_id = ?",
    )
    .bind(&user_msg.message_id)
    .bind(b.to_string())
    .execute(&pool)
    .await
    .unwrap();

        // 小B finishes its turn with plain assistant text without calling `post_to_space`
        let events = finalize_space_turn_deliveries(
            &pool,
            b,
            "鉴权模块已完成单元测试并通过验证。",
            &DeliveryContext::default(),
        )
        .await
        .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].space_id, space);

        // Receipt for user_msg is now `replied`
        let receipts = list_message_receipts(&pool, &user_msg.message_id)
            .await
            .unwrap();
        let b_after = receipts
            .iter()
            .find(|r| r.conversation_id == b.to_string())
            .unwrap();
        assert_eq!(b_after.state, "replied");

        // And the fallback message was posted to the space for User
        let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        assert_eq!(messages.len(), 2);
        let fallback = &messages[1];
        assert_eq!(fallback.origin, "agent");
        assert_eq!(
            fallback.in_reply_to.as_deref(),
            Some(user_msg.message_id.as_str())
        );
        assert_eq!(
            fallback.envelope["content"].as_str().unwrap(),
            "鉴权模块已完成单元测试并通过验证。"
        );
    }

    #[tokio::test]
    async fn third_in_flight_delivery_queues_without_waking() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        create_session(&pool, c, workspace, Some("小C")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        add_space_member(&pool, a, &space, c, "小C", Uuid::new_v4())
            .await
            .unwrap();

        let first = post_as(&pool, None, &space, "@小A 先做", &[]).await;
        let second = post_as(&pool, None, &space, "@小B 再做", &[]).await;
        sqlx::query("UPDATE collaboration_space_deliveries SET receipt_state = 'processing'")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(input_count(&pool, c).await, 0);

        let third = post_as(&pool, None, &space, "@小C 第三件", &[]).await;
        assert_eq!(third.receipts.len(), 1);
        assert_eq!(third.receipts[0].conversation_id, c);
        assert_eq!(third.receipts[0].delivered, "queued");
        assert!(third.receipts[0].input_id.is_none());
        assert_eq!(input_count(&pool, c).await, 0);
        assert_eq!(input_count(&pool, a).await, 1);
        assert_eq!(input_count(&pool, b).await, 1);
        let _ = (first, second);
        let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        assert!(
            messages.iter().any(|message| message.origin == "system"),
            "concurrency cap must insert the system notice"
        );
    }

    #[tokio::test]
    async fn migrated_space_without_lead_still_posts() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;
        let lead: Option<String> =
            sqlx::query_scalar("SELECT lead_member_id FROM collaboration_spaces WHERE id = ?")
                .bind(&space)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(lead.is_none());
        let posted = post_as(&pool, None, &space, "旧群也能发", &[]).await;
        assert_eq!(posted.receipts.len(), 1);
        assert_eq!(posted.receipts[0].conversation_id, a);
    }
}
