use async_trait::async_trait;
use thiserror::Error;

use crate::filesystem::{AgentFileReadRequest, AgentFileWriteRequest};
use crate::ids::{AgentPermissionId, AgentTerminalId};
use crate::permissions::{AgentPermissionRequest, AgentPermissionResponse};
use crate::terminal::{
    AgentTerminalCreateRequest, AgentTerminalExit, AgentTerminalOutputSnapshot,
};

#[derive(Debug, Error)]
pub enum HostRequestError {
    #[error("host request is unsupported: {0}")]
    Unsupported(&'static str),
    #[error("host request failed: {0}")]
    Failed(String),
}

#[async_trait]
pub trait AgentHost: Send + Sync + 'static {
    async fn request_permission(
        &self,
        request: AgentPermissionRequest,
    ) -> Result<AgentPermissionResponse, HostRequestError>;

    async fn create_terminal(
        &self,
        request: AgentTerminalCreateRequest,
    ) -> Result<AgentTerminalId, HostRequestError>;

    async fn terminal_output(
        &self,
        terminal_id: AgentTerminalId,
    ) -> Result<AgentTerminalOutputSnapshot, HostRequestError>;

    async fn wait_terminal_exit(
        &self,
        terminal_id: AgentTerminalId,
    ) -> Result<Option<AgentTerminalExit>, HostRequestError>;

    async fn kill_terminal(
        &self,
        terminal_id: AgentTerminalId,
    ) -> Result<(), HostRequestError>;

    async fn read_text_file(
        &self,
        request: AgentFileReadRequest,
    ) -> Result<String, HostRequestError>;

    async fn write_text_file(
        &self,
        request: AgentFileWriteRequest,
    ) -> Result<(), HostRequestError>;

    async fn respond_permission(
        &self,
        permission_id: AgentPermissionId,
        response: AgentPermissionResponse,
    ) -> Result<(), HostRequestError>;
}

