use serde::Deserialize;
use tauri::{Emitter, Manager};

use crate::{
    error::AppError,
    host_client::{
        ApplyHostUpdateResult, ConnectHostRequest, ConnectHostResult, DiscoveredHost,
        HOST_CLIENT_CHANGED, HostClientStatus, SavedHostUpdateView, advertised_connect_origin,
        runtime,
    },
    host_windows::host_app_window_label,
    state::AppState,
};

#[tauri::command]
pub async fn host_client_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<HostClientStatus, AppError> {
    runtime().set_local_host_id(local_host_id().await).await;
    runtime()
        .status(&state.remote_desktop, window.label())
        .await
}

#[tauri::command]
pub async fn host_client_discover() -> Result<Vec<DiscoveredHost>, AppError> {
    runtime().set_local_host_id(local_host_id().await).await;
    runtime().discover().await
}

#[tauri::command]
pub async fn host_client_host_updates() -> Result<Vec<SavedHostUpdateView>, AppError> {
    runtime().probe_updates().await
}

#[derive(Deserialize)]
pub struct ApplyHostUpdateRequest {
    pub profile_id: String,
}

const HOST_UPDATE_UNREACHABLE: &str = "host_update_unreachable";

#[tauri::command]
pub async fn host_client_apply_host_update(
    request: ApplyHostUpdateRequest,
) -> Result<ApplyHostUpdateResult, AppError> {
    let Some(profile) = runtime().profile(&request.profile_id).await? else {
        return Err(AppError::NotFound("saved Host was not found".to_string()));
    };
    let origin = advertised_connect_origin(&profile.origin, profile.provision.as_ref());
    let Some(token) = runtime().access_token(&request.profile_id).await? else {
        return Err(AppError::BadRequest(HOST_UPDATE_UNREACHABLE.to_string()));
    };
    runtime()
        .apply_host_upgrade(&origin, &token)
        .await
        .map_err(map_host_update_error)
}

fn map_host_update_error(error: AppError) -> AppError {
    match &error {
        AppError::BadRequest(message)
            if message == HOST_UPDATE_UNREACHABLE || message.contains("could not reach Host") =>
        {
            AppError::BadRequest(HOST_UPDATE_UNREACHABLE.to_string())
        }
        _ => error,
    }
}

#[tauri::command]
pub async fn host_client_connect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    request: ConnectHostRequest,
) -> Result<ConnectHostResult, AppError> {
    runtime().set_local_host_id(local_host_id().await).await;
    connect_and_open_window(&app, window.label(), &state.remote_desktop, request).await
}

pub(crate) async fn connect_and_open_window(
    app: &tauri::AppHandle,
    caller_window: &str,
    registry: &crate::remote_desktop::RemoteDesktopRegistry,
    request: ConnectHostRequest,
) -> Result<ConnectHostResult, AppError> {
    let result = runtime().connect(caller_window, registry, request).await?;
    super::host_window::open_or_focus_host_window(app, &result.profile)?;
    let _ = app.emit(HOST_CLIENT_CHANGED, ());
    Ok(result)
}

#[tauri::command]
pub async fn host_client_disconnect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let label = window.label().to_string();
    runtime()
        .disconnect_window(&state.remote_desktop, &label)
        .await?;
    let _ = app.emit(HOST_CLIENT_CHANGED, ());
    if host_app_window_label(&label).is_some() {
        super::host_window::close_host_family(&app, &label);
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct DeleteHostRequest {
    pub profile_id: String,
}

#[tauri::command]
pub async fn host_client_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: DeleteHostRequest,
) -> Result<(), AppError> {
    let windows = runtime()
        .delete(&state.remote_desktop, &request.profile_id)
        .await?;
    for label in windows {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }
    let _ = app.emit(HOST_CLIENT_CHANGED, ());
    Ok(())
}

async fn local_host_id() -> Option<String> {
    tokio::task::spawn_blocking(|| {
        utils::assets::load_or_create_host_id(&utils::assets::asset_dir()).ok()
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::{HOST_UPDATE_UNREACHABLE, map_host_update_error};
    use crate::error::AppError;

    #[test]
    fn connection_failures_use_the_unreachable_update_error() {
        match map_host_update_error(AppError::BadRequest(
            "could not reach Host: timeout".to_string(),
        )) {
            AppError::BadRequest(message) => assert_eq!(message, HOST_UPDATE_UNREACHABLE),
            other => panic!("unexpected {other:?}"),
        }
        match map_host_update_error(AppError::BadRequest(
            "Host is already on the latest version".to_string(),
        )) {
            AppError::BadRequest(message) => {
                assert_eq!(message, "Host is already on the latest version")
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
