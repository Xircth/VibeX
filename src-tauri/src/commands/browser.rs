use std::sync::Arc;

use browser_runtime::{
    BrowserEngine, BrowserEngineCommand, BrowserError, BrowserIntent, BrowserRuntime, BrowserTab,
    BrowserTabId, CreateBrowserTab,
};
use serde::Serialize;

#[derive(Clone)]
pub struct BrowserCommandState {
    pub runtime: Arc<BrowserRuntime>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCommandError {
    pub code: &'static str,
    pub message: String,
}

struct UnavailableBrowserEngine {
    message: String,
}

impl BrowserEngine for UnavailableBrowserEngine {
    fn dispatch(&self, _command: BrowserEngineCommand) -> Result<(), BrowserError> {
        Err(BrowserError::Engine(self.message.clone()))
    }
}

pub fn unavailable_runtime(message: String) -> BrowserRuntime {
    BrowserRuntime::new(UnavailableBrowserEngine { message })
}

impl From<BrowserError> for BrowserCommandError {
    fn from(error: BrowserError) -> Self {
        let code = match error {
            BrowserError::Engine(_) => "browser_engine_error",
            BrowserError::StateUnavailable => "browser_state_unavailable",
            BrowserError::TabNotFound(_) => "browser_tab_not_found",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

pub fn create_tab(
    runtime: &BrowserRuntime,
    request: CreateBrowserTab,
) -> Result<BrowserTab, BrowserCommandError> {
    runtime.create_tab(request).map_err(Into::into)
}

#[tauri::command]
pub async fn browser_create_tab(
    state: tauri::State<'_, BrowserCommandState>,
    request: CreateBrowserTab,
) -> Result<BrowserTab, BrowserCommandError> {
    create_tab(&state.runtime, request)
}

#[tauri::command]
pub async fn browser_apply_intent(
    state: tauri::State<'_, BrowserCommandState>,
    tab_id: BrowserTabId,
    intent: BrowserIntent,
) -> Result<(), BrowserCommandError> {
    state.runtime.apply(&tab_id, intent).map_err(Into::into)
}

#[tauri::command]
pub async fn browser_close_tab(
    state: tauri::State<'_, BrowserCommandState>,
    tab_id: BrowserTabId,
) -> Result<(), BrowserCommandError> {
    state.runtime.close_tab(&tab_id).map_err(Into::into)
}

#[tauri::command]
pub async fn browser_get_tab(
    state: tauri::State<'_, BrowserCommandState>,
    tab_id: BrowserTabId,
) -> Result<Option<BrowserTab>, BrowserCommandError> {
    state.runtime.tab(&tab_id).map_err(Into::into)
}
