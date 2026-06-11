use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::AgentSessionId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentFileReadRequest {
    pub session_id: AgentSessionId,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentFileWriteRequest {
    pub session_id: AgentSessionId,
    pub path: String,
    pub content: String,
}
