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

impl fmt::Display for BrowserTabId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BrowserProfile {
    Global,
    Workspace { workspace_id: String },
    Ephemeral,
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
    pub profile: BrowserProfile,
    pub surface: BrowserSurface,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BrowserIntent {
    Navigate { url: String },
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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserEngineEvent {
    NavigationStateChanged {
        tab_id: BrowserTabId,
        url: String,
        title: String,
        loading: bool,
        can_go_back: bool,
        can_go_forward: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BrowserEvent {
    TabCreated { tab: BrowserTab },
    TabUpdated { tab: BrowserTab },
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
        }
    }

    pub fn apply_engine_event(&self, event: BrowserEngineEvent) -> Result<(), BrowserError> {
        match event {
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
        }
    }
}
