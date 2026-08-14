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
            let sort_key = ConversationInputRecord::next_sort_key_on_connection(
                &mut conn,
                input.conversation_id,
            )
            .await?;
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

    pub async fn list(
        &self,
        conversation_id: Uuid,
    ) -> Result<Vec<ConversationInputView>, ConversationInputControlError> {
        ConversationInputRecord::list_for_conversation(&self.pool, conversation_id)
            .await?
            .into_iter()
            .map(ConversationInputView::try_from)
            .collect()
    }

    pub async fn update(
        &self,
        input: UpdateConversationInput,
    ) -> Result<ConversationInputView, ConversationInputControlError> {
        let payload_json = validate_input_payload(&input.payload)?;
        let revision = input
            .expected_revision
            .checked_add(1)
            .ok_or(ConversationInputControlError::RevisionOverflow)?;
        let event = ConversationEvent::ConversationInput {
            event: ConversationInputEvent::Updated {
                input_id: input.input_id,
                revision,
                payload_digest: format!("{:x}", Sha256::digest(&payload_json)),
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
        ConversationInputRecord::find_by_id_for_conversation(&self.pool, conversation_id, input_id)
            .await?
            .ok_or(ConversationInputControlError::NotFound(input_id))?
            .try_into()
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
        let stale = ConversationInputRecord::list_stale_unsubmitted_claims(&self.pool, now).await?;
        let mut released = 0;
        for input in stale {
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
        })
    }
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
mod tests {
    use std::{str::FromStr, time::Duration as StdDuration};

    use agents::{AgentId, ConversationInputPayload};
    use chrono::{Duration, Utc};
    use db::models::{
        conversation::{ConversationRecord, CreateConversationRecord},
        conversation_event::AppendConversationEvent,
        conversation_input::ConversationInputRecord,
        conversation_steering::ConversationSteeringRecord,
    };
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use tempfile::TempDir;
    use uuid::Uuid;

    use super::{
        CancelConversationInput, ConversationInputControl, ConversationInputControlError,
        ConversationInputEvent, ConversationInputQueue, ConversationInputStatus,
        MAX_CONVERSATION_INPUT_BYTES, ReorderConversationInput, SubmitConversationInput,
        UpdateConversationInput,
    };
    use crate::{ConversationEventAppender, ConversationProjector};

    fn submitted(input_id: Uuid, sort_key: i64) -> ConversationInputEvent {
        ConversationInputEvent::Submitted {
            input_id,
            operation_id: Uuid::new_v4(),
            revision: 1,
            sort_key,
            payload_digest: format!("digest-{input_id}"),
            payload: payload("hello"),
            principal: serde_json::json!({ "kind": "test" }),
        }
    }

    fn payload(text: &str) -> ConversationInputPayload {
        ConversationInputPayload {
            agent_id: AgentId::parse("codex").expect("agent id"),
            workspace_id: Uuid::new_v4(),
            executor_profile_id: None,
            text: text.to_string(),
            display_text: None,
            images: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            plugin_actions: Vec::new(),
        }
    }

    async fn setup_pool() -> sqlx::SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys for focused projection test");
        pool
    }

    async fn setup_multi_connection_pool() -> (TempDir, sqlx::SqlitePool) {
        let temporary = TempDir::new().expect("temporary sqlite directory");
        let database_path = temporary.path().join("conversation-claims.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&database_path)
            .create_if_missing(true)
            .foreign_keys(false)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(StdDuration::from_secs(5));
        let migration_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone())
            .await
            .expect("connect migration db");
        sqlx::migrate!("../db/migrations")
            .run(&migration_pool)
            .await
            .expect("run migrations");
        migration_pool.close().await;
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("PRAGMA foreign_keys = OFF")
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .expect("connect multi-connection db");
        (temporary, pool)
    }

    #[test]
    fn rebuilds_multiple_inputs_in_stable_queue_order() {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let queue = ConversationInputQueue::rebuild([
            submitted(second, 20),
            submitted(first, 10),
            ConversationInputEvent::Reordered {
                input_id: second,
                revision: 2,
                sort_key: 5,
            },
        ])
        .expect("valid event history");

        assert_eq!(queue.queued_ids(), vec![second, first]);
    }

    #[test]
    fn claimed_input_cannot_be_edited() {
        let input_id = Uuid::new_v4();
        let claim_token = Uuid::new_v4();
        let mut queue =
            ConversationInputQueue::rebuild([submitted(input_id, 10)]).expect("submitted input");
        queue
            .apply(ConversationInputEvent::Claimed {
                input_id,
                claim_token,
                claim_deadline: Utc::now() + Duration::seconds(30),
            })
            .expect("claim queued input");

        let error = queue
            .apply(ConversationInputEvent::Updated {
                input_id,
                revision: 2,
                payload_digest: "changed".to_string(),
                payload: payload("changed"),
            })
            .expect_err("claimed inputs are immutable");

        assert_eq!(
            queue.get(input_id).unwrap().status,
            ConversationInputStatus::Claimed
        );
        assert!(error.to_string().contains("queued"));
    }

    #[test]
    fn dispatch_requires_the_active_claim_token() {
        let input_id = Uuid::new_v4();
        let claim_token = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let mut queue = ConversationInputQueue::rebuild([
            submitted(input_id, 10),
            ConversationInputEvent::Claimed {
                input_id,
                claim_token,
                claim_deadline: Utc::now() + Duration::seconds(30),
            },
        ])
        .expect("claimed input");

        let error = queue
            .apply(ConversationInputEvent::Dispatched {
                input_id,
                claim_token: Uuid::new_v4(),
                turn_id,
            })
            .expect_err("a competing dispatcher cannot consume the claim");

        assert!(error.to_string().contains("claim token"));
        assert_eq!(
            queue.get(input_id).unwrap().status,
            ConversationInputStatus::Claimed
        );
    }

    #[test]
    fn mutations_require_the_next_revision() {
        let input_id = Uuid::new_v4();
        let mut queue =
            ConversationInputQueue::rebuild([submitted(input_id, 10)]).expect("submitted input");

        let error = queue
            .apply(ConversationInputEvent::Cancelled {
                input_id,
                revision: 3,
            })
            .expect_err("revision gaps are conflicts");

        assert!(error.to_string().contains("revision 2"));
        assert_eq!(
            queue.get(input_id).unwrap().status,
            ConversationInputStatus::Queued
        );
    }

    #[tokio::test]
    async fn event_append_and_rebuild_are_the_input_projection_authority() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");
        let input_id = Uuid::new_v4();
        let event = agents::ConversationEvent::ConversationInput {
            event: ConversationInputEvent::Submitted {
                input_id,
                operation_id: Uuid::new_v4(),
                revision: 1,
                sort_key: 1024,
                payload_digest: "digest".to_string(),
                payload: payload("persist me"),
                principal: serde_json::json!({ "kind": "test" }),
            },
        };
        let normalized = serde_json::to_string(&event).expect("serialize input event");
        ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "user",
                event_kind: "conversation_input",
                normalized_json: &normalized,
                raw_json: None,
                idempotency_key: Some(&format!("input:{input_id}:submitted")),
            },
        )
        .await
        .expect("append input event");

        let projected = ConversationInputRecord::find_by_id(&pool, input_id)
            .await
            .expect("read input projection")
            .expect("input projected from event");
        assert_eq!(projected.status, "queued");

        sqlx::query("DELETE FROM conversation_inputs WHERE conversation_id = ?")
            .bind(conversation_id)
            .execute(&pool)
            .await
            .expect("simulate lost projection");
        ConversationProjector::rebuild_projection(&pool, conversation_id)
            .await
            .expect("rebuild projection");
        assert!(
            ConversationInputRecord::find_by_id(&pool, input_id)
                .await
                .expect("read rebuilt input")
                .is_some()
        );
    }

    #[tokio::test]
    async fn steering_receipt_rebuilds_from_requested_and_terminal_events() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        let expected_turn_id = Uuid::new_v4();
        let steering_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");

        for (event, key) in [
            (
                agents::ConversationEvent::ConversationSteering {
                    event: agents::ConversationSteeringEvent::Requested {
                        steering_id,
                        operation_id: Uuid::new_v4(),
                        expected_turn_id,
                        payload_digest: "digest".to_string(),
                        blocks: vec![agents::ConversationInputBlock::Text {
                            text: "focus the failing test".to_string(),
                        }],
                        principal: serde_json::json!({ "kind": "test" }),
                    },
                },
                "requested",
            ),
            (
                agents::ConversationEvent::ConversationSteering {
                    event: agents::ConversationSteeringEvent::Accepted {
                        steering_id,
                        expected_turn_id,
                    },
                },
                "accepted",
            ),
        ] {
            let normalized = serde_json::to_string(&event).expect("serialize steering event");
            ConversationEventAppender::append(
                &pool,
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id,
                    turn_id: Some(expected_turn_id),
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source: "user",
                    event_kind: "conversation_steering",
                    normalized_json: &normalized,
                    raw_json: None,
                    idempotency_key: Some(&format!("steering:{steering_id}:{key}")),
                },
            )
            .await
            .expect("append steering event");
        }

        assert_eq!(
            ConversationSteeringRecord::find_by_id(&pool, conversation_id, steering_id)
                .await
                .expect("read receipt")
                .expect("projected receipt")
                .status,
            "accepted"
        );
        sqlx::query("DELETE FROM conversation_steering WHERE conversation_id = ?")
            .bind(conversation_id)
            .execute(&pool)
            .await
            .expect("drop projection");
        ConversationProjector::rebuild_projection(&pool, conversation_id)
            .await
            .expect("rebuild projection");
        assert_eq!(
            ConversationSteeringRecord::find_by_id(&pool, conversation_id, steering_id)
                .await
                .expect("read rebuilt receipt")
                .expect("rebuilt receipt")
                .status,
            "accepted"
        );
    }

    #[tokio::test]
    async fn submit_is_idempotent_and_rejects_operation_payload_conflicts() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");
        let operation_id = Uuid::new_v4();
        let control = ConversationInputControl::new(pool.clone());
        let original_payload = payload("hello");

        let first = control
            .submit(SubmitConversationInput {
                conversation_id,
                operation_id,
                payload: original_payload.clone(),
                principal: serde_json::json!({ "kind": "test" }),
            })
            .await
            .expect("first submit");
        let retry = control
            .submit(SubmitConversationInput {
                conversation_id,
                operation_id,
                payload: original_payload.clone(),
                principal: serde_json::json!({ "kind": "test" }),
            })
            .await
            .expect("idempotent retry");
        assert_eq!(retry.id, first.id);

        let principal_conflict = control
            .submit(SubmitConversationInput {
                conversation_id,
                operation_id,
                payload: original_payload.clone(),
                principal: serde_json::json!({ "kind": "different-user" }),
            })
            .await
            .expect_err("an operation id cannot be replayed by another principal");
        assert!(matches!(
            principal_conflict,
            ConversationInputControlError::OperationConflict { .. }
        ));

        let mut conflicting_payload = original_payload;
        conflicting_payload.text = "different".to_string();
        let conflict = control
            .submit(SubmitConversationInput {
                conversation_id,
                operation_id,
                payload: conflicting_payload,
                principal: serde_json::json!({ "kind": "test" }),
            })
            .await
            .expect_err("same operation cannot change payload");
        assert!(matches!(
            conflict,
            ConversationInputControlError::OperationConflict { .. }
        ));
        assert_eq!(
            control
                .list(conversation_id)
                .await
                .expect("list inputs")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn oversized_input_is_rejected_before_it_reaches_the_event_log() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");
        let control = ConversationInputControl::new(pool.clone());
        let error = control
            .submit(SubmitConversationInput {
                conversation_id,
                operation_id: Uuid::new_v4(),
                payload: payload(&"x".repeat(MAX_CONVERSATION_INPUT_BYTES)),
                principal: serde_json::json!({ "kind": "test" }),
            })
            .await
            .expect_err("oversized input must fail closed");
        assert!(matches!(
            error,
            ConversationInputControlError::InputTooLarge { .. }
        ));
        let events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(&pool)
        .await
        .expect("count events");
        assert_eq!(events, 0);
    }

    #[tokio::test]
    async fn queued_inputs_can_be_updated_reordered_and_cancelled_with_revisions() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");
        let control = ConversationInputControl::new(pool);
        let queued = control
            .submit(SubmitConversationInput {
                conversation_id,
                operation_id: Uuid::new_v4(),
                payload: payload("first"),
                principal: serde_json::json!({ "kind": "test" }),
            })
            .await
            .expect("submit input");

        let updated = control
            .update(UpdateConversationInput {
                conversation_id,
                input_id: queued.id,
                operation_id: Uuid::new_v4(),
                expected_revision: 1,
                payload: payload("edited"),
            })
            .await
            .expect("update queued input");
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.payload.text, "edited");

        let reordered = control
            .reorder(ReorderConversationInput {
                conversation_id,
                input_id: queued.id,
                operation_id: Uuid::new_v4(),
                expected_revision: 2,
                sort_key: -100,
            })
            .await
            .expect("reorder queued input");
        assert_eq!(reordered.revision, 3);
        assert_eq!(reordered.sort_key, -100);

        let cancelled = control
            .cancel(CancelConversationInput {
                conversation_id,
                input_id: queued.id,
                operation_id: Uuid::new_v4(),
                expected_revision: 3,
            })
            .await
            .expect("cancel queued input");
        assert_eq!(cancelled.revision, 4);
        assert_eq!(cancelled.status, ConversationInputStatus::Cancelled);
    }

    #[tokio::test]
    async fn input_mutation_cannot_cross_conversation_scope() {
        let pool = setup_pool().await;
        let first_conversation = Uuid::new_v4();
        let second_conversation = Uuid::new_v4();
        for conversation_id in [first_conversation, second_conversation] {
            ConversationRecord::create(
                &pool,
                conversation_id,
                CreateConversationRecord {
                    workspace_id: Uuid::new_v4(),
                    task_id: None,
                    title: None,
                    initial_prompt: None,
                    status: None,
                    executor: Some("codex"),
                },
            )
            .await
            .expect("create conversation");
        }
        let control = ConversationInputControl::new(pool);
        let input = control
            .submit(SubmitConversationInput {
                conversation_id: first_conversation,
                operation_id: Uuid::new_v4(),
                payload: payload("protected"),
                principal: serde_json::json!({ "kind": "test" }),
            })
            .await
            .expect("submit input");

        let error = control
            .reorder(ReorderConversationInput {
                conversation_id: second_conversation,
                input_id: input.id,
                operation_id: Uuid::new_v4(),
                expected_revision: 1,
                sort_key: 1,
            })
            .await
            .expect_err("cross-conversation mutation must fail closed");
        assert!(matches!(
            error,
            ConversationInputControlError::StateConflict { .. }
        ));
        assert_eq!(
            control
                .find(first_conversation, input.id)
                .await
                .expect("original input")
                .revision,
            1
        );
    }

    #[tokio::test]
    async fn claim_next_is_an_event_sourced_single_consumer_decision() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");
        let control = ConversationInputControl::new(pool.clone());
        let queued = control
            .submit(SubmitConversationInput {
                conversation_id,
                operation_id: Uuid::new_v4(),
                payload: payload("claim me"),
                principal: serde_json::json!({ "kind": "test" }),
            })
            .await
            .expect("submit input");

        let claim = control
            .claim_next(conversation_id, Duration::seconds(30))
            .await
            .expect("claim query")
            .expect("queued input");
        assert_eq!(claim.input.id, queued.id);
        assert_eq!(claim.input.status, ConversationInputStatus::Claimed);
        assert_eq!(claim.input.claim_token, Some(claim.claim_token));
        assert!(
            control
                .claim_next(conversation_id, Duration::seconds(30))
                .await
                .expect("second claim query")
                .is_none(),
            "a second dispatcher cannot claim the same input"
        );

        let claimed_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_events \
             WHERE conversation_id = ? AND event_kind = 'conversation_input' \
             AND normalized_json LIKE '%\"kind\":\"claimed\"%'",
        )
        .bind(conversation_id)
        .fetch_one(&pool)
        .await
        .expect("count claim events");
        assert_eq!(claimed_events, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sqlite_multi_connection_claim_stress_has_exactly_one_winner() {
        let (_temporary, pool) = setup_multi_connection_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");
        let control = ConversationInputControl::new(pool.clone());
        control
            .submit(SubmitConversationInput {
                conversation_id,
                operation_id: Uuid::new_v4(),
                payload: payload("claim once"),
                principal: serde_json::json!({ "kind": "test" }),
            })
            .await
            .expect("submit input");

        let mut claims = tokio::task::JoinSet::new();
        for _ in 0..32 {
            let control = control.clone();
            claims.spawn(async move {
                control
                    .claim_next(conversation_id, Duration::seconds(30))
                    .await
            });
        }
        let mut winners = 0;
        while let Some(result) = claims.join_next().await {
            if result.expect("claim task").expect("claim query").is_some() {
                winners += 1;
            }
        }
        assert_eq!(winners, 1);

        let claimed_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_events
             WHERE conversation_id = ? AND event_kind = 'conversation_input'
               AND normalized_json LIKE '%\"kind\":\"claimed\"%'",
        )
        .bind(conversation_id)
        .fetch_one(&pool)
        .await
        .expect("count claim events");
        assert_eq!(claimed_events, 1);
    }

    #[tokio::test]
    async fn stale_claim_recovery_appends_release_event_before_requeueing() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");
        let control = ConversationInputControl::new(pool.clone());
        let queued = control
            .submit(SubmitConversationInput {
                conversation_id,
                operation_id: Uuid::new_v4(),
                payload: payload("recover me"),
                principal: serde_json::json!({ "kind": "test" }),
            })
            .await
            .expect("submit input");
        let claim = control
            .claim_next(conversation_id, Duration::milliseconds(1))
            .await
            .expect("claim query")
            .expect("claimed input");
        assert_eq!(claim.input.id, queued.id);

        let released = control
            .recover_stale_claims(Utc::now() + Duration::seconds(1))
            .await
            .expect("recover stale claims");
        assert_eq!(released, 1);
        assert_eq!(
            control
                .find(conversation_id, queued.id)
                .await
                .expect("recovered input")
                .status,
            ConversationInputStatus::Queued
        );
        let release_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_events \
             WHERE conversation_id = ? \
             AND normalized_json LIKE '%\"kind\":\"claim_released\"%'",
        )
        .bind(conversation_id)
        .fetch_one(&pool)
        .await
        .expect("count release events");
        assert_eq!(release_events, 1);
    }

    #[tokio::test]
    async fn concurrent_submits_allocate_distinct_order_inside_the_append_transaction() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");
        let control = ConversationInputControl::new(pool);
        let first = control.submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload("first"),
            principal: serde_json::json!({ "kind": "test" }),
        });
        let second = control.submit(SubmitConversationInput {
            conversation_id,
            operation_id: Uuid::new_v4(),
            payload: payload("second"),
            principal: serde_json::json!({ "kind": "test" }),
        });
        let (first, second) = tokio::join!(first, second);
        first.expect("first concurrent submit");
        second.expect("second concurrent submit");

        let inputs = control.list(conversation_id).await.expect("ordered inputs");
        assert_eq!(inputs.len(), 2);
        assert_ne!(inputs[0].sort_key, inputs[1].sort_key);
        assert!(inputs[0].sort_key < inputs[1].sort_key);
    }

    #[test]
    #[ignore = "fixed-fixture capacity gate; run explicitly before release"]
    fn rebuilds_ten_thousand_input_events_with_one_thousand_queued_inputs() {
        let started = std::time::Instant::now();
        let mut events = Vec::with_capacity(10_000);
        let mut ids = Vec::with_capacity(1_000);
        for index in 0..1_000 {
            let input_id = Uuid::new_v4();
            ids.push(input_id);
            events.push(ConversationInputEvent::Submitted {
                input_id,
                operation_id: Uuid::new_v4(),
                revision: 1,
                sort_key: i64::from(index) * 1_024,
                payload_digest: format!("digest-{index}-1"),
                payload: payload("capacity fixture"),
                principal: serde_json::json!({"kind": "capacity"}),
            });
        }
        for revision in 2..=10 {
            for (index, input_id) in ids.iter().copied().enumerate() {
                events.push(ConversationInputEvent::Reordered {
                    input_id,
                    revision,
                    sort_key: i64::try_from(index).unwrap() * 1_024,
                });
            }
        }

        let queue = ConversationInputQueue::rebuild(events).expect("capacity fixture is valid");
        let ordered = queue.queued_ids();
        let elapsed = started.elapsed();
        assert_eq!(ordered.len(), 1_000);
        assert_eq!(ordered.first(), ids.first());
        assert_eq!(ordered.last(), ids.last());
        assert!(
            elapsed < StdDuration::from_secs(2),
            "10k-event queue rebuild exceeded 2s: {elapsed:?}"
        );
        eprintln!(
            "conversation_capacity events=10000 queued=1000 elapsed_ms={}",
            elapsed.as_millis()
        );
    }
}
