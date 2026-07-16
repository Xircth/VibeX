use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent_kind::AgentKind;

/// One executable in the local Agent runtime pair that VibeX has inspected.
/// Paths are the actual resolved launch paths, never an inferred package name.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentRuntimeComponentInfo {
    pub path: Option<String>,
    pub version: Option<String>,
    pub minimum_supported_version: Option<String>,
    pub supported: bool,
}

/// The exact local CLI and ACP bridge VibeX will use for an Agent session.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LocalAgentRuntimeInfo {
    pub cli: AgentRuntimeComponentInfo,
    pub acp: AgentRuntimeComponentInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSettingInfo {
    pub id: i64,
    /// Typed identity (canonical key on the wire) so registry↔setting joins
    /// can never diverge on spelling again.
    pub agent_type: AgentKind,
    pub enabled: bool,
    pub sort_order: i32,
    pub installed_version: Option<String>,
    pub env_json: Option<String>,
    pub config_json: Option<String>,
    pub auto_approve_mode: String,
    /// Verified local presence (login/config marker, PATH binary, or global
    /// npm package). Never inferred from the distribution kind.
    pub installed: bool,
    /// The distribution's runtime prerequisites (node/uv) are satisfied on
    /// this machine, so an install action can succeed.
    pub runtime_ok: bool,
    /// Actual local CLI/ACP paths and versions when this Agent has a managed
    /// local runtime contract. Kept optional for non-local runtimes and
    /// backwards-compatible desktop/frontend upgrades.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub local_runtime: Option<LocalAgentRuntimeInfo>,
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
    pub agent_type: AgentKind,
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
    /// Agent identities in the desired order
    pub order: Vec<AgentKind>,
}
