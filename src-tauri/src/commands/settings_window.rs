use tauri::Manager;

use crate::{
    host_client::runtime,
    host_windows::{
        host_app_window_label, host_settings_window_title, host_webview_data_directory,
        settings_window_label_for_caller,
    },
};

fn resolve_settings_window_title(title: Option<String>) -> String {
    let trimmed = title.unwrap_or_default();
    let trimmed = trimmed.trim();
    if trimmed.is_empty() {
        "Settings".to_string()
    } else {
        trimmed.to_string()
    }
}

async fn resolve_window_title(caller: &str, base: String) -> String {
    let Some(host_label) = host_app_window_label(caller) else {
        return base;
    };
    let Some(profile_id) = runtime().profile_id_for_window(host_label).await else {
        return base;
    };
    let Ok(Some(profile)) = runtime().profile(&profile_id).await else {
        return base;
    };
    host_settings_window_title(&base, &profile.name)
}

fn settings_window_path(path: Option<&str>) -> String {
    let trimmed = path.unwrap_or("/settings").trim();
    if trimmed == "/settings" || trimmed.starts_with("/settings/") {
        trimmed.to_string()
    } else {
        "/settings".to_string()
    }
}

fn navigate_settings_window(window: &tauri::WebviewWindow, path: &str) {
    let Ok(encoded) = serde_json::to_string(path) else {
        return;
    };
    let _ = window.eval(format!(
        "if (location.pathname !== {encoded}) location.replace({encoded})"
    ));
}

fn open_or_focus(
    app: &tauri::AppHandle,
    label: &str,
    title: &str,
    path: Option<&str>,
) -> Result<(), String> {
    let path = settings_window_path(path);
    if let Some(window) = app.get_webview_window(label) {
        crate::apply_app_icon(&window)?;
        window.set_title(title).map_err(|e| e.to_string())?;
        navigate_settings_window(&window, &path);
        let _ = window.unminimize();
        let _ = window.show();
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let mut builder = crate::window_chrome::apply_app_window_chrome(
        tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(path.into()))
            .title(title)
            .inner_size(1100.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .resizable(true)
            .center(),
    );
    if let Some(data_directory) = host_webview_data_directory(label) {
        builder = builder.data_directory(data_directory);
    }

    let builder = builder
        .icon(crate::load_app_icon()?)
        .map_err(|e| e.to_string())?;

    let window = builder.build().map_err(|e| e.to_string())?;
    crate::window_chrome::apply_created_window_chrome(&window);
    Ok(())
}

pub fn open_local_settings_window(app: &tauri::AppHandle) -> Result<(), String> {
    open_or_focus(app, "settings", "设置", None)
}

#[tauri::command]
pub async fn open_settings_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    title: Option<String>,
    path: Option<String>,
) -> Result<(), String> {
    let caller = window.label().to_string();
    let target = settings_window_label_for_caller(&caller);
    let title = resolve_window_title(&caller, resolve_settings_window_title(title)).await;
    open_or_focus(&app, &target, &title, path.as_deref())
}

#[cfg(test)]
mod tests {
    use super::{resolve_settings_window_title, settings_window_path};

    #[test]
    fn uses_the_provided_localized_title() {
        assert_eq!(
            resolve_settings_window_title(Some("设置".to_string())),
            "设置"
        );
        assert_eq!(
            resolve_settings_window_title(Some("Settings".to_string())),
            "Settings"
        );
    }

    #[test]
    fn falls_back_to_english_when_title_is_missing() {
        assert_eq!(resolve_settings_window_title(None), "Settings");
        assert_eq!(
            resolve_settings_window_title(Some("   ".to_string())),
            "Settings"
        );
    }

    #[test]
    fn settings_paths_stay_inside_settings() {
        assert_eq!(settings_window_path(None), "/settings");
        assert_eq!(
            settings_window_path(Some("/settings/web-service")),
            "/settings/web-service"
        );
        assert_eq!(
            settings_window_path(Some(" /settings/system ")),
            "/settings/system"
        );
        assert_eq!(settings_window_path(Some("/local-projects")), "/settings");
        assert_eq!(
            settings_window_path(Some("https://example.com")),
            "/settings"
        );
    }
}
