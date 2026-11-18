//! Shared product-window chrome: overlay titlebar on macOS, frameless on Windows.
//!
//! Tauri's `trafficLightPosition.y` only grows the native titlebar container.
//! It does not move the close/miniaturize/zoom buttons, so overlay lights stay
//! glued to the top of a 36px toolbar. macOS alignment is applied directly.
//!
//! The native window and WebView background are painted from the saved theme
//! before the first show. On Windows, an unset theme follows the app color
//! scheme, so a Light appearance still flashes the dark WebView2 surface.

#[cfg(target_os = "macos")]
const MACOS_TOOLBAR_HEIGHT: f64 = 36.0;
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_X: f64 = 16.0;

const LIGHT_CANVAS: tauri::window::Color = tauri::window::Color(255, 255, 255, 255);
const DARK_CANVAS: tauri::window::Color = tauri::window::Color(27, 27, 27, 255);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SavedAppearance {
    Light,
    Dark,
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BootCanvas {
    appearance: SavedAppearance,
    system_is_dark: bool,
}

impl BootCanvas {
    fn resolved_is_dark(self) -> bool {
        match self.appearance {
            SavedAppearance::Light => false,
            SavedAppearance::Dark => true,
            SavedAppearance::System => self.system_is_dark,
        }
    }

    pub(crate) fn color(self) -> tauri::window::Color {
        if self.resolved_is_dark() {
            DARK_CANVAS
        } else {
            LIGHT_CANVAS
        }
    }

    /// `None` keeps the window following the OS. Light and Dark are pinned so a
    /// Light theme does not inherit a dark system WebView background.
    pub(crate) fn forced_theme(self) -> Option<tauri::Theme> {
        match self.appearance {
            SavedAppearance::Light => Some(tauri::Theme::Light),
            SavedAppearance::Dark => Some(tauri::Theme::Dark),
            SavedAppearance::System => None,
        }
    }
}

pub(crate) fn boot_canvas_from_settings(raw: &str, system_is_dark: bool) -> BootCanvas {
    let appearance = serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| saved_appearance_from_value(&value))
        .unwrap_or(SavedAppearance::System);
    BootCanvas {
        appearance,
        system_is_dark,
    }
}

fn saved_appearance_from_value(value: &serde_json::Value) -> Option<SavedAppearance> {
    let theme = if let Some(section) = value.get("application") {
        section.get("theme")
    } else {
        value.get("theme")
    }?;
    match theme.as_str()?.trim().to_ascii_uppercase().as_str() {
        "LIGHT" => Some(SavedAppearance::Light),
        "DARK" => Some(SavedAppearance::Dark),
        "SYSTEM" => Some(SavedAppearance::System),
        _ => None,
    }
}

pub(crate) fn saved_boot_canvas() -> BootCanvas {
    let system_is_dark = system_prefers_dark();
    let raw = std::fs::read_to_string(utils::assets::settings_path()).unwrap_or_default();
    boot_canvas_from_settings(&raw, system_is_dark)
}

pub(crate) fn apply_boot_canvas_to_configs(
    windows: &mut [tauri::utils::config::WindowConfig],
    canvas: BootCanvas,
) {
    for window in windows {
        if window.label == "desktop-toast" {
            continue;
        }
        window.background_color = Some(canvas.color());
        window.theme = canvas.forced_theme();
    }
}

fn apply_boot_canvas_to_builder<'a, R, M>(
    mut builder: tauri::WebviewWindowBuilder<'a, R, M>,
    canvas: BootCanvas,
) -> tauri::WebviewWindowBuilder<'a, R, M>
where
    R: tauri::Runtime,
    M: tauri::Manager<R>,
{
    builder = builder.background_color(canvas.color());
    if let Some(theme) = canvas.forced_theme() {
        builder = builder.theme(Some(theme));
    }
    builder
}

pub fn apply_app_window_chrome<'a, R, M>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M>
where
    R: tauri::Runtime,
    M: tauri::Manager<R>,
{
    let builder = apply_boot_canvas_to_builder(builder, saved_boot_canvas());
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

pub(crate) fn apply_saved_window_canvas(window: &tauri::WebviewWindow) {
    if window.label() == "desktop-toast" {
        return;
    }
    let canvas = saved_boot_canvas();
    if let Err(error) = window.set_background_color(Some(canvas.color())) {
        tracing::warn!("Failed to set window canvas color: {error}");
    }
    if let Err(error) = window.set_theme(canvas.forced_theme()) {
        tracing::warn!("Failed to set window theme: {error}");
    }
    #[cfg(windows)]
    set_windows_webview_color_scheme(window, canvas.forced_theme());
}

pub fn apply_created_window_chrome(window: &tauri::WebviewWindow) {
    apply_saved_window_canvas(window);
    #[cfg(windows)]
    if let Err(error) = window.set_decorations(false) {
        tracing::warn!("Failed to hide native window decorations: {error}");
    }
    #[cfg(target_os = "macos")]
    {
        align_macos_traffic_lights(window.ns_window().ok());
        schedule_macos_traffic_light_realign(window);
    }
}

#[cfg(windows)]
fn set_windows_webview_color_scheme(window: &tauri::WebviewWindow, theme: Option<tauri::Theme>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO, COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK,
        COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT, ICoreWebView2_13,
    };
    use windows::core::Interface;

    let scheme = match theme {
        Some(tauri::Theme::Dark) => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK,
        Some(tauri::Theme::Light) => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT,
        Some(_) | None => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO,
    };
    if let Err(error) = window.with_webview(move |platform| {
        let Ok(core) = (unsafe { platform.controller().CoreWebView2() }) else {
            return;
        };
        let Ok(core) = core.cast::<ICoreWebView2_13>() else {
            return;
        };
        let Ok(profile) = (unsafe { core.Profile() }) else {
            return;
        };
        unsafe {
            let _ = profile.SetPreferredColorScheme(scheme);
        }
    }) {
        tracing::warn!("Failed to set WebView preferred color scheme: {error}");
    }
}

