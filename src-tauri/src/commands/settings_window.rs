use tauri::Manager;

#[tauri::command]
pub async fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    // 如果 settings 窗口已存在，聚焦它
    if let Some(window) = app.get_webview_window("settings") {
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // 否则创建新窗口
    let _window = tauri::WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("/settings".into()),
    )
    .title("Settings - VibeUltra")
    .inner_size(1100.0, 800.0)
    .min_inner_size(800.0, 600.0)
    .resizable(true)
    .center()
    .decorations(false) // 自定义标题栏
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}
