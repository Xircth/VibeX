use std::sync::Arc;

use agents::{
    AgentElicitationId, AgentElicitationRequest, AgentEvent, AgentSessionId,
    ids::AgentConnectionId, runtime::AgentRuntime,
};
use async_trait::async_trait;
use db::models::conversation::DbConversationSummary;
use delegation::{CompanionFeaturePort, DelegationScope, InMemoryCompanionFeatures};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

pub(crate) struct RuntimeCompanionFeatures {
    pub memory: Arc<InMemoryCompanionFeatures>,
    pub pool: SqlitePool,
    pub runtime: Arc<AgentRuntime>,
}

impl std::fmt::Debug for RuntimeCompanionFeatures {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeCompanionFeatures")
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl CompanionFeaturePort for RuntimeCompanionFeatures {
    async fn feedback(&self, scope: &DelegationScope) -> Value {
        self.memory.feedback(scope).await
    }

    async fn commit_feedback(&self, scope: &DelegationScope, ids: &[String]) {
        self.memory.commit_feedback(scope, ids).await;
    }

    async fn ask(&self, scope: &DelegationScope, questions: Value) -> Value {
        let (pending, answer_rx) = self
            .memory
            .begin_question(scope.clone(), questions.clone())
            .await;
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
        match answer_rx.await {
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
        scope: &DelegationScope,
        conversation_id: &str,
        _max_messages: u32,
    ) -> Value {
        let Ok(conversation_id) = Uuid::parse_str(conversation_id) else {
            return json!({ "found": false, "conversation_id": conversation_id });
        };
        let (Ok(Some(parent)), Ok(Some(summary))) = (
            DbConversationSummary::find_by_id(&self.pool, scope.parent_conversation_id).await,
            DbConversationSummary::find_by_id(&self.pool, conversation_id).await,
        ) else {
            return json!({ "found": false, "conversation_id": conversation_id });
        };
        if parent.workspace_id != summary.workspace_id {
            return json!({ "found": false, "conversation_id": conversation_id });
        }
        json!({
            "found": true,
            "conversation_id": summary.id,
            "title": summary.title,
            "agent_id": summary.agent_id,
            "status": summary.status,
            "workspace_id": summary.workspace_id,
            "message_count": summary.message_count,
            "parent_conversation_id": summary.parent_session_id,
        })
    }
}
