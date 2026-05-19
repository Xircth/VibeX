use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, LazyLock,
        atomic::{AtomicU64, Ordering},
    },
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use db::models::{
    coding_agent_turn::{CodingAgentTurn, CreateCodingAgentTurn},
    execution_process::{
        CreateExecutionProcess, ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus,
    },
    execution_process_logs::ExecutionProcessLogs,
    execution_process_repo_state::CreateExecutionProcessRepoState,
    session::{CreateSession, Session, SessionStatus},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::{
    actions::{
        ExecutorAction, ExecutorActionType, coding_agent_follow_up::CodingAgentFollowUpRequest,
        coding_agent_initial::CodingAgentInitialRequest,
    },
    executors::{
        BaseCodingAgent, CodingAgent, SlashCommandKind,
        codex::{AskForApproval, ReasoningEffort, SandboxMode},
    },
    logs::{
        NormalizedEntry, NormalizedEntryError, NormalizedEntryType, TokenUsageInfo,
        utils::ConversationPatch,
    },
    profile::{ExecutorConfig, ExecutorConfigs, ExecutorProfileId},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use services::services::container::ContainerService;
use sqlx::SqlitePool;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::{Mutex, oneshot},
    time::Duration,
};
use ts_rs::TS;
use utils::{log_msg::LogMsg, msg_store::MsgStore};
use uuid::Uuid;

use crate::{
    error::AppError, state::AppState, workspace_paths::resolve_workspace_agent_working_dir,
};

const CODEX_REQUEST_TIMEOUT_SECS: u64 = 30;
const CODEX_INITIALIZE_TIMEOUT_SECS: u64 = 15;
const ACP_FALLBACK_ENV: &str = "VIBEX_PROVIDER_ACP_FALLBACK";
const CLAUDE_ACP_FALLBACK_ENV: &str = "VIBEX_CLAUDE_ACP_FALLBACK";
const CODEX_ACP_FALLBACK_ENV: &str = "VIBEX_CODEX_ACP_FALLBACK";
const OPENCODE_ACP_FALLBACK_ENV: &str = "VIBEX_OPENCODE_ACP_FALLBACK";
const CLAUDE_PRIMARY_MODEL_ENV: &str = "ANTHROPIC_MODEL";
const CLAUDE_DEFAULT_SONNET_ENV: &str = "ANTHROPIC_DEFAULT_SONNET_MODEL";
const CLAUDE_DEFAULT_OPUS_ENV: &str = "ANTHROPIC_DEFAULT_OPUS_MODEL";
const CLAUDE_DEFAULT_HAIKU_ENV: &str = "ANTHROPIC_DEFAULT_HAIKU_MODEL";

static CODEX_APP_SERVERS: LazyLock<Mutex<HashMap<String, Arc<CodexAppServer>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NATIVE_ACTIVE_TURNS: LazyLock<Mutex<HashMap<String, NativeProcessHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CODEX_NATIVE_TURN_SINKS: LazyLock<Mutex<HashMap<String, NativeConversationSink>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CODEX_NATIVE_THREAD_SINKS: LazyLock<Mutex<HashMap<String, NativeConversationSink>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PROVIDER_EVENT_HISTORY: LazyLock<Mutex<HashMap<String, Vec<ProviderRuntimeEvent>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
struct NativeProcessHandle {
    provider: ProviderId,
    child: Arc<Mutex<Child>>,
}

#[derive(Clone)]
struct NativeConversationSink {
    pool: SqlitePool,
    process_id: Uuid,
    session_id: Uuid,
    msg_store: Arc<MsgStore>,
    state: Arc<Mutex<NativeConversationState>>,
}

#[derive(Default)]
struct NativeConversationState {
    assistant_content: String,
    assistant_written: bool,
    next_entry_index: usize,
}

struct CodexAppServer {
    workspace_id: String,
    workspace_dir: PathBuf,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    next_id: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum ProviderId {
    Claude,
    Codex,
    Opencode,
}

impl ProviderId {
    fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Opencode => "OpenCode",
        }
    }

    fn base_agent(self) -> BaseCodingAgent {
        match self {
            Self::Claude => BaseCodingAgent::ClaudeCode,
            Self::Codex => BaseCodingAgent::Codex,
            Self::Opencode => BaseCodingAgent::Opencode,
        }
    }
}

impl From<BaseCodingAgent> for ProviderId {
    fn from(agent: BaseCodingAgent) -> Self {
        match agent {
            BaseCodingAgent::ClaudeCode => Self::Claude,
            BaseCodingAgent::Codex => Self::Codex,
            BaseCodingAgent::Opencode => Self::Opencode,
        }
    }
}

