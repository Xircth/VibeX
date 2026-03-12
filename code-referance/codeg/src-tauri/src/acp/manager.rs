use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::acp::connection::{spawn_agent_connection, AgentConnection, ConnectionCommand};
use crate::acp::error::AcpError;
use crate::acp::types::{ConnectionInfo, PromptInputBlock};
use crate::models::agent::AgentType;

pub struct ConnectionManager {
    connections: Arc<Mutex<HashMap<String, AgentConnection>>>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn spawn_agent(
        &self,
        agent_type: AgentType,
        working_dir: Option<String>,
        session_id: Option<String>,
        runtime_env: BTreeMap<String, String>,
        owner_window_label: String,
        app_handle: tauri::AppHandle,
    ) -> Result<String, AcpError> {
        let connection_id = uuid::Uuid::new_v4().to_string();
        eprintln!(
            "[ACP] spawning connection id={} owner_window={} agent={:?}",
            connection_id, owner_window_label, agent_type
        );

        let conn = spawn_agent_connection(
            connection_id.clone(),
            agent_type,
            working_dir,
            session_id,
            runtime_env,
            owner_window_label,
            app_handle,
        )
        .await?;

        self.connections
            .lock()
            .await
            .insert(connection_id.clone(), conn);

        Ok(connection_id)
    }

    pub async fn send_prompt(
        &self,
        conn_id: &str,
        blocks: Vec<PromptInputBlock>,
    ) -> Result<(), AcpError> {
        let cmd_tx = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
            conn.cmd_tx.clone()
        };
        cmd_tx
            .send(ConnectionCommand::Prompt { blocks })
            .await
            .map_err(|_| AcpError::ProcessExited)
    }

    pub async fn set_mode(&self, conn_id: &str, mode_id: String) -> Result<(), AcpError> {
        let cmd_tx = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
            conn.cmd_tx.clone()
        };
        cmd_tx
            .send(ConnectionCommand::SetMode { mode_id })
            .await
            .map_err(|_| AcpError::ProcessExited)
    }

    pub async fn set_config_option(
        &self,
        conn_id: &str,
        config_id: String,
        value_id: String,
    ) -> Result<(), AcpError> {
        let cmd_tx = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
            conn.cmd_tx.clone()
        };
        cmd_tx
            .send(ConnectionCommand::SetConfigOption {
                config_id,
                value_id,
            })
            .await
            .map_err(|_| AcpError::ProcessExited)
    }

    pub async fn cancel(&self, conn_id: &str) -> Result<(), AcpError> {
        let cmd_tx = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
            conn.cmd_tx.clone()
        };
        cmd_tx
            .send(ConnectionCommand::Cancel)
            .await
            .map_err(|_| AcpError::ProcessExited)
    }

    pub async fn respond_permission(
        &self,
        conn_id: &str,
        request_id: &str,
        option_id: &str,
    ) -> Result<(), AcpError> {
        let cmd_tx = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
            conn.cmd_tx.clone()
        };
        cmd_tx
            .send(ConnectionCommand::RespondPermission {
                request_id: request_id.into(),
                option_id: option_id.into(),
            })
            .await
            .map_err(|_| AcpError::ProcessExited)
    }

    pub async fn disconnect(&self, conn_id: &str) -> Result<(), AcpError> {
        let cmd_tx = {
            let mut connections = self.connections.lock().await;
            connections.remove(conn_id).map(|conn| conn.cmd_tx)
        };
        if let Some(cmd_tx) = cmd_tx {
            let _ = cmd_tx.send(ConnectionCommand::Disconnect).await;
            Ok(())
        } else {
            Err(AcpError::ConnectionNotFound(conn_id.into()))
        }
    }

    pub async fn disconnect_by_owner_window(&self, owner_window_label: &str) -> usize {
        let cmd_txs = {
            let mut connections = self.connections.lock().await;
            let ids: Vec<String> = connections
                .iter()
                .filter_map(|(id, conn)| {
                    if conn.owner_window_label == owner_window_label {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect();

            let mut txs = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(conn) = connections.remove(&id) {
                    txs.push(conn.cmd_tx);
                }
            }
            txs
        };

        let disconnected = cmd_txs.len();
        for cmd_tx in cmd_txs {
            let _ = cmd_tx.send(ConnectionCommand::Disconnect).await;
        }
        eprintln!(
            "[ACP] disconnect by owner window owner_window={} count={}",
            owner_window_label, disconnected
        );
        disconnected
    }

    pub async fn disconnect_all(&self) -> usize {
        let cmd_txs: Vec<_> = {
            let mut connections = self.connections.lock().await;
            connections
                .drain()
                .map(|(_, conn)| conn.cmd_tx)
                .collect()
        };
        let disconnected = cmd_txs.len();
        for cmd_tx in cmd_txs {
            let _ = cmd_tx.send(ConnectionCommand::Disconnect).await;
        }
        eprintln!("[ACP] disconnect_all count={}", disconnected);
        disconnected
    }

    pub async fn list_connections(&self) -> Vec<ConnectionInfo> {
        let connections = self.connections.lock().await;
        connections.values().map(|c| c.info()).collect()
    }
}
