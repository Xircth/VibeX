//! Desktop browser surfaces, following Codeg's wry split:
//! macOS/Windows embed a child webview with `WebViewBuilder::build_as_child`;
//! Linux uses an owned `WebviewWindow` because child webviews cannot be
//! positioned on Wayland.
//!
//! Tabs are built with no URL (still `about:blank`), then navigated with
//! `load_url` after the surface is in the map — the same order as Codeg
//! `open_tab_core`. wry's `url()` is never called on macOS: it unwraps a nil
//! `WKWebView.URL` and panics the main thread.

#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::sync::atomic::AtomicBool;
use std::{
    cell::RefCell,
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread::ThreadId,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use browser_host::{BrowserBounds, BrowserHostError, BrowserService, FrozenFrame, NativeTabs};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{Emitter, Manager};
use tauri_runtime_wry::wry::{
    self, NewWindowFeatures, NewWindowResponse, PageLoadEvent, Rect, WebView, WebViewBuilder,
    dpi::{LogicalPosition, LogicalSize},
};
use url::Url;

struct NativeSurfaces {
    #[cfg(not(target_os = "linux"))]
    views: HashMap<String, WebView>,
    #[cfg(target_os = "windows")]
    contexts: HashMap<String, wry::WebContext>,
    #[cfg(target_os = "linux")]
    windows: HashMap<String, tauri::WebviewWindow>,
    devices: HashMap<String, String>,
    last_bounds: HashMap<String, BrowserBounds>,
}

thread_local! {
    static SURFACES: RefCell<NativeSurfaces> = RefCell::new(NativeSurfaces {
        #[cfg(not(target_os = "linux"))]
        views: HashMap::new(),
        #[cfg(target_os = "windows")]
        contexts: HashMap::new(),
        #[cfg(target_os = "linux")]
        windows: HashMap::new(),
        devices: HashMap::new(),
        last_bounds: HashMap::new(),
    });
}

static MAIN_THREAD: OnceLock<ThreadId> = OnceLock::new();
static POPUP_SEQ: AtomicU64 = AtomicU64::new(0);
static GESTURES: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
static PENDING_POPUPS: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
/// WebView2 `CapturePreview` hangs the compositor if two run at once, which
/// is how a freeze-frame overlay leaves the page unresponsive — including
/// `location.reload()`. One capture at a time; a second ask gets `None`.
#[cfg(any(target_os = "macos", target_os = "windows"))]
static FREEZE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

fn gestures() -> &'static Mutex<HashMap<String, Instant>> {
    GESTURES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mark_gesture(tab_id: &str) {
    if let Ok(mut map) = gestures().lock() {
        let now = Instant::now();
        map.retain(|_, at| now.duration_since(*at) <= browser_host::policy::POPUP_GESTURE_WINDOW);
        map.insert(tab_id.to_owned(), now);
    }
}

fn recent_gesture(tab_id: &str) -> bool {
    gestures()
        .lock()
        .ok()
        .and_then(|map| map.get(tab_id).copied())
        .is_some_and(|at| at.elapsed() <= browser_host::policy::POPUP_GESTURE_WINDOW)
}

fn pending_popups() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    PENDING_POPUPS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Remember the href a click just named so `NewWindowRequested` can use it
/// when WebView2 hands over an empty URI (common for `target=_blank`).
fn remember_popup_url(tab_id: &str, url: &str) {
    if url.is_empty() || !allow_navigation(url) {
        return;
    }
    if let Ok(mut map) = pending_popups().lock() {
        map.retain(|_, (_, at)| at.elapsed() <= Duration::from_secs(2));
        map.insert(tab_id.to_owned(), (url.to_owned(), Instant::now()));
    }
}

fn take_popup_url(tab_id: &str) -> Option<String> {
    let Ok(mut map) = pending_popups().lock() else {
        return None;
    };
    let (url, at) = map.remove(tab_id)?;
    (at.elapsed() <= Duration::from_secs(2)).then_some(url)
}

fn remember_main_thread() {
    let _ = MAIN_THREAD.set(std::thread::current().id());
}

fn on_main_thread() -> bool {
    MAIN_THREAD.get() == Some(&std::thread::current().id())
}

const PAGE_EVENT: &str = "plugin.browser";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPageEvent {
    kind: &'static str,
    tab_id: String,
    url: String,
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    favicon: Option<String>,
    loading: bool,
}

pub struct TauriNativeTabs {
    app: tauri::AppHandle,
    service: Mutex<Weak<BrowserService>>,
}

impl TauriNativeTabs {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            service: Mutex::new(Weak::new()),
        }
    }

    pub fn bind(&self, service: Weak<BrowserService>) {
        if let Ok(mut slot) = self.service.lock() {
            *slot = service;
        }
    }

    fn label(tab_id: &str) -> String {
        format!("browser-{tab_id}")
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    fn profile_dir(profile_id: &str) -> std::path::PathBuf {
        utils::assets::host_data_dir()
            .join("browser-profiles")
            .join(profile_id)
    }

    fn data_store_identifier(profile_id: &str) -> [u8; 16] {
        const NAMESPACE_URL: uuid::Uuid = uuid::Uuid::from_bytes([
            0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4,
            0x30, 0xc8,
        ]);
        uuid::Uuid::new_v5(
            &NAMESPACE_URL,
            format!("https://vibex.app/browser-profile/{profile_id}").as_bytes(),
        )
        .into_bytes()
    }

    fn main_window(&self) -> Result<tauri::WebviewWindow, BrowserHostError> {
        self.app.get_webview_window("main").ok_or_else(|| {
            BrowserHostError::new("browser_open_failed", "main window is not available")
        })
    }

    fn on_main<T: Send + 'static>(
        &self,
        f: impl FnOnce() -> Result<T, BrowserHostError> + Send + 'static,
    ) -> Result<T, BrowserHostError> {
        #[cfg(target_os = "macos")]
        {
            if objc2_foundation::MainThreadMarker::new().is_some() {
                remember_main_thread();
                return f();
            }
        }
        let (tx, rx) = mpsc::channel();
        self.app
            .run_on_main_thread(move || {
                remember_main_thread();
                let _ = tx.send(f());
            })
            .map_err(|error| BrowserHostError::new("browser_open_failed", error.to_string()))?;
        rx.recv()
            .map_err(|error| BrowserHostError::new("browser_open_failed", error.to_string()))?
    }
}

fn device_bounds(panel: &BrowserBounds, device: &str) -> BrowserBounds {
    let (width, height): (f64, f64) = match device {
        "phone" => (390.0, 844.0),
        "tablet" => (768.0, 1024.0),
        _ => return panel.clone(),
    };
    let width = width.min(panel.width.max(1.0));
    let height = height.min(panel.height.max(1.0));
    BrowserBounds {
        x: panel.x + ((panel.width - width) * 0.5).max(0.0),
        y: panel.y + ((panel.height - height) * 0.5).max(0.0),
        width,
        height,
        scale: panel.scale,
        visible: panel.visible,
    }
}

const FREEZE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(400);

