//! Plugin manifest and lifecycle domain services.

mod error;
mod manifest;
mod ports;
mod readiness;
mod resolver;
mod service;

pub use error::PluginError;
pub use manifest::{
    ArtifactIntent, ConsoleBinding, Distribution, ManifestSource, PluginAction, PluginId,
    PluginManifest, PluginMembership, PromptBlock, SkillDeclaration, SkillId, SkillSource,
    ToolDependency, ToolId, ToolKind,
};
pub use ports::{
    ManagedTool, PluginRuntimeError, SkillAvailabilityPort, ToolRuntimeAdapter, ToolRuntimePort,
};
pub use readiness::{
    DependencyState, EnableOperation, EnableOperationKind, EnableResult, PluginActivation,
    PluginReadiness, PluginSnapshot, ProviderState, ReadinessIssue, SkillState,
};
pub use resolver::{
    Architecture, OperatingSystem, Platform, ResolvedToolDistribution, ToolDependencyResolver,
};
pub use service::PluginService;
