//! In-process multi-agent delegation broker.
//!
//! The parent agent's LLM calls the built-in MCP tool `delegate_to_agent`
//! (exposed by the out-of-process `vibex-mcp` companion). The companion frames
//! the call over a UDS / named pipe to this crate's listener, which hands it to
//! the [`DelegationBroker`]. The broker spawns a fresh child ACP session via the
//! [`spawner::ConnectionSpawner`] trait, tracks it asynchronously, and resolves
//! the parent's tool call when the child's turn completes.
//!
//! Everything the broker touches outside its own state is a trait
//! ([`spawner`], depth/status lookups, meta writer, event emitter) so the core
//! logic unit-tests against mocks without a live agent runtime or database.

pub mod broker;
pub mod depth;
pub mod event_emitter;
pub mod listener;
pub mod lookups;
pub mod meta_writer;
pub mod spawner;
pub mod steering;
pub mod stop_reason;
pub mod token_registry;
pub mod types;

#[cfg(test)]
mod testing;

pub use broker::{DelegationBroker, StatusWait};
pub use event_emitter::{DelegationCompletedEvent, DelegationEventEmitter, DelegationStartedEvent};
pub use listener::{DelegationListener, default_socket_path};
pub use lookups::{ChildStatusLookup, ChildStatusRecord, DepthLookup, ParentSessionLookup};
pub use meta_writer::DelegationMetaWriter;
pub use spawner::{ConnectionSpawner, SpawnerError};
pub use steering::{
    CompanionFeaturePort, FeedbackNote, InMemoryCompanionFeatures, NoopCompanionFeatures,
    PendingQuestion, PendingQuestionWait, SharedCompanionFeatures,
};
pub use stop_reason::{StopClass, classify_stop_reason, outcome_from_turn};
pub use token_registry::{TokenEntry, TokenFeature, TokenPermissions, TokenRegistry};
pub use types::{
    AgentDelegationDefaults, DelegationConfig, DelegationError, DelegationLink, DelegationMatchKey,
    DelegationOutcome, DelegationPolicySnapshot, DelegationRequest, DelegationScope,
    DelegationSuccess, DelegationTaskReport, DelegationWorkspaceAccess, TaskStatus, TokenUsage,
};
