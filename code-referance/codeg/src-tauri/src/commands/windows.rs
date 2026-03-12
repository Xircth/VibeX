use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::models::FolderHistoryEntry;

pub struct SettingsWindowState {
    owner_window_label: Mutex<Option<String>>,
    disabled_windows: Mutex<HashSet<String>>,
}

pub struct CommitWindowState {
    owner_by_commit_label: Mutex<HashMap<String, String>>,
}

pub fn folder_window_label(folder_id: i32) -> String {
    format!("folder-{folder_id}")
}

pub(crate) fn apply_platform_window_style<'a, R, M>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M>
where
    R: tauri::Runtime,
    M: tauri::Manager<R>,
{
    #[cfg(target_os = "macos")]
    {
        builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
    }

    #[cfg(target_os = "windows")]
    {
        return builder.decorations(false);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        builder
    }
}

#[cfg(target_os = "windows")]
fn ensure_windows_undecorated(window: &tauri::WebviewWindow) {
    let _ = window.set_decorations(false);
}

#[cfg(not(target_os = "windows"))]
fn ensure_windows_undecorated(_window: &tauri::WebviewWindow) {}

impl SettingsWindowState {
    pub fn new() -> Self {
        Self {
            owner_window_label: Mutex::new(None),
            disabled_windows: Mutex::new(HashSet::new()),
        }
    }

    fn set_owner(&self, label: String) {
        if let Ok(mut owner) = self.owner_window_label.lock() {
            *owner = Some(label);
        }
    }

    fn take_owner(&self) -> Option<String> {
        self.owner_window_label
            .lock()
            .ok()
            .and_then(|mut owner| owner.take())
    }

    fn set_disabled_windows(&self, labels: HashSet<String>) {
        if let Ok(mut disabled) = self.disabled_windows.lock() {
            *disabled = labels;
        }
    }

    fn take_disabled_windows(&self) -> HashSet<String> {
        self.disabled_windows
            .lock()
            .map(|mut disabled| std::mem::take(&mut *disabled))
            .unwrap_or_default()
    }
}

impl CommitWindowState {
    pub fn new() -> Self {
        Self {
            owner_by_commit_label: Mutex::new(HashMap::new()),
        }
    }

    fn set_owner(&self, commit_label: String, owner_label: String) {
        if let Ok(mut owners) = self.owner_by_commit_label.lock() {
            owners.insert(commit_label, owner_label);
        }
    }

    fn take_owner(&self, commit_label: &str) -> Option<String> {
        self.owner_by_commit_label
            .lock()
            .ok()
            .and_then(|mut owners| owners.remove(commit_label))
    }
}

fn get_folder_id_from_window(window: &tauri::WebviewWindow) -> Option<i32> {
    let url = window.url().ok()?;
    url.query_pairs()
        .find(|(key, _)| key == "id")
        .and_then(|(_, value)| value.parse::<i32>().ok())
}

fn resolve_settings_route(section: Option<&str>) -> &'static str {
    match section {
        Some("appearance") => "settings/appearance",
        Some("agents") => "settings/agents",
        Some("mcp") => "settings/mcp",
        Some("skills") => "settings/skills",
        Some("shortcuts") => "settings/shortcuts",
        Some("system") => "settings/system",
        _ => "settings/system",
    }
}

fn normalize_agent_query(agent_type: Option<&str>) -> Option<String> {
    let raw = agent_type?.trim();
    if raw.is_empty() {
        return None;
    }
    if raw
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
    {
        return Some(raw.to_string());
    }
    None
}

fn resolve_settings_target(section: Option<&str>, agent_type: Option<&str>) -> String {
    let route = resolve_settings_route(section);
    if route == "settings/agents" {
        if let Some(agent) = normalize_agent_query(agent_type) {
            return format!("{route}?agent={agent}");
        }
    }
    route.to_string()
}

