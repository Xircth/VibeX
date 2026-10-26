use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use super::*;

pub(crate) fn scheduled_deadline(
    input: &SendSessionInput,
    cap_hours: i64,
) -> Result<Option<DateTime<Utc>>, CollaborationError> {
    let cap = Duration::hours(cap_hours);
    let now = Utc::now();
    let has_seconds = input.delay_seconds.is_some();
    let has_deadline = input
        .deliver_at
        .as_deref()
        .is_some_and(|raw| !raw.trim().is_empty());
    if has_seconds && has_deadline {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "delay_seconds and deliver_at are mutually exclusive",
        ));
    }
    if let Some(seconds) = input.delay_seconds {
        if seconds <= 0 {
            return Ok(None);
        }
        if seconds > cap.num_seconds() {
            return Err(CollaborationError::new(
                "delay_exceeds_cap",
                format!("delay exceeds {cap_hours} hours"),
            ));
        }
        return Ok(Some(now + Duration::seconds(seconds)));
    }
    let Some(raw) = input.deliver_at.as_deref() else {
        return Ok(None);
    };
    let when = DateTime::parse_from_rfc3339(raw)
        .map(|parsed| parsed.with_timezone(&Utc))
        .map_err(|_| {
            CollaborationError::new("conversation_control_failed", "deliver_at must be RFC3339")
        })?;
    if when - now > cap {
        return Err(CollaborationError::new(
            "delay_exceeds_cap",
            format!("delay exceeds {cap_hours} hours"),
        ));
    }
    if when <= now {
        return Ok(None);
    }
    Ok(Some(when))
}

pub(crate) async fn schedule_input(
    pool: &SqlitePool,
    input: &SendSessionInput,
    target: &SessionHead,
    deliver_at: DateTime<Utc>,
) -> Result<SendReceipt, CollaborationError> {
    let digest = digest_text(&input.text);
    let principal = json!({
        "kind": "companion",
        "parentConversationId": input.caller_id,
    })
    .to_string();
    let payload = json!({
        "text": input.text,
        "agent_id": target.agent_id,
        "workspace_id": target.workspace_id,
    });
    let mut conn = pool.acquire().await.map_err(db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let outcome = async {
        let existing = sqlx::query_as::<_, (String, String, String)>(
            r#"SELECT id, payload_digest, principal_json FROM conversation_delayed_inputs
               WHERE conversation_id = ? AND operation_id = ?"#,
        )
        .bind(input.conversation_id.to_string())
        .bind(input.operation_id.to_string())
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
        if let Some((id, stored_digest, stored_principal)) = existing {
            if stored_digest != digest || stored_principal != principal {
                return Err(operation_conflict());
            }
            return Ok(SendReceipt {
                delivered: "scheduled".to_string(),
                input_id: None,
                turn_id: None,
                delayed_input_id: Some(id),
                idempotent_replay: true,
            });
        }
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO conversation_delayed_inputs
               (id, conversation_id, operation_id, payload_json, payload_digest, principal_json,
                deliver_at, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)"#,
        )
        .bind(&id)
        .bind(input.conversation_id.to_string())
        .bind(input.operation_id.to_string())
        .bind(payload.to_string())
        .bind(&digest)
        .bind(&principal)
        .bind(stamp(deliver_at))
        .bind(now_stamp())
        .execute(&mut *conn)
        .await
        .map_err(db)?;
        Ok(SendReceipt {
            delivered: "scheduled".to_string(),
            input_id: None,
            turn_id: None,
            delayed_input_id: Some(id),
            idempotent_replay: false,
        })
    }
    .await;
    finish_immediate(&mut conn, outcome).await
}

pub async fn promote_due_delayed_inputs(pool: &SqlitePool) -> Result<u32, CollaborationError> {
    promote_due_delayed_inputs_with(pool, &DeliveryContext::default()).await
}

