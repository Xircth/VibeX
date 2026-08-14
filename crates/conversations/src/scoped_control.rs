use std::time::{Duration, Instant};

use agents::{AgentId, ConversationInputPayload};
use db::models::{conversation::DbConversationSummary, conversation_turn::ConversationTurnRecord};
use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;

use crate::{
    ConversationContext, ConversationInputControl, ConversationInputSubmission,
    ConversationRelationControl, ConversationSessionService, SubmitConversationInput,
};

#[derive(Debug, Error)]
pub enum ScopedConversationControlError {
    #[error("invalid conversation id")]
    InvalidConversationId,
    #[error("invalid operation id")]
    InvalidOperationId,
    #[error("conversation is outside the companion scope")]
    OutOfScope,
    #[error("conversation has no configured agent")]
    MissingAgent,
    #[error("{0}")]
    Internal(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedConversationWait {
    pub conversation_id: Uuid,
    pub ready: bool,
    pub timed_out: bool,
    pub last_sequence: i64,
    pub turn_id: Option<Uuid>,
    pub turn_status: Option<String>,
}

/// Capability-scoped facade used by the per-session companion. It deliberately
/// exposes only durable input and read-only wait; authority is derived from the
/// parent/descendant relation on every call rather than from a guessed UUID.
#[derive(Clone)]
pub struct ScopedConversationControl {
    context: ConversationContext,
}

impl ScopedConversationControl {
    pub fn new(context: ConversationContext) -> Self {
        Self { context }
    }

    pub async fn submit_text(
        &self,
        parent_conversation_id: Uuid,
        conversation_id: &str,
        operation_id: &str,
        text: &str,
    ) -> Result<ConversationInputSubmission, ScopedConversationControlError> {
        let conversation_id = Uuid::parse_str(conversation_id)
            .map_err(|_| ScopedConversationControlError::InvalidConversationId)?;
        let operation_id = Uuid::parse_str(operation_id)
            .map_err(|_| ScopedConversationControlError::InvalidOperationId)?;
        let summary = self
            .authorize(parent_conversation_id, conversation_id)
            .await?;
        let agent_id = summary
            .agent_id
            .ok_or(ScopedConversationControlError::MissingAgent)
            .and_then(|agent_id| {
                AgentId::parse(agent_id.as_ref())
                    .map_err(|error| ScopedConversationControlError::Internal(error.to_string()))
            })?;
        let inputs = ConversationInputControl::with_publisher(
            self.context.deployment.db().pool.clone(),
            self.context.event_publisher.clone(),
        );
        let submitted = inputs
            .submit(SubmitConversationInput {
                conversation_id,
                operation_id,
                payload: ConversationInputPayload {
                    agent_id,
                    workspace_id: summary.workspace_id,
                    executor_profile_id: None,
                    text: text.to_string(),
                    display_text: None,
                    images: Vec::new(),
                    mode_override: None,
                    config_overrides: Vec::new(),
                    plugin_actions: Vec::new(),
                },
                principal: serde_json::json!({
                    "kind": "companion",
                    "parentConversationId": parent_conversation_id,
                }),
            })
            .await
            .map_err(|error| ScopedConversationControlError::Internal(error.to_string()))?;
        let service = ConversationSessionService::new(self.context.clone());
        let turn = service
            .dispatch_next_queued_input(conversation_id)
            .await
            .map_err(|error| ScopedConversationControlError::Internal(error.to_string()))?;
        let input = inputs
            .find(conversation_id, submitted.id)
            .await
            .map_err(|error| ScopedConversationControlError::Internal(error.to_string()))?;
        Ok(ConversationInputSubmission { input, turn })
    }

    pub async fn wait(
        &self,
        parent_conversation_id: Uuid,
        conversation_id: &str,
        after_sequence: Option<i64>,
        wait_ms: Option<u64>,
    ) -> Result<ScopedConversationWait, ScopedConversationControlError> {
        let conversation_id = Uuid::parse_str(conversation_id)
            .map_err(|_| ScopedConversationControlError::InvalidConversationId)?;
        self.authorize(parent_conversation_id, conversation_id)
            .await?;
        let deadline = wait_ms
            .filter(|value| *value > 0)
            .map(|value| Instant::now() + Duration::from_millis(value.min(60_000)));

        loop {
            let snapshot = self.wait_snapshot(conversation_id, after_sequence).await?;
            if snapshot.ready || wait_ms.is_none() {
                return Ok(snapshot);
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Ok(ScopedConversationWait {
                    timed_out: true,
                    ..snapshot
                });
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub async fn cancel_turn(
        &self,
        parent_conversation_id: Uuid,
        conversation_id: &str,
        reason: Option<String>,
    ) -> Result<(), ScopedConversationControlError> {
        let conversation_id = Uuid::parse_str(conversation_id)
            .map_err(|_| ScopedConversationControlError::InvalidConversationId)?;
        self.authorize(parent_conversation_id, conversation_id)
            .await?;
        ConversationSessionService::new(self.context.clone())
            .cancel_turn(conversation_id, reason)
            .await
            .map_err(|error| ScopedConversationControlError::Internal(error.to_string()))
    }

    async fn wait_snapshot(
        &self,
        conversation_id: Uuid,
        after_sequence: Option<i64>,
    ) -> Result<ScopedConversationWait, ScopedConversationControlError> {
        let pool = &self.context.deployment.db().pool;
        let last_sequence = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(sequence), 0) FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(pool)
        .await
        .map_err(|error| ScopedConversationControlError::Internal(error.to_string()))?;
        let turn = ConversationTurnRecord::list_for_conversation(pool, conversation_id)
            .await
            .map_err(|error| ScopedConversationControlError::Internal(error.to_string()))?
            .into_iter()
            .last();
        let turn_terminal = turn.as_ref().is_some_and(|turn| {
            !matches!(
                turn.status.as_str(),
                "pending" | "queued" | "running" | "blocked"
            )
        });
        let cursor_advanced = after_sequence.is_some_and(|cursor| last_sequence > cursor);
        Ok(ScopedConversationWait {
            conversation_id,
            ready: cursor_advanced || turn_terminal,
            timed_out: false,
            last_sequence,
            turn_id: turn.as_ref().map(|turn| turn.id),
            turn_status: turn.map(|turn| turn.status),
        })
    }

    async fn authorize(
        &self,
        parent_conversation_id: Uuid,
        conversation_id: Uuid,
    ) -> Result<DbConversationSummary, ScopedConversationControlError> {
        let pool = &self.context.deployment.db().pool;
        ConversationRelationControl::new(pool.clone())
            .companion_scope_target(parent_conversation_id, conversation_id)
            .await
            .map_err(|error| ScopedConversationControlError::Internal(error.to_string()))?
            .ok_or(ScopedConversationControlError::OutOfScope)
    }
}
