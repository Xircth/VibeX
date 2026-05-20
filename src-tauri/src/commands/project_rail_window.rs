use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, window::Color};

const PROJECT_RAIL_WINDOW_LABEL: &str = "project-rail";
const PROJECT_RAIL_ACTIVATED_EVENT: &str = "project-rail-activated";
const PROJECT_RAIL_PROJECT_DIALOG_REQUEST_EVENT: &str = "project-rail-project-dialog-requested";
const PROJECT_RAIL_VISIBILITY_EVENT: &str = "project-rail-visibility";
const PROJECT_RAIL_WIDTH: i32 = 82;
const PROJECT_RAIL_MIN_VISIBLE_ITEMS: usize = 4;
const PROJECT_RAIL_MIN_HEIGHT: i32 = 362;
const PROJECT_RAIL_BASE_HEIGHT: i32 = 170;
const PROJECT_RAIL_ITEM_HEIGHT: i32 = 48;
const PROJECT_RAIL_HEIGHT_SCALE_NUMERATOR: i32 = 3;
const PROJECT_RAIL_HEIGHT_SCALE_DENOMINATOR: i32 = 2;
const PROJECT_RAIL_GAP: i32 = 12;
const PROJECT_RAIL_MARGIN: i32 = 12;
const PROJECT_RAIL_NATIVE_CORNER_DIAMETER: i32 = 36;

#[cfg(windows)]
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
#[cfg(windows)]
const DWMWA_BORDER_COLOR: u32 = 34;
#[cfg(windows)]
const DWMWCP_ROUND: u32 = 2;
#[cfg(windows)]
const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;

#[cfg(windows)]
unsafe extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: *mut std::ffi::c_void,
        dw_attribute: u32,
        pv_attribute: *const std::ffi::c_void,
        cb_attribute: u32,
    ) -> i32;

    fn CreateRoundRectRgn(
        n_left_rect: i32,
        n_top_rect: i32,
        n_right_rect: i32,
        n_bottom_rect: i32,
        n_width_ellipse: i32,
        n_height_ellipse: i32,
    ) -> *mut std::ffi::c_void;

    fn SetWindowRgn(
        hwnd: *mut std::ffi::c_void,
        h_rgn: *mut std::ffi::c_void,
        b_redraw: i32,
    ) -> i32;
}

#[derive(Debug, Clone, Copy)]
struct ProjectRailContext {
    work_x: i32,
    work_y: i32,
    work_width: i32,
    work_height: i32,
    main_position: PhysicalPosition<i32>,
    main_size: PhysicalSize<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRailTargetPayload {
    pub project_id: String,
    pub route: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRailProjectDialogRequest {
    pub mode: String,
}

pub fn ensure_project_rail_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(PROJECT_RAIL_WINDOW_LABEL) {
        crate::apply_app_icon(&window)?;
        configure_project_rail_window_appearance(&window)?;
        return Ok(window);
    }

    let builder = tauri::WebviewWindowBuilder::new(
        app,
        PROJECT_RAIL_WINDOW_LABEL,
        WebviewUrl::App("/project-rail".into()),
    )
    .title("Projects - VibeX")
    .inner_size(PROJECT_RAIL_WIDTH as f64, PROJECT_RAIL_MIN_HEIGHT as f64)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .background_color(Color(0, 0, 0, 0))
    .shadow(false)
    .visible(false);

    let builder = builder
        .icon(crate::load_app_icon().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;

    let window = builder.build().map_err(|error| error.to_string())?;

    configure_project_rail_window_appearance(&window)?;
    Ok(window)
}

fn configure_project_rail_window_appearance(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .set_background_color(Some(Color(0, 0, 0, 0)))
        .map_err(|error| error.to_string())?;
    window
        .set_shadow(false)
        .map_err(|error| error.to_string())?;
    configure_project_rail_window_corners(window)?;
    if let Ok(size) = window.inner_size() {
        apply_project_rail_native_shape(window, size.width as i32, size.height as i32)?;
    }
    Ok(())
}

#[cfg(windows)]
fn configure_project_rail_window_corners(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let corner_preference = DWMWCP_ROUND;
    let border_color = DWMWA_COLOR_NONE;

    let corner_result = unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner_preference as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&corner_preference) as u32,
        )
    };

    if corner_result < 0 {
        return Err(format!(
            "Failed to set project rail corner preference: 0x{corner_result:08X}"
        ));
    }

    let border_result = unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_BORDER_COLOR,
            &border_color as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&border_color) as u32,
        )
    };

    if border_result < 0 {
        return Err(format!(
            "Failed to clear project rail border color: 0x{border_result:08X}"
        ));
    }

    Ok(())
}

#[cfg(not(windows))]
fn configure_project_rail_window_corners(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn apply_project_rail_native_shape(
    window: &tauri::WebviewWindow,
    width: i32,
    height: i32,
) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let region = unsafe {
        CreateRoundRectRgn(
            0,
            0,
            width + 1,
            height + 1,
            PROJECT_RAIL_NATIVE_CORNER_DIAMETER,
            PROJECT_RAIL_NATIVE_CORNER_DIAMETER,
        )
    };

    if region.is_null() {
        return Err("Failed to create rounded project rail region".to_string());
    }

    let result = unsafe { SetWindowRgn(hwnd.0, region, 1) };
    if result == 0 {
        return Err("Failed to apply rounded project rail region".to_string());
    }

    Ok(())
}

#[cfg(not(windows))]
fn apply_project_rail_native_shape(
    _window: &tauri::WebviewWindow,
    _width: i32,
    _height: i32,
) -> Result<(), String> {
    Ok(())
}

