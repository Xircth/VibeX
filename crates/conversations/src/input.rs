use std::{collections::BTreeMap, sync::Arc};

pub use agents::conversation::ConversationInputEvent;
use agents::{ConversationEvent, ConversationInputPayload};
use chrono::{DateTime, Duration, Utc};
use db::models::{
    conversation_event::AppendConversationEvent, conversation_input::ConversationInputRecord,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

use crate::ConversationEventAppender;

const MAX_CONVERSATION_INPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum ConversationInputStatus {
    Queued,
    Scheduled,
    Claimed,
    Dispatched,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct ConversationInputView {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub operation_id: Uuid,
    pub revision: u64,
    pub sort_key: i64,
    pub status: ConversationInputStatus,
    pub payload: ConversationInputPayload,
    pub principal: serde_json::Value,
    pub claim_token: Option<Uuid>,
    pub claim_deadline: Option<DateTime<Utc>>,
    pub turn_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deliver_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct ConversationInputSubmission {
    pub input: ConversationInputView,
    pub turn: Option<crate::ConversationTurnSnapshot>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SubmitConversationInput {
    pub conversation_id: Uuid,
    pub operation_id: Uuid,
    pub payload: ConversationInputPayload,
    pub principal: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UpdateConversationInput {
    pub conversation_id: Uuid,
    pub input_id: Uuid,
    pub operation_id: Uuid,
    pub expected_revision: u64,
    pub payload: ConversationInputPayload,
    pub delay_seconds: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReorderConversationInput {
    pub conversation_id: Uuid,
    pub input_id: Uuid,
    pub operation_id: Uuid,
    pub expected_revision: u64,
    pub sort_key: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CancelConversationInput {
    pub conversation_id: Uuid,
    pub input_id: Uuid,
    pub operation_id: Uuid,
    pub expected_revision: u64,
}

#[derive(Debug, Error)]
pub enum ConversationInputControlError {
    #[error("conversation binding changed; refresh before submitting")]
    BindingRevisionConflict,
    #[error("this conversation's Agent is controlled by its workflow or bot")]
    ContinuationNotAllowed,
    #[error("conversation input operation {operation_id} was retried with a different payload")]
    OperationConflict { operation_id: Uuid },
    #[error("conversation input {0} was not found")]
    NotFound(Uuid),
    #[error("conversation input {input_id} changed or is no longer queued")]
    StateConflict { input_id: Uuid },
    #[error("conversation input revision overflow")]
    RevisionOverflow,
    #[error("prompt must include text or an image")]
    EmptyInput,
    #[error("conversation input exceeds {maximum} bytes (received {actual})")]
    InputTooLarge { actual: usize, maximum: usize },
    #[error("invalid conversation input projection status `{0}`")]
    InvalidStatus(String),
    #[error("conversation input serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[derive(Clone)]
pub struct ConversationInputControl {
    pool: SqlitePool,
    publisher: Option<Arc<dyn crate::ConversationEventPublisher>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConversationInputClaim {
    pub claim_token: Uuid,
    pub claim_deadline: DateTime<Utc>,
    pub input: ConversationInputView,
}

impl ConversationInputControl {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            publisher: None,
        }
    }

    pub fn with_publisher(
        pool: SqlitePool,
        publisher: Arc<dyn crate::ConversationEventPublisher>,
    ) -> Self {
        Self {
            pool,
            publisher: Some(publisher),
        }
    }

    pub async fn submit(
        &self,
        input: SubmitConversationInput,
    ) -> Result<ConversationInputView, ConversationInputControlError> {
        self.submit_with_placement(input, false).await
    }

    /// Persist a durable input at the front of the queue (`min_queued_sort_key - 1`)
    /// so `interrupt_restart` steering dispatches ahead of any existing queued items.
    pub async fn submit_at_front(
        &self,
        input: SubmitConversationInput,
    ) -> Result<ConversationInputView, ConversationInputControlError> {
        self.submit_with_placement(input, true).await
    }

    async fn submit_with_placement(
        &self,
        input: SubmitConversationInput,
        at_front: bool,
    ) -> Result<ConversationInputView, ConversationInputControlError> {
        let payload_json = validate_input_payload(&input.payload)?;
        let payload_digest = format!("{:x}", Sha256::digest(&payload_json));
        let principal = input.principal.clone();

        if let Some(existing) = ConversationInputRecord::find_by_operation(
            &self.pool,
            input.conversation_id,
            input.operation_id,
        )
        .await?
        {
            return same_operation(existing, input.operation_id, &payload_digest, &principal);
        }

        let input_id = Uuid::new_v4();
        let event_id = Uuid::new_v4();
        let idempotency_key = format!("conversation-input-operation:{}", input.operation_id);
        let mut conn = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
        let append = async {
            // Check at acceptance, never when an already accepted queue item dispatches.
            // Retries are resolved first, even if the binding has since advanced.
            let duplicate: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM conversation_inputs WHERE conversation_id = ? AND operation_id = ?)")
                .bind(input.conversation_id).bind(input.operation_id).fetch_one(&mut *conn).await?;
            if !duplicate {
                let (revision, current_agent): (i64, Option<String>) = sqlx::query_as("SELECT binding_revision, agent_id FROM sessions WHERE id = ?")
                    .bind(input.conversation_id).fetch_one(&mut *conn).await?;
                if input.payload.expected_binding_revision.is_some_and(|expected| expected != revision as u64) {
                    return Err(ConversationInputControlError::BindingRevisionConflict);
                }
                if current_agent.as_deref().is_some_and(|agent| agent != input.payload.agent_id.as_str()) || input.payload.continuation_policy == Some(agents::conversation::ContinuationPolicy::Fresh) {
                    let owned: bool = sqlx::query_scalar(
                        r#"SELECT EXISTS(
                               SELECT 1 FROM conversation_relations
                               WHERE child_conversation_id = ?
                                 AND kind IN ('workflow_step', 'delegation')
                           )
                           OR EXISTS(
                               SELECT 1 FROM collaboration_thread_members tm
                               LEFT JOIN collaboration_members m ON m.id = tm.member_id
                               WHERE tm.conversation_id = ?
                                 AND lower(replace(COALESCE(m.agent, ''), '-', '_')) != lower(replace(?, '-', '_'))
                           )"#,
                    )
                    .bind(input.conversation_id)
                    .bind(input.conversation_id.to_string())
                    .bind(input.payload.agent_id.as_str())
                    .fetch_one(&mut *conn)
                    .await?;
                    if owned { return Err(ConversationInputControlError::ContinuationNotAllowed); }
                }
            }
            let sort_key = if at_front {
                ConversationInputRecord::min_queued_sort_key_on_connection(
                    &mut conn,
                    input.conversation_id,
                )
                .await?
                .map(|min_key| min_key.saturating_sub(1))
                .unwrap_or(0)
            } else {
                ConversationInputRecord::next_sort_key_on_connection(
                    &mut conn,
                    input.conversation_id,
                )
                .await?
            };
            let event = ConversationEvent::ConversationInput {
                event: ConversationInputEvent::Submitted {
                    input_id,
                    operation_id: input.operation_id,
                    revision: 1,
                    sort_key,
                    payload_digest: payload_digest.clone(),
                    payload: input.payload,
                    principal: input.principal,
                },
            };
            let normalized_json = serde_json::to_string(&event)?;
            ConversationEventAppender::append_and_apply(
                &mut conn,
                AppendConversationEvent {
                    id: event_id,
                    conversation_id: input.conversation_id,
                    turn_id: None,
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source: "user",
                    event_kind: "conversation_input",
                    normalized_json: &normalized_json,
                    raw_json: None,
                    idempotency_key: Some(&idempotency_key),
                },
            )
            .await
            .map_err(ConversationInputControlError::from)
        }
        .await;
        let record = match append {
            Ok(record) => {
                if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                    return Err(error.into());
                }
                record
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(error);
            }
        };
        drop(conn);
        if record.id == event_id {
            self.publish(&record).await;
        }

        let persisted = ConversationInputRecord::find_by_operation(
            &self.pool,
            input.conversation_id,
            input.operation_id,
        )
        .await?
        .ok_or(ConversationInputControlError::NotFound(input_id))?;
        same_operation(persisted, input.operation_id, &payload_digest, &principal)
    }

    /// Atomically move a queued (or scheduled delayed) input to the absolute front
    /// of `conversation_inputs` (`min_queued_sort_key - 1`) before `cancel_turn` runs.
    pub async fn promote_to_front(
        &self,
        conversation_id: Uuid,
        input_id: Uuid,
        operation_id: Uuid,
        expected_revision: Option<u64>,
    ) -> Result<ConversationInputView, ConversationInputControlError> {
        if let Some(existing_promoted) =
            ConversationInputRecord::find_by_operation(&self.pool, conversation_id, operation_id)
                .await?
        {
            return ConversationInputView::try_from(existing_promoted);
        }
        if let Some(delayed) =
            find_delayed_input_view(&self.pool, conversation_id, input_id).await?
            && delayed.status == ConversationInputStatus::Scheduled
        {
            if let Some(expected) = expected_revision
                && delayed.revision != expected
            {
                return Err(ConversationInputControlError::StateConflict { input_id });
            }
            let _ =
                cancel_delayed_input_if_exists(&self.pool, conversation_id, input_id).await?;
            return self
                .submit_at_front(SubmitConversationInput {
                    conversation_id,
                    operation_id,
                    payload: delayed.payload,
                    principal: delayed.principal,
                })
                .await;
        }

        let idempotency_key = format!("conversation-input-operation:{operation_id}");
        let event_id = Uuid::new_v4();
        let mut conn = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
        let tx_result = async {
            let already_applied: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM conversation_events WHERE conversation_id = ? AND idempotency_key = ?)",
            )
            .bind(conversation_id)
            .bind(&idempotency_key)
            .fetch_one(&mut *conn)
            .await?;
            if already_applied {
                return Ok::<_, ConversationInputControlError>(None);
            }

            let existing = ConversationInputRecord::find_by_id_for_conversation_on_connection(
                &mut conn,
                conversation_id,
                input_id,
            )
            .await?
            .ok_or(ConversationInputControlError::NotFound(input_id))?;
            if existing.status != "queued" {
                return Err(ConversationInputControlError::StateConflict { input_id });
            }
            let current_rev = u64::try_from(existing.revision).map_err(|_| {
                ConversationInputControlError::InvalidStatus(format!(
                    "negative revision {}",
                    existing.revision
                ))
            })?;
            if let Some(expected) = expected_revision
                && current_rev != expected
            {
                return Err(ConversationInputControlError::StateConflict { input_id });
            }
            let revision = current_rev
                .checked_add(1)
                .ok_or(ConversationInputControlError::RevisionOverflow)?;
            let sort_key = ConversationInputRecord::min_queued_sort_key_on_connection(
                &mut conn,
                conversation_id,
            )
            .await?
            .map(|min_key| min_key.saturating_sub(1))
            .unwrap_or(0);
            let event = ConversationEvent::ConversationInput {
                event: ConversationInputEvent::Reordered {
                    input_id,
                    revision,
                    sort_key,
                },
            };
            let normalized_json = serde_json::to_string(&event)?;
            let record = ConversationEventAppender::append_and_apply(
                &mut conn,
                AppendConversationEvent {
                    id: event_id,
                    conversation_id,
                    turn_id: None,
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source: "user",
                    event_kind: "conversation_input",
                    normalized_json: &normalized_json,
                    raw_json: None,
                    idempotency_key: Some(&idempotency_key),
                },
            )
            .await
            .map_err(|error| match error {
                sqlx::Error::Protocol(_) => {
                    ConversationInputControlError::StateConflict { input_id }
                }
                other => ConversationInputControlError::from(other),
            })?;
            Ok(Some(record))
        }
        .await;

        let maybe_record = match tx_result {
            Ok(record) => {
                if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                    return Err(error.into());
                }
                record
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(error);
            }
        };
        drop(conn);
        if let Some(record) = maybe_record
            && record.id == event_id
        {
            self.publish(&record).await;
        }
        self.find(conversation_id, input_id).await
    }

    /// Idempotently consume (cancel) a queued/scheduled input after native in-flight
    /// steering succeeded so the queue pump does not re-send it when the turn finishes.
    pub async fn consume_for_native_steer(
        &self,
        conversation_id: Uuid,
        input_id: Uuid,
        operation_id: Uuid,
        expected_revision: Option<u64>,
    ) -> Result<Option<ConversationInputView>, ConversationInputControlError> {
        let current = match self.find(conversation_id, input_id).await {
            Ok(view) => view,
            Err(ConversationInputControlError::NotFound(_)) => return Ok(None),
            Err(error) => return Err(error),
        };
        if current.status == ConversationInputStatus::Cancelled {
            return Ok(Some(current));
        }
        let revision = expected_revision.unwrap_or(current.revision);
        match self
            .cancel(CancelConversationInput {
                conversation_id,
                input_id,
                operation_id,
                expected_revision: revision,
            })
            .await
        {
            Ok(cancelled) => Ok(Some(cancelled)),
            Err(ConversationInputControlError::StateConflict { .. }) => {
                let refreshed = self.find(conversation_id, input_id).await?;
                if refreshed.status == ConversationInputStatus::Cancelled {
                    Ok(Some(refreshed))
                } else {
                    Err(ConversationInputControlError::StateConflict { input_id })
                }
            }
            Err(error) => Err(error),
        }
    }

    pub async fn list(
        &self,
        conversation_id: Uuid,
    ) -> Result<Vec<ConversationInputView>, ConversationInputControlError> {
        let mut views = ConversationInputRecord::list_for_conversation(&self.pool, conversation_id)
            .await?
            .into_iter()
            .map(ConversationInputView::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        let delayed = list_delayed_input_views(&self.pool, conversation_id).await?;
        views.extend(delayed);
        Ok(views)
    }

    pub async fn update(
        &self,
        input: UpdateConversationInput,
    ) -> Result<ConversationInputView, ConversationInputControlError> {
        let payload_bytes = validate_input_payload(&input.payload)?;
        let payload_digest = format!("{:x}", Sha256::digest(&payload_bytes));
        let payload_json_str = serde_json::to_string(&input.payload)?;

        if let Some(updated_delayed) = update_delayed_input_if_exists(
            &self.pool,
            input.conversation_id,
            input.input_id,
            &payload_json_str,
            &payload_digest,
            input.delay_seconds,
        )
        .await?
        {
            return Ok(updated_delayed);
        }

        if let Some(delay_seconds) = input.delay_seconds.filter(|seconds| *seconds > 0) {
            let existing = ConversationInputRecord::find_by_id_for_conversation(
                &self.pool,
                input.conversation_id,
                input.input_id,
            )
            .await?
            .ok_or(ConversationInputControlError::NotFound(input.input_id))?;
            if existing.status != "queued" {
                return Err(ConversationInputControlError::StateConflict {
                    input_id: input.input_id,
                });
            }
            let deliver_at = Utc::now() + Duration::seconds(delay_seconds);
            let now = Utc::now();
            let delayed_id = input.input_id;
            let delayed_op_id = input.operation_id;
            let deliver_at_stamp = deliver_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let now_stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            sqlx::query(
                r#"INSERT INTO conversation_delayed_inputs
                   (id, conversation_id, operation_id, payload_json, payload_digest, principal_json,
                    deliver_at, status, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
                   ON CONFLICT(id) DO UPDATE SET
                     operation_id = excluded.operation_id,
                     payload_json = excluded.payload_json,
                     payload_digest = excluded.payload_digest,
                     principal_json = excluded.principal_json,
                     deliver_at = excluded.deliver_at,
                     status = 'scheduled'"#,
            )
            .bind(delayed_id.to_string())
            .bind(input.conversation_id.to_string())
            .bind(delayed_op_id.to_string())
            .bind(&payload_json_str)
            .bind(&payload_digest)
            .bind(&existing.principal_json)
            .bind(&deliver_at_stamp)
            .bind(&now_stamp)
            .execute(&self.pool)
            .await?;
            if let Err(error) = self
                .cancel(CancelConversationInput {
                    conversation_id: input.conversation_id,
                    input_id: input.input_id,
                    operation_id: input.operation_id,
                    expected_revision: input.expected_revision,
                })
                .await
            {
                let _ = sqlx::query("DELETE FROM conversation_delayed_inputs WHERE id = ?")
                    .bind(delayed_id.to_string())
                    .execute(&self.pool)
                    .await;
                return Err(error);
            }
            return Ok(ConversationInputView {
                id: delayed_id,
                conversation_id: input.conversation_id,
                operation_id: delayed_op_id,
                revision: 1,
                sort_key: deliver_at.timestamp_millis(),
                status: ConversationInputStatus::Scheduled,
                payload: input.payload,
                principal: serde_json::from_str(&existing.principal_json)
                    .unwrap_or_else(|_| serde_json::json!({})),
                claim_token: None,
                claim_deadline: None,
                turn_id: None,
                created_at: now,
                updated_at: now,
                deliver_at: Some(deliver_at),
            });
        }

        let revision = input
            .expected_revision
            .checked_add(1)
            .ok_or(ConversationInputControlError::RevisionOverflow)?;
        let event = ConversationEvent::ConversationInput {
            event: ConversationInputEvent::Updated {
                input_id: input.input_id,
                revision,
                payload_digest,
                payload: input.payload,
            },
        };
        self.append_mutation(
            input.conversation_id,
            input.input_id,
            input.operation_id,
            event,
        )
        .await
    }

    pub async fn reorder(
        &self,
        input: ReorderConversationInput,
    ) -> Result<ConversationInputView, ConversationInputControlError> {
        let revision = input
            .expected_revision
            .checked_add(1)
            .ok_or(ConversationInputControlError::RevisionOverflow)?;
        self.append_mutation(
            input.conversation_id,
            input.input_id,
            input.operation_id,
            ConversationEvent::ConversationInput {
                event: ConversationInputEvent::Reordered {
                    input_id: input.input_id,
                    revision,
                    sort_key: input.sort_key,
                },
            },
        )
        .await
    }

    pub async fn cancel(
        &self,
        input: CancelConversationInput,
    ) -> Result<ConversationInputView, ConversationInputControlError> {
        if let Some(cancelled_delayed) =
            cancel_delayed_input_if_exists(&self.pool, input.conversation_id, input.input_id)
                .await?
        {
            return Ok(cancelled_delayed);
        }
        let revision = input
            .expected_revision
            .checked_add(1)
            .ok_or(ConversationInputControlError::RevisionOverflow)?;
        self.append_mutation(
            input.conversation_id,
            input.input_id,
            input.operation_id,
            ConversationEvent::ConversationInput {
                event: ConversationInputEvent::Cancelled {
                    input_id: input.input_id,
                    revision,
                },
            },
        )
        .await
    }

    /// Cancel every still-queued input. Claimed/dispatched inputs are owned by
    /// the in-flight Turn path and must not be cancelled here.
    pub async fn cancel_queued(
        &self,
        conversation_id: Uuid,
    ) -> Result<usize, ConversationInputControlError> {
        let pending = self.list(conversation_id).await?;
        let mut cancelled = 0usize;
        for input in pending {
            if input.status != ConversationInputStatus::Queued {
                continue;
            }
            match self
                .cancel(CancelConversationInput {
                    conversation_id,
                    input_id: input.id,
                    operation_id: Uuid::new_v4(),
                    expected_revision: input.revision,
                })
                .await
            {
                Ok(_) => cancelled += 1,
                Err(ConversationInputControlError::StateConflict { .. }) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(cancelled)
    }

    async fn append_mutation(
        &self,
        conversation_id: Uuid,
        input_id: Uuid,
        operation_id: Uuid,
        event: ConversationEvent,
    ) -> Result<ConversationInputView, ConversationInputControlError> {
        let normalized_json = serde_json::to_string(&event)?;
        let idempotency_key = format!("conversation-input-operation:{operation_id}");
        let event_id = Uuid::new_v4();
        let record = match ConversationEventAppender::append(
            &self.pool,
            AppendConversationEvent {
                id: event_id,
                conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "user",
                event_kind: "conversation_input",
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: Some(&idempotency_key),
            },
        )
        .await
        {
            Ok(record) => record,
            Err(sqlx::Error::Protocol(_)) => {
                return Err(ConversationInputControlError::StateConflict { input_id });
            }
            Err(error) => return Err(error.into()),
        };
        if record.normalized_json != normalized_json {
            return Err(ConversationInputControlError::OperationConflict { operation_id });
        }
        if record.id == event_id {
            self.publish(&record).await;
        }
        self.find(conversation_id, input_id).await
    }

    pub async fn find(
        &self,
        conversation_id: Uuid,
        input_id: Uuid,
    ) -> Result<ConversationInputView, ConversationInputControlError> {
        if let Some(record) = ConversationInputRecord::find_by_id_for_conversation(
            &self.pool,
            conversation_id,
            input_id,
        )
        .await?
        {
            if record.status == "cancelled"
                && let Some(delayed) =
                    find_delayed_input_view(&self.pool, conversation_id, input_id).await?
            {
                return Ok(delayed);
            }
            return record.try_into();
        }
        if let Some(delayed) =
            find_delayed_input_view(&self.pool, conversation_id, input_id).await?
        {
            return Ok(delayed);
        }
        Err(ConversationInputControlError::NotFound(input_id))
    }

    pub async fn claim_next(
        &self,
        conversation_id: Uuid,
        lease_duration: Duration,
    ) -> Result<Option<ConversationInputClaim>, ConversationInputControlError> {
        if lease_duration <= Duration::zero() {
            return Err(ConversationInputControlError::StateConflict {
                input_id: Uuid::nil(),
            });
        }
        let mut conn = self.pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
        let result = async {
            let Some(input_id) =
                ConversationInputRecord::first_queued_id_on_connection(&mut conn, conversation_id)
                    .await?
            else {
                return Ok::<_, ConversationInputControlError>(None);
            };
            let claim_token = Uuid::new_v4();
            let claim_deadline = Utc::now() + lease_duration;
            let event = ConversationEvent::ConversationInput {
                event: ConversationInputEvent::Claimed {
                    input_id,
                    claim_token,
                    claim_deadline,
                },
            };
            let normalized_json = serde_json::to_string(&event)?;
            let idempotency_key = format!("conversation-input-claim:{claim_token}");
            let record = ConversationEventAppender::append_and_apply(
                &mut conn,
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id,
                    turn_id: None,
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source: "system",
                    event_kind: "conversation_input",
                    normalized_json: &normalized_json,
                    raw_json: None,
                    idempotency_key: Some(&idempotency_key),
                },
            )
            .await?;
            Ok(Some((input_id, claim_token, claim_deadline, record)))
        }
        .await;

        let claimed = match result {
            Ok(claimed) => {
                if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                    return Err(error.into());
                }
                claimed
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(error);
            }
        };
        drop(conn);

        let Some((input_id, claim_token, claim_deadline, record)) = claimed else {
            return Ok(None);
        };
        self.publish(&record).await;
        Ok(Some(ConversationInputClaim {
            claim_token,
            claim_deadline,
            input: self.find(conversation_id, input_id).await?,
        }))
    }

    pub async fn release_claim(
        &self,
        conversation_id: Uuid,
        input_id: Uuid,
        claim_token: Uuid,
    ) -> Result<ConversationInputView, ConversationInputControlError> {
        self.append_mutation(
            conversation_id,
            input_id,
            claim_token,
            ConversationEvent::ConversationInput {
                event: ConversationInputEvent::ClaimReleased {
                    input_id,
                    claim_token,
                },
            },
        )
        .await
    }

    pub async fn recover_stale_claims(
        &self,
        now: DateTime<Utc>,
    ) -> Result<usize, ConversationInputControlError> {
        self.release_unsubmitted_claims(
            ConversationInputRecord::list_stale_unsubmitted_claims(&self.pool, now).await?,
        )
        .await
    }

    /// Release every claimed input that never produced a Turn. Call this only
    /// when no dispatcher from this process can still be holding those claims
    /// (host startup / crash recovery).
    pub async fn recover_orphaned_unsubmitted_claims(
        &self,
    ) -> Result<usize, ConversationInputControlError> {
        self.release_unsubmitted_claims(
            ConversationInputRecord::list_unsubmitted_claims(&self.pool).await?,
        )
        .await
    }

    async fn release_unsubmitted_claims(
        &self,
        claims: Vec<ConversationInputRecord>,
    ) -> Result<usize, ConversationInputControlError> {
        let mut released = 0;
        for input in claims {
            let Some(claim_token) = input.claim_token else {
                continue;
            };
            match self
                .release_claim(input.conversation_id, input.id, claim_token)
                .await
            {
                Ok(_) => released += 1,
                Err(ConversationInputControlError::StateConflict { .. }) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(released)
    }

    async fn publish(&self, record: &db::models::conversation_event::ConversationEventRecord) {
        if let Some(publisher) = &self.publisher {
            publisher.publish(record).await;
        }
    }
}

fn validate_input_payload(
    payload: &ConversationInputPayload,
) -> Result<Vec<u8>, ConversationInputControlError> {
    if payload.text.trim().is_empty() && payload.images.is_empty() {
        return Err(ConversationInputControlError::EmptyInput);
    }
    let bytes = serde_json::to_vec(payload)?;
    if bytes.len() > MAX_CONVERSATION_INPUT_BYTES {
        return Err(ConversationInputControlError::InputTooLarge {
            actual: bytes.len(),
            maximum: MAX_CONVERSATION_INPUT_BYTES,
        });
    }
    Ok(bytes)
}

fn same_operation(
    record: ConversationInputRecord,
    operation_id: Uuid,
    payload_digest: &str,
    principal: &serde_json::Value,
) -> Result<ConversationInputView, ConversationInputControlError> {
    let persisted_principal = serde_json::from_str::<serde_json::Value>(&record.principal_json)?;
    if record.payload_digest != payload_digest || persisted_principal != *principal {
        return Err(ConversationInputControlError::OperationConflict { operation_id });
    }
    ConversationInputView::try_from(record)
}

impl TryFrom<ConversationInputRecord> for ConversationInputView {
    type Error = ConversationInputControlError;

    fn try_from(record: ConversationInputRecord) -> Result<Self, Self::Error> {
        let status = match record.status.as_str() {
            "queued" => ConversationInputStatus::Queued,
            "claimed" => ConversationInputStatus::Claimed,
            "dispatched" => ConversationInputStatus::Dispatched,
            "cancelled" => ConversationInputStatus::Cancelled,
            status => {
                return Err(ConversationInputControlError::InvalidStatus(
                    status.to_string(),
                ));
            }
        };
        Ok(Self {
            id: record.id,
            conversation_id: record.conversation_id,
            operation_id: record.operation_id,
            revision: u64::try_from(record.revision).map_err(|_| {
                ConversationInputControlError::InvalidStatus(format!(
                    "negative revision {}",
                    record.revision
                ))
            })?,
            sort_key: record.sort_key,
            status,
            payload: serde_json::from_str(&record.payload_json)?,
            principal: serde_json::from_str(&record.principal_json)?,
            claim_token: record.claim_token,
            claim_deadline: record.claim_deadline,
            turn_id: record.turn_id,
            created_at: record.created_at,
            updated_at: record.updated_at,
            deliver_at: None,
        })
    }
}

#[derive(Debug, sqlx::FromRow)]
struct DelayedInputRow {
    id: String,
    conversation_id: String,
    operation_id: String,
    payload_json: String,
    principal_json: String,
    deliver_at: String,
    created_at: String,
}

fn parse_delayed_payload(
    raw: &str,
) -> Result<ConversationInputPayload, ConversationInputControlError> {
    if let Ok(full) = serde_json::from_str::<ConversationInputPayload>(raw) {
        return Ok(full);
    }
    let val: serde_json::Value = serde_json::from_str(raw)?;
    let text = val
        .get("text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let display_text = val
        .get("display_text")
        .or_else(|| val.get("displayText"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let agent_raw = val
        .get("agent_id")
        .or_else(|| val.get("agentId"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("codex");
    let agent_id = agents::AgentId::parse(agent_raw)
        .unwrap_or_else(|_| agents::AgentId::parse("codex").expect("fallback agent_id"));
    let workspace_id = val
        .get("workspace_id")
        .or_else(|| val.get("workspaceId"))
        .and_then(serde_json::Value::as_str)
        .and_then(|v| Uuid::parse_str(v).ok())
        .unwrap_or_else(Uuid::nil);
    Ok(ConversationInputPayload {
        continuation_policy: None,
        expected_binding_revision: None,
        agent_id,
        workspace_id,
        executor_profile_id: None,
        text,
        display_text,
        images: Vec::new(),
        mode_override: None,
        config_overrides: Vec::new(),
        workflow_refs: Vec::new(),
        file_refs: Vec::new(),
        internal_prompt_contributions: Vec::new(),
        collaboration_origin: None,
    })
}

fn delayed_row_to_view(
    row: DelayedInputRow,
    requested_conversation_id: Uuid,
    status: ConversationInputStatus,
) -> Option<ConversationInputView> {
    let id = Uuid::parse_str(&row.id).ok()?;
    let operation_id = Uuid::parse_str(&row.operation_id).unwrap_or_else(|_| Uuid::new_v4());
    let payload = parse_delayed_payload(&row.payload_json).ok()?;
    let principal =
        serde_json::from_str(&row.principal_json).unwrap_or_else(|_| serde_json::json!({}));
    let deliver_at = DateTime::parse_from_rfc3339(&row.deliver_at)
        .map(|dt| dt.with_timezone(&Utc))
        .ok()?;
    let created_at = DateTime::parse_from_rfc3339(&row.created_at)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or(deliver_at);
    let _target_conversation_id = Uuid::parse_str(&row.conversation_id).ok();
    Some(ConversationInputView {
        id,
        conversation_id: requested_conversation_id,
        operation_id,
        revision: 1,
        sort_key: deliver_at.timestamp_millis(),
        status,
        payload,
        principal,
        claim_token: None,
        claim_deadline: None,
        turn_id: None,
        created_at,
        updated_at: created_at,
        deliver_at: Some(deliver_at),
    })
}

async fn list_delayed_input_views(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Vec<ConversationInputView>, ConversationInputControlError> {
    let conv_str = conversation_id.to_string();
    let rows = sqlx::query_as::<_, DelayedInputRow>(
        r#"SELECT id, conversation_id, operation_id, payload_json, principal_json, deliver_at, created_at
           FROM conversation_delayed_inputs
           WHERE status = 'scheduled'
             AND COALESCE(json_extract(principal_json, '$.kind'), '') != 'collaboration_space_post'
             AND (conversation_id = ? OR json_extract(principal_json, '$.parentConversationId') = ?)
           ORDER BY deliver_at ASC, created_at ASC"#,
    )
    .bind(&conv_str)
    .bind(&conv_str)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            delayed_row_to_view(row, conversation_id, ConversationInputStatus::Scheduled)
        })
        .collect())
}

async fn find_delayed_input_view(
    pool: &SqlitePool,
    conversation_id: Uuid,
    input_id: Uuid,
) -> Result<Option<ConversationInputView>, ConversationInputControlError> {
    let conv_str = conversation_id.to_string();
    let row = sqlx::query_as::<_, (String, String, String, String, String, String, String, String)>(
        r#"SELECT id, conversation_id, operation_id, payload_json, principal_json, deliver_at, created_at, status
           FROM conversation_delayed_inputs
           WHERE id = ?
             AND COALESCE(json_extract(principal_json, '$.kind'), '') != 'collaboration_space_post'
             AND (conversation_id = ? OR json_extract(principal_json, '$.parentConversationId') = ?)
           LIMIT 1"#,
    )
    .bind(input_id.to_string())
    .bind(&conv_str)
    .bind(&conv_str)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(
        |(
            id,
            row_conv_id,
            operation_id,
            payload_json,
            principal_json,
            deliver_at,
            created_at,
            status,
        )| {
            let mapped_status = match status.as_str() {
                "scheduled" => ConversationInputStatus::Scheduled,
                "cancelled" => ConversationInputStatus::Cancelled,
                "dispatched" => ConversationInputStatus::Dispatched,
                _ => ConversationInputStatus::Scheduled,
            };
            delayed_row_to_view(
                DelayedInputRow {
                    id,
                    conversation_id: row_conv_id,
                    operation_id,
                    payload_json,
                    principal_json,
                    deliver_at,
                    created_at,
                },
                conversation_id,
                mapped_status,
            )
        },
    ))
}

async fn update_delayed_input_if_exists(
    pool: &SqlitePool,
    conversation_id: Uuid,
    input_id: Uuid,
    payload_json: &str,
    payload_digest: &str,
    delay_seconds: Option<i64>,
) -> Result<Option<ConversationInputView>, ConversationInputControlError> {
    let conv_str = conversation_id.to_string();
    let existing = sqlx::query_as::<_, DelayedInputRow>(
        r#"SELECT id, conversation_id, operation_id, payload_json, principal_json, deliver_at, created_at
           FROM conversation_delayed_inputs
           WHERE id = ? AND status = 'scheduled'
             AND COALESCE(json_extract(principal_json, '$.kind'), '') != 'collaboration_space_post'
             AND (conversation_id = ? OR json_extract(principal_json, '$.parentConversationId') = ?)
           LIMIT 1"#,
    )
    .bind(input_id.to_string())
    .bind(&conv_str)
    .bind(&conv_str)
    .fetch_optional(pool)
    .await?;
    let Some(mut row) = existing else {
        return Ok(None);
    };
    let next_deliver_at = match delay_seconds.filter(|seconds| *seconds > 0) {
        Some(seconds) => (Utc::now() + Duration::seconds(seconds))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        None => row.deliver_at.clone(),
    };
    sqlx::query(
        r#"UPDATE conversation_delayed_inputs
           SET payload_json = ?, payload_digest = ?, deliver_at = ?
           WHERE id = ? AND status = 'scheduled'"#,
    )
    .bind(payload_json)
    .bind(payload_digest)
    .bind(&next_deliver_at)
    .bind(&row.id)
    .execute(pool)
    .await?;
    row.payload_json = payload_json.to_string();
    row.deliver_at = next_deliver_at;
    Ok(delayed_row_to_view(
        row,
        conversation_id,
        ConversationInputStatus::Scheduled,
    ))
}

async fn cancel_delayed_input_if_exists(
    pool: &SqlitePool,
    conversation_id: Uuid,
    input_id: Uuid,
) -> Result<Option<ConversationInputView>, ConversationInputControlError> {
    let conv_str = conversation_id.to_string();
    let existing = sqlx::query_as::<_, DelayedInputRow>(
        r#"SELECT id, conversation_id, operation_id, payload_json, principal_json, deliver_at, created_at
           FROM conversation_delayed_inputs
           WHERE id = ? AND status = 'scheduled'
             AND COALESCE(json_extract(principal_json, '$.kind'), '') != 'collaboration_space_post'
             AND (conversation_id = ? OR json_extract(principal_json, '$.parentConversationId') = ?)
           LIMIT 1"#,
    )
    .bind(input_id.to_string())
    .bind(&conv_str)
    .bind(&conv_str)
    .fetch_optional(pool)
    .await?;
    let Some(row) = existing else {
        return Ok(None);
    };
    sqlx::query(
        r#"UPDATE conversation_delayed_inputs
           SET status = 'cancelled'
           WHERE id = ? AND status = 'scheduled'"#,
    )
    .bind(&row.id)
    .execute(pool)
    .await?;
    Ok(delayed_row_to_view(
        row,
        conversation_id,
        ConversationInputStatus::Cancelled,
    ))
}

fn event_input_id(event: &ConversationInputEvent) -> Uuid {
    match event {
        ConversationInputEvent::Submitted { input_id, .. }
        | ConversationInputEvent::Updated { input_id, .. }
        | ConversationInputEvent::Reordered { input_id, .. }
        | ConversationInputEvent::Claimed { input_id, .. }
        | ConversationInputEvent::ClaimReleased { input_id, .. }
        | ConversationInputEvent::Dispatched { input_id, .. }
        | ConversationInputEvent::Cancelled { input_id, .. } => *input_id,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationInputState {
    pub input_id: Uuid,
    pub operation_id: Uuid,
    pub revision: u64,
    pub sort_key: i64,
    pub payload_digest: String,
    pub status: ConversationInputStatus,
    pub claim_token: Option<Uuid>,
    pub claim_deadline: Option<DateTime<Utc>>,
    pub turn_id: Option<Uuid>,
}

#[derive(Debug, Default)]
pub struct ConversationInputQueue {
    inputs: BTreeMap<Uuid, ConversationInputState>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConversationInputTransitionError {
    #[error("input {0} has already been submitted")]
    AlreadySubmitted(Uuid),
    #[error("input {0} was not submitted")]
    NotFound(Uuid),
    #[error("input {input_id} must be queued for {operation}; current status is {status:?}")]
    NotQueued {
        input_id: Uuid,
        operation: &'static str,
        status: ConversationInputStatus,
    },
    #[error("input {input_id} expected revision {expected}, received {actual}")]
    RevisionConflict {
        input_id: Uuid,
        expected: u64,
        actual: u64,
    },
    #[error("input {input_id} claim token does not match the active claim")]
    ClaimTokenMismatch { input_id: Uuid },
}

impl ConversationInputQueue {
    pub fn rebuild(
        events: impl IntoIterator<Item = ConversationInputEvent>,
    ) -> Result<Self, ConversationInputTransitionError> {
        let mut queue = Self::default();
        for event in events {
            queue.apply(event)?;
        }
        Ok(queue)
    }

    pub fn apply(
        &mut self,
        event: ConversationInputEvent,
    ) -> Result<(), ConversationInputTransitionError> {
        let input_id = event_input_id(&event);
        if let ConversationInputEvent::Submitted {
            operation_id,
            revision,
            sort_key,
            payload_digest,
            ..
        } = event
        {
            if self.inputs.contains_key(&input_id) {
                return Err(ConversationInputTransitionError::AlreadySubmitted(input_id));
            }
            if revision != 1 {
                return Err(ConversationInputTransitionError::RevisionConflict {
                    input_id,
                    expected: 1,
                    actual: revision,
                });
            }
            self.inputs.insert(
                input_id,
                ConversationInputState {
                    input_id,
                    operation_id,
                    revision,
                    sort_key,
                    payload_digest,
                    status: ConversationInputStatus::Queued,
                    claim_token: None,
                    claim_deadline: None,
                    turn_id: None,
                },
            );
            return Ok(());
        }

        let state = self
            .inputs
            .get_mut(&input_id)
            .ok_or(ConversationInputTransitionError::NotFound(input_id))?;
        match event {
            ConversationInputEvent::Submitted { .. } => unreachable!(),
            ConversationInputEvent::Updated {
                revision,
                payload_digest,
                ..
            } => {
                ensure_queued(state, "update")?;
                ensure_next_revision(state, revision)?;
                state.revision = revision;
                state.payload_digest = payload_digest;
            }
            ConversationInputEvent::Reordered {
                revision, sort_key, ..
            } => {
                ensure_queued(state, "reorder")?;
                ensure_next_revision(state, revision)?;
                state.revision = revision;
                state.sort_key = sort_key;
            }
            ConversationInputEvent::Claimed {
                claim_token,
                claim_deadline,
                ..
            } => {
                ensure_queued(state, "claim")?;
                state.status = ConversationInputStatus::Claimed;
                state.claim_token = Some(claim_token);
                state.claim_deadline = Some(claim_deadline);
            }
            ConversationInputEvent::ClaimReleased { claim_token, .. } => {
                ensure_claim_token(state, claim_token)?;
                state.status = ConversationInputStatus::Queued;
                state.claim_token = None;
                state.claim_deadline = None;
            }
            ConversationInputEvent::Dispatched {
                claim_token,
                turn_id,
                ..
            } => {
                ensure_claim_token(state, claim_token)?;
                state.status = ConversationInputStatus::Dispatched;
                state.turn_id = Some(turn_id);
                state.claim_deadline = None;
            }
            ConversationInputEvent::Cancelled { revision, .. } => {
                ensure_queued(state, "cancel")?;
                ensure_next_revision(state, revision)?;
                state.revision = revision;
                state.status = ConversationInputStatus::Cancelled;
            }
        }
        Ok(())
    }

    pub fn get(&self, input_id: Uuid) -> Option<&ConversationInputState> {
        self.inputs.get(&input_id)
    }

    pub fn queued_ids(&self) -> Vec<Uuid> {
        let mut queued = self
            .inputs
            .values()
            .filter(|input| input.status == ConversationInputStatus::Queued)
            .collect::<Vec<_>>();
        queued.sort_by_key(|input| (input.sort_key, input.input_id));
        queued.into_iter().map(|input| input.input_id).collect()
    }
}

fn ensure_queued(
    state: &ConversationInputState,
    operation: &'static str,
) -> Result<(), ConversationInputTransitionError> {
    if state.status != ConversationInputStatus::Queued {
        return Err(ConversationInputTransitionError::NotQueued {
            input_id: state.input_id,
            operation,
            status: state.status,
        });
    }
    Ok(())
}

fn ensure_next_revision(
    state: &ConversationInputState,
    revision: u64,
) -> Result<(), ConversationInputTransitionError> {
    let expected = state.revision + 1;
    if revision != expected {
        return Err(ConversationInputTransitionError::RevisionConflict {
            input_id: state.input_id,
            expected,
            actual: revision,
        });
    }
    Ok(())
}

fn ensure_claim_token(
    state: &ConversationInputState,
    claim_token: Uuid,
) -> Result<(), ConversationInputTransitionError> {
    if state.status != ConversationInputStatus::Claimed || state.claim_token != Some(claim_token) {
        return Err(ConversationInputTransitionError::ClaimTokenMismatch {
            input_id: state.input_id,
        });
    }
    Ok(())
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod tests;
