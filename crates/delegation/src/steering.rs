use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, Notify, oneshot};
use uuid::Uuid;

use crate::DelegationScope;

pub const MAX_FEEDBACK_CHARS: usize = 4096;
pub const MAX_FEEDBACK_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackStatus {
    Pending,
    Delivered,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FeedbackNote {
    pub id: String,
    pub text: String,
    pub created_at: DateTime<Utc>,
    pub status: FeedbackStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedbackError {
    Empty,
    TooLong,
}

impl FeedbackNote {
    fn new_pending(text: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            text,
            created_at: Utc::now(),
            status: FeedbackStatus::Pending,
            delivered_at: None,
        }
    }

    fn agent_payload(&self) -> Value {
        json!({
            "id": self.id,
            "text": self.text,
            "created_at": self.created_at.to_rfc3339(),
        })
    }
}

fn estimated_note_response_bytes(text: &str) -> usize {
    text.len().saturating_mul(6).saturating_add(128)
}

fn bounded_feedback_batch(pending: Vec<FeedbackNote>) -> Vec<FeedbackNote> {
    let mut out: Vec<FeedbackNote> = Vec::new();
    let mut total: usize = 64;
    for note in pending {
        let cost = estimated_note_response_bytes(&note.text);
        if !out.is_empty() && total.saturating_add(cost) > MAX_FEEDBACK_RESPONSE_BYTES {
            break;
        }
        total = total.saturating_add(cost);
        out.push(note);
    }
    out
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

    async fn session_send(
        &self,
        _scope: &DelegationScope,
        conversation_id: &str,
        _operation_id: &str,
        _text: &str,
    ) -> Value {
        json!({
            "accepted": false,
            "conversation_id": conversation_id,
            "error_code": "session_control_unavailable",
        })
    }

    async fn session_cancel(
        &self,
        _scope: &DelegationScope,
        conversation_id: &str,
        _reason: Option<&str>,
    ) -> Value {
        json!({
            "accepted": false,
            "conversation_id": conversation_id,
            "error_code": "session_control_unavailable",
        })
    }

    async fn session_wait(
        &self,
        _scope: &DelegationScope,
        conversation_id: &str,
        _after_sequence: Option<i64>,
        _wait_ms: Option<u64>,
    ) -> Value {
        json!({
            "found": false,
            "conversation_id": conversation_id,
            "error_code": "session_control_unavailable",
        })
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
    feedback: AsyncMutex<HashMap<DelegationScope, Vec<FeedbackNote>>>,
    questions: Arc<StdMutex<HashMap<String, PendingQuestionState>>>,
    question_notify: Notify,
    sessions: AsyncMutex<HashMap<(DelegationScope, String), Value>>,
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

struct QuestionWaitGuard {
    questions: Arc<StdMutex<HashMap<String, PendingQuestionState>>>,
    question_id: String,
}

/// Owns a pending question from insertion until answer/cancellation. Dropping
/// this handle removes the question synchronously, including while callers are
/// between async setup steps.
pub struct PendingQuestionWait {
    question: PendingQuestion,
    answer_rx: oneshot::Receiver<Value>,
    _guard: QuestionWaitGuard,
}

impl PendingQuestionWait {
    pub fn question(&self) -> &PendingQuestion {
        &self.question
    }

    pub async fn wait(self) -> Result<Value, oneshot::error::RecvError> {
        self.answer_rx.await
    }
}

impl Drop for QuestionWaitGuard {
    fn drop(&mut self) {
        self.questions.lock().unwrap().remove(&self.question_id);
    }
}

impl InMemoryCompanionFeatures {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn push_feedback(
        &self,
        scope: DelegationScope,
        text: impl Into<String>,
    ) -> Result<FeedbackNote, FeedbackError> {
        let text = text.into();
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(FeedbackError::Empty);
        }
        if trimmed.chars().count() > MAX_FEEDBACK_CHARS {
            return Err(FeedbackError::TooLong);
        }
        let note = FeedbackNote::new_pending(trimmed.to_string());
        self.feedback
            .lock()
            .await
            .entry(scope)
            .or_default()
            .push(note.clone());
        Ok(note)
    }

    pub async fn list_feedback(&self, conversation_id: Uuid) -> Vec<FeedbackNote> {
        self.feedback
            .lock()
            .await
            .iter()
            .filter(|(scope, _)| scope.parent_conversation_id == conversation_id)
            .flat_map(|(_, notes)| notes.clone())
            .collect()
    }

    pub async fn clear_conversation(&self, conversation_id: Uuid) {
        self.feedback
            .lock()
            .await
            .retain(|scope, _| scope.parent_conversation_id != conversation_id);
    }

    pub async fn next_question(&self, scope: &DelegationScope) -> PendingQuestion {
        loop {
            let notified = self.question_notify.notified();
            if let Some(question) = self
                .questions
                .lock()
                .unwrap()
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
    ) -> Result<PendingQuestionWait, &'static str> {
        let id = Uuid::new_v4().to_string();
        let question = PendingQuestion {
            id: id.clone(),
            scope,
            questions,
        };
        let (answer_tx, answer_rx) = oneshot::channel();
        let mut pending_questions = self.questions.lock().unwrap();
        if pending_questions
            .values()
            .any(|pending| pending.question.scope == question.scope)
        {
            return Err("question already pending for parent conversation");
        }
        pending_questions.insert(
            id.clone(),
            PendingQuestionState {
                question: question.clone(),
                answer_tx,
            },
        );
        drop(pending_questions);
        self.question_notify.notify_waiters();
        Ok(PendingQuestionWait {
            question,
            answer_rx,
            _guard: QuestionWaitGuard {
                questions: self.questions.clone(),
                question_id: id,
            },
        })
    }

    pub async fn answer_question(
        &self,
        question_id: &str,
        parent_conversation_id: Uuid,
        answers: Value,
    ) -> Result<PendingQuestion, &'static str> {
        let mut questions = self.questions.lock().unwrap();
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

    /// Drop all steering state for a torn-down parent connection. Dropping the
    /// answer senders releases blocked `ask` calls as declined.
    pub async fn close_parent_connection(&self, parent_connection_id: &str) {
        self.feedback
            .lock()
            .await
            .retain(|scope, _| scope.parent_connection_id != parent_connection_id);
        self.questions.lock().unwrap().retain(|_, pending| {
            pending.question.scope.parent_connection_id != parent_connection_id
        });
        self.sessions
            .lock()
            .await
            .retain(|(scope, _), _| scope.parent_connection_id != parent_connection_id);
    }
}

#[async_trait]
impl CompanionFeaturePort for InMemoryCompanionFeatures {
    async fn feedback(&self, scope: &DelegationScope) -> Value {
        let pending = self
            .feedback
            .lock()
            .await
            .get(scope)
            .into_iter()
            .flatten()
            .filter(|note| note.status == FeedbackStatus::Pending)
            .cloned()
            .collect::<Vec<_>>();
        let batch = bounded_feedback_batch(pending);
        json!({
            "count": batch.len(),
            "feedback": batch.iter().map(FeedbackNote::agent_payload).collect::<Vec<_>>(),
        })
    }

    async fn commit_feedback(&self, scope: &DelegationScope, ids: &[String]) {
        let mut queues = self.feedback.lock().await;
        let Some(notes) = queues.get_mut(scope) else {
            return;
        };
        let now = Utc::now();
        for note in notes.iter_mut() {
            if ids.contains(&note.id) && note.status == FeedbackStatus::Pending {
                note.status = FeedbackStatus::Delivered;
                note.delivered_at = Some(now);
            }
        }
    }

    async fn ask(&self, scope: &DelegationScope, questions: Value) -> Value {
        let Ok(wait) = self.begin_question(scope.clone(), questions).await else {
            return json!({
                "declined": true,
                "answers": [],
                "error": "question already pending for parent conversation",
            });
        };
        let question = wait.question().clone();
        match wait.wait().await {
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
        let wait = features
            .begin_question(
                DelegationScope {
                    parent_connection_id: "parent".to_string(),
                    parent_conversation_id: parent,
                },
                json!([{ "question": "Continue?" }]),
            )
            .await
            .unwrap();
        let question = wait.question().clone();

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
        assert_eq!(wait.wait().await.unwrap()["answer"], "yes");
    }

    #[tokio::test]
    async fn parent_allows_one_question_and_teardown_releases_waiter() {
        let features = InMemoryCompanionFeatures::new();
        let scope = DelegationScope {
            parent_connection_id: "parent".to_string(),
            parent_conversation_id: Uuid::new_v4(),
        };
        let first_wait = features
            .begin_question(scope.clone(), json!([{ "question": "First?" }]))
            .await
            .unwrap();

        assert!(
            features
                .begin_question(scope, json!([{ "question": "Second?" }]))
                .await
                .is_err()
        );
        features.close_parent_connection("parent").await;
        assert!(
            first_wait.wait().await.is_err(),
            "teardown drops answer sender"
        );
    }

    #[tokio::test]
    async fn canceled_ask_releases_the_scope_for_a_later_question() {
        let features = Arc::new(InMemoryCompanionFeatures::new());
        let scope = DelegationScope {
            parent_connection_id: "parent".to_string(),
            parent_conversation_id: Uuid::new_v4(),
        };
        let first = tokio::spawn({
            let features = features.clone();
            let scope = scope.clone();
            async move {
                features
                    .ask(&scope, json!([{ "question": "First?" }]))
                    .await
            }
        });
        features.next_question(&scope).await;
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());

        let second = tokio::spawn({
            let features = features.clone();
            let scope = scope.clone();
            async move {
                features
                    .ask(&scope, json!([{ "question": "Second?" }]))
                    .await
            }
        });
        let pending = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            features.next_question(&scope),
        )
        .await
        .expect("canceled waiter must remove its pending question");
        features
            .answer_question(
                &pending.id,
                scope.parent_conversation_id,
                json!([{ "selected": ["yes"] }]),
            )
            .await
            .unwrap();
        assert_eq!(second.await.unwrap()["declined"], false);
    }

    #[tokio::test]
    async fn feedback_rejects_empty_and_oversized_notes() {
        let features = InMemoryCompanionFeatures::new();
        let scope = DelegationScope {
            parent_connection_id: "parent".to_string(),
            parent_conversation_id: Uuid::new_v4(),
        };
        assert_eq!(
            features.push_feedback(scope.clone(), "   ").await,
            Err(FeedbackError::Empty)
        );
        assert_eq!(
            features
                .push_feedback(scope, "x".repeat(MAX_FEEDBACK_CHARS + 1))
                .await,
            Err(FeedbackError::TooLong)
        );
    }

    #[tokio::test]
    async fn feedback_read_does_not_consume_until_commit() {
        let features = InMemoryCompanionFeatures::new();
        let scope = DelegationScope {
            parent_connection_id: "parent".to_string(),
            parent_conversation_id: Uuid::new_v4(),
        };
        let note = features
            .push_feedback(scope.clone(), "turn left")
            .await
            .unwrap();
        let first = features.feedback(&scope).await;
        let second = features.feedback(&scope).await;
        assert_eq!(first["count"], 1);
        assert_eq!(second["count"], 1);
        features.commit_feedback(&scope, &[note.id.clone()]).await;
        assert_eq!(features.feedback(&scope).await["count"], 0);
        assert_eq!(
            features.list_feedback(scope.parent_conversation_id).await[0].status,
            FeedbackStatus::Delivered
        );
        features
            .clear_conversation(scope.parent_conversation_id)
            .await;
        assert!(
            features
                .list_feedback(scope.parent_conversation_id)
                .await
                .is_empty()
        );
    }
}
