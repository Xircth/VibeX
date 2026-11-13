//! Release inspector switch.
//!
//! The `tauri/devtools` feature stays off so Inspect Element is not compiled
//! into every release build. `settings.json` `system.developer_mode` is the
//! remembered switch, and this module applies it to the desktop WebViews.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tauri::{Manager, Webview};

use crate::error::AppError;

const SYSTEM_SECTION: &str = "system";
const HOTKEY_INSTALL: &str = r#"
(function () {
  if (window.__vibexDeveloperModeHotkey) return;
  window.__vibexDeveloperModeHotkey = true;
  var invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!invoke) return;
  document.addEventListener('keydown', function (event) {
    if (event.repeat) return;
    var mac = /Mac/.test(navigator.platform) || /Mac/.test(navigator.userAgent);
    var chord = mac
      ? event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey && event.code === 'KeyI'
      : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === 'KeyI';
    var f12 = event.code === 'F12' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (!chord && !f12) return;
    event.preventDefault();
    event.stopPropagation();
    if (!window.__vibexDeveloperMode) return;
    invoke('open_developer_tools').catch(function () {});
  }, true);
})();
"#;

const VK_F12: u32 = 0x7B;
const VK_I: u32 = 0x49;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InspectShortcut {
    Ignore,
    /// Eat the key so WebView2 cannot open DevTools after the switch is off.
    Swallow,
    Open,
}

/// Release WebView2 keeps its own F12 shortcut after `AreDevToolsEnabled` was
/// turned on. Closing developer mode must swallow that key, not only skip our
/// open call.
pub fn inspect_shortcut_action(
    enabled: bool,
    key: u32,
    ctrl: bool,
    shift: bool,
    alt: bool,
    meta: bool,
    key_down: bool,
    repeat: bool,
) -> InspectShortcut {
    if !key_down || repeat {
        return InspectShortcut::Ignore;
    }
    let f12 = key == VK_F12 && !ctrl && !shift && !alt && !meta;
    let inspect_chord = key == VK_I && ctrl && shift && !alt && !meta;
    if !f12 && !inspect_chord {
        return InspectShortcut::Ignore;
    }
    if enabled {
        InspectShortcut::Open
    } else {
        InspectShortcut::Swallow
    }
}

static ENABLED: AtomicBool = AtomicBool::new(false);

