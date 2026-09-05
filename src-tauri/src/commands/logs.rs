//! Commands backing Settings → Logs.

use tauri::AppHandle;

use crate::{
    error::AppError,
    logging::{
        LOG_SETTINGS_CHANGED_EVENT, LogSettings, LogSettingsView,
        hub::{LogRecord, log_hub},
        init::{env_level_is_set, load_persisted_settings, persist_settings, sanitize_settings},
    },
};

const DEFAULT_LIMIT: usize = 500;
const MAX_LIMIT: usize = 5_000;

#[tauri::command]
pub async fn get_log_settings() -> Result<LogSettingsView, AppError> {
    let settings = load_persisted_settings();
    Ok(LogSettingsView {
        level: settings.level,
        targets: settings.targets,
        env_locked: env_level_is_set(),
    })
}

#[tauri::command]
pub async fn set_log_settings(
    settings: LogSettings,
    _app: AppHandle,
) -> Result<LogSettings, AppError> {
    let settings = sanitize_settings(settings);
    persist_settings(&settings).map_err(AppError::Internal)?;
    if !env_level_is_set() {
        if let Some(hub) = log_hub() {
            hub.apply_settings(&settings);
        }
    }
    server::global_host_events().emit(LOG_SETTINGS_CHANGED_EVENT, &settings);
    Ok(settings)
}

#[tauri::command]
pub async fn get_recent_logs(limit: Option<usize>) -> Result<Vec<LogRecord>, AppError> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    Ok(match log_hub() {
        Some(hub) => {
            let mut records = hub.snapshot();
            if records.len() > limit {
                records.drain(0..records.len() - limit);
            }
            records
        }
        None => Vec::new(),
    })
}

#[tauri::command]
pub async fn get_logs_dir() -> Result<String, AppError> {
    Ok(utils::assets::logs_dir().to_string_lossy().to_string())
}