#[cfg(target_os = "windows")]
fn start_freeze_frame(webview: &WebView, tx: tokio::sync::oneshot::Sender<Option<FrozenFrame>>) {
    use std::sync::{Arc, Mutex as StdMutex};

    use tauri_runtime_wry::wry::WebViewExtWindows;
    use webview2_com::{
        CapturePreviewCompletedHandler,
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use windows::Win32::UI::Shell::SHCreateMemStream;

    let tx = Arc::new(StdMutex::new(Some(tx)));
    let result = (|| {
        let webview2 = webview.webview();
        let stream = unsafe { SHCreateMemStream(None) }
            .ok_or_else(|| "cannot allocate a snapshot buffer".to_string())?;
        let filled = stream.clone();
        let tx = Arc::clone(&tx);
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
            let frame = match result {
                Ok(()) => read_webview_stream(&filled).ok().map(|bytes| FrozenFrame {
                    mime: "image/png".into(),
                    data: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
                }),
                Err(_) => None,
            };
            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(frame);
            }
            Ok(())
        }));
        unsafe {
            webview2.CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream,
                &handler,
            )
        }
        .map_err(|error| error.to_string())?;
        Ok::<(), String>(())
    })();
    if result.is_err() {
        if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(None);
        }
    }
}

#[cfg(target_os = "windows")]
fn read_webview_stream(stream: &windows::Win32::System::Com::IStream) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::STREAM_SEEK_SET;
    unsafe {
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|error| error.to_string())?;
        let mut out = Vec::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let mut read = 0u32;
            stream
                .Read(
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    Some(&mut read),
                )
                .ok()
                .map_err(|error| error.to_string())?;
            if read == 0 {
                return Ok(out);
            }
            out.extend_from_slice(&buffer[..read as usize]);
        }
    }
}

#[cfg(target_os = "macos")]
fn start_freeze_frame(webview: &WebView, tx: tokio::sync::oneshot::Sender<Option<FrozenFrame>>) {
    use std::sync::Mutex as StdMutex;

    use block2::RcBlock;
    use objc2::{MainThreadMarker, runtime::AnyObject};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSView};
    use objc2_foundation::{NSDictionary, NSNumber, NSString};
    use objc2_web_kit::WKSnapshotConfiguration;
    use tauri_runtime_wry::wry::WebViewExtMacOS;

    let wk = webview.webview();
    let snapshot_width = NSView::bounds(&wk).size.width;
    let tx = StdMutex::new(Some(tx));
    let block = RcBlock::new(
        move |image: *mut NSImage, error: *mut objc2_foundation::NSError| {
            let frame = unsafe {
                if error.is_null() && !image.is_null() {
                    let quality = NSNumber::new_f64(0.92);
                    let key = NSString::from_str("NSImageCompressionFactor");
                    let properties = NSDictionary::from_slices(&[&*key], &[&quality as &AnyObject]);
                    (*image)
                        .TIFFRepresentation()
                        .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                        .and_then(|rep| {
                            rep.representationUsingType_properties(
                                NSBitmapImageFileType::JPEG,
                                &properties,
                            )
                        })
                        .map(|jpeg| FrozenFrame {
                            mime: "image/jpeg".into(),
                            data: base64::Engine::encode(
                                &base64::engine::general_purpose::STANDARD,
                                jpeg.to_vec(),
                            ),
                        })
                } else {
                    None
                }
            };
            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(frame);
            }
        },
    );
    unsafe {
        let mtm = MainThreadMarker::new_unchecked();
        let config = WKSnapshotConfiguration::new(mtm);
        config.setAfterScreenUpdates(false);
        if snapshot_width > 1.0 {
            let width = NSNumber::new_f64(snapshot_width);
            config.setSnapshotWidth(Some(&width));
        }
        wk.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block);
    }
}

fn wry_bounds(bounds: &BrowserBounds) -> Rect {
    Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into(),
    }
}

fn apply_user_agent(webview: &WebView, device: &str) {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::NSString;
        use tauri_runtime_wry::wry::WebViewExtMacOS;
        let ua = match device {
            "phone" => Some(NSString::from_str(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
            )),
            "tablet" => Some(NSString::from_str(
                "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
            )),
            _ => None,
        };
        unsafe {
            webview.webview().setCustomUserAgent(ua.as_deref());
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, device);
    }
}

fn map_wry(error: wry::Error) -> BrowserHostError {
    BrowserHostError::new("browser_open_failed", error.to_string())
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
                forKey: &*key
            ];
            let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
            let _: () = msg_send![defaults, registerDefaults: registration];
        }
    });
}

fn allow_navigation(raw: &str) -> bool {
    let Ok(parsed) = Url::parse(raw) else {
        return false;
    };
    browser_host::navigation_allowed(&parsed) || browser_host::subframe_navigation_allowed(&parsed)
}

/// Overlay thumbs with a transparent track, so the page is not inset for a
/// classic scrollbar gutter. Windows also uses Fluent overlay chrome.
const OVERLAY_SCROLLBAR_SCRIPT: &str = r#"
(() => {
  if (document.getElementById('vibex-overlay-scroll')) return;
  const style = document.createElement('style');
  style.id = 'vibex-overlay-scroll';
  style.textContent = `
    html { scrollbar-width: thin; scrollbar-color: rgba(80,80,80,.45) transparent; }
    html::-webkit-scrollbar, body::-webkit-scrollbar {
      width: 8px; height: 8px; background: transparent;
    }
    html::-webkit-scrollbar-track, html::-webkit-scrollbar-track-piece,
    html::-webkit-scrollbar-corner, body::-webkit-scrollbar-track,
    body::-webkit-scrollbar-track-piece, body::-webkit-scrollbar-corner {
      background: transparent;
    }
    html::-webkit-scrollbar-thumb, body::-webkit-scrollbar-thumb {
      background-color: rgba(80,80,80,.4);
      border-radius: 8px;
      border: 2px solid transparent;
      background-clip: padding-box;
    }
  `;
  document.documentElement.appendChild(style);
})();
"#;

const PAGE_CHROME_SCRIPT: &str = r#"
(() => {
  function send(kind, payload) {
    var msg = 'vibex:' + JSON.stringify({ kind: kind, payload: payload });
    try {
      if (window.ipc && typeof window.ipc.postMessage === 'function') {
        window.ipc.postMessage(msg);
        return true;
      }
    } catch (e) {}
    try {
      if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
        window.chrome.webview.postMessage(msg);
        return true;
      }
    } catch (e) {}
    return false;
  }
  var lastIcon = '';
  var lastTitle = '';
  var chromeFrame = 0;
  function report() {
    var title = document.title || '';
    var icon = document.querySelector('link[rel="icon"]')
      || document.querySelector('link[rel="shortcut icon"]')
      || document.querySelector('link[rel*="icon"]');
    var favicon = icon && icon.href ? icon.href : '';
    if (!favicon && location.origin && location.protocol.indexOf('http') === 0) {
      favicon = location.origin + '/favicon.ico';
    }
    if (title === lastTitle && favicon === lastIcon) return;
    lastTitle = title;
    lastIcon = favicon;
    send('chrome', {
      title: title,
      favicon: favicon,
      url: location.href || ''
    });
  }
  function schedule() {
    if (chromeFrame) return;
    if (typeof requestAnimationFrame !== 'function') {
      report();
      return;
    }
    chromeFrame = requestAnimationFrame(function () {
      chromeFrame = 0;
      report();
    });
  }
  var obs = new MutationObserver(schedule);
  function arm() {
    try {
      obs.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['href', 'rel']
      });
    } catch (e) {}
    report();
  }
  if (document.documentElement) arm();
  else document.addEventListener('DOMContentLoaded', arm, { once: true });
})();
"#;

