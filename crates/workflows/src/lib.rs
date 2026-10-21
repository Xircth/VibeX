//! Durable, transport-neutral Workflow domain (ADR-0045).

mod service;
mod spec;
mod store;
mod wake;

pub use service::{
    AcceptWorkflowStepCandidate, CompleteWorkflowStep, DecideApproval, ForkWorkflowRun,
    PauseWorkflowRun, PublishWorkflow, ResumePausedWorkflowRun, ReviewWorkflow,
    StageWorkflowStepCandidate, StartWorkflow, WorkflowCore, WorkflowError, WorkflowReviewDecision,
    WorkflowValidationView,
};
pub use spec::{
    AgentStepSpec, ApprovalStepSpec, CompletionPolicy, NotifyStepSpec, SideEffectClass,
    WorkflowBinding, WorkflowDefinition, WorkflowPolicy, WorkflowStep, WorkflowStepSpec,
    WorkspaceAccess, normalize_definition, validate_definition, validate_json_schema,
    validate_json_value,
};
pub use store::{
    ClaimedWorkflowStep, DebugRunScope, ResolvedWorkflowStepInput, WorkflowDefinitionSummary,
    WorkflowEvent, WorkflowEventRecord, WorkflowRetentionCandidate, WorkflowRunStatus,
    WorkflowRunView, WorkflowStepStatus, WorkflowStepView, WorkflowStore, WorkflowVersionView,
};
pub use wake::{notify_workflow_work, workflow_wake};
