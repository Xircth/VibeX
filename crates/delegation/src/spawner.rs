//! The broker's gateway to the agent runtime. Implemented in `src-tauri` over
//! `AgentRuntime` + the DB; mocked in broker unit tests.

use agents::registry::AgentKind;
use async_trait::async_trait;
use uuid::Uuid;

use crate::types::DelegationLink;

#[derive(Debug, thiserror::Error)]
pub enum SpawnerError {
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("send prompt failed: {0}")]
    SendPrompt(String),
    #[error("parent session is gone")]
    ParentGone,
    #[error("{0}")]
    Other(String),
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
        agent_type: AgentKind,
        working_dir: Option<String>,
    ) -> Result<String, SpawnerError>;

    /// Create the child `sessions` row (linked to its parent via `link`), send
    /// the delegation `task` as its first prompt, and return the child
    /// `sessions.id`.
    async fn send_prompt_linked(
        &self,
        child_connection_id: &str,
        task: String,
        link: DelegationLink,
    ) -> Result<Uuid, SpawnerError>;

    /// Interrupt any in-flight prompt on the child. Idempotent.
    async fn cancel(&self, child_connection_id: &str) -> Result<(), SpawnerError>;

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
            .spawn("parent-conn", AgentKind::Codex, Some("/tmp".to_string()))
            .await
            .expect("spawn");
        assert_eq!(handle, "child-conn");

        let calls = spawner.calls.lock().unwrap();
        assert_eq!(calls.spawned.len(), 1);
        assert_eq!(calls.spawned[0].0, "parent-conn");
        assert_eq!(calls.spawned[0].1, AgentKind::Codex);
        assert_eq!(calls.spawned[0].2.as_deref(), Some("/tmp"));
    }

    #[tokio::test]
    async fn mock_spawner_surfaces_configured_spawn_error() {
        let mut spawner = MockSpawner::new();
        spawner.spawn_error = Some("boom".to_string());
        let err = spawner
            .spawn("parent-conn", AgentKind::ClaudeCode, None)
            .await
            .expect_err("should fail");
        assert!(matches!(err, SpawnerError::Spawn(_)));
    }
}
