pub mod client;
pub mod harness;
pub mod normalize_logs;
pub mod provider;
pub mod session;
pub mod terminal;

use std::{fmt::Display, str::FromStr};

use agent_client_protocol::schema::{
    AvailableCommand, ContentBlock, Plan, RequestPermissionRequest, SessionModeId,
    SessionNotification, ToolCall, ToolCallUpdate,
};
pub use client::AcpClient;
pub use harness::AcpAgentHarness;
pub use normalize_logs::*;
pub use provider::*;
use serde::{Deserialize, Serialize};
pub use session::SessionManager;
pub use terminal::{AcpTerminalLifecycleEvent, acp_terminal_registry};
use workspace_utils::approvals::ApprovalStatus;

/// Parsed event types for internal processing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AcpEvent {
    User(String),
    SessionStart(String),
    Message(ContentBlock),
    Thought(ContentBlock),
    ToolCall(ToolCall),
    ToolUpdate(ToolCallUpdate),
    Plan(Plan),
    AvailableCommands(Vec<AvailableCommand>),
    CurrentMode(SessionModeId),
    RequestPermission(RequestPermissionRequest),
    ApprovalResponse(ApprovalResponse),
    Error(String),
    Done(String),
    Other(SessionNotification),
}

impl Display for AcpEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", serde_json::to_string(self).unwrap_or_default())
    }
}

impl FromStr for AcpEvent {
    type Err = serde_json::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        serde_json::from_str(s)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalResponse {
    pub tool_call_id: String,
    pub status: ApprovalStatus,
}
