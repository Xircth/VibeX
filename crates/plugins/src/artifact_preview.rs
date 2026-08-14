use std::sync::Arc;

use serde_json::{Value, json};

use crate::{
    HostCapabilityBroker, PluginControlPlane, PluginPreviewHostError, PluginPreviewRequest,
    PluginPreviewSession,
};

/// Routes an Artifact preview through the published Worker generation before
/// the Worker enters the capability Broker. This is shared by Desktop and
/// Server and contains no provider-specific behavior.
pub struct PluginArtifactPreviewService {
    plugins: Arc<PluginControlPlane>,
    broker: Arc<HostCapabilityBroker>,
}

impl PluginArtifactPreviewService {
    pub fn new(plugins: Arc<PluginControlPlane>, broker: Arc<HostCapabilityBroker>) -> Self {
        Self { plugins, broker }
    }

    pub async fn open(
        &self,
        request: PluginPreviewRequest,
    ) -> Result<PluginPreviewSession, PluginPreviewHostError> {
        let plugin = self
            .plugins
            .plugin(&request.plugin_id)
            .await
            .map_err(registry_error)?
            .ok_or_else(|| preview_error("PLUGIN_MISSING", "Artifact plugin is not installed"))?;
        if plugin.version != request.plugin_version {
            return Err(preview_error(
                "GENERATION_STALE",
                "Artifact was produced by a different plugin version",
            ));
        }
        let provider = plugin
            .app
            .preview_providers
            .iter()
            .find(|provider| provider.id == request.provider_id)
            .ok_or_else(|| {
                preview_error(
                    "PROVIDER_MISSING",
                    "Artifact preview provider is not published",
                )
            })?;
        let handler = provider.handler.as_str();
        if handler.is_empty() {
            return Err(preview_error(
                "PROVIDER_PROTOCOL_MISSING",
                "Artifact preview provider has no Worker handler",
            ));
        }
        let lease = self
            .plugins
            .activation_lease(&request.plugin_id)
            .await
            .ok_or_else(|| {
                preview_error(
                    "WORKER_GENERATION_MISSING",
                    "Artifact plugin Worker is not active",
                )
            })?;
        let mut request = request;
        request.generation = lease.activation().generation;
        request.package_digest = lease.activation().package_digest.clone();
        let artifact_handle = self
            .broker
            .issue_artifact_handle(
                &request.plugin_id,
                lease.activation().generation,
                request.clone(),
            )
            .await
            .map_err(|error| preview_error("ARTIFACT_HANDLE_FAILED", error.to_string()))?;
        let value = lease
            .invoke(
                handler,
                json!({
                    "artifactHandle": artifact_handle,
                    "providerId": request.provider_id,
                }),
            )
            .await;
        if value.is_err() {
            self.broker.revoke_artifact_handle(&artifact_handle).await;
        }
        let value =
            value.map_err(|error| preview_error("PREVIEW_WORKER_FAILED", error.to_string()))?;
        decode_worker_lease(value)
    }

    pub async fn close(
        &self,
        file_path: &str,
        lease_id: Option<&str>,
    ) -> Result<(), PluginPreviewHostError> {
        self.broker.close_preview(file_path, lease_id).await
    }
}

fn decode_worker_lease(value: Value) -> Result<PluginPreviewSession, PluginPreviewHostError> {
    let required_string = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| preview_error("PREVIEW_PROTOCOL_INVALID", format!("{key} is missing")))
    };
    let required_u64 = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_u64)
            .ok_or_else(|| preview_error("PREVIEW_PROTOCOL_INVALID", format!("{key} is missing")))
    };
    let port = required_u64("port")?;
    Ok(PluginPreviewSession {
        lease_id: required_string("leaseId")?,
        loopback_port: u16::try_from(port)
            .map_err(|_| preview_error("PREVIEW_PROTOCOL_INVALID", "port is outside u16"))?,
        capability_token: required_string("capabilityToken")?,
        expires_at_unix_ms: required_u64("expiresAtUnixMs")?,
    })
}

fn registry_error(error: crate::PluginError) -> PluginPreviewHostError {
    preview_error("PLUGIN_REGISTRY_FAILED", error.to_string())
}

fn preview_error(code: &'static str, message: impl Into<String>) -> PluginPreviewHostError {
    PluginPreviewHostError::new(code, message)
}