impl ProviderId {
    fn history_key(self, session_id: &str) -> String {
        format!("{self:?}:{session_id}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum CapabilityState {
    Available,
    Unavailable,
    Partial,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum CapabilitySource {
    Native,
    Sdk,
    AppServer,
    CliJson,
    AcpFallback,
    Config,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CapabilityStatus {
    pub state: CapabilityState,
    pub source: CapabilitySource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CapabilityStatus {
    fn available(source: CapabilitySource) -> Self {
        Self {
            state: CapabilityState::Available,
            source,
            detail: None,
        }
    }

    fn partial(source: CapabilitySource, detail: impl Into<String>) -> Self {
        Self {
            state: CapabilityState::Partial,
            source,
            detail: Some(detail.into()),
        }
    }

    fn unavailable(source: CapabilitySource, detail: impl Into<String>) -> Self {
        Self {
            state: CapabilityState::Unavailable,
            source,
            detail: Some(detail.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProviderCapabilityState {
    pub slash_commands: CapabilityStatus,
    pub images: CapabilityStatus,
    pub session_resume: CapabilityStatus,
    pub session_fork: CapabilityStatus,
    pub approvals: CapabilityStatus,
    pub user_input_requests: CapabilityStatus,
    pub reasoning_control: CapabilityStatus,
    pub collaboration_mode: CapabilityStatus,
    pub mcp: CapabilityStatus,
    pub provider_control_panel: CapabilityStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProviderTurnRequest {
    pub provider: ProviderId,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_profile_id: Option<ExecutorProfileId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub provider_options: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProviderRuntimeEvent {
    pub provider: ProviderId,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub event: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProviderCommand {
    pub provider: ProviderId,
    pub name: String,
    pub description: String,
    pub kind: SlashCommandKind,
    pub source: CapabilitySource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProviderModel {
    pub provider: ProviderId,
    pub id: String,
    pub label: String,
    pub source: CapabilitySource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProviderSessionSummary {
    pub provider: ProviderId,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProviderHistorySnapshot {
    pub provider: ProviderId,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<ProviderRuntimeEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum ProviderRuntimeKind {
    ClaudeAgentSdk,
    CodexAppServer,
    OpencodeSdk,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProviderRuntimeDependency {
    pub id: String,
    pub label: String,
    pub source: CapabilitySource,
    pub required: bool,
    pub user_visible: bool,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProviderRuntimeContract {
    pub provider: ProviderId,
    pub primary_runtime: ProviderRuntimeKind,
    pub primary_source: CapabilitySource,
    pub primary_label: String,
    pub dependencies: Vec<ProviderRuntimeDependency>,
    pub fallback_source: CapabilitySource,
    pub fallback_enabled_by_default: bool,
    pub fallback_env: String,
    pub global_fallback_env: String,
    pub force_fallback_option: String,
    pub command_visibility_policy: String,
    pub event_history_policy: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProviderRuntimeStatus {
    pub provider: ProviderId,
    pub contract: ProviderRuntimeContract,
    pub native: CapabilityStatus,
    pub fallback: CapabilityStatus,
}

fn runtime_dependency(
    id: &str,
    label: &str,
    source: CapabilitySource,
    required: bool,
    user_visible: bool,
    detail: &str,
) -> ProviderRuntimeDependency {
    ProviderRuntimeDependency {
        id: id.to_string(),
        label: label.to_string(),
        source,
        required,
        user_visible,
        detail: detail.to_string(),
    }
}

pub fn provider_runtime_contract(provider: ProviderId) -> ProviderRuntimeContract {
    let (primary_runtime, primary_source, primary_label, dependencies, event_history_policy) =
        match provider {
            ProviderId::Claude => (
                ProviderRuntimeKind::ClaudeAgentSdk,
                CapabilitySource::Sdk,
                "Claude Agent SDK bridge",
                vec![
                    runtime_dependency(
                        "claude_agent_sdk",
                        "@anthropic-ai/claude-agent-sdk",
                        CapabilitySource::Sdk,
                        true,
                        false,
                        "Hidden project dependency used by the Node SDK bridge.",
                    ),
                    runtime_dependency(
                        "claude_cli",
                        "Claude Code CLI",
                        CapabilitySource::Native,
                        false,
                        true,
                        "Companion local runtime for Claude Code account, auth, and config state.",
                    ),
                    runtime_dependency(
                        "claude_acp",
                        "Claude ACP adapter",
                        CapabilitySource::AcpFallback,
                        false,
                        true,
                        "Compatibility fallback only; it is not the primary runtime.",
                    ),
                ],
                "SDK JSONL events are stored in the provider runtime event envelope.",
            ),
            ProviderId::Codex => (
                ProviderRuntimeKind::CodexAppServer,
                CapabilitySource::AppServer,
                "Codex app-server",
                vec![
                    runtime_dependency(
                        "codex_cli",
                        "Codex CLI",
                        CapabilitySource::AppServer,
                        true,
                        true,
                        "Primary local runtime launched as `codex app-server`.",
                    ),
                    runtime_dependency(
                        "codex_acp",
                        "Codex ACP adapter",
                        CapabilitySource::AcpFallback,
                        false,
                        true,
                        "Compatibility fallback only; it is not the primary runtime.",
                    ),
                ],
                "App-server JSON-RPC events are stored in the provider runtime event envelope.",
            ),
            ProviderId::Opencode => (
                ProviderRuntimeKind::OpencodeSdk,
                CapabilitySource::Sdk,
                "OpenCode SDK bridge",
                vec![
                    runtime_dependency(
                        "opencode_sdk",
                        "@opencode-ai/sdk",
                        CapabilitySource::Sdk,
                        true,
                        false,
                        "Hidden project dependency used by the Node SDK bridge.",
                    ),
                    runtime_dependency(
                        "opencode_cli",
                        "OpenCode CLI/server",
                        CapabilitySource::Native,
                        true,
                        true,
                        "The SDK launches or connects to the local OpenCode runtime.",
                    ),
                    runtime_dependency(
                        "opencode_acp",
                        "OpenCode ACP adapter",
                        CapabilitySource::AcpFallback,
                        false,
                        true,
                        "Compatibility fallback only; it is not the primary runtime.",
                    ),
                ],
                "SDK JSONL events are stored in the provider runtime event envelope.",
            ),
        };

    ProviderRuntimeContract {
        provider,
        primary_runtime,
        primary_source,
        primary_label: primary_label.to_string(),
        dependencies,
        fallback_source: CapabilitySource::AcpFallback,
        fallback_enabled_by_default: true,
        fallback_env: provider_acp_fallback_env(provider).to_string(),
        global_fallback_env: ACP_FALLBACK_ENV.to_string(),
        force_fallback_option: "force_acp_fallback".to_string(),
        command_visibility_policy:
            "Expose only commands that can produce a visible VibeX chat/result effect; hide TUI-only config/status commands until VibeX owns an equivalent UI."
                .to_string(),
        event_history_policy: format!("{event_history_policy} ACP fallback events are labeled as `acp_fallback` with the native failure reason when available."),
    }
}

pub fn provider_capabilities(provider: ProviderId) -> ProviderCapabilityState {
    match provider {
        ProviderId::Claude => ProviderCapabilityState {
            slash_commands: CapabilityStatus::available(CapabilitySource::Sdk),
            images: CapabilityStatus::available(CapabilitySource::Sdk),
            session_resume: CapabilityStatus::available(CapabilitySource::Sdk),
            session_fork: CapabilityStatus::available(CapabilitySource::Sdk),
            approvals: CapabilityStatus::available(CapabilitySource::Sdk),
            user_input_requests: CapabilityStatus::partial(
                CapabilitySource::Sdk,
                "Interactive prompts depend on the selected Claude surface.",
            ),
            reasoning_control: CapabilityStatus::partial(
                CapabilitySource::Sdk,
                "Reasoning controls map to Claude model or effort choices.",
            ),
            collaboration_mode: CapabilityStatus::unavailable(
                CapabilitySource::Native,
                "Claude does not expose a Codex-style collaboration mode.",
            ),
            mcp: CapabilityStatus::available(CapabilitySource::Config),
            provider_control_panel: CapabilityStatus::partial(
                CapabilitySource::Config,
                "Settings currently cover config files and local availability.",
            ),
        },
        ProviderId::Codex => ProviderCapabilityState {
            slash_commands: CapabilityStatus::available(CapabilitySource::AppServer),
            images: CapabilityStatus::available(CapabilitySource::AppServer),
            session_resume: CapabilityStatus::available(CapabilitySource::AppServer),
            session_fork: CapabilityStatus::available(CapabilitySource::AppServer),
            approvals: CapabilityStatus::available(CapabilitySource::AppServer),
            user_input_requests: CapabilityStatus::available(CapabilitySource::AppServer),
            reasoning_control: CapabilityStatus::available(CapabilitySource::AppServer),
            collaboration_mode: CapabilityStatus::available(CapabilitySource::AppServer),
            mcp: CapabilityStatus::available(CapabilitySource::Config),
            provider_control_panel: CapabilityStatus::partial(
                CapabilitySource::Config,
                "Native account and config surfaces are available; app-server lifecycle is next.",
            ),
        },
        ProviderId::Opencode => ProviderCapabilityState {
            slash_commands: CapabilityStatus::available(CapabilitySource::Sdk),
            images: CapabilityStatus::partial(
                CapabilitySource::Sdk,
                "OpenCode image support depends on provider and model.",
            ),
            session_resume: CapabilityStatus::available(CapabilitySource::Sdk),
            session_fork: CapabilityStatus::available(CapabilitySource::Sdk),
            approvals: CapabilityStatus::partial(
                CapabilitySource::Sdk,
                "Approval behavior is surfaced through OpenCode SDK permission events.",
            ),
            user_input_requests: CapabilityStatus::partial(
                CapabilitySource::Sdk,
                "Interactive prompts depend on OpenCode SDK permission/question events.",
            ),
            reasoning_control: CapabilityStatus::partial(
                CapabilitySource::Sdk,
                "Reasoning is model/provider specific.",
            ),
            collaboration_mode: CapabilityStatus::partial(
                CapabilitySource::Sdk,
                "OpenCode plan/build behavior is not the same as Codex collaboration mode.",
            ),
            mcp: CapabilityStatus::available(CapabilitySource::Sdk),
            provider_control_panel: CapabilityStatus::available(CapabilitySource::Sdk),
        },
    }
}

pub fn provider_slash_commands(provider: ProviderId) -> Vec<ProviderCommand> {
    let entries: &[(&str, &str)] = match provider {
        ProviderId::Claude => &[
            ("add-dir", "Add additional working directories"),
            ("agents", "Manage custom agents"),
            ("clear", "Clear conversation history"),
            ("compact", "Compact conversation with an optional focus"),
            ("context", "Show context usage"),
            ("cost", "Show token usage and cost"),
            ("doctor", "Check Claude Code installation health"),
            ("init", "Initialize a CLAUDE.md file"),
            ("memory", "Edit CLAUDE.md memory files"),
            ("resume", "Resume a Claude Code conversation"),
            ("review", "Review a pull request"),
            ("security-review", "Review code for security issues"),
            ("status", "Show account and system status"),
        ],
        ProviderId::Codex => &[
            ("compact", "Compact conversation with an optional focus"),
            (
                "goal",
                "Set, inspect, pause, resume, or clear a long-running goal",
            ),
            (
                "init",
                "Create an AGENTS.md file with repository instructions",
            ),
            ("plan", "Switch to planning-oriented Codex behavior"),
            ("review", "Review code with optional instructions"),
        ],
        ProviderId::Opencode => &[
            ("agents", "List or switch OpenCode agents"),
            ("build", "Switch to build mode"),
            ("compact", "Compact the current session"),
            ("commands", "Show available OpenCode commands"),
            ("init", "Create or update AGENTS.md"),
            ("models", "List available models"),
            ("plan", "Switch to plan mode"),
            ("session", "Manage or switch sessions"),
            ("sessions", "List sessions"),
            ("status", "Show current OpenCode status"),
            ("summarize", "Summarize the current session"),
        ],
    };

    entries
        .iter()
        .map(|(name, description)| ProviderCommand {
            provider,
            name: (*name).to_string(),
            description: (*description).to_string(),
            kind: SlashCommandKind::Command,
            source: provider_runtime_contract(provider).primary_source,
        })
        .collect()
}

fn should_hide_provider_slash_command(provider: ProviderId, name: &str) -> bool {
    let normalized = name.trim().trim_start_matches('/').to_ascii_lowercase();
    matches!(normalized.as_str(), "config" | "mcp" | "model" | "theme")
        || (provider == ProviderId::Claude && normalized == "permissions")
}

fn provider_from_executor_name(executor: &str) -> Option<ProviderId> {
    match executor.trim().to_ascii_uppercase().as_str() {
        "CLAUDE_CODE" | "CLAUDECODE" | "CLAUDE" | "CLAUDE-CODE" | "CLAUDE_CODE_ACP" => {
            Some(ProviderId::Claude)
        }
        "CODEX" | "CODEX_ACP" => Some(ProviderId::Codex),
        "OPENCODE" | "OPEN_CODE" | "OPEN-CODE" | "OPENCODE_ACP" => Some(ProviderId::Opencode),
        _ => None,
    }
}

fn session_executor_matches_provider(executor: Option<&str>, provider: ProviderId) -> bool {
    executor
        .and_then(provider_from_executor_name)
        .is_none_or(|session_provider| session_provider == provider)
}

fn provider_option_string<'a>(
    options: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Option<&'a str> {
    options
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn provider_option_bool(options: &serde_json::Map<String, Value>, key: &str) -> bool {
    options.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn provider_executor_profile_id(request: &ProviderTurnRequest) -> ExecutorProfileId {
    request
        .executor_profile_id
        .clone()
        .unwrap_or_else(|| ExecutorProfileId::new(request.provider.base_agent()))
}

fn validate_provider_executor_profile(request: &ProviderTurnRequest) -> Result<(), AppError> {
    if let Some(profile_id) = &request.executor_profile_id
        && profile_id.executor != request.provider.base_agent()
    {
        return Err(AppError::BadRequest(format!(
            "Provider {:?} cannot run executor profile {}",
            request.provider, profile_id
        )));
    }
    Ok(())
}

fn provider_executor_config(request: &ProviderTurnRequest) -> ExecutorConfig {
    ExecutorConfig::from(provider_executor_profile_id(request))
}

fn should_force_acp_fallback(request: &ProviderTurnRequest) -> bool {
    provider_option_bool(&request.provider_options, "force_acp_fallback")
}

fn codex_approval_policy_value(approval: Option<&AskForApproval>) -> &'static str {
    match approval {
        Some(AskForApproval::UnlessTrusted) => "untrusted",
        Some(AskForApproval::OnFailure) => "on-failure",
        Some(AskForApproval::OnRequest) => "on-request",
        Some(AskForApproval::Never) | None => "never",
    }
}

fn codex_reasoning_effort_value(effort: &ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::Xhigh => "xhigh",
    }
}

fn codex_sandbox_policy_value(mode: Option<&SandboxMode>, workspace_dir: &Path) -> Value {
    match mode.unwrap_or(&SandboxMode::DangerFullAccess) {
        SandboxMode::Auto | SandboxMode::DangerFullAccess => json!({
            "type": "dangerFullAccess",
        }),
        SandboxMode::ReadOnly => json!({
            "type": "readOnly",
            "networkAccess": true,
        }),
        SandboxMode::WorkspaceWrite => json!({
            "type": "workspaceWrite",
            "writableRoots": [workspace_dir.to_string_lossy()],
            "networkAccess": true,
        }),
    }
}

#[derive(Debug, Clone, PartialEq)]
struct CodexRuntimeOptions {
    model: Option<String>,
    approval_policy: String,
    sandbox_policy: Value,
    effort: Option<String>,
}

fn resolve_codex_runtime_options(
    request: &ProviderTurnRequest,
    workspace_dir: &Path,
) -> CodexRuntimeOptions {
    let profile_id = provider_executor_profile_id(request);
    let agent = ExecutorConfigs::get_cached().get_coding_agent_or_default(&profile_id);
    let profile = match agent {
        CodingAgent::Codex(codex) => Some(codex),
        _ => None,
    };

    let model = request
        .model
        .clone()
        .or_else(|| profile_id.model.clone())
        .or_else(|| profile.as_ref().and_then(|codex| codex.model.clone()));
    let approval_policy = provider_option_string(&request.provider_options, "approval_policy")
        .or_else(|| provider_option_string(&request.provider_options, "approvalPolicy"))
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            codex_approval_policy_value(
                profile
                    .as_ref()
                    .and_then(|codex| codex.ask_for_approval.as_ref()),
            )
            .into()
        });
    let sandbox_policy = request
        .provider_options
        .get("sandbox_policy")
        .or_else(|| request.provider_options.get("sandboxPolicy"))
        .cloned()
        .unwrap_or_else(|| {
            codex_sandbox_policy_value(
                profile.as_ref().and_then(|codex| codex.sandbox.as_ref()),
                workspace_dir,
            )
        });
    let effort = provider_option_string(&request.provider_options, "effort")
        .map(ToString::to_string)
        .or_else(|| {
            profile
                .as_ref()
                .and_then(|codex| codex.model_reasoning_effort.as_ref())
                .map(codex_reasoning_effort_value)
                .map(ToString::to_string)
        });

    CodexRuntimeOptions {
        model,
        approval_policy,
        sandbox_policy,
        effort,
    }
}

fn apply_profile_defaults_to_request(request: &mut ProviderTurnRequest) {
    let profile_id = provider_executor_profile_id(request);
    if request.model.is_none() {
        request.model = profile_id.model.clone();
    }
    let agent = ExecutorConfigs::get_cached().get_coding_agent_or_default(&profile_id);

    match agent {
        CodingAgent::ClaudeCode(claude) => {
            request.text = claude.append_prompt.combine_prompt(&request.text);
            if request.model.is_none() {
                request.model = claude.model.clone();
            }
            if let Some(env) = claude.cmd.env {
                let profile_env = json!(env);
                match request.provider_options.get_mut("env") {
                    Some(Value::Object(existing)) => {
                        if let Some(profile_env) = profile_env.as_object() {
                            for (key, value) in profile_env {
                                existing.entry(key.clone()).or_insert_with(|| value.clone());
                            }
                        }
                    }
                    Some(_) => {}
                    None => {
                        request
                            .provider_options
                            .insert("env".to_string(), profile_env);
                    }
                }
            }
            if claude.plan.unwrap_or(false) {
                request
                    .provider_options
                    .entry("permission_mode".to_string())
                    .or_insert_with(|| json!("plan"));
            } else if claude.dangerously_skip_permissions.unwrap_or(false) {
                request
                    .provider_options
                    .entry("permission_mode".to_string())
                    .or_insert_with(|| json!("bypassPermissions"));
            }
        }
        CodingAgent::Opencode(opencode) => {
            request.text = opencode.append_prompt.combine_prompt(&request.text);
            if request.model.is_none() {
                request.model = opencode.model.clone();
            }
            if let Some(agent) = opencode.agent {
                request
                    .provider_options
                    .entry("agent".to_string())
                    .or_insert_with(|| json!(agent));
            }
            if let Some(variant) = opencode.variant {
                request
                    .provider_options
                    .entry("variant".to_string())
                    .or_insert_with(|| json!(variant));
            }
            if let Some(env) = opencode.cmd.env {
                let profile_env = json!(env);
                match request.provider_options.get_mut("env") {
                    Some(Value::Object(existing)) => {
                        if let Some(profile_env) = profile_env.as_object() {
                            for (key, value) in profile_env {
                                existing.entry(key.clone()).or_insert_with(|| value.clone());
                            }
                        }
                    }
                    Some(_) => {}
                    None => {
                        request
                            .provider_options
                            .insert("env".to_string(), profile_env);
                    }
                }
            }
            request
                .provider_options
                .entry("auto_approve".to_string())
                .or_insert_with(|| json!(opencode.auto_approve));
            request
                .provider_options
                .entry("auto_compact".to_string())
                .or_insert_with(|| json!(opencode.auto_compact));
        }
        CodingAgent::Codex(_) => {}
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AcpFallbackConfig {
    enabled: bool,
    env_name: Option<&'static str>,
}

fn provider_acp_fallback_env(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Claude => CLAUDE_ACP_FALLBACK_ENV,
        ProviderId::Codex => CODEX_ACP_FALLBACK_ENV,
        ProviderId::Opencode => OPENCODE_ACP_FALLBACK_ENV,
    }
}

fn parse_acp_fallback_enabled_value(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" | "enabled" => Some(true),
        "0" | "false" | "no" | "off" | "disabled" => Some(false),
        _ => None,
    }
}

fn acp_fallback_config(provider: ProviderId) -> AcpFallbackConfig {
    let provider_env = provider_acp_fallback_env(provider);
    if let Ok(value) = std::env::var(provider_env) {
        return AcpFallbackConfig {
            enabled: parse_acp_fallback_enabled_value(&value).unwrap_or(true),
            env_name: Some(provider_env),
        };
    }
    if let Ok(value) = std::env::var(ACP_FALLBACK_ENV) {
        return AcpFallbackConfig {
            enabled: parse_acp_fallback_enabled_value(&value).unwrap_or(true),
            env_name: Some(ACP_FALLBACK_ENV),
        };
    }
    AcpFallbackConfig {
        enabled: true,
        env_name: None,
    }
}

async fn new_provider_hidden_command(program: &str, args: Vec<String>) -> tokio::process::Command {
    let executable = utils::shell::resolve_executable_path(program)
        .await
        .unwrap_or_else(|| PathBuf::from(program));
    utils::process::new_hidden_tokio_command(executable, args)
}

fn claude_settings_path() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join(".claude").join("settings.json"))
}

fn read_claude_model_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    for key in [
        CLAUDE_PRIMARY_MODEL_ENV,
        CLAUDE_DEFAULT_SONNET_ENV,
        CLAUDE_DEFAULT_OPUS_ENV,
        CLAUDE_DEFAULT_HAIKU_ENV,
    ] {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                env.insert(key.to_string(), value);
            }
        }
    }

    if let Some(path) = claude_settings_path()
        && let Ok(content) = std::fs::read_to_string(path)
        && let Ok(value) = serde_json::from_str::<Value>(&content)
        && let Some(settings_env) = value.get("env").and_then(Value::as_object)
    {
        for key in [
            CLAUDE_PRIMARY_MODEL_ENV,
            CLAUDE_DEFAULT_SONNET_ENV,
            CLAUDE_DEFAULT_OPUS_ENV,
            CLAUDE_DEFAULT_HAIKU_ENV,
        ] {
            if let Some(value) = settings_env.get(key).and_then(Value::as_str) {
                if !value.trim().is_empty() {
                    env.insert(key.to_string(), value.to_string());
                }
            }
        }
    }

    env
}

fn resolve_claude_model_from_env(model: &str, env: &HashMap<String, String>) -> Option<String> {
    let model = model.trim();
    let env_key = match model.to_ascii_lowercase().as_str() {
        "sonnet" => Some(CLAUDE_DEFAULT_SONNET_ENV),
        "opus" => Some(CLAUDE_DEFAULT_OPUS_ENV),
        "haiku" => Some(CLAUDE_DEFAULT_HAIKU_ENV),
        _ => None,
    };

    if let Some(env_key) = env_key {
        if let Some(value) = env.get(env_key).map(String::as_str).map(str::trim) {
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }

        if model.eq_ignore_ascii_case("sonnet")
            && let Some(value) = env
                .get(CLAUDE_PRIMARY_MODEL_ENV)
                .map(String::as_str)
                .map(str::trim)
        {
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }

    Some(model.to_string())
}

fn resolve_claude_model(model: Option<&str>) -> Option<String> {
    let model = model?.trim();
    if model.is_empty() {
        return None;
    }
    resolve_claude_model_from_env(model, &read_claude_model_env())
}

fn claude_image_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

fn resolve_claude_image_path(workspace_dir: &Path, image: &str) -> Result<PathBuf, AppError> {
    if image.starts_with("http://") || image.starts_with("https://") {
        return Err(AppError::BadRequest(
            "Claude Code native vision input requires local image files; remote image URLs are not supported yet."
                .to_string(),
        ));
    }

    let path = PathBuf::from(image);
    Ok(if path.is_absolute() {
        path
    } else {
        workspace_dir.join(path)
    })
}

fn repo_root_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(manifest_dir)
}

fn claude_sdk_bridge_script_path() -> PathBuf {
    repo_root_path()
        .join("scripts")
        .join("claude-agent-sdk-provider.mjs")
}

fn build_claude_sdk_bridge_args(input_path: &Path) -> Vec<String> {
    vec![
        claude_sdk_bridge_script_path()
            .to_string_lossy()
            .to_string(),
        input_path.to_string_lossy().to_string(),
    ]
}

fn build_claude_sdk_metadata_args(input_path: &Path) -> Vec<String> {
    vec![
        claude_sdk_bridge_script_path()
            .to_string_lossy()
            .to_string(),
        "--metadata".to_string(),
        input_path.to_string_lossy().to_string(),
    ]
}

fn claude_provider_option_string<'a>(
    request: &'a ProviderTurnRequest,
    snake_case_key: &str,
    camel_case_key: &str,
) -> Option<&'a str> {
    provider_option_string(&request.provider_options, snake_case_key)
        .or_else(|| provider_option_string(&request.provider_options, camel_case_key))
}

fn build_claude_sdk_bridge_input(
    request: &ProviderTurnRequest,
    workspace_dir: &Path,
) -> Result<Value, AppError> {
    let mut images = Vec::new();

    for image in &request.images {
        let path = resolve_claude_image_path(workspace_dir, image)?;
        let mime_type = claude_image_mime_type(&path).ok_or_else(|| {
            AppError::BadRequest(format!(
                "Claude Code native vision input only supports PNG, JPEG, GIF, or WebP images: {}",
                path.display()
            ))
        })?;
        let bytes = std::fs::read(&path).map_err(|error| {
            AppError::BadRequest(format!(
                "Failed to read Claude Code image input {}: {}",
                path.display(),
                error
            ))
        })?;
        images.push(json!({
            "path": path.to_string_lossy(),
            "mediaType": mime_type,
            "base64": BASE64_STANDARD.encode(bytes),
        }));
    }

    Ok(json!({
        "text": request.text,
        "cwd": workspace_dir.to_string_lossy(),
        "sessionId": request.session_id,
        "threadId": request.thread_id,
        "resume": provider_option_string(&request.provider_options, "resume"),
        "model": resolve_claude_model(request.model.as_deref()),
        "effort": provider_option_string(&request.provider_options, "effort"),
        "permissionMode": claude_provider_option_string(
            request,
            "permission_mode",
            "permissionMode",
        ),
        "env": request.provider_options.get("env"),
        "forkSession": provider_option_bool(&request.provider_options, "fork")
            || provider_option_bool(&request.provider_options, "forkSession"),
        "images": images,
    }))
}

fn write_claude_sdk_bridge_input_file(input: &Value) -> Result<PathBuf, AppError> {
    let path = std::env::temp_dir().join(format!("vibex-claude-sdk-{}.json", Uuid::new_v4()));
    let bytes = serde_json::to_vec(input).map_err(|error| {
        app_error_from_native(
            ProviderId::Claude,
            format!("failed to serialize SDK bridge input: {error}"),
        )
    })?;
    std::fs::write(&path, bytes).map_err(|error| {
        app_error_from_native(
            ProviderId::Claude,
            format!(
                "failed to write SDK bridge input {}: {}",
                path.display(),
                error
            ),
        )
    })?;
    Ok(path)
}

async fn load_claude_sdk_metadata(workspace_dir: &Path) -> Result<Value, AppError> {
    let input = json!({
        "cwd": workspace_dir.to_string_lossy(),
    });
    let input_path = write_claude_sdk_bridge_input_file(&input)?;
    let output = tokio::time::timeout(Duration::from_secs(20), async {
        let mut command =
            new_provider_hidden_command("node", build_claude_sdk_metadata_args(&input_path)).await;
        command
            .current_dir(workspace_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.output().await
    })
    .await
    .map_err(|_| app_error_from_native(ProviderId::Claude, "SDK metadata discovery timed out"))?
    .map_err(|error| app_error_from_native(ProviderId::Claude, error.to_string()));
    let _ = std::fs::remove_file(&input_path);
    let output = output?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(app_error_from_native(
            ProviderId::Claude,
            if stderr.is_empty() {
                "SDK metadata discovery failed".to_string()
            } else {
                stderr
            },
        ));
    }

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("sdk_metadata") {
            continue;
        }
        return Ok(value);
    }

    Err(app_error_from_native(
        ProviderId::Claude,
        "SDK metadata discovery returned no metadata",
    ))
}

fn claude_sdk_metadata_commands(metadata: &Value) -> Vec<ProviderCommand> {
    metadata
        .get("commands")
        .and_then(Value::as_array)
        .map(|commands| {
            commands
                .iter()
                .filter_map(|command| {
                    let name = command.get("name").and_then(Value::as_str)?;
                    if should_hide_provider_slash_command(ProviderId::Claude, name) {
                        return None;
                    }
                    let description = command
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    Some(ProviderCommand {
                        provider: ProviderId::Claude,
                        name: name.to_string(),
                        description: description.to_string(),
                        kind: SlashCommandKind::Command,
                        source: CapabilitySource::Sdk,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn claude_sdk_metadata_models(metadata: &Value) -> Vec<ProviderModel> {
    metadata
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let id = model.get("value").and_then(Value::as_str)?;
                    let label = model
                        .get("displayName")
                        .and_then(Value::as_str)
                        .or_else(|| model.get("description").and_then(Value::as_str))
                        .unwrap_or(id);
                    Some(ProviderModel {
                        provider: ProviderId::Claude,
                        id: id.to_string(),
                        label: label.to_string(),
                        source: CapabilitySource::Sdk,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

async fn load_claude_sdk_commands(workspace_dir: &Path) -> Result<Vec<ProviderCommand>, AppError> {
    let commands = claude_sdk_metadata_commands(&load_claude_sdk_metadata(workspace_dir).await?);
    if commands.is_empty() {
        return Err(app_error_from_native(
            ProviderId::Claude,
            "SDK command discovery returned no commands",
        ));
    }
    Ok(commands)
}

async fn load_claude_sdk_models(workspace_dir: &Path) -> Result<Vec<ProviderModel>, AppError> {
    let models = claude_sdk_metadata_models(&load_claude_sdk_metadata(workspace_dir).await?);
    if models.is_empty() {
        return Err(app_error_from_native(
            ProviderId::Claude,
            "SDK model discovery returned no models",
        ));
    }
    Ok(models)
}

fn opencode_sdk_bridge_script_path() -> PathBuf {
    repo_root_path()
        .join("scripts")
        .join("opencode-sdk-provider.mjs")
}

fn build_opencode_sdk_bridge_args(input_path: &Path) -> Vec<String> {
    vec![
        opencode_sdk_bridge_script_path()
            .to_string_lossy()
            .to_string(),
        input_path.to_string_lossy().to_string(),
    ]
}

fn build_opencode_sdk_metadata_args(input_path: &Path) -> Vec<String> {
    vec![
        opencode_sdk_bridge_script_path()
            .to_string_lossy()
            .to_string(),
        "--metadata".to_string(),
        input_path.to_string_lossy().to_string(),
    ]
}

fn opencode_image_mime_type(image: &str) -> Option<&'static str> {
    let path = image
        .split(['?', '#'])
        .next()
        .unwrap_or(image)
        .to_ascii_lowercase();
    if path.ends_with(".png") {
        Some("image/png")
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if path.ends_with(".gif") {
        Some("image/gif")
    } else if path.ends_with(".webp") {
        Some("image/webp")
    } else if path.ends_with(".pdf") {
        Some("application/pdf")
    } else {
        None
    }
}

fn resolve_opencode_file_path(workspace_dir: &Path, image: &str) -> String {
    if image.starts_with("http://") || image.starts_with("https://") || image.starts_with("file://")
    {
        image.to_string()
    } else {
        let path = PathBuf::from(image);
        if path.is_absolute() {
            path.to_string_lossy().to_string()
        } else {
            workspace_dir.join(path).to_string_lossy().to_string()
        }
    }
}

fn build_opencode_sdk_bridge_input(
    request: &ProviderTurnRequest,
    workspace_dir: &Path,
) -> Result<Value, AppError> {
    let mut images = Vec::new();
    for image in &request.images {
        let mime = opencode_image_mime_type(image).ok_or_else(|| {
            AppError::BadRequest(format!(
                "OpenCode SDK file input only supports PNG, JPEG, GIF, WebP, or PDF files: {image}"
            ))
        })?;
        let path = resolve_opencode_file_path(workspace_dir, image);
        images.push(json!({
            "path": path,
            "mime": mime,
            "url": if image.starts_with("http://") || image.starts_with("https://") || image.starts_with("file://") {
                Some(image.clone())
            } else {
                None
            },
        }));
    }

    Ok(json!({
        "text": request.text,
        "cwd": workspace_dir.to_string_lossy(),
        "sessionId": request.session_id,
        "threadId": request.thread_id,
        "model": request.model,
        "agent": provider_option_string(&request.provider_options, "agent"),
        "variant": provider_option_string(&request.provider_options, "variant"),
        "forkSession": provider_option_bool(&request.provider_options, "fork"),
        "dangerouslySkipPermissions": provider_option_bool(&request.provider_options, "dangerously_skip_permissions"),
        "autoApprove": provider_option_bool(&request.provider_options, "auto_approve"),
        "autoCompact": request.provider_options
            .get("auto_compact")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        "env": request.provider_options.get("env"),
        "config": request.provider_options.get("config"),
        "images": images,
    }))
}

fn write_opencode_sdk_bridge_input_file(input: &Value) -> Result<PathBuf, AppError> {
    let path = std::env::temp_dir().join(format!("vibex-opencode-sdk-{}.json", Uuid::new_v4()));
    let bytes = serde_json::to_vec(input).map_err(|error| {
        app_error_from_native(
            ProviderId::Opencode,
            format!("failed to serialize SDK bridge input: {error}"),
        )
    })?;
    std::fs::write(&path, bytes).map_err(|error| {
        app_error_from_native(
            ProviderId::Opencode,
            format!(
                "failed to write SDK bridge input {}: {}",
                path.display(),
                error
            ),
        )
    })?;
    Ok(path)
}

async fn load_opencode_sdk_metadata(workspace_dir: &Path) -> Result<Value, AppError> {
    let input = json!({
        "cwd": workspace_dir.to_string_lossy(),
    });
    let input_path = write_opencode_sdk_bridge_input_file(&input)?;
    let output = tokio::time::timeout(Duration::from_secs(30), async {
        let mut command =
            new_provider_hidden_command("node", build_opencode_sdk_metadata_args(&input_path))
                .await;
        command
            .current_dir(workspace_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.output().await
    })
    .await
    .map_err(|_| app_error_from_native(ProviderId::Opencode, "SDK metadata discovery timed out"))?
    .map_err(|error| app_error_from_native(ProviderId::Opencode, error.to_string()));
    let _ = std::fs::remove_file(&input_path);
    let output = output?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(app_error_from_native(
            ProviderId::Opencode,
            if stderr.is_empty() {
                "SDK metadata discovery failed".to_string()
            } else {
                stderr
            },
        ));
    }

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("opencode_sdk_metadata") {
            continue;
        }
        return Ok(value);
    }

    Err(app_error_from_native(
        ProviderId::Opencode,
        "SDK metadata discovery returned no metadata",
    ))
}

fn opencode_sdk_metadata_commands(metadata: &Value) -> Vec<ProviderCommand> {
    metadata
        .get("commands")
        .and_then(Value::as_array)
        .map(|commands| {
            commands
                .iter()
                .filter_map(|command| {
                    let name = command.get("name").and_then(Value::as_str)?;
                    if should_hide_provider_slash_command(ProviderId::Opencode, name) {
                        return None;
                    }
                    let description = command
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    Some(ProviderCommand {
                        provider: ProviderId::Opencode,
                        name: name.to_string(),
                        description: description.to_string(),
                        kind: SlashCommandKind::Command,
                        source: CapabilitySource::Sdk,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn opencode_sdk_metadata_models(metadata: &Value) -> Vec<ProviderModel> {
    metadata
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let id = model.get("id").and_then(Value::as_str)?;
                    let label = model
                        .get("label")
                        .and_then(Value::as_str)
                        .or_else(|| model.get("name").and_then(Value::as_str))
                        .unwrap_or(id);
                    Some(ProviderModel {
                        provider: ProviderId::Opencode,
                        id: id.to_string(),
                        label: label.to_string(),
                        source: CapabilitySource::Sdk,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

async fn load_opencode_sdk_commands(
    workspace_dir: &Path,
) -> Result<Vec<ProviderCommand>, AppError> {
    let commands =
        opencode_sdk_metadata_commands(&load_opencode_sdk_metadata(workspace_dir).await?);
    if commands.is_empty() {
        return Err(app_error_from_native(
            ProviderId::Opencode,
            "SDK command discovery returned no commands",
        ));
    }
    Ok(commands)
}

async fn load_opencode_sdk_models(workspace_dir: &Path) -> Result<Vec<ProviderModel>, AppError> {
    let models = opencode_sdk_metadata_models(&load_opencode_sdk_metadata(workspace_dir).await?);
    if models.is_empty() {
        return Err(app_error_from_native(
            ProviderId::Opencode,
            "SDK model discovery returned no models",
        ));
    }
    Ok(models)
}

fn codex_input_items(request: &ProviderTurnRequest) -> Vec<Value> {
    let mut input = vec![json!({ "type": "text", "text": request.text })];
    for image in &request.images {
        if image.starts_with("http://") || image.starts_with("https://") {
            input.push(json!({ "type": "image", "url": image }));
        } else {
            input.push(json!({ "type": "localImage", "path": image }));
        }
    }
    input
}

fn extract_thread_id(value: &Value) -> Option<String> {
    value
        .get("result")
        .and_then(|result| result.get("threadId"))
        .or_else(|| value.get("threadId"))
        .or_else(|| value.get("session_id"))
        .or_else(|| {
            value
                .get("params")
                .and_then(|params| params.get("threadId"))
        })
        .or_else(|| {
            value
                .get("params")
                .and_then(|params| params.get("thread"))
                .and_then(|thread| thread.get("id"))
        })
        .or_else(|| value.get("sessionID"))
        .or_else(|| {
            value
                .get("properties")
                .and_then(|properties| properties.get("sessionID"))
        })
        .or_else(|| value.get("event").and_then(|event| event.get("sessionID")))
        .or_else(|| {
            value
                .get("event")
                .and_then(|event| event.get("properties"))
                .and_then(|properties| properties.get("sessionID"))
        })
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("info"))
                .and_then(|info| info.get("sessionID"))
        })
        .or_else(|| value.get("event").and_then(|event| event.get("session_id")))
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| result.get("thread"))
                .and_then(|thread| thread.get("id"))
        })
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("result"))
                .and_then(|result| result.get("thread"))
                .and_then(|thread| thread.get("id"))
        })
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn extract_turn_id(value: &Value) -> Option<String> {
    value
        .get("result")
        .and_then(|result| result.get("turnId"))
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| result.get("turn"))
                .and_then(|turn| turn.get("id"))
        })
        .or_else(|| value.get("turnId"))
        .or_else(|| value.get("uuid"))
        .or_else(|| value.get("params").and_then(|params| params.get("turnId")))
        .or_else(|| {
            value
                .get("params")
                .and_then(|params| params.get("turn"))
                .and_then(|turn| turn.get("id"))
        })
        .or_else(|| value.get("turn").and_then(|turn| turn.get("id")))
        .or_else(|| value.get("event").and_then(|event| event.get("uuid")))
        .or_else(|| {
            value
                .get("event")
                .and_then(|event| event.get("turn"))
                .and_then(|turn| turn.get("id"))
        })
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("result"))
                .and_then(|result| result.get("turn"))
                .and_then(|turn| turn.get("id"))
        })
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn codex_runtime_key(workspace_id: &str, workspace_dir: &Path) -> String {
    format!("codex:{workspace_id}:{}", workspace_dir.display())
}

async fn push_provider_event(session_id: &str, event: ProviderRuntimeEvent) {
    let key = event.provider.history_key(session_id);
    PROVIDER_EVENT_HISTORY
        .lock()
        .await
        .entry(key)
        .or_default()
        .push(event);
}

async fn register_native_conversation_sink(
    state: &tauri::State<'_, AppState>,
    process_id: Uuid,
    session_id: Uuid,
) -> NativeConversationSink {
    let msg_store = Arc::new(MsgStore::new());
    state
        .deployment
        .container()
        .msg_stores()
        .write()
        .await
        .insert(process_id, msg_store.clone());

    NativeConversationSink {
        pool: state.deployment.db().pool.clone(),
        process_id,
        session_id,
        msg_store,
        state: Arc::new(Mutex::new(NativeConversationState::default())),
    }
}

async fn persist_native_log_msg(pool: &SqlitePool, process_id: Uuid, msg: &LogMsg) {
    match serde_json::to_string(msg) {
        Ok(json_line) => {
            if let Err(error) =
                ExecutionProcessLogs::append_log_line(pool, process_id, &format!("{json_line}\n"))
                    .await
            {
                tracing::error!(
                    "Failed to persist native provider log for process {}: {}",
                    process_id,
                    error
                );
            }
        }
        Err(error) => {
            tracing::error!(
                "Failed to serialize native provider log for process {}: {}",
                process_id,
                error
            );
        }
    }
}

async fn push_native_log_msg(sink: &NativeConversationSink, msg: LogMsg) {
    sink.msg_store.push(msg.clone());
    persist_native_log_msg(&sink.pool, sink.process_id, &msg).await;
}

fn native_normalized_entry(
    entry_type: NormalizedEntryType,
    content: impl Into<String>,
    metadata: Option<Value>,
) -> NormalizedEntry {
    NormalizedEntry {
        timestamp: None,
        entry_type,
        content: content.into(),
        metadata,
    }
}

fn provider_event_is_user_echo(value: &Value) -> bool {
    value
        .get("event")
        .and_then(|event| event.get("message"))
        .and_then(|message| message.get("role"))
        .or_else(|| value.get("message").and_then(|message| message.get("role")))
        .or_else(|| value.get("role"))
        .and_then(Value::as_str)
        .is_some_and(|role| role.eq_ignore_ascii_case("user"))
}

fn extract_provider_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(extract_provider_text)
                .collect::<Vec<_>>()
                .join("\n");
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        Value::Object(record) => {
            for key in ["text", "delta", "content"] {
                if let Some(text) = record.get(key).and_then(extract_provider_text)
                    && !text.trim().is_empty()
                {
                    return Some(text);
                }
            }
            for key in [
                "message", "parts", "params", "event", "response", "data", "result",
            ] {
                if let Some(text) = record.get(key).and_then(extract_provider_text)
                    && !text.trim().is_empty()
                {
                    return Some(text);
                }
            }
            None
        }
        _ => None,
    }
}

fn extract_provider_stream_text(value: &Value) -> Option<String> {
    let record = value.as_object()?;
    let method = record.get("method").and_then(Value::as_str);
    if method == Some("item/agentMessage/delta") {
        return record
            .get("params")
            .and_then(|params| params.get("delta"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string);
    }

    let event_type = record.get("type").and_then(Value::as_str);
    if event_type == Some("text_delta") {
        return record
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string);
    }

    None
}

fn append_provider_assistant_text(content: &mut String, text: &str, is_stream_delta: bool) {
    if content.is_empty() {
        content.push_str(text);
        return;
    }

    if !is_stream_delta {
        content.push('\n');
    }
    content.push_str(text);
}

fn json_u32(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn token_usage_info(
    total_tokens: Option<u32>,
    context_window: Option<u32>,
) -> Option<TokenUsageInfo> {
    let total_tokens = total_tokens?;
    let model_context_window = context_window?;
    if model_context_window == 0 {
        return None;
    }
    Some(TokenUsageInfo {
        total_tokens,
        model_context_window,
    })
}

fn sum_u32(values: impl IntoIterator<Item = Option<u32>>) -> Option<u32> {
    let mut total = 0u32;
    let mut has_value = false;
    for value in values.into_iter().flatten() {
        total = total.saturating_add(value);
        has_value = true;
    }
    has_value.then_some(total)
}

fn extract_codex_token_usage_info(value: &Value) -> Option<TokenUsageInfo> {
    if value.get("method").and_then(Value::as_str) != Some("thread/tokenUsage/updated") {
        return None;
    }
    let usage = value.get("params")?.get("tokenUsage")?;
    token_usage_info(
        json_u32(
            usage
                .get("total")
                .and_then(|total| total.get("totalTokens")),
        ),
        json_u32(usage.get("modelContextWindow")),
    )
}

fn extract_claude_token_usage_info(value: &Value) -> Option<TokenUsageInfo> {
    if value.get("type").and_then(Value::as_str) != Some("result") {
        return None;
    }
    let usage = value.get("usage")?;
    let total_tokens = json_u32(usage.get("total_tokens")).or_else(|| {
        sum_u32([
            json_u32(usage.get("input_tokens")),
            json_u32(usage.get("output_tokens")),
            json_u32(usage.get("cache_creation_input_tokens")),
            json_u32(usage.get("cache_read_input_tokens")),
        ])
    });
    let context_window = value
        .get("modelUsage")
        .and_then(Value::as_object)
        .and_then(|models| {
            models
                .values()
                .filter_map(|model| json_u32(model.get("contextWindow")))
                .max()
        });

    token_usage_info(total_tokens, context_window)
}

fn extract_opencode_token_usage_info(value: &Value) -> Option<TokenUsageInfo> {
    let tokens = value.get("tokens")?;
    let total_tokens = sum_u32([
        json_u32(tokens.get("input")),
        json_u32(tokens.get("output")),
        json_u32(tokens.get("reasoning")),
        json_u32(tokens.get("cache").and_then(|cache| cache.get("read"))),
        json_u32(tokens.get("cache").and_then(|cache| cache.get("write"))),
    ]);
    let context_window = json_u32(
        value
            .get("model")
            .and_then(|model| model.get("limit"))
            .and_then(|limit| limit.get("context")),
    )
    .or_else(|| json_u32(value.get("limit").and_then(|limit| limit.get("context"))))
    .or_else(|| json_u32(value.get("modelContextWindow")));

    token_usage_info(total_tokens, context_window)
}

fn extract_provider_token_usage_info(value: &Value) -> Option<TokenUsageInfo> {
    extract_codex_token_usage_info(value)
        .or_else(|| extract_claude_token_usage_info(value))
        .or_else(|| extract_opencode_token_usage_info(value))
        .or_else(|| {
            value
                .get("event")
                .and_then(extract_provider_token_usage_info)
        })
        .or_else(|| {
            value
                .get("response")
                .and_then(extract_provider_token_usage_info)
        })
}

fn extract_provider_error(value: &Value) -> Option<String> {
    let record = value.as_object()?;
    let event_type = record
        .get("type")
        .or_else(|| record.get("method"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let looks_like_error = event_type.contains("error") || event_type.contains("stderr");
    if !looks_like_error {
        return None;
    }

    record
        .get("message")
        .or_else(|| record.get("error"))
        .or_else(|| {
            record
                .get("params")
                .and_then(|params| params.get("message"))
        })
        .or_else(|| record.get("params").and_then(|params| params.get("error")))
        .and_then(extract_provider_text)
        .or_else(|| Some(value.to_string()))
}

async fn push_native_provider_event_to_conversation(sink: &NativeConversationSink, event: &Value) {
    if let Some(token_usage) = extract_provider_token_usage_info(event) {
        let mut state = sink.state.lock().await;
        let index = state.next_entry_index;
        state.next_entry_index += 1;
        drop(state);

        let entry = native_normalized_entry(
            NormalizedEntryType::TokenUsageInfo(token_usage),
            "",
            Some(event.clone()),
        );
        push_native_log_msg(
            sink,
            LogMsg::JsonPatch(ConversationPatch::add_normalized_entry(index, entry)),
        )
        .await;
        return;
    }

    if let Some(error) = extract_provider_error(event) {
        let mut state = sink.state.lock().await;
        let index = state.next_entry_index;
        state.next_entry_index += 1;
        drop(state);

        let entry = native_normalized_entry(
            NormalizedEntryType::ErrorMessage {
                error_type: NormalizedEntryError::Other,
            },
            error,
            Some(event.clone()),
        );
        push_native_log_msg(
            sink,
            LogMsg::JsonPatch(ConversationPatch::add_normalized_entry(index, entry)),
        )
        .await;
        return;
    }

    if provider_event_is_user_echo(event) {
        return;
    }

    let (text, is_stream_delta) = if let Some(text) = extract_provider_stream_text(event) {
        (text, true)
    } else if let Some(text) = extract_provider_text(event) {
        (text, false)
    } else {
        return;
    };

    let mut state = sink.state.lock().await;
    append_provider_assistant_text(&mut state.assistant_content, &text, is_stream_delta);

    let index = if state.assistant_written {
        0
    } else {
        state.assistant_written = true;
        state.next_entry_index = state.next_entry_index.max(1);
        0
    };
    let entry = native_normalized_entry(
        NormalizedEntryType::AssistantMessage,
        state.assistant_content.clone(),
        Some(event.clone()),
    );
    let patch = if state.assistant_written && state.assistant_content != text {
        ConversationPatch::replace(index, entry)
    } else {
        ConversationPatch::add_normalized_entry(index, entry)
    };
    drop(state);

    push_native_log_msg(sink, LogMsg::JsonPatch(patch)).await;
}

async fn complete_native_conversation_sink(
    sink: NativeConversationSink,
    status: ExecutionProcessStatus,
    exit_code: Option<i64>,
) {
    if let Err(error) =
        ExecutionProcess::update_completion(&sink.pool, sink.process_id, status, exit_code).await
    {
        tracing::error!(
            "Failed to mark native provider process {} complete: {}",
            sink.process_id,
            error
        );
    }
    if let Err(error) =
        Session::update_status(&sink.pool, sink.session_id, SessionStatus::InReview).await
    {
        tracing::error!(
            "Failed to mark native provider session {} in review: {}",
            sink.session_id,
            error
        );
    }
    sink.msg_store.push_finished();
}

async fn route_codex_event_to_native_conversation(value: &Value) {
    let turn_id = extract_turn_id(value);
    let thread_id = extract_thread_id(value);
    let mut sink = None;
    if let Some(turn_id) = turn_id.as_deref() {
        sink = CODEX_NATIVE_TURN_SINKS.lock().await.get(turn_id).cloned();
    }
    if sink.is_none()
        && let Some(thread_id) = thread_id.as_deref()
    {
        sink = CODEX_NATIVE_THREAD_SINKS
            .lock()
            .await
            .get(thread_id)
            .cloned();
    }
    let Some(sink) = sink else {
        return;
    };

    push_native_provider_event_to_conversation(&sink, value).await;

    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if method == "turn/completed" || method == "turn/error" || method == "error" {
        if let Some(turn_id) = turn_id.as_deref() {
            CODEX_NATIVE_TURN_SINKS.lock().await.remove(turn_id);
        }
        if let Some(thread_id) = thread_id.as_deref() {
            CODEX_NATIVE_THREAD_SINKS.lock().await.remove(thread_id);
        }
        let status = if method == "turn/completed" {
            ExecutionProcessStatus::Completed
        } else {
            ExecutionProcessStatus::Failed
        };
        let exit_code = if status == ExecutionProcessStatus::Completed {
            Some(0)
        } else {
            None
        };
        complete_native_conversation_sink(sink, status, exit_code).await;
    }
}

fn app_error_from_native(provider: ProviderId, error: impl Into<String>) -> AppError {
    AppError::BadRequest(format!(
        "{} native runtime failed: {}",
        provider.label(),
        error.into()
    ))
}

fn provider_fallback_status(provider: ProviderId) -> CapabilityStatus {
    let fallback = acp_fallback_config(provider);
    let contract = provider_runtime_contract(provider);
    if !fallback.enabled {
        let env_name = fallback
            .env_name
            .map(str::to_string)
            .unwrap_or_else(|| contract.global_fallback_env.clone());
        return CapabilityStatus::unavailable(
            contract.fallback_source,
            format!(
                "{} ACP compatibility fallback is disabled by `{}`.",
                provider.label(),
                env_name
            ),
        );
    }

    CapabilityStatus::available(contract.fallback_source).with_detail(format!(
        "{} can still use the provider-scoped ACP compatibility adapter controlled by `{}`.",
        provider.label(),
        contract.fallback_env
    ))
}

impl CapabilityStatus {
    fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

async fn probe_native_runtime(provider: ProviderId) -> CapabilityStatus {
    let contract = provider_runtime_contract(provider);
    let (program, args, expected) = match provider {
        ProviderId::Claude => (
            "node",
            vec![
                claude_sdk_bridge_script_path()
                    .to_string_lossy()
                    .to_string(),
                "--probe".to_string(),
            ],
            "claude-agent-sdk-provider:ok",
        ),
        ProviderId::Codex => (
            "codex",
            vec!["app-server".to_string(), "--help".to_string()],
            "Run the app server",
        ),
        ProviderId::Opencode => (
            "node",
            vec![
                opencode_sdk_bridge_script_path()
                    .to_string_lossy()
                    .to_string(),
                "--probe".to_string(),
            ],
            "opencode-sdk-provider:ok",
        ),
    };

    let output = tokio::time::timeout(Duration::from_secs(4), async move {
        new_provider_hidden_command(program, args)
            .await
            .output()
            .await
    })
    .await;

    match output {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{stdout}\n{stderr}");
            if combined.contains(expected) {
                CapabilityStatus::available(contract.primary_source).with_detail(format!(
                    "{} primary runtime probe passed via `{program}` ({}).",
                    provider.label(),
                    contract.primary_label
                ))
            } else {
                CapabilityStatus::partial(
                    contract.primary_source,
                    format!(
                        "{} was found, but expected primary runtime marker `{expected}` was not present.",
                        provider.label()
                    ),
                )
            }
        }
        Ok(Err(error)) => CapabilityStatus::unavailable(
            contract.primary_source,
            format!(
                "Failed to launch `{program}` for {} primary runtime {}: {error}",
                provider.label(),
                contract.primary_label
            ),
        ),
        Err(_) => CapabilityStatus::unavailable(
            contract.primary_source,
            format!(
                "Timed out probing `{program}` for {} primary runtime {}.",
                provider.label(),
                contract.primary_label
            ),
        ),
    }
}

async fn ensure_provider_session(
    state: &tauri::State<'_, AppState>,
    provider: ProviderId,
    workspace_id: Uuid,
    session_id: Option<&str>,
    initial_prompt: &str,
) -> Result<Session, AppError> {
    let pool = &state.deployment.db().pool;

    if let Some(session_id) = session_id {
        let session_uuid = Uuid::parse_str(session_id)
            .map_err(|_| AppError::BadRequest(format!("Invalid session id: {session_id}")))?;
        let session = Session::find_by_id(pool, session_uuid)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Session {session_id} not found")))?;
        if session.workspace_id != workspace_id {
            return Err(AppError::BadRequest(format!(
                "Session {} does not belong to workspace {}",
                session.id, workspace_id
            )));
        }
        if !session_executor_matches_provider(session.executor.as_deref(), provider) {
            return Err(AppError::BadRequest(format!(
                "Session {} belongs to a different provider",
                session.id
            )));
        }
        return Ok(session);
    }

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))?;

    Session::create(
        pool,
        &CreateSession {
            executor: Some(provider.base_agent().to_string()),
            task_id: Some(workspace.task_id),
            name: Some(format!("{} native provider turn", provider.label())),
            initial_prompt: Some(initial_prompt.to_string()),
            status: Some(SessionStatus::Todo),
        },
        Uuid::new_v4(),
        workspace.id,
    )
    .await
    .map_err(AppError::from)
}

async fn resolve_provider_workspace_dir(
    state: &tauri::State<'_, AppState>,
    workspace: &mut Workspace,
) -> Result<PathBuf, AppError> {
    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(workspace)
        .await?;
    workspace.container_ref = Some(container_ref.clone());
    let repos =
        WorkspaceRepo::find_repos_for_workspace(&state.deployment.db().pool, workspace.id).await?;
    let agent_working_dir = resolve_workspace_agent_working_dir(workspace, &container_ref, &repos);
    state
        .deployment
        .image()
        .copy_images_by_task_to_worktree(
            &PathBuf::from(&container_ref),
            workspace.task_id,
            agent_working_dir.as_deref(),
        )
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(agent_working_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(container_ref)))
}

async fn load_provider_workspace(
    state: &tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Workspace, AppError> {
    Workspace::find_by_id(&state.deployment.db().pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))
}

async fn create_native_execution_process(
    state: &tauri::State<'_, AppState>,
    workspace: &Workspace,
    session: &Session,
    request: &ProviderTurnRequest,
    agent_session_id: Option<String>,
    native_message_id: Option<String>,
) -> Result<ExecutionProcess, AppError> {
    let pool = &state.deployment.db().pool;
    let repositories = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    if repositories.is_empty() {
        return Err(AppError::BadRequest(format!(
            "Workspace {} has no repositories configured",
            workspace.id
        )));
    }

    let workspace_root = workspace
        .container_ref
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| AppError::BadRequest("Workspace container ref not found".to_string()))?;

    let mut repo_states = Vec::with_capacity(repositories.len());
    for repo in &repositories {
        let repo_path = workspace
            .repo_path(repo)
            .unwrap_or_else(|| workspace_root.clone());
        let before_head_commit = state
            .deployment
            .git()
            .get_head_info(&repo_path)
            .ok()
            .map(|head| head.oid);
        repo_states.push(CreateExecutionProcessRepoState {
            repo_id: repo.id,
            before_head_commit,
            after_head_commit: None,
            merge_commit: None,
        });
    }

    let working_dir = resolve_workspace_agent_working_dir(
        workspace,
        workspace_root.to_string_lossy().as_ref(),
        &repositories,
    );
    let executor_config = provider_executor_config(request);
    let action_type = if let Some(agent_session_id) = agent_session_id.clone() {
        ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
            prompt: request.text.clone(),
            session_id: agent_session_id,
            reset_to_message_id: None,
            executor_config,
            working_dir,
        })
    } else {
        ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
            prompt: request.text.clone(),
            executor_config,
            working_dir,
        })
    };
    let action = ExecutorAction::new(action_type, None);
    let process = ExecutionProcess::create(
        pool,
        &CreateExecutionProcess {
            session_id: session.id,
            executor_action: action,
            run_reason: ExecutionProcessRunReason::CodingAgent,
        },
        Uuid::new_v4(),
        &repo_states,
    )
    .await?;

    CodingAgentTurn::create(
        pool,
        &CreateCodingAgentTurn {
            execution_process_id: process.id,
            prompt: Some(request.text.clone()),
        },
        Uuid::new_v4(),
    )
    .await?;

    if let Some(agent_session_id) = agent_session_id.as_deref() {
        CodingAgentTurn::update_agent_session_id(pool, process.id, agent_session_id).await?;
    }
    if let Some(native_message_id) = native_message_id.as_deref() {
        CodingAgentTurn::update_agent_message_id(pool, process.id, native_message_id).await?;
    }
    Session::update_status(pool, session.id, SessionStatus::InProgress).await?;

    Ok(process)
}

fn provider_request_with_resolved_thread_id(
    mut request: ProviderTurnRequest,
    latest_session_id: Option<String>,
) -> ProviderTurnRequest {
    if request.thread_id.is_none() {
        request.thread_id = latest_session_id;
    }
    request
}

async fn resolve_native_provider_request(
    pool: &SqlitePool,
    session: &Session,
    request: ProviderTurnRequest,
) -> Result<ProviderTurnRequest, AppError> {
    if request.thread_id.is_some() {
        return Ok(request);
    }

    let latest_session_id = CodingAgentTurn::find_latest_session_info(pool, session.id)
        .await?
        .map(|info| info.session_id);
    Ok(provider_request_with_resolved_thread_id(
        request,
        latest_session_id,
    ))
}

async fn send_codex_request(
    server: &Arc<CodexAppServer>,
    method: &str,
    params: Value,
    timeout_duration: Duration,
) -> Result<Value, String> {
    let id = server.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    server.pending.lock().await.insert(id, tx);

    let write_result = async {
        let mut stdin = server.stdin.lock().await;
        let mut line = serde_json::to_string(&json!({
            "id": id,
            "method": method,
            "params": params,
        }))
        .map_err(|error| error.to_string())?;
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|error| error.to_string())
    }
    .await;

    if let Err(error) = write_result {
        server.pending.lock().await.remove(&id);
        return Err(error);
    }

    match tokio::time::timeout(timeout_duration, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            server.pending.lock().await.remove(&id);
            Err("request canceled".to_string())
        }
        Err(_) => {
            server.pending.lock().await.remove(&id);
            Err(format!("request `{method}` timed out"))
        }
    }
}

async fn send_codex_notification(
    server: &Arc<CodexAppServer>,
    method: &str,
    params: Option<Value>,
) -> Result<(), String> {
    let mut stdin = server.stdin.lock().await;
    let mut message = serde_json::Map::new();
    message.insert("method".to_string(), json!(method));
    if let Some(params) = params {
        message.insert("params".to_string(), params);
    }
    let mut line = serde_json::to_string(&Value::Object(message)).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

async fn send_codex_response(
    server: &Arc<CodexAppServer>,
    request_id: &str,
    response: Value,
) -> Result<(), String> {
    let id = request_id
        .parse::<u64>()
        .map(Value::from)
        .unwrap_or_else(|_| Value::String(request_id.to_string()));
    let mut stdin = server.stdin.lock().await;
    let mut line = serde_json::to_string(&json!({
        "id": id,
        "result": response,
    }))
    .map_err(|error| error.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| error.to_string())
}

fn spawn_codex_app_server_readers(
    server: Arc<CodexAppServer>,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    session_id: String,
) {
    let stdout_server = server.clone();
    let stdout_session_id = session_id.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(error) => {
                    push_provider_event(
                        &stdout_session_id,
                        ProviderRuntimeEvent {
                            provider: ProviderId::Codex,
                            workspace_id: stdout_server.workspace_id.clone(),
                            thread_id: None,
                            turn_id: None,
                            event: json!({
                                "method": "codex/parse_error",
                                "params": { "error": error.to_string(), "raw": line },
                            }),
                        },
                    )
                    .await;
                    continue;
                }
            };

            let id = value
                .get("id")
                .and_then(|id| id.as_u64().or_else(|| id.as_str()?.parse().ok()));
            let has_response = value.get("result").is_some() || value.get("error").is_some();
            if let Some(id) = id
                && has_response
            {
                if let Some(tx) = stdout_server.pending.lock().await.remove(&id) {
                    let _ = tx.send(Ok(value));
                }
                continue;
            }

            if value.get("method").is_some() {
                push_provider_event(
                    &stdout_session_id,
                    ProviderRuntimeEvent {
                        provider: ProviderId::Codex,
                        workspace_id: stdout_server.workspace_id.clone(),
                        thread_id: extract_thread_id(&value),
                        turn_id: extract_turn_id(&value),
                        event: value.clone(),
                    },
                )
                .await;
                route_codex_event_to_native_conversation(&value).await;
            }
        }
    });

    let stderr_server = server.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            push_provider_event(
                &session_id,
                ProviderRuntimeEvent {
                    provider: ProviderId::Codex,
                    workspace_id: stderr_server.workspace_id.clone(),
                    thread_id: None,
                    turn_id: None,
                    event: json!({
                        "method": "codex/stderr",
                        "params": { "message": line },
                    }),
                },
            )
            .await;
        }
    });
}

