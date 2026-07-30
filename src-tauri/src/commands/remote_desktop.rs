use remote_protocol::ServerCapabilities;
use serde_json::Value;

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
) -> Result<Value, AppError> {
    state
        .remote_desktop
        .call(window.label(), &profile_id, &command, args)
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
