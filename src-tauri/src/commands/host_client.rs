use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    error::AppError,
    host_client::{
        ConnectHostRequest, ConnectHostResult, DiscoveredHost, HostClientStatus, runtime,
    },
    state::AppState,
};

#[tauri::command]
pub async fn host_client_status(
    state: tauri::State<'_, AppState>,
) -> Result<HostClientStatus, AppError> {
    runtime().set_local_host_id(local_host_id().await).await;
    runtime().status(&state.remote_desktop).await
}

#[tauri::command]
pub async fn host_client_discover() -> Result<Vec<DiscoveredHost>, AppError> {
    runtime().set_local_host_id(local_host_id().await).await;
    runtime().discover().await
}

#[tauri::command]
pub async fn host_client_connect(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    mut request: ConnectHostRequest,
) -> Result<ConnectHostResult, AppError> {
    runtime().set_local_host_id(local_host_id().await).await;
    if request
        .origin
        .as_deref()
        .map(str::trim)
        .is_none_or(str::is_empty)
    {
        ensure_provisioned_origin(&state, &mut request).await?;
    }
    runtime()
        .connect(window.label(), &state.remote_desktop, request, async {
            super::web_service::stop_if_running().await
        })
        .await
}

async fn ensure_provisioned_origin(
    state: &tauri::State<'_, AppState>,
    request: &mut ConnectHostRequest,
) -> Result<(), AppError> {
    let Some(profile_id) = request.profile_id.as_deref() else {
        return Ok(());
    };
    let Some(profile) = runtime().profile(profile_id).await? else {
        return Ok(());
    };
    let kind = profile.provision_kind.as_deref().unwrap_or("manual");
    if !plugins::provision_kind_needs_ensure(kind) {
        return Ok(());
    }
    let catalog = state
        .plugin_control_plane
        .contributions()
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let provisioner = catalog.items.iter().find(|item| {
        item.kind == plugins::ContributionKind::RemoteProvisioner
            && item.metadata.get("provisionKind").and_then(Value::as_str) == Some(kind)
    });
    let Some(provisioner) = provisioner else {
        return Err(AppError::BadRequest(
            "this Host needs a provisioner that is not installed or not enabled".to_string(),
        ));
    };
    let handler = provisioner
        .metadata
        .get("handler")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Internal("provisioner handler is missing".to_string()))?;
    let timeout_seconds = provisioner
        .metadata
        .get("timeoutSeconds")
        .and_then(Value::as_u64)
        .unwrap_or(120)
        .clamp(5, 600);
    let lease = state
        .plugin_control_plane
        .activation_lease(&provisioner.plugin_id)
        .await
        .ok_or_else(|| {
            AppError::BadRequest(
                "this Host needs a provisioner that is not installed or not enabled".to_string(),
            )
        })?;
    let ensured = lease
        .invoke_with_timeout(
            handler,
            json!({
                "operation": "ensure",
                "profile": {
                    "id": profile.id,
                    "origin": profile.origin,
                    "provisionKind": kind,
                    "provision": profile.provision,
                    "hasCredential": profile.has_credential,
                }
            }),
            Duration::from_secs(timeout_seconds),
        )
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let origin = ensured
        .get("origin")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::Internal("provisioner did not return a Host address".to_string())
        })?;
    request.origin = Some(origin.to_string());
    if request
        .token
        .as_deref()
        .map(str::trim)
        .is_none_or(str::is_empty)
        && let Some(token) = ensured.get("token").and_then(Value::as_str)
    {
        request.token = Some(token.to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn host_client_disconnect(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    runtime().disconnect(&state.remote_desktop).await
}

#[derive(Deserialize)]
pub struct DeleteHostRequest {
    pub profile_id: String,
}

#[tauri::command]
pub async fn host_client_delete(
    state: tauri::State<'_, AppState>,
    request: DeleteHostRequest,
) -> Result<(), AppError> {
    runtime()
        .delete(&state.remote_desktop, &request.profile_id)
        .await
}

async fn local_host_id() -> Option<String> {
    tokio::task::spawn_blocking(|| {
        utils::assets::load_or_create_host_id(&utils::assets::asset_dir()).ok()
    })
    .await
    .ok()
    .flatten()
}