pub async fn promote_due_delayed_inputs_with(
    pool: &SqlitePool,
    delivery: &DeliveryContext,
) -> Result<u32, CollaborationError> {
    let due = sqlx::query_as::<_, DueDelay>(
        r#"SELECT id, conversation_id, operation_id, payload_json, principal_json
           FROM conversation_delayed_inputs
           WHERE status = 'scheduled' AND deliver_at <= ?
           ORDER BY deliver_at, id"#,
    )
    .bind(now_stamp())
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut promoted = 0;
    for row in due {
        if promote_one(pool, &row, delivery).await? {
            promoted += 1;
        }
    }
    Ok(promoted)
}

pub fn spawn_delayed_input_promoter(pool: SqlitePool, delivery: DeliveryContext) {
    tokio::spawn(async move {
        loop {
            if let Err(error) = promote_due_delayed_inputs_with(&pool, &delivery).await {
                tracing::warn!(%error, "delayed input promotion failed");
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
}

#[derive(Debug, FromRow)]
pub(crate) struct DueDelay {
    pub(crate) id: String,
    pub(crate) conversation_id: String,
    pub(crate) operation_id: String,
    pub(crate) payload_json: String,
    pub(crate) principal_json: String,
}

pub(crate) async fn promote_one(
    pool: &SqlitePool,
    row: &DueDelay,
    delivery: &DeliveryContext,
) -> Result<bool, CollaborationError> {
    let principal: Value = serde_json::from_str(&row.principal_json).unwrap_or_else(|_| json!({}));
    if principal.get("kind").and_then(Value::as_str) == Some("collaboration_space_post") {
        let payload: Value = serde_json::from_str(&row.payload_json).unwrap_or_else(|_| json!({}));
        let space_id = payload
            .get("space_id")
            .and_then(Value::as_str)
            .or_else(|| principal.get("space_id").and_then(Value::as_str))
            .unwrap_or_default()
            .to_string();
        let caller_id = payload
            .get("caller_id")
            .and_then(Value::as_str)
            .and_then(|v| Uuid::parse_str(v).ok());
        let content = payload
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let summary = payload
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_string);
        let to = payload
            .get("to")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let in_reply_to = payload
            .get("in_reply_to")
            .and_then(Value::as_str)
            .map(str::to_string);
        let operation_id = Uuid::parse_str(&row.operation_id).unwrap_or_else(|_| Uuid::new_v4());
        match post_to_space_with(
            pool,
            PostToSpace {
                caller_id,
                space_id: space_id.clone(),
                content,
                summary,
                to,
                in_reply_to,
                operation_id,
            },
            delivery,
        )
        .await
        {
            Ok(posted) => {
                sqlx::query(
                    r#"UPDATE conversation_delayed_inputs
                       SET status = 'promoted', promoted_input_id = ?, error = NULL
                       WHERE id = ? AND status = 'scheduled'"#,
                )
                .bind(&posted.message_id)
                .bind(&row.id)
                .execute(pool)
                .await
                .map_err(db)?;
                if let Ok(workspace_id) = space_workspace_id(pool, &space_id).await {
                    delivery.notify_space_changed(CollaborationSpaceChangedEvent {
                        workspace_id,
                        space_id,
                        seq: Some(posted.seq),
                        member_id: None,
                    });
                }
                return Ok(true);
            }
            Err(error) if error.code == "limit_exceeded" => return Ok(false),
            Err(error) => {
                mark_delay_failed(pool, &row.id, &error.message).await?;
                if let Ok(workspace_id) = space_workspace_id(pool, &space_id).await {
                    delivery.notify_space_changed(CollaborationSpaceChangedEvent {
                        workspace_id,
                        space_id,
                        seq: None,
                        member_id: None,
                    });
                }
                return Ok(false);
            }
        }
    }

    let Ok(conversation_id) = Uuid::parse_str(&row.conversation_id) else {
        mark_delay_failed(pool, &row.id, "invalid conversation").await?;
        return Ok(false);
    };
    let Ok(operation_id) = Uuid::parse_str(&row.operation_id) else {
        mark_delay_failed(pool, &row.id, "invalid operation").await?;
        return Ok(false);
    };
    let Some(head) = load_session(pool, conversation_id).await? else {
        mark_delay_failed(pool, &row.id, "conversation was not found").await?;
        return Ok(false);
    };
    if head.deleted_at.is_some() || head.status == "archived" {
        mark_delay_failed(pool, &row.id, "conversation was not found").await?;
        return Ok(false);
    }
    let payload: Value = serde_json::from_str(&row.payload_json).unwrap_or_else(|_| json!({}));
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let display_text = payload
        .get("display_text")
        .or_else(|| payload.get("displayText"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let origin = payload
        .get("collaboration_origin")
        .or_else(|| payload.get("collaborationOrigin"))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok());
    let receipt = match deliver_text(
        pool,
        conversation_id,
        operation_id,
        &text,
        display_text,
        origin,
        &head,
        principal.clone(),
        delivery,
    )
    .await
    {
        Ok(receipt) => receipt,
        Err(error) if error.code == "limit_exceeded" => return Ok(false),
        Err(error) => {
            mark_delay_failed(pool, &row.id, &error.message).await?;
            return Ok(false);
        }
    };
    sqlx::query(
        r#"UPDATE conversation_delayed_inputs
           SET status = 'promoted', promoted_input_id = ?, error = NULL
           WHERE id = ? AND status = 'scheduled'"#,
    )
    .bind(receipt.input_id.map(|id| id.to_string()))
    .bind(&row.id)
    .execute(pool)
    .await
    .map_err(db)?;
    let parent_conv = principal
        .get("parentConversationId")
        .and_then(Value::as_str)
        .map(str::to_string);
    delivery.notify_space_changed(CollaborationSpaceChangedEvent {
        workspace_id: head.workspace_id,
        space_id: format!("session:{conversation_id}"),
        seq: None,
        member_id: parent_conv,
    });
    Ok(true)
}

pub(crate) async fn mark_delay_failed(
    pool: &SqlitePool,
    id: &str,
    error: &str,
) -> Result<(), CollaborationError> {
    sqlx::query(
        r#"UPDATE conversation_delayed_inputs
           SET status = 'failed', error = ?
           WHERE id = ? AND status = 'scheduled'"#,
    )
    .bind(error)
    .bind(id)
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

pub async fn post_to_space_delayed_with(
    pool: &SqlitePool,
    input: PostToSpace,
    delay_seconds: Option<i64>,
    turn_delivery: &DeliveryContext,
) -> Result<SpacePostResult, CollaborationError> {
    if parse_unassigned_space_id(input.space_id.trim()).is_some() {
        return Err(CollaborationError::new(
            "invalid_space_for_direct_chat",
            "当前会话属于一对一私聊会话，无需调用 post_to_space 等群空间消息工具；请直接输出回复文本与用户交流。",
        ));
    }
    let seconds = delay_seconds.unwrap_or(0);
    if seconds <= 0 {
        return post_to_space_with(pool, input, turn_delivery).await;
    }
    let cap_seconds = Duration::hours(HARD_DELAY_HOURS).num_seconds();
    if seconds > cap_seconds {
        return Err(CollaborationError::new(
            "delay_exceeds_cap",
            format!("delay exceeds {HARD_DELAY_HOURS} hours"),
        ));
    }
    let content = input.content.trim();
    if content.is_empty() {
        return Err(CollaborationError::new(
            "conversation_control_failed",
            "content must not be empty",
        ));
    }
    let (nickname, sender) = match input.caller_id {
        Some(caller_id) => {
            let member = caller_seat(pool, &input.space_id, caller_id).await?;
            let seat = seat_conversation(&member).unwrap_or(caller_id);
            (member.nickname, Some(seat))
        }
        None => {
            ensure_user_member(pool, &input.space_id).await?;
            ("user".to_string(), None)
        }
    };
    let targets = resolve_targets(pool, &input.space_id, sender, &input.to, content).await?;
    let deliver_at = Utc::now() + Duration::seconds(seconds);
    let deliver_at_stamp = stamp(deliver_at);
    let digest = digest_text(content);
    let principal = json!({
        "kind": "collaboration_space_post",
        "space_id": input.space_id,
        "caller_id": input.caller_id,
        "nickname": nickname,
    })
    .to_string();
    let payload = json!({
        "space_id": input.space_id,
        "caller_id": input.caller_id,
        "nickname": nickname,
        "content": content,
        "summary": input.summary,
        "to": input.to,
        "in_reply_to": input.in_reply_to,
        "operation_id": input.operation_id,
    });
    let conv_key = input.caller_id.unwrap_or_else(Uuid::nil).to_string();
    let op_key = input.operation_id.to_string();
    let existing = sqlx::query_as::<_, (String, String, String)>(
        r#"SELECT id, payload_digest, principal_json FROM conversation_delayed_inputs
           WHERE conversation_id = ? AND operation_id = ?"#,
    )
    .bind(&conv_key)
    .bind(&op_key)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let delayed_id = if let Some((id, stored_digest, stored_principal)) = existing {
        if stored_digest != digest || stored_principal != principal {
            return Err(operation_conflict());
        }
        id
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO conversation_delayed_inputs
               (id, conversation_id, operation_id, payload_json, payload_digest, principal_json,
                deliver_at, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)"#,
        )
        .bind(&id)
        .bind(&conv_key)
        .bind(&op_key)
        .bind(payload.to_string())
        .bind(&digest)
        .bind(&principal)
        .bind(&deliver_at_stamp)
        .bind(now_stamp())
        .execute(pool)
        .await
        .map_err(db)?;
        id
    };
    let receipts = targets
        .into_iter()
        .filter_map(|target| {
            let conversation_id = target.conversation_id?;
            Some(DeliveryReceipt {
                conversation_id,
                nickname: target.nickname,
                delivered: "scheduled".to_string(),
                state: "queued".to_string(),
                input_id: None,
                error_code: None,
            })
        })
        .collect();
    Ok(SpacePostResult {
        message_id: delayed_id,
        seq: 0,
        receipts,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledSpaceMessage {
    pub id: String,
    pub space_id: String,
    pub caller_id: Option<String>,
    pub nickname: String,
    pub content: String,
    pub summary: Option<String>,
    pub to: Vec<String>,
    pub deliver_at: String,
    pub created_at: String,
}

pub async fn list_space_scheduled_messages(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<Vec<ScheduledSpaceMessage>, CollaborationError> {
    let rows = sqlx::query_as::<_, (String, String, String, String, String)>(
        r#"SELECT id, payload_json, principal_json, deliver_at, created_at
           FROM conversation_delayed_inputs
           WHERE status = 'scheduled'
             AND json_extract(principal_json, '$.kind') = 'collaboration_space_post'
             AND json_extract(principal_json, '$.space_id') = ?
           ORDER BY deliver_at ASC, created_at ASC"#,
    )
    .bind(space_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;

    let mut items = Vec::with_capacity(rows.len());
    for (id, payload_raw, principal_raw, deliver_at, created_at) in rows {
        let payload: Value = serde_json::from_str(&payload_raw).unwrap_or_else(|_| json!({}));
        let principal: Value = serde_json::from_str(&principal_raw).unwrap_or_else(|_| json!({}));
        let caller_id = payload
            .get("caller_id")
            .and_then(Value::as_str)
            .or_else(|| principal.get("caller_id").and_then(Value::as_str))
            .map(str::to_string);
        let nickname = payload
            .get("nickname")
            .and_then(Value::as_str)
            .or_else(|| principal.get("nickname").and_then(Value::as_str))
            .unwrap_or("user")
            .to_string();
        let content = payload
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let summary = payload
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_string);
        let to = payload
            .get("to")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        items.push(ScheduledSpaceMessage {
            id,
            space_id: space_id.to_string(),
            caller_id,
            nickname,
            content,
            summary,
            to,
            deliver_at,
            created_at,
        });
    }
    Ok(items)
}

pub async fn cancel_space_scheduled_message(
    pool: &SqlitePool,
    space_id: &str,
    id: &str,
) -> Result<bool, CollaborationError> {
    let result = sqlx::query(
        r#"UPDATE conversation_delayed_inputs
           SET status = 'cancelled'
           WHERE id = ? AND status = 'scheduled'
             AND json_extract(principal_json, '$.kind') = 'collaboration_space_post'
             AND json_extract(principal_json, '$.space_id') = ?"#,
    )
    .bind(id)
    .bind(space_id)
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(result.rows_affected() > 0)
}

pub async fn update_space_scheduled_message(
    pool: &SqlitePool,
    space_id: &str,
    id: &str,
    content: Option<&str>,
    delay_seconds: Option<i64>,
) -> Result<Option<ScheduledSpaceMessage>, CollaborationError> {
    let row = sqlx::query_as::<_, (String, String, String, String)>(
        r#"SELECT payload_json, principal_json, deliver_at, created_at
           FROM conversation_delayed_inputs
           WHERE id = ? AND status = 'scheduled'
             AND json_extract(principal_json, '$.kind') = 'collaboration_space_post'
             AND json_extract(principal_json, '$.space_id') = ?"#,
    )
    .bind(id)
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some((payload_raw, _principal_raw, deliver_at, _created_at)) = row else {
        return Ok(None);
    };
    let mut payload: Value = serde_json::from_str(&payload_raw).unwrap_or_else(|_| json!({}));
    if let Some(next_content) = content.map(str::trim).filter(|c| !c.is_empty()) {
        payload["content"] = json!(next_content);
    }
    let next_deliver_at = match delay_seconds.filter(|s| *s > 0) {
        Some(seconds) => stamp(Utc::now() + Duration::seconds(seconds)),
        None => deliver_at,
    };
    let next_text = payload
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let digest = digest_text(next_text);
    sqlx::query(
        r#"UPDATE conversation_delayed_inputs
           SET payload_json = ?, payload_digest = ?, deliver_at = ?
           WHERE id = ? AND status = 'scheduled'"#,
    )
    .bind(payload.to_string())
    .bind(&digest)
    .bind(&next_deliver_at)
    .bind(id)
    .execute(pool)
    .await
    .map_err(db)?;
    let all = list_space_scheduled_messages(pool, space_id).await?;
    Ok(all.into_iter().find(|item| item.id == id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::test_support::*;

    #[tokio::test]
    async fn delayed_row_does_not_take_sort_key() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        request.delay_seconds = Some(30);
        let receipt = send_session_input(&pool, request).await.unwrap();
        assert_eq!(receipt.delivered, "scheduled");
        assert!(receipt.delayed_input_id.is_some());
        assert_eq!(input_count(&pool, caller).await, 0);
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info('conversation_delayed_inputs')")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(!columns.iter().any(|column| column == "sort_key"));
    }

    #[tokio::test]
    async fn bad_deliver_at_is_not_reported_as_over_cap() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        request.deliver_at = Some("tomorrow".to_string());
        let error = send_session_input(&pool, request).await.unwrap_err();
        assert_eq!(error.code, "conversation_control_failed");
        assert!(error.message.contains("RFC3339"));
        assert_eq!(input_count(&pool, caller).await, 0);
    }

    #[tokio::test]
    async fn delay_fields_are_mutually_exclusive() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        request.delay_seconds = Some(10);
        request.deliver_at = Some(stamp(Utc::now() + Duration::hours(1)));
        let error = send_session_input(&pool, request).await.unwrap_err();
        assert_eq!(error.code, "conversation_control_failed");
        assert_eq!(input_count(&pool, caller).await, 0);
    }

    #[tokio::test]
    async fn promote_calls_submit_once() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        request.delay_seconds = Some(30);
        send_session_input(&pool, request).await.unwrap();
        sqlx::query(
            "UPDATE conversation_delayed_inputs SET deliver_at = ? WHERE conversation_id = ?",
        )
        .bind(stamp(Utc::now() - Duration::seconds(1)))
        .bind(caller.to_string())
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(promote_due_delayed_inputs(&pool).await.unwrap(), 1);
        assert_eq!(promote_due_delayed_inputs(&pool).await.unwrap(), 0);
        assert_eq!(input_count(&pool, caller).await, 1);
        let status: String = sqlx::query_scalar(
            "SELECT status FROM conversation_delayed_inputs WHERE conversation_id = ?",
        )
        .bind(caller.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "promoted");
    }

    #[tokio::test]
    async fn promote_failed_when_archived() {
        let pool = setup_pool().await;
        let caller = Uuid::new_v4();
        create_session(&pool, caller, Uuid::new_v4(), None).await;
        let mut request = send_for(caller, caller, CompanionWritePolicy::SameWorkspace);
        request.delay_seconds = Some(20);
        send_session_input(&pool, request).await.unwrap();
        sqlx::query("UPDATE sessions SET status = 'archived' WHERE id = ?")
            .bind(caller)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE conversation_delayed_inputs SET deliver_at = ? WHERE conversation_id = ?",
        )
        .bind(stamp(Utc::now() - Duration::seconds(1)))
        .bind(caller.to_string())
        .execute(&pool)
        .await
        .unwrap();
        promote_due_delayed_inputs(&pool).await.unwrap();
        assert_eq!(input_count(&pool, caller).await, 0);
        let status: String = sqlx::query_scalar(
            "SELECT status FROM conversation_delayed_inputs WHERE conversation_id = ?",
        )
        .bind(caller.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "failed");
    }

    #[tokio::test]
    async fn delayed_space_post_schedules_lists_and_promotes_message() {
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

        let delayed = post_to_space_delayed_with(
            &pool,
            PostToSpace {
                caller_id: Some(a),
                space_id: space.clone(),
                content: "@小B 稍后同步检查结果".to_string(),
                summary: None,
                to: vec!["小B".to_string()],
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
            Some(120),
            &DeliveryContext::default(),
        )
        .await
        .unwrap();

        assert_eq!(delayed.seq, 0);
        let listed = list_space_scheduled_messages(&pool, &space).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, delayed.message_id);
        assert_eq!(listed[0].caller_id, Some(a.to_string()));
        assert_eq!(listed[0].nickname, "小A");
        assert_eq!(listed[0].content, "@小B 稍后同步检查结果");

        // Move deliver_at into the past and promote
        sqlx::query("UPDATE conversation_delayed_inputs SET deliver_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
        .bind(&delayed.message_id)
        .execute(&pool)
        .await
        .unwrap();

        let promoted = promote_due_delayed_inputs(&pool).await.unwrap();
        assert_eq!(promoted, 1);

        let listed_after = list_space_scheduled_messages(&pool, &space).await.unwrap();
        assert!(listed_after.is_empty());

        let messages = list_space_messages(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        assert_eq!(messages.len(), 1);
        assert!(
            messages[0].envelope["content"]
                .as_str()
                .unwrap()
                .contains("稍后同步检查结果")
        );
    }

    #[tokio::test]
    async fn delayed_session_input_visible_in_sender_and_recipient_queues_and_convertible() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let sender = Uuid::new_v4();
        let recipient = Uuid::new_v4();
        create_session(&pool, sender, workspace, Some("发送者")).await;
        create_session(&pool, recipient, workspace, Some("接收者")).await;

        let op_id = Uuid::new_v4();
        let receipt = send_session_input(
            &pool,
            SendSessionInput {
                caller_id: sender,
                conversation_id: recipient,
                operation_id: op_id,
                text: "延时会话消息".to_string(),
                policy: CompanionWritePolicy::SameWorkspace,
                steer: false,
                steer_supported: true,
                expected_turn_id: None,
                delay_seconds: Some(300),
                deliver_at: None,
                delay_cap_hours: 24,
            },
        )
        .await
        .unwrap();
        assert_eq!(receipt.delivered, "scheduled");

        let control = crate::ConversationInputControl::new(pool.clone());
        let sender_inputs = control.list(sender).await.unwrap();
        assert_eq!(sender_inputs.len(), 1);
        assert_eq!(
            sender_inputs[0].status,
            crate::ConversationInputStatus::Scheduled
        );
        assert!(sender_inputs[0].deliver_at.is_some());
        assert_eq!(sender_inputs[0].payload.text, "延时会话消息");

        let recipient_inputs = control.list(recipient).await.unwrap();
        assert_eq!(recipient_inputs.len(), 1);
        assert_eq!(
            recipient_inputs[0].status,
            crate::ConversationInputStatus::Scheduled
        );
        assert!(recipient_inputs[0].deliver_at.is_some());
    }
}