async fn ensure_codex_app_server(
    request: &ProviderTurnRequest,
    workspace_id: Uuid,
    workspace_dir: &Path,
    session_id: &str,
) -> Result<Arc<CodexAppServer>, String> {
    let key = codex_runtime_key(&workspace_id.to_string(), workspace_dir);
    if let Some(server) = CODEX_APP_SERVERS.lock().await.get(&key).cloned() {
        let process_alive = server
            .child
            .lock()
            .await
            .try_wait()
            .map(|status| status.is_none())
            .unwrap_or(false);
        if process_alive
            && send_codex_request(&server, "model/list", json!({}), Duration::from_secs(4))
                .await
                .is_ok()
        {
            return Ok(server);
        }
        CODEX_APP_SERVERS.lock().await.remove(&key);
    }

    let mut command_args = vec!["app-server".to_string()];
    if let Some(listen) = provider_option_string(&request.provider_options, "listen") {
        command_args.push("--listen".to_string());
        command_args.push(listen.to_string());
    }

    let mut command = new_provider_hidden_command("codex", command_args).await;
    command
        .current_dir(workspace_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdin = child.stdin.take().ok_or("missing codex app-server stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("missing codex app-server stdout")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("missing codex app-server stderr")?;

    let server = Arc::new(CodexAppServer {
        workspace_id: workspace_id.to_string(),
        workspace_dir: workspace_dir.to_path_buf(),
        child: Arc::new(Mutex::new(child)),
        stdin: Arc::new(Mutex::new(stdin)),
        pending: Arc::new(Mutex::new(HashMap::new())),
        next_id: AtomicU64::new(1),
    });

    spawn_codex_app_server_readers(server.clone(), stdout, stderr, session_id.to_string());
    let init_params = json!({
        "clientInfo": {
            "name": "vibex",
            "title": "VibeX",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "capabilities": {
            "experimentalApi": true,
        },
    });
    let init_response = send_codex_request(
        &server,
        "initialize",
        init_params,
        Duration::from_secs(CODEX_INITIALIZE_TIMEOUT_SECS),
    )
    .await?;
    if let Some(error) = init_response.get("error") {
        return Err(format!("initialize failed: {error}"));
    }
    send_codex_notification(&server, "initialized", None).await?;

    CODEX_APP_SERVERS.lock().await.insert(key, server.clone());
    Ok(server)
}

async fn start_codex_native_turn(
    state: &tauri::State<'_, AppState>,
    request: ProviderTurnRequest,
    workspace: &Workspace,
    workspace_dir: PathBuf,
    session: &Session,
) -> Result<ProviderRuntimeEvent, AppError> {
    let request =
        resolve_native_provider_request(&state.deployment.db().pool, session, request).await?;
    let workspace_id = workspace.id;
    let queued_turn_id = Uuid::new_v4().to_string();
    let process = create_native_execution_process(
        state,
        workspace,
        session,
        &request,
        request.thread_id.clone(),
        Some(queued_turn_id.clone()),
    )
    .await?;
    let conversation_sink = register_native_conversation_sink(state, process.id, session.id).await;
    CODEX_NATIVE_TURN_SINKS
        .lock()
        .await
        .insert(queued_turn_id.clone(), conversation_sink.clone());

    let event = ProviderRuntimeEvent {
        provider: ProviderId::Codex,
        workspace_id: workspace_id.to_string(),
        thread_id: request.thread_id.clone(),
        turn_id: Some(queued_turn_id.clone()),
        event: json!({
            "method": "turn/queued",
            "runtime_source": "native_app_server",
            "execution_process_id": process.id,
            "session_id": session.id,
        }),
    };
    push_provider_event(&session.id.to_string(), event.clone()).await;

    let pool = state.deployment.db().pool.clone();
    let session_id = session.id;
    let session_id_string = session.id.to_string();
    let workspace_id_string = workspace_id.to_string();
    let process_id = process.id;
    tokio::spawn(async move {
        let codex_options = resolve_codex_runtime_options(&request, &workspace_dir);
        let failure_event = |message: String| {
            json!({
                "method": "turn/error",
                "runtime_source": "native_app_server",
                "error": message,
            })
        };
        let mut final_thread_id = request.thread_id.clone();
        let mut final_turn_id = queued_turn_id.clone();

        let server = match ensure_codex_app_server(
            &request,
            workspace_id,
            &workspace_dir,
            &session_id_string,
        )
        .await
        {
            Ok(server) => server,
            Err(error) => {
                let event = failure_event(error);
                push_provider_event(
                    &session_id_string,
                    ProviderRuntimeEvent {
                        provider: ProviderId::Codex,
                        workspace_id: workspace_id_string.clone(),
                        thread_id: final_thread_id.clone(),
                        turn_id: Some(final_turn_id.clone()),
                        event: event.clone(),
                    },
                )
                .await;
                push_native_provider_event_to_conversation(&conversation_sink, &event).await;
                CODEX_NATIVE_TURN_SINKS.lock().await.remove(&final_turn_id);
                complete_native_conversation_sink(
                    conversation_sink,
                    ExecutionProcessStatus::Failed,
                    None,
                )
                .await;
                return;
            }
        };

        let thread_result: Result<String, String> = match request.thread_id.clone() {
            Some(thread_id) if provider_option_bool(&request.provider_options, "fork") => {
                let mut fork_params = serde_json::Map::new();
                fork_params.insert("threadId".to_string(), json!(thread_id));
                if let Some(message_id) =
                    provider_option_string(&request.provider_options, "message_id")
                {
                    fork_params.insert("messageId".to_string(), json!(message_id));
                }
                match send_codex_request(
                    &server,
                    "thread/fork",
                    Value::Object(fork_params),
                    Duration::from_secs(CODEX_REQUEST_TIMEOUT_SECS),
                )
                .await
                {
                    Ok(response) if response.get("error").is_some() => {
                        Err(format!("thread/fork failed: {}", response["error"]))
                    }
                    Ok(response) => extract_thread_id(&response).ok_or_else(|| {
                        format!("thread/fork did not return a thread id: {response}")
                    }),
                    Err(error) => Err(error),
                }
            }
            Some(thread_id) => {
                match send_codex_request(
                    &server,
                    "thread/resume",
                    json!({ "threadId": thread_id }),
                    Duration::from_secs(CODEX_REQUEST_TIMEOUT_SECS),
                )
                .await
                {
                    Ok(response) if response.get("error").is_some() => {
                        Err(format!("thread/resume failed: {}", response["error"]))
                    }
                    Ok(response) => Ok(extract_thread_id(&response).unwrap_or(thread_id)),
                    Err(error) => Err(error),
                }
            }
            None => {
                let mut params = serde_json::Map::new();
                params.insert("cwd".to_string(), json!(workspace_dir.to_string_lossy()));
                params.insert(
                    "approvalPolicy".to_string(),
                    json!(codex_options.approval_policy.as_str()),
                );
                params.insert(
                    "sandboxPolicy".to_string(),
                    codex_options.sandbox_policy.clone(),
                );
                if let Some(model) = codex_options.model.as_deref() {
                    params.insert("model".to_string(), json!(model));
                }
                match send_codex_request(
                    &server,
                    "thread/start",
                    Value::Object(params),
                    Duration::from_secs(CODEX_REQUEST_TIMEOUT_SECS),
                )
                .await
                {
                    Ok(response) if response.get("error").is_some() => {
                        Err(format!("thread/start failed: {}", response["error"]))
                    }
                    Ok(response) => extract_thread_id(&response).ok_or_else(|| {
                        format!("thread/start did not return a thread id: {response}")
                    }),
                    Err(error) => Err(error),
                }
            }
        };

        let thread_id = match thread_result {
            Ok(thread_id) => thread_id,
            Err(error) => {
                let event = failure_event(error);
                push_provider_event(
                    &session_id_string,
                    ProviderRuntimeEvent {
                        provider: ProviderId::Codex,
                        workspace_id: workspace_id_string.clone(),
                        thread_id: final_thread_id.clone(),
                        turn_id: Some(final_turn_id.clone()),
                        event: event.clone(),
                    },
                )
                .await;
                push_native_provider_event_to_conversation(&conversation_sink, &event).await;
                CODEX_NATIVE_TURN_SINKS.lock().await.remove(&final_turn_id);
                complete_native_conversation_sink(
                    conversation_sink,
                    ExecutionProcessStatus::Failed,
                    None,
                )
                .await;
                return;
            }
        };
        final_thread_id = Some(thread_id.clone());
        CODEX_NATIVE_THREAD_SINKS
            .lock()
            .await
            .insert(thread_id.clone(), conversation_sink.clone());
        if let Err(error) =
            CodingAgentTurn::update_agent_session_id(&pool, process_id, &thread_id).await
        {
            tracing::error!(
                "Failed to persist Codex app-server thread id for process {}: {}",
                process_id,
                error
            );
        }

        let mut params = serde_json::Map::new();
        params.insert("threadId".to_string(), json!(thread_id));
        params.insert(
            "cwd".to_string(),
            json!(server.workspace_dir.to_string_lossy()),
        );
        params.insert(
            "approvalPolicy".to_string(),
            json!(codex_options.approval_policy.as_str()),
        );
        params.insert(
            "sandboxPolicy".to_string(),
            codex_options.sandbox_policy.clone(),
        );
        if let Some(model) = codex_options.model.as_deref() {
            params.insert("model".to_string(), json!(model));
        }
        if let Some(effort) = codex_options.effort.as_deref() {
            params.insert("effort".to_string(), json!(effort));
        }
        if let Some(collaboration_mode) =
            provider_option_string(&request.provider_options, "collaboration_mode")
        {
            params.insert(
                "collaborationMode".to_string(),
                json!({ "id": collaboration_mode }),
            );
        }
        params.insert(
            "input".to_string(),
            Value::Array(codex_input_items(&request)),
        );

        let response = match send_codex_request(
            &server,
            "turn/start",
            Value::Object(params),
            Duration::from_secs(CODEX_REQUEST_TIMEOUT_SECS),
        )
        .await
        {
            Ok(response) if response.get("error").is_some() => {
                let event = failure_event(format!("turn/start failed: {}", response["error"]));
                push_provider_event(
                    &session_id_string,
                    ProviderRuntimeEvent {
                        provider: ProviderId::Codex,
                        workspace_id: workspace_id_string.clone(),
                        thread_id: final_thread_id.clone(),
                        turn_id: Some(final_turn_id.clone()),
                        event: event.clone(),
                    },
                )
                .await;
                push_native_provider_event_to_conversation(&conversation_sink, &event).await;
                CODEX_NATIVE_TURN_SINKS.lock().await.remove(&final_turn_id);
                if let Some(thread_id) = final_thread_id.as_deref() {
                    CODEX_NATIVE_THREAD_SINKS.lock().await.remove(thread_id);
                }
                complete_native_conversation_sink(
                    conversation_sink,
                    ExecutionProcessStatus::Failed,
                    None,
                )
                .await;
                return;
            }
            Ok(response) => response,
            Err(error) => {
                let event = failure_event(error);
                push_provider_event(
                    &session_id_string,
                    ProviderRuntimeEvent {
                        provider: ProviderId::Codex,
                        workspace_id: workspace_id_string.clone(),
                        thread_id: final_thread_id.clone(),
                        turn_id: Some(final_turn_id.clone()),
                        event: event.clone(),
                    },
                )
                .await;
                push_native_provider_event_to_conversation(&conversation_sink, &event).await;
                CODEX_NATIVE_TURN_SINKS.lock().await.remove(&final_turn_id);
                if let Some(thread_id) = final_thread_id.as_deref() {
                    CODEX_NATIVE_THREAD_SINKS.lock().await.remove(thread_id);
                }
                complete_native_conversation_sink(
                    conversation_sink,
                    ExecutionProcessStatus::Failed,
                    None,
                )
                .await;
                return;
            }
        };

        if let Some(turn_id) = extract_turn_id(&response) {
            final_turn_id = turn_id;
            CODEX_NATIVE_TURN_SINKS.lock().await.remove(&queued_turn_id);
            CODEX_NATIVE_TURN_SINKS
                .lock()
                .await
                .insert(final_turn_id.clone(), conversation_sink.clone());
            if let Err(error) =
                CodingAgentTurn::update_agent_message_id(&pool, process_id, &final_turn_id).await
            {
                tracing::error!(
                    "Failed to persist Codex app-server turn id for process {}: {}",
                    process_id,
                    error
                );
            }
        }

        let event = ProviderRuntimeEvent {
            provider: ProviderId::Codex,
            workspace_id: workspace_id.to_string(),
            thread_id: final_thread_id.clone(),
            turn_id: Some(final_turn_id),
            event: json!({
                "method": "turn/started",
                "runtime_source": "native_app_server",
                "execution_process_id": process_id,
                "session_id": session_id,
                "response": response,
            }),
        };
        push_provider_event(&session_id_string, event).await;
    });

    Ok(event)
}

async fn start_claude_sdk_native_turn(
    state: &tauri::State<'_, AppState>,
    request: ProviderTurnRequest,
    workspace: &Workspace,
    workspace_dir: PathBuf,
    session: &Session,
) -> Result<ProviderRuntimeEvent, AppError> {
    let request =
        resolve_native_provider_request(&state.deployment.db().pool, session, request).await?;
    let provider = ProviderId::Claude;
    let workspace_id = workspace.id;
    let turn_id = Uuid::new_v4().to_string();
    let bridge_input = build_claude_sdk_bridge_input(&request, &workspace_dir)?;
    let bridge_input_path = write_claude_sdk_bridge_input_file(&bridge_input)?;
    let program = "node";
    let args = build_claude_sdk_bridge_args(&bridge_input_path);
    let runtime_source = "native_claude_agent_sdk";

    let mut command = new_provider_hidden_command(program, args.clone()).await;
    command
        .current_dir(&workspace_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        let _ = std::fs::remove_file(&bridge_input_path);
        app_error_from_native(provider, error.to_string())
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| app_error_from_native(provider, "missing stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| app_error_from_native(provider, "missing stderr"))?;
    let child = Arc::new(Mutex::new(child));
    let process = create_native_execution_process(
        state,
        workspace,
        session,
        &request,
        request.thread_id.clone(),
        Some(turn_id.clone()),
    )
    .await?;
    let conversation_sink = register_native_conversation_sink(state, process.id, session.id).await;

    NATIVE_ACTIVE_TURNS.lock().await.insert(
        turn_id.clone(),
        NativeProcessHandle {
            provider,
            child: child.clone(),
        },
    );

    let event = ProviderRuntimeEvent {
        provider,
        workspace_id: workspace_id.to_string(),
        thread_id: request.thread_id.clone(),
        turn_id: Some(turn_id.clone()),
        event: json!({
            "type": "execution_started",
            "runtime_source": runtime_source,
            "execution_process_id": process.id,
            "session_id": session.id,
            "program": program,
            "args": args,
        }),
    };
    push_provider_event(&session.id.to_string(), event.clone()).await;

    let stdout_session_id = session.id.to_string();
    let stdout_workspace_id = workspace_id.to_string();
    let stdout_thread_id = request.thread_id.clone();
    let stdout_turn_id = turn_id.clone();
    let stdout_pool = state.deployment.db().pool.clone();
    let stdout_process_id = process.id;
    let stdout_sink = conversation_sink.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let parsed = serde_json::from_str::<Value>(&line).unwrap_or_else(|_| {
                json!({
                    "type": "text_delta",
                    "text": line,
                })
            });
            if let Some(thread_id) = extract_thread_id(&parsed)
                && let Err(error) = CodingAgentTurn::update_agent_session_id(
                    &stdout_pool,
                    stdout_process_id,
                    &thread_id,
                )
                .await
            {
                tracing::error!(
                    "Failed to persist Claude SDK session id for process {}: {}",
                    stdout_process_id,
                    error
                );
            }
            push_provider_event(
                &stdout_session_id,
                ProviderRuntimeEvent {
                    provider,
                    workspace_id: stdout_workspace_id.clone(),
                    thread_id: extract_thread_id(&parsed).or_else(|| stdout_thread_id.clone()),
                    turn_id: extract_turn_id(&parsed).or_else(|| Some(stdout_turn_id.clone())),
                    event: parsed.clone(),
                },
            )
            .await;
            push_native_provider_event_to_conversation(&stdout_sink, &parsed).await;
        }
    });

    let stderr_session_id = session.id.to_string();
    let stderr_workspace_id = workspace_id.to_string();
    let stderr_turn_id = turn_id.clone();
    let stderr_sink = conversation_sink.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            push_provider_event(
                &stderr_session_id,
                ProviderRuntimeEvent {
                    provider,
                    workspace_id: stderr_workspace_id.clone(),
                    thread_id: None,
                    turn_id: Some(stderr_turn_id.clone()),
                    event: json!({
                        "type": "stderr",
                        "message": line,
                    }),
                },
            )
            .await;
            push_native_provider_event_to_conversation(
                &stderr_sink,
                &json!({
                    "type": "stderr",
                    "message": line,
                }),
            )
            .await;
        }
    });

    let wait_session_id = session.id.to_string();
    let wait_workspace_id = workspace_id.to_string();
    let wait_turn_id = turn_id.clone();
    let wait_pool = state.deployment.db().pool.clone();
    let wait_process_id = process.id;
    let wait_session_uuid = session.id;
    let wait_msg_stores = state.deployment.container().msg_stores().clone();
    tokio::spawn(async move {
        let status = child.lock().await.wait().await;
        let _ = std::fs::remove_file(&bridge_input_path);
        NATIVE_ACTIVE_TURNS.lock().await.remove(&wait_turn_id);
        let (event, process_status, exit_code) = match status {
            Ok(status) if status.success() => (
                json!({
                    "method": "turn/completed",
                    "runtime_source": runtime_source,
                    "exit_code": status.code(),
                }),
                ExecutionProcessStatus::Completed,
                status.code().map(i64::from),
            ),
            Ok(status) => (
                json!({
                    "method": "turn/error",
                    "runtime_source": runtime_source,
                    "exit_code": status.code(),
                }),
                ExecutionProcessStatus::Failed,
                status.code().map(i64::from),
            ),
            Err(error) => (
                json!({
                    "method": "turn/error",
                    "runtime_source": runtime_source,
                    "error": error.to_string(),
                }),
                ExecutionProcessStatus::Failed,
                None,
            ),
        };
        if let Err(error) = ExecutionProcess::update_completion(
            &wait_pool,
            wait_process_id,
            process_status,
            exit_code,
        )
        .await
        {
            tracing::error!(
                "Failed to mark native provider process {} complete: {}",
                wait_process_id,
                error
            );
        }
        if let Err(error) =
            Session::update_status(&wait_pool, wait_session_uuid, SessionStatus::InReview).await
        {
            tracing::error!(
                "Failed to mark native provider session {} in review: {}",
                wait_session_uuid,
                error
            );
        }
        push_provider_event(
            &wait_session_id,
            ProviderRuntimeEvent {
                provider,
                workspace_id: wait_workspace_id,
                thread_id: None,
                turn_id: Some(wait_turn_id),
                event,
            },
        )
        .await;
        if let Some(msg_store) = wait_msg_stores.write().await.remove(&wait_process_id) {
            msg_store.push_finished();
        }
    });

    Ok(event)
}

