use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, window::Color};

const DESKTOP_TOAST_WINDOW_LABEL: &str = "desktop-toast";
const DESKTOP_TOAST_EVENT: &str = "desktop-toast";
const DESKTOP_TOAST_ACTIVATED_EVENT: &str = "desktop-toast-activated";
const DESKTOP_TOAST_WIDTH: i32 = 456;
const DESKTOP_TOAST_HEIGHT: i32 = 520;
const DESKTOP_TOAST_MARGIN: i32 = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopToastPayload {
    pub project_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub title: String,
    pub description: String,
    pub kind: String,
    pub duration_ms: Option<u64>,
}

#[tauri::command]
pub async fn desktop_toast_window_ready(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Vec<DesktopToastPayload>, String> {
    let mut runtime = state.desktop_toast_state.lock().await;
    runtime.ready = true;
    Ok(std::mem::take(&mut runtime.pending))
}

fn configure_desktop_toast_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .set_background_color(Some(Color(0, 0, 0, 0)))
        .map_err(|error| error.to_string())?;
    window
        .set_shadow(false)
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn ensure_desktop_toast_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(DESKTOP_TOAST_WINDOW_LABEL) {
        crate::apply_app_icon(&window)?;
        configure_desktop_toast_window(&window)?;
        return Ok(window);
    }

    let builder = tauri::WebviewWindowBuilder::new(
        app,
        DESKTOP_TOAST_WINDOW_LABEL,
        WebviewUrl::App("/desktop-toast".into()),
    )
    .title("Desktop Toasts")
    .inner_size(DESKTOP_TOAST_WIDTH as f64, DESKTOP_TOAST_HEIGHT as f64)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .background_color(Color(0, 0, 0, 0))
    .shadow(false)
    .focused(false)
    .visible(false);

    let builder = builder
        .icon(crate::load_app_icon()?)
        .map_err(|error| error.to_string())?;

    let window = builder.build().map_err(|error| error.to_string())?;

    configure_desktop_toast_window(&window)?;
    Ok(window)
}

fn position_desktop_toast_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let monitor = main_window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| main_window.primary_monitor().ok().flatten())
        .ok_or_else(|| "No monitor available for desktop toast".to_string())?;

    let work_area = monitor.work_area();
    let (x, y) = toast_window_physical_position(
        (work_area.position.x, work_area.position.y),
        (work_area.size.width, work_area.size.height),
        monitor.scale_factor(),
    );

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

fn toast_window_physical_position(
    work_area_position: (i32, i32),
    work_area_size: (u32, u32),
    scale_factor: f64,
) -> (i32, i32) {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let width = (f64::from(DESKTOP_TOAST_WIDTH) * scale).round() as i32;
    let height = (f64::from(DESKTOP_TOAST_HEIGHT) * scale).round() as i32;
    let margin = (f64::from(DESKTOP_TOAST_MARGIN) * scale).round() as i32;
    (
        work_area_position.0 + work_area_size.0 as i32 - width - margin,
        work_area_position.1 + work_area_size.1 as i32 - height - margin,
    )
}

#[tauri::command]
pub async fn show_desktop_toast(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    payload: DesktopToastPayload,
) -> Result<(), String> {
    let window = ensure_desktop_toast_window(&app)?;
    position_desktop_toast_window(&app, &window)?;

    let mut runtime = state.desktop_toast_state.lock().await;
    if runtime.ready {
        window
            .emit(DESKTOP_TOAST_EVENT, payload)
            .map_err(|error| error.to_string())?;
    } else {
        runtime.pending.push(payload);
    }
    window.show().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn is_main_window_focused(app: tauri::AppHandle) -> Result<bool, String> {
    for (label, window) in app.webview_windows() {
        if label == DESKTOP_TOAST_WINDOW_LABEL {
            continue;
        }
        if window.is_focused().map_err(|error| error.to_string())? {
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
pub async fn activate_desktop_toast(
    app: tauri::AppHandle,
    payload: DesktopToastPayload,
) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    main_window.show().map_err(|error| error.to_string())?;
    main_window.set_focus().map_err(|error| error.to_string())?;
    main_window
        .emit(DESKTOP_TOAST_ACTIVATED_EVENT, payload)
        .map_err(|error| error.to_string())?;

    if let Some(toast_window) = app.get_webview_window(DESKTOP_TOAST_WINDOW_LABEL) {
        let _ = toast_window.hide();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::toast_window_physical_position;

    #[test]
    fn positions_the_window_in_physical_pixels_on_retina() {
        assert_eq!(
            toast_window_physical_position((0, 0), (3024, 1964), 2.0),
            (2080, 892)
        );
    }

    #[test]
    fn positions_the_window_on_unscaled_displays() {
        assert_eq!(
            toast_window_physical_position((0, 0), (1920, 1080), 1.0),
            (1448, 544)
        );
    }
}