fn read_project_rail_context(app: &tauri::AppHandle) -> Result<ProjectRailContext, String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let monitor = main_window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| main_window.primary_monitor().ok().flatten())
        .ok_or_else(|| "No monitor available for project rail".to_string())?;

    let work_area = monitor.work_area();
    let main_position = main_window
        .outer_position()
        .map_err(|error| error.to_string())?;
    let main_size = main_window
        .outer_size()
        .map_err(|error| error.to_string())?;

    Ok(ProjectRailContext {
        work_x: work_area.position.x,
        work_y: work_area.position.y,
        work_width: work_area.size.width as i32,
        work_height: work_area.size.height as i32,
        main_position,
        main_size,
    })
}

fn clamp_project_rail_height(window_height: i32, context: ProjectRailContext) -> i32 {
    let max_monitor_height =
        (context.work_height - PROJECT_RAIL_MARGIN * 2).max(PROJECT_RAIL_MIN_HEIGHT);

    window_height
        .max(PROJECT_RAIL_MIN_HEIGHT)
        .min(max_monitor_height)
}

fn compute_project_rail_height(item_count: usize, context: ProjectRailContext) -> i32 {
    let visible_item_count = item_count.max(PROJECT_RAIL_MIN_VISIBLE_ITEMS);
    let base_height =
        PROJECT_RAIL_BASE_HEIGHT + PROJECT_RAIL_ITEM_HEIGHT * visible_item_count as i32;
    let desired_height =
        (base_height * PROJECT_RAIL_HEIGHT_SCALE_NUMERATOR) / PROJECT_RAIL_HEIGHT_SCALE_DENOMINATOR;
    clamp_project_rail_height(desired_height, context)
}

fn apply_project_rail_bounds(
    window: &tauri::WebviewWindow,
    context: ProjectRailContext,
    window_height: i32,
) -> Result<(), String> {
    let window_height = clamp_project_rail_height(window_height, context);
    let (x, y) = compute_project_rail_position(context, window_height);

    window
        .set_size(PhysicalSize::new(
            PROJECT_RAIL_WIDTH as u32,
            window_height as u32,
        ))
        .map_err(|error| error.to_string())?;
    apply_project_rail_native_shape(window, PROJECT_RAIL_WIDTH, window_height)?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn compute_project_rail_position(context: ProjectRailContext, window_height: i32) -> (i32, i32) {
    let min_x = context.work_x + PROJECT_RAIL_MARGIN;
    let max_x = context.work_x + context.work_width - PROJECT_RAIL_WIDTH - PROJECT_RAIL_MARGIN;
    let min_y = context.work_y + PROJECT_RAIL_MARGIN;
    let max_y = context.work_y + context.work_height - window_height - PROJECT_RAIL_MARGIN;

    let x = (context.main_position.x - PROJECT_RAIL_WIDTH - PROJECT_RAIL_GAP).clamp(min_x, max_x);
    let centered_y =
        context.main_position.y + (context.main_size.height as i32 - window_height) / 2;
    let y = centered_y.clamp(min_y, max_y);

    (x, y)
}

fn sync_project_rail_window_position(
    window: &tauri::WebviewWindow,
    context: ProjectRailContext,
    window_height: i32,
) -> Result<(), String> {
    let window_height = clamp_project_rail_height(window_height, context);
    let (x, y) = compute_project_rail_position(context, window_height);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

fn position_project_rail_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    item_count: usize,
) -> Result<(), String> {
    let context = read_project_rail_context(app)?;
    let window_height = compute_project_rail_height(item_count, context);
    apply_project_rail_bounds(window, context, window_height)
}

pub fn sync_project_rail_window(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(PROJECT_RAIL_WINDOW_LABEL) else {
        return Ok(());
    };

    if window.is_visible().map_err(|error| error.to_string())? {
        let context = read_project_rail_context(app)?;
        let current_height = window
            .inner_size()
            .map_err(|error| error.to_string())?
            .height as i32;

        sync_project_rail_window_position(&window, context, current_height)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn sync_project_rail_window_bounds(
    app: tauri::AppHandle,
    item_count: Option<usize>,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(PROJECT_RAIL_WINDOW_LABEL) else {
        return Ok(());
    };

    if !window.is_visible().map_err(|error| error.to_string())? {
        return Ok(());
    }

    position_project_rail_window(&app, &window, item_count.unwrap_or_default())
}

#[tauri::command]
pub async fn set_project_rail_window_visible(
    app: tauri::AppHandle,
    visible: bool,
    item_count: Option<usize>,
) -> Result<(), String> {
    let window = ensure_project_rail_window(&app)?;
    let was_visible = window.is_visible().map_err(|error| error.to_string())?;

    if visible {
        position_project_rail_window(&app, &window, item_count.unwrap_or_default())?;
        if !was_visible {
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        }
    } else {
        window.hide().map_err(|error| error.to_string())?;
    }

    app.emit(PROJECT_RAIL_VISIBILITY_EVENT, visible)
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn activate_project_rail_target(
    app: tauri::AppHandle,
    payload: ProjectRailTargetPayload,
) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    main_window.show().map_err(|error| error.to_string())?;
    main_window.set_focus().map_err(|error| error.to_string())?;
    main_window
        .emit(PROJECT_RAIL_ACTIVATED_EVENT, payload)
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn request_project_rail_project_dialog(
    app: tauri::AppHandle,
    payload: ProjectRailProjectDialogRequest,
) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    main_window.show().map_err(|error| error.to_string())?;
    main_window.set_focus().map_err(|error| error.to_string())?;
    main_window
        .emit(PROJECT_RAIL_PROJECT_DIALOG_REQUEST_EVENT, payload)
        .map_err(|error| error.to_string())?;

    Ok(())
}