pub fn developer_mode_from_document(raw: &str) -> Option<bool> {
    let value: Value = serde_json::from_str(raw).ok()?;
    Some(
        value
            .get(SYSTEM_SECTION)
            .and_then(|section| section.get("developer_mode"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

pub fn read_enabled() -> bool {
    let Ok(raw) = std::fs::read_to_string(utils::assets::settings_path()) else {
        return false;
    };
    developer_mode_from_document(&raw).unwrap_or(false)
}

pub async fn write_enabled(enabled: bool) -> Result<(), AppError> {
    let mut updates = serde_json::Map::new();
    updates.insert("developer_mode".to_string(), Value::Bool(enabled));
    services::services::settings_store::merge_object_section(
        &utils::assets::settings_path(),
        SYSTEM_SECTION,
        updates,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(())
}

pub fn apply_saved(app: &tauri::AppHandle) {
    apply(app, read_enabled());
}

pub fn apply(app: &tauri::AppHandle, enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
    let script = state_script(enabled);
    for (label, window) in app.webview_windows() {
        if is_browser_window(&label) {
            continue;
        }
        let _ = window.eval(&script);
        configure_window(&window, enabled, false);
    }
}

pub fn handle_page_load(webview: &Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    if payload.event() != tauri::webview::PageLoadEvent::Finished
        || is_browser_window(webview.label())
    {
        return;
    }
    let enabled = ENABLED.load(Ordering::Relaxed);
    let _ = webview.eval(state_script(enabled));
    configure_webview(webview, enabled, false);
}

pub fn open_window(window: &tauri::WebviewWindow) -> Result<(), AppError> {
    if !ENABLED.load(Ordering::Relaxed) && !read_enabled() {
        return Err(AppError::BadRequest("Developer mode is off".to_string()));
    }
    ENABLED.store(true, Ordering::Relaxed);
    configure_window(window, true, true);
    Ok(())
}

fn is_browser_window(label: &str) -> bool {
    label.starts_with("browser-")
}

fn state_script(enabled: bool) -> String {
    format!("window.__vibexDeveloperMode={enabled};{HOTKEY_INSTALL}")
}

fn configure_window(window: &tauri::WebviewWindow, enabled: bool, open: bool) {
    let _ = window.with_webview(move |platform| configure_platform(&platform, enabled, open));
}

fn configure_webview(webview: &Webview, enabled: bool, open: bool) {
    let _ = webview.with_webview(move |platform| configure_platform(&platform, enabled, open));
}

fn configure_platform(platform: &tauri::webview::PlatformWebview, enabled: bool, open: bool) {
    #[cfg(windows)]
    configure_windows(platform, enabled, open);
    #[cfg(target_os = "macos")]
    configure_macos(platform, enabled, open);
    #[cfg(target_os = "linux")]
    configure_linux(platform, enabled, open);
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (platform, enabled, open);
    }
}

#[cfg(windows)]
fn configure_windows(platform: &tauri::webview::PlatformWebview, enabled: bool, open: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    let controller = platform.controller();
    let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
        return;
    };
    if let Ok(settings) = unsafe { core.Settings() } {
        let _ = unsafe { settings.SetAreDevToolsEnabled(enabled) };
        if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = unsafe { settings3.SetAreBrowserAcceleratorKeysEnabled(true) };
        }
    }
    install_windows_shortcut_hook(&controller, &core);
    if open && enabled {
        let _ = unsafe { core.OpenDevToolsWindow() };
    }
}

#[cfg(windows)]
fn install_windows_shortcut_hook(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) {
    use std::{
        collections::HashSet,
        sync::{Mutex, OnceLock},
    };

    use webview2_com::{
        AcceleratorKeyPressedEventHandler,
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
        },
    };

    static HOOKS: OnceLock<Mutex<HashSet<isize>>> = OnceLock::new();
    let hooks = HOOKS.get_or_init(|| Mutex::new(HashSet::new()));
    let key = windows::core::Interface::as_raw(controller) as isize;
    if !hooks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key)
    {
        return;
    }

    let core = core.clone();
    let mut token = 0i64;
    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
        unsafe { args.KeyEventKind(&mut kind)? };
        if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
            && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
        {
            return Ok(());
        }
        let mut virtual_key = 0u32;
        unsafe { args.VirtualKey(&mut virtual_key)? };
        let mut status = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
        unsafe { args.PhysicalKeyStatus(&mut status)? };
        match inspect_shortcut_action(
            ENABLED.load(Ordering::Relaxed),
            virtual_key,
            key_is_down(0x11) || key_is_down(0xA2) || key_is_down(0xA3),
            key_is_down(0x10) || key_is_down(0xA0) || key_is_down(0xA1),
            key_is_down(0x12) || key_is_down(0xA4) || key_is_down(0xA5),
            key_is_down(0x5B) || key_is_down(0x5C),
            true,
            status.WasKeyDown.as_bool(),
        ) {
            InspectShortcut::Ignore => return Ok(()),
            InspectShortcut::Swallow => {
                if let Ok(settings) = unsafe { core.Settings() } {
                    let _ = unsafe { settings.SetAreDevToolsEnabled(false) };
                }
            }
            InspectShortcut::Open => {
                if let Ok(settings) = unsafe { core.Settings() } {
                    let _ = unsafe { settings.SetAreDevToolsEnabled(true) };
                }
                let _ = unsafe { core.OpenDevToolsWindow() };
            }
        }
        let _ = unsafe { args.SetHandled(true) };
        Ok(())
    }));
    if unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) }.is_err() {
        hooks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&key);
    }
}

#[cfg(windows)]
fn key_is_down(virtual_key: i32) -> bool {
    unsafe extern "system" {
        fn GetAsyncKeyState(virtual_key: i32) -> i16;
    }
    unsafe { GetAsyncKeyState(virtual_key) as u16 & 0x8000 != 0 }
}

