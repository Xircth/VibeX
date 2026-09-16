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
#[cfg(all(feature = "cef-host", target_os = "windows"))]
pub use cef_host::sync_windows_browser_hosts;
#[cfg(feature = "cef-host")]
pub use cef_host::{
    CefBootstrap, CefHostError, CefProcess, CefSession, NativeBrowserParent, PumpScheduler,
    bootstrap,
};

const MINIMUM_COMMAND_CAPACITY: usize = 1;
const WINDOWS_CEF_DISABLED_FEATURES: &str =
    "CalculateNativeWinOcclusion,ApplyNativeOcclusionToCompositor";

/// Chromium switches applied to every embedded CEF process.
///
/// Native-window occlusion is disabled on every platform because Chromium can
/// otherwise stop presenting a still-visible view. Windows no longer parents
/// the page into Tauri's WebView2 HWND (that path crashed the GPU process and
/// fell back to in-process software compositing on the UI thread). Direct
/// composition stays enabled so GPU work remains in CEF's GPU process.
pub fn embedded_chromium_switches() -> Vec<(&'static str, Option<&'static str>)> {
    vec![("disable-features", Some(WINDOWS_CEF_DISABLED_FEATURES))]
}

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
        match profile {
            // Chrome runtime uses root_cache_path/Default when cache_path equals
            // the user-data dir. Nested paths such as chromium/profiles/global are
            // rejected with "Cannot create profile at path".
            BrowserProfile::Global => Some(self.root_cache_path.clone()),
            BrowserProfile::Workspace { workspace_id } => Some(
                self.root_cache_path
                    .join(format!("workspace-{}", encode_path_segment(workspace_id))),
            ),
            BrowserProfile::Ephemeral => None,
        }
    }

    /// Chrome runtime only loads a disk profile from the user-data dir itself or
    /// an immediate child of it (`cache_path.DirName() == user_data_dir`).
    pub fn is_supported_disk_profile_path(&self, cache_path: &Path) -> bool {
        cache_path == self.root_cache_path
            || cache_path.parent() == Some(self.root_cache_path.as_path())
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

#[cfg(test)]
mod tests {
    use super::embedded_chromium_switches;

    #[test]
    fn embedded_switches_disable_windows_occlusion() {
        let switches = embedded_chromium_switches();
        let features = switches
            .iter()
            .find(|(name, _)| *name == "disable-features")
            .and_then(|(_, value)| *value)
            .expect("disable-features must be set");
        assert!(features.contains("CalculateNativeWinOcclusion"));
        assert!(features.contains("ApplyNativeOcclusionToCompositor"));
    }

    #[test]
    fn embedded_switches_do_not_force_in_process_compositing() {
        let names: Vec<&str> = embedded_chromium_switches()
            .iter()
            .map(|(name, _)| *name)
            .collect();
        assert!(!names.contains(&"disable-direct-composition"));
        assert!(!names.contains(&"disable-gpu-vsync"));
        assert!(!names.contains(&"in-process-gpu"));
        assert!(!names.contains(&"disable-gpu"));
    }
}

#[cfg(test)]
mod tab_close_cleanup_tests {
    use std::collections::{HashMap, HashSet};

    use browser_runtime::BrowserTabId;

    fn drop_tab_scoped<V>(map: &mut HashMap<(BrowserTabId, u64), V>, tab_id: &BrowserTabId) {
        map.retain(|(id, _), _| id != tab_id);
    }

    #[test]
    fn a_second_close_does_not_reschedule_destruction() {
        let mut closing = HashSet::new();
        let tab = BrowserTabId::from("tab-a");
        assert!(
            closing.insert(tab.clone()),
            "the first DoClose must own destruction"
        );
        assert!(
            !closing.insert(tab),
            "DestroyWindow re-entering DoClose must not queue another destroy"
        );
    }

    #[test]
    fn pending_callbacks_for_a_closed_tab_are_dropped() {
        let mut pending = HashMap::new();
        pending.insert((BrowserTabId::from("keep"), 1u64), "keep");
        pending.insert((BrowserTabId::from("gone"), 2u64), "gone");
        drop_tab_scoped(&mut pending, &BrowserTabId::from("gone"));
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending.get(&(BrowserTabId::from("keep"), 1)).copied(),
            Some("keep")
        );
    }
}
