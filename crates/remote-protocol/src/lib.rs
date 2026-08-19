//! Versioned, transport-neutral DTOs shared by VibeX adapters.

mod capabilities;
mod command;
mod device_auth;
mod error;
mod ids;
mod notification;
mod pairing_invitation;
mod schema;
mod subscription;

pub use capabilities::{CapabilityId, ServerCapabilities};
pub use command::{CommandRequest, CommandResponse};
pub use device_auth::{
    CreatePairingRequest, DeviceCredential, DeviceId, DevicePermissionPreset, PairingChallenge,
    PairingId, RedeemPairingRequest, RevokeDeviceResponse,
};
pub use error::{ErrorCode, ErrorEnvelope};
pub use ids::{ConversationId, OperationId, SubscriptionId};
pub use notification::{NotificationOutcome, NotificationSource, TerminalNotificationSummary};
pub use pairing_invitation::{
    CONNECTION_CODE_ALPHABET, CONNECTION_CODE_LEN, IssuedPairingInvitation,
    PairingInvitationPayload, ReachabilityOrigin, is_connection_code, is_loopback_origin,
    issue_connection_code,
};
pub use schema::{ProtocolSchemaBundle, protocol_schema_bundle, write_protocol_schema_artifacts};
pub use subscription::{
    EventCursor, OfflineConversationCache, RemoteEvent, SubscriptionBootstrap,
    SubscriptionClientMessage, SubscriptionRequest, SubscriptionResource,
    SubscriptionServerMessage, SubscriptionSnapshot,
};

/// Remote protocol major/minor version implemented by this crate.
pub const PROTOCOL_VERSION: &str = "1.0";
