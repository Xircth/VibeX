use executors::{
    executors::{BaseCodingAgent, SlashCommandKind},
    profile::ExecutorProfileId,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{ACP_FALLBACK_ENV, provider_acp_fallback_env};
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
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Opencode => "OpenCode",
        }
    }

    pub(super) fn base_agent(self) -> BaseCodingAgent {
        match self {
            Self::Claude => BaseCodingAgent::ClaudeCode,
            Self::Codex => BaseCodingAgent::Codex,
            Self::Opencode => BaseCodingAgent::Opencode,
        }
    }
}

impl ProviderId {
    pub(super) fn history_key(self, session_id: &str) -> String {
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
    pub(super) fn available(source: CapabilitySource) -> Self {
        Self {
            state: CapabilityState::Available,
            source,
            detail: None,
        }
    }

    pub(super) fn partial(source: CapabilitySource, detail: impl Into<String>) -> Self {
        Self {
            state: CapabilityState::Partial,
            source,
            detail: Some(detail.into()),
        }
    }

    pub(super) fn unavailable(source: CapabilitySource, detail: impl Into<String>) -> Self {
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
