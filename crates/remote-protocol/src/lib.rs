//! Versioned, transport-neutral DTOs shared by VibeX adapters.

mod capabilities;
mod command;
mod error;
mod ids;
mod subscription;

pub use capabilities::{CapabilityId, ServerCapabilities};
pub use command::{CommandRequest, CommandResponse};
pub use error::{ErrorCode, ErrorEnvelope};
pub use ids::{ConversationId, OperationId, SubscriptionId};
pub use subscription::{
    EventCursor, RemoteEvent, SubscriptionBootstrap, SubscriptionClientMessage,
    SubscriptionRequest, SubscriptionResource, SubscriptionServerMessage, SubscriptionSnapshot,
};

/// Remote protocol major/minor version implemented by this crate.
pub const PROTOCOL_VERSION: &str = "1.0";