const PAGE_NAV_SCRIPT: &str = r#"
(() => {
  if (window.__vibexNavHooked) return;
  window.__vibexNavHooked = true;
  function send(kind, payload) {
    var msg = 'vibex:' + JSON.stringify({ kind: kind, payload: payload });
    try {
      if (window.ipc && typeof window.ipc.postMessage === 'function') {
        window.ipc.postMessage(msg);
        return true;
      }
    } catch (e) {}
    try {
      if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
        window.chrome.webview.postMessage(msg);
        return true;
      }
    } catch (e) {}
    return false;
  }
  function hrefOf(anchor) {
    if (!anchor) return '';
    try {
      return anchor.href || '';
    } catch (e) {
      return '';
    }
  }
  function wantsNewTab(event, anchor) {
    if (!anchor) return false;
    if (anchor.hasAttribute('download')) return false;
    var target = (anchor.target || '').toLowerCase();
    if (target === '_blank' || target === '_new') return true;
    if (event.ctrlKey || event.metaKey || event.shiftKey) return true;
    if (event.button === 1) return true;
    return false;
  }
  function onActivate(event) {
    var node = event.target;
    while (node && node.nodeType !== 1) node = node.parentNode;
    var anchor = node && node.closest ? node.closest('a[href]') : null;
    if (!anchor) return;
    var url = hrefOf(anchor);
    if (!url) return;
    if (wantsNewTab(event, anchor)) {
      // Never cancel the click here. preventDefault/stopImmediatePropagation
      // made postMessage "succeed" while eating the engine's new-window
      // request — the page inspector then shows no navigation at all.
      var sent = false;
      try {
        sent = send('gesture', {}) || sent;
        sent = send('navigate', { url: url, newTab: true }) || sent;
        console.info('[vibex-browser] new-tab', url, sent ? 'sent' : 'ipc-missing');
      } catch (e) {
        try { console.info('[vibex-browser] new-tab', url, e); } catch (e2) {}
      }
      return;
    }
    send('navigate', { url: url, newTab: false });
  }
  function openInTab(url) {
    if (!url) return;
    send('gesture', {});
    send('navigate', { url: String(url), newTab: true });
  }
  function reportLocation() {
    try {
      send('navigate', { url: String(location.href || ''), newTab: false });
    } catch (e) {}
  }
  window.addEventListener('pointerdown', function () { send('gesture', {}); }, true);
  window.addEventListener('click', onActivate, true);
  window.addEventListener('auxclick', function (event) {
    if (event.button !== 1) return;
    onActivate(event);
  }, true);
  window.addEventListener('hashchange', reportLocation, true);
  window.addEventListener('popstate', reportLocation, true);
  try {
    var hist = window.history;
    if (hist) {
      var wrap = function (name) {
        var original = hist[name];
        if (typeof original !== 'function') return;
        hist[name] = function () {
          var result = original.apply(this, arguments);
          reportLocation();
          return result;
        };
      };
      wrap('pushState');
      wrap('replaceState');
    }
  } catch (e) {}
  try {
    var origOpen = window.open;
    if (typeof origOpen === 'function') {
      Object.defineProperty(window, 'open', {
        configurable: true,
        writable: true,
        value: function (url, name, features) {
          if (url) openInTab(url);
          return origOpen.apply(this, arguments);
        }
      });
    }
  } catch (e) {}
})();
"#;

/// WKWebView's own UA stops at `(KHTML, like Gecko)` — no `Version/… Safari/…`.
/// Baidu sniffs that as "engine, no browser" and returns a five-line document
/// that `location.replace`s https→http; WebKit upgrades it back to https and
/// the tab loops. GitHub/Google do not. Same tokens Codeg appends.
#[cfg(target_os = "macos")]
fn safari_user_agent() -> &'static str {
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15"
}

fn emit_tab_state(app: &tauri::AppHandle, tab_id: &str, url: &str, loading: bool) {
    let _ = app.emit(
        PAGE_EVENT,
        BrowserPageEvent {
            kind: "tab.state",
            tab_id: tab_id.to_owned(),
            url: url.to_owned(),
            title: None,
            favicon: None,
            loading,
        },
    );
}

fn emit_tab_open(app: &tauri::AppHandle, tab_id: &str, url: &str, source_tab_id: &str) {
    let _ = app.emit(
        PAGE_EVENT,
        json!({
            "kind": "tab.open",
            "url": url,
            "tabId": tab_id,
            "sourceTabId": source_tab_id,
        }),
    );
}

/// Open the URL as a new UI tab without an adopted engine view.
/// Must run on the UI thread: Tauri event delivery from wry's Windows
/// NewWindowRequested worker is dropped.
fn emit_tab_open_url(app: &tauri::AppHandle, url: &str, source_tab_id: &str) {
    let payload = json!({
        "kind": "tab.open",
        "url": url,
        "sourceTabId": source_tab_id,
    });
    if on_main_thread() {
        emit_tab_open_payload(app, payload);
        return;
    }
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        remember_main_thread();
        emit_tab_open_payload(&app, payload);
    });
}

fn parse_page_ipc(body: &str) -> Option<Value> {
    let body = body.trim();
    let body = body.strip_prefix("vibex:").unwrap_or(body);
    let value = serde_json::from_str::<Value>(body).ok()?;
    match value {
        Value::String(inner) => {
            let inner = inner.strip_prefix("vibex:").unwrap_or(&inner);
            serde_json::from_str(inner).ok()
        }
        other => Some(other),
    }
}

fn dispatch_page_ipc(app: &tauri::AppHandle, tab_id: &str, value: &Value) {
    match value.get("kind").and_then(Value::as_str) {
        Some("gesture") => mark_gesture(tab_id),
        Some("pick") => {
            let _ = app.emit(
                PAGE_EVENT,
                json!({
                    "kind": "pick",
                    "tabId": tab_id,
                    "payload": value.get("payload"),
                }),
            );
        }
        Some("navigate") => {
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            let url = payload
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let new_tab = payload
                .get("newTab")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if !allow_navigation(&url) {
                return;
            }
            if new_tab {
                remember_popup_url(tab_id, &url);
                emit_tab_open_url(app, &url, tab_id);
            } else {
                let _ = app.emit(
                    PAGE_EVENT,
                    json!({
                        "kind": "tab.chrome",
                        "tabId": tab_id,
                        "url": url,
                    }),
                );
            }
        }
        Some("chrome") => {
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            let _ = app.emit(
                PAGE_EVENT,
                json!({
                    "kind": "tab.chrome",
                    "tabId": tab_id,
                    "url": payload.get("url").and_then(Value::as_str).unwrap_or(""),
                    "title": payload.get("title").and_then(Value::as_str),
                    "favicon": payload.get("favicon").and_then(Value::as_str).filter(|value| !value.is_empty()),
                }),
            );
        }
        _ => {}
    }
}

