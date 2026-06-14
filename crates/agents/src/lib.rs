//! ACP-native agent runtime primitives.
//!
//! This crate is the new product-owned live agent boundary. It intentionally
//! does not depend on VibeX's legacy executor, provider-runtime, `MsgStore`, or
//! `ExecutionProcess` systems.

pub mod config;
pub mod conversation;
pub mod delegation_inject;
pub mod distribution;
pub mod error;
pub mod events;
pub mod filesystem;
pub mod history;
pub mod host;
pub mod ids;
pub mod installer;
pub mod manager;
pub mod mcp;
pub mod mcp_file;
pub mod metadata;
pub mod parsers;
pub mod permissions;
pub mod preflight;
pub mod registry;
pub mod runtime;
pub mod session;
pub mod skills;
pub mod state;
pub mod terminal;

pub use config::{AgentConfigStrategy, AgentConfigSurface, PathTemplate, config_surface};
pub use delegation_inject::{DelegationInjector, InjectedMcpServer};
pub use conversation::{
    AgentExecutionStats, ContentBlock, ConversationDetail, ConversationSummary, ImageData,
    MessageTurn, SessionStats, SubAgentToolCall, TurnRole, TurnUsage,
};
pub use distribution::{
    AgentDistribution, CommandBuildInput, CommandParts, DistributionError, PlatformBinary,
    SystemCommand, current_platform,
};
pub use error::{AgentError, AgentResult};
pub use events::{
    AgentAvailableCommand, AgentContentBlock, AgentErrorEvent, AgentEvent, AgentEventEnvelope,
    AgentPlan, AgentPromptFinished, AgentSessionConfigChoice, AgentSessionConfigOption,
    AgentSessionMode, AgentTerminalOutput, AgentTerminalSnapshot, AgentToolCall,
    AgentToolCallUpdate, AgentUsage, DelegationResultSummary,
};
pub use filesystem::{AgentFileReadRequest, AgentFileWriteRequest};
pub use history::{
    AgentHistoryError, AgentHistorySource, ImportedAgentMessage, ImportedAgentMessageRole,
    ImportedAgentSession, default_history_sources, import_history_source,
};
pub use host::{AgentHost, HostRequestError};
pub use ids::{
    AgentConnectionId, AgentPermissionId, AgentPromptId, AgentSessionId, AgentTerminalId,
};
pub use installer::{
    AgentInstallPlan, AgentInstallStatus, AgentPreflight, AgentPreflightIssue,
    AgentPreflightSeverity,
};
pub use manager::{
    AgentConnectionCommand, AgentConnectionLaunch, AgentConnectionManager,
    AgentConnectionManagerEvent, ManagedAgentConnectionSnapshot,
};
pub use mcp::{AgentMcpStrategy, AgentMcpSurface, mcp_surface};
pub use mcp_file::{
    AgentMcpConfig, default_mcp_config_path, mcp_file_config, read_agent_mcp_config,
    write_agent_mcp_config,
};
pub use metadata::{
    AgentAvailabilityInfo, AgentCapability, agent_availability, agent_capabilities,
    claude_config_path, codex_auth_path, codex_config_path, codex_home, opencode_auth_path,
    opencode_config_dir, opencode_config_path,
};
pub use permissions::{
    AgentAutoApproveMode, AgentPermissionOption, AgentPermissionOptionKind, AgentPermissionRequest,
    AgentPermissionResponse, decide_auto_permission_response,
};
pub use preflight::{
    AgentPreflightCheckItem, AgentPreflightCheckStatus, AgentPreflightFixAction,
    AgentPreflightProbe, AgentPreflightReport, build_preflight_report,
};
pub use registry::{
    AgentRegistryEntry, AgentType, agent_type_from_executor_key, all_agent_types, executor_key_for,
    registry_entry,
};
pub use runtime::{
    AgentRuntime, CancelAgentPromptInput, ConnectAgentInput, EnsureAgentSessionInput,
    RespondAgentPermissionInput, ResumeAgentSessionInput, RuntimeEventSink, RuntimeSnapshot,
    SendAgentPromptInput,
};
pub use session::{AgentPromptQueue, QueueTransition};
pub use skills::{AgentSkillsStrategy, AgentSkillsSurface, skills_surface};
pub use state::{
    AgentConnectionSnapshot, AgentConnectionStatus, AgentPromptSnapshot, AgentPromptStatus,
    AgentSessionSnapshot, AgentSessionStatus,
};
pub use terminal::{
    AgentTerminalCreateRequest, AgentTerminalEnvVar, AgentTerminalExit, AgentTerminalOutputSnapshot,
};
