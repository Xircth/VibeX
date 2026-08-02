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

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct CreatePairingRequest {
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
