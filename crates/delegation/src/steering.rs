use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, Notify, oneshot};
use uuid::Uuid;

use crate::DelegationScope;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FeedbackNote {
    pub id: String,
    pub text: String,
}

#[async_trait]
pub trait CompanionFeaturePort: std::fmt::Debug + Send + Sync {
    async fn feedback(&self, scope: &DelegationScope) -> Value;
    async fn commit_feedback(&self, scope: &DelegationScope, ids: &[String]);

    async fn ask(&self, _scope: &DelegationScope, _questions: Value) -> Value {
        json!({ "declined": true, "answers": [] })
    }

    async fn session_info(
        &self,
        _scope: &DelegationScope,
        conversation_id: &str,
        _max_messages: u32,
    ) -> Value {
        json!({ "found": false, "conversation_id": conversation_id })
    }
}

#[derive(Debug, Default)]
pub struct NoopCompanionFeatures;

#[async_trait]
impl CompanionFeaturePort for NoopCompanionFeatures {
    async fn feedback(&self, _scope: &DelegationScope) -> Value {
        json!({ "count": 0, "feedback": [] })
    }

    async fn commit_feedback(&self, _scope: &DelegationScope, _ids: &[String]) {}
}

#[derive(Debug, Default)]
pub struct InMemoryCompanionFeatures {
    feedback: Mutex<HashMap<DelegationScope, Vec<FeedbackNote>>>,
    questions: Mutex<HashMap<String, PendingQuestionState>>,
    question_notify: Notify,
    sessions: Mutex<HashMap<(DelegationScope, String), Value>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingQuestion {
    pub id: String,
    pub scope: DelegationScope,
    pub questions: Value,
}

#[derive(Debug)]
struct PendingQuestionState {
    question: PendingQuestion,
    answer_tx: oneshot::Sender<Value>,
}

impl InMemoryCompanionFeatures {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn push_feedback(&self, scope: DelegationScope, text: impl Into<String>) -> String {
        let id = Uuid::new_v4().to_string();
        self.feedback
            .lock()
            .await
            .entry(scope)
            .or_default()
            .push(FeedbackNote {
                id: id.clone(),
                text: text.into(),
            });
        id
    }

    pub async fn next_question(&self, scope: &DelegationScope) -> PendingQuestion {
        loop {
            let notified = self.question_notify.notified();
            if let Some(question) = self
                .questions
                .lock()
                .await
                .values()
                .find(|pending| &pending.question.scope == scope)
                .map(|pending| pending.question.clone())
            {
                return question;
            }
            notified.await;
        }
    }

    pub async fn begin_question(
        &self,
        scope: DelegationScope,
        questions: Value,
    ) -> (PendingQuestion, oneshot::Receiver<Value>) {
        let id = Uuid::new_v4().to_string();
        let question = PendingQuestion {
            id: id.clone(),
            scope,
            questions,
        };
        let (answer_tx, answer_rx) = oneshot::channel();
        self.questions.lock().await.insert(
            id,
            PendingQuestionState {
                question: question.clone(),
                answer_tx,
            },
        );
        self.question_notify.notify_waiters();
        (question, answer_rx)
    }

    pub async fn answer_question(
        &self,
        question_id: &str,
        parent_conversation_id: Uuid,
        answers: Value,
    ) -> Result<PendingQuestion, &'static str> {
        let mut questions = self.questions.lock().await;
        let pending = questions.get(question_id).ok_or("question not found")?;
        if pending.question.scope.parent_conversation_id != parent_conversation_id {
            return Err("question does not belong to conversation");
        }
        let pending = questions.remove(question_id).expect("checked above");
        drop(questions);
        let question = pending.question;
        pending
            .answer_tx
            .send(answers)
            .map_err(|_| "question is no longer waiting")?;
        Ok(question)
    }

    pub async fn register_session_info(
        &self,
        scope: DelegationScope,
        conversation_id: impl Into<String>,
        info: Value,
    ) {
        self.sessions
            .lock()
            .await
            .insert((scope, conversation_id.into()), info);
    }
}

#[async_trait]
impl CompanionFeaturePort for InMemoryCompanionFeatures {
    async fn feedback(&self, scope: &DelegationScope) -> Value {
        let notes = self
            .feedback
            .lock()
            .await
            .get(scope)
            .cloned()
            .unwrap_or_default();
        json!({ "count": notes.len(), "feedback": notes })
    }

    async fn commit_feedback(&self, scope: &DelegationScope, ids: &[String]) {
        let mut queues = self.feedback.lock().await;
        let Some(notes) = queues.get_mut(scope) else {
            return;
        };
        notes.retain(|note| !ids.contains(&note.id));
        if notes.is_empty() {
            queues.remove(scope);
        }
    }

    async fn ask(&self, scope: &DelegationScope, questions: Value) -> Value {
        let (question, answer_rx) = self.begin_question(scope.clone(), questions).await;
        match answer_rx.await {
            Ok(answers) => json!({
                "question_id": question.id,
                "declined": false,
                "answers": answers,
            }),
            Err(_) => json!({
                "question_id": question.id,
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
        self.sessions
            .lock()
            .await
            .get(&(scope.clone(), conversation_id.to_string()))
            .cloned()
            .unwrap_or_else(|| {
                json!({
                    "found": false,
                    "conversation_id": conversation_id,
                })
            })
    }
}

pub type SharedCompanionFeatures = Arc<dyn CompanionFeaturePort>;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn question_answer_is_bound_to_parent_conversation() {
        let features = InMemoryCompanionFeatures::new();
        let parent = Uuid::new_v4();
        let other = Uuid::new_v4();
        let (question, answer_rx) = features
            .begin_question(
                DelegationScope {
                    parent_connection_id: "parent".to_string(),
                    parent_conversation_id: parent,
                },
                json!([{ "question": "Continue?" }]),
            )
            .await;

        assert!(
            features
                .answer_question(&question.id, other, json!({ "answer": "wrong" }))
                .await
                .is_err()
        );
        features
            .answer_question(&question.id, parent, json!({ "answer": "yes" }))
            .await
            .unwrap();
        assert_eq!(answer_rx.await.unwrap()["answer"], "yes");
    }
}
