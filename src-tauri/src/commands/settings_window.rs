use tauri::Manager;

fn resolve_settings_window_title(title: Option<String>) -> String {
    let trimmed = title.unwrap_or_default();
    let trimmed = trimmed.trim();
    if trimmed.is_empty() {
        "Settings".to_string()
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
pub async fn open_settings_window(
    app: tauri::AppHandle,
    title: Option<String>,
) -> Result<(), String> {
    let title = resolve_settings_window_title(title);
    if let Some(window) = app.get_webview_window("settings") {
        crate::apply_app_icon(&window)?;
        window.set_title(&title).map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("/settings".into()),
    )
    .title(title)
    .inner_size(1100.0, 800.0)
    .min_inner_size(800.0, 600.0)
    .resizable(true)
    .center();

    let builder = builder
        .icon(crate::load_app_icon().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    builder.build().map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::resolve_settings_window_title;

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
}
