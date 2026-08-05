//! Event-sourced conversation core (ADR-0003).
//!
//! Home of the projection fold, snapshot resume, and the incremental row projector —
//! moved out of `crates/db` so the storage layer no longer depends on `agents` (the
//! db→agents reverse dependency is now gone). `crates/db` is a dumb storage layer;
//! this crate owns the folding of the event log into timeline projections.

pub mod commit_reminder;
pub mod export;
pub mod host;
pub mod projection;
pub mod runtime_events;
pub mod search;
pub mod service;

pub use export::{render_html, render_markdown};
pub use host::{
    DefaultConversationHost, resolve_agent_runtime_launch_settings,
    resolve_workspace_agent_working_dir, workspace_prompt_blocks,
};
pub use projection::{
    CONVERSATION_PROJECTION_VERSION, ConversationEventAppender, ConversationProjector,
    ConversationStateApplier, IncrementalRowProjector,
};
pub use runtime_events::{
    ConversationAgentEventRecorder, RuntimeEventRecordError, start_agent_event_persistence,
};
pub use search::{
    ConversationSearchHit, backfill_missing, reindex_from_projection, search_conversations,
};
pub use service::{
    AgentRuntimeLaunchSettings, ConversationContext, ConversationHost, ConversationRuntimeState,
    ConversationServiceError, ConversationSessionService, ConversationStartTurnInput,
    ConversationTurnSnapshot, CreateDelegatedConversation, create_delegated_conversation,
    finalize_checkpoint_file_changes, preview_checkpoint_file_changes,
};
