//! Event-sourced conversation core (ADR-0003).
//!
//! Home of the projection fold, snapshot resume, and the incremental row projector —
//! moved out of `crates/db` so the storage layer no longer depends on `agents` (the
//! db→agents reverse dependency is now gone). `crates/db` is a dumb storage layer;
//! this crate owns the folding of the event log into timeline projections.

pub mod commit_reminder;
pub mod export;
pub mod host;
pub mod input;
pub mod projection;
pub mod relation;
pub mod runtime_events;
pub mod scoped_control;
pub mod search;
pub mod service;

pub use export::{render_html, render_markdown};
pub use host::{
    DefaultConversationHost, resolve_absolute_workspace_agent_working_dir,
    resolve_agent_runtime_launch_settings, resolve_workspace_agent_working_dir,
    workspace_prompt_blocks,
};
pub use input::{
    CancelConversationInput, ConversationInputClaim, ConversationInputControl,
    ConversationInputControlError, ConversationInputEvent, ConversationInputQueue,
    ConversationInputState, ConversationInputStatus, ConversationInputSubmission,
    ConversationInputView, ReorderConversationInput, SubmitConversationInput,
    UpdateConversationInput,
};
pub use projection::{
    CONVERSATION_PROJECTION_VERSION, ConversationEventAppender, ConversationProjector,
    ConversationStateApplier, IncrementalRowProjector,
};
pub use relation::{
    ConversationChildSummaryView, ConversationRelationControl, ConversationRelationView,
    CreateConversationRelation,
};
pub use runtime_events::{
    ConversationAgentEventRecorder, RecordedConversationBatch, RecordedConversationCompletion,
    RuntimeEventRecordError, start_agent_event_persistence,
};
pub use scoped_control::{
    ScopedConversationControl, ScopedConversationControlError, ScopedConversationWait,
};
pub use search::{
    ConversationSearchHit, backfill_missing, reindex_from_projection, search_conversations,
};
pub use service::{
    AgentRuntimeLaunchSettings, ConversationContext, ConversationEventPublisher, ConversationHost,
    ConversationRuntimeState, ConversationServiceError, ConversationSessionService,
    ConversationStartTurnInput, ConversationSteerInput, ConversationSteeringReceipt,
    ConversationSteeringStatus, ConversationTurnSnapshot, CreateDelegatedConversation,
    CreateForkConversation, CreateWorkflowConversation, NoopConversationEventPublisher,
    QueuedConversationInputClaim, create_delegated_conversation, create_fork_conversation,
    create_workflow_conversation, finalize_checkpoint_file_changes,
    preview_checkpoint_file_changes,
};
