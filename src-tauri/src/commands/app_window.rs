use crate::error::AppError;

/// Open an extra local app window.
///
/// This must stay async and hop onto the UI thread *after* the invoking
/// webview's IPC handler returns. On Windows, creating a WebView2 with a
/// different user-data folder from inside `WebMessageReceived` deadlocks:
/// the new window stays blank, cannot close, and the caller window freezes.
#[tauri::command]
pub async fn open_app_window(app: tauri::AppHandle) -> Result<String, AppError> {
    // Yield so Tauri can finish the invoking webview's WebMessageReceived
    // before the UI thread constructs another WebView2 controller.
    tokio::task::yield_now().await;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app_for_window = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(crate::app_windows::open_local_app_window(&app_for_window));
    })
    .map_err(|error| AppError::Internal(error.to_string()))?;
    rx.await.map_err(|_| {
        AppError::Internal("app window task did not run on the UI thread".to_string())
    })?
}

#[cfg(test)]
mod tests {
    #[test]
    fn ipc_open_defers_webview_creation_off_the_caller_message_stack() {
        let source = include_str!("app_window.rs");
        let body = source.split("#[cfg(test)]").next().expect("command source");
        assert!(
            body.contains("async fn open_app_window"),
            "sync IPC create deadlocks WebView2 when the new window uses another profile"
        );
        assert!(
            body.contains("run_on_main_thread"),
            "window construction must run on the UI thread after the IPC handler returns"
        );
        assert!(
            body.contains("yield_now"),
            "must yield so WebMessageReceived can return before WebView2 creation"
        );
    }
}
