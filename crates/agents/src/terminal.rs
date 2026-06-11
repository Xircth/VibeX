use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::{AgentSessionId, AgentTerminalId};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentTerminalCreateRequest {
    pub session_id: AgentSessionId,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_byte_limit: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentTerminalOutputSnapshot {
    pub terminal_id: AgentTerminalId,
    pub output: String,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<AgentTerminalExit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentTerminalExit {
    Code { code: i32 },
    Signal { signal: String },
    Unknown,
}

