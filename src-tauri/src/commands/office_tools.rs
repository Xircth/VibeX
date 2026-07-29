//! Thin Tauri adapter for the managed Office Artifact provider.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::{error::AppError, state::AppState};

pub const OFFICECLI_INSTALL_EVENT: &str = "officecli-install";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficecliInfo {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub runtime_error: Option<String>,
}

impl OfficecliInfo {
    fn missing() -> Self {
        Self {
            installed: false,
            version: None,
            path: None,
            runtime_error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct OfficecliInstallEvent {
    task_id: String,
    kind: &'static str,
    payload: String,
}

fn emit_install(app: &AppHandle, task_id: &str, kind: &'static str, payload: impl Into<String>) {
    let _ = app.emit(
        OFFICECLI_INSTALL_EVENT,
        OfficecliInstallEvent {
            task_id: task_id.to_owned(),
            kind,
            payload: payload.into(),
        },
    );
}

#[tauri::command]
pub async fn officecli_detect(state: State<'_, AppState>) -> Result<OfficecliInfo, AppError> {
    Ok(match state.office_runtime.detect().await {
        Ok(Some(lock)) => OfficecliInfo {
            installed: true,
            version: Some(lock.version),
            path: Some(lock.executable_path.to_string_lossy().into_owned()),
            runtime_error: None,
        },
        Ok(None) => OfficecliInfo::missing(),
        Err(error) => OfficecliInfo {
            runtime_error: Some(error.to_string()),
            ..OfficecliInfo::missing()
        },
    })
}

#[tauri::command]
pub async fn officecli_install(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<OfficecliInfo, AppError> {
    if task_id.trim().is_empty() {
        return Err(AppError::BadRequest("taskId must not be empty".into()));
    }
    emit_install(
        &app,
        &task_id,
        "started",
        "Downloading the version-locked OfficeCLI distribution…",
    );
    emit_install(
        &app,
        &task_id,
        "log",
        "The download will be verified with the bundled SHA-256 before execution.",
    );
    match state.office_runtime.install(&task_id).await {
        Ok(lock) => {
            emit_install(
                &app,
                &task_id,
                "completed",
                format!("OfficeCLI {} is ready.", lock.version),
            );
            Ok(OfficecliInfo {
                installed: true,
                version: Some(lock.version),
                path: Some(lock.executable_path.to_string_lossy().into_owned()),
                runtime_error: None,
            })
        }
        Err(error) => {
            emit_install(&app, &task_id, "failed", error.to_string());
            Err(AppError::Internal(error.to_string()))
        }
    }
}

#[tauri::command]
pub async fn officecli_cancel_install(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<bool, AppError> {
    Ok(state.office_runtime.cancel_install(&task_id).await)
}

#[tauri::command]
pub async fn officecli_uninstall(state: State<'_, AppState>) -> Result<OfficecliInfo, AppError> {
    state
        .office_runtime
        .uninstall()
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(OfficecliInfo::missing())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWatchStartResult {
    pub port: Option<u16>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[tauri::command]
pub async fn start_office_watch(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<OfficeWatchStartResult, AppError> {
    Ok(
        match state
            .office_runtime
            .start_compatibility_preview(&file_path)
            .await
        {
            Ok(port) => OfficeWatchStartResult {
                port: Some(port),
                error_code: None,
                error_message: None,
            },
            Err(error) => OfficeWatchStartResult {
                port: None,
                error_code: Some(error.code().to_owned()),
                error_message: Some(error.to_string()),
            },
        },
    )
}

#[tauri::command]
pub async fn stop_office_watch(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<(), AppError> {
    state
        .office_runtime
        .stop_compatibility_preview(&file_path)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::OfficecliInfo;

    #[test]
    fn missing_info_preserves_frontend_contract() {
        let value = serde_json::to_value(OfficecliInfo::missing()).unwrap();
        assert_eq!(value["installed"], false);
        assert!(value["version"].is_null());
        assert!(value["path"].is_null());
        assert!(value["runtimeError"].is_null());
    }
}