fn system_prefers_dark() -> bool {
    static CACHED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHED.get_or_init(detect_system_prefers_dark)
}

#[cfg(windows)]
fn detect_system_prefers_dark() -> bool {
    use windows::{
        Win32::{
            Foundation::ERROR_SUCCESS,
            System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW},
        },
        core::w,
    };

    let mut data: u32 = 1;
    let mut data_size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut _),
            Some(&mut data_size),
        )
    };
    status == ERROR_SUCCESS && data == 0
}

#[cfg(target_os = "macos")]
fn detect_system_prefers_dark() -> bool {
    std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("dark"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn detect_system_prefers_dark() -> bool {
    std::env::var("GTK_THEME")
        .map(|theme| theme.to_ascii_lowercase().contains("dark"))
        .unwrap_or(false)
}

pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == "desktop-toast" {
        return;
    }
    match event {
        tauri::WindowEvent::Focused(focused) => {
            crate::memory_target::on_main_window_focus(window, *focused);
            #[cfg(target_os = "macos")]
            align_macos_traffic_lights(window.ns_window().ok());
        }
        tauri::WindowEvent::Resized(_)
        | tauri::WindowEvent::ScaleFactorChanged { .. }
        | tauri::WindowEvent::ThemeChanged(_) => {
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
    use super::boot_canvas_from_settings;

    #[test]
    fn product_windows_use_shared_chrome() {
        let conf = include_str!("../tauri.conf.json");
        assert!(conf.contains("\"titleBarStyle\": \"Overlay\""));
        assert!(conf.contains("\"hiddenTitle\": true"));
        assert!(
            conf.contains("\"visible\": false"),
            "main window must stay hidden until chrome is applied and the UI paints"
        );
        assert!(
            !conf.contains("trafficLightPosition"),
            "Tauri trafficLightPosition.y does not move the buttons"
        );

        let chrome = include_str!("window_chrome.rs");
        assert!(chrome.contains("MACOS_TOOLBAR_HEIGHT: f64 = 36.0"));
        assert!(chrome.contains("rect.origin.y"));
        assert!(
            chrome.contains("background_color"),
            "product windows must paint the saved theme behind the first frame"
        );
        assert!(chrome.contains("apply_saved_window_canvas"));

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

        let settings = include_str!("commands/settings_window.rs");
        assert!(
            settings.contains(".visible(false)"),
            "settings window must stay hidden until the settings surface paints"
        );
        assert!(
            settings.contains("schedule_settings_window_reveal_fallback"),
            "a hidden settings window needs a native reveal fallback"
        );
        assert!(
            settings.contains("apply_saved_window_canvas"),
            "an existing settings window must match the saved theme before it is shown"
        );

        let lib = include_str!("lib.rs");
        assert!(
            lib.contains("apply_boot_canvas_to_configs"),
            "the config-created main window must be born with the saved canvas"
        );
    }

    #[test]
    fn saved_theme_picks_the_canvas_before_the_first_frame() {
        let light = boot_canvas_from_settings(r#"{"application":{"theme":"LIGHT"}}"#, true);
        assert_eq!(light.color(), tauri::window::Color(255, 255, 255, 255));
        assert_eq!(light.forced_theme(), Some(tauri::Theme::Light));

        let dark = boot_canvas_from_settings(r#"{"application":{"theme":"dark"}}"#, false);
        assert_eq!(dark.color(), tauri::window::Color(27, 27, 27, 255));
        assert_eq!(dark.forced_theme(), Some(tauri::Theme::Dark));

        let system_dark = boot_canvas_from_settings(r#"{"application":{"theme":"SYSTEM"}}"#, true);
        assert_eq!(system_dark.color(), tauri::window::Color(27, 27, 27, 255));
        assert_eq!(system_dark.forced_theme(), None);

        let system_light = boot_canvas_from_settings(r#"{"theme":"SYSTEM"}"#, false);
        assert_eq!(
            system_light.color(),
            tauri::window::Color(255, 255, 255, 255)
        );
        assert_eq!(system_light.forced_theme(), None);

        let legacy = boot_canvas_from_settings(r#"{"theme":"LIGHT"}"#, true);
        assert_eq!(legacy.forced_theme(), Some(tauri::Theme::Light));

        let section_without_theme =
            boot_canvas_from_settings(r#"{"application":{},"theme":"DARK"}"#, false);
        assert_eq!(section_without_theme.forced_theme(), None);

        let missing = boot_canvas_from_settings("not json", true);
        assert_eq!(missing.color(), tauri::window::Color(27, 27, 27, 255));
        assert_eq!(missing.forced_theme(), None);
    }
}
