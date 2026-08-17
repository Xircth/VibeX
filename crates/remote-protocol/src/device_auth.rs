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