#[cfg(target_os = "macos")]
fn configure_macos(platform: &tauri::webview::PlatformWebview, enabled: bool, open: bool) {
    let pointer = platform.inner();
    if pointer.is_null() {
        return;
    }
    use objc2::runtime::NSObjectProtocol;
    unsafe {
        let view = &*pointer.cast::<objc2_web_kit::WKWebView>();
        if view.respondsToSelector(objc2::sel!(setInspectable:)) {
            view.setInspectable(enabled);
        }
        if !open && enabled {
            return;
        }
        let inspector: *mut objc2::runtime::AnyObject = objc2::msg_send![view, _inspector];
        if inspector.is_null() {
            return;
        }
        if open && enabled {
            prefer_detached_inspector();
            let _: () = objc2::msg_send![inspector, show];
        } else if !enabled {
            let _: () = objc2::msg_send![inspector, close];
        }
    }
}

#[cfg(target_os = "macos")]
fn prefer_detached_inspector() {
    use std::sync::Once;

    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        use objc2::{class, msg_send, runtime::AnyObject};
        use objc2_foundation::ns_string;
        unsafe {
            let no: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: false];
            let key = ns_string!("__WebInspectorPageGroupLevel1__.WebKit2InspectorStartsAttached");
            let registration: *mut AnyObject = msg_send![
                class!(NSDictionary),
                dictionaryWithObject: no,
                forKey: key
            ];
            let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
            let _: () = msg_send![defaults, registerDefaults: registration];
        }
    });
}

#[cfg(target_os = "linux")]
fn configure_linux(platform: &tauri::webview::PlatformWebview, enabled: bool, open: bool) {
    use webkit2gtk::{SettingsExt, WebInspectorExt, WebViewExt};

    let view = platform.inner();
    if let Some(settings) = view.settings() {
        settings.set_enable_developer_extras(enabled);
    }
    let Some(inspector) = view.inspector() else {
        return;
    };
    if open && enabled {
        inspector.show();
    } else if !enabled {
        inspector.close();
    }
}

#[tauri::command]
pub fn get_developer_mode() -> bool {
    let enabled = read_enabled();
    ENABLED.store(enabled, Ordering::Relaxed);
    enabled
}

#[tauri::command]
pub async fn set_developer_mode(app: tauri::AppHandle, enabled: bool) -> Result<bool, AppError> {
    write_enabled(enabled).await?;
    apply(&app, enabled);
    Ok(enabled)
}

#[tauri::command]
pub fn open_developer_tools(window: tauri::WebviewWindow) -> Result<(), AppError> {
    open_window(&window)
}

#[cfg(test)]
mod tests {
    use super::developer_mode_from_document;

    #[test]
    fn missing_developer_mode_stays_off() {
        assert_eq!(
            developer_mode_from_document(r#"{"system":{"proxy":{"mode":"auto"}}}"#),
            Some(false)
        );
        assert_eq!(developer_mode_from_document("{}"), Some(false));
        assert_eq!(developer_mode_from_document("not-json"), None);
    }

    #[test]
    fn developer_mode_reads_the_system_section() {
        assert_eq!(
            developer_mode_from_document(
                r#"{"application":{"theme":"system"},"system":{"developer_mode":true}}"#
            ),
            Some(true)
        );
    }

    #[test]
    fn windows_f12_opens_only_while_developer_mode_is_on() {
        use super::{InspectShortcut, inspect_shortcut_action};

        assert_eq!(
            inspect_shortcut_action(true, 0x7B, false, false, false, false, true, false),
            InspectShortcut::Open
        );
        assert_eq!(
            inspect_shortcut_action(true, 0x49, true, true, false, false, true, false),
            InspectShortcut::Open
        );
        assert_eq!(
            inspect_shortcut_action(false, 0x7B, false, false, false, false, true, false),
            InspectShortcut::Swallow
        );
        assert_eq!(
            inspect_shortcut_action(false, 0x49, true, true, false, false, true, false),
            InspectShortcut::Swallow
        );
        assert_eq!(
            inspect_shortcut_action(true, 0x7B, false, false, false, false, true, true),
            InspectShortcut::Ignore
        );
        assert!(super::HOTKEY_INSTALL.contains("if (!window.__vibexDeveloperMode) return;"));
    }
}
