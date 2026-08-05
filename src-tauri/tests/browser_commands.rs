use browser_runtime::{
    BrowserEngine, BrowserEngineCommand, BrowserError, BrowserProfile, BrowserRuntime,
    BrowserSurface, CreateBrowserTab,
};
use vibex::commands::browser;

struct RejectingEngine;

impl BrowserEngine for RejectingEngine {
    fn dispatch(&self, _command: BrowserEngineCommand) -> Result<(), BrowserError> {
        Err(BrowserError::Engine("CEF host did not start".to_string()))
    }
}

#[test]
fn command_adapter_returns_a_stable_error_code_when_cef_rejects_creation() {
    let runtime = BrowserRuntime::new(RejectingEngine);

    let error = browser::create_tab(
        &runtime,
        CreateBrowserTab {
            initial_url: "https://example.com".to_string(),
            profile: BrowserProfile::Global,
            surface: BrowserSurface {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                scale_factor: 1.0,
                visible: true,
            },
        },
    )
    .expect_err("CEF rejection should cross the command boundary");

    assert_eq!(error.code, "browser_engine_error");
    assert_eq!(
        error.message,
        "browser engine rejected command: CEF host did not start"
    );
}

#[test]
fn unavailable_cef_runtime_reports_the_initialization_error() {
    let runtime = browser::unavailable_runtime(
        "CEF child windows require an X11/XWayland parent".to_string(),
    );

    let error = browser::create_tab(
        &runtime,
        CreateBrowserTab {
            initial_url: "https://example.com".to_string(),
            profile: BrowserProfile::Global,
            surface: BrowserSurface {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                scale_factor: 1.0,
                visible: true,
            },
        },
    )
    .expect_err("an unavailable CEF runtime must reject browser creation");

    assert_eq!(error.code, "browser_engine_error");
    assert_eq!(
        error.message,
        "browser engine rejected command: CEF child windows require an X11/XWayland parent"
    );
}
