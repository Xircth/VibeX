use remote_protocol::{OperationId, ServerCapabilities};
use serde_json::Value;
use tauri::ipc::Channel;

use crate::{error::AppError, remote_desktop::RemoteDesktopProfileInput, state::AppState};

#[tauri::command]
pub async fn remote_desktop_connect(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    profile: RemoteDesktopProfileInput,
) -> Result<(), AppError> {
    state
        .remote_desktop
        .connect(
            window.label(),
            &profile.profile_id,
            &profile.base_url,
            profile.token,
        )
        .await
}

#[tauri::command]
pub async fn remote_desktop_disconnect(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<(), AppError> {
    state
        .remote_desktop
        .disconnect(window.label(), &profile_id)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn remote_desktop_call(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    profile_id: String,
    command: String,
    args: Value,
    operation_id: Option<String>,
) -> Result<Value, AppError> {
    let operation_id = operation_id
        .map(|value| OperationId::parse(&value))
        .transpose()
        .map_err(|error| AppError::BadRequest(format!("invalid operation id: {error}")))?;
    state
        .remote_desktop
        .call(window.label(), &profile_id, &command, args, operation_id)
        .await
}

#[tauri::command]
pub async fn remote_desktop_capabilities(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<ServerCapabilities, AppError> {
    state
        .remote_desktop
        .capabilities(window.label(), &profile_id)
        .await
}

#[tauri::command]
pub async fn remote_desktop_listen(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    profile_id: String,
    event: String,
) -> Result<(), AppError> {
    state
        .remote_desktop
        .listen_host_event(app, window.label(), &profile_id, event)
        .await
}

#[tauri::command]
pub async fn remote_desktop_subscribe(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    profile_id: String,
    request: Value,
    on_event: Channel<Value>,
) -> Result<(), AppError> {
    state
        .remote_desktop
        .subscribe_events(window.label(), &profile_id, request, on_event)
        .await
}
