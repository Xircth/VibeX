//! ACP-native agent runtime primitives.
//!
//! This crate is the new product-owned live agent boundary. It intentionally
//! does not depend on VibeX's legacy executor, provider-runtime, `MsgStore`, or
//! `ExecutionProcess` systems.

pub mod distribution;
pub mod error;
pub mod events;
pub mod filesystem;
pub mod host;
pub mod ids;
pub mod installer;
pub mod mcp;
pub mod permissions;
pub mod config;
pub mod runtime;
pub mod registry;
pub mod session;
pub mod skills;
pub mod state;
pub mod terminal;

pub use distribution::{
    AgentDistribution, CommandBuildInput, CommandParts, DistributionError, PlatformBinary,
};
pub use error::{AgentError, AgentResult};
pub use events::{
    AgentContentBlock, AgentErrorEvent, AgentEvent, AgentEventEnvelope, AgentPlan,
    AgentPromptFinished, AgentTerminalOutput, AgentTerminalSnapshot, AgentToolCall,
    AgentToolCallUpdate, AgentUsage,
};
pub use filesystem::{AgentFileReadRequest, AgentFileWriteRequest};
pub use host::{AgentHost, HostRequestError};
pub use ids::{
    AgentConnectionId, AgentPermissionId, AgentPromptId, AgentSessionId, AgentTerminalId,
};
pub use installer::{
    AgentInstallPlan, AgentInstallStatus, AgentPreflight, AgentPreflightIssue,
    AgentPreflightSeverity,
};
pub use mcp::{AgentMcpStrategy, AgentMcpSurface};
pub use permissions::{AgentPermissionOption, AgentPermissionRequest, AgentPermissionResponse};
pub use config::{AgentConfigSurface, AgentConfigStrategy, PathTemplate};
pub use registry::{AgentRegistryEntry, AgentType, all_agent_types, registry_entry};
pub use runtime::{
    AgentRuntime, ConnectAgentInput, RuntimeEventSink, RuntimeSnapshot, SendAgentPromptInput,
};
pub use session::{AgentPromptQueue, QueueTransition};
pub use skills::{AgentSkillsStrategy, AgentSkillsSurface};
pub use state::{
    AgentConnectionSnapshot, AgentConnectionStatus, AgentPromptSnapshot, AgentPromptStatus,
    AgentSessionSnapshot, AgentSessionStatus,
};
pub use terminal::{AgentTerminalCreateRequest, AgentTerminalExit, AgentTerminalOutputSnapshot};