#[tauri::command]
pub async fn list_open_folders(
    app: AppHandle,
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<FolderHistoryEntry>, AppCommandError> {
    let windows = app.webview_windows();
    let mut folder_ids: Vec<i32> = Vec::new();

    for (label, window) in &windows {
        if label.starts_with("folder-") {
            if let Some(id) = get_folder_id_from_window(window) {
                folder_ids.push(id);
            }
        }
    }

    let all_folders = crate::db::service::folder_service::list_folders(&db.conn)
        .await
        .map_err(AppCommandError::from)?;

    let open_folders: Vec<FolderHistoryEntry> = all_folders
        .into_iter()
        .filter(|f| folder_ids.contains(&f.id))
        .collect();

    Ok(open_folders)
}

#[tauri::command]
pub async fn focus_folder_window(app: AppHandle, folder_id: i32) -> Result<(), AppCommandError> {
    let windows = app.webview_windows();
    for (label, window) in &windows {
        if label.starts_with("folder-") {
            if let Some(id) = get_folder_id_from_window(window) {
                if id == folder_id {
                    window.set_focus().map_err(|e| {
                        AppCommandError::window("Failed to focus folder window", e.to_string())
                    })?;
                    return Ok(());
                }
            }
        }
    }
    Err(
        AppCommandError::not_found(format!("No open window for folder {folder_id}"))
            .with_detail(format!("folder_id={folder_id}")),
    )
}

#[tauri::command]
pub async fn open_folder_window(
    app: AppHandle,
    db: tauri::State<'_, AppDatabase>,
    path: String,
) -> Result<(), AppCommandError> {
    // Add to history via DB
    let entry = crate::db::service::folder_service::add_folder(&db.conn, &path)
        .await
        .map_err(AppCommandError::from)?;

    let label = folder_window_label(entry.id);
    if let Some(existing) = app.get_webview_window(&label) {
        ensure_windows_undecorated(&existing);
        let _ = existing.unminimize();
        existing
            .set_focus()
            .map_err(|e| AppCommandError::window("Failed to focus folder window", e.to_string()))?;
        if let Some(w) = app.get_webview_window("welcome") {
            let _ = w.close();
        }
        return Ok(());
    }

    let url = WebviewUrl::App(format!("folder?id={}", entry.id).into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(&entry.name)
        .inner_size(1260.0, 860.0)
        .min_inner_size(900.0, 600.0);
    let folder_window = apply_platform_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open folder window", e.to_string()))?;
    ensure_windows_undecorated(&folder_window);

    // Close welcome window
    if let Some(w) = app.get_webview_window("welcome") {
        w.close().map_err(|e| {
            AppCommandError::window("Failed to close welcome window", e.to_string())
        })?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_commit_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    state: tauri::State<'_, CommitWindowState>,
    folder_id: i32,
) -> Result<(), AppCommandError> {
    let owner_label = window.label().to_string();
    let label = format!("commit-{folder_id}");

    if let Some(existing) = app.get_webview_window(&label) {
        if let Some(owner_window) = app.get_webview_window(&owner_label) {
            owner_window.set_enabled(false).map_err(|e| {
                AppCommandError::window("Failed to disable owner window", e.to_string())
            })?;
        }
        state.set_owner(label.clone(), owner_label);
        let _ = existing.unminimize();
        existing
            .set_focus()
            .map_err(|e| AppCommandError::window("Failed to focus commit window", e.to_string()))?;
        return Ok(());
    }

    let folder = crate::db::service::folder_service::get_folder_by_id(&db.conn, folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Folder {folder_id} not found"))
                .with_detail(format!("folder_id={folder_id}"))
        })?;

    let url = WebviewUrl::App(format!("commit?folderId={folder_id}").into());
    let builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(format!("提交代码 - {}", folder.name))
        .inner_size(1220.0, 820.0)
        .min_inner_size(980.0, 620.0)
        .always_on_top(true)
        .center();
    let commit_window = apply_platform_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open commit window", e.to_string()))?;
    ensure_windows_undecorated(&commit_window);
    if let Some(owner_window) = app.get_webview_window(&owner_label) {
        if let Err(err) = owner_window.set_enabled(false) {
            let _ = commit_window.close();
            return Err(AppCommandError::window(
                "Failed to disable owner window",
                err.to_string(),
            ));
        }
    }
    state.set_owner(label, owner_label);
    commit_window
        .set_focus()
        .map_err(|e| AppCommandError::window("Failed to focus commit window", e.to_string()))?;

    Ok(())
}

#[tauri::command]
pub async fn open_settings_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    section: Option<String>,
    agent_type: Option<String>,
    state: tauri::State<'_, SettingsWindowState>,
) -> Result<(), AppCommandError> {
    let target_route = resolve_settings_target(section.as_deref(), agent_type.as_deref());
    if let Some(existing) = app.get_webview_window("settings") {
        ensure_windows_undecorated(&existing);
        if section.is_some() || agent_type.is_some() {
            let target_path = format!("/{target_route}");
            let target_json = serde_json::to_string(&target_path).map_err(|e| {
                AppCommandError::window("Failed to build settings navigation target", e.to_string())
            })?;
            let nav_script = format!("window.location.replace({target_json});");
            existing.eval(&nav_script).map_err(|e| {
                AppCommandError::window("Failed to navigate settings window", e.to_string())
            })?;
        }
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| {
            AppCommandError::window("Failed to focus settings window", e.to_string())
        })?;
        return Ok(());
    }

    let owner_label = window.label().to_string();
    let url = WebviewUrl::App(target_route.into());
    let builder = WebviewWindowBuilder::new(&app, "settings", url)
        .title("Settings")
        .inner_size(1080.0, 700.0)
        .min_inner_size(1080.0, 600.0)
        .always_on_top(true)
        .center();
    let settings_window = apply_platform_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open settings window", e.to_string()))?;
    ensure_windows_undecorated(&settings_window);

    let mut disabled = HashSet::new();
    for (label, webview) in app.webview_windows() {
        if label != "settings" {
            webview.set_enabled(false).map_err(|e| {
                AppCommandError::window("Failed to update window enabled state", e.to_string())
            })?;
            disabled.insert(label);
        }
    }

    state.set_owner(owner_label);
    state.set_disabled_windows(disabled);
    settings_window
        .set_focus()
        .map_err(|e| AppCommandError::window("Failed to focus settings window", e.to_string()))?;
    Ok(())
}

