use std::path::PathBuf;

use crate::{error::AppError, host_windows::webview_profile_directory};

pub const APP_WINDOW_PREFIX: &str = "app-";

pub fn new_app_window_label() -> String {
    format!("{APP_WINDOW_PREFIX}{}", uuid::Uuid::new_v4())
}

pub fn is_app_window(label: &str) -> bool {
    label.starts_with(APP_WINDOW_PREFIX) && label.len() > APP_WINDOW_PREFIX.len()
}

pub fn app_webview_data_directory(window_label: &str) -> Option<PathBuf> {
    is_app_window(window_label).then(|| webview_profile_directory(window_label))
}

pub fn open_local_app_window(app: &tauri::AppHandle) -> Result<String, AppError> {
    let label = new_app_window_label();
    if !is_app_window(&label) {
        return Err(AppError::Internal(
            "local app window labels must use the app- prefix".to_string(),
        ));
    }
    let mut builder = crate::window_chrome::apply_app_window_chrome(
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("/".into()))
            .title("VibeX")
            .inner_size(1400.0, 900.0)
            .min_inner_size(800.0, 600.0)
            .resizable(true)
            .center(),
    );
    if let Some(data_directory) = app_webview_data_directory(&label) {
        builder = builder.data_directory(data_directory);
    }

    let builder = builder
        .icon(crate::load_app_icon().map_err(AppError::Internal)?)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let window = builder
        .build()
        .map_err(|error| AppError::Internal(error.to_string()))?;
    crate::window_chrome::apply_created_window_chrome(&window);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    Ok(label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_windows::{is_host_window, settings_window_label_for_caller};

    #[test]
    fn extra_app_windows_are_local_and_not_host_bound() {
        let label = "app-550e8400-e29b-41d4-a716-446655440000";
        assert!(is_app_window(label));
        assert!(!is_app_window("app-"));
        assert!(!is_app_window("main"));
        assert!(!is_app_window("host-abc"));
        assert!(!is_host_window(label));
        assert_eq!(settings_window_label_for_caller(label), "settings");
    }

    #[test]
    fn new_app_window_labels_are_unique() {
        let first = new_app_window_label();
        let second = new_app_window_label();
        assert!(is_app_window(&first));
        assert!(is_app_window(&second));
        assert_ne!(first, second);
    }

    #[test]
    fn extra_app_windows_use_isolated_webview_profiles() {
        let label = "app-550e8400-e29b-41d4-a716-446655440000";
        let path = app_webview_data_directory(label).expect("app window profile");
        assert_eq!(path.file_name().and_then(|name| name.to_str()), Some(label));
        assert!(
            path.components()
                .any(|component| component.as_os_str() == "webview-profiles")
        );
        assert!(app_webview_data_directory("main").is_none());
        assert!(app_webview_data_directory("settings").is_none());
        assert!(app_webview_data_directory("host-abc").is_none());
        assert!(app_webview_data_directory("app-").is_none());
    }
}
