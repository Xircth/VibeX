use std::time::Duration;

use browser_host::BrowserHostError;
use tauri::Webview;

const EVAL_TIMEOUT: Duration = Duration::from_secs(15);

pub async fn eval_js(webview: Webview, script: String) -> Result<String, BrowserHostError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| start_eval(platform, script, tx))
        .map_err(|error| BrowserHostError::new("browser_read_failed", error.to_string()))?;
    match tokio::time::timeout(EVAL_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(BrowserHostError::new(
            "browser_read_failed",
            "the page did not answer",
        )),
        Err(_) => Err(BrowserHostError::new(
            "browser_read_failed",
            "the page did not answer in time",
        )),
    }
}

fn start_eval(
    platform: tauri::webview::PlatformWebview,
    script: String,
    tx: tokio::sync::oneshot::Sender<Result<String, BrowserHostError>>,
) {
    #[cfg(target_os = "macos")]
    macos::start(platform, script, tx);
    #[cfg(target_os = "windows")]
    windows::start(platform, script, tx);
    #[cfg(target_os = "linux")]
    linux::start(platform, script, tx);
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = platform;
        let _ = script;
        let _ = tx.send(Err(BrowserHostError::new(
            "browser_unavailable",
            "native eval is not implemented on this OS",
        )));
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use block2::RcBlock;
    use objc2::{MainThreadMarker, rc::Retained, runtime::AnyObject};
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::{WKContentWorld, WKWebView};

    use super::*;

    pub fn start(
        platform: tauri::webview::PlatformWebview,
        script: String,
        tx: tokio::sync::oneshot::Sender<Result<String, BrowserHostError>>,
    ) {
        let tx = std::sync::Mutex::new(Some(tx));
        unsafe {
            let Some(webview) = Retained::<WKWebView>::retain(platform.inner().cast()) else {
                complete(
                    &tx,
                    Err(BrowserHostError::new(
                        "browser_read_failed",
                        "missing WKWebView",
                    )),
                );
                return;
            };
            let mtm = MainThreadMarker::new_unchecked();
            let world = WKContentWorld::worldWithName(&NSString::from_str("codeg"), mtm);
            let js = NSString::from_str(&script);
            let block = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                let result = if !error.is_null() {
                    let message = (*error).localizedDescription().to_string();
                    Err(BrowserHostError::new("browser_read_failed", message))
                } else {
                    Ok(js_value_to_string(value))
                };
                complete(&tx, result);
            });
            webview.evaluateJavaScript_inFrame_inContentWorld_completionHandler(
                &js,
                None,
                &world,
                Some(&block),
            );
        }
    }

    fn complete(
        tx: &std::sync::Mutex<
            Option<tokio::sync::oneshot::Sender<Result<String, BrowserHostError>>>,
        >,
        result: Result<String, BrowserHostError>,
    ) {
        if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(result);
        }
    }

    unsafe fn js_value_to_string(value: *mut AnyObject) -> String {
        if value.is_null() {
            return "null".into();
        }
        // SAFETY: completion handler only passes a live Objective-C object.
        let object = unsafe { &*value };
        if let Some(string) = object.downcast_ref::<NSString>() {
            return string.to_string();
        }
        let description: Retained<NSString> = unsafe { objc2::msg_send![object, description] };
        description.to_string()
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::sync::{Arc, Mutex};

    use ::windows::core::{HSTRING, Interface};
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

    use super::*;

    pub fn start(
        platform: tauri::webview::PlatformWebview,
        script: String,
        tx: tokio::sync::oneshot::Sender<Result<String, BrowserHostError>>,
    ) {
        let tx = Arc::new(Mutex::new(Some(tx)));
        let result = (|| {
            let controller = platform.controller();
            let webview = unsafe { controller.CoreWebView2() }
                .map_err(|error| BrowserHostError::new("browser_read_failed", error.to_string()))?;
            let tx = Arc::clone(&tx);
            let handler = webview2_com::ExecuteScriptCompletedHandler::create(Box::new(
                move |error_code, result| {
                    let payload = if error_code.is_ok() {
                        Ok(result.to_string())
                    } else {
                        Err(BrowserHostError::new(
                            "browser_read_failed",
                            format!("ExecuteScript failed: {error_code:?}"),
                        ))
                    };
                    if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                        let _ = tx.send(payload);
                    }
                    Ok(())
                },
            ));
            unsafe { webview.ExecuteScript(&HSTRING::from(script), &handler) }
                .map_err(|error| BrowserHostError::new("browser_read_failed", error.to_string()))?;
            Ok(())
        })();
        if let Err(error) = result {
            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = tx.send(Err(error));
            }
        }
        let _ = ICoreWebView2::IID;
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::sync::Mutex;

    use gtk::glib;
    use webkit2gtk::prelude::*;

    use super::*;

    pub fn start(
        platform: tauri::webview::PlatformWebview,
        script: String,
        tx: tokio::sync::oneshot::Sender<Result<String, BrowserHostError>>,
    ) {
        let tx = Mutex::new(Some(tx));
        let webview = platform.inner();
        webview.evaluate_javascript(
            &script,
            None,
            None,
            None::<&gio::Cancellable>,
            glib::clone!(
                #[strong]
                tx,
                move |result| {
                    let payload = match result {
                        Ok(value) => Ok(value.to_str().unwrap_or("null").to_owned()),
                        Err(error) => Err(BrowserHostError::new(
                            "browser_read_failed",
                            error.to_string(),
                        )),
                    };
                    if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                        let _ = tx.send(payload);
                    }
                }
            ),
        );
    }
}
