use artifacts::{ArtifactRepository, SqliteArtifactRepository};
use serde::Serialize;
use tauri::State;
use ts_rs::TS;

use crate::{error::AppError, state::AppState};

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ArtifactPreviewLeaseDto {
    pub lease_id: uuid::Uuid,
    pub artifact_id: uuid::Uuid,
    pub provider_id: String,
    pub loopback_port: u16,
    pub capability_token: String,
    pub expires_at_unix_ms: u64,
    pub preview_url: String,
    pub docx_fallback_supported: bool,
}

#[tauri::command]
pub async fn artifact_open_preview(
    state: State<'_, AppState>,
    preview_proxy: State<'_, crate::plugin_dev_server::DesktopPreviewProxy>,
    artifact_id: uuid::Uuid,
) -> Result<ArtifactPreviewLeaseDto, AppError> {
    let repository = SqliteArtifactRepository::new(state.deployment.db().pool.clone());
    let artifact = repository
        .find(artifact_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
        .ok_or_else(|| AppError::NotFound(format!("artifact {artifact_id}")))?;
    let path = artifact.scope_root.join(&artifact.relative_path);
    let path = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let service = plugins::PluginArtifactPreviewService::new(
        state.plugin_control_plane.clone(),
        state.plugin_capability_broker.clone(),
    );
    let provider_id = artifact.producer.provider_id.clone();
    let lease = service
        .open(plugins::PluginPreviewRequest {
            file_path: path.to_string_lossy().into_owned(),
            media_type: artifact.media_type,
            plugin_id: artifact.producer.plugin_id,
            plugin_version: artifact.producer.plugin_version,
            provider_id: provider_id.clone(),
            generation: 0,
            package_digest: String::new(),
        })
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let lease_id = uuid::Uuid::parse_str(&lease.lease_id)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let preview_url = preview_proxy
        .register(&lease)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(ArtifactPreviewLeaseDto {
        lease_id,
        artifact_id,
        provider_id,
        loopback_port: lease.loopback_port,
        capability_token: lease.capability_token,
        expires_at_unix_ms: lease.expires_at_unix_ms,
        preview_url,
        docx_fallback_supported: false,
    })
}

#[tauri::command]
pub async fn artifact_close_preview(
    state: State<'_, AppState>,
    preview_proxy: State<'_, crate::plugin_dev_server::DesktopPreviewProxy>,
    lease_id: uuid::Uuid,
) -> Result<(), AppError> {
    preview_proxy.revoke(&lease_id.to_string()).await;
    plugins::PluginArtifactPreviewService::new(
        state.plugin_control_plane.clone(),
        state.plugin_capability_broker.clone(),
    )
    .close("", Some(&lease_id.to_string()))
    .await
    .map_err(|error| AppError::Internal(error.to_string()))
}
