use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A saved client Host profile as a plugin is allowed to see it.
///
/// Device credentials never cross this boundary. Full Trust could still read
/// the store off disk; the broker still refuses to be the thing that hands
/// tokens to plugin logs.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostProfile {
    pub id: String,
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    pub name: String,
    pub provision_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provision: Option<Value>,
    pub has_credential: bool,
    pub connected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<String>,
}

/// Create or overwrite a saved Host. `provisionKind` is a Host-owned source
/// tag (`manual`, `discovered`, `ssh`, …), not a plugin id.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostProfileDraft {
    #[serde(default)]
    pub id: Option<String>,
    pub origin: String,
    #[serde(default)]
    pub name: Option<String>,
    pub provision_kind: String,
    #[serde(default)]
    pub provision: Option<Value>,
}

/// Ask the Host to attach the app shell to a saved or just-provisioned Host.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectRequest {
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectResult {
    pub profile: RemoteHostProfile,
    pub stopped_host: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteProfileErrorCode {
    Unavailable,
    Invalid,
    NotFound,
    ConnectFailed,
    ProvisionerMissing,
}

impl RemoteProfileErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "remote_profiles_unavailable",
            Self::Invalid => "remote_profile_invalid",
            Self::NotFound => "remote_profile_not_found",
            Self::ConnectFailed => "remote_connect_failed",
            Self::ProvisionerMissing => "remote_provisioner_missing",
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct RemoteProfileError {
    code: RemoteProfileErrorCode,
    message: String,
}

impl RemoteProfileError {
    pub fn new(code: RemoteProfileErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> RemoteProfileErrorCode {
        self.code
    }
}

/// Host seam for the client saved-Host list. Uninstall of a plugin must not
/// call [`RemoteProfileHost::forget`]; these records belong to the Host.
#[async_trait]
pub trait RemoteProfileHost: Send + Sync {
    async fn list(&self) -> Result<Vec<RemoteHostProfile>, RemoteProfileError>;

    async fn upsert(
        &self,
        plugin_id: &str,
        draft: RemoteHostProfileDraft,
    ) -> Result<RemoteHostProfile, RemoteProfileError>;

    async fn forget(&self, plugin_id: &str, profile_id: &str) -> Result<(), RemoteProfileError>;

    async fn connect(
        &self,
        plugin_id: &str,
        request: RemoteConnectRequest,
    ) -> Result<RemoteConnectResult, RemoteProfileError>;

    async fn disconnect(&self, plugin_id: &str) -> Result<(), RemoteProfileError>;
}

/// Headless composition has no client profile store.
pub struct UnavailableRemoteProfileHost;

fn unavailable() -> RemoteProfileError {
    RemoteProfileError::new(
        RemoteProfileErrorCode::Unavailable,
        "this Host has no client profile store",
    )
}

#[async_trait]
impl RemoteProfileHost for UnavailableRemoteProfileHost {
    async fn list(&self) -> Result<Vec<RemoteHostProfile>, RemoteProfileError> {
        Err(unavailable())
    }

    async fn upsert(
        &self,
        _plugin_id: &str,
        _draft: RemoteHostProfileDraft,
    ) -> Result<RemoteHostProfile, RemoteProfileError> {
        Err(unavailable())
    }

    async fn forget(&self, _plugin_id: &str, _profile_id: &str) -> Result<(), RemoteProfileError> {
        Err(unavailable())
    }

    async fn connect(
        &self,
        _plugin_id: &str,
        _request: RemoteConnectRequest,
    ) -> Result<RemoteConnectResult, RemoteProfileError> {
        Err(unavailable())
    }

    async fn disconnect(&self, _plugin_id: &str) -> Result<(), RemoteProfileError> {
        Err(unavailable())
    }
}

/// True when connecting this Host requires a matching remote provisioner.
pub fn provision_kind_needs_ensure(kind: &str) -> bool {
    let kind = kind.trim();
    !kind.is_empty() && kind != "manual" && kind != "discovered"
}
