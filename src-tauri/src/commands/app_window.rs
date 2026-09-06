#[tauri::command]
pub fn open_app_window(app: tauri::AppHandle) -> Result<String, crate::error::AppError> {
    crate::app_windows::open_local_app_window(&app)
}