fn emit_tab_open_payload(app: &tauri::AppHandle, payload: Value) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit(PAGE_EVENT, payload.clone());
        if let Ok(json) = serde_json::to_string(&payload) {
            let script = format!(
                "(function(){{try{{window.dispatchEvent(new CustomEvent('vibex-browser-tab-open',{{detail:{json}}}));}}catch(e){{}}}})();"
            );
            let _ = window.eval(&script);
        }
    }
    let _ = app.emit(PAGE_EVENT, payload);
}

fn fallback_open_or_deny(
    app: &tauri::AppHandle,
    opener_id: &str,
    url: &str,
    reason: &str,
) -> NewWindowResponse {
    if url != "about:blank" && allow_navigation(url) {
        emit_tab_open_url(app, url, opener_id);
    } else if on_main_thread() {
        emit_popup_denied(app, opener_id, url, reason);
    } else {
        let app = app.clone();
        let opener = opener_id.to_owned();
        let url = url.to_owned();
        let reason = reason.to_owned();
        let _ = app.clone().run_on_main_thread(move || {
            remember_main_thread();
            emit_popup_denied(&app, &opener, &url, &reason);
        });
    }
    NewWindowResponse::Deny
}

#[cfg(target_os = "windows")]
type AdoptedView = webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
#[cfg(target_os = "macos")]
type AdoptedView = objc2::rc::Retained<objc2_web_kit::WKWebView>;

#[cfg(target_os = "windows")]
struct SendCoreWebView(AdoptedView);
#[cfg(target_os = "windows")]
unsafe impl Send for SendCoreWebView {}

/// Codeg `surface_child::new_window_handler`: build a child webview from the
/// opener's environment, register it, and hand the platform view back so the
/// engine navigates it. Deny cancels `window.open` / `target=_blank` with no
/// visible tab.
fn emit_popup_denied(app: &tauri::AppHandle, opener_id: &str, url: &str, reason: &str) {
    let _ = app.emit(
        PAGE_EVENT,
        json!({
            "kind": "popup.denied",
            "sourceTabId": opener_id,
            "url": url,
            "reason": reason,
        }),
    );
}

/// WebView2 raises this on the UI thread. wry 0.54 then hops to a worker
/// and waits for `Create`, which deadlocks the deferral. Attach this instead:
/// handle the request here, tell the Host to open a tab, and mark it handled.
#[cfg(target_os = "windows")]
fn attach_windows_popup_handler(
    webview: &WebView,
    app: tauri::AppHandle,
    opener_id: String,
) -> Result<(), BrowserHostError> {
    use tauri_runtime_wry::wry::WebViewExtWindows;
    use webview2_com::{NewWindowRequestedEventHandler, WebMessageReceivedEventHandler};
    use windows::{Win32::System::Com::CoTaskMemFree, core::PWSTR};

    fn take_uri(source: PWSTR) -> String {
        if source.is_null() {
            return String::new();
        }
        let text = unsafe { source.to_string().unwrap_or_default() };
        unsafe { CoTaskMemFree(Some(source.0 as _)) };
        text
    }

    let core = webview.webview();
    let app_popup = app.clone();
    let opener_popup = opener_id.clone();
    let mut token = 0i64;
    unsafe {
        core.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let mut url = take_uri(uri);
                if url.is_empty() {
                    if let Some(pending) = take_popup_url(&opener_popup) {
                        url = pending;
                    }
                }
                if url != "about:blank" && allow_navigation(&url) {
                    emit_tab_open_url(&app_popup, &url, &opener_popup);
                }
                let _ = args.SetHandled(true);
                Ok(())
            })),
            &mut token,
        )
        .map_err(|error| BrowserHostError::new("browser_open_failed", error.to_string()))?;
        let mut msg_token = 0i64;
        core.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut raw = PWSTR::null();
                let text = if args.TryGetWebMessageAsString(&mut raw).is_ok() {
                    take_uri(raw)
                } else {
                    let mut json = PWSTR::null();
                    if args.WebMessageAsJson(&mut json).is_err() {
                        return Ok(());
                    }
                    take_uri(json)
                };
                if let Some(value) = parse_page_ipc(&text) {
                    dispatch_page_ipc(&app, &opener_id, &value);
                }
                Ok(())
            })),
            &mut msg_token,
        )
        .map_err(|error| BrowserHostError::new("browser_open_failed", error.to_string()))?;
    }
    Ok(())
}

fn handle_new_window(
    app: &tauri::AppHandle,
    owner: &tauri::WebviewWindow,
    opener_id: &str,
    profile_id: &str,
    service: Weak<BrowserService>,
    url: String,
    features: NewWindowFeatures,
) -> NewWindowResponse {
    let open_url = if url.is_empty() {
        // The click's IPC href is posted in the same gesture; wait a beat
        // so it can land before we fall back to about:blank.
        if let Some(url) = take_popup_url(opener_id) {
            url
        } else {
            std::thread::sleep(Duration::from_millis(50));
            take_popup_url(opener_id).unwrap_or_else(|| "about:blank".to_owned())
        }
    } else {
        url.clone()
    };
    if !allow_navigation(&open_url) {
        emit_popup_denied(app, opener_id, &open_url, "blocked-scheme");
        return NewWindowResponse::Deny;
    }
    // http(s) links become a Host tab. Creating a child WebView2 from wry's
    // Windows worker deadlocks the NewWindowRequested deferral, and emitting
    // from that worker never reaches the UI. Deny the engine window and
    // open the URL ourselves on the main thread — the same outcome as a
    // browser tab, without opener.
    if open_url != "about:blank" {
        return fallback_open_or_deny(app, opener_id, &open_url, "opened-as-tab");
    }
    let gesture_ok = recent_gesture(opener_id) || cfg!(target_os = "windows");
    if !gesture_ok {
        return fallback_open_or_deny(app, opener_id, &open_url, "no-gesture");
    }
    if on_main_thread() {
        return adopt_popup(
            app, owner, opener_id, profile_id, service, &open_url, &features,
        )
        .unwrap_or_else(|_| fallback_open_or_deny(app, opener_id, &open_url, "create-failed"));
    }
    #[cfg(target_os = "windows")]
    {
        let (tx, rx) = mpsc::channel();
        let app = app.clone();
        let deny_app = app.clone();
        let owner = owner.clone();
        let opener_owned = opener_id.to_owned();
        let profile_id = profile_id.to_owned();
        let deny_opener = opener_owned.clone();
        let deny_url = open_url.clone();
        let adopt_url = open_url.clone();
        let _ = app.clone().run_on_main_thread(move || {
            remember_main_thread();
            let result = adopt_popup_view(
                &app,
                &owner,
                &opener_owned,
                &profile_id,
                service,
                &adopt_url,
                &features,
            )
            .map(SendCoreWebView);
            let _ = tx.send(result);
        });
        return match rx.recv_timeout(Duration::from_millis(400)) {
            Ok(Ok(SendCoreWebView(webview))) => NewWindowResponse::Create { webview },
            _ => fallback_open_or_deny(&deny_app, &deny_opener, &deny_url, "create-failed"),
        };
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (owner, profile_id, service, url, features);
        fallback_open_or_deny(app, opener_id, &open_url, "create-failed")
    }
}

