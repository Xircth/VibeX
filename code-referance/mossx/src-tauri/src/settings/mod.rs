use tauri::{Manager, State, Window};

use crate::shared::settings_core::{
    get_app_settings_core, get_codex_config_path_core,
    restart_codex_sessions_for_app_settings_change_core, restore_app_settings_core,
    update_app_settings_core,
};
use crate::state::AppState;
use crate::types::AppSettings;
use crate::window;

#[tauri::command]
pub(crate) async fn get_app_settings(
    state: State<'_, AppState>,
    window: Window,
) -> Result<AppSettings, String> {
    let settings = get_app_settings_core(&state.app_settings).await;
    let _ = window::apply_window_appearance(&window, settings.theme.as_str());
    Ok(settings)
}

#[tauri::command]
pub(crate) async fn update_app_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
    window: Window,
) -> Result<AppSettings, String> {
    let previous = state.app_settings.lock().await.clone();
    let updated =
        update_app_settings_core(settings, &state.app_settings, &state.settings_path).await?;
    let proxy_changed = previous.system_proxy_enabled != updated.system_proxy_enabled
        || previous.system_proxy_url != updated.system_proxy_url;
    if proxy_changed {
        if let Err(error) = restart_codex_sessions_for_app_settings_change_core(
            &state.workspaces,
            &state.sessions,
            &state.app_settings,
            |entry, default_bin, codex_args, codex_home| {
                crate::backend::app_server::spawn_workspace_session(
                    entry,
                    default_bin,
                    codex_args,
                    codex_home,
                    env!("CARGO_PKG_VERSION").to_string(),
                    crate::event_sink::TauriEventSink::new(window.app_handle().clone()),
                )
            },
        )
        .await
        {
            let rollback_error =
                restore_app_settings_core(&previous, &state.app_settings, &state.settings_path)
                    .await
                    .err();
            let message = match rollback_error {
                Some(rollback_error) => {
                    format!("{error} (rollback failed: {rollback_error})")
                }
                None => error,
            };
            return Err(message);
        }
    }
    let _ = window::apply_window_appearance(&window, updated.theme.as_str());
    Ok(updated)
}

#[tauri::command]
pub(crate) async fn get_codex_config_path() -> Result<String, String> {
    get_codex_config_path_core()
}
