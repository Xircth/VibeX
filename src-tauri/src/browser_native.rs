//! Desktop browser surfaces, following Codeg's wry split:
//! macOS/Windows embed a child webview with `WebViewBuilder::build_as_child`;
//! Linux uses an owned `WebviewWindow` because child webviews cannot be
//! positioned on Wayland.
//!
//! Tabs are built with no URL (still `about:blank`), then navigated with
//! `load_url` after the surface is in the map — the same order as Codeg
//! `open_tab_core`. wry's `url()` is never called on macOS: it unwraps a nil
//! `WKWebView.URL` and panics the main thread.

use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{Arc, Mutex, Weak, mpsc},
};

use async_trait::async_trait;
use browser_host::{BrowserBounds, BrowserHostError, BrowserService, FrozenFrame, NativeTabs};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{Emitter, Manager};
use tauri_runtime_wry::wry::{
    self, NewWindowResponse, PageLoadEvent, Rect, WebView, WebViewBuilder,
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

const PAGE_EVENT: &str = "plugin.browser";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPageEvent {
    kind: &'static str,
    tab_id: String,
    url: String,
    title: Option<String>,
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
                return f();
            }
        }
        let (tx, rx) = mpsc::channel();
        self.app
            .run_on_main_thread(move || {
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

#[cfg(target_os = "macos")]
fn start_freeze_frame(webview: &WebView, tx: tokio::sync::oneshot::Sender<Option<FrozenFrame>>) {
    use std::sync::Mutex as StdMutex;

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2::runtime::AnyObject;
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
                    let quality = NSNumber::new_f64(0.55);
                    let key = NSString::from_str("NSImageCompressionFactor");
                    let properties = NSDictionary::from_slices(
                        &[&*key],
                        &[&quality as &AnyObject],
                    );
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
            loading,
        },
    );
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
    #[cfg(target_os = "windows")] context: &mut wry::WebContext,
) -> Result<WebView, BrowserHostError> {
    let (on_load, on_title) = page_handlers(app.clone(), tab_id.to_owned(), service.clone());
    let nav_id = tab_id.to_owned();
    let nav_service = service.clone();
    let open_app = app.clone();
    let open_id = tab_id.to_owned();
    let ipc_app = app.clone();
    let ipc_id = tab_id.to_owned();
    let builder = {
        #[cfg(target_os = "windows")]
        {
            WebViewBuilder::new_with_web_context(context)
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
        .with_hotkeys_zoom(true);
    #[cfg(target_os = "macos")]
    {
        builder = builder.with_user_agent(safari_user_agent());
    }
    let mut builder = builder
        .with_navigation_handler(move |url| {
            if !allow_navigation(&url) {
                return false;
            }
            if let Some(service) = nav_service.upgrade() {
                service.commit_url(&nav_id, &url);
            }
            true
        })
        .with_new_window_req_handler(move |url, _features| {
            if allow_navigation(&url) {
                let _ = open_app.emit(
                    PAGE_EVENT,
                    json!({
                        "kind": "tab.open",
                        "url": url,
                        "sourceTabId": open_id,
                    }),
                );
            }
            NewWindowResponse::Deny
        })
        .with_ipc_handler(move |request| {
            let Ok(value) = serde_json::from_str::<Value>(request.body()) else {
                return;
            };
            if value.get("kind").and_then(Value::as_str) != Some("pick") {
                return;
            }
            let _ = ipc_app.emit(
                PAGE_EVENT,
                json!({
                    "kind": "pick",
                    "tabId": ipc_id,
                    "payload": value.get("payload"),
                }),
            );
        })
        .with_on_page_load_handler(on_load)
        .with_document_title_changed_handler(on_title);
    #[cfg(target_os = "macos")]
    {
        use tauri_runtime_wry::wry::WebViewBuilderExtDarwin;
        builder =
            builder.with_data_store_identifier(TauriNativeTabs::data_store_identifier(profile_id));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = profile_id;
    }
    builder.build_as_child(parent).map_err(map_wry)
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
                                context,
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
        self.run_script(tab_id, "location.reload()").await
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
        #[cfg(not(target_os = "macos"))]
        {
            let _ = tab_id;
            return Ok(None);
        }
        #[cfg(target_os = "macos")]
        {
            let tab_id = tab_id.to_owned();
            let (tx, rx) = tokio::sync::oneshot::channel();
            self.on_main(move || {
                SURFACES.with(|slot| {
                    let store = slot.borrow();
                    let Some(webview) = store.views.get(&tab_id) else {
                        let _ = tx.send(None);
                        return Ok(());
                    };
                    start_freeze_frame(webview, tx);
                    Ok(())
                })
            })?;
            match tokio::time::timeout(FREEZE_TIMEOUT, rx).await {
                Ok(Ok(frame)) => Ok(frame),
                _ => Ok(None),
            }
        }
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
