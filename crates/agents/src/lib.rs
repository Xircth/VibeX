//! ACP-native agent runtime primitives.
//!
//! This crate is the new product-owned live agent boundary. It intentionally
//! does not depend on VibeX's legacy executor, provider-runtime, `MsgStore`, or
//! `ExecutionProcess` systems.

pub mod auth_status;
pub mod capability;
pub mod cli_exposure;
pub mod conversation;
pub mod delegation_inject;
pub mod distribution;
pub mod elicitation;
pub mod error;
pub mod events;
pub mod filesystem;
pub mod history;
pub mod host;
pub mod ids;
pub mod install_planner;
pub mod launch_gate;
pub mod lifecycle;
pub mod local_detection;
pub mod management_boundary;
pub mod management_state;
pub mod manager;
pub mod metadata;
pub mod native_config;
pub mod operations;
pub mod parsers;
pub mod permissions;
pub mod profiles;
pub mod registry_client;
pub mod runtime;
pub mod session;
pub mod session_gate;
pub mod skills;
pub mod state;
pub mod terminal;
pub mod user_definition;

pub use api_types::{
    AgentAuthenticationStatus, AgentId, AgentKind, AgentLifecycleState, UserAgentDistributionKind,
};
pub use auth_status::{
    AUTH_STATUS_DRAFT_REVISION, AcpAuthStatusAdapter, AcpAuthStatusAdapterError,
    AuthenticationMethod, AuthenticationObservation, AuthenticationObservationState,
    AuthenticationSource, ResolvedSessionAuthentication, SessionAuthenticationEvidence,
    resolve_session_authentication_evidence,
};
pub use capability::AcpCapabilityNormalizer;
pub use cli_exposure::{
    CliExposureError, PublishedCliCommand, ShellFamily, publish_managed_runtime_cli,
    remove_managed_runtime_cli, switch_managed_runtime_cli,
};
pub use conversation::{
    AcpAuthenticationObservationSnapshot, AcpCapabilitySnapshot, AgentExecutionStats,
    AgentPromptCapabilities, ContentBlock, ConversationAgentConnectionStatus,
    ConversationBundleChecksum, ConversationBundleManifest, ConversationBundlePayload,
    ConversationDelegation, ConversationDelegationResult, ConversationDetail, ConversationError,
    ConversationErrorView, ConversationEvent, ConversationEventEnvelope, ConversationEventsPage,
    ConversationFeedbackRequest, ConversationFeedbackResponse, ConversationFileChange,
    ConversationFileChangeSummary, ConversationFileLocation, ConversationInputBlock,
    ConversationPermissionRequest, ConversationPermissionResponse, ConversationPermissionView,
    ConversationPlanEntry, ConversationPluginActionInvocation, ConversationQuestionRequest,
    ConversationQuestionResponse, ConversationSessionNotice, ConversationSummary,
    ConversationTerminalPatch, ConversationTerminalView, ConversationTimeline,
    ConversationTimelinePage, ConversationTimelineRow, ConversationToolCallPatch,
    ConversationUsage, ImageData, MessageTurn, SessionLoadFailureReason, SessionRecoveryStrategy,
    SessionStats, SubAgentToolCall, TurnBlockedReason, TurnRole, TurnUsage,
};
pub use delegation_inject::{
    CompanionCapabilities, CompanionInjection, CompanionInjectionContext, DelegationInjector,
    InjectedMcpServer, InjectedRemoteMcpServer, InjectedRemoteMcpTransport,
};
pub use distribution::current_platform;
pub use elicitation::{AgentElicitationRequest, AgentElicitationResponse};
pub use error::{AgentError, AgentResult};
pub use events::{
    AgentAvailableCommand, AgentContentBlock, AgentErrorEvent, AgentEvent, AgentEventEnvelope,
    AgentListedSession, AgentPlan, AgentPreparedSessionSnapshot, AgentPromptFinished,
    AgentSessionConfigChoice, AgentSessionConfigDependency, AgentSessionConfigOption,
    AgentSessionConfigOverride, AgentSessionControlsSnapshot, AgentSessionListPage,
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
    AgentConnectionId, AgentElicitationId, AgentPermissionId, AgentPromptId, AgentSessionId,
    AgentTerminalId,
};
pub use install_planner::{
    ArtifactTrust, ArtifactVerification, InstallCandidateSource, InstallEnvironment,
    InstallPlanner, InstallPlanningError, InstallPlanningInput, LockedInstallSource,
    PlannedDistributionKind, PlannedInstallComponent, ResolvedInstallPlan, TofuFingerprint,
    VersionEvidence, verify_artifact_bytes, verify_version_evidence,
};
pub use launch_gate::{LaunchComponentEvidence, LaunchGate, LaunchGateError};
pub use lifecycle::{
    BUSY_LIFECYCLE_MESSAGE, ComponentOwnership, LifecycleAction, LifecycleBlockReason,
    LifecycleComponent, LifecycleFacts, LifecyclePlan, LifecycleService,
};
pub use management_boundary::{
    BoundaryError, Clock, InstallInvocation, InstallOutput, InstallRunner, NativeFileMetadata,
    NativeFileSystem, RegistryFetchResponse, RegistryFetcher, SystemClock, TokioNativeFileSystem,
};
pub use management_state::{
    AgentManagementSnapshot, ComponentProbeState, ExternalCandidateObservation, ManagementFacts,
    ManagementOperationState, ProbeService, RequiredComponentProbe, VerifiedExternalRuntime,
    reduce_management_snapshot,
};
pub use manager::{
    AgentConnectionCommand, AgentConnectionLaunch, AgentConnectionManager,
    AgentConnectionManagerEvent, ManagedAgentConnectionSnapshot,
};
pub use metadata::{
    AgentCapability, agent_capabilities, claude_config_path, codex_auth_path, codex_config_path,
    codex_home, opencode_auth_path, opencode_config_dir, opencode_config_path,
};
pub use native_config::{
    ConfigApplyEffect, NativeConfigError, NativeConfigFieldSnapshot, NativeConfigFileSnapshot,
    NativeConfigPatch, NativeConfigProvider, NativeConfigSaveError, NativeConfigSaveResult,
    NativeConfigSnapshot,
};
pub use operations::{InstallOperationError, InstallOrchestrator, OrchestratorAgentSnapshot};
pub use permissions::{
    AgentAutoApproveMode, AgentPermissionOption, AgentPermissionOptionKind, AgentPermissionRequest,
    AgentPermissionResponse, RemotePermissionIntent, decide_auto_permission_response,
    decide_remote_permission_response,
};
pub use profiles::{
    AccountEvidence, AccountEvidenceKind, AuthenticationPrecedence, BuiltInProfile,
    BuiltInProfileCatalog, NativeConfigBinding, NativeConfigField, NativeConfigFieldKind,
    NativeConfigFormat, ProfileBinaryArtifact, ProfileComponent, ProfileExternalCandidate,
    ProfileIcon, ProfileInstallSource, ProfileRegistryBinding, ProfileTopology,
    RegistryEntryIdentity,
};
pub use registry_client::{
    OfficialRegistryHttpFetcher, RegistryAddTarget, RegistryAgentEntry, RegistryBinaryTarget,
    RegistryCache, RegistryCacheFreshness, RegistryDistributions, RegistryPackageDistribution,
    RegistrySnapshot, RegistrySnapshotClient, RegistryView, parse_registry_distributions_json,
    sanitize_registry_svg,
};
pub use runtime::{
    AgentRuntime, CancelAgentPromptInput, ConnectAgentInput, EnsureAgentSessionInput,
    NoopEventSink, RespondAgentElicitationInput, RespondAgentPermissionInput,
    ResumeAgentSessionInput, RuntimeEventSink, RuntimeSnapshot, SendAgentPromptInput,
};
pub use session::{AgentPromptQueue, QueueTransition};
pub use session_gate::{
    SessionBinding, SessionDefaultValidation, SessionGate, SessionGateError, SessionGateInput,
    SessionLaunchAuthorization, SessionLaunchLock, validate_session_defaults,
};
pub use skills::{AgentSkillsStrategy, AgentSkillsSurface, skills_surface};
pub use state::{
    AgentConnectionSnapshot, AgentConnectionStatus, AgentPromptSnapshot, AgentPromptStatus,
    AgentSessionSnapshot, AgentSessionStatus,
};
pub use terminal::{
    AgentTerminalCreateRequest, AgentTerminalEnvVar, AgentTerminalExit, AgentTerminalOutputSnapshot,
};
pub use user_definition::{UserAgentDefinition, UserAgentInstallTarget};
