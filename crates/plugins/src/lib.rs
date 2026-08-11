//! Plugin manifest and lifecycle domain services.

mod control_plane;
mod error;
mod manifest;
mod native;
mod package;
mod ports;
mod readiness;
mod resolver;
mod runtime;
mod service;

pub use control_plane::{
    ConflictDecision, ImportConflict, ImportDisposition, ImportResult, InMemoryPluginRegistry,
    InstalledPlugin, PluginControlPlane, PluginRegistry, RuntimeConflict, RuntimeInstallation,
    SqlitePluginRegistry,
};
pub use error::PluginError;
pub use manifest::{
    ActionId, ArtifactIntent, ConsoleBinding, Distribution, ManifestSource, PluginAction, PluginId,
    PluginManifest, PluginMembership, PromptBlock, SkillDeclaration, SkillId, SkillSource,
    ToolDependency, ToolId, ToolKind,
};
pub use native::{
    FilesystemNativePluginAdapter, NativeAdapterCapabilities, NativeEcosystem, NativePluginAdapter,
    NativePluginDescriptor, NativePluginImportCommand, OfficialCliNativePluginAdapter,
    parse_official_plugin_import_commands,
};
pub use package::{
    InvocationDefinition, InvocationKind, PackageFormat, PackageSkill, PackageWarning,
    PluginPackage, PluginSource, PluginSourceKind, RuntimeContribution, RuntimeInstall,
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
pub use runtime::{
    GlobalRuntimeHost, GlobalRuntimeInstaller, RuntimeProcess, SystemGlobalRuntimeHost,
    sanitized_runtime_environment,
};
pub use service::PluginService;
