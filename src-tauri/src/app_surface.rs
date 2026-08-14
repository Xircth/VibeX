use serde_json::Value;
use tauri::State;

use crate::{error::AppError, state::AppState};

#[tauri::command]
pub async fn plugin_surface_open(
    state: State<'_, AppState>,
    plugin_id: String,
    surface_id: String,
    generation: u64,
    token: String,
    artifact_path: Option<String>,
) -> Result<plugins::AppSurfaceDocument, AppError> {
    state
        .plugin_app_surfaces
        .open(plugins::AppSurfaceOpenRequest {
            identity: plugins::AppSurfaceIdentity {
                plugin_id,
                surface_id,
                generation,
                token,
            },
            artifact_path: artifact_path.map(Into::into),
        })
        .await
        .map_err(app_surface_error)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn plugin_surface_invoke(
    state: State<'_, AppState>,
    plugin_id: String,
    surface_id: String,
    generation: u64,
    token: String,
    request_id: String,
    sequence: u64,
    method: String,
    params: Value,
) -> Result<Value, AppError> {
    state
        .plugin_app_surfaces
        .invoke(plugins::AppSurfaceInvocation {
            identity: plugins::AppSurfaceIdentity {
                plugin_id,
                surface_id,
                generation,
                token,
            },
            request_id,
            sequence,
            method,
            params,
        })
        .await
        .map_err(app_surface_error)
}

#[tauri::command]
pub async fn plugin_surface_revoke(
    state: State<'_, AppState>,
    plugin_id: String,
    surface_id: String,
    generation: u64,
    token: String,
    reason: String,
) -> Result<(), AppError> {
    tracing::debug!(%plugin_id, %surface_id, %reason, "App surface session revoked");
    state
        .plugin_app_surfaces
        .revoke(&plugins::AppSurfaceIdentity {
            plugin_id,
            surface_id,
            generation,
            token,
        })
        .await
        .map_err(app_surface_error)
}

fn app_surface_error(error: plugins::AppSurfaceError) -> AppError {
    match error.kind() {
        plugins::AppSurfaceErrorKind::NotFound => AppError::NotFound(error.to_string()),
        plugins::AppSurfaceErrorKind::BadRequest => AppError::BadRequest(error.to_string()),
        plugins::AppSurfaceErrorKind::Conflict => AppError::Conflict(error.to_string()),
        plugins::AppSurfaceErrorKind::Internal => AppError::Internal(error.to_string()),
    }
}
