//! The broker's gateway to the agent runtime. Implemented in `src-tauri` over
//! `AgentRuntime` + the DB; mocked in broker unit tests.

use agents::AgentId;
use async_trait::async_trait;
use uuid::Uuid;

use crate::types::DelegationLink;

#[derive(Debug, thiserror::Error)]
pub enum SpawnerError {
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("send prompt failed: {0}")]
    SendPrompt(String),
    #[error("send prompt failed after linking child {child_session_id}: {message}")]
    SendPromptAfterLink {
        child_session_id: Uuid,
        message: String,
    },
    #[error("parent session is gone")]
    ParentGone,
    #[error("{0}")]
    Other(String),
}

impl SpawnerError {
    /// Durable child identity, when setup progressed far enough that the broker
    /// must emit a terminal lifecycle instead of treating the call as absent.
    pub fn linked_child_session_id(&self) -> Option<Uuid> {
        match self {
            Self::SendPromptAfterLink {
                child_session_id, ..
            } => Some(*child_session_id),
            Self::Spawn(_) | Self::SendPrompt(_) | Self::ParentGone | Self::Other(_) => None,
        }
    }
}

/// Spawns and drives child ACP sessions for a `delegate_to_agent` call.
#[async_trait]
pub trait ConnectionSpawner: Send + Sync {
    /// Spawn a fresh child ACP connection of `agent_type` in `working_dir`,
    /// inheriting the parent connection's workspace. Returns the child's VibeX
    /// connection id (used later for cancel/disconnect) — NOT the ACP session id.
    async fn spawn(
        &self,
        parent_connection_id: &str,
        agent_type: AgentId,
        working_dir: Option<String>,
    ) -> Result<String, SpawnerError>;

    /// Persist the child conversation before the agent process is ready so the
    /// parent card can open the transcript immediately.
    async fn create_child_conversation(
        &self,
        child_session_id: Uuid,
        task: &str,
        link: &DelegationLink,
    ) -> Result<Uuid, SpawnerError>;

    /// Create the child `sessions` row (linked to its parent via `link`), send
    /// the delegation `task` as its first prompt, and return the child
    /// `sessions.id`.
    async fn send_prompt_linked(
        &self,
        child_connection_id: &str,
        child_session_id: Uuid,
        task: String,
        link: DelegationLink,
    ) -> Result<Uuid, SpawnerError>;

    /// Interrupt any in-flight prompt on the child. Idempotent.
    async fn cancel(&self, child_connection_id: &str) -> Result<(), SpawnerError>;

    /// Release resolver correlation for a child that the broker has already
    /// made terminal. Idempotent.
    async fn release_child(&self, child_session_id: Uuid) -> Result<(), SpawnerError>;

    /// Tear down the child connection (one-shot v1: always after resolution).
    async fn disconnect(&self, child_connection_id: &str) -> Result<(), SpawnerError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::MockSpawner;

    #[tokio::test]
    async fn mock_spawner_records_spawn_and_returns_handle() {
        let spawner = MockSpawner::new();
        let handle = spawner
            .spawn(
                "parent-conn",
                AgentId::parse("codex").unwrap(),
                Some("/tmp".to_string()),
            )
            .await
            .expect("spawn");
        assert_eq!(handle, "child-conn");

        let calls = spawner.calls.lock().unwrap();
        assert_eq!(calls.spawned.len(), 1);
        assert_eq!(calls.spawned[0].0, "parent-conn");
        assert_eq!(calls.spawned[0].1, AgentId::parse("codex").unwrap());
        assert_eq!(calls.spawned[0].2.as_deref(), Some("/tmp"));
    }

    #[tokio::test]
    async fn mock_spawner_surfaces_configured_spawn_error() {
        let mut spawner = MockSpawner::new();
        spawner.spawn_error = Some("boom".to_string());
        let err = spawner
            .spawn("parent-conn", AgentId::parse("claude_code").unwrap(), None)
            .await
            .expect_err("should fail");
        assert!(matches!(err, SpawnerError::Spawn(_)));
    }
}