async fn start_opencode_sdk_native_turn(
    state: &tauri::State<'_, AppState>,
    request: ProviderTurnRequest,
    workspace: &Workspace,
    workspace_dir: PathBuf,
    session: &Session,
) -> Result<ProviderRuntimeEvent, AppError> {
    let request =
        resolve_native_provider_request(&state.deployment.db().pool, session, request).await?;
    let provider = ProviderId::Opencode;
    let workspace_id = workspace.id;
    let turn_id = Uuid::new_v4().to_string();
    let bridge_input = build_opencode_sdk_bridge_input(&request, &workspace_dir)?;
    let bridge_input_path = write_opencode_sdk_bridge_input_file(&bridge_input)?;
    let program = "node";
    let args = build_opencode_sdk_bridge_args(&bridge_input_path);
    let runtime_source = "native_opencode_sdk";

    let mut command = new_provider_hidden_command(program, args.clone()).await;
    command
        .current_dir(&workspace_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        let _ = std::fs::remove_file(&bridge_input_path);
        app_error_from_native(provider, error.to_string())
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| app_error_from_native(provider, "missing stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| app_error_from_native(provider, "missing stderr"))?;
    let child = Arc::new(Mutex::new(child));
    let process = create_native_execution_process(
        state,
        workspace,
        session,
        &request,
        request.thread_id.clone(),
        Some(turn_id.clone()),
    )
    .await?;
    let conversation_sink = register_native_conversation_sink(state, process.id, session.id).await;

    NATIVE_ACTIVE_TURNS.lock().await.insert(
        turn_id.clone(),
        NativeProcessHandle {
            provider,
            child: child.clone(),
        },
    );

    let event = ProviderRuntimeEvent {
        provider,
        workspace_id: workspace_id.to_string(),
        thread_id: request.thread_id.clone(),
        turn_id: Some(turn_id.clone()),
        event: json!({
            "type": "execution_started",
            "runtime_source": runtime_source,
            "execution_process_id": process.id,
            "session_id": session.id,
            "program": program,
            "args": args,
        }),
    };
    push_provider_event(&session.id.to_string(), event.clone()).await;

    let stdout_session_id = session.id.to_string();
    let stdout_workspace_id = workspace_id.to_string();
    let stdout_thread_id = request.thread_id.clone();
    let stdout_turn_id = turn_id.clone();
    let stdout_pool = state.deployment.db().pool.clone();
    let stdout_process_id = process.id;
    let stdout_sink = conversation_sink.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let parsed = serde_json::from_str::<Value>(&line).unwrap_or_else(|_| {
                json!({
                    "type": "text_delta",
                    "text": line,
                })
            });
            if let Some(thread_id) = extract_thread_id(&parsed)
                && let Err(error) = CodingAgentTurn::update_agent_session_id(
                    &stdout_pool,
                    stdout_process_id,
                    &thread_id,
                )
                .await
            {
                tracing::error!(
                    "Failed to persist OpenCode SDK session id for process {}: {}",
                    stdout_process_id,
                    error
                );
            }
            push_provider_event(
                &stdout_session_id,
                ProviderRuntimeEvent {
                    provider,
                    workspace_id: stdout_workspace_id.clone(),
                    thread_id: extract_thread_id(&parsed).or_else(|| stdout_thread_id.clone()),
                    turn_id: extract_turn_id(&parsed).or_else(|| Some(stdout_turn_id.clone())),
                    event: parsed.clone(),
                },
            )
            .await;
            push_native_provider_event_to_conversation(&stdout_sink, &parsed).await;
        }
    });

    let stderr_session_id = session.id.to_string();
    let stderr_workspace_id = workspace_id.to_string();
    let stderr_turn_id = turn_id.clone();
    let stderr_sink = conversation_sink.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            push_provider_event(
                &stderr_session_id,
                ProviderRuntimeEvent {
                    provider,
                    workspace_id: stderr_workspace_id.clone(),
                    thread_id: None,
                    turn_id: Some(stderr_turn_id.clone()),
                    event: json!({
                        "type": "stderr",
                        "message": line,
                    }),
                },
            )
            .await;
            push_native_provider_event_to_conversation(
                &stderr_sink,
                &json!({
                    "type": "stderr",
                    "message": line,
                }),
            )
            .await;
        }
    });

    let wait_session_id = session.id.to_string();
    let wait_workspace_id = workspace_id.to_string();
    let wait_turn_id = turn_id.clone();
    let wait_pool = state.deployment.db().pool.clone();
    let wait_process_id = process.id;
    let wait_session_uuid = session.id;
    let wait_msg_stores = state.deployment.container().msg_stores().clone();
    tokio::spawn(async move {
        let status = child.lock().await.wait().await;
        let _ = std::fs::remove_file(&bridge_input_path);
        NATIVE_ACTIVE_TURNS.lock().await.remove(&wait_turn_id);
        let (event, process_status, exit_code) = match status {
            Ok(status) if status.success() => (
                json!({
                    "method": "turn/completed",
                    "runtime_source": runtime_source,
                    "exit_code": status.code(),
                }),
                ExecutionProcessStatus::Completed,
                status.code().map(i64::from),
            ),
            Ok(status) => (
                json!({
                    "method": "turn/error",
                    "runtime_source": runtime_source,
                    "exit_code": status.code(),
                }),
                ExecutionProcessStatus::Failed,
                status.code().map(i64::from),
            ),
            Err(error) => (
                json!({
                    "method": "turn/error",
                    "runtime_source": runtime_source,
                    "error": error.to_string(),
                }),
                ExecutionProcessStatus::Failed,
                None,
            ),
        };
        if let Err(error) = ExecutionProcess::update_completion(
            &wait_pool,
            wait_process_id,
            process_status,
            exit_code,
        )
        .await
        {
            tracing::error!(
                "Failed to mark native provider process {} complete: {}",
                wait_process_id,
                error
            );
        }
        if let Err(error) =
            Session::update_status(&wait_pool, wait_session_uuid, SessionStatus::InReview).await
        {
            tracing::error!(
                "Failed to mark native provider session {} in review: {}",
                wait_session_uuid,
                error
            );
        }
        push_provider_event(
            &wait_session_id,
            ProviderRuntimeEvent {
                provider,
                workspace_id: wait_workspace_id,
                thread_id: None,
                turn_id: Some(wait_turn_id),
                event,
            },
        )
        .await;
        if let Some(msg_store) = wait_msg_stores.write().await.remove(&wait_process_id) {
            msg_store.push_finished();
        }
    });

    Ok(event)
}