pub fn restore_windows_after_settings(app: &AppHandle, state: &SettingsWindowState) {
    for label in state.take_disabled_windows() {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.set_enabled(true);
        }
    }

    if let Some(owner_label) = state.take_owner() {
        if let Some(window) = app.get_webview_window(&owner_label) {
            let _ = window.set_focus();
        }
    }
}

pub fn restore_window_after_commit(
    app: &AppHandle,
    state: &CommitWindowState,
    commit_window_label: &str,
) {
    if let Some(owner_label) = state.take_owner(commit_window_label) {
        if let Some(window) = app.get_webview_window(&owner_label) {
            let _ = window.set_enabled(true);
            let _ = window.set_focus();
        }
    }
}

pub fn open_welcome_window(app: &AppHandle) -> Result<(), AppCommandError> {
    if let Some(existing) = app.get_webview_window("welcome") {
        ensure_windows_undecorated(&existing);
        return Ok(());
    }
    let url = WebviewUrl::App("welcome".into());
    let builder = WebviewWindowBuilder::new(app, "welcome", url)
        .title("Codeg")
        .inner_size(800.0, 520.0)
        .min_inner_size(600.0, 400.0)
        .center();
    let welcome_window = apply_platform_window_style(builder)
        .build()
        .map_err(|e| AppCommandError::window("Failed to open welcome window", e.to_string()))?;
    ensure_windows_undecorated(&welcome_window);
    Ok(())
}
