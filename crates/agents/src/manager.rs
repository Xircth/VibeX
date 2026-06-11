use std::{collections::HashMap, path::PathBuf};

use tokio::sync::{Mutex, mpsc};

use crate::{
    AgentConnectionId, AgentContentBlock, AgentError, AgentPromptId, AgentResult, AgentSessionId,
    AgentType,
};

#[derive(Debug, Clone)]
pub struct AgentConnectionLaunch {
    pub connection_id: AgentConnectionId,
    pub agent_type: AgentType,
    pub working_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentConnectionCommand {
    Prompt {
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
    },
    Cancel {
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
    },
    RespondPermission {
        permission_id: String,
        option_id: String,
    },
    Disconnect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedAgentConnectionSnapshot {
    pub connection_id: AgentConnectionId,
    pub agent_type: AgentType,
    pub working_dir: PathBuf,
}

#[derive(Debug)]
struct ManagedAgentConnection {
    snapshot: ManagedAgentConnectionSnapshot,
    cmd_tx: mpsc::Sender<AgentConnectionCommand>,
}

#[derive(Debug, Default)]
pub struct AgentConnectionManager {
    connections: Mutex<HashMap<AgentConnectionId, ManagedAgentConnection>>,
}

impl AgentConnectionManager {
    pub async fn register_connection(
        &self,
        launch: AgentConnectionLaunch,
    ) -> ManagedAgentConnectionSnapshot {
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<AgentConnectionCommand>(32);
        let snapshot = ManagedAgentConnectionSnapshot {
            connection_id: launch.connection_id,
            agent_type: launch.agent_type,
            working_dir: launch.working_dir,
        };

        tokio::spawn(async move {
            while let Some(command) = cmd_rx.recv().await {
                if matches!(command, AgentConnectionCommand::Disconnect) {
                    break;
                }
            }
        });

        self.connections.lock().await.insert(
            snapshot.connection_id,
            ManagedAgentConnection {
                snapshot: snapshot.clone(),
                cmd_tx,
            },
        );

        snapshot
    }

    pub async fn send_prompt(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
        blocks: Vec<AgentContentBlock>,
    ) -> AgentResult<()> {
        self.send_command(
            connection_id,
            AgentConnectionCommand::Prompt {
                session_id,
                prompt_id,
                blocks,
            },
        )
        .await
    }

    pub async fn cancel_prompt(
        &self,
        connection_id: AgentConnectionId,
        session_id: AgentSessionId,
        prompt_id: AgentPromptId,
    ) -> AgentResult<()> {
        self.send_command(
            connection_id,
            AgentConnectionCommand::Cancel {
                session_id,
                prompt_id,
            },
        )
        .await
    }

    pub async fn disconnect(&self, connection_id: AgentConnectionId) -> AgentResult<()> {
        let connection = self.connections.lock().await.remove(&connection_id);
        let Some(connection) = connection else {
            return Err(AgentError::ConnectionNotFound(connection_id.to_string()));
        };

        connection
            .cmd_tx
            .send(AgentConnectionCommand::Disconnect)
            .await
            .map_err(|_| AgentError::Runtime("agent connection command channel closed".into()))
    }

    pub async fn list_connections(&self) -> Vec<ManagedAgentConnectionSnapshot> {
        self.connections
            .lock()
            .await
            .values()
            .map(|connection| connection.snapshot.clone())
            .collect()
    }

    async fn send_command(
        &self,
        connection_id: AgentConnectionId,
        command: AgentConnectionCommand,
    ) -> AgentResult<()> {
        let cmd_tx = {
            let connections = self.connections.lock().await;
            connections
                .get(&connection_id)
                .map(|connection| connection.cmd_tx.clone())
        }
        .ok_or_else(|| AgentError::ConnectionNotFound(connection_id.to_string()))?;

        cmd_tx
            .send(command)
            .await
            .map_err(|_| AgentError::Runtime("agent connection command channel closed".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn manager_registers_and_removes_connection() {
        let manager = AgentConnectionManager::default();
        let connection_id = AgentConnectionId::new();

        manager
            .register_connection(AgentConnectionLaunch {
                connection_id,
                agent_type: AgentType::Codex,
                working_dir: PathBuf::from("C:/work"),
            })
            .await;

        assert_eq!(manager.list_connections().await.len(), 1);
        manager.disconnect(connection_id).await.unwrap();
        assert!(manager.list_connections().await.is_empty());
    }

    #[tokio::test]
    async fn manager_rejects_unknown_prompt_connection() {
        let err = AgentConnectionManager::default()
            .send_prompt(
                AgentConnectionId::new(),
                AgentSessionId::new(),
                AgentPromptId::new(),
                vec![AgentContentBlock::Text {
                    text: "hello".to_string(),
                }],
            )
            .await
            .unwrap_err();

        assert!(matches!(err, AgentError::ConnectionNotFound(_)));
    }
}
