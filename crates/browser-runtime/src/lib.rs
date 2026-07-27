use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::broadcast;
use uuid::Uuid;

const EVENT_BUFFER_SIZE: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BrowserTabId(String);

impl BrowserTabId {
    fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

impl From<&str> for BrowserTabId {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl fmt::Display for BrowserTabId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BrowserProfile {
    Global,
    Workspace { workspace_id: String },
    Ephemeral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserPermissionKind {
    Media,
    Generic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserDownloadState {
    InProgress,
    Complete,
    Canceled,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSurface {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub visible: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBrowserTab {
    pub initial_url: String,
    pub profile: BrowserProfile,
    pub surface: BrowserSurface,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: BrowserTabId,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub zoom_level: f64,
    pub profile: BrowserProfile,
    pub surface: BrowserSurface,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BrowserIntent {
    Navigate {
        url: String,
    },
    Back,
    Forward,
    Reload,
    Stop,
    SetSurface {
        surface: BrowserSurface,
    },
    Focus,
    OpenDevTools,
    SetZoom {
        level: f64,
    },
    Find {
        query: String,
        forward: bool,
        match_case: bool,
        find_next: bool,
    },
    StopFinding,
    ResolvePermission {
        request_id: u64,
        allow: bool,
    },
    CancelDownload {
        download_id: u32,
    },
    ExecuteDevTools {
        request_id: u32,
        method: String,
        params: serde_json::Value,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum BrowserEngineCommand {
    Create {
        tab_id: BrowserTabId,
        initial_url: String,
        profile: BrowserProfile,
        surface: BrowserSurface,
    },
    Navigate {
        tab_id: BrowserTabId,
        url: String,
    },
    Back {
        tab_id: BrowserTabId,
    },
    Forward {
        tab_id: BrowserTabId,
    },
    Reload {
        tab_id: BrowserTabId,
    },
    Stop {
        tab_id: BrowserTabId,
    },
    SetSurface {
        tab_id: BrowserTabId,
        surface: BrowserSurface,
    },
    Close {
        tab_id: BrowserTabId,
    },
    Focus {
        tab_id: BrowserTabId,
    },
    OpenDevTools {
        tab_id: BrowserTabId,
    },
    SetZoom {
        tab_id: BrowserTabId,
        level: f64,
    },
    Find {
        tab_id: BrowserTabId,
        query: String,
        forward: bool,
        match_case: bool,
        find_next: bool,
    },
    StopFinding {
        tab_id: BrowserTabId,
    },
    ResolvePermission {
        tab_id: BrowserTabId,
        request_id: u64,
        allow: bool,
    },
    CancelDownload {
        tab_id: BrowserTabId,
        download_id: u32,
    },
    ExecuteDevTools {
        tab_id: BrowserTabId,
        request_id: u32,
        method: String,
        params: serde_json::Value,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserEngineEvent {
    PopupRequested {
        opener_tab_id: BrowserTabId,
        url: String,
    },
    PermissionRequested {
        tab_id: BrowserTabId,
        request_id: u64,
        origin: String,
        kind: BrowserPermissionKind,
        requested_permissions: u32,
    },
    DownloadUpdated {
        tab_id: BrowserTabId,
        download_id: u32,
        url: String,
        file_name: String,
        received_bytes: i64,
        total_bytes: i64,
        percent_complete: i32,
        state: BrowserDownloadState,
    },
    NavigationStateChanged {
        tab_id: BrowserTabId,
        url: String,
        title: String,
        loading: bool,
        can_go_back: bool,
        can_go_forward: bool,
    },
    Failed {
        tab_id: BrowserTabId,
        code: String,
        message: String,
    },
    DevToolsResult {
        tab_id: BrowserTabId,
        request_id: u32,
        success: bool,
        result: serde_json::Value,
    },
    DevToolsEvent {
        tab_id: BrowserTabId,
        method: String,
        params: serde_json::Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BrowserEvent {
    TabCreated {
        tab: BrowserTab,
    },
    TabUpdated {
        tab: BrowserTab,
    },
    TabClosed {
        tab_id: BrowserTabId,
    },
    PopupCreated {
        opener_tab_id: BrowserTabId,
        tab: BrowserTab,
    },
    PermissionRequested {
        tab_id: BrowserTabId,
        request_id: u64,
        origin: String,
        kind: BrowserPermissionKind,
        requested_permissions: u32,
    },
    DownloadUpdated {
        tab_id: BrowserTabId,
        download_id: u32,
        url: String,
        file_name: String,
        received_bytes: i64,
        total_bytes: i64,
        percent_complete: i32,
        state: BrowserDownloadState,
    },
    TabFailed {
        tab: BrowserTab,
        code: String,
        message: String,
    },
    DevToolsResult {
        tab_id: BrowserTabId,
        request_id: u32,
        success: bool,
        result: serde_json::Value,
    },
    DevToolsEvent {
        tab_id: BrowserTabId,
        method: String,
        params: serde_json::Value,
    },
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum BrowserError {
    #[error("browser engine rejected command: {0}")]
    Engine(String),
    #[error("browser runtime state is unavailable")]
    StateUnavailable,
    #[error("browser tab was not found: {0}")]
    TabNotFound(BrowserTabId),
}

pub trait BrowserEngine: Send + Sync + 'static {
    fn dispatch(&self, command: BrowserEngineCommand) -> Result<(), BrowserError>;
}

pub struct BrowserRuntime {
    engine: Arc<dyn BrowserEngine>,
    tabs: Mutex<HashMap<BrowserTabId, BrowserTab>>,
    events: broadcast::Sender<BrowserEvent>,
}

impl BrowserRuntime {
    pub fn new(engine: impl BrowserEngine) -> Self {
        let (events, _) = broadcast::channel(EVENT_BUFFER_SIZE);
        Self {
            engine: Arc::new(engine),
            tabs: Mutex::new(HashMap::new()),
            events,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BrowserEvent> {
        self.events.subscribe()
    }

    pub fn create_tab(&self, request: CreateBrowserTab) -> Result<BrowserTab, BrowserError> {
        let tab = BrowserTab {
            id: BrowserTabId::new(),
            url: request.initial_url,
            title: String::new(),
            loading: true,
            can_go_back: false,
            can_go_forward: false,
            zoom_level: 0.0,
            profile: request.profile,
            surface: request.surface,
        };

        self.engine.dispatch(BrowserEngineCommand::Create {
            tab_id: tab.id.clone(),
            initial_url: tab.url.clone(),
            profile: tab.profile.clone(),
            surface: tab.surface.clone(),
        })?;

        self.tabs
            .lock()
            .map_err(|_| BrowserError::StateUnavailable)?
            .insert(tab.id.clone(), tab.clone());
        let _ = self
            .events
            .send(BrowserEvent::TabCreated { tab: tab.clone() });

        Ok(tab)
    }

    pub fn apply(&self, tab_id: &BrowserTabId, intent: BrowserIntent) -> Result<(), BrowserError> {
        if !self
            .tabs
            .lock()
            .map_err(|_| BrowserError::StateUnavailable)?
            .contains_key(tab_id)
        {
            return Err(BrowserError::TabNotFound(tab_id.clone()));
        }

        match intent {
            BrowserIntent::Navigate { url } => {
                self.engine.dispatch(BrowserEngineCommand::Navigate {
                    tab_id: tab_id.clone(),
                    url,
                })
            }
            BrowserIntent::Back => self.engine.dispatch(BrowserEngineCommand::Back {
                tab_id: tab_id.clone(),
            }),
            BrowserIntent::Forward => self.engine.dispatch(BrowserEngineCommand::Forward {
                tab_id: tab_id.clone(),
            }),
            BrowserIntent::Reload => self.engine.dispatch(BrowserEngineCommand::Reload {
                tab_id: tab_id.clone(),
            }),
            BrowserIntent::Stop => self.engine.dispatch(BrowserEngineCommand::Stop {
                tab_id: tab_id.clone(),
            }),
            BrowserIntent::SetSurface { surface } => {
                self.engine.dispatch(BrowserEngineCommand::SetSurface {
                    tab_id: tab_id.clone(),
                    surface: surface.clone(),
                })?;
                let tab = {
                    let mut tabs = self
                        .tabs
                        .lock()
                        .map_err(|_| BrowserError::StateUnavailable)?;
                    let tab = tabs
                        .get_mut(tab_id)
                        .ok_or_else(|| BrowserError::TabNotFound(tab_id.clone()))?;
                    tab.surface = surface;
                    tab.clone()
                };
                let _ = self.events.send(BrowserEvent::TabUpdated { tab });
                Ok(())
            }
            BrowserIntent::Focus => self.engine.dispatch(BrowserEngineCommand::Focus {
                tab_id: tab_id.clone(),
            }),
            BrowserIntent::OpenDevTools => {
                self.engine.dispatch(BrowserEngineCommand::OpenDevTools {
                    tab_id: tab_id.clone(),
                })
            }
            BrowserIntent::SetZoom { level } => {
                self.engine.dispatch(BrowserEngineCommand::SetZoom {
                    tab_id: tab_id.clone(),
                    level,
                })?;
                let tab = {
                    let mut tabs = self
                        .tabs
                        .lock()
                        .map_err(|_| BrowserError::StateUnavailable)?;
                    let tab = tabs
                        .get_mut(tab_id)
                        .ok_or_else(|| BrowserError::TabNotFound(tab_id.clone()))?;
                    tab.zoom_level = level;
                    tab.clone()
                };
                let _ = self.events.send(BrowserEvent::TabUpdated { tab });
                Ok(())
            }
            BrowserIntent::Find {
                query,
                forward,
                match_case,
                find_next,
            } => self.engine.dispatch(BrowserEngineCommand::Find {
                tab_id: tab_id.clone(),
                query,
                forward,
                match_case,
                find_next,
            }),
            BrowserIntent::StopFinding => self.engine.dispatch(BrowserEngineCommand::StopFinding {
                tab_id: tab_id.clone(),
            }),
            BrowserIntent::ResolvePermission { request_id, allow } => {
                self.engine
                    .dispatch(BrowserEngineCommand::ResolvePermission {
                        tab_id: tab_id.clone(),
                        request_id,
                        allow,
                    })
            }
            BrowserIntent::CancelDownload { download_id } => {
                self.engine.dispatch(BrowserEngineCommand::CancelDownload {
                    tab_id: tab_id.clone(),
                    download_id,
                })
            }
            BrowserIntent::ExecuteDevTools {
                request_id,
                method,
                params,
            } => self.engine.dispatch(BrowserEngineCommand::ExecuteDevTools {
                tab_id: tab_id.clone(),
                request_id,
                method,
                params,
            }),
        }
    }

    pub fn apply_engine_event(&self, event: BrowserEngineEvent) -> Result<(), BrowserError> {
        match event {
            BrowserEngineEvent::PopupRequested { opener_tab_id, url } => {
                let opener = self
                    .tab(&opener_tab_id)?
                    .ok_or_else(|| BrowserError::TabNotFound(opener_tab_id.clone()))?;
                let mut surface = opener.surface;
                surface.visible = false;
                let tab = BrowserTab {
                    id: BrowserTabId::new(),
                    url,
                    title: String::new(),
                    loading: true,
                    can_go_back: false,
                    can_go_forward: false,
                    zoom_level: opener.zoom_level,
                    profile: opener.profile,
                    surface,
                };
                self.engine.dispatch(BrowserEngineCommand::Create {
                    tab_id: tab.id.clone(),
                    initial_url: tab.url.clone(),
                    profile: tab.profile.clone(),
                    surface: tab.surface.clone(),
                })?;
                self.tabs
                    .lock()
                    .map_err(|_| BrowserError::StateUnavailable)?
                    .insert(tab.id.clone(), tab.clone());
                let _ = self
                    .events
                    .send(BrowserEvent::PopupCreated { opener_tab_id, tab });
                Ok(())
            }
            BrowserEngineEvent::PermissionRequested {
                tab_id,
                request_id,
                origin,
                kind,
                requested_permissions,
            } => {
                if self.tab(&tab_id)?.is_none() {
                    return Err(BrowserError::TabNotFound(tab_id));
                }
                let _ = self.events.send(BrowserEvent::PermissionRequested {
                    tab_id,
                    request_id,
                    origin,
                    kind,
                    requested_permissions,
                });
                Ok(())
            }
            BrowserEngineEvent::DownloadUpdated {
                tab_id,
                download_id,
                url,
                file_name,
                received_bytes,
                total_bytes,
                percent_complete,
                state,
            } => {
                if self.tab(&tab_id)?.is_none() {
                    return Err(BrowserError::TabNotFound(tab_id));
                }
                let _ = self.events.send(BrowserEvent::DownloadUpdated {
                    tab_id,
                    download_id,
                    url,
                    file_name,
                    received_bytes,
                    total_bytes,
                    percent_complete,
                    state,
                });
                Ok(())
            }
            BrowserEngineEvent::NavigationStateChanged {
                tab_id,
                url,
                title,
                loading,
                can_go_back,
                can_go_forward,
            } => {
                let tab = {
                    let mut tabs = self
                        .tabs
                        .lock()
                        .map_err(|_| BrowserError::StateUnavailable)?;
                    let tab = tabs
                        .get_mut(&tab_id)
                        .ok_or_else(|| BrowserError::TabNotFound(tab_id.clone()))?;
                    tab.url = url;
                    tab.title = title;
                    tab.loading = loading;
                    tab.can_go_back = can_go_back;
                    tab.can_go_forward = can_go_forward;
                    tab.clone()
                };
                let _ = self.events.send(BrowserEvent::TabUpdated { tab });
                Ok(())
            }
            BrowserEngineEvent::Failed {
                tab_id,
                code,
                message,
            } => {
                let tab = {
                    let mut tabs = self
                        .tabs
                        .lock()
                        .map_err(|_| BrowserError::StateUnavailable)?;
                    let tab = tabs
                        .get_mut(&tab_id)
                        .ok_or_else(|| BrowserError::TabNotFound(tab_id.clone()))?;
                    tab.loading = false;
                    tab.clone()
                };
                let _ = self
                    .events
                    .send(BrowserEvent::TabFailed { tab, code, message });
                Ok(())
            }
            BrowserEngineEvent::DevToolsResult {
                tab_id,
                request_id,
                success,
                result,
            } => {
                if self.tab(&tab_id)?.is_none() {
                    return Err(BrowserError::TabNotFound(tab_id));
                }
                let _ = self.events.send(BrowserEvent::DevToolsResult {
                    tab_id,
                    request_id,
                    success,
                    result,
                });
                Ok(())
            }
            BrowserEngineEvent::DevToolsEvent {
                tab_id,
                method,
                params,
            } => {
                if self.tab(&tab_id)?.is_none() {
                    return Err(BrowserError::TabNotFound(tab_id));
                }
                let _ = self.events.send(BrowserEvent::DevToolsEvent {
                    tab_id,
                    method,
                    params,
                });
                Ok(())
            }
        }
    }

    pub fn tab(&self, tab_id: &BrowserTabId) -> Result<Option<BrowserTab>, BrowserError> {
        Ok(self
            .tabs
            .lock()
            .map_err(|_| BrowserError::StateUnavailable)?
            .get(tab_id)
            .cloned())
    }

    pub fn close_tab(&self, tab_id: &BrowserTabId) -> Result<(), BrowserError> {
        if self.tab(tab_id)?.is_none() {
            return Err(BrowserError::TabNotFound(tab_id.clone()));
        }
        self.engine.dispatch(BrowserEngineCommand::Close {
            tab_id: tab_id.clone(),
        })?;
        self.tabs
            .lock()
            .map_err(|_| BrowserError::StateUnavailable)?
            .remove(tab_id);
        let _ = self.events.send(BrowserEvent::TabClosed {
            tab_id: tab_id.clone(),
        });
        Ok(())
    }
}
