use std::sync::Arc;

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use db::models::scratch::{DraftFollowUpData, Scratch, ScratchPayload};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// Represents a queued follow-up message for a session
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct QueuedMessage {
    /// The session this message is queued for
    pub session_id: Uuid,
    /// The follow-up data (message + variant)
    pub data: DraftFollowUpData,
    /// Timestamp when the message was queued
    pub queued_at: DateTime<Utc>,
}

/// Status of the queue for a session (for frontend display)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(export)]
pub enum QueueStatus {
    /// No message queued
    Empty,
    /// Message is queued and waiting for execution to complete
    Queued { message: QueuedMessage },
}

/// In-memory service for managing queued follow-up messages.
/// One queued message per session.
#[derive(Clone)]
pub struct QueuedMessageService {
    queue: Arc<DashMap<Uuid, QueuedMessage>>,
}

impl QueuedMessageService {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(DashMap::new()),
        }
    }

    /// Queue a message for a session. Replaces any existing queued message.
    pub fn queue_message(&self, session_id: Uuid, data: DraftFollowUpData) -> QueuedMessage {
        let queued = QueuedMessage {
            session_id,
            data,
            queued_at: Utc::now(),
        };
        self.insert_restored(queued.clone());
        queued
    }

    /// Restore a queued message with an existing timestamp.
    pub fn insert_restored(&self, queued: QueuedMessage) {
        self.queue.insert(queued.session_id, queued);
    }

    /// Restore all queued follow-ups from scratch records.
    pub fn restore_from_scratches(&self, scratches: &[Scratch]) {
        self.queue.clear();

        for scratch in scratches {
            let ScratchPayload::DraftFollowUp(data) = &scratch.payload else {
                continue;
            };
            if !data.queued {
                continue;
            }

            self.insert_restored(QueuedMessage {
                session_id: scratch.id,
                data: data.clone(),
                queued_at: scratch.updated_at,
            });
        }
    }

    /// Cancel/remove a queued message for a session
    pub fn cancel_queued(&self, session_id: Uuid) -> Option<QueuedMessage> {
        self.queue.remove(&session_id).map(|(_, v)| v)
    }

    /// Get the queued message for a session (if any)
    pub fn get_queued(&self, session_id: Uuid) -> Option<QueuedMessage> {
        self.queue.get(&session_id).map(|r| r.clone())
    }

    /// Take (remove and return) the queued message for a session.
    /// Used by finalization flow to consume the queued message.
    pub fn take_queued(&self, session_id: Uuid) -> Option<QueuedMessage> {
        self.queue.remove(&session_id).map(|(_, v)| v)
    }

    /// Check if a session has a queued message
    pub fn has_queued(&self, session_id: Uuid) -> bool {
        self.queue.contains_key(&session_id)
    }

    /// Get queue status for frontend display
    pub fn get_status(&self, session_id: Uuid) -> QueueStatus {
        match self.get_queued(session_id) {
            Some(msg) => QueueStatus::Queued { message: msg },
            None => QueueStatus::Empty,
        }
    }
}

impl Default for QueuedMessageService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use db::models::scratch::{DraftWorkspaceData, ScratchPayload};

    use super::*;

    #[test]
    fn restore_from_scratches_only_loads_followups() {
        let service = QueuedMessageService::new();
        let followup_session = Uuid::new_v4();
        let other_session = Uuid::new_v4();
        let queued_at = Utc::now();

        let scratches = vec![
            Scratch {
                id: followup_session,
                payload: ScratchPayload::DraftFollowUp(DraftFollowUpData {
                    message: "resume me".to_string(),
                    images: vec![".vibe-images/queued.png".to_string()],
                    executor_config: executors::profile::ExecutorConfig::from(
                        executors::profile::ExecutorProfileId::new(
                            executors::executors::BaseCodingAgent::Codex,
                        ),
                    ),
                    queued: true,
                }),
                created_at: queued_at,
                updated_at: queued_at,
            },
            Scratch {
                id: other_session,
                payload: ScratchPayload::DraftWorkspace(DraftWorkspaceData {
                    message: "ignore me".to_string(),
                    project_id: None,
                    repos: vec![],
                    selected_profile: None,
                    linked_issue: None,
                }),
                created_at: queued_at,
                updated_at: queued_at,
            },
        ];

        service.restore_from_scratches(&scratches);

        let restored = service
            .get_queued(followup_session)
            .expect("follow-up restored");
        assert_eq!(restored.data.message, "resume me");
        assert_eq!(restored.data.images, vec![".vibe-images/queued.png"]);
        assert_eq!(restored.queued_at, queued_at);
        assert!(service.get_queued(other_session).is_none());
    }
}
