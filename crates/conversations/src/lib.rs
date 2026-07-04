//! Event-sourced conversation core (ADR-0003).
//!
//! Home of the projection fold, snapshot resume, and the incremental row projector —
//! moved out of `crates/db` so the storage layer no longer depends on `agents` (the
//! db→agents reverse dependency is now gone). `crates/db` is a dumb storage layer;
//! this crate owns the folding of the event log into timeline projections.

pub mod projection;

pub use projection::{
    ConversationEventAppender, ConversationProjector, ConversationStateApplier,
    IncrementalRowProjector, CONVERSATION_PROJECTION_VERSION,
};
