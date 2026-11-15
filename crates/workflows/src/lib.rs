//! Durable, transport-neutral Workflow domain (ADR-0045) and Pulse Dual-Primitive Orchestration.

mod graph_patch;
mod presets;
mod pulse_steps;
mod service;
mod spec;
mod store;
mod store_execution;
mod store_reconcile;
mod store_saga;
mod store_scheduler;
mod store_transitions;
mod wake;

#[cfg(test)]
mod pulse_workflow_tests;
#[cfg(test)]
mod service_tests_core;
#[cfg(test)]
mod service_tests_reconcile;
#[cfg(test)]
mod spec_tests;

pub use graph_patch::{WorkflowGraphPatch, WorkflowGraphPatchOp, apply_workflow_graph_patch};
pub use presets::{
    DirectReflexPresetConfig, DualPrimitiveActorSpec, EventSagaPresetConfig,
    HybridPipelinePresetConfig, PresetOrchestratorSpec, SpecialistSessionSpec,
    SuperagentRouterPresetConfig, WindowAggregatorPresetConfig, build_direct_reflex_workflow,
    build_event_saga_workflow, build_hybrid_pipeline_workflow, build_preset_workflow,
    build_superagent_router_workflow, build_window_aggregator_workflow,
    build_workflow_from_pulse_rule, default_preset_workflow,
};
pub use pulse_steps::{
    ApprovalOptionSpec, BotConversationScope, BotMailboxPolicy, BotStepSpec, BoundedLoopStepSpec,
    ConditionBranchStepSpec, EventActor, EventEnvelope, EventSourceKind, EventSourceMeta,
    EventTrace, EventTrustLevel, GateFilterAst, GateFilterCondition, GroupDispatchMode,
    GroupMentionOrder, GroupStageStepSpec, MAX_BOUNDED_LOOP_ITERATIONS, MAX_GATE_FILTER_CONDITIONS,
    MAX_WAIT_FOR_EVENT_TIMEOUT_SECONDS, OutboxActionKind, OutboxActionStepSpec,
    PresetOrchestratorKind, PulseEvalMode, PulseRuleSpec, PulseTargetSpec, PulseWorkspaceIsolation,
    ReplyChannelAddress, SessionStepSpec, UserGateInteractionKind, UserGateStepSpec,
    UserInteractionKind, UserInteractionSeverity, WaitForEventStepSpec, evaluate_gate_condition,
    evaluate_gate_condition_on_value, evaluate_gate_filter_envelope, evaluate_gate_filter_on_value,
    match_waiting_step, resolve_json_pointer,
};
pub use service::{
    AcceptWorkflowStepCandidate, CompleteWorkflowStep, DecideApproval, DecideUserGate,
    ForkWorkflowRun, PauseWorkflowRun, PublishWorkflow, ResumePausedWorkflowRun,
    ResumeWaitingWorkflowStep, ReviewWorkflow, StageWorkflowStepCandidate, StartWorkflow,
    WorkflowCore, WorkflowError, WorkflowReviewDecision, WorkflowValidationView,
};
pub use spec::{
    AgentStepSpec, ApprovalStepSpec, CompletionPolicy, MAX_WORKFLOW_STEPS, NotifyStepSpec,
    SideEffectClass, WORKFLOW_DEFINITION_VERSION, WorkflowBinding, WorkflowDefinition,
    WorkflowPolicy, WorkflowStep, WorkflowStepSpec, WorkspaceAccess, normalize_definition,
    validate_definition, validate_definition_errors, validate_json_schema, validate_json_value,
};
pub use store::{
    ClaimedWorkflowStep, DebugRunScope, ResolvedWorkflowStepInput, WaitingWorkflowStep,
    WorkflowDefinitionSummary, WorkflowEvent, WorkflowEventRecord, WorkflowRetentionCandidate,
    WorkflowRunStatus, WorkflowRunView, WorkflowStepStatus, WorkflowStepView, WorkflowStore,
    WorkflowVersionView,
};
pub use wake::{notify_workflow_work, workflow_wake};
