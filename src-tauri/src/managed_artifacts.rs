use std::path::PathBuf;

use tauri::{AppHandle, Manager};

pub(crate) fn directory(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let home_dir = app
        .path()
        .home_dir()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(utils::path::managed_artifacts_directory(
        &home_dir,
        &app_data_dir,
    ))
}
