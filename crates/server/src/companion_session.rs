//! Application-core adapter over the in-memory companion store.

use std::sync::Arc;

use agents::{
    AgentElicitationId, AgentElicitationResponse, AgentEvent, AgentSessionId,
    conversation::ConversationEvent, ids::AgentConnectionId,
};
use application::{ApplicationError, CompanionSessionPort, ConversationLiveFeedbackNote};
use async_trait::async_trait;
use conversations::{ConversationContext, ConversationEventAppender};
use db::models::{
    conversation_event::AppendConversationEvent,
    conversation_feedback_note::{ConversationFeedbackNoteRecord, CreateConversationFeedbackNote},
};
use delegation::InMemoryCompanionFeatures;
use plugins::{OfficialMcpRuntime, SESSION_FEAT_FEEDBACK};
use serde_json::json;
use uuid::Uuid;

pub struct CompanionSessionAdapter {
    memory: Arc<InMemoryCompanionFeatures>,
    context: ConversationContext,
    official_mcp: Arc<OfficialMcpRuntime>,
}

impl CompanionSessionAdapter {
    pub fn new(
        memory: Arc<InMemoryCompanionFeatures>,
        context: ConversationContext,
        official_mcp: Arc<OfficialMcpRuntime>,
    ) -> Self {
        Self {
            memory,
            context,
            official_mcp,
        }
    }
}

