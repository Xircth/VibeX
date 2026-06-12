use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSettingInfo {
    pub id: i64,
    pub agent_type: String,
    pub enabled: bool,
    pub sort_order: i32,
    pub installed_version: Option<String>,
    pub env_json: Option<String>,
    pub config_json: Option<String>,
    pub auto_approve_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PreflightResult {
    pub checks: Vec<PreflightCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PreflightCheck {
    pub check_id: String,
    pub label: String,
    pub status: PreflightStatus,
    pub message: String,
    pub fixes: Vec<PreflightFix>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PreflightFix {
    pub action: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum PreflightStatus {
    Pass,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct UpdateAgentPreferences {
    pub agent_type: String,
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[ts(optional)]
    pub env_json: Option<String>,
    #[ts(optional)]
    pub config_json: Option<String>,
    #[ts(optional)]
    pub auto_approve_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct ReorderAgentsRequest {
    /// List of agent_type strings in the desired order
    pub order: Vec<String>,
}
