use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::ids::{AgentConnectionId, AgentPromptId, AgentSessionId};
use crate::registry::AgentType;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentConnectionStatus {
    Disconnected,
    Connecting,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentSessionStatus {
    Creating,
    Ready,
    Running,
    Cancelling,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentPromptStatus {
    Queued,
    Running,
    Cancelling,
    Completed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
    },
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentConnectionSnapshot {
    pub id: AgentConnectionId,
    pub agent_type: AgentType,
    pub workspace_id: Uuid,
    pub status: AgentConnectionStatus,
    pub working_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSessionSnapshot {
    pub id: AgentSessionId,
    pub connection_id: AgentConnectionId,
    pub acp_session_id: String,
    pub status: AgentSessionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_prompt_id: Option<AgentPromptId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub queued_prompt_ids: Vec<AgentPromptId>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPromptSnapshot {
    pub id: AgentPromptId,
    pub session_id: AgentSessionId,
    pub status: AgentPromptStatus,
    pub text_preview: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_status_preserves_completion_reason() {
        let status = AgentPromptStatus::Completed {
            stop_reason: Some("end_turn".to_string()),
        };

        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["kind"], "completed");
        assert_eq!(json["stop_reason"], "end_turn");
    }
}