#[cfg(not(target_os = "linux"))]
fn adopt_popup(
    app: &tauri::AppHandle,
    owner: &tauri::WebviewWindow,
    opener_id: &str,
    profile_id: &str,
    service: Weak<BrowserService>,
    url: &str,
    features: &NewWindowFeatures,
) -> Result<NewWindowResponse, BrowserHostError> {
    let webview = adopt_popup_view(app, owner, opener_id, profile_id, service, url, features)?;
    Ok(NewWindowResponse::Create { webview })
}

#[cfg(not(target_os = "linux"))]
fn adopt_popup_view(
    app: &tauri::AppHandle,
    owner: &tauri::WebviewWindow,
    opener_id: &str,
    profile_id: &str,
    service: Weak<BrowserService>,
    url: &str,
    features: &NewWindowFeatures,
) -> Result<AdoptedView, BrowserHostError> {
    let open_url = if url.is_empty() {
        "about:blank".to_owned()
    } else {
        url.to_owned()
    };
    if !allow_navigation(&open_url) {
        return Err(BrowserHostError::new(
            "browser_bad_address",
            "this address cannot open in a tab",
        ));
    }
    SURFACES.with(|slot| {
        let mut store = slot.borrow_mut();
        let tab_id = loop {
            let seq = POPUP_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
            let candidate = format!("{opener_id}-p{seq}");
            if !store.views.contains_key(&candidate) {
                break candidate;
            }
        };
        let mut bounds = store
            .last_bounds
            .get(opener_id)
            .cloned()
            .unwrap_or_default();
        bounds.visible = false;
        let label = TauriNativeTabs::label(&tab_id);
        let webview = {
            #[cfg(target_os = "windows")]
            {
                build_child(
                    owner,
                    &tab_id,
                    &label,
                    &bounds,
                    profile_id,
                    app,
                    service.clone(),
                    None,
                    Some(features),
                )?
            }
            #[cfg(target_os = "macos")]
            {
                build_child(
                    owner,
                    &tab_id,
                    &label,
                    &bounds,
                    profile_id,
                    app,
                    service.clone(),
                    Some(features),
                )?
            }
        };
        let _ = webview.set_visible(false);
        store.last_bounds.insert(tab_id.clone(), bounds.clone());
        store.views.insert(tab_id.clone(), webview);
        let platform = {
            let webview = store.views.get(&tab_id).expect("inserted popup");
            #[cfg(target_os = "windows")]
            {
                use tauri_runtime_wry::wry::WebViewExtWindows;
                webview.webview()
            }
            #[cfg(target_os = "macos")]
            {
                use tauri_runtime_wry::wry::WebViewExtMacOS;
                objc2::rc::Retained::into_super(webview.webview())
            }
        };
        if let Some(service) = service.upgrade() {
            service.adopt_tab(
                tab_id.clone(),
                open_url.clone(),
                profile_id.to_owned(),
                bounds,
            );
        }
        emit_tab_open(app, &tab_id, &open_url, opener_id);
        Ok(platform)
    })
}

fn page_handlers(
    app: tauri::AppHandle,
    tab_id: String,
    service: Weak<BrowserService>,
) -> (
    impl Fn(PageLoadEvent, String) + Send + 'static,
    impl Fn(String) + Send + 'static,
) {
    let load_app = app.clone();
    let load_id = tab_id.clone();
    let load_service = service;
    let title_app = app;
    let title_id = tab_id;
    (
        move |event, url| {
            let loading = matches!(event, PageLoadEvent::Started);
            if !loading {
                if let Some(service) = load_service.upgrade() {
                    service.commit_url(&load_id, &url);
                }
            }
            emit_tab_state(&load_app, &load_id, &url, loading);
        },
        move |title| {
            let _ = title_app.emit(
                PAGE_EVENT,
                BrowserPageEvent {
                    kind: "tab.state",
                    tab_id: title_id.clone(),
                    url: String::new(),
                    title: Some(title),
                    favicon: None,
                    loading: false,
                },
            );
        },
    )
}

