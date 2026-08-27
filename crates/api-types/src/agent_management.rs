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
    /// Declares that the custom Agent reads the cross-agent
    /// `~/.agents/skills` / project `.agents/skills` convention.
    #[serde(default)]
    pub skills_shared_store: bool,
    /// Optional dedicated global skills directory. The service expands `~`
    /// and rejects relative paths before persisting this value.
    #[serde(default)]
    pub skills_directory: Option<String>,
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
    pub skills_shared_store: bool,
    pub skills_directory: Option<String>,
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
pub struct AgentLocalRuntimeView {
    pub path: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentDiscoveryPhase {
    Pending,
    Checking,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentDiscoveryProgressView {
    pub phase: AgentDiscoveryPhase,
    pub completed: u32,
    pub total: u32,
    pub found: u32,
    pub checked_agent_ids: Vec<AgentId>,
    pub timed_out: bool,
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
    #[serde(default)]
    #[ts(optional)]
    pub local_runtime: Option<AgentLocalRuntimeView>,
    pub active_operation: Option<AgentOperationKind>,
    pub rollback_available: bool,
    #[serde(default)]
    #[ts(optional)]
    pub settings_features: Option<Vec<AgentSettingsFeature>>,
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
pub struct CommunityAcpPresetView {
    pub preset_id: String,
    pub agent_id: AgentId,
    pub display_name: String,
    pub description: String,
    pub authors: Vec<String>,
    pub repository: Option<String>,
    pub version: String,
    pub distribution_kind: UserAgentDistributionKind,
    pub distribution_json: String,
    pub icon_light: Option<String>,
    pub icon_dark: Option<String>,
    pub built_in: bool,
    pub added: bool,
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
    #[serde(default)]
    pub presets: Vec<CommunityAcpPresetView>,
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
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AgentPreflightSource {
    System,
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
    pub source: Option<AgentPreflightSource>,
    pub repairable: bool,
    #[serde(default)]
    pub update_available: bool,
    #[serde(default)]
    pub available_version: Option<String>,
    #[serde(default)]
    pub update_group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPreflightView {
    pub agent_id: AgentId,
    pub checked_at: String,
    pub items: Vec<AgentPreflightItemView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentManagementActionKind {
    Login,
    Logout,
    Setup,
    Subscription,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentManagementActionView {
    pub id: String,
    pub label: String,
    pub description: String,
    pub label_key: String,
    pub description_key: String,
    pub kind: AgentManagementActionKind,
    pub available: bool,
    pub unavailable_reason: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentManagementActionsView {
    pub agent_id: AgentId,
    pub actions: Vec<AgentManagementActionView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentManagementActionReceipt {
    pub agent_id: AgentId,
    pub action_id: String,
    pub launched: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentAccountFlowStatus {
    Idle,
    Pending,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentAccountFlowView {
    pub agent_id: AgentId,
    pub action_id: Option<String>,
    pub status: AgentAccountFlowStatus,
    pub exit_code: Option<i32>,
    pub authentication: Option<AgentAuthenticationStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpenCodeProviderModelView {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpenCodeProviderConnectionView {
    pub provider_id: String,
    pub name: String,
    pub npm: Option<String>,
    pub api: Option<String>,
    pub base_url: Option<String>,
    pub models: Vec<OpenCodeProviderModelView>,
    pub credential_present: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpenCodeProviderConnectionsView {
    pub providers: Vec<OpenCodeProviderConnectionView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpenCodeProviderModelRequest {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpenCodeProviderConnectRequest {
    pub provider_id: String,
    pub name: String,
    pub npm: Option<String>,
    pub api: Option<String>,
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    pub models: Vec<OpenCodeProviderModelRequest>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum OpenCodeProviderCatalogSource {
    Live,
    Cache,
    Bundled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpenCodeCatalogModelView {
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    pub tool_call: bool,
    pub context: Option<u32>,
    pub cost_in: Option<f64>,
    pub cost_out: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpenCodeCatalogProviderView {
    pub id: String,
    pub name: String,
    pub npm: Option<String>,
    pub env: Vec<String>,
    pub doc: Option<String>,
    pub auth_kind: String,
    pub models: Vec<OpenCodeCatalogModelView>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpenCodeProviderCatalogView {
    pub source: OpenCodeProviderCatalogSource,
    pub providers: Vec<OpenCodeCatalogProviderView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CodexDeviceCodeView {
    pub user_code: String,
    pub verification_url: String,
    pub device_auth_id: String,
    pub interval: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CodexDeviceCodePollView {
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentModelCatalogSource {
    Live,
    Cache,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentModelCatalogItemView {
    pub id: String,
    pub label: String,
    pub context_window: Option<u32>,
    pub reasoning_levels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentModelCatalogView {
    pub agent_id: AgentId,
    pub source: AgentModelCatalogSource,
    pub models: Vec<AgentModelCatalogItemView>,
    pub default_model: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CodexCustomModelRequest {
    pub slug: String,
    #[serde(alias = "displayName")]
    pub display_name: Option<String>,
    #[serde(alias = "contextWindow")]
    pub context_window: Option<u32>,
    pub base: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CodexModelCatalogConfigRequest {
    #[serde(default)]
    pub customs: Vec<CodexCustomModelRequest>,
    #[serde(default, alias = "excludedOfficials")]
    pub excluded_officials: Vec<String>,
    #[serde(default, alias = "default")]
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CodexModelCatalogConfigView {
    pub customs: Vec<CodexCustomModelRequest>,
    pub excluded_officials: Vec<String>,
    pub default_model: Option<String>,
    pub catalog_path: String,
    pub source_path: String,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentModelProviderView {
    pub id: String,
    pub name: String,
    pub agent_id: AgentId,
    pub api_url: String,
    pub model: String,
    pub credential_present: bool,
    pub bound: bool,
    /// `true` 表示该 Provider 由 VibeX 的预设存储管理；`false` 表示它只存在于
    /// Agent 原生配置中（例如 Codex `config.toml` 的 `[model_providers.xxx]`），
    /// 只能查看或接管，不能被 VibeX 直接编辑或删除。
    pub managed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentModelProvidersView {
    pub agent_id: AgentId,
    pub providers: Vec<AgentModelProviderView>,
    pub bound_provider_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentModelProviderProbeView {
    pub ok: bool,
    pub latency_ms: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentModelProviderImportSource {
    Native,
    CcSwitch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentModelProviderImportCandidateView {
    pub source_id: String,
    pub name: String,
    pub api_url: String,
    pub model: String,
    pub credential_present: bool,
    pub skip_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentModelProviderImportPreviewView {
    pub agent_id: AgentId,
    pub source: AgentModelProviderImportSource,
    pub source_path: Option<String>,
    pub candidates: Vec<AgentModelProviderImportCandidateView>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentModelProviderImportRequest {
    pub agent_id: AgentId,
    pub source: AgentModelProviderImportSource,
    pub source_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PiCustomProviderView {
    pub id: String,
    pub base_url: String,
    pub api: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PiRuntimeConfigurationView {
    pub mode: String,
    pub command: String,
    pub config_dir: String,
    pub session_dir: String,
    pub trust_workspace: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PiConfigurationView {
    pub default_provider: String,
    pub default_model: String,
    pub thinking_level: String,
    pub credential_present: bool,
    pub auth_providers: Vec<String>,
    pub custom_providers: Vec<PiCustomProviderView>,
    pub runtime: PiRuntimeConfigurationView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PiCredentialsSaveRequest {
    pub provider: String,
    pub model: String,
    pub thinking_level: Option<String>,
    pub api_key: Option<String>,
    pub custom_base_url: Option<String>,
    pub custom_api: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PiRuntimeSaveRequest {
    pub mode: String,
    pub command: String,
    pub config_dir: String,
    pub session_dir: String,
    pub trust_workspace: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PiCommandValidationView {
    pub found: bool,
    pub resolved_path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum DshProviderKind {
    Official,
    Catalog,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DshProviderModelView {
    pub id: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DshCatalogProviderView {
    pub id: String,
    pub name: String,
    pub api_key_env: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DshProviderView {
    pub id: String,
    pub display_name: String,
    pub kind: DshProviderKind,
    pub notes: Option<String>,
    pub api: Option<String>,
    pub base_url: Option<String>,
    pub api_key_env: String,
    pub credential_present: bool,
    pub models: Vec<DshProviderModelView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DshProvidersView {
    pub settings_path: String,
    pub credentials_path: String,
    pub default_provider: String,
    pub default_model: String,
    pub providers: Vec<DshProviderView>,
    pub catalog: Vec<DshCatalogProviderView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DshProviderSaveRequest {
    pub id: String,
    pub display_name: Option<String>,
    pub notes: Option<String>,
    pub api: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub models: Vec<DshProviderModelView>,
    pub set_default: bool,
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DshProviderDiscoverRequest {
    pub base_url: String,
    pub api_key: Option<String>,
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum DshExtensionKind {
    Plugin,
    Skill,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DshPluginView {
    pub name: String,
    pub version: Option<String>,
    pub reserved: bool,
    pub source: String,
    pub kind: DshExtensionKind,
    pub path: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DshPluginSummaryView {
    pub profile: String,
    pub profile_dir: String,
    pub plugins: Vec<DshPluginView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GrokPluginView {
    pub name: String,
    pub version: Option<String>,
    pub status: String,
    pub path: Option<String>,
    pub source: Option<String>,
    pub marketplace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GrokPluginSummaryView {
    pub home: String,
    pub plugins: Vec<GrokPluginView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentModelProviderSaveRequest {
    pub id: Option<String>,
    pub name: String,
    pub agent_id: AgentId,
    pub api_url: String,
    pub api_key: Option<String>,
    pub model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum OpenCodePluginStatus {
    Installed,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpenCodePluginView {
    pub name: String,
    pub declared_spec: String,
    pub installed_version: Option<String>,
    pub status: OpenCodePluginStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpenCodePluginSummaryView {
    pub config_path: String,
    pub cache_dir: String,
    pub plugins: Vec<OpenCodePluginView>,
    pub has_project_config_hint: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentAuthModeKind {
    Subscription,
    OfficialApi,
    Provider,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentAuthModeOptionView {
    pub value: String,
    pub kind: AgentAuthModeKind,
    pub label_key: String,
    pub description_key: String,
    pub credential_env: Option<String>,
    pub native_config_field_id: Option<String>,
    pub credential_required: bool,
    #[serde(default)]
    #[ts(optional)]
    pub official_api_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentAuthModeView {
    pub agent_id: AgentId,
    pub mode: String,
    pub modes: Vec<String>,
    pub options: Vec<AgentAuthModeOptionView>,
    pub credential_env: String,
    pub credential_present: bool,
    #[serde(default)]
    #[ts(optional)]
    pub account_label: Option<String>,
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
    Json,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentNativeConfigSurface {
    #[default]
    Configuration,
    Authentication,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentNativeConfigFormat {
    Json,
    Toml,
    Yaml,
    Dotenv,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentNativeConfigFileView {
    pub path: String,
    pub format: AgentNativeConfigFormat,
    pub content: String,
    pub sensitive: bool,
    pub exists: bool,
    pub revision: String,
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
    #[serde(default)]
    pub surface: AgentNativeConfigSurface,
}

/// First-class settings surfaces contributed by an Agent profile. The frontend
/// renders these capabilities instead of maintaining a second fixed Agent list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentSettingsFeature {
    AuthenticationMode,
    ModelCatalog,
    ReusableModelProviders,
    CodexModelCatalog,
    PiConfiguration,
    OpenCodeProviders,
    OpenCodePlugins,
    DshProviders,
    DshPlugins,
    GrokPlugins,
    NativeMcp,
    NativeSkills,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentNativeConfigView {
    pub agent_id: AgentId,
    pub available: bool,
    #[serde(default)]
    pub settings_features: Vec<AgentSettingsFeature>,
    pub path: Option<String>,
    pub paths: Vec<String>,
    pub fields: Vec<AgentNativeConfigFieldView>,
    pub files: Vec<AgentNativeConfigFileView>,
    pub applies_to_next_session: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentEnvironmentEntryView {
    pub name: String,
    pub value: Option<String>,
    pub secret: bool,
    pub present: bool,
    pub masked_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentEnvironmentView {
    pub agent_id: AgentId,
    pub entries: Vec<AgentEnvironmentEntryView>,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentEnvironmentPatchRequest {
    pub agent_id: AgentId,
    pub base_revision: String,
    pub values: std::collections::BTreeMap<String, Option<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AgentEnvironmentDiagnosticLevel {
    Ok,
    Warning,
    Error,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentEnvironmentDiagnosticCheckView {
    pub id: String,
    pub label_key: String,
    pub value: String,
    pub level: AgentEnvironmentDiagnosticLevel,
    pub detail_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentEnvironmentDiagnosticSectionView {
    pub id: String,
    pub title_key: String,
    pub checks: Vec<AgentEnvironmentDiagnosticCheckView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentEnvironmentDiagnosticsView {
    pub agent_id: AgentId,
    pub verdict_code: String,
    pub verdict_level: AgentEnvironmentDiagnosticLevel,
    pub sections: Vec<AgentEnvironmentDiagnosticSectionView>,
    pub generated_at: String,
    pub plain_text: String,
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
pub struct AgentNativeConfigFileWriteRequest {
    pub agent_id: AgentId,
    pub path: String,
    pub base_revision: String,
    pub content: String,
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
    pub read: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentOperationReceipt {
    pub operation_id: String,
    pub agent_id: AgentId,
    pub kind: AgentOperationKind,
    pub status: AgentOperationStatus,
}
