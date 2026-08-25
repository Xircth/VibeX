//! Plugin manifest and lifecycle domain services.

mod activation;
mod app_surface;
mod artifact_preview;
mod contribution;
mod control_plane;
mod error;
mod host_capability_broker;
mod host_service;
mod isolated;
mod language_runtimes;
mod link_watch;
mod manifest;
mod marketplace;
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
    ActivationRecoveryFailure, BundledPluginActivation, ConflictDecision, ImportConflict,
    ImportDisposition, ImportResult, InMemoryPluginRegistry, InstalledPlugin, PluginControlPlane,
    PluginRegistry, RuntimeInstallation, SqlitePluginRegistry, candidate_capability_grants,
};
pub use error::PluginError;
pub use host_capability_broker::HostCapabilityBroker;
pub use language_runtimes::{
    LanguageRuntimeLock, PLUGIN_WORKER_CPYTHON_VERSION, plugin_worker_cpython_lock,
};
pub use manifest::{
    ActionId, ArtifactIntent, ConsoleBinding, Distribution, ManifestSource, PluginAction, PluginId,
    PluginManifest, PluginMembership, PromptBlock, SkillDeclaration, SkillId, SkillSource,
    ToolDependency, ToolId, ToolKind,
};
pub use marketplace::{
    MarketplaceIndex, MarketplaceListing, PublisherTofu, archive_digest, default_index_path,
    default_tofu_path, load_index, load_tofu, remember_publisher, save_tofu,
};
pub use native::{
    FilesystemNativePluginAdapter, NativeAdapterCapabilities, NativeEcosystem, NativePluginAdapter,
    NativePluginDescriptor, NativePluginImportCommand, OfficialCliNativePluginAdapter,
    parse_official_plugin_import_commands,
};
pub use official_mcp::{
    DELEGATION_MCP_NAME, OfficialMcpBinding, OfficialMcpRuntime, PLUGIN_DEV_MCP_NAME,
    SESSION_FEAT_ALL, SESSION_FEAT_ASK, SESSION_FEAT_FEEDBACK, SESSION_FEAT_SESSION_CONTROL,
    SESSION_FEAT_SESSIONS, SESSION_MCP_NAME, binding_has_delegation_mcp,
    session_features_from_config,
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
    WorkerActivation, WorkerHost, WorkerHostError, isolated_spawn_supported, recent_plugin_crashes,
    record_plugin_crash,
};