#[cfg(not(target_os = "linux"))]
fn committed_url(webview: &WebView) -> Result<String, BrowserHostError> {
    #[cfg(target_os = "macos")]
    {
        use tauri_runtime_wry::wry::WebViewExtMacOS;
        let wk = webview.webview();
        unsafe {
            Ok(wk
                .URL()
                .and_then(|url| url.absoluteString())
                .map(|value| value.to_string())
                .unwrap_or_else(|| "about:blank".into()))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        webview
            .url()
            .map_err(|error| BrowserHostError::new("browser_read_failed", error.to_string()))
    }
}

#[cfg(not(target_os = "linux"))]
fn build_child(
    parent: &tauri::WebviewWindow,
    tab_id: &str,
    label: &str,
    bounds: &BrowserBounds,
    profile_id: &str,
    app: &tauri::AppHandle,
    service: Weak<BrowserService>,
    #[cfg(target_os = "windows")] context: Option<&mut wry::WebContext>,
    popup: Option<&NewWindowFeatures>,
) -> Result<WebView, BrowserHostError> {
    let (on_load, on_title) = page_handlers(app.clone(), tab_id.to_owned(), service.clone());
    let nav_id = tab_id.to_owned();
    let nav_service = service.clone();
    let popup_app = app.clone();
    let popup_owner = parent.clone();
    let popup_opener = tab_id.to_owned();
    let popup_profile = profile_id.to_owned();
    let popup_service = service.clone();
    let ipc_app = app.clone();
    let ipc_id = tab_id.to_owned();
    let builder = {
        #[cfg(target_os = "windows")]
        {
            match context {
                Some(context) => WebViewBuilder::new_with_web_context(context),
                None => WebViewBuilder::new(),
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            WebViewBuilder::new()
        }
    };
    #[cfg(target_os = "macos")]
    prefer_detached_inspector();
    let mut builder = builder
        .with_id(label)
        .with_bounds(wry_bounds(bounds))
        .with_visible(bounds.visible)
        .with_focused(false)
        .with_devtools(cfg!(debug_assertions))
        .with_hotkeys_zoom(true)
        .with_initialization_script(OVERLAY_SCROLLBAR_SCRIPT)
        .with_initialization_script(PAGE_CHROME_SCRIPT)
        .with_initialization_script(PAGE_NAV_SCRIPT);
    let started_app = app.clone();
    let started_id = tab_id.to_owned();
    let done_app = app.clone();
    let done_id = tab_id.to_owned();
    builder = builder
        .with_download_started_handler(move |url, path: &mut PathBuf| {
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("download")
                .to_owned();
            let _ = started_app.emit(
                PAGE_EVENT,
                json!({
                    "kind": "download",
                    "tabId": started_id,
                    "state": "started",
                    "url": url,
                    "fileName": file_name,
                    "path": path.to_string_lossy(),
                }),
            );
            true
        })
        .with_download_completed_handler(move |url, path, success| {
            let file_name = path
                .as_ref()
                .and_then(|item| item.file_name())
                .and_then(|name| name.to_str())
                .unwrap_or("download")
                .to_owned();
            let _ = done_app.emit(
                PAGE_EVENT,
                json!({
                    "kind": "download",
                    "tabId": done_id,
                    "state": if success { "completed" } else { "failed" },
                    "url": url,
                    "fileName": file_name,
                    "path": path.as_ref().map(|item| item.to_string_lossy().into_owned()),
                }),
            );
        });
    #[cfg(target_os = "macos")]
    {
        builder = builder.with_user_agent(safari_user_agent());
    }
    #[cfg(target_os = "windows")]
    {
        use tauri_runtime_wry::wry::{ScrollBarStyle, WebViewBuilderExtWindows};
        builder = builder.with_scroll_bar_style(ScrollBarStyle::FluentOverlay);
        if let Some(features) = popup {
            builder = builder.with_environment(features.opener.environment.clone());
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(features) = popup {
            use tauri_runtime_wry::wry::WebViewBuilderExtMacos;
            builder =
                builder.with_webview_configuration(features.opener.target_configuration.clone());
        }
    }
    let nav_app = app.clone();
    let nav_emit_id = tab_id.to_owned();
    let mut builder = builder.with_navigation_handler(move |url| {
        if !allow_navigation(&url) {
            let _ = nav_app.emit(
                PAGE_EVENT,
                json!({
                    "kind": "navigation.blocked",
                    "tabId": nav_emit_id,
                    "url": url,
                    "reason": "scheme",
                }),
            );
            return false;
        }
        if let Some(service) = nav_service.upgrade() {
            service.commit_url(&nav_id, &url);
        }
        emit_tab_state(&nav_app, &nav_emit_id, &url, true);
        true
    });
    #[cfg(not(target_os = "windows"))]
    {
        builder = builder.with_new_window_req_handler(move |url, features| {
            handle_new_window(
                &popup_app,
                &popup_owner,
                &popup_opener,
                &popup_profile,
                popup_service.clone(),
                url,
                features,
            )
        });
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (
            &popup_app,
            &popup_owner,
            &popup_opener,
            &popup_profile,
            &popup_service,
        );
    }
    builder = builder
        .with_ipc_handler(move |request| {
            let Some(value) = parse_page_ipc(request.body()) else {
                return;
            };
            dispatch_page_ipc(&ipc_app, &ipc_id, &value);
        })
        .with_on_page_load_handler(on_load)
        .with_document_title_changed_handler(on_title);
    #[cfg(target_os = "macos")]
    {
        if popup.is_none() {
            use tauri_runtime_wry::wry::WebViewBuilderExtDarwin;
            builder = builder
                .with_data_store_identifier(TauriNativeTabs::data_store_identifier(profile_id));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = profile_id;
    }
    let webview = builder.build_as_child(parent).map_err(map_wry)?;
    #[cfg(target_os = "windows")]
    {
        attach_windows_popup_handler(&webview, app.clone(), tab_id.to_owned())?;
    }
    Ok(webview)
}

#[async_trait]
impl NativeTabs for TauriNativeTabs {
    async fn open(
        &self,
        tab_id: &str,
        url: &str,
        bounds: &BrowserBounds,
        profile_id: &str,
    ) -> Result<(), BrowserHostError> {
        let owner = self.main_window()?;
        let tab_id = tab_id.to_owned();
        let url = url.to_owned();
        let mut bounds = bounds.clone();
        if bounds.width >= 32.0 && bounds.height >= 32.0 {
            bounds.visible = true;
        }
        let profile_id = profile_id.to_owned();
        let app = self.app.clone();
        let service = self
            .service
            .lock()
            .ok()
            .map(|slot| slot.clone())
            .unwrap_or_else(Weak::new);
        self.on_main(move || {
            #[cfg(not(target_os = "linux"))]
            {
                SURFACES.with(|slot| {
                    let mut store = slot.borrow_mut();
                    if store.views.contains_key(&tab_id) {
                        return Ok(());
                    }
                    let label = Self::label(&tab_id);
                    #[cfg(target_os = "windows")]
                    let profile_dir = {
                        let dir = Self::profile_dir(&profile_id);
                        let _ = std::fs::create_dir_all(&dir);
                        dir
                    };
                    let webview = {
                        #[cfg(target_os = "windows")]
                        {
                            let context = store
                                .contexts
                                .entry(profile_id.clone())
                                .or_insert_with(|| wry::WebContext::new(Some(profile_dir)));
                            build_child(
                                &owner,
                                &tab_id,
                                &label,
                                &bounds,
                                &profile_id,
                                &app,
                                service.clone(),
                                Some(context),
                                None,
                            )?
                        }
                        #[cfg(not(target_os = "windows"))]
                        {
                            build_child(
                                &owner,
                                &tab_id,
                                &label,
                                &bounds,
                                &profile_id,
                                &app,
                                service.clone(),
                                None,
                            )?
                        }
                    };
                    store.last_bounds.insert(tab_id.clone(), bounds.clone());
                    store.views.insert(tab_id.clone(), webview);
                    let webview = store.views.get(&tab_id).expect("inserted");
                    let placed = device_bounds(
                        &bounds,
                        store
                            .devices
                            .get(&tab_id)
                            .map(String::as_str)
                            .unwrap_or("desktop"),
                    );
                    webview.set_bounds(wry_bounds(&placed)).map_err(map_wry)?;
                    webview.set_visible(bounds.visible).map_err(map_wry)?;
                    webview.load_url(&url).map_err(map_wry)
                })
            }
            #[cfg(target_os = "linux")]
            {
                use tauri::{WebviewUrl, WebviewWindowBuilder};
                SURFACES.with(|slot| {
                    let mut store = slot.borrow_mut();
                    if store.windows.contains_key(&tab_id) {
                        return Ok(());
                    }
                    let label = Self::label(&tab_id);
                    let blank = Url::parse("about:blank").expect("blank");
                    let profile_dir = Self::profile_dir(&profile_id);
                    let _ = std::fs::create_dir_all(&profile_dir);
                    let load_app = app.clone();
                    let load_id = tab_id.clone();
                    let title_app = app.clone();
                    let title_id = tab_id.clone();
                    let window =
                        WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(blank))
                            .title("Browser")
                            .inner_size(bounds.width.max(480.0), bounds.height.max(320.0))
                            .focused(false)
                            .devtools(cfg!(debug_assertions))
                            .on_navigation(|nav| allow_navigation(nav.as_str()))
                            .on_page_load(move |_window, payload| {
                                let _ = load_app.emit(
                                    PAGE_EVENT,
                                    BrowserPageEvent {
                                        kind: "tab.state",
                                        tab_id: load_id.clone(),
                                        url: payload.url().to_string(),
                                        title: None,
                                        favicon: None,
                                        loading: matches!(
                                            payload.event(),
                                            tauri::webview::PageLoadEvent::Started
                                        ),
                                    },
                                );
                            })
                            .on_document_title_changed(move |_window, title| {
                                let _ = title_app.emit(
                                    PAGE_EVENT,
                                    BrowserPageEvent {
                                        kind: "tab.state",
                                        tab_id: title_id.clone(),
                                        url: String::new(),
                                        title: Some(title),
                                        favicon: None,
                                        loading: false,
                                    },
                                );
                            })
                            .parent(&owner)
                            .map_err(|error| {
                                BrowserHostError::new("browser_open_failed", error.to_string())
                            })?
                            .data_directory(profile_dir)
                            .build()
                            .map_err(|error| {
                                BrowserHostError::new("browser_open_failed", error.to_string())
                            })?;
                    let parsed = Url::parse(&url).map_err(|error| {
                        BrowserHostError::new("browser_bad_address", error.to_string())
                    })?;
                    window.navigate(parsed).map_err(|error| {
                        BrowserHostError::new("browser_open_failed", error.to_string())
                    })?;
                    store.windows.insert(tab_id, window);
                    Ok(())
                })
            }
        })
    }

    async fn navigate(&self, tab_id: &str, url: &str) -> Result<(), BrowserHostError> {
        let tab_id = tab_id.to_owned();
        let url = url.to_owned();
        self.on_main(move || {
            SURFACES.with(|slot| {
                #[cfg(not(target_os = "linux"))]
                {
                    let store = slot.borrow();
                    let webview = store.views.get(&tab_id).ok_or_else(|| {
                        BrowserHostError::new("browser_no_such_tab", format!("no surface {tab_id}"))
                    })?;
                    if let Some(bounds) = store.last_bounds.get(&tab_id) {
                        let mut shown = bounds.clone();
                        shown.visible = true;
                        let placed = device_bounds(
                            &shown,
                            store
                                .devices
                                .get(&tab_id)
                                .map(String::as_str)
                                .unwrap_or("desktop"),
                        );
                        webview.set_bounds(wry_bounds(&placed)).map_err(map_wry)?;
                        webview.set_visible(true).map_err(map_wry)?;
                    }
                    webview.load_url(&url).map_err(map_wry)
                }
                #[cfg(target_os = "linux")]
                {
                    let store = slot.borrow();
                    let window = store.windows.get(&tab_id).ok_or_else(|| {
                        BrowserHostError::new("browser_no_such_tab", format!("no surface {tab_id}"))
                    })?;
                    let parsed = Url::parse(&url).map_err(|error| {
                        BrowserHostError::new("browser_bad_address", error.to_string())
                    })?;
                    window.navigate(parsed).map_err(|error| {
                        BrowserHostError::new("browser_open_failed", error.to_string())
                    })
                }
            })
        })
    }

    async fn close(&self, tab_id: &str) -> Result<(), BrowserHostError> {
        let tab_id = tab_id.to_owned();
        self.on_main(move || {
            SURFACES.with(|slot| {
                let mut store = slot.borrow_mut();
                #[cfg(not(target_os = "linux"))]
                {
                    store.views.remove(&tab_id);
                }
                #[cfg(target_os = "linux")]
                {
                    if let Some(window) = store.windows.remove(&tab_id) {
                        let _ = window.close();
                    }
                }
                store.devices.remove(&tab_id);
                store.last_bounds.remove(&tab_id);
                Ok(())
            })
        })
    }

    async fn set_bounds(
        &self,
        tab_id: &str,
        bounds: &BrowserBounds,
    ) -> Result<(), BrowserHostError> {
        let tab_id = tab_id.to_owned();
        let bounds = bounds.clone();
        self.on_main(move || {
            SURFACES.with(|slot| {
                #[cfg(not(target_os = "linux"))]
                {
                    let mut store = slot.borrow_mut();
                    if store.last_bounds.get(&tab_id) == Some(&bounds) {
                        return Ok(());
                    }
                    store.last_bounds.insert(tab_id.clone(), bounds.clone());
                    let placed = device_bounds(
                        &bounds,
                        store
                            .devices
                            .get(&tab_id)
                            .map(String::as_str)
                            .unwrap_or("desktop"),
                    );
                    let Some(webview) = store.views.get(&tab_id) else {
                        return Ok(());
                    };
                    webview.set_bounds(wry_bounds(&placed)).map_err(map_wry)?;
                    webview.set_visible(bounds.visible).map_err(map_wry)
                }
                #[cfg(target_os = "linux")]
                {
                    let _ = tab_id;
                    let _ = bounds;
                    Ok(())
                }
            })
        })
    }

    async fn eval(&self, tab_id: &str, expression: &str) -> Result<String, BrowserHostError> {
        let tab_id = tab_id.to_owned();
        let expression = expression.to_owned();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = Mutex::new(Some(tx));
        self.on_main(move || {
            SURFACES.with(|slot| {
                #[cfg(not(target_os = "linux"))]
                {
                    let store = slot.borrow();
                    let webview = store.views.get(&tab_id).ok_or_else(|| {
                        BrowserHostError::new("browser_no_such_tab", format!("no surface {tab_id}"))
                    })?;
                    webview
                        .evaluate_script_with_callback(&expression, move |result| {
                            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                                let _ = tx.send(result);
                            }
                        })
                        .map_err(|error| {
                            BrowserHostError::new("browser_read_failed", error.to_string())
                        })
                }
                #[cfg(target_os = "linux")]
                {
                    let store = slot.borrow();
                    let window = store.windows.get(&tab_id).ok_or_else(|| {
                        BrowserHostError::new("browser_no_such_tab", format!("no surface {tab_id}"))
                    })?;
                    window.eval(&expression).map_err(|error| {
                        BrowserHostError::new("browser_read_failed", error.to_string())
                    })?;
                    if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                        let _ = tx.send("null".into());
                    }
                    Ok(())
                }
            })
        })?;
        tokio::time::timeout(std::time::Duration::from_secs(15), rx)
            .await
            .map_err(|_| {
                BrowserHostError::new("browser_read_failed", "the page did not answer in time")
            })?
            .map_err(|_| BrowserHostError::new("browser_read_failed", "the page did not answer"))
    }

    async fn current_url(&self, tab_id: &str) -> Result<String, BrowserHostError> {
        let tab_id = tab_id.to_owned();
        self.on_main(move || {
            SURFACES.with(|slot| {
                #[cfg(not(target_os = "linux"))]
                {
                    let store = slot.borrow();
                    let webview = store.views.get(&tab_id).ok_or_else(|| {
                        BrowserHostError::new("browser_no_such_tab", format!("no surface {tab_id}"))
                    })?;
                    committed_url(webview)
                }
                #[cfg(target_os = "linux")]
                {
                    let store = slot.borrow();
                    let window = store.windows.get(&tab_id).ok_or_else(|| {
                        BrowserHostError::new("browser_no_such_tab", format!("no surface {tab_id}"))
                    })?;
                    window.url().map(|url| url.to_string()).map_err(|error| {
                        BrowserHostError::new("browser_read_failed", error.to_string())
                    })
                }
            })
        })
    }

    async fn go_back(&self, tab_id: &str) -> Result<(), BrowserHostError> {
        self.run_script(tab_id, "history.back()").await
    }

    async fn go_forward(&self, tab_id: &str) -> Result<(), BrowserHostError> {
        self.run_script(tab_id, "history.forward()").await
    }

    async fn reload(&self, tab_id: &str) -> Result<(), BrowserHostError> {
        let tab_id = tab_id.to_owned();
        self.on_main(move || {
            SURFACES.with(|slot| {
                #[cfg(not(target_os = "linux"))]
                {
                    let store = slot.borrow();
                    let webview = store.views.get(&tab_id).ok_or_else(|| {
                        BrowserHostError::new("browser_no_such_tab", format!("no surface {tab_id}"))
                    })?;
                    let url = committed_url(webview).unwrap_or_default();
                    if url.is_empty() {
                        webview
                            .evaluate_script("location.reload()")
                            .map_err(map_wry)
                    } else {
                        webview.load_url(&url).map_err(map_wry)
                    }
                }
                #[cfg(target_os = "linux")]
                {
                    let store = slot.borrow();
                    let window = store.windows.get(&tab_id).ok_or_else(|| {
                        BrowserHostError::new("browser_no_such_tab", format!("no surface {tab_id}"))
                    })?;
                    match window.url() {
                        Ok(url) => window.navigate(url).map_err(|error| {
                            BrowserHostError::new("browser_open_failed", error.to_string())
                        }),
                        Err(_) => window.eval("location.reload()").map_err(|error| {
                            BrowserHostError::new("browser_open_failed", error.to_string())
                        }),
                    }
                }
            })
        })
    }

    async fn set_zoom(&self, tab_id: &str, factor: f64) -> Result<(), BrowserHostError> {
        let tab_id = tab_id.to_owned();
        self.on_main(move || {
            SURFACES.with(|slot| {
                #[cfg(not(target_os = "linux"))]
                {
                    let store = slot.borrow();
                    let webview = store.views.get(&tab_id).ok_or_else(|| {
                        BrowserHostError::new("browser_no_such_tab", format!("no surface {tab_id}"))
                    })?;
                    webview.zoom(factor).map_err(map_wry)
                }
                #[cfg(target_os = "linux")]
                {
                    let _ = tab_id;
                    let _ = factor;
                    Ok(())
                }
            })
        })
    }

    async fn open_devtools(&self, tab_id: &str) -> Result<(), BrowserHostError> {
        let tab_id = tab_id.to_owned();
        self.on_main(move || {
            SURFACES.with(|slot| {
                #[cfg(not(target_os = "linux"))]
                {
                    #[cfg(target_os = "macos")]
                    prefer_detached_inspector();
                    let store = slot.borrow();
                    let webview = store.views.get(&tab_id).ok_or_else(|| {
                        BrowserHostError::new("browser_no_such_tab", format!("no surface {tab_id}"))
                    })?;
                    webview.open_devtools();
                    Ok(())
                }
                #[cfg(target_os = "linux")]
                {
                    let _ = tab_id;
                    Ok(())
                }
            })
        })
    }

    async fn set_device(&self, tab_id: &str, device: &str) -> Result<(), BrowserHostError> {
        let tab_id = tab_id.to_owned();
        let device = device.to_owned();
        self.on_main(move || {
            SURFACES.with(|slot| {
                let mut store = slot.borrow_mut();
                store.devices.insert(tab_id.clone(), device.clone());
                #[cfg(not(target_os = "linux"))]
                {
                    let bounds = store
                        .last_bounds
                        .get(&tab_id)
                        .cloned()
                        .unwrap_or_else(BrowserBounds::default);
                    let placed = device_bounds(&bounds, &device);
                    let Some(webview) = store.views.get(&tab_id) else {
                        return Ok(());
                    };
                    apply_user_agent(webview, &device);
                    webview.set_bounds(wry_bounds(&placed)).map_err(map_wry)?;
                    Ok(())
                }
                #[cfg(target_os = "linux")]
                {
                    let _ = device;
                    Ok(())
                }
            })
        })
    }

    async fn inject(&self, tab_id: &str, script: &str) -> Result<(), BrowserHostError> {
        self.run_script(tab_id, script).await
    }

    async fn freeze_frame(&self, tab_id: &str) -> Result<Option<FrozenFrame>, BrowserHostError> {
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = tab_id;
            return Ok(None);
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            if FREEZE_IN_FLIGHT.swap(true, Ordering::SeqCst) {
                return Ok(None);
            }
            let tab_id = tab_id.to_owned();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let started = self.on_main(move || {
                SURFACES.with(|slot| {
                    let store = slot.borrow();
                    let hidden = store
                        .last_bounds
                        .get(&tab_id)
                        .is_some_and(|bounds| !bounds.visible);
                    if hidden {
                        let _ = tx.send(None);
                        return Ok(());
                    }
                    let Some(webview) = store.views.get(&tab_id) else {
                        let _ = tx.send(None);
                        return Ok(());
                    };
                    start_freeze_frame(webview, tx);
                    Ok(())
                })
            });
            let frame = match started {
                Ok(()) => match tokio::time::timeout(FREEZE_TIMEOUT, rx).await {
                    Ok(Ok(frame)) => frame,
                    _ => None,
                },
                Err(_) => None,
            };
            FREEZE_IN_FLIGHT.store(false, Ordering::SeqCst);
            Ok(frame)
        }
    }

    fn notify(&self, payload: Value) {
        if payload.get("kind").and_then(Value::as_str) == Some("tab.open") {
            if on_main_thread() {
                emit_tab_open_payload(&self.app, payload);
                return;
            }
            let app = self.app.clone();
            let _ = app.clone().run_on_main_thread(move || {
                remember_main_thread();
                emit_tab_open_payload(&app, payload);
            });
            return;
        }
        let _ = self.app.emit(PAGE_EVENT, payload);
    }
}

