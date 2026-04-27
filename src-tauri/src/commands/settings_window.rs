use tauri::Manager;

#[tauri::command]
pub async fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        crate::apply_app_icon(&window)?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("/settings".into()),
    )
    .title("Settings - VibeX")
    .inner_size(1100.0, 800.0)
    .min_inner_size(800.0, 600.0)
    .resizable(true)
    .center()
    .decorations(false);

    let builder = builder
        .icon(crate::load_app_icon().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    builder.build().map_err(|e| e.to_string())?;

    Ok(())
}
