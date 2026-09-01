//! Production companion tools shared by desktop and `vibex-server`.

use std::sync::Arc;

use agents::{
    AgentElicitationId, AgentElicitationRequest, AgentEvent, AgentSessionId,
    ids::AgentConnectionId, runtime::AgentRuntime,
};
use async_trait::async_trait;
use conversations::{
    ScopedConversationControl, ScopedConversationControlError, resolve_referenced_session,
    session_info_value,
};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{CompanionFeaturePort, DelegationScope, InMemoryCompanionFeatures, PendingQuestion};

pub struct HostCompanionFeatures {
    pub memory: Arc<InMemoryCompanionFeatures>,
    pub pool: SqlitePool,
    pub runtime: Arc<AgentRuntime>,
    pub conversations: ScopedConversationControl,
}

impl std::fmt::Debug for HostCompanionFeatures {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HostCompanionFeatures")
            .finish_non_exhaustive()
    }
}

impl HostCompanionFeatures {
    pub fn new(
        memory: Arc<InMemoryCompanionFeatures>,
        pool: SqlitePool,
        runtime: Arc<AgentRuntime>,
        conversations: ScopedConversationControl,
    ) -> Self {
        Self {
            memory,
            pool,
            runtime,
            conversations,
        }
    }

    pub async fn answer_question(
        &self,
        question_id: &str,
        parent_conversation_id: Uuid,
        answers: Value,
    ) -> Result<PendingQuestion, &'static str> {
        self.memory
            .answer_question(question_id, parent_conversation_id, answers)
            .await
    }
}

#[async_trait]
impl CompanionFeaturePort for HostCompanionFeatures {
    async fn feedback(&self, scope: &DelegationScope) -> Value {
        self.memory.feedback(scope).await
    }

    async fn commit_feedback(&self, scope: &DelegationScope, ids: &[String]) {
        self.memory.commit_feedback(scope, ids).await;
    }

    async fn ask(&self, scope: &DelegationScope, questions: Value) -> Value {
        let questions = match delegation_proto::parse_questions(&questions) {
            Ok(parsed) => parsed,
            Err(error) => {
                return json!({
                    "declined": false,
                    "isError": true,
                    "message": error,
                    "answers": [],
                });
            }
        };
        let Ok(wait) = self
            .memory
            .begin_question(scope.clone(), questions.clone())
            .await
        else {
            return json!({
                "declined": true,
                "answers": [],
                "error": "question already pending for parent conversation",
            });
        };
        let pending = wait.question().clone();
        if let (Ok(connection_id), Ok(question_id)) = (
            Uuid::parse_str(&scope.parent_connection_id),
            Uuid::parse_str(&pending.id),
        ) {
            let message = questions
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|question| question["question"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            self.runtime
                .emit_external(
                    AgentConnectionId::from(connection_id),
                    Some(AgentSessionId::from(scope.parent_conversation_id)),
                    AgentEvent::ElicitationRequested {
                        request: AgentElicitationRequest {
                            id: AgentElicitationId(question_id),
                            session_id: AgentSessionId::from(scope.parent_conversation_id),
                            message,
                            requested_schema: json!({
                                "type": "object",
                                "x-vibex-questions": questions,
                            }),
                        },
                    },
                )
                .await;
        }
        match wait.wait().await {
            Ok(answer) if answer["__declined"] == true => json!({
                "question_id": pending.id,
                "declined": true,
                "answers": [],
            }),
            Ok(answers) => json!({
                "question_id": pending.id,
                "declined": false,
                "answers": answers,
            }),
            Err(_) => json!({
                "question_id": pending.id,
                "declined": true,
                "answers": [],
            }),
        }
    }

    async fn session_info(
        &self,
        _scope: &DelegationScope,
        conversation_id: &str,
        max_messages: u32,
    ) -> Value {
        let info = resolve_referenced_session(&self.pool, conversation_id, max_messages).await;
        session_info_value(&info)
    }

    async fn session_send(
        &self,
        scope: &DelegationScope,
        conversation_id: &str,
        operation_id: &str,
        text: &str,
    ) -> Value {
        match self
            .conversations
            .submit_text(
                scope.parent_conversation_id,
                conversation_id,
                operation_id,
                text,
            )
            .await
        {
            Ok(submission) => json!({
                "accepted": true,
                "conversation_id": conversation_id,
                "input": submission.input,
                "turn": submission.turn,
            }),
            Err(error) => control_error(conversation_id, error, true),
        }
    }

    async fn session_cancel(
        &self,
        scope: &DelegationScope,
        conversation_id: &str,
        reason: Option<&str>,
    ) -> Value {
        match self
            .conversations
            .cancel_turn(
                scope.parent_conversation_id,
                conversation_id,
                reason.map(str::to_string),
            )
            .await
        {
            Ok(()) => json!({ "accepted": true, "conversation_id": conversation_id }),
            Err(error) => control_error(conversation_id, error, true),
        }
    }

    async fn session_wait(
        &self,
        scope: &DelegationScope,
        conversation_id: &str,
        after_sequence: Option<i64>,
        wait_ms: Option<u64>,
    ) -> Value {
        match self
            .conversations
            .wait(
                scope.parent_conversation_id,
                conversation_id,
                after_sequence,
                wait_ms,
            )
            .await
        {
            Ok(snapshot) => serde_json::to_value(snapshot)
                .unwrap_or_else(|error| json!({ "found": false, "message": error.to_string() })),
            Err(error) => control_error(conversation_id, error, false),
        }
    }
}

fn control_error(
    conversation_id: &str,
    error: ScopedConversationControlError,
    send: bool,
) -> Value {
    let code = match &error {
        ScopedConversationControlError::InvalidConversationId => "invalid_conversation_id",
        ScopedConversationControlError::InvalidOperationId => "invalid_operation_id",
        ScopedConversationControlError::OutOfScope => "conversation_out_of_scope",
        ScopedConversationControlError::MissingAgent => "conversation_missing_agent",
        ScopedConversationControlError::Internal(_) => "conversation_control_failed",
    };
    if send {
        json!({
            "accepted": false,
            "conversation_id": conversation_id,
            "error_code": code,
            "message": error.to_string(),
        })
    } else {
        json!({
            "found": false,
            "conversation_id": conversation_id,
            "error_code": code,
            "message": error.to_string(),
        })
    }
}
