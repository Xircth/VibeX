use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Open capability identifier. Unknown values are intentionally preserved so
/// older clients can safely negotiate with newer servers.
#[derive(
    Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS,
)]
#[serde(transparent)]
pub struct CapabilityId(String);

impl CapabilityId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Response payload for protocol and feature negotiation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
pub struct ServerCapabilities {
    pub server_version: String,
    pub protocol_version: String,
    pub minimum_client_version: String,
    pub capabilities: Vec<CapabilityId>,
}

impl ServerCapabilities {
    pub fn supports(&self, capability: &CapabilityId) -> bool {
        self.capabilities.contains(capability)
    }
}
