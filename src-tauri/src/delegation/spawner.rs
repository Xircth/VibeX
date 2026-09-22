//! `ConnectionSpawner` over the conversation control plane.
//!
//! Child identity is persisted first. `spawn` then binds ACP through
//! `ensure_session_controls`; `send_prompt_linked` starts the first turn
//! through `start_turn`. Cancel uses the same `cancel_turn` path as a
//! user-owned conversation.

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use agents::{
    AgentId, AgentSessionConfigOverride,
    ids::{AgentConnectionId, AgentSessionId},
    runtime::AgentRuntime,
};
use async_trait::async_trait;
use conversations::{
    ConversationContext, ConversationSessionService, CreateDelegatedConversation,
    create_delegated_conversation,
};
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
    pub context: ConversationContext,
    pub map: ResolverMap,
}

#[async_trait]
impl ConnectionSpawner for RuntimeSpawner {
    async fn spawn(
        &self,
        parent_connection_id: &str,
        _agent_type: AgentId,
        working_dir: Option<String>,
        child_session_id: Uuid,
    ) -> Result<String, SpawnerError> {
        let parent = AgentConnectionId::from(
            Uuid::parse_str(parent_connection_id)
                .map_err(|e| SpawnerError::Spawn(e.to_string()))?,
        );
        let snapshot = self.runtime.snapshot().await;
        if !snapshot.connections.iter().any(|conn| conn.id == parent) {
            return Err(SpawnerError::Spawn(
                "parent connection not found".to_string(),
            ));
        }
        let service = ConversationSessionService::new(self.context.clone());
        service
            .ensure_session_controls_with_working_dir(
                child_session_id,
                working_dir.map(PathBuf::from),
            )
            .await
            .map_err(|e| SpawnerError::Spawn(e.to_string()))?;
        self.runtime
            .live_connection_id(AgentSessionId::from(child_session_id))
            .await
            .map(|id| id.to_string())
            .ok_or_else(|| SpawnerError::Spawn("child ACP session is not bound".to_string()))
    }

    async fn create_child_conversation(
        &self,
        child_session_id: Uuid,
        task: &str,
        link: &DelegationLink,
    ) -> Result<Uuid, SpawnerError> {
        let child_id = child_session_id;
        create_delegated_conversation(
            &self.pool,
            CreateDelegatedConversation {
                id: child_id,
                parent_conversation_id: link.parent_session_id,
                parent_tool_call_id: link.parent_tool_use_id.clone(),
                delegation_id: link.delegation_call_id.clone(),
                agent_id: link.agent_type.clone(),
                prompt: task.to_string(),
                policy: serde_json::to_value(&link.policy)
                    .map_err(|error| SpawnerError::SendPrompt(error.to_string()))?,
            },
        )
        .await
        .map_err(|e| SpawnerError::SendPrompt(e.to_string()))?;
        Ok(child_id)
    }

    async fn send_prompt_linked(
        &self,
        _child_connection_id: &str,
        child_session_id: Uuid,
        task: String,
        link: DelegationLink,
    ) -> Result<Uuid, SpawnerError> {
        let child_id = child_session_id;
        let config_overrides = link
            .preferred_config_values
            .into_iter()
            .map(|(key, value)| AgentSessionConfigOverride { key, value })
            .collect();
        self.map.lock().await.insert(
            child_id,
            (link.delegation_call_id.clone(), link.agent_type.clone()),
        );
        let service = ConversationSessionService::new(self.context.clone());
        if let Err(error) = service
            .start_delegated_turn(child_id, task, link.preferred_mode_id, config_overrides)
            .await
        {
            self.map.lock().await.remove(&child_id);
            return Err(SpawnerError::SendPromptAfterLink {
                child_session_id: child_id,
                message: error.to_string(),
            });
        }
        Ok(child_id)
    }

    async fn cancel(&self, child_connection_id: &str) -> Result<(), SpawnerError> {
        let conn = AgentConnectionId::from(
            Uuid::parse_str(child_connection_id).map_err(|e| SpawnerError::Other(e.to_string()))?,
        );
        let snapshot = self.runtime.snapshot().await;
        if let Some(session) = snapshot.sessions.iter().find(|s| s.connection_id == conn) {
            let service = ConversationSessionService::new(self.context.clone());
            let _ = service
                .cancel_turn(session.id.0, Some("canceled by MCP client".to_string()))
                .await;
        }
        Ok(())
    }

    async fn release_child(&self, child_session_id: Uuid) -> Result<(), SpawnerError> {
        self.map.lock().await.remove(&child_session_id);
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