async fn try_native_provider_turn(
    state: &tauri::State<'_, AppState>,
    mut request: ProviderTurnRequest,
    workspace_id: Uuid,
    session: &Session,
) -> Result<ProviderRuntimeEvent, AppError> {
    if should_force_acp_fallback(&request) {
        return Err(app_error_from_native(
            request.provider,
            "native runtime disabled by provider option `force_acp_fallback`",
        ));
    }

    apply_profile_defaults_to_request(&mut request);
    let mut workspace = load_provider_workspace(state, workspace_id).await?;
    let workspace_dir = resolve_provider_workspace_dir(state, &mut workspace).await?;
    match request.provider {
        ProviderId::Codex => {
            start_codex_native_turn(state, request, &workspace, workspace_dir, session).await
        }
        ProviderId::Claude => {
            start_claude_sdk_native_turn(state, request, &workspace, workspace_dir, session).await
        }
        ProviderId::Opencode => {
            start_opencode_sdk_native_turn(state, request, &workspace, workspace_dir, session).await
        }
    }
}

async fn fallback_acp_turn(
    state: tauri::State<'_, AppState>,
    request: ProviderTurnRequest,
    workspace_id: Uuid,
    session: Session,
    native_error: Option<String>,
) -> Result<ProviderRuntimeEvent, AppError> {
    let fallback = acp_fallback_config(request.provider);
    if !fallback.enabled {
        let env_name = fallback.env_name.unwrap_or(ACP_FALLBACK_ENV);
        let native_error = native_error.unwrap_or_else(|| "native runtime unavailable".to_string());
        return Err(AppError::BadRequest(format!(
            "{} ACP fallback is disabled by `{}`; native runtime error: {}",
            request.provider.label(),
            env_name,
            native_error
        )));
    }

    let executor_profile_id = provider_executor_profile_id(&request);
    let process = crate::commands::sessions::follow_up(
        state,
        session.id,
        request.text.clone(),
        executor_profile_id,
        None,
        None,
        None,
    )
    .await?;

    let mut payload = json!({
        "type": "execution_started",
        "runtime_source": "acp_fallback",
        "execution_process_id": process.id,
        "session_id": session.id,
        "provider": request.provider,
    });
    if let Some(native_error) = native_error
        && let Some(object) = payload.as_object_mut()
    {
        object.insert("fallback_reason".to_string(), json!(native_error));
    }

    Ok(ProviderRuntimeEvent {
        provider: request.provider,
        workspace_id: workspace_id.to_string(),
        thread_id: request.thread_id,
        turn_id: Some(process.id.to_string()),
        event: payload,
    })
}

