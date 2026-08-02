//! Wire protocol shared between the in-app delegation broker (the `delegation`
//! crate, listener side) and the out-of-process `vibex-mcp` companion (client
//! side).
//!
//! Deliberately dependency-light (serde + tokio io only) so the companion
//! binary stays small and never pulls in the broker or the agent runtime. Both
//! peers frame messages the same way: a `u32` little-endian byte length
//! followed by that many bytes of JSON. Length prefixing (rather than
//! newline-delimiting) keeps embedded newlines in a delegated `task` intact.

mod report;
mod transport;

pub use report::{DelegationTaskReport, TaskStatus};
pub use transport::{
    BrokerAskRequest, BrokerCancelRequest, BrokerCancelTaskRequest, BrokerCommitFeedbackRequest,
    BrokerFeedbackRequest, BrokerMessage, BrokerRequest, BrokerResponse, BrokerSessionRequest,
    BrokerStatusRequest, MAX_FRAME_BYTES, read_frame, write_frame,
};
