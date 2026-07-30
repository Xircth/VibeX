use std::sync::Arc;

use agents::{
    AgentElicitationId, AgentElicitationRequest, AgentEvent, AgentSessionId,
    conversation::{ConversationEvent, ConversationInputBlock},
    ids::AgentConnectionId,
    runtime::AgentRuntime,
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
        max_messages: u32,
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
        let messages = load_compact_transcript(&self.pool, conversation_id, max_messages).await;
        json!({
            "found": true,
            "conversation_id": summary.id,
            "title": summary.title,
            "agent_id": summary.agent_id,
            "status": summary.status,
            "workspace_id": summary.workspace_id,
            "message_count": summary.message_count,
            "parent_conversation_id": summary.parent_session_id,
            "messages": messages,
        })
    }
}

async fn load_compact_transcript(
    pool: &SqlitePool,
    conversation_id: Uuid,
    max_messages: u32,
) -> Vec<Value> {
    if max_messages == 0 {
        return Vec::new();
    }
    let rows = sqlx::query_scalar::<_, String>(
        r#"SELECT normalized_json
           FROM conversation_events
           WHERE conversation_id = ?
             AND event_kind IN ('user_turn_created', 'assistant_text_delta')
           ORDER BY sequence DESC
           LIMIT ?"#,
    )
    .bind(conversation_id)
    .bind(i64::from(max_messages.min(200)))
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    rows.into_iter()
        .rev()
        .filter_map(|normalized| {
            let event = serde_json::from_str::<ConversationEvent>(&normalized).ok()?;
            match event {
                ConversationEvent::UserTurnCreated { blocks } => {
                    let content = blocks
                        .into_iter()
                        .filter_map(|block| match block {
                            ConversationInputBlock::Text { text } => Some(text),
                            ConversationInputBlock::Image { .. }
                            | ConversationInputBlock::Resource { .. } => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    (!content.is_empty()).then(|| json!({ "role": "user", "content": content }))
                }
                ConversationEvent::AssistantTextDelta { text, .. } => {
                    Some(json!({ "role": "assistant", "content": text }))
                }
                _ => None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    #[tokio::test]
    async fn compact_transcript_honors_message_limit_and_zero() {
        let options = SqliteConnectOptions::from_str("sqlite::memory:").unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE conversation_events (
                   conversation_id BLOB NOT NULL,
                   event_kind TEXT NOT NULL,
                   sequence INTEGER NOT NULL,
                   normalized_json TEXT NOT NULL
               )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let conversation_id = Uuid::new_v4();
        for (sequence, event) in [
            (
                1,
                ConversationEvent::UserTurnCreated {
                    blocks: vec![ConversationInputBlock::Text {
                        text: "first".to_string(),
                    }],
                },
            ),
            (
                2,
                ConversationEvent::AssistantTextDelta {
                    text: "second".to_string(),
                    message_id: None,
                },
            ),
        ] {
            let normalized = serde_json::to_string(&event).unwrap();
            let kind = if sequence == 1 {
                "user_turn_created"
            } else {
                "assistant_text_delta"
            };
            sqlx::query(
                "INSERT INTO conversation_events \
                 (conversation_id, event_kind, sequence, normalized_json) VALUES (?, ?, ?, ?)",
            )
            .bind(conversation_id)
            .bind(kind)
            .bind(sequence)
            .bind(normalized)
            .execute(&pool)
            .await
            .unwrap();
        }

        let one = load_compact_transcript(&pool, conversation_id, 1).await;
        let none = load_compact_transcript(&pool, conversation_id, 0).await;

        assert_eq!(
            one,
            vec![json!({ "role": "assistant", "content": "second" })]
        );
        assert!(none.is_empty());
    }
}