async fn load_provider_history_from_db(
    state: &tauri::State<'_, AppState>,
    provider: ProviderId,
    loader: &str,
    session: Session,
) -> Result<ProviderHistorySnapshot, AppError> {
    let pool = &state.deployment.db().pool;
    let session_id = session.id.to_string();
    let in_memory_events = PROVIDER_EVENT_HISTORY
        .lock()
        .await
        .get(&provider.history_key(&session_id))
        .cloned()
        .unwrap_or_default();
    let processes = ExecutionProcess::find_by_session_id(pool, session.id, false).await?;

    let mut turns = Vec::new();
    for process in processes {
        let turn = CodingAgentTurn::find_by_execution_process_id(pool, process.id).await?;
        let raw_logs = ExecutionProcessLogs::find_by_execution_id(pool, process.id).await?;
        let parsed_logs = ExecutionProcessLogs::parse_logs(&raw_logs).unwrap_or_default();
        let log_count = parsed_logs.len();
        let log_preview: Vec<Value> = parsed_logs
            .into_iter()
            .take(24)
            .map(|entry| match entry {
                LogMsg::Stdout(value) => json!({ "type": "stdout", "value": value }),
                LogMsg::Stderr(value) => json!({ "type": "stderr", "value": value }),
                LogMsg::SessionId(value) => json!({ "type": "session_id", "value": value }),
                LogMsg::MessageId(value) => json!({ "type": "message_id", "value": value }),
                LogMsg::Ready => json!({ "type": "ready" }),
                LogMsg::Finished => json!({ "type": "finished" }),
                LogMsg::JsonPatch(value) => json!({ "type": "json_patch", "value": value }),
            })
            .collect();
        turns.push(json!({
            "execution_process": {
                "id": process.id,
                "status": process.status,
                "run_reason": process.run_reason,
                "started_at": process.started_at,
                "completed_at": process.completed_at,
            },
            "turn": turn,
            "raw_log_count": log_count,
            "raw_log_preview": log_preview,
        }));
    }

    Ok(ProviderHistorySnapshot {
        provider,
        session_id,
        events: in_memory_events,
        raw: Some(json!({
            "source": loader,
            "provider": provider,
            "session": {
                "id": session.id,
                "workspace_id": session.workspace_id,
                "name": session.name,
                "status": session.status,
                "executor": session.executor,
            },
            "turns": turns,
        })),
    })
}

