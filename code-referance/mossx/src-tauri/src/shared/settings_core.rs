use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::codex::config as codex_config;
use crate::shared::proxy_core;
use crate::storage::write_settings;
use crate::types::AppSettings;

fn sync_codex_config_flags(settings: &AppSettings) {
    let _ = codex_config::write_collab_enabled(settings.experimental_collab_enabled);
    let _ = codex_config::write_collaboration_modes_enabled(
        settings.experimental_collaboration_modes_enabled,
    );
    let _ = codex_config::write_steer_enabled(settings.experimental_steer_enabled);
    let _ = codex_config::write_unified_exec_enabled(settings.experimental_unified_exec_enabled);
    let _ =
        codex_config::write_codex_mode_enforcement_enabled(settings.codex_mode_enforcement_enabled);
}

pub(crate) async fn get_app_settings_core(app_settings: &Mutex<AppSettings>) -> AppSettings {
    let mut settings = app_settings.lock().await.clone();
    if let Ok(Some(collab_enabled)) = codex_config::read_collab_enabled() {
        settings.experimental_collab_enabled = collab_enabled;
    }
    if let Ok(Some(collaboration_modes_enabled)) = codex_config::read_collaboration_modes_enabled()
    {
        settings.experimental_collaboration_modes_enabled = collaboration_modes_enabled;
    }
    if let Ok(Some(steer_enabled)) = codex_config::read_steer_enabled() {
        settings.experimental_steer_enabled = steer_enabled;
    }
    if let Ok(Some(unified_exec_enabled)) = codex_config::read_unified_exec_enabled() {
        settings.experimental_unified_exec_enabled = unified_exec_enabled;
    }
    if let Ok(Some(mode_enforcement_enabled)) = codex_config::read_codex_mode_enforcement_enabled()
    {
        settings.codex_mode_enforcement_enabled = mode_enforcement_enabled;
    }
    settings
}

pub(crate) async fn update_app_settings_core(
    settings: AppSettings,
    app_settings: &Mutex<AppSettings>,
    settings_path: &PathBuf,
) -> Result<AppSettings, String> {
    proxy_core::validate_proxy_settings(&settings)?;
    sync_codex_config_flags(&settings);
    write_settings(settings_path, &settings)?;
    proxy_core::apply_app_proxy_settings(&settings)?;
    let mut current = app_settings.lock().await;
    *current = settings.clone();
    Ok(settings)
}

pub(crate) async fn restore_app_settings_core(
    previous: &AppSettings,
    app_settings: &Mutex<AppSettings>,
    settings_path: &PathBuf,
) -> Result<(), String> {
    sync_codex_config_flags(previous);
    write_settings(settings_path, previous)?;
    proxy_core::apply_app_proxy_settings(previous)?;
    let mut current = app_settings.lock().await;
    *current = previous.clone();
    Ok(())
}

pub(crate) async fn restart_codex_sessions_for_app_settings_change_core<F, Fut>(
    workspaces: &Mutex<std::collections::HashMap<String, crate::types::WorkspaceEntry>>,
    sessions: &Mutex<
        std::collections::HashMap<String, Arc<crate::backend::app_server::WorkspaceSession>>,
    >,
    app_settings: &Mutex<AppSettings>,
    spawn_session: F,
) -> Result<(), String>
where
    F: Fn(crate::types::WorkspaceEntry, Option<String>, Option<String>, Option<PathBuf>) -> Fut
        + Copy,
    Fut: std::future::Future<
        Output = Result<Arc<crate::backend::app_server::WorkspaceSession>, String>,
    >,
{
    crate::shared::workspaces_core::restart_all_connected_sessions_core(
        workspaces,
        sessions,
        app_settings,
        spawn_session,
    )
    .await
}

pub(crate) fn get_codex_config_path_core() -> Result<String, String> {
    codex_config::config_toml_path()
        .ok_or_else(|| "Unable to resolve CODEX_HOME".to_string())
        .and_then(|path| {
            path.to_str()
                .map(|value| value.to_string())
                .ok_or_else(|| "Unable to resolve CODEX_HOME".to_string())
        })
}
