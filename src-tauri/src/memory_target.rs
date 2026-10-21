//! Main-window WebView2 memory target.
//!
//! Hide-to-tray already drops the target immediately. A visible window that
//! loses focus waits three minutes, and only then asks Chromium to compact.
//! Focus always restores NORMAL.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::Manager;

static FOCUS_GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn on_main_window_focus(window: &tauri::Window, focused: bool) {
    if window.label() != "main" {
        return;
    }
    let generation = FOCUS_GENERATION
        .fetch_add(1, Ordering::Relaxed)
        .wrapping_add(1);
    let app = window.app_handle().clone();
    if focused {
        set_main_memory_target(&app, false);
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3 * 60)).await;
        if FOCUS_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        let Some(main) = app.get_webview_window("main") else {
            return;
        };
        if main.is_focused().unwrap_or(true) {
            return;
        }
        set_main_memory_target(&app, true);
    });
}

fn set_main_memory_target(app: &tauri::AppHandle, low: bool) {
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, ICoreWebView2_19,
        };
        use windows::core::Interface;
        let Some(main) = app.get_webview_window("main") else {
            return;
        };
        let _ = main.with_webview(move |platform| {
            let controller = platform.controller();
            unsafe {
                if let Ok(core) = controller.CoreWebView2()
                    && let Ok(core19) = core.cast::<ICoreWebView2_19>()
                {
                    let level = if low {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                    } else {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                    };
                    let _ = core19.SetMemoryUsageTargetLevel(level);
                }
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (app, low);
    }
}
