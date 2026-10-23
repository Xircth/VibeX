//! Daemon state, settings persistence, global stop hotkey registration, and JSON-RPC handlers
//! built directly on top of `commands::computer::ComputerService`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::acp::computer_tools::{ComputerToolsConfig, ComputerToolsRuntimeConfig};
use crate::commands::computer::{
    computer_driver_info_core, computer_driver_install_core, computer_driver_uninstall_core,
    computer_list_shareable_windows_core, computer_request_permission_core,
    computer_revoke_all_core, computer_share_app_core, computer_share_screen_core,
    computer_share_window_core, computer_share_windows_core, computer_shared_state_core,
    computer_status_core, computer_stop_core, computer_window_thumbnail_core,
    permission_settings_url, ComputerHost, ComputerService,
};
use crate::compat::event_bridge::{EventEmitter, WebEventBroadcaster};
use crate::computer::agent::{ComputerActivityPayload, GrantLevel, DEFAULT_BLOCKLIST};
use crate::computer::keys::Platform;
use crate::computer::protocol::OsPermission;
use crate::computer::stop_shortcut::{StopKeyStatus, StopShortcut};
use crate::computer::types::ActDelivery;
use crate::mcp_dispatch;

const DEFAULT_GRANT_TIMEOUT_SECS: u64 = 1800;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedPreferences {
    #[serde(default = "default_false")]
    enabled: bool,
    #[serde(default = "default_grant_timeout_secs")]
    grant_timeout_secs: u64,
    #[serde(default = "default_stop_shortcut")]
    stop_shortcut: String,
    #[serde(default = "default_true")]
    allow_foreground: bool,
    #[serde(default = "default_delivery_str")]
    default_delivery: String,
    #[serde(default)]
    blocklist_unblocked: Vec<String>,
    #[serde(default)]
    blocklist_custom: Vec<String>,
    #[serde(default = "default_false")]
    launch_enabled: bool,
    #[serde(default = "default_false")]
    clipboard_enabled: bool,
    #[serde(default = "default_false")]
    screen_enabled: bool,
    #[serde(default = "default_true")]
    show_indicator: bool,
}

fn default_false() -> bool {
    false
}
fn default_true() -> bool {
    true
}
fn default_grant_timeout_secs() -> u64 {
    DEFAULT_GRANT_TIMEOUT_SECS
}
fn default_stop_shortcut() -> String {
    StopShortcut::default_for(Platform::current()).to_string()
}
fn default_delivery_str() -> String {
    "background".to_string()
}

impl Default for PersistedPreferences {
    fn default() -> Self {
        Self {
            enabled: false,
            grant_timeout_secs: DEFAULT_GRANT_TIMEOUT_SECS,
            stop_shortcut: default_stop_shortcut(),
            allow_foreground: true,
            default_delivery: "background".to_string(),
            blocklist_unblocked: Vec::new(),
            blocklist_custom: Vec::new(),
            launch_enabled: false,
            clipboard_enabled: false,
            screen_enabled: false,
            show_indicator: true,
        }
    }
}

