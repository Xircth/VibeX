use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::{AgentPermissionId, AgentSessionId};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPermissionOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPermissionRequest {
    pub id: AgentPermissionId,
    pub session_id: AgentSessionId,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    pub options: Vec<AgentPermissionOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentPermissionResponse {
    Selected { option_id: String },
    Cancelled,
}
