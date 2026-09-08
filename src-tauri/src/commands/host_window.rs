use tauri::Manager;

use crate::{
    error::AppError,
    host_client::HostClientProfileView,
    host_windows::{
        host_app_window_label, host_settings_window_for_app, host_webview_data_directory,
        host_window_label, host_window_title,
    },
};

pub fn close_host_family(app: &tauri::AppHandle, window_label: &str) {
    let Some(host_label) = host_app_window_label(window_label) else {
        return;
    };
    if let Some(settings_label) = host_settings_window_for_app(host_label)
        && let Some(settings) = app.get_webview_window(&settings_label)
    {
        let _ = settings.close();
    }
    if let Some(host) = app.get_webview_window(host_label) {
        let _ = host.close();
    }
}

pub fn open_or_focus_host_window(
    app: &tauri::AppHandle,
    profile: &HostClientProfileView,
) -> Result<String, AppError> {
    let label = host_window_label(&profile.id);
    let title = host_window_title(&profile.name);
    if let Some(window) = app.get_webview_window(&label) {
        crate::apply_app_icon(&window).map_err(AppError::Internal)?;
        window
            .set_title(&title)
            .map_err(|error| AppError::Internal(error.to_string()))?;
        let _ = window.unminimize();
        let _ = window.show();
        window
            .set_focus()
            .map_err(|error| AppError::Internal(error.to_string()))?;
        return Ok(label);
    }

    let mut builder = crate::window_chrome::apply_app_window_chrome(
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("/".into()))
            .title(title)
            .inner_size(1400.0, 900.0)
            .min_inner_size(800.0, 600.0)
            .resizable(true)
            .center(),
    );
    if let Some(data_directory) = host_webview_data_directory(&label) {
        builder = builder.data_directory(data_directory);
    }

    let builder = builder
        .icon(crate::load_app_icon().map_err(AppError::Internal)?)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let window = builder
        .build()
        .map_err(|error| AppError::Internal(error.to_string()))?;
    crate::window_chrome::apply_created_window_chrome(&window);
    Ok(label)
}
