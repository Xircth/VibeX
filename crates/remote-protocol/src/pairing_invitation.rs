use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{DevicePermissionPreset, PairingChallenge, PairingId};

/// One reachable origin for a Host, never a Host identity by itself.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct ReachabilityOrigin {
    pub origin: String,
    pub kind: String,
}

impl ReachabilityOrigin {
    pub fn lan(origin: impl Into<String>) -> Self {
        Self {
            origin: origin.into(),
            kind: "lan".to_string(),
        }
    }
}

/// Payload inside a `vibex-pairing:` invitation. Long-lived credentials must
/// never appear here.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PairingInvitationPayload {
    pub version: u32,
    pub host_id: String,
    pub preset: String,
    pub expires_at: String,
    pub pairing_id: String,
    pub pairing_token: String,
    pub reachability: Vec<ReachabilityOrigin>,
}

impl PairingInvitationPayload {
    pub const VERSION: u32 = 1;

    pub fn from_challenge(
        host_id: impl Into<String>,
        preset: DevicePermissionPreset,
        challenge: &PairingChallenge,
        reachability: impl IntoIterator<Item = ReachabilityOrigin>,
    ) -> Self {
        Self {
            version: Self::VERSION,
            host_id: host_id.into(),
            preset: preset.as_str().to_string(),
            expires_at: challenge.expires_at.clone(),
            pairing_id: challenge.pairing_id.to_string(),
            pairing_token: challenge.pairing_token.clone(),
            reachability: reachability
                .into_iter()
                .filter(|item| !is_loopback_origin(&item.origin))
                .collect(),
        }
    }

    pub fn encode(&self) -> String {
        format!(
            "vibex-pairing:{}",
            serde_json::to_string(self).expect("pairing invitation serializes")
        )
    }
}

/// Host-console issuance: the redeemable challenge plus the scannable text.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IssuedPairingInvitation {
    pub host_id: String,
    pub pairing_id: PairingId,
    pub pairing_token: String,
    pub expires_at: String,
    pub requested_scopes: Vec<String>,
    pub preset: String,
    pub reachability: Vec<ReachabilityOrigin>,
    pub invitation: String,
}

impl IssuedPairingInvitation {
    pub fn from_payload(challenge: PairingChallenge, payload: PairingInvitationPayload) -> Self {
        Self {
            host_id: payload.host_id.clone(),
            pairing_id: challenge.pairing_id,
            pairing_token: challenge.pairing_token,
            expires_at: challenge.expires_at,
            requested_scopes: challenge.requested_scopes,
            preset: payload.preset.clone(),
            reachability: payload.reachability.clone(),
            invitation: payload.encode(),
        }
    }
}

pub fn is_loopback_origin(origin: &str) -> bool {
    let lowered = origin.to_ascii_lowercase();
    lowered.contains("127.0.0.1")
        || lowered.contains("localhost")
        || lowered.contains("[::1]")
        || lowered.contains("://[::1]")
}
