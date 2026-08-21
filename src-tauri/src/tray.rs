//! System tray (P2-5): a menubar/tray icon with a Show / Hide / Quit menu, plus
//! an activity badge fed from the frontend. Uses Tauri v2's built-in tray-icon
//! API (no plugin). Closing the main window hides it through the same helpers
//! so Host stays in the background; Quit and `exit_app` are the only exits.
//! Menu clicks are dispatched from the app-wide `on_menu_event` in lib.rs so
//! all menu ids share one handler. Deep-links are intentionally out of scope
//! here (they need extra plugins + per-OS scheme registration).

use tauri::{AppHandle, Manager};

pub const TRAY_MENU_ID_SHOW: &str = "tray:show";
pub const TRAY_MENU_ID_HIDE: &str = "tray:hide";
pub const TRAY_MENU_ID_QUIT: &str = "tray:quit";
pub const TRAY_ICON_ID: &str = "vibex-tray";

/// Bring the main window to the foreground (unminimize + show + focus).
pub fn show_main_window(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

pub fn hide_main_window(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
}

/// Dispatch a tray menu click (called from lib.rs `on_menu_event`). Returns true
/// if the id was a tray id and handled.
pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    match id {
        TRAY_MENU_ID_SHOW => show_main_window(app),
        TRAY_MENU_ID_HIDE => hide_main_window(app),
        TRAY_MENU_ID_QUIT => app.exit(0),
        _ => return false,
    }
    true
}

/// Install the tray icon and its menu. Best-effort: on Linux the tray may be
/// invisible (no StatusNotifierWatcher) even on success, so nothing assumes it
/// exists.
pub fn install_tray_icon(app: &AppHandle) -> tauri::Result<()> {
    use tauri::{
        menu::{MenuBuilder, MenuItem, PredefinedMenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let show_item = MenuItem::with_id(app, TRAY_MENU_ID_SHOW, "显示 VibeX", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, TRAY_MENU_ID_HIDE, "隐藏窗口", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_ID_QUIT, "退出 VibeX", true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show_item, &hide_item, &separator, &quit_item])
        .build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ICON_ID)
        .tooltip("VibeX")
        .menu(&menu)
        // `false` is required so a left-click fires TrayIconEvent::Click instead
        // of the OS consuming it to pop the menu (notably macOS, tauri#11413).
        .show_menu_on_left_click(false);

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Update the tray/dock activity badge from the frontend's aggregated unread
/// count (P2-5). Best-effort and per-OS: macOS shows the count as menubar text
/// and a dock badge; Linux (Unity) shows a dock badge; Windows has no simple
/// count badge here (skipped).
#[tauri::command]
pub async fn update_tray_badge(app: AppHandle, count: u32) -> Result<(), crate::error::AppError> {
    #[cfg(target_os = "macos")]
    if let Some(tray) = app.tray_by_id(TRAY_ICON_ID) {
        let title = if count > 0 {
            Some(count.to_string())
        } else {
            None
        };
        let _ = tray.set_title(title.as_deref());
    }

    if let Some(main) = app.get_webview_window("main") {
        let badge = if count > 0 { Some(count as i64) } else { None };
        let _ = main.set_badge_count(badge);
    }
    Ok(())
}