async fn load_claude_history(
    state: &tauri::State<'_, AppState>,
    session: Session,
) -> Result<ProviderHistorySnapshot, AppError> {
    load_provider_history_from_db(state, ProviderId::Claude, "claude_history_loader", session).await
}

async fn load_codex_history(
    state: &tauri::State<'_, AppState>,
    session: Session,
) -> Result<ProviderHistorySnapshot, AppError> {
    load_provider_history_from_db(state, ProviderId::Codex, "codex_history_loader", session).await
}

async fn load_opencode_history(
    state: &tauri::State<'_, AppState>,
    session: Session,
) -> Result<ProviderHistorySnapshot, AppError> {
    load_provider_history_from_db(
        state,
        ProviderId::Opencode,
        "opencode_history_loader",
        session,
    )
    .await
}

#[tauri::command]
pub async fn provider_runtime_get_capabilities(
    provider: ProviderId,
) -> Result<ProviderCapabilityState, AppError> {
    Ok(provider_capabilities(provider))
}

#[tauri::command]
pub async fn provider_runtime_get_status(
    provider: ProviderId,
) -> Result<ProviderRuntimeStatus, AppError> {
    Ok(ProviderRuntimeStatus {
        provider,
        contract: provider_runtime_contract(provider),
        native: probe_native_runtime(provider).await,
        fallback: provider_fallback_status(provider),
    })
}

#[tauri::command]
pub async fn provider_runtime_get_commands(
    state: tauri::State<'_, AppState>,
    provider: ProviderId,
    workspace_id: Option<Uuid>,
    repo_id: Option<Uuid>,
) -> Result<Vec<ProviderCommand>, AppError> {
    let _ = repo_id;
    if provider == ProviderId::Claude
        && let Some(workspace_id) = workspace_id
    {
        let mut workspace = load_provider_workspace(&state, workspace_id).await?;
        let workspace_dir = resolve_provider_workspace_dir(&state, &mut workspace).await?;
        return load_claude_sdk_commands(&workspace_dir).await;
    }
    if provider == ProviderId::Opencode
        && let Some(workspace_id) = workspace_id
    {
        let mut workspace = load_provider_workspace(&state, workspace_id).await?;
        let workspace_dir = resolve_provider_workspace_dir(&state, &mut workspace).await?;
        return load_opencode_sdk_commands(&workspace_dir).await;
    }

    Ok(provider_slash_commands(provider))
}

#[tauri::command]
pub async fn provider_runtime_list_models(
    provider: ProviderId,
) -> Result<Vec<ProviderModel>, AppError> {
    if provider == ProviderId::Claude {
        return load_claude_sdk_models(&repo_root_path()).await;
    }
    if provider == ProviderId::Opencode {
        return load_opencode_sdk_models(&repo_root_path()).await;
    }

    let models: Vec<(String, String)> = match provider {
        ProviderId::Claude => unreachable!("Claude models are loaded from Agent SDK metadata"),
        ProviderId::Codex => vec![
            ("gpt-5.5".to_string(), "GPT-5.5".to_string()),
            ("gpt-5.4".to_string(), "GPT-5.4".to_string()),
        ],
        ProviderId::Opencode => unreachable!("OpenCode models are loaded from SDK metadata"),
    };

    Ok(models
        .iter()
        .map(|(id, label)| ProviderModel {
            provider,
            id: id.to_string(),
            label: label.to_string(),
            source: match provider {
                ProviderId::Codex => CapabilitySource::AppServer,
                ProviderId::Claude => {
                    unreachable!("Claude models are loaded from Agent SDK metadata")
                }
                ProviderId::Opencode => {
                    unreachable!("OpenCode models are loaded from SDK metadata")
                }
            },
        })
        .collect())
}

#[tauri::command]
pub async fn provider_runtime_send_turn(
    state: tauri::State<'_, AppState>,
    request: ProviderTurnRequest,
) -> Result<ProviderRuntimeEvent, AppError> {
    validate_provider_executor_profile(&request)?;
    let workspace_id = Uuid::parse_str(&request.workspace_id).map_err(|_| {
        AppError::BadRequest(format!("Invalid workspace id: {}", request.workspace_id))
    })?;
    let session = ensure_provider_session(
        &state,
        request.provider,
        workspace_id,
        request.session_id.as_deref(),
        &request.text,
    )
    .await?;
    match try_native_provider_turn(&state, request.clone(), workspace_id, &session).await {
        Ok(event) => Ok(event),
        Err(native_error) => {
            let native_error_message = native_error.to_string();
            fallback_acp_turn(
                state,
                request,
                workspace_id,
                session,
                Some(native_error_message),
            )
            .await
        }
    }
}

