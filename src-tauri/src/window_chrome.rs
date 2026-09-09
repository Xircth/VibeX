//! Shared product-window chrome: overlay titlebar on macOS, frameless on Windows.
//!
//! Tauri's `trafficLightPosition.y` only grows the native titlebar container.
//! It does not move the close/miniaturize/zoom buttons, so overlay lights stay
//! glued to the top of a 36px toolbar. macOS alignment is applied directly.

#[cfg(target_os = "macos")]
const MACOS_TOOLBAR_HEIGHT: f64 = 36.0;
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_X: f64 = 16.0;

pub fn apply_app_window_chrome<'a, R, M>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M>
where
    R: tauri::Runtime,
    M: tauri::Manager<R>,
{
    #[cfg(target_os = "macos")]
    {
        builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
    }
    #[cfg(windows)]
    {
        builder.decorations(false)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        builder
    }
}

pub fn apply_created_window_chrome(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Err(error) = window.set_decorations(false) {
        tracing::warn!("Failed to hide native window decorations: {error}");
    }
    #[cfg(target_os = "macos")]
    {
        align_macos_traffic_lights(window.ns_window().ok());
        schedule_macos_traffic_light_realign(window);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = window;
}

pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == "desktop-toast" {
        return;
    }
    match event {
        tauri::WindowEvent::Resized(_)
        | tauri::WindowEvent::ScaleFactorChanged { .. }
        | tauri::WindowEvent::ThemeChanged(_)
        | tauri::WindowEvent::Focused(_) => {
            #[cfg(target_os = "macos")]
            align_macos_traffic_lights(window.ns_window().ok());
        }
        _ => {}
    }
}

#[cfg(target_os = "macos")]
fn schedule_macos_traffic_light_realign(window: &tauri::WebviewWindow) {
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        for delay_ms in [16_u64, 80, 250] {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            let window = window.clone();
            let align_window = window.clone();
            let _ = window.run_on_main_thread(move || {
                align_macos_traffic_lights(align_window.ns_window().ok());
            });
        }
    });
}

#[cfg(target_os = "macos")]
fn align_macos_traffic_lights(ns_window: Option<*mut std::ffi::c_void>) {
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
    use objc2_foundation::MainThreadMarker;

    let Some(ptr) = ns_window.filter(|ptr| !ptr.is_null()) else {
        return;
    };
    if MainThreadMarker::new().is_none() {
        return;
    }

    unsafe {
        let window = &*ptr.cast::<NSWindow>();
        let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else {
            return;
        };
        let Some(miniaturize) = window.standardWindowButton(NSWindowButton::MiniaturizeButton)
        else {
            return;
        };
        let zoom = window.standardWindowButton(NSWindowButton::ZoomButton);
        let Some(button_bar) = close.superview() else {
            return;
        };
        let Some(title_bar_container) = button_bar.superview() else {
            return;
        };

        let close_rect = NSView::frame(&close);
        if close_rect.size.height <= 0.0 {
            return;
        }

        let mut title_bar_rect = NSView::frame(&title_bar_container);
        title_bar_rect.size.height = MACOS_TOOLBAR_HEIGHT;
        title_bar_rect.origin.y = window.frame().size.height - MACOS_TOOLBAR_HEIGHT;
        title_bar_container.setFrame(title_bar_rect);

        let space_between = NSView::frame(&miniaturize).origin.x - close_rect.origin.x;
        let mut buttons = vec![close, miniaturize];
        if let Some(zoom) = zoom {
            buttons.push(zoom);
        }
        for (index, button) in buttons.into_iter().enumerate() {
            let mut rect = NSView::frame(&button);
            rect.origin.x = MACOS_TRAFFIC_LIGHT_X + (index as f64 * space_between);
            rect.origin.y = ((MACOS_TOOLBAR_HEIGHT - rect.size.height) / 2.0).max(0.0);
            button.setFrameOrigin(rect.origin);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn product_windows_use_shared_chrome() {
        let conf = include_str!("../tauri.conf.json");
        assert!(conf.contains("\"titleBarStyle\": \"Overlay\""));
        assert!(conf.contains("\"hiddenTitle\": true"));
        assert!(
            !conf.contains("trafficLightPosition"),
            "Tauri trafficLightPosition.y does not move the buttons"
        );

        let chrome = include_str!("window_chrome.rs");
        assert!(chrome.contains("MACOS_TOOLBAR_HEIGHT: f64 = 36.0"));
        assert!(chrome.contains("rect.origin.y"));

        for source in [
            include_str!("app_windows.rs"),
            include_str!("commands/host_window.rs"),
            include_str!("commands/settings_window.rs"),
        ] {
            assert!(
                source.contains("apply_app_window_chrome"),
                "window builders must share overlay/frameless chrome"
            );
            assert!(
                source.contains("apply_created_window_chrome"),
                "created windows must realign macOS traffic lights"
            );
        }
    }
}
