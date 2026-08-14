//! Durable, transport-neutral Workflow domain (ADR-0045).

mod service;
mod spec;
mod store;

pub use service::{
    CompleteWorkflowStep, DecideApproval, PublishWorkflow, ReviewWorkflow, StartWorkflow,
    WorkflowCore, WorkflowError, WorkflowReviewDecision, WorkflowValidationView,
};
pub use spec::{
    AgentStepSpec, ApprovalStepSpec, SideEffectClass, WorkflowBinding, WorkflowDefinition,
    WorkflowPolicy, WorkflowStep, WorkflowStepSpec, WorkspaceAccess, normalize_definition,
    validate_definition, validate_json_schema, validate_json_value,
};
pub use store::{
    ClaimedWorkflowStep, ResolvedWorkflowStepInput, WorkflowEvent, WorkflowEventRecord,
    WorkflowRetentionCandidate, WorkflowRunStatus, WorkflowRunView, WorkflowStepStatus,
    WorkflowStepView, WorkflowStore, WorkflowVersionView,
};