#[tauri::command]
pub async fn provider_runtime_interrupt(
    provider: ProviderId,
    thread_id: Option<String>,
    turn_id: Option<String>,
) -> Result<(), AppError> {
    if provider == ProviderId::Codex
        && let (Some(thread_id), Some(turn_id)) = (thread_id.as_deref(), turn_id.as_deref())
    {
        let servers: Vec<Arc<CodexAppServer>> =
            CODEX_APP_SERVERS.lock().await.values().cloned().collect();
        for server in servers {
            let response = send_codex_request(
                &server,
                "turn/interrupt",
                json!({ "threadId": thread_id, "turnId": turn_id }),
                Duration::from_secs(5),
            )
            .await;
            if response.is_ok() {
                return Ok(());
            }
        }
    }

    let Some(turn_id) = turn_id else {
        return Err(AppError::BadRequest(format!(
            "{} interrupt requires a turn id",
            provider.label()
        )));
    };
    let Some(handle) = NATIVE_ACTIVE_TURNS.lock().await.remove(&turn_id) else {
        return Err(AppError::NotFound(format!("Turn {turn_id} is not active")));
    };
    if handle.provider != provider {
        return Err(AppError::BadRequest(format!(
            "Turn {turn_id} belongs to a different provider"
        )));
    }
    handle
        .child
        .lock()
        .await
        .kill()
        .await
        .map_err(|error| app_error_from_native(provider, error.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn provider_runtime_list_sessions(
    state: tauri::State<'_, AppState>,
    provider: ProviderId,
    workspace_id: Option<Uuid>,
) -> Result<Vec<ProviderSessionSummary>, AppError> {
    let Some(workspace_id) = workspace_id else {
        return Ok(Vec::new());
    };
    let sessions = Session::find_by_workspace_id(&state.deployment.db().pool, workspace_id).await?;

    Ok(sessions
        .into_iter()
        .filter(|session| session_executor_matches_provider(session.executor.as_deref(), provider))
        .map(|session| ProviderSessionSummary {
            provider,
            session_id: session.id.to_string(),
            title: session.name.or(session.initial_prompt),
        })
        .collect())
}

#[tauri::command]
pub async fn provider_runtime_load_history(
    state: tauri::State<'_, AppState>,
    provider: ProviderId,
    session_id: Uuid,
) -> Result<ProviderHistorySnapshot, AppError> {
    let session = Session::find_by_id(&state.deployment.db().pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {session_id} not found")))?;

    if !session_executor_matches_provider(session.executor.as_deref(), provider) {
        return Err(AppError::BadRequest(format!(
            "Session {session_id} belongs to a different provider"
        )));
    }

    match provider {
        ProviderId::Claude => load_claude_history(&state, session).await,
        ProviderId::Codex => load_codex_history(&state, session).await,
        ProviderId::Opencode => load_opencode_history(&state, session).await,
    }
}

#[tauri::command]
pub async fn provider_runtime_respond_to_request(
    provider: ProviderId,
    request_id: String,
    response: serde_json::Value,
) -> Result<(), AppError> {
    match provider {
        ProviderId::Codex => {
            let servers: Vec<Arc<CodexAppServer>> =
                CODEX_APP_SERVERS.lock().await.values().cloned().collect();
            if servers.is_empty() {
                return Err(AppError::NotFound(
                    "No active Codex app-server runtime found".to_string(),
                ));
            }
            let mut last_error = None;
            for server in servers {
                match send_codex_response(&server, &request_id, response.clone()).await {
                    Ok(()) => return Ok(()),
                    Err(error) => last_error = Some(error),
                }
            }
            Err(app_error_from_native(
                provider,
                last_error.unwrap_or_else(|| "failed to send response".to_string()),
            ))
        }
        ProviderId::Claude | ProviderId::Opencode => Err(AppError::BadRequest(format!(
            "{} request response routing is not exposed by the selected native CLI surface",
            provider.label()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn_request(provider: ProviderId) -> ProviderTurnRequest {
        ProviderTurnRequest {
            provider,
            workspace_id: Uuid::new_v4().to_string(),
            executor_profile_id: None,
            thread_id: None,
            session_id: None,
            text: "hello".to_string(),
            model: None,
            images: Vec::new(),
            provider_options: serde_json::Map::new(),
        }
    }

    #[test]
    fn provider_command_catalogs_are_isolated() {
        let claude = provider_slash_commands(ProviderId::Claude);
        let codex = provider_slash_commands(ProviderId::Codex);
        let opencode = provider_slash_commands(ProviderId::Opencode);

        assert!(!claude.iter().any(|command| command.name == "permissions"));
        assert!(!claude.iter().any(|command| command.name == "mcp"));
        assert!(!claude.iter().any(|command| command.name == "config"));
        assert!(!claude.iter().any(|command| command.name == "model"));
        assert!(codex.iter().any(|command| command.name == "goal"));
        assert!(opencode.iter().any(|command| command.name == "agents"));
        assert!(!claude.iter().any(|command| command.name == "goal"));
        assert!(!codex.iter().any(|command| command.name == "mcp"));
        assert!(!codex.iter().any(|command| command.name == "model"));
        assert!(!codex.iter().any(|command| command.name == "permissions"));
        assert!(!opencode.iter().any(|command| command.name == "config"));
        assert!(!opencode.iter().any(|command| command.name == "mcp"));
        assert!(!opencode.iter().any(|command| command.name == "model"));
    }

    #[test]
    fn provider_capabilities_keep_provider_specific_sources() {
        let claude = provider_capabilities(ProviderId::Claude);
        let codex = provider_capabilities(ProviderId::Codex);
        let opencode = provider_capabilities(ProviderId::Opencode);

        assert_eq!(claude.images.state, CapabilityState::Available);
        assert_eq!(claude.images.source, CapabilitySource::Sdk);
        assert_eq!(codex.collaboration_mode.state, CapabilityState::Available);
        assert_eq!(codex.collaboration_mode.source, CapabilitySource::AppServer);
        assert_eq!(opencode.mcp.state, CapabilityState::Available);
        assert_eq!(opencode.mcp.source, CapabilitySource::Sdk);
    }

    #[test]
    fn provider_runtime_contract_documents_primary_and_fallback_paths() {
        let claude = provider_runtime_contract(ProviderId::Claude);
        let codex = provider_runtime_contract(ProviderId::Codex);
        let opencode = provider_runtime_contract(ProviderId::Opencode);

        assert_eq!(claude.primary_runtime, ProviderRuntimeKind::ClaudeAgentSdk);
        assert_eq!(claude.primary_source, CapabilitySource::Sdk);
        assert_eq!(claude.fallback_env, CLAUDE_ACP_FALLBACK_ENV);
        assert!(claude.fallback_enabled_by_default);
        assert!(claude.dependencies.iter().any(|dependency| {
            dependency.id == "claude_agent_sdk" && dependency.required && !dependency.user_visible
        }));
        assert!(claude.dependencies.iter().any(|dependency| {
            dependency.id == "claude_acp" && dependency.source == CapabilitySource::AcpFallback
        }));

        assert_eq!(codex.primary_runtime, ProviderRuntimeKind::CodexAppServer);
        assert_eq!(codex.primary_source, CapabilitySource::AppServer);
        assert_eq!(codex.fallback_env, CODEX_ACP_FALLBACK_ENV);
        assert!(codex.dependencies.iter().any(|dependency| {
            dependency.id == "codex_cli" && dependency.required && dependency.user_visible
        }));

        assert_eq!(opencode.primary_runtime, ProviderRuntimeKind::OpencodeSdk);
        assert_eq!(opencode.primary_source, CapabilitySource::Sdk);
        assert_eq!(opencode.fallback_env, OPENCODE_ACP_FALLBACK_ENV);
        assert!(opencode.dependencies.iter().any(|dependency| {
            dependency.id == "opencode_sdk" && dependency.required && !dependency.user_visible
        }));
        assert!(opencode.dependencies.iter().any(|dependency| {
            dependency.id == "opencode_cli" && dependency.required && dependency.user_visible
        }));

        for contract in [claude, codex, opencode] {
            assert_eq!(contract.global_fallback_env, ACP_FALLBACK_ENV);
            assert_eq!(contract.force_fallback_option, "force_acp_fallback");
            assert!(contract.command_visibility_policy.contains("visible VibeX"));
            assert!(contract.event_history_policy.contains("acp_fallback"));
        }
    }

    #[test]
    fn session_provider_matching_rejects_cross_provider_history() {
        assert!(session_executor_matches_provider(
            Some("CODEX"),
            ProviderId::Codex
        ));
        assert!(session_executor_matches_provider(None, ProviderId::Claude));
        assert!(!session_executor_matches_provider(
            Some("CLAUDE_CODE"),
            ProviderId::Codex
        ));
        assert!(!session_executor_matches_provider(
            Some("OPENCODE"),
            ProviderId::Claude
        ));
    }

    #[test]
    fn native_provider_events_extract_display_text_without_user_echoes() {
        let claude_event = json!({
            "type": "sdk_event",
            "text": "assistant reply",
            "event": {
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "assistant reply" }]
                }
            }
        });
        let user_event = json!({
            "type": "sdk_event",
            "text": "user prompt",
            "event": {
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": "user prompt" }]
                }
            }
        });
        let opencode_event = json!({
            "type": "opencode_sdk_event",
            "event": {
                "message": {
                    "role": "assistant",
                    "parts": [{ "type": "text", "text": "opencode reply" }]
                }
            }
        });
        let stderr_event = json!({
            "type": "stderr",
            "message": "provider failed"
        });

        assert_eq!(
            extract_provider_text(&claude_event),
            Some("assistant reply".to_string())
        );
        assert!(provider_event_is_user_echo(&user_event));
        assert_eq!(
            extract_provider_text(&opencode_event),
            Some("opencode reply".to_string())
        );
        assert_eq!(
            extract_provider_error(&stderr_event),
            Some("provider failed".to_string())
        );
    }

    #[test]
    fn codex_app_server_events_extract_current_protocol_ids_and_text() {
        let turn_start_response = json!({
            "id": 12,
            "result": {
                "turn": {
                    "id": "turn-123",
                    "status": "running",
                    "items": []
                }
            }
        });
        let turn_completed_notification = json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-123",
                "turn": {
                    "id": "turn-123",
                    "status": "completed",
                    "items": []
                }
            }
        });
        let agent_delta_notification = json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "thread-123",
                "turnId": "turn-123",
                "itemId": "item-123",
                "delta": "hello"
            }
        });

        assert_eq!(
            extract_turn_id(&turn_start_response),
            Some("turn-123".to_string())
        );
        assert_eq!(
            extract_turn_id(&turn_completed_notification),
            Some("turn-123".to_string())
        );
        assert_eq!(
            extract_thread_id(&turn_completed_notification),
            Some("thread-123".to_string())
        );
        assert_eq!(
            extract_provider_text(&agent_delta_notification),
            Some("hello".to_string())
        );
        assert_eq!(
            extract_provider_stream_text(&json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "delta": " **GPT"
                }
            })),
            Some(" **GPT".to_string())
        );
        assert_eq!(
            extract_provider_stream_text(&json!({
                "type": "text_delta",
                "text": " 5.5"
            })),
            Some(" 5.5".to_string())
        );
    }

    #[test]
    fn native_provider_requests_reuse_persisted_threads_when_frontend_omits_thread_id() {
        let mut request = turn_request(ProviderId::Codex);
        request.thread_id = None;

        let resolved =
            provider_request_with_resolved_thread_id(request, Some("persisted-thread".to_string()));
        assert_eq!(resolved.thread_id.as_deref(), Some("persisted-thread"));

        let mut explicit = turn_request(ProviderId::Codex);
        explicit.thread_id = Some("explicit-thread".to_string());
        let explicit = provider_request_with_resolved_thread_id(
            explicit,
            Some("persisted-thread".to_string()),
        );
        assert_eq!(explicit.thread_id.as_deref(), Some("explicit-thread"));
    }

    #[test]
    fn sdk_bridge_inputs_receive_resolved_thread_ids() {
        let mut claude_request = turn_request(ProviderId::Claude);
        claude_request = provider_request_with_resolved_thread_id(
            claude_request,
            Some("claude-persisted-thread".to_string()),
        );
        let claude_input =
            build_claude_sdk_bridge_input(&claude_request, &PathBuf::from("C:\\workspace"))
                .unwrap();
        assert_eq!(
            claude_input.get("threadId").and_then(Value::as_str),
            Some("claude-persisted-thread")
        );

        let mut opencode_request = turn_request(ProviderId::Opencode);
        opencode_request = provider_request_with_resolved_thread_id(
            opencode_request,
            Some("opencode-persisted-thread".to_string()),
        );
        let opencode_input =
            build_opencode_sdk_bridge_input(&opencode_request, &PathBuf::from("C:\\workspace"))
                .unwrap();
        assert_eq!(
            opencode_input.get("threadId").and_then(Value::as_str),
            Some("opencode-persisted-thread")
        );
    }

    #[test]
    fn native_provider_events_extract_token_usage_info() {
        let codex_event = json!({
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": "thread-123",
                "turnId": "turn-123",
                "tokenUsage": {
                    "total": {
                        "totalTokens": 1200,
                        "inputTokens": 900,
                        "cachedInputTokens": 100,
                        "outputTokens": 200,
                        "reasoningOutputTokens": 0
                    },
                    "last": {
                        "totalTokens": 300,
                        "inputTokens": 200,
                        "cachedInputTokens": 50,
                        "outputTokens": 50,
                        "reasoningOutputTokens": 0
                    },
                    "modelContextWindow": 128000
                }
            }
        });
        let claude_event = json!({
            "type": "sdk_event",
            "event": {
                "type": "result",
                "subtype": "success",
                "usage": {
                    "input_tokens": 1000,
                    "output_tokens": 200,
                    "cache_creation_input_tokens": 50,
                    "cache_read_input_tokens": 25
                },
                "modelUsage": {
                    "claude-sonnet": {
                        "contextWindow": 200000
                    }
                }
            }
        });
        let opencode_event = json!({
            "type": "opencode_sdk_response",
            "response": {
                "type": "assistant",
                "tokens": {
                    "input": 700,
                    "output": 100,
                    "reasoning": 25,
                    "cache": {
                        "read": 10,
                        "write": 5
                    }
                },
                "modelContextWindow": 128000
            }
        });

        assert_eq!(
            extract_provider_token_usage_info(&codex_event)
                .map(|info| { (info.total_tokens, info.model_context_window) }),
            Some((1200, 128000))
        );
        assert_eq!(
            extract_provider_token_usage_info(&claude_event)
                .map(|info| { (info.total_tokens, info.model_context_window) }),
            Some((1275, 200000))
        );
        assert_eq!(
            extract_provider_token_usage_info(&opencode_event)
                .map(|info| { (info.total_tokens, info.model_context_window) }),
            Some((840, 128000))
        );
    }

    #[test]
    fn native_provider_stream_deltas_preserve_markdown_boundaries() {
        let mut content = String::new();
        append_provider_assistant_text(&mut content, "我是基于 **GPT", true);
        append_provider_assistant_text(&mut content, "-5** 的 Codex", true);
        append_provider_assistant_text(&mut content, " 编码代理。", true);

        assert_eq!(content, "我是基于 **GPT-5** 的 Codex 编码代理。");

        append_provider_assistant_text(&mut content, "完整块消息", false);
        assert_eq!(
            content,
            "我是基于 **GPT-5** 的 Codex 编码代理。\n完整块消息"
        );
    }

    #[test]
    fn claude_sdk_bridge_args_use_node_bridge_without_stream_json() {
        let input_path = PathBuf::from("C:\\tmp\\claude-sdk-input.json");
        let args = build_claude_sdk_bridge_args(&input_path);

        assert_eq!(args.len(), 2);
        assert!(args[0].ends_with("scripts\\claude-agent-sdk-provider.mjs"));
        assert_eq!(args[1], "C:\\tmp\\claude-sdk-input.json");
        assert!(!args.iter().any(|arg| arg.contains("stream-json")));

        let metadata_args = build_claude_sdk_metadata_args(&input_path);
        assert_eq!(metadata_args[1], "--metadata");
        assert_eq!(metadata_args[2], "C:\\tmp\\claude-sdk-input.json");
    }

    #[test]
    fn claude_sdk_bridge_input_maps_options_and_images() {
        let temp_dir = std::env::temp_dir().join(format!("vibex-claude-image-{}", Uuid::new_v4()));
        let image_dir = temp_dir.join(".vibe-images");
        std::fs::create_dir_all(&image_dir).unwrap();
        std::fs::write(image_dir.join("shot.png"), [0x89, b'P', b'N', b'G']).unwrap();

        let mut request = turn_request(ProviderId::Claude);
        request.text = "describe image".to_string();
        request.model = Some("claude-sonnet-4-5-20250929".to_string());
        request.thread_id = Some("claude-session-id".to_string());
        request.session_id = Some(Uuid::new_v4().to_string());
        request.images = vec![".vibe-images/shot.png".to_string()];
        request
            .provider_options
            .insert("effort".to_string(), json!("high"));
        request
            .provider_options
            .insert("permission_mode".to_string(), json!("plan"));
        request.provider_options.insert(
            "env".to_string(),
            json!({
                "ANTHROPIC_BASE_URL": "https://example.test",
            }),
        );
        request
            .provider_options
            .insert("fork".to_string(), json!(true));

        let value = build_claude_sdk_bridge_input(&request, &temp_dir).unwrap();

        assert_eq!(
            value.get("text").and_then(Value::as_str),
            Some("describe image")
        );
        assert_eq!(
            value.get("threadId").and_then(Value::as_str),
            Some("claude-session-id")
        );
        assert_eq!(
            value.get("model").and_then(Value::as_str),
            Some("claude-sonnet-4-5-20250929")
        );
        assert_eq!(value.get("effort").and_then(Value::as_str), Some("high"));
        assert_eq!(
            value.get("permissionMode").and_then(Value::as_str),
            Some("plan")
        );
        assert_eq!(
            value
                .get("env")
                .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
                .and_then(Value::as_str),
            Some("https://example.test")
        );
        assert_eq!(
            value.get("forkSession").and_then(Value::as_bool),
            Some(true)
        );
        let images = value.get("images").and_then(Value::as_array).unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(
            images[0].get("mediaType").and_then(Value::as_str),
            Some("image/png")
        );
        assert!(
            images[0]
                .get("base64")
                .and_then(Value::as_str)
                .is_some_and(|data| !data.is_empty())
        );
        assert!(!value.to_string().contains("stream-json"));

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn claude_native_model_aliases_resolve_from_local_env() {
        let mut env = HashMap::new();
        env.insert(
            CLAUDE_PRIMARY_MODEL_ENV.to_string(),
            "deepseek-v4-pro".to_string(),
        );
        env.insert(
            CLAUDE_DEFAULT_HAIKU_ENV.to_string(),
            "deepseek-v4-flash".to_string(),
        );

        assert_eq!(
            resolve_claude_model_from_env("sonnet", &env).as_deref(),
            Some("deepseek-v4-pro")
        );
        assert_eq!(
            resolve_claude_model_from_env("haiku", &env).as_deref(),
            Some("deepseek-v4-flash")
        );
        assert_eq!(
            resolve_claude_model_from_env("claude-custom", &env).as_deref(),
            Some("claude-custom")
        );
    }

    #[test]
    fn claude_sdk_metadata_maps_command_and_model_catalogs() {
        let metadata = json!({
            "commands": [
                { "name": "review", "description": "Review changes" },
                { "name": "mcp", "description": "Manage MCP servers" },
                { "name": "permissions", "description": "Manage permissions" },
                { "description": "missing name" }
            ],
            "models": [
                { "value": "sonnet[1m]", "displayName": "Sonnet (1M context)" },
                { "value": "deepseek-v4-pro", "description": "Custom model" },
                { "displayName": "missing value" }
            ]
        });

        let commands = claude_sdk_metadata_commands(&metadata);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].provider, ProviderId::Claude);
        assert_eq!(commands[0].name, "review");
        assert_eq!(commands[0].source, CapabilitySource::Sdk);

        let models = claude_sdk_metadata_models(&metadata);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "sonnet[1m]");
        assert_eq!(models[0].label, "Sonnet (1M context)");
        assert_eq!(models[0].source, CapabilitySource::Sdk);
        assert_eq!(models[1].id, "deepseek-v4-pro");
        assert_eq!(models[1].label, "Custom model");
    }

    #[test]
    fn opencode_sdk_bridge_input_maps_profile_session_and_file_inputs() {
        let input_path = PathBuf::from("C:\\tmp\\opencode-sdk-input.json");
        let args = build_opencode_sdk_bridge_args(&input_path);

        assert_eq!(args.len(), 2);
        assert!(args[0].ends_with("scripts\\opencode-sdk-provider.mjs"));
        assert_eq!(args[1], "C:\\tmp\\opencode-sdk-input.json");
        assert!(!args.iter().any(|arg| arg.contains("--format")));

        let metadata_args = build_opencode_sdk_metadata_args(&input_path);
        assert_eq!(metadata_args[1], "--metadata");
        assert_eq!(metadata_args[2], "C:\\tmp\\opencode-sdk-input.json");

        let mut request = turn_request(ProviderId::Opencode);
        let workspace_dir = PathBuf::from("C:\\workspace");
        request.model = Some("openai/gpt-5.4".to_string());
        request.thread_id = Some("opencode-session-id".to_string());
        request.session_id = Some(Uuid::new_v4().to_string());
        request.images = vec![".vibe-images\\shot.png".to_string()];
        request
            .provider_options
            .insert("agent".to_string(), json!("build"));
        request
            .provider_options
            .insert("variant".to_string(), json!("high"));
        request
            .provider_options
            .insert("fork".to_string(), json!(true));
        request
            .provider_options
            .insert("auto_approve".to_string(), json!(true));
        request
            .provider_options
            .insert("auto_compact".to_string(), json!(false));
        request.provider_options.insert(
            "env".to_string(),
            json!({
                "OPENCODE_CONFIG_CONTENT": "{\"theme\":\"dark\"}",
            }),
        );

        let value = build_opencode_sdk_bridge_input(&request, &workspace_dir).unwrap();

        assert_eq!(
            value.get("model").and_then(Value::as_str),
            Some("openai/gpt-5.4")
        );
        assert_eq!(
            value.get("threadId").and_then(Value::as_str),
            Some("opencode-session-id")
        );
        assert_eq!(value.get("agent").and_then(Value::as_str), Some("build"));
        assert_eq!(value.get("variant").and_then(Value::as_str), Some("high"));
        assert_eq!(
            value.get("forkSession").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            value.get("autoApprove").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            value.get("autoCompact").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            value
                .get("env")
                .and_then(|env| env.get("OPENCODE_CONFIG_CONTENT"))
                .and_then(Value::as_str),
            Some("{\"theme\":\"dark\"}")
        );
        let images = value.get("images").and_then(Value::as_array).unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(
            images[0].get("mime").and_then(Value::as_str),
            Some("image/png")
        );
        assert!(
            images[0]
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(|path| path.ends_with(".vibe-images\\shot.png"))
        );
        assert!(!value.to_string().contains("--format"));
    }

    #[test]
    fn opencode_sdk_metadata_maps_command_and_model_catalogs() {
        let metadata = json!({
            "commands": [
                { "name": "review", "description": "Review changes" },
                { "name": "mcp", "description": "Show MCP server status" },
                { "description": "missing name" }
            ],
            "models": [
                { "id": "opencode/gpt-5.5", "label": "OpenCode / GPT-5.5" },
                { "id": "modelverse/deepseek-v4-pro", "name": "DeepSeek V4 Pro" },
                { "label": "missing id" }
            ]
        });

        let commands = opencode_sdk_metadata_commands(&metadata);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].provider, ProviderId::Opencode);
        assert_eq!(commands[0].name, "review");
        assert_eq!(commands[0].source, CapabilitySource::Sdk);

        let models = opencode_sdk_metadata_models(&metadata);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "opencode/gpt-5.5");
        assert_eq!(models[0].label, "OpenCode / GPT-5.5");
        assert_eq!(models[0].source, CapabilitySource::Sdk);
        assert_eq!(models[1].id, "modelverse/deepseek-v4-pro");
        assert_eq!(models[1].label, "DeepSeek V4 Pro");
    }

    #[test]
    fn force_acp_fallback_is_provider_scoped_option() {
        let mut request = turn_request(ProviderId::Codex);
        assert!(!should_force_acp_fallback(&request));
        request
            .provider_options
            .insert("force_acp_fallback".to_string(), json!(true));
        assert!(should_force_acp_fallback(&request));
    }

    #[test]
    fn rejects_cross_provider_profile_ids() {
        let mut request = turn_request(ProviderId::Claude);
        request.executor_profile_id = Some(ExecutorProfileId::new(BaseCodingAgent::Codex));

        assert!(validate_provider_executor_profile(&request).is_err());
    }

    #[test]
    fn codex_runtime_options_use_profile_model_and_full_access() {
        let mut request = turn_request(ProviderId::Codex);
        request.executor_profile_id = Some(ExecutorProfileId::with_variant(
            BaseCodingAgent::Codex,
            "GPT_5_5".to_string(),
        ));

        let options = resolve_codex_runtime_options(&request, Path::new("C:\\workspace"));

        assert_eq!(options.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(options.approval_policy, "never");
        assert_eq!(
            options.sandbox_policy.get("type").and_then(Value::as_str),
            Some("dangerFullAccess")
        );
    }

    #[test]
    fn codex_runtime_options_prefer_profile_model_override() {
        let mut request = turn_request(ProviderId::Codex);
        let mut profile =
            ExecutorProfileId::with_variant(BaseCodingAgent::Codex, "GPT_5_5".to_string());
        profile.model = Some("gpt-5.4".to_string());
        request.executor_profile_id = Some(profile);

        let options = resolve_codex_runtime_options(&request, Path::new("C:\\workspace"));

        assert_eq!(options.model.as_deref(), Some("gpt-5.4"));
    }

    #[test]
    fn parses_acp_fallback_env_values() {
        for value in ["1", "true", "TRUE", "yes", "on", "enabled"] {
            assert_eq!(parse_acp_fallback_enabled_value(value), Some(true));
        }
        for value in ["0", "false", "FALSE", "no", "off", "disabled"] {
            assert_eq!(parse_acp_fallback_enabled_value(value), Some(false));
        }
        assert_eq!(parse_acp_fallback_enabled_value("unexpected"), None);
    }
}