#[async_trait]
impl CompanionSessionPort for CompanionSessionAdapter {
    async fn submit_feedback(
        &self,
        conversation_id: Uuid,
        text: &str,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        let gate = &self.official_mcp;
        if !gate.allow_session_mcp() || gate.session_features() & SESSION_FEAT_FEEDBACK == 0 {
            return Err(ApplicationError::conflict("live feedback is off"));
        }
        let runtime = self
            .context
            .runtime_states
            .lock()
            .await
            .get(&conversation_id)
            .cloned()
            .ok_or_else(|| ApplicationError::conflict("no live session"))?;
        let connection_id = runtime
            .connection_id
            .clone()
            .ok_or_else(|| ApplicationError::conflict("no live session"))?;
        if !runtime.turn_in_flight {
            return Err(ApplicationError::conflict("no active turn"));
        }
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(ApplicationError::bad_request("feedback is empty"));
        }
        if trimmed.chars().count() > delegation::MAX_FEEDBACK_CHARS {
            return Err(ApplicationError::bad_request("feedback is too long"));
        }
        let note_id = Uuid::new_v4();
        let operation_id = Uuid::new_v4();
        let turn_id = runtime.active_turn_id;
        let event = ConversationEvent::UserSubmittedFeedback {
            note_id,
            operation_id,
            text: trimmed.to_string(),
            turn_id,
        };
        let event_value = serde_json::to_value(&event)
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let event_kind = event_value
            .get("kind")
            .and_then(|value| value.as_str())
            .ok_or_else(|| ApplicationError::internal("feedback event missing kind"))?
            .to_string();
        let normalized_json = serde_json::to_string(&event)
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let idempotency_key = format!("user-feedback:{note_id}");
        let mut conn = self
            .context
            .deployment
            .db()
            .pool
            .acquire()
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let record = match ConversationFeedbackNoteRecord::create_pending(
            &mut conn,
            CreateConversationFeedbackNote {
                id: note_id,
                conversation_id,
                operation_id,
                turn_id,
                text: trimmed,
            },
        )
        .await
        {
            Ok(record) => record,
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(ApplicationError::internal(error.to_string()));
            }
        };
        let event_record = match ConversationEventAppender::append_on_connection(
            &mut conn,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                binding_id: runtime.binding_id,
                connection_id: Some(&connection_id),
                prompt_id: None,
                source: "user",
                event_kind: &event_kind,
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: Some(&idempotency_key),
            },
        )
        .await
        {
            Ok(record) => record,
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(ApplicationError::internal(error.to_string()));
            }
        };
        if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(ApplicationError::internal(error.to_string()));
        }
        self.context.event_publisher.publish(&event_record).await;
        Ok(note_record_view(record))
    }

    async fn list_feedback(
        &self,
        conversation_id: Uuid,
    ) -> Result<Vec<ConversationLiveFeedbackNote>, ApplicationError> {
        let in_flight = self
            .context
            .runtime_states
            .lock()
            .await
            .get(&conversation_id)
            .is_some_and(|runtime| runtime.turn_in_flight);
        if !in_flight {
            let _ = ConversationFeedbackNoteRecord::expire_pending_for_conversation(
                &self.context.deployment.db().pool,
                conversation_id,
            )
            .await;
        }
        ConversationFeedbackNoteRecord::list_for_conversation(
            &self.context.deployment.db().pool,
            conversation_id,
        )
        .await
        .map(|notes| notes.into_iter().map(note_record_view).collect())
        .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn salvage_feedback(
        &self,
        conversation_id: Uuid,
        note_id: &str,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        let id = Uuid::parse_str(note_id)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let updated = ConversationFeedbackNoteRecord::settle_pending(
            &self.context.deployment.db().pool,
            conversation_id,
            &[id],
            "salvaged",
            None,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        if updated == 0 {
            return Err(ApplicationError::conflict("feedback note is not pending"));
        }
        let notes = ConversationFeedbackNoteRecord::list_for_conversation(
            &self.context.deployment.db().pool,
            conversation_id,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        notes
            .into_iter()
            .find(|note| note.id == id)
            .map(note_record_view)
            .ok_or_else(|| ApplicationError::not_found("feedback note not found"))
    }

    async fn dismiss_feedback(
        &self,
        conversation_id: Uuid,
        note_id: &str,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        let id = Uuid::parse_str(note_id)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let updated = ConversationFeedbackNoteRecord::settle_pending(
            &self.context.deployment.db().pool,
            conversation_id,
            &[id],
            "dismissed",
            None,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        if updated == 0 {
            return Err(ApplicationError::conflict("feedback note is not open"));
        }
        let notes = ConversationFeedbackNoteRecord::list_for_conversation(
            &self.context.deployment.db().pool,
            conversation_id,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        notes
            .into_iter()
            .find(|note| note.id == id)
            .map(note_record_view)
            .ok_or_else(|| ApplicationError::not_found("feedback note not found"))
    }

    async fn answer_question(
        &self,
        conversation_id: Uuid,
        question_id: &str,
        response: AgentElicitationResponse,
    ) -> Result<bool, ApplicationError> {
        let companion_answer = match &response {
            AgentElicitationResponse::Accept { content } => content
                .get("answers")
                .cloned()
                .unwrap_or_else(|| content.clone()),
            AgentElicitationResponse::Decline | AgentElicitationResponse::Cancel => {
                json!({ "__declined": true })
            }
        };
        let Ok(pending) = self
            .memory
            .answer_question(question_id, conversation_id, companion_answer)
            .await
        else {
            return Ok(false);
        };
        let connection_id = Uuid::parse_str(&pending.scope.parent_connection_id)
            .map(AgentConnectionId::from)
            .map_err(|error| {
                ApplicationError::bad_request(format!("invalid companion connection id: {error}"))
            })?;
        let elicitation_id = Uuid::parse_str(&pending.id)
            .map(AgentElicitationId)
            .map_err(|error| {
                ApplicationError::bad_request(format!("invalid companion question id: {error}"))
            })?;
        self.context
            .agent_runtime
            .emit_external(
                connection_id,
                Some(AgentSessionId::from(pending.scope.parent_conversation_id)),
                AgentEvent::ElicitationResponded {
                    elicitation_id,
                    response,
                },
            )
            .await;
        Ok(true)
    }

    async fn clear_turn(&self, conversation_id: Uuid) {
        let _ = ConversationFeedbackNoteRecord::expire_pending_for_conversation(
            &self.context.deployment.db().pool,
            conversation_id,
        )
        .await;
        self.memory.clear_conversation(conversation_id).await;
    }
}

fn note_record_view(note: ConversationFeedbackNoteRecord) -> ConversationLiveFeedbackNote {
    ConversationLiveFeedbackNote {
        id: note.id.to_string(),
        text: note.text,
        created_at: note.created_at.to_rfc3339(),
        status: note.status,
        delivered_at: note.delivered_at.map(|at| at.to_rfc3339()),
    }
}
