use serde::{Deserialize, Serialize};

use crate::{ConversationId, SubscriptionId};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SubscriptionRequest {
    pub subscription_id: SubscriptionId,
    #[serde(flatten)]
    pub resource: SubscriptionResource,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "resource", rename_all = "snake_case")]
pub enum SubscriptionResource {
    Conversation {
        conversation_id: ConversationId,
        after_sequence: i64,
    },
}

/// An open event envelope: `kind` remains a string and `payload` remains JSON so
/// a client can preserve or ignore events introduced by a newer server.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RemoteEvent {
    pub sequence: i64,
    pub kind: String,
    pub payload: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SubscriptionSnapshot {
    pub through_sequence: i64,
    pub payload: serde_json::Value,
}

/// Atomic attach result built from a durable event cursor. `ready` acknowledges
/// that the server registered the subscription before returning the captured
/// high-water mark.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SubscriptionBootstrap {
    pub subscription_id: SubscriptionId,
    pub ready: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<SubscriptionSnapshot>,
    #[serde(default)]
    pub replay: Vec<RemoteEvent>,
    pub high_water_mark: i64,
}
