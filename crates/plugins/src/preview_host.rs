use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPreviewRequest {
    pub file_path: String,
    pub media_type: String,
    pub plugin_id: String,
    pub plugin_version: String,
    pub provider_id: String,
    #[serde(default)]
    pub generation: u64,
    #[serde(default)]
    pub package_digest: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPreviewSession {
    pub lease_id: String,
    pub loopback_port: u16,
    pub capability_token: String,
    pub expires_at_unix_ms: u64,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct PluginPreviewHostError {
    code: String,
    message: String,
}

impl PluginPreviewHostError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }
}

/// Host seam used by product surfaces after Contribution Registry resolution.
/// Implementations are provider adapters; callers never dispatch on plugin IDs
/// or file extensions.
#[async_trait]
pub trait PluginPreviewHost: Send + Sync {
    async fn open_preview(
        &self,
        request: PluginPreviewRequest,
    ) -> Result<PluginPreviewSession, PluginPreviewHostError>;

    async fn close_preview(
        &self,
        file_path: &str,
        lease_id: Option<&str>,
    ) -> Result<(), PluginPreviewHostError>;
}
