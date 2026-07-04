//! Event-sourced conversation core (ADR-0003).
//!
//! Home of the projection fold, snapshot resume, and the incremental row projector —
//! moved out of `crates/db` so the storage layer no longer depends on `agents` (the
//! db→agents reverse dependency is now gone). `crates/db` is a dumb storage layer;
//! this crate owns the folding of the event log into timeline projections.

pub mod projection;
pub mod service;

pub use projection::{
    CONVERSATION_PROJECTION_VERSION, ConversationEventAppender, ConversationProjector,
    ConversationStateApplier, IncrementalRowProjector,
};
pub use service::{
    AgentRuntimeLaunchSettings, ConversationContext, ConversationHost, ConversationRuntimeState,
    ConversationServiceError, ConversationSessionService, ConversationStartTurnInput,
    ConversationTurnSnapshot, finalize_checkpoint_file_changes,
};
