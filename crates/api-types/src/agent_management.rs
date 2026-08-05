use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AgentId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentSource {
    BuiltInProfile,
    OfficialRegistry,
    UserDefinition,
    RetiredLegacy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum UserAgentDistributionKind {
    Binary,
    Npx,
    Uvx,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UserAgentDefinitionRequest {
    pub agent_id: AgentId,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub distribution_kind: UserAgentDistributionKind,
    pub distribution_json: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum UserAgentIntegrityKind {
    Sha256,
    TrustOnFirstUse,
    EcosystemLock,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UserAgentEnvironmentVariableView {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UserAgentDistributionView {
    pub kind: UserAgentDistributionKind,
    pub platform: String,
    pub platform_supported: bool,
    pub package: Option<String>,
    pub archive_url: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    pub environment: Vec<UserAgentEnvironmentVariableView>,
    pub sha256: Option<String>,
    pub integrity: UserAgentIntegrityKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UserAgentDefinitionView {
    pub agent_id: AgentId,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub distribution_json: String,
    pub distribution: UserAgentDistributionView,
    pub definition_sha256: String,
    pub installed_definition_sha256: Option<String>,
    pub reinstall_required: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentLifecycleState {
    Retired,
    PlatformUnsupported,
    Queued,
    Installing,
    Updating,
    Repairing,
    NeedsRepair,
    NeedsAuth,
    NeedsConfig,
    Ready,
    Uninstalled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentAuthenticationStatus {
    Account,
    ApiKey,
    NotLoggedIn,
    MultipleUnknown,
    NotRequired,
}

/// Minimal wire identity used while the open management API is introduced.
///
/// Rich catalog, installation, capability, and diagnostic projections build on
/// these independent facts rather than collapsing them into one legacy boolean.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentManagementIdentity {
    pub agent_id: AgentId,
    pub source: AgentSource,
    pub lifecycle: AgentLifecycleState,
    pub authentication: AgentAuthenticationStatus,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentOperationKind {
    Install,
    Update,
    Repair,
    Rollback,
    Uninstall,
    Remove,
    Check,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentOperationStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentManagementView {
    pub agent_id: AgentId,
    pub display_name: String,
    pub description: String,
    pub icon_light: Option<String>,
    pub icon_dark: Option<String>,
    pub icon_svg: Option<String>,
    pub source: AgentSource,
    pub built_in: bool,
    pub retired: bool,
    pub enabled: bool,
    pub position: u32,
    pub lifecycle: AgentLifecycleState,
    pub authentication: AgentAuthenticationStatus,
    pub runtime_version: Option<String>,
    pub acp_version: Option<String>,
    pub active_operation: Option<AgentOperationKind>,
    pub rollback_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentRegistryViewRow {
    pub agent_id: AgentId,
    pub registry_id: Option<String>,
    pub display_name: String,
    pub description: String,
    #[serde(default)]
    pub authors: Vec<String>,
    pub version: String,
    pub icon_light: Option<String>,
    pub icon_dark: Option<String>,
    pub icon_svg: Option<String>,
    pub built_in: bool,
    pub added: bool,
    pub installed: bool,
    pub platform_supported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentUpdateCheckView {
    pub agent_id: AgentId,
    pub current_version: Option<String>,
    pub available_version: Option<String>,
    pub update_available: bool,
    pub snapshot_id: Option<String>,
    pub fetched_at: Option<String>,
    pub fresh: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentRegistryView {
    pub current_platform: String,
    pub snapshot_id: Option<String>,
    pub fetched_at: Option<String>,
    pub fresh: bool,
    pub refresh_error: Option<String>,
    pub installed: Vec<AgentRegistryViewRow>,
    pub uninstalled: Vec<AgentRegistryViewRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentOperationEvent {
    pub sequence: u32,
    pub agent_id: AgentId,
    pub operation_id: String,
    pub kind: AgentOperationKind,
    pub status: AgentOperationStatus,
    pub progress_percent: Option<u8>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentManagementErrorCode {
    NotFound,
    InvalidState,
    Busy,
    RegistryUnavailable,
    PlatformUnsupported,
    ConfigConflict,
    IntegrityFailure,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentManagementErrorView {
    pub code: AgentManagementErrorCode,
    pub message: String,
    pub agent_id: Option<AgentId>,
    pub preflight_item_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPreflightItemView {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
    pub version: Option<String>,
    pub path: Option<String>,
    pub repairable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPreflightView {
    pub agent_id: AgentId,
    pub checked_at: String,
    pub items: Vec<AgentPreflightItemView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentNativeConfigOptionView {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentNativeConfigFieldKind {
    Text,
    Secret,
    Select,
    Boolean,
    Number,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentNativeConfigFormat {
    Json,
    Toml,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentNativeConfigFileView {
    pub path: String,
    pub format: AgentNativeConfigFormat,
    pub content: String,
    pub sensitive: bool,
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentNativeConfigFieldView {
    pub id: String,
    pub label: String,
    pub description: String,
    pub kind: AgentNativeConfigFieldKind,
    pub options: Vec<AgentNativeConfigOptionView>,
    pub secret: bool,
    pub path: String,
    pub present: bool,
    pub value: Option<String>,
    pub masked_value: Option<String>,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentNativeConfigView {
    pub agent_id: AgentId,
    pub available: bool,
    pub path: Option<String>,
    pub paths: Vec<String>,
    pub fields: Vec<AgentNativeConfigFieldView>,
    pub files: Vec<AgentNativeConfigFileView>,
    pub applies_to_next_session: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentNativeConfigPatchRequest {
    pub agent_id: AgentId,
    pub base_field_revisions: std::collections::BTreeMap<String, String>,
    pub fields: std::collections::BTreeMap<String, Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentDiagnosticView {
    pub id: String,
    pub agent_id: AgentId,
    pub operation_kind: String,
    pub severity: String,
    pub message: String,
    pub redacted_output: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentOperationReceipt {
    pub operation_id: String,
    pub agent_id: AgentId,
    pub kind: AgentOperationKind,
    pub status: AgentOperationStatus,
}
