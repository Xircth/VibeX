use std::{
    fmt::Write as _,
    path::{Path, PathBuf},
    sync::{
        Arc,
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
};

use browser_runtime::{BrowserEngine, BrowserEngineCommand, BrowserError, BrowserProfile};

#[cfg(feature = "cef-host")]
mod cef_host;
#[cfg(feature = "cef-host")]
pub use cef_host::{
    CefBootstrap, CefHostError, CefProcess, CefSession, NativeBrowserParent, PumpScheduler,
    bootstrap,
};

const MINIMUM_COMMAND_CAPACITY: usize = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CefRuntimeConfig {
    root_cache_path: PathBuf,
    runtime_resources_path: Option<PathBuf>,
}

impl CefRuntimeConfig {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            root_cache_path: app_data_dir.join("chromium"),
            runtime_resources_path: None,
        }
    }

    pub fn with_runtime_resources(mut self, path: PathBuf) -> Self {
        self.runtime_resources_path = Some(path);
        self
    }

    pub fn root_cache_path(&self) -> &Path {
        &self.root_cache_path
    }

    pub fn runtime_resources_path(&self) -> Option<&Path> {
        self.runtime_resources_path.as_deref()
    }

    pub fn runtime_locales_path(&self) -> Option<PathBuf> {
        self.runtime_resources_path
            .as_ref()
            .map(|path| path.join("locales"))
    }

    pub fn profile_cache_path(&self, profile: &BrowserProfile) -> Option<PathBuf> {
        let profile_name = match profile {
            BrowserProfile::Global => "global".to_string(),
            BrowserProfile::Workspace { workspace_id } => {
                format!("workspace-{}", encode_path_segment(workspace_id))
            }
            BrowserProfile::Ephemeral => return None,
        };
        Some(self.root_cache_path.join("profiles").join(profile_name))
    }
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') {
            encoded.push(char::from(byte));
        } else {
            write!(&mut encoded, "_{byte:02x}").expect("writing to a String cannot fail");
        }
    }
    if encoded.is_empty() {
        encoded.push_str("_empty");
    }
    encoded
}

#[derive(Clone)]
pub struct CefEngineHandle {
    commands: SyncSender<BrowserEngineCommand>,
    wake: Arc<dyn Fn() + Send + Sync + 'static>,
}

pub fn command_channel(capacity: usize) -> (CefEngineHandle, Receiver<BrowserEngineCommand>) {
    command_channel_with_waker(capacity, Arc::new(|| {}))
}

pub fn command_channel_with_waker(
    capacity: usize,
    wake: Arc<dyn Fn() + Send + Sync + 'static>,
) -> (CefEngineHandle, Receiver<BrowserEngineCommand>) {
    let (commands, receiver) = mpsc::sync_channel(capacity.max(MINIMUM_COMMAND_CAPACITY));
    (CefEngineHandle { commands, wake }, receiver)
}

impl BrowserEngine for CefEngineHandle {
    fn dispatch(&self, command: BrowserEngineCommand) -> Result<(), BrowserError> {
        self.commands.try_send(command).map_err(|error| {
            let message = match error {
                TrySendError::Full(_) => "CEF command queue is full",
                TrySendError::Disconnected(_) => "CEF browser host is unavailable",
            };
            BrowserError::Engine(message.to_string())
        })?;
        (self.wake)();
        Ok(())
    }
}
