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
mod webrtc;

pub use capabilities::{CapabilityId, ServerCapabilities};
pub use command::{CommandRequest, CommandResponse};
pub use device_auth::{
    CreateDeviceConnectRequest, CreatePairingRequest, DeviceConnectRequestStatus, DeviceCredential,
    DeviceId, DevicePermissionPreset, PairingChallenge, PairingId, PendingDeviceConnectRequest,
    PollDeviceConnectResponse, RedeemPairingRequest, RevokeDeviceResponse,
};
pub use error::{ErrorCode, ErrorEnvelope};
pub use ids::{ConversationId, OperationId, SubscriptionId};
pub use notification::{NotificationOutcome, NotificationSource, TerminalNotificationSummary};
pub use pairing_invitation::{
    CONNECTION_CODE_ALPHABET, CONNECTION_CODE_LEN, IssuedPairingInvitation,
    PAIRING_TTL_CHOICES_SECONDS, PAIRING_TTL_DEFAULT_SECONDS, PairingInvitationPayload,
    ReachabilityOrigin, canonical_pairing_token, is_connection_code, is_loopback_origin,
    is_public_plaintext_http_origin, issue_connection_code, origin_allows_plaintext_http,
    parse_pairing_ttl_seconds, resolve_pairing_ttl_seconds,
};
pub use schema::{ProtocolSchemaBundle, protocol_schema_bundle, write_protocol_schema_artifacts};
pub use subscription::{
    EventCursor, EventDurability, OfflineConversationCache, RemoteEvent, SubscriptionBootstrap,
    SubscriptionClientMessage, SubscriptionRequest, SubscriptionResource,
    SubscriptionServerMessage, SubscriptionSnapshot,
};
pub use webrtc::{
    BULK_BUFFERED_HIGH_WATER_BYTES, BULK_BUFFERED_LOW_THRESHOLD_BYTES, BULK_CHANNEL_LABEL,
    BULK_CHUNK_MAX_BYTES, BULK_CHUNK_MIN_BYTES, BulkChannelFrame, CHANNEL_BINDING_MAX_SKEW_SECONDS,
    CHANNEL_BINDING_PREFIX, CONTROL_CHANNEL_LABEL, CONTROL_MAX_FRAME_BYTES, ChannelBindingClaims,
    ControlChannelFrame, SIGNALING_PIGGYBACK_MAX_BYTES, SignalingPiggybackEvents,
    SignalingResumeCursor, extract_sdp_sha256_fingerprint,
};

/// Remote protocol major/minor version implemented by this crate.
pub const PROTOCOL_VERSION: &str = "1.0";