impl PersistedPreferences {
    fn to_runtime_config(&self) -> ComputerToolsConfig {
        let platform = Platform::current();
        ComputerToolsConfig {
            enabled: self.enabled,
            grant_ttl: (self.grant_timeout_secs > 0)
                .then(|| Duration::from_secs(self.grant_timeout_secs)),
            blocklist: self.blocklist_custom.clone(),
            blocklist_removed: self.blocklist_unblocked.clone(),
            stop_shortcut: StopShortcut::from_setting(&self.stop_shortcut, platform),
            show_indicator: self.show_indicator,
            allow_foreground: self.allow_foreground,
            default_delivery: if self.default_delivery == "foreground" {
                ActDelivery::Foreground
            } else {
                ActDelivery::Background
            },
            launch_enabled: self.launch_enabled,
            clipboard_enabled: self.clipboard_enabled,
            screen_enabled: self.screen_enabled,
            switched_off: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerToolsSettings {
    pub enabled: bool,
    pub env_override: Option<bool>,
    pub grant_timeout_secs: u64,
    pub stop_shortcut: String,
    pub default_stop_shortcut: String,
    pub allow_foreground: bool,
    pub default_delivery: ActDelivery,
    pub default_blocklist: Vec<DefaultBlockEntry>,
    pub custom_blocklist: Vec<String>,
    pub launch_enabled: bool,
    pub clipboard_enabled: bool,
    pub screen_enabled: bool,
    pub show_indicator: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultBlockEntry {
    pub key: &'static str,
    pub name: &'static str,
    pub blocked: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPreferencesArgs {
    pub grant_timeout_secs: Option<u64>,
    pub stop_shortcut: Option<String>,
    pub allow_foreground: Option<bool>,
    pub default_delivery: Option<ActDelivery>,
    pub unblocked_defaults: Option<Vec<String>>,
    pub custom_blocklist: Option<Vec<String>>,
    pub launch_enabled: Option<bool>,
    pub clipboard_enabled: Option<bool>,
    pub screen_enabled: Option<bool>,
    pub show_indicator: Option<bool>,
}

/// Global OS hotkey manager for the Stop shortcut on Windows (using `RegisterHotKey` on a
/// dedicated Win32 message thread) and graceful fallback elsewhere.
pub struct GlobalStopHotkey {
    inner: Mutex<StopKeyInner>,
}

struct StopKeyInner {
    held: Option<StopShortcut>,
    status: StopKeyStatus,
    #[cfg(windows)]
    worker_tx: Option<std::sync::mpsc::SyncSender<WinHotkeyCmd>>,
}

#[cfg(windows)]
enum WinHotkeyCmd {
    Register(
        u32,
        u32,
        Arc<dyn Fn() + Send + Sync + 'static>,
        std::sync::mpsc::SyncSender<Result<(), String>>,
    ),
    Unregister(std::sync::mpsc::SyncSender<()>),
}

impl Default for GlobalStopHotkey {
    fn default() -> Self {
        Self::new()
    }
}

impl GlobalStopHotkey {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(StopKeyInner {
                held: None,
                status: StopKeyStatus::default(),
                #[cfg(windows)]
                worker_tx: None,
            }),
        }
    }

    pub fn status(&self) -> StopKeyStatus {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .status
            .clone()
    }

    pub fn sync(
        &self,
        wanted: Option<&StopShortcut>,
        on_press: Arc<dyn Fn() + Send + Sync + 'static>,
    ) -> Option<StopKeyStatus> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if inner.status.failed.is_none() && inner.held.as_ref() == wanted {
            return None;
        }
        #[cfg(windows)]
        {
            let tx = inner
                .worker_tx
                .get_or_insert_with(spawn_windows_hotkey_thread)
                .clone();
            if inner.held.take().is_some() {
                let (ack_tx, ack_rx) = std::sync::mpsc::sync_channel(1);
                let _ = tx.send(WinHotkeyCmd::Unregister(ack_tx));
                let _ = ack_rx.recv_timeout(Duration::from_secs(2));
            }
            let mut status = StopKeyStatus::default();
            if let Some(shortcut) = wanted {
                match win32_hotkey_mods_and_vk(shortcut) {
                    Some((mods, vk)) => {
                        let (ack_tx, ack_rx) = std::sync::mpsc::sync_channel(1);
                        let _ = tx.send(WinHotkeyCmd::Register(mods, vk, on_press, ack_tx));
                        match ack_rx.recv_timeout(Duration::from_secs(2)) {
                            Ok(Ok(())) => {
                                inner.held = Some(shortcut.clone());
                                status.active = Some(shortcut.to_string());
                            }
                            Ok(Err(detail)) => {
                                status.failed = Some(shortcut.to_string());
                                status.detail = Some(detail);
                            }
                            Err(_) => {
                                status.failed = Some(shortcut.to_string());
                                status.detail =
                                    Some("hotkey thread did not respond in time".to_string());
                            }
                        }
                    }
                    None => {
                        status.failed = Some(shortcut.to_string());
                        status.detail = Some("not a key the stop shortcut can be on".to_string());
                    }
                }
            }
            if inner.status == status {
                return None;
            }
            inner.status = status.clone();
            Some(status)
        }
        #[cfg(not(windows))]
        {
            let _ = on_press;
            let mut status = StopKeyStatus::default();
            if let Some(shortcut) = wanted {
                inner.held = Some(shortcut.clone());
                status.active = Some(shortcut.to_string());
            } else {
                inner.held = None;
            }
            if inner.status == status {
                return None;
            }
            inner.status = status.clone();
            Some(status)
        }
    }
}

#[cfg(windows)]
fn win32_hotkey_mods_and_vk(shortcut: &StopShortcut) -> Option<(u32, u32)> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
    };
    let mut mods = MOD_NOREPEAT;
    if shortcut.modifiers.control {
        mods |= MOD_CONTROL;
    }
    if shortcut.modifiers.alt {
        mods |= MOD_ALT;
    }
    if shortcut.modifiers.shift {
        mods |= MOD_SHIFT;
    }
    if shortcut.modifiers.command {
        mods |= MOD_WIN;
    }
    let code = shortcut.code.as_str();
    let vk: u32 = if let Some(letter) = code.strip_prefix("Key") {
        let ch = letter.chars().next()?;
        if !ch.is_ascii_uppercase() || letter.len() != 1 {
            return None;
        }
        ch as u32
    } else if let Some(digit) = code.strip_prefix("Digit") {
        let ch = digit.chars().next()?;
        if !ch.is_ascii_digit() || digit.len() != 1 {
            return None;
        }
        ch as u32
    } else if let Some(fnum) = code.strip_prefix('F') {
        let n = fnum.parse::<u32>().ok()?;
        if !(1..=12).contains(&n) {
            return None;
        }
        0x70 + (n - 1)
    } else {
        match code {
            "Escape" => 0x1B,
            "Minus" => 0xBD,
            "Equal" => 0xBB,
            "BracketLeft" => 0xDB,
            "BracketRight" => 0xDD,
            "Backslash" => 0xDC,
            "Semicolon" => 0xBA,
            "Quote" => 0xDE,
            "Backquote" => 0xC0,
            "Comma" => 0xBC,
            "Period" => 0xBE,
            "Slash" => 0xBF,
            _ => return None,
        }
    };
    Some((mods, vk))
}

#[cfg(windows)]
fn spawn_windows_hotkey_thread() -> std::sync::mpsc::SyncSender<WinHotkeyCmd> {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_HOTKEY, WM_USER,
    };

    const HOTKEY_ID: i32 = 0x4355;
    const WM_CMD: u32 = WM_USER + 42;

    let (cmd_tx, cmd_rx) = std::sync::mpsc::sync_channel::<WinHotkeyCmd>(16);
    let (tid_tx, tid_rx) = std::sync::mpsc::sync_channel::<u32>(1);

    std::thread::Builder::new()
        .name("computer-stop-hotkey".into())
        .spawn(move || unsafe {
            let mut msg: MSG = std::mem::zeroed();
            PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
            let tid = GetCurrentThreadId();
            let _ = tid_tx.send(tid);

            let mut callback: Option<Arc<dyn Fn() + Send + Sync + 'static>> = None;
            let mut registered = false;

            loop {
                let ret = GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0);
                if ret <= 0 {
                    break;
                }
                if msg.message == WM_HOTKEY && msg.wParam as i32 == HOTKEY_ID {
                    if let Some(cb) = &callback {
                        let cb = cb.clone();
                        std::thread::spawn(move || cb());
                    }
                } else if msg.message == WM_CMD {
                    while let Ok(cmd) = cmd_rx.try_recv() {
                        match cmd {
                            WinHotkeyCmd::Register(mods, vk, cb, ack) => {
                                if registered {
                                    let _ = UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
                                    registered = false;
                                }
                                if RegisterHotKey(std::ptr::null_mut(), HOTKEY_ID, mods, vk) != 0 {
                                    registered = true;
                                    callback = Some(cb);
                                    let _ = ack.send(Ok(()));
                                } else {
                                    let err = GetLastError();
                                    let detail = if err == 1409 {
                                        "Another application is already using this shortcut (OS error 1409)".to_string()
                                    } else {
                                        format!("OS error {err}")
                                    };
                                    let _ = ack.send(Err(detail));
                                }
                            }
                            WinHotkeyCmd::Unregister(ack) => {
                                if registered {
                                    let _ = UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
                                    registered = false;
                                }
                                callback = None;
                                let _ = ack.send(());
                            }
                        }
                    }
                }
            }
        })
        .expect("spawn hotkey thread");

    let tid = tid_rx.recv().unwrap_or(0);
    let (proxy_tx, proxy_rx) = std::sync::mpsc::sync_channel::<WinHotkeyCmd>(16);
    std::thread::Builder::new()
        .name("computer-stop-hotkey-proxy".into())
        .spawn(move || {
            while let Ok(cmd) = proxy_rx.recv() {
                let _ = cmd_tx.send(cmd);
                if tid != 0 {
                    unsafe {
                        let _ = PostThreadMessageW(tid, WM_CMD, 0, 0);
                    }
                }
            }
        })
        .expect("spawn hotkey proxy");

    proxy_tx
}

