use serde::Deserialize;

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
    request: ConnectHostRequest,
) -> Result<ConnectHostResult, AppError> {
    runtime().set_local_host_id(local_host_id().await).await;
    runtime()
        .connect(window.label(), &state.remote_desktop, request, async {
            super::web_service::stop_if_running().await
        })
        .await
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
