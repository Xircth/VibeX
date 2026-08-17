//! Plugin manifest and lifecycle domain services.

mod activation;
mod app_surface;
mod artifact_preview;
mod contribution;
mod control_plane;
mod error;
mod host_capability_broker;
mod manifest;
mod native;
mod official_mcp;
mod package;
mod ports;
mod preview_host;
mod process_preview_host;
mod readiness;
mod resolver;
mod runtime;
mod service;
mod worker_host;

pub use activation::{ActivationLease, ActivationManager, PreparedActivation};
pub use app_surface::{
    AppSurfaceDocument, AppSurfaceError, AppSurfaceErrorKind, AppSurfaceIdentity,
    AppSurfaceInvocation, AppSurfaceOpenRequest, PluginAppSurfaceHost,
};
pub use artifact_preview::PluginArtifactPreviewService;
pub use contribution::{
    ContributionCatalog, ContributionDescriptor, ContributionKind, ResolvedFileOpener,
};
pub use control_plane::{
    ActivationRecoveryFailure, ConflictDecision, ImportConflict, ImportDisposition, ImportResult,
    InMemoryPluginRegistry, InstalledPlugin, PluginControlPlane, PluginRegistry,
    RuntimeInstallation, SqlitePluginRegistry, candidate_capability_grants,
};
pub use error::PluginError;
pub use host_capability_broker::HostCapabilityBroker;
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
pub use official_mcp::{
    COLLABORATION_PLUGIN_ID, OfficialProductMcpGate, WORKFLOW_CREATOR_PLUGIN_ID,
};
pub use package::{
    AppSurfaceContribution, CapabilityRequest, FileOpenerContribution, FileOpenerTarget,
    InvocationDefinition, InvocationKind, PackageAppContributions, PackageFormat, PackageSkill,
    PackageWarning, PluginContentDocument, PluginContentIndex, PluginContentItem,
    PluginEntrypoints, PluginPackage, PluginProductDetail, PluginSource, PluginSourceKind,
    PreviewProcessContribution, PreviewProviderContribution, RuntimeContribution, RuntimeInstall,
    package_content_digest,
};
pub use ports::{
    ManagedTool, PluginRuntimeError, SkillAvailabilityPort, ToolRuntimeAdapter, ToolRuntimePort,
};
pub use preview_host::{
    PluginPreviewHost, PluginPreviewHostError, PluginPreviewRequest, PluginPreviewSession,
};
pub use process_preview_host::ExternalProcessPreviewHost;
pub use readiness::{
    DependencyState, EnableOperation, EnableOperationKind, EnableResult, PluginActivation,
    PluginReadiness, PluginSnapshot, ProviderState, ReadinessIssue, SkillState,
};
pub use resolver::{
    Architecture, OperatingSystem, Platform, ResolvedToolDistribution, ToolDependencyResolver,
};
pub use runtime::{
    ContentAddressedRuntimeHost, GlobalRuntimeHost, GlobalRuntimeInstaller,
    PluginWorkerRuntimeProvider, RuntimeProcess, inherited_runtime_environment,
};
pub use service::PluginService;
pub use worker_host::{
    CapabilityBroker, CapabilityGrant, DenyCapabilityBroker, ScopedCapabilityBroker,
    WorkerActivation, WorkerHost, WorkerHostError,
};