impl TauriNativeTabs {
    async fn run_script(&self, tab_id: &str, script: &str) -> Result<(), BrowserHostError> {
        let tab_id = tab_id.to_owned();
        let script = script.to_owned();
        self.on_main(move || {
            SURFACES.with(|slot| {
                #[cfg(not(target_os = "linux"))]
                {
                    let store = slot.borrow();
                    let webview = store.views.get(&tab_id).ok_or_else(|| {
                        BrowserHostError::new("browser_no_such_tab", format!("no surface {tab_id}"))
                    })?;
                    webview.evaluate_script(&script).map_err(map_wry)
                }
                #[cfg(target_os = "linux")]
                {
                    let store = slot.borrow();
                    let window = store.windows.get(&tab_id).ok_or_else(|| {
                        BrowserHostError::new("browser_no_such_tab", format!("no surface {tab_id}"))
                    })?;
                    window.eval(&script).map_err(|error| {
                        BrowserHostError::new("browser_open_failed", error.to_string())
                    })
                }
            })
        })
    }
}

pub fn desktop_browser_service(app: tauri::AppHandle) -> Arc<browser_host::BrowserService> {
    let native = Arc::new(TauriNativeTabs::new(app));
    let service = Arc::new(browser_host::BrowserService::new(native.clone(), true));
    native.bind(Arc::downgrade(&service));
    service
}
