use std::{fmt, str::FromStr};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

macro_rules! device_uuid_id {
    ($name:ident) => {
        #[derive(
            Clone,
            Copy,
            Debug,
            Deserialize,
            Eq,
            Hash,
            JsonSchema,
            Ord,
            PartialEq,
            PartialOrd,
            Serialize,
            TS,
        )]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }

            pub const fn from_uuid(value: Uuid) -> Self {
                Self(value)
            }

            pub const fn as_uuid(self) -> Uuid {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(value).map(Self)
            }
        }
    };
}

device_uuid_id!(PairingId);
device_uuid_id!(DeviceId);

/// Pairing-time device class. Presets only expand scopes; authorization still
/// checks each scope independently.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DevicePermissionPreset {
    Workstation,
    Companion,
}

impl DevicePermissionPreset {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Workstation => "workstation",
            Self::Companion => "companion",
        }
    }

    pub fn from_command(value: &str) -> Option<Self> {
        match value.trim() {
            "companion" => Some(Self::Companion),
            "workstation" => Some(Self::Workstation),
            _ => None,
        }
    }

    /// Scopes granted to a Workstation Device. Host administration stays off this list.
    pub const fn workstation_scopes() -> &'static [&'static str] {
        &[
            "conversation.read",
            "conversation.write",
            "conversation.attach",
            "conversation.permission",
            "conversation.question",
            "conversation.cancel",
            "conversation.steer",
            "application.call",
            "plugin.read",
            "plugin.write",
            "plugin.surface",
            "artifact.read",
            "artifact.preview",
            "automation.read",
            "automation.write",
            "delegation.read",
            "delegation.cancel",
            "workflow.read",
            "workflow.write",
            "workflow.run",
            "workflow.approve",
            "notification.summary",
            "offline.read",
            "workspace.terminal",
        ]
    }

    /// Scopes granted to a Companion Device.
    pub const fn companion_scopes() -> &'static [&'static str] {
        &[
            "conversation.read",
            "conversation.write",
            "conversation.attach",
            "conversation.permission",
            "conversation.question",
            "conversation.cancel",
            "conversation.steer",
            "plugin.read",
            "artifact.read",
            "workflow.read",
            "automation.read",
            "delegation.read",
            "notification.summary",
            "offline.read",
        ]
    }

    pub const fn scopes(self) -> &'static [&'static str] {
        match self {
            Self::Workstation => Self::workstation_scopes(),
            Self::Companion => Self::companion_scopes(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct CreatePairingRequest {
    #[serde(default)]
    pub preset: Option<DevicePermissionPreset>,
    #[serde(default)]
    pub requested_scopes: Vec<String>,
    #[serde(default)]
    pub ttl_seconds: Option<i64>,
}

#[derive(Clone, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct PairingChallenge {
    pub pairing_id: PairingId,
    pub pairing_token: String,
    pub expires_at: String,
    pub requested_scopes: Vec<String>,
}

#[derive(Clone, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct RedeemPairingRequest {
    pub pairing_token: String,
    pub device_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key_ed25519: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_kind: Option<String>,
    #[serde(default)]
    pub replace_existing_mobile: bool,
}

#[derive(Clone, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct DeviceCredential {
    pub device_id: DeviceId,
    pub access_token: String,
    pub scopes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct RevokeDeviceResponse {
    pub device_id: DeviceId,
    pub revoked: bool,
}

#[derive(Clone, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct CreateDeviceConnectRequest {
    pub device_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key_ed25519: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_nonce: Option<String>,
    #[serde(default)]
    pub replace_existing_mobile: bool,
    /// VibeX account token of the requesting device. When present, the host only
    /// accepts the request if the token belongs to the account signed in on the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_token: Option<String>,
}

impl std::fmt::Debug for CreateDeviceConnectRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreateDeviceConnectRequest")
            .field("device_name", &self.device_name)
            .field("client_kind", &self.client_kind)
            .field("public_key_ed25519", &self.public_key_ed25519)
            .field("session_nonce", &self.session_nonce)
            .field("replace_existing_mobile", &self.replace_existing_mobile)
            .field(
                "account_token",
                &self.account_token.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DeviceConnectRequestStatus {
    Pending,
    Approved,
    Rejected,
    Expired,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct PendingDeviceConnectRequest {
    pub request_id: PairingId,
    pub device_name: String,
    pub client_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip_address: Option<String>,
    pub sas_code: String,
    pub created_at: String,
    pub expires_at: String,
    /// Display name of the VibeX account the host verified for this request; absent for
    /// requests made without an account token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_display_name: Option<String>,
}

#[derive(Clone, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct PollDeviceConnectResponse {
    pub request_id: PairingId,
    pub host_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_name: Option<String>,
    pub sas_code: String,
    pub status: DeviceConnectRequestStatus,
    pub expires_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<DeviceCredential>,
}