pub struct DaemonState {
    settings_path: PathBuf,
    prefs: Mutex<PersistedPreferences>,
    pub runtime_config: ComputerToolsRuntimeConfig,
    pub computer: Arc<ComputerService>,
    pub broadcaster: Arc<WebEventBroadcaster>,
    pub stop_key: Arc<GlobalStopHotkey>,
}

impl DaemonState {
    pub async fn new(data_dir: &Path) -> Arc<Self> {
        let _ = std::fs::create_dir_all(data_dir);
        let settings_path = data_dir.join("settings.json");
        let prefs: PersistedPreferences = std::fs::read_to_string(&settings_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let runtime_config = ComputerToolsRuntimeConfig::new();
        runtime_config.set(prefs.to_runtime_config()).await;

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let host = ComputerHost::Server {
            broadcaster: broadcaster.clone(),
            emitter: EventEmitter::Web(broadcaster.clone()),
        };
        let computer = ComputerService::start(host, runtime_config.clone());

        let state = Arc::new(Self {
            settings_path,
            prefs: Mutex::new(prefs),
            runtime_config,
            computer,
            broadcaster,
            stop_key: Arc::new(GlobalStopHotkey::new()),
        });

        state.sync_stop_shortcut().await;
        state
    }

    fn save_prefs(&self, prefs: &PersistedPreferences) {
        if let Ok(json) = serde_json::to_string_pretty(prefs) {
            let _ = std::fs::write(&self.settings_path, json);
        }
    }

    pub async fn sync_stop_shortcut(self: &Arc<Self>) {
        let snap = self.runtime_config.snapshot().await;
        let wanted = snap.enabled.then_some(snap.stop_shortcut).flatten();
        let state_weak = Arc::downgrade(self);
        let handle = tokio::runtime::Handle::current();
        let on_press = Arc::new(move || {
            if let Some(st) = state_weak.upgrade() {
                let computer = st.computer.clone();
                handle.spawn(async move {
                    computer.stop().await;
                });
            }
        });
        if let Some(status) = self.stop_key.sync(wanted.as_ref(), on_press) {
            self.computer.events().stop_key(&status);
        }
    }

    pub async fn get_settings(&self) -> ComputerToolsSettings {
        let snap = self.runtime_config.snapshot().await;
        let platform = Platform::current();
        let default_blocklist = DEFAULT_BLOCKLIST
            .iter()
            .map(|entry| DefaultBlockEntry {
                key: entry.key,
                name: entry.name,
                blocked: !snap.blocklist_removed.iter().any(|k| k == entry.key),
            })
            .collect();
        ComputerToolsSettings {
            enabled: snap.enabled,
            env_override: None,
            grant_timeout_secs: snap.grant_ttl.map_or(0, |d: Duration| d.as_secs()),
            stop_shortcut: snap
                .stop_shortcut
                .map(|s: StopShortcut| s.to_string())
                .unwrap_or_default(),
            default_stop_shortcut: StopShortcut::default_for(platform).to_string(),
            allow_foreground: snap.allow_foreground,
            default_delivery: snap.default_delivery,
            default_blocklist,
            custom_blocklist: snap.blocklist,
            launch_enabled: snap.launch_enabled,
            clipboard_enabled: snap.clipboard_enabled,
            screen_enabled: snap.screen_enabled,
            show_indicator: snap.show_indicator,
        }
    }

    pub async fn set_enabled(
        self: &Arc<Self>,
        enabled: bool,
    ) -> Result<ComputerToolsSettings, String> {
        let next_cfg = {
            let mut prefs = self.prefs.lock().unwrap_or_else(|p| p.into_inner());
            prefs.enabled = enabled;
            self.save_prefs(&prefs);
            prefs.to_runtime_config()
        };
        self.runtime_config.set(next_cfg).await;
        self.sync_stop_shortcut().await;
        Ok(self.get_settings().await)
    }

    pub async fn set_preferences(
        self: &Arc<Self>,
        args: SetPreferencesArgs,
    ) -> Result<ComputerToolsSettings, String> {
        let platform = Platform::current();
        const MAX_TIMEOUT_SECS: u64 = 86_400;
        const MAX_BLOCKLIST_ENTRIES: usize = 256;
        const MAX_ENTRY_LEN: usize = 512;

        if let Some(secs) = args.grant_timeout_secs {
            if secs > MAX_TIMEOUT_SECS {
                return Err(format!(
                    "grantTimeoutSecs exceeds maximum ({MAX_TIMEOUT_SECS})"
                ));
            }
        }
        let parsed_shortcut = match args.stop_shortcut.as_deref().map(str::trim) {
            None => None,
            Some("") => Some(String::new()),
            Some(spelling) => {
                let normalized = normalize_shortcut_spelling(spelling);
                let s = StopShortcut::parse(&normalized, platform).map_err(|e| e.to_string())?;
                Some(s.to_string())
            }
        };

        let next_unblocked = args.unblocked_defaults.map(|keys| {
            DEFAULT_BLOCKLIST
                .iter()
                .filter(|d| keys.iter().any(|k| k == d.key))
                .map(|d| d.key.to_string())
                .collect::<Vec<_>>()
        });

        let next_custom = match args.custom_blocklist {
            None => None,
            Some(entries) => {
                if entries.len() > MAX_BLOCKLIST_ENTRIES {
                    return Err(format!(
                        "customBlocklist may hold at most {MAX_BLOCKLIST_ENTRIES} entries"
                    ));
                }
                let mut cleaned: Vec<String> = Vec::with_capacity(entries.len());
                for raw in entries {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if trimmed.len() > MAX_ENTRY_LEN {
                        return Err(format!(
                            "blocklist entry is longer than {MAX_ENTRY_LEN} characters"
                        ));
                    }
                    if !cleaned.iter().any(|c| c.eq_ignore_ascii_case(trimmed)) {
                        cleaned.push(trimmed.to_string());
                    }
                }
                Some(cleaned)
            }
        };

        let next_cfg = {
            let mut prefs = self.prefs.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(secs) = args.grant_timeout_secs {
                prefs.grant_timeout_secs = secs;
            }
            if let Some(shortcut) = parsed_shortcut {
                prefs.stop_shortcut = shortcut;
            }
            if let Some(allow) = args.allow_foreground {
                prefs.allow_foreground = allow;
            }
            if let Some(delivery) = args.default_delivery {
                prefs.default_delivery = match delivery {
                    ActDelivery::Foreground => "foreground".to_string(),
                    ActDelivery::Background => "background".to_string(),
                };
            }
            if let Some(unblocked) = next_unblocked {
                prefs.blocklist_unblocked = unblocked;
            }
            if let Some(custom) = next_custom {
                prefs.blocklist_custom = custom;
            }
            if let Some(launch) = args.launch_enabled {
                prefs.launch_enabled = launch;
            }
            if let Some(clipboard) = args.clipboard_enabled {
                prefs.clipboard_enabled = clipboard;
            }
            if let Some(screen) = args.screen_enabled {
                prefs.screen_enabled = screen;
            }
            if let Some(show) = args.show_indicator {
                prefs.show_indicator = show;
            }
            self.save_prefs(&prefs);
            prefs.to_runtime_config()
        };

        self.runtime_config.set(next_cfg).await;
        self.sync_stop_shortcut().await;
        Ok(self.get_settings().await)
    }

    pub fn recent_activity(&self) -> Vec<ComputerActivityPayload> {
        self.broadcaster.recent_activity()
    }

    pub fn clear_activity(&self) {
        self.broadcaster.clear_activity();
    }

    /// Dispatch a JSON-RPC method from the plugin Worker or MCP server.
    pub async fn dispatch_rpc(
        self: &Arc<Self>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        match method {
            "computer.getSettings" => {
                serde_json::to_value(self.get_settings().await).map_err(|e| e.to_string())
            }
            "computer.setEnabled" => {
                let enabled = params
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| "missing boolean `enabled`".to_string())?;
                let res = self.set_enabled(enabled).await?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.setPreferences" => {
                let args: SetPreferencesArgs =
                    serde_json::from_value(params).map_err(|e| e.to_string())?;
                let res = self.set_preferences(args).await?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.status" => {
                let res = computer_status_core(&self.computer)
                    .await
                    .map_err(|e| e.message)?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.sharedState" => {
                let res = computer_shared_state_core(&self.computer);
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.listShareableWindows" => {
                let res = computer_list_shareable_windows_core(&self.computer)
                    .await
                    .map_err(|e| e.message)?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.windowThumbnail" => {
                let target_id = params
                    .get("targetId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "missing `targetId`".to_string())?;
                let res = computer_window_thumbnail_core(&self.computer, target_id)
                    .await
                    .map_err(|e| e.message)?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.shareWindow" => {
                let target_id = params
                    .get("targetId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "missing `targetId`".to_string())?;
                let level: GrantLevel =
                    serde_json::from_value(params.get("level").cloned().unwrap_or(json!("none")))
                        .map_err(|e| e.to_string())?;
                let res = computer_share_window_core(&self.computer, target_id, level)
                    .await
                    .map_err(|e| e.message)?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.shareWindows" => {
                let target_ids: Vec<String> =
                    serde_json::from_value(params.get("targetIds").cloned().unwrap_or(json!([])))
                        .map_err(|e| e.to_string())?;
                let level: GrantLevel =
                    serde_json::from_value(params.get("level").cloned().unwrap_or(json!("none")))
                        .map_err(|e| e.to_string())?;
                let res = computer_share_windows_core(&self.computer, &target_ids, level)
                    .await
                    .map_err(|e| e.message)?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.shareApp" => {
                let target_id = params.get("targetId").and_then(Value::as_str);
                let app_id = params.get("appId").and_then(Value::as_str);
                let level: GrantLevel =
                    serde_json::from_value(params.get("level").cloned().unwrap_or(json!("none")))
                        .map_err(|e| e.to_string())?;
                let res = computer_share_app_core(&self.computer, target_id, app_id, level)
                    .await
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.shareScreen" => {
                let level: GrantLevel =
                    serde_json::from_value(params.get("level").cloned().unwrap_or(json!("none")))
                        .map_err(|e| e.to_string())?;
                let res = computer_share_screen_core(&self.computer, level)
                    .await
                    .map_err(|e| e.message)?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.revokeAll" => {
                computer_revoke_all_core(&self.computer);
                Ok(Value::Null)
            }
            "computer.stop" => {
                computer_stop_core(&self.computer).await;
                Ok(Value::Null)
            }
            "computer.stopKeyStatus" => {
                serde_json::to_value(self.stop_key.status()).map_err(|e| e.to_string())
            }
            "computer.driverInfo" => {
                let res = computer_driver_info_core(&self.computer);
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.driverInstall" => {
                let res = computer_driver_install_core(&self.computer)
                    .await
                    .map_err(|e| e.message)?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.driverUninstall" => {
                let st = self.clone();
                let res = computer_driver_uninstall_core(&self.computer, async move {
                    st.set_enabled(false).await.map(|_| ())
                })
                .await
                .map_err(|e| e.message)?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.requestPermission" => {
                let permission: OsPermission = serde_json::from_value(
                    params
                        .get("permission")
                        .or_else(|| params.get("kind"))
                        .cloned()
                        .unwrap_or(Value::Null),
                )
                .map_err(|e| e.to_string())?;
                let res = computer_request_permission_core(&self.computer, permission)
                    .await
                    .map_err(|e| e.message)?;
                serde_json::to_value(res).map_err(|e| e.to_string())
            }
            "computer.openPermissionSettings" => {
                let permission: OsPermission = serde_json::from_value(
                    params
                        .get("permission")
                        .or_else(|| params.get("kind"))
                        .cloned()
                        .unwrap_or(Value::Null),
                )
                .map_err(|e| e.to_string())?;
                if let Some(url) = permission_settings_url(permission) {
                    #[cfg(target_os = "macos")]
                    {
                        let _ = std::process::Command::new("open").arg(url).spawn();
                    }
                    #[cfg(not(target_os = "macos"))]
                    let _ = url;
                }
                Ok(Value::Null)
            }
            "computer.revealHelper" => {
                let helper = crate::computer::local::helper_to_reveal()
                    .await
                    .map_err(|e| e.to_string())?;
                reveal_path_in_file_manager(&helper)?;
                Ok(Value::Null)
            }
            "computer.listLocalApps" => {
                let apps = tokio::task::spawn_blocking(list_local_apps)
                    .await
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(apps).map_err(|e| e.to_string())
            }
            "computer.pickExecutableFile" => {
                let picked = tokio::task::spawn_blocking(pick_executable_file)
                    .await
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(picked).map_err(|e| e.to_string())
            }
            "computer.activity" => {
                serde_json::to_value(self.recent_activity()).map_err(|e| e.to_string())
            }
            "computer.snapshotState" => {
                let settings = self.get_settings().await;
                let status = computer_status_core(&self.computer)
                    .await
                    .map_err(|e| e.message)?;
                let shared_state = computer_shared_state_core(&self.computer);
                serde_json::to_value(json!({
                    "settings": settings,
                    "status": status,
                    "sharedState": shared_state,
                    "stopKeyStatus": self.stop_key.status(),
                    "driverInfo": computer_driver_info_core(&self.computer),
                    "activity": self.recent_activity(),
                }))
                .map_err(|e| e.to_string())
            }
            "computer.clearActivity" => {
                self.clear_activity();
                Ok(Value::Null)
            }
            "mcp.listTools" => {
                let tools = mcp_dispatch::list_computer_tools(&self.runtime_config).await;
                Ok(json!({ "tools": tools }))
            }
            "mcp.callTool" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
                mcp_dispatch::call_computer_tool(
                    &self.runtime_config,
                    &self.computer,
                    name,
                    &arguments,
                )
                .await
            }
            other => Err(format!("unknown method: {other}")),
        }
    }
}

/// Normalize human/UI shortcut spellings (e.g. `Ctrl+Alt+S`, `Ctrl+Shift+1`, `Control+Alt+Escape`)
/// into the canonical W3C format expected by `StopShortcut::parse`.
pub fn normalize_shortcut_spelling(raw: &str) -> String {
    let parts: Vec<&str> = raw
        .split('+')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        return String::new();
    }
    let mut out: Vec<String> = Vec::with_capacity(parts.len());
    for (idx, part) in parts.iter().enumerate() {
        let is_last = idx + 1 == parts.len();
        if !is_last {
            let mapped = if part.eq_ignore_ascii_case("ctrl")
                || part.eq_ignore_ascii_case("control")
                || *part == "⌃"
            {
                "Control"
            } else if part.eq_ignore_ascii_case("alt")
                || part.eq_ignore_ascii_case("opt")
                || part.eq_ignore_ascii_case("option")
                || *part == "⌥"
            {
                "Alt"
            } else if part.eq_ignore_ascii_case("shift") || *part == "⇧" {
                "Shift"
            } else if part.eq_ignore_ascii_case("command")
                || part.eq_ignore_ascii_case("cmd")
                || part.eq_ignore_ascii_case("meta")
                || part.eq_ignore_ascii_case("super")
                || *part == "⌘"
            {
                "Command"
            } else {
                *part
            };
            out.push(mapped.to_string());
        } else {
            let key = if part.len() == 1 {
                let ch = part.chars().next().unwrap();
                if ch.is_ascii_alphabetic() {
                    format!("Key{}", ch.to_ascii_uppercase())
                } else if ch.is_ascii_digit() {
                    format!("Digit{ch}")
                } else {
                    match ch {
                        '-' => "Minus".to_string(),
                        '=' => "Equal".to_string(),
                        '[' => "BracketLeft".to_string(),
                        ']' => "BracketRight".to_string(),
                        '\\' => "Backslash".to_string(),
                        ';' => "Semicolon".to_string(),
                        '\'' => "Quote".to_string(),
                        '`' => "Backquote".to_string(),
                        ',' => "Comma".to_string(),
                        '.' => "Period".to_string(),
                        '/' => "Slash".to_string(),
                        _ => (*part).to_string(),
                    }
                }
            } else if part.eq_ignore_ascii_case("esc") || part.eq_ignore_ascii_case("escape") {
                "Escape".to_string()
            } else {
                (*part).to_string()
            };
            out.push(key);
        }
    }
    out.join("+")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAppEntry {
    pub name: String,
    pub identifier: String,
    pub exe_name: Option<String>,
    pub path: Option<String>,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedExecutable {
    pub canceled: bool,
    pub path: Option<String>,
    pub file_name: Option<String>,
    pub name: Option<String>,
}

#[cfg(target_os = "windows")]
fn pick_executable_file() -> PickedExecutable {
    use std::ffi::c_void;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    #[repr(C)]
    struct OpenFileNameW {
        l_struct_size: u32,
        hwnd_owner: *mut c_void,
        h_instance: *mut c_void,
        lpstr_filter: *const u16,
        lpstr_custom_filter: *mut u16,
        n_max_cust_filter: u32,
        n_filter_index: u32,
        lpstr_file: *mut u16,
        n_max_file: u32,
        lpstr_file_title: *mut u16,
        n_max_file_title: u32,
        lpstr_initial_dir: *const u16,
        lpstr_title: *const u16,
        flags: u32,
        n_file_offset: u16,
        n_file_extension: u16,
        lpstr_def_ext: *const u16,
        l_cust_data: isize,
        lpfn_hook: *const c_void,
        lp_template_name: *const u16,
        pv_reserved: *mut c_void,
        dw_reserved: u32,
        flags_ex: u32,
    }

    #[link(name = "comdlg32")]
    extern "system" {
        fn GetOpenFileNameW(lpofn: *mut OpenFileNameW) -> i32;
    }

    const OFN_PATHMUSTEXIST: u32 = 0x0000_0800;
    const OFN_FILEMUSTEXIST: u32 = 0x0000_1000;
    const OFN_NOCHANGEDIR: u32 = 0x0000_0008;
    const OFN_EXPLORER: u32 = 0x0008_0000;

    let filter_str = "应用程序 (*.exe)\0*.exe\0所有文件 (*.*)\0*.*\0\0";
    let filter_wide: Vec<u16> = filter_str.encode_utf16().collect();
    let title_wide: Vec<u16> = "选择拒绝共享的应用执行文件"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut file_buf = vec![0u16; 1024];

    let hwnd_owner = unsafe { GetForegroundWindow() };
    let mut ofn = OpenFileNameW {
        l_struct_size: std::mem::size_of::<OpenFileNameW>() as u32,
        hwnd_owner,
        h_instance: std::ptr::null_mut(),
        lpstr_filter: filter_wide.as_ptr(),
        lpstr_custom_filter: std::ptr::null_mut(),
        n_max_cust_filter: 0,
        n_filter_index: 1,
        lpstr_file: file_buf.as_mut_ptr(),
        n_max_file: file_buf.len() as u32,
        lpstr_file_title: std::ptr::null_mut(),
        n_max_file_title: 0,
        lpstr_initial_dir: std::ptr::null(),
        lpstr_title: title_wide.as_ptr(),
        flags: OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_FILEMUSTEXIST | OFN_NOCHANGEDIR,
        n_file_offset: 0,
        n_file_extension: 0,
        lpstr_def_ext: std::ptr::null(),
        l_cust_data: 0,
        lpfn_hook: std::ptr::null(),
        lp_template_name: std::ptr::null(),
        pv_reserved: std::ptr::null_mut(),
        dw_reserved: 0,
        flags_ex: 0,
    };

    let ok = unsafe { GetOpenFileNameW(&mut ofn) };
    if ok == 0 {
        return PickedExecutable {
            canceled: true,
            path: None,
            file_name: None,
            name: None,
        };
    }

    let len = file_buf
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(file_buf.len());
    let path = String::from_utf16_lossy(&file_buf[..len])
        .trim()
        .to_string();
    if path.is_empty() {
        return PickedExecutable {
            canceled: true,
            path: None,
            file_name: None,
            name: None,
        };
    }
    let file_name = path
        .rsplit(['\\', '/'])
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let name = crate::computer::appident::file_description(&path).or_else(|| {
        file_name.as_deref().map(|f| {
            f.strip_suffix(".exe")
                .or_else(|| f.strip_suffix(".EXE"))
                .unwrap_or(f)
                .to_string()
        })
    });

    PickedExecutable {
        canceled: false,
        path: Some(path),
        file_name,
        name,
    }
}

#[cfg(target_os = "macos")]
fn pick_executable_file() -> PickedExecutable {
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg("POSIX path of (choose file of type {\"app\", \"public.unix-executable\"} with prompt \"选择拒绝共享的应用\")")
        .output();
    if let Ok(output) = out {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .trim()
                .trim_end_matches('/')
                .to_string();
            if !path.is_empty() {
                let file_name = path
                    .rsplit('/')
                    .next()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let name = file_name
                    .as_deref()
                    .map(|f| f.strip_suffix(".app").unwrap_or(f).to_string());
                return PickedExecutable {
                    canceled: false,
                    path: Some(path),
                    file_name,
                    name,
                };
            }
        }
    }
    PickedExecutable {
        canceled: true,
        path: None,
        file_name: None,
        name: None,
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn pick_executable_file() -> PickedExecutable {
    let out = std::process::Command::new("zenity")
        .arg("--file-selection")
        .arg("--title=选择拒绝共享的应用执行文件")
        .output();
    if let Ok(output) = out {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                let file_name = path
                    .rsplit('/')
                    .next()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                return PickedExecutable {
                    canceled: false,
                    path: Some(path),
                    file_name: file_name.clone(),
                    name: file_name,
                };
            }
        }
    }
    PickedExecutable {
        canceled: true,
        path: None,
        file_name: None,
        name: None,
    }
}

#[cfg(target_os = "windows")]
fn list_local_apps() -> Vec<LocalAppEntry> {
    use std::collections::{HashMap, HashSet};
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
    };

    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            hkey: isize,
            sub_key: *const u16,
            options: u32,
            sam_desired: u32,
            phk_result: *mut isize,
        ) -> i32;
        fn RegEnumKeyExW(
            hkey: isize,
            index: u32,
            lp_name: *mut u16,
            lpcch_name: *mut u32,
            lp_reserved: *mut u32,
            lp_class: *mut u16,
            lpcch_class: *mut u32,
            lpft_last_write_time: *mut u64,
        ) -> i32;
        fn RegQueryValueExW(
            hkey: isize,
            lp_value_name: *const u16,
            lp_reserved: *const u32,
            lp_type: *mut u32,
            lp_data: *mut u8,
            lpcb_data: *mut u32,
        ) -> i32;
        fn RegCloseKey(hkey: isize) -> i32;
    }

    const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as i32 as isize;
    const HKEY_LOCAL_MACHINE: isize = 0x8000_0002u32 as i32 as isize;
    const KEY_READ: u32 = 0x20019;
    const REG_SZ: u32 = 1;
    const REG_EXPAND_SZ: u32 = 2;
    const REG_DWORD: u32 = 4;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn reg_read_string(hkey: isize, name: Option<&str>) -> Option<String> {
        let name_w = name.map(wide);
        let name_ptr = name_w.as_ref().map_or(std::ptr::null(), |v| v.as_ptr());
        let mut ty = 0u32;
        let mut size = 0u32;
        let st = unsafe {
            RegQueryValueExW(
                hkey,
                name_ptr,
                std::ptr::null(),
                &mut ty,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if st != 0 || (ty != REG_SZ && ty != REG_EXPAND_SZ) || size == 0 || size > 4096 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let st = unsafe {
            RegQueryValueExW(
                hkey,
                name_ptr,
                std::ptr::null(),
                &mut ty,
                buf.as_mut_ptr(),
                &mut size,
            )
        };
        if st != 0 {
            return None;
        }
        let units: Vec<u16> = buf[..size as usize]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|&u| u != 0)
            .collect();
        let text = String::from_utf16_lossy(&units).trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    fn reg_read_dword(hkey: isize, name: &str) -> Option<u32> {
        let name_w = wide(name);
        let mut ty = 0u32;
        let mut data = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let st = unsafe {
            RegQueryValueExW(
                hkey,
                name_w.as_ptr(),
                std::ptr::null(),
                &mut ty,
                (&mut data as *mut u32).cast(),
                &mut size,
            )
        };
        (st == 0 && ty == REG_DWORD).then_some(data)
    }

    fn is_noise_exe(file_name: &str) -> bool {
        let lower = file_name.to_ascii_lowercase();
        if !lower.ends_with(".exe") {
            return true;
        }
        for bad in [
            "unins",
            "uninstall",
            "setup",
            "msiexec",
            "crashpad",
            "createdump",
            "updater",
            "update.exe",
            "elevate.exe",
            "vibex",
            "cua-driver",
            "explorer.exe",
            "applicationframehost.exe",
            "msedgewebview2.exe",
            "shellexperiencehost.exe",
            "searchhost.exe",
            "startmenuexperiencehost.exe",
            "textinputhost.exe",
            "lockapp.exe",
        ] {
            if lower.contains(bad) {
                return true;
            }
        }
        false
    }

    fn is_noise_display_name(name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        for bad in [
            "microsoft visual c++",
            "microsoft .net",
            "windows software development kit",
            "windows sdk",
            "update for ",
            "security update",
            "hotfix",
            "redistributable",
            "vs_",
            "vcpp_",
            "click-to-run",
            "webview2 runtime",
        ] {
            if lower.contains(bad) {
                return true;
            }
        }
        false
    }

    fn clean_exe_path(raw: &str) -> Option<String> {
        let s = raw.trim().trim_matches('"').trim();
        let s = if let Some((before_comma, _)) = s.rsplit_once(',') {
            before_comma.trim().trim_matches('"')
        } else {
            s
        };
        let s = if let Some(idx) = s.to_ascii_lowercase().find(".exe") {
            &s[..idx + 4]
        } else {
            return None;
        };
        let s = s.trim().trim_matches('"');
        let file = s.rsplit(['\\', '/']).next()?;
        if is_noise_exe(file) {
            return None;
        }
        Path::new(s).exists().then(|| s.to_string())
    }

    let mut by_key: HashMap<String, LocalAppEntry> = HashMap::new();

    let mut insert_app =
        |name: String, exe_name: Option<String>, path: Option<String>, running: bool| {
            let name = name.trim().to_string();
            if name.is_empty() || is_noise_display_name(&name) {
                return;
            }
            if let Some(ref exe) = exe_name {
                if is_noise_exe(exe) {
                    return;
                }
            }
            let identifier = exe_name
                .clone()
                .or_else(|| path.clone())
                .unwrap_or_else(|| name.clone());
            let key = exe_name
                .as_deref()
                .unwrap_or(&identifier)
                .to_ascii_lowercase();
            match by_key.get_mut(&key) {
                Some(existing) => {
                    if running {
                        existing.running = true;
                    }
                    if existing.path.is_none() && path.is_some() {
                        existing.path = path;
                    }
                    if existing.exe_name.is_none() && exe_name.is_some() {
                        existing.exe_name = exe_name;
                    }
                }
                None => {
                    by_key.insert(
                        key,
                        LocalAppEntry {
                            name,
                            identifier,
                            exe_name,
                            path,
                            running,
                        },
                    );
                }
            }
        };

    // 1. Currently running visible window applications
    unsafe extern "system" fn enum_wnd_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd) != 0 {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid != 0 {
                let set = &mut *(lparam as *mut HashSet<u32>);
                set.insert(pid);
            }
        }
        1
    }
    let mut pids = HashSet::<u32>::new();
    unsafe {
        EnumWindows(
            Some(enum_wnd_proc),
            &mut pids as *mut HashSet<u32> as LPARAM,
        );
    }
    for pid in pids {
        if pid == std::process::id() {
            continue;
        }
        if let Some(img) = crate::computer::procinfo::process_image(pid) {
            if !crate::computer::appident::is_windows_application(&img.path) {
                continue;
            }
            let Some(file) = img.path.rsplit(['\\', '/']).next().map(str::to_string) else {
                continue;
            };
            if is_noise_exe(&file) {
                continue;
            }
            let name =
                crate::computer::appident::file_description(&img.path).unwrap_or_else(|| {
                    file.strip_suffix(".exe")
                        .or_else(|| file.strip_suffix(".EXE"))
                        .unwrap_or(&file)
                        .to_string()
                });
            insert_app(name, Some(file), Some(img.path), true);
        }
    }

    // 2. Installed applications from Registry Uninstall keys
    for (root, subkey_path) in [
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            HKEY_CURRENT_USER,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
    ] {
        let path_w = wide(subkey_path);
        let mut hkey = 0isize;
        if unsafe { RegOpenKeyExW(root, path_w.as_ptr(), 0, KEY_READ, &mut hkey) } != 0 {
            continue;
        }
        let mut index = 0u32;
        loop {
            let mut name_buf = [0u16; 260];
            let mut name_len = name_buf.len() as u32;
            let st = unsafe {
                RegEnumKeyExW(
                    hkey,
                    index,
                    name_buf.as_mut_ptr(),
                    &mut name_len,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if st != 0 {
                break;
            }
            index += 1;
            let sub_name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            let full_sub = format!(r"{subkey_path}\{sub_name}");
            let full_sub_w = wide(&full_sub);
            let mut sub_hkey = 0isize;
            if unsafe { RegOpenKeyExW(root, full_sub_w.as_ptr(), 0, KEY_READ, &mut sub_hkey) } == 0
            {
                let sys_comp = reg_read_dword(sub_hkey, "SystemComponent").unwrap_or(0);
                if sys_comp != 1 {
                    if let Some(display_name) = reg_read_string(sub_hkey, Some("DisplayName")) {
                        let exe_path = reg_read_string(sub_hkey, Some("DisplayIcon"))
                            .and_then(|icon| clean_exe_path(&icon))
                            .or_else(|| {
                                let loc = reg_read_string(sub_hkey, Some("InstallLocation"))?;
                                let dir = Path::new(loc.trim().trim_matches('"'));
                                let rd = std::fs::read_dir(dir).ok()?;
                                rd.flatten()
                                    .map(|e| e.path())
                                    .find(|p| {
                                        p.is_file()
                                            && p.file_name()
                                                .and_then(|n| n.to_str())
                                                .is_some_and(|n| !is_noise_exe(n))
                                    })
                                    .map(|p| p.to_string_lossy().to_string())
                            });
                        if let Some(path) = exe_path {
                            let exe_name = path.rsplit(['\\', '/']).next().map(str::to_string);
                            insert_app(display_name, exe_name, Some(path), false);
                        }
                    }
                }
                unsafe {
                    RegCloseKey(sub_hkey);
                }
            }
        }
        unsafe {
            RegCloseKey(hkey);
        }
    }

    // 3. Registry App Paths
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let subkey_path = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths";
        let path_w = wide(subkey_path);
        let mut hkey = 0isize;
        if unsafe { RegOpenKeyExW(root, path_w.as_ptr(), 0, KEY_READ, &mut hkey) } != 0 {
            continue;
        }
        let mut index = 0u32;
        loop {
            let mut name_buf = [0u16; 260];
            let mut name_len = name_buf.len() as u32;
            let st = unsafe {
                RegEnumKeyExW(
                    hkey,
                    index,
                    name_buf.as_mut_ptr(),
                    &mut name_len,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if st != 0 {
                break;
            }
            index += 1;
            let sub_name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            if is_noise_exe(&sub_name) {
                continue;
            }
            let full_sub = format!(r"{subkey_path}\{sub_name}");
            let full_sub_w = wide(&full_sub);
            let mut sub_hkey = 0isize;
            if unsafe { RegOpenKeyExW(root, full_sub_w.as_ptr(), 0, KEY_READ, &mut sub_hkey) } == 0
            {
                if let Some(default_val) = reg_read_string(sub_hkey, None) {
                    if let Some(exe_path) = clean_exe_path(&default_val) {
                        let exe_name = exe_path
                            .rsplit(['\\', '/'])
                            .next()
                            .unwrap_or(&sub_name)
                            .to_string();
                        let display = crate::computer::appident::file_description(&exe_path)
                            .unwrap_or_else(|| {
                                exe_name
                                    .strip_suffix(".exe")
                                    .or_else(|| exe_name.strip_suffix(".EXE"))
                                    .unwrap_or(&exe_name)
                                    .to_string()
                            });
                        insert_app(display, Some(exe_name), Some(exe_path), false);
                    }
                }
                unsafe {
                    RegCloseKey(sub_hkey);
                }
            }
        }
        unsafe {
            RegCloseKey(hkey);
        }
    }

    let mut list: Vec<LocalAppEntry> = by_key.into_values().collect();
    list.sort_by(|a, b| {
        b.running
            .cmp(&a.running)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    list
}

#[cfg(target_os = "macos")]
fn list_local_apps() -> Vec<LocalAppEntry> {
    let mut out = Vec::new();
    let mut dirs = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
    ];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join("Applications"));
    }
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !file_name.ends_with(".app") {
                continue;
            }
            let name = file_name.trim_end_matches(".app").to_string();
            out.push(LocalAppEntry {
                name,
                identifier: file_name.to_string(),
                exe_name: Some(file_name.to_string()),
                path: Some(path.to_string_lossy().to_string()),
                running: false,
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out.dedup_by(|a, b| a.identifier.eq_ignore_ascii_case(&b.identifier));
    out
}

#[cfg(all(unix, not(target_os = "macos")))]
fn list_local_apps() -> Vec<LocalAppEntry> {
    let mut out = Vec::new();
    let mut dirs = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
    ];
    if let Some(data) = dirs::data_local_dir() {
        dirs.push(data.join("applications"));
    }
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let mut name = None;
            let mut exec = None;
            let mut no_display = false;
            for line in text.lines() {
                if let Some(v) = line.strip_prefix("Name=") {
                    if name.is_none() {
                        name = Some(v.trim().to_string());
                    }
                } else if let Some(v) = line.strip_prefix("Exec=") {
                    exec = v
                        .split_whitespace()
                        .next()
                        .map(|s| s.trim_matches('"').to_string());
                } else if line.trim() == "NoDisplay=true" {
                    no_display = true;
                }
            }
            if no_display {
                continue;
            }
            if let (Some(name), Some(exec_cmd)) = (name, exec) {
                let exe_name = exec_cmd.rsplit('/').next().unwrap_or(&exec_cmd).to_string();
                out.push(LocalAppEntry {
                    name,
                    identifier: exe_name.clone(),
                    exe_name: Some(exe_name),
                    path: Some(exec_cmd),
                    running: false,
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out.dedup_by(|a, b| a.identifier.eq_ignore_ascii_case(&b.identifier));
    out
}

fn reveal_path_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}
