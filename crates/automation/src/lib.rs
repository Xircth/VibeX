//! Transport-neutral Automation v2 domain and execution ports.

mod adapters;
mod engine;
mod isolation;
mod recovery;
mod runner;
mod schedule;
mod spec;
mod templates;

pub use adapters::FileOwnerLock;
pub use engine::{
    AutomationEngine, AutomationService, ClaimStorePort, ClaimedRun, EngineError, OwnerLockPort,
};
pub use isolation::{
    GitWorkspacePort, PreparedWorkspace, SharedRootState, WorkspaceError,
    WorkspacePreparationRequest, WorkspaceService,
};
pub use recovery::{RecoveryStorePort, StartupReconciler, StartupRecoveryReport};
pub use runner::{
    AgentRuntimeVersionEvidence, AutomationRunner, ComponentVersionEvidence, ConnectionLaunch,
    ResolvedVersionEvidence, RunError, RunExecutionRequest, RunSnapshot, RunStatus, RunStorePort,
    ToolLockVersionEvidence, TurnLaunchCorrelation, TurnLauncherPort, TurnTerminalState,
    WorkspacePreparerPort,
};
pub use schedule::{
    Clock, ScheduleError, ScheduleService, ScheduleSpec, SystemClock, next_run_after,
};
pub use spec::{
    AUTOMATION_SPEC_VERSION, AgentSelectionIntent, AutomationDraftInput, AutomationError,
    ComposerCanonicalInput, IsolationSpec, PluginActionCatalogPort, PluginActionRef,
    TurnLaunchSpec, TurnLaunchSpecInput, WorkspaceTarget,
};
pub use templates::{AutomationDraft, AutomationTemplate, BuiltinTemplateCatalog};
