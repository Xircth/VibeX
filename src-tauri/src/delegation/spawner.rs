//! `ConnectionSpawner` over `AgentRuntime` + the `Session` model.
//!
//! `spawn` establishes a child agent connection; `send_prompt_linked` creates
//! the linked child `sessions` row, registers it for the resolver, and sends the
//! delegation task as the child's first prompt. The child's `external_session_id`
//! + `agent_type` are auto-bound later by the runtime's `SessionLinked` event.

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use agents::{
    AgentId,
    events::AgentContentBlock,
    ids::{AgentConnectionId, AgentSessionId},
    runtime::{AgentRuntime, CancelAgentPromptInput, ConnectAgentInput, SendAgentPromptInput},
};
use async_trait::async_trait;
use conversations::{CreateDelegatedConversation, create_delegated_conversation};
use delegation::{ConnectionSpawner, DelegationLink, SpawnerError};
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use uuid::Uuid;

/// Shared map `child sessions.id → (delegation call_id, agent_type)` the resolver
/// consults to route a finished child turn back to the broker.
pub(crate) type ResolverMap = Arc<Mutex<HashMap<Uuid, (String, AgentId)>>>;

pub(crate) struct RuntimeSpawner {
    pub runtime: Arc<AgentRuntime>,
    pub pool: SqlitePool,
    pub map: ResolverMap,
}

#[async_trait]
impl ConnectionSpawner for RuntimeSpawner {
    async fn spawn(
        &self,
        parent_connection_id: &str,
        agent_type: AgentId,
        working_dir: Option<String>,
    ) -> Result<String, SpawnerError> {
        let parent = AgentConnectionId::from(
            Uuid::parse_str(parent_connection_id)
                .map_err(|e| SpawnerError::Spawn(e.to_string()))?,
        );
        let snapshot = self.runtime.snapshot().await;
        let parent_conn = snapshot
            .connections
            .iter()
            .find(|conn| conn.id == parent)
            .ok_or_else(|| SpawnerError::Spawn("parent connection not found".to_string()))?;
        let working_dir = working_dir
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&parent_conn.working_dir));
        let launch = crate::commands::agents::agent_runtime_launch_settings_from_pool(
            &self.pool,
            &agent_type,
        )
        .await
        .map_err(|e| SpawnerError::Spawn(e.to_string()))?;
        let child = self
            .runtime
            .connect(ConnectAgentInput {
                agent_id: agent_type,
                launch_lock: launch.launch_lock,
                workspace_id: parent_conn.workspace_id,
                working_dir,
                auto_approve_mode: launch.auto_approve_mode,
                env: launch.env,
            })
            .await
            .map_err(|e| SpawnerError::Spawn(e.to_string()))?;
        Ok(child.id.0.to_string())
    }

    async fn send_prompt_linked(
        &self,
        child_connection_id: &str,
        task: String,
        link: DelegationLink,
    ) -> Result<Uuid, SpawnerError> {
        let conn = AgentConnectionId::from(
            Uuid::parse_str(child_connection_id).map_err(|e| SpawnerError::Other(e.to_string()))?,
        );
        let child_id = Uuid::new_v4();
        create_delegated_conversation(
            &self.pool,
            CreateDelegatedConversation {
                id: child_id,
                parent_conversation_id: link.parent_session_id,
                parent_tool_call_id: link.parent_tool_use_id.clone(),
                delegation_id: link.delegation_call_id.clone(),
                agent_id: link.agent_type.clone(),
                prompt: task.clone(),
            },
        )
        .await
        .map_err(|e| SpawnerError::SendPrompt(e.to_string()))?;

        let session_id = AgentSessionId::from(child_id);
        self.runtime
            .new_session_with_id(conn, session_id, child_id.to_string())
            .await
            .map_err(|e| SpawnerError::SendPrompt(e.to_string()))?;
        self.map
            .lock()
            .await
            .insert(child_id, (link.delegation_call_id.clone(), link.agent_type));
        self.runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: conn,
                session_id,
                blocks: vec![AgentContentBlock::Text { text: task }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .map_err(|e| SpawnerError::SendPrompt(e.to_string()))?;
        Ok(child_id)
    }

    async fn cancel(&self, child_connection_id: &str) -> Result<(), SpawnerError> {
        let conn = AgentConnectionId::from(
            Uuid::parse_str(child_connection_id).map_err(|e| SpawnerError::Other(e.to_string()))?,
        );
        let snapshot = self.runtime.snapshot().await;
        if let Some(session) = snapshot.sessions.iter().find(|s| s.connection_id == conn)
            && let Some(prompt_id) = session.active_prompt_id
        {
            let _ = self
                .runtime
                .cancel_prompt(CancelAgentPromptInput {
                    connection_id: conn,
                    session_id: session.id,
                    prompt_id,
                })
                .await;
        }
        Ok(())
    }

    async fn disconnect(&self, child_connection_id: &str) -> Result<(), SpawnerError> {
        let conn = AgentConnectionId::from(
            Uuid::parse_str(child_connection_id).map_err(|e| SpawnerError::Other(e.to_string()))?,
        );
        let _ = self.runtime.disconnect(conn).await;
        Ok(())
    }
}
