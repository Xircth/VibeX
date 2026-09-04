use std::{path::Path, time::Duration};

use application::ApplicationError;
use db::models::{
    agent_management::legacy_migration::LegacyAgentMigration,
    execution_process::ExecutionProcess,
    project::Project,
    workspace::Workspace,
};
use deployment::Deployment;
use executors::profile::ExecutorConfigs;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::{
    config::{Config, load_config_from_file, save_config_to_file},
    settings_store::{read_section, write_section},
    worktree_manager::WorktreeManager,
    worktree_settings::{load_project_settings, should_prompt_cleanup},
};
use utils::proxy::{DetectedProxy, capture_inherited_proxy, detect_proxy};
use uuid::Uuid;

use super::unwrap_named;
use crate::{
    domains::{ServerApplicationDomains, internal_error, parse, serialize},
    host::events::global_host_events,
};

const SYSTEM_SECTION: &str = "system";
const PROXY_URL_ENV_KEYS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];
const DEFAULT_UPDATE_REPOSITORY: &str = "Xircth/VibeX";
const RELEASE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProxyMode {
    #[default]
    Auto,
    Manual,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SystemProxySettings {
    #[serde(default)]
    mode: ProxyMode,
    #[serde(default)]
    proxy_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detected_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detected_source: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PersistedProxy {
    mode: ProxyMode,
    proxy_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RenderingAccelerationMode {
    #[default]
    Auto,
    ForceGpu,
    DisableGpu,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SystemRenderingSettings {
    #[serde(default)]
    acceleration_mode: RenderingAccelerationMode,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SystemSettingsStore {
    #[serde(default)]
    proxy: PersistedProxy,
    #[serde(default)]
    rendering: SystemRenderingSettings,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum LogLevel {
    All,
    Off,
    Error,
    Warn,
    #[default]
    Info,
    Debug,
    Trace,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct TargetDirective {
    target: String,
    level: LogLevel,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LogSettings {
    level: LogLevel,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    targets: Vec<TargetDirective>,
}

#[derive(Debug, Clone, Serialize)]
struct LogSettingsView {
    level: LogLevel,
    targets: Vec<TargetDirective>,
    env_locked: bool,
}

#[derive(Debug, Clone, Serialize)]
struct LogRecord {
    seq: u64,
    timestamp_ms: u64,
    level: &'static str,
    target: String,
    message: String,
    #[serde(default)]
    fields: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
struct AppReleaseStatus {
    current_version: String,
    latest_version: Option<String>,
    update_available: bool,
    release_url: Option<String>,
    repository: Option<String>,
    checked: bool,
    error: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    checked_at: String,
}

#[derive(Debug, Clone, Serialize)]
struct ClearLocalDataResponse {
    cleared: bool,
    requires_reload: bool,
}

#[derive(Debug, Clone, Serialize)]
struct WorktreeCleanupStatus {
    current_count: usize,
    threshold: u32,
    should_prompt: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashReportMeta {
    id: String,
    created_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashReportsInfo {
    repository: Option<String>,
    reports: Vec<CrashReportMeta>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimitArgs {
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectIdArgs {
    project_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CrashIdArgs {
    id: String,
}

fn logging_path() -> std::path::PathBuf {
    utils::assets::asset_dir().join("logging.json")
}

fn crashes_dir() -> std::path::PathBuf {
    utils::assets::asset_dir().join("crashes")
}

fn env_level_is_set() -> bool {
    ["VIBEX_LOG", "RUST_LOG"].iter().any(|key| {
        std::env::var(key)
            .ok()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    })
}

fn load_log_settings() -> LogSettings {
    std::fs::read_to_string(logging_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

async fn load_system_store() -> Result<SystemSettingsStore, ApplicationError> {
    let unified_path = utils::assets::settings_path();
    if let Some(store) = read_section(&unified_path, SYSTEM_SECTION)
        .await
        .map_err(internal_error)?
    {
        return Ok(store);
    }
    Ok(SystemSettingsStore::default())
}

async fn save_system_store(store: &SystemSettingsStore) -> Result<(), ApplicationError> {
    write_section(&utils::assets::settings_path(), SYSTEM_SECTION, store)
        .await
        .map_err(internal_error)
}

fn enrich_proxy(persisted: PersistedProxy) -> SystemProxySettings {
    let detected = detect_proxy();
    SystemProxySettings {
        mode: persisted.mode,
        proxy_url: persisted.proxy_url,
        detected_url: detected.as_ref().map(|item| item.url.clone()),
        detected_source: detected
            .as_ref()
            .map(|item| item.source.as_str().to_string()),
    }
}

fn apply_proxy(settings: &PersistedProxy) {
    let detected = detect_proxy();
    let url = match settings.mode {
        ProxyMode::Manual => settings
            .proxy_url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(ToOwned::to_owned),
        ProxyMode::Auto => detected.and_then(|item: DetectedProxy| {
            item.source
                .applies_to_process()
                .then(|| item.url.trim().to_string())
                .filter(|url| !url.is_empty())
        }),
    };
    match url {
        Some(url) => {
            for key in PROXY_URL_ENV_KEYS {
                unsafe { std::env::set_var(key, &url) };
            }
        }
        None => {
            for key in PROXY_URL_ENV_KEYS {
                unsafe { std::env::remove_var(key) };
            }
        }
    }
}

pub(super) fn get_log_settings() -> Result<Value, ApplicationError> {
    let settings = load_log_settings();
    serialize(LogSettingsView {
        level: settings.level,
        targets: settings.targets,
        env_locked: env_level_is_set(),
    })
}

pub(super) fn set_log_settings(args: Value) -> Result<Value, ApplicationError> {
    let settings: LogSettings = unwrap_named(args, &["settings"])?;
    let path = logging_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(internal_error)?;
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&settings).map_err(internal_error)?)
        .map_err(internal_error)?;
    global_host_events().emit("log-settings://changed", &settings);
    serialize(settings)
}

pub(super) async fn get_recent_logs(args: Value) -> Result<Value, ApplicationError> {
    let args: LimitArgs = parse(args).unwrap_or(LimitArgs { limit: None });
    let limit = args.limit.unwrap_or(500).clamp(1, 5_000);
    let dir = utils::assets::logs_dir();
    let mut records = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("log") {
                continue;
            }
            if let Ok(content) = tokio::fs::read_to_string(&path).await {
                for (index, line) in content.lines().rev().take(limit).enumerate() {
                    records.push(LogRecord {
                        seq: index as u64,
                        timestamp_ms: 0,
                        level: "info",
                        target: path
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        message: line.to_string(),
                        fields: Default::default(),
                    });
                }
            }
        }
    }
    records.truncate(limit);
    serialize(records)
}

pub(super) fn get_logs_dir() -> Result<Value, ApplicationError> {
    serialize(utils::assets::logs_dir().to_string_lossy().into_owned())
}

pub(super) async fn get_proxy() -> Result<Value, ApplicationError> {
    serialize(enrich_proxy(load_system_store().await?.proxy))
}

pub(super) async fn update_proxy(args: Value) -> Result<Value, ApplicationError> {
    let settings: SystemProxySettings = unwrap_named(args, &["settings"])?;
    if settings.mode == ProxyMode::Manual
        && settings
            .proxy_url
            .as_deref()
            .map(str::trim)
            .is_none_or(|url| url.is_empty())
    {
        return Err(ApplicationError::bad_request(
            "Proxy URL is required when proxy is set to manual",
        ));
    }
    if let Some(url) = settings.proxy_url.as_deref().map(str::trim).filter(|url| !url.is_empty()) {
        reqwest::Proxy::all(url)
            .map_err(|error| ApplicationError::bad_request(format!("Invalid proxy URL: {error}")))?;
    }
    let persisted = PersistedProxy {
        mode: settings.mode,
        proxy_url: settings
            .proxy_url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(ToOwned::to_owned),
    };
    let mut store = load_system_store().await?;
    store.proxy = persisted.clone();
    save_system_store(&store).await?;
    capture_inherited_proxy();
    apply_proxy(&persisted);
    serialize(enrich_proxy(persisted))
}

pub(super) async fn get_rendering() -> Result<Value, ApplicationError> {
    serialize(load_system_store().await?.rendering)
}

pub(super) async fn update_rendering(args: Value) -> Result<Value, ApplicationError> {
    let settings: SystemRenderingSettings = unwrap_named(args, &["settings"])?;
    let mut store = load_system_store().await?;
    store.rendering = settings.clone();
    save_system_store(&store).await?;
    serialize(settings)
}

pub(super) async fn check_app_release() -> Result<Value, ApplicationError> {
    let current_version = utils::version::APP_VERSION.to_string();
    let repository = std::env::var("VIBEX_UPDATE_REPOSITORY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_UPDATE_REPOSITORY.to_string());
    let url = format!("https://api.github.com/repos/{repository}/releases/latest");
    let client = reqwest::Client::builder()
        .timeout(RELEASE_CHECK_TIMEOUT)
        .build()
        .map_err(internal_error)?;
    match client
        .get(url)
        .header(reqwest::header::USER_AGENT, "VibeX")
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            let body: Value = response.json().await.unwrap_or(Value::Null);
            let latest = body
                .get("tag_name")
                .and_then(Value::as_str)
                .map(|tag| tag.trim_start_matches('v').to_string());
            serialize(AppReleaseStatus {
                current_version: current_version.clone(),
                latest_version: latest.clone(),
                update_available: latest
                    .as_deref()
                    .is_some_and(|latest| latest != current_version),
                release_url: body
                    .get("html_url")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                repository: Some(repository),
                checked: true,
                error: None,
                body: body.get("body").and_then(Value::as_str).map(ToOwned::to_owned),
                published_at: body
                    .get("published_at")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                checked_at: chrono::Utc::now().to_rfc3339(),
            })
        }
        Ok(response) => serialize(AppReleaseStatus {
            current_version,
            latest_version: None,
            update_available: false,
            release_url: None,
            repository: Some(repository),
            checked: false,
            error: Some(format!("GitHub returned {}", response.status())),
            body: None,
            published_at: None,
            checked_at: chrono::Utc::now().to_rfc3339(),
        }),
        Err(error) => serialize(AppReleaseStatus {
            current_version,
            latest_version: None,
            update_available: false,
            release_url: None,
            repository: Some(repository),
            checked: false,
            error: Some(error.to_string()),
            body: None,
            published_at: None,
            checked_at: chrono::Utc::now().to_rfc3339(),
        }),
    }
}

pub(super) async fn worktree_cleanup(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: ProjectIdArgs = parse(args)?;
    Project::find_by_id(&domains.pool, args.project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApplicationError::not_found(format!("Project {} not found", args.project_id)))?;
    let settings = load_project_settings(&utils::assets::settings_path(), args.project_id)
        .await
        .map_err(internal_error)?;
    let workspaces = Workspace::fetch_by_project_id(&domains.pool, args.project_id)
        .await
        .map_err(internal_error)?;
    let current_count = workspaces
        .iter()
        .filter(|workspace| {
            workspace.use_worktree
                && workspace
                    .container_ref
                    .as_deref()
                    .is_some_and(|path| Path::new(path).exists())
        })
        .count();
    serialize(WorktreeCleanupStatus {
        current_count,
        threshold: settings.cleanup_prompt_threshold,
        should_prompt: should_prompt_cleanup(&settings, current_count),
    })
}

pub(super) async fn crash_reports_list() -> Result<Value, ApplicationError> {
    let mut reports = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(crashes_dir()).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("crash-") || !name.ends_with(".txt") {
                continue;
            }
            reports.push(CrashReportMeta {
                created_at_ms: name
                    .trim_start_matches("crash-")
                    .trim_end_matches(".txt")
                    .parse()
                    .ok(),
                id: name,
            });
        }
    }
    reports.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    serialize(CrashReportsInfo {
        repository: Some(DEFAULT_UPDATE_REPOSITORY.to_string()),
        reports,
    })
}

fn checked_crash_path(id: &str) -> Result<std::path::PathBuf, ApplicationError> {
    if !id.starts_with("crash-") || !id.ends_with(".txt") || id.contains(['/', '\\']) {
        return Err(ApplicationError::bad_request(format!(
            "Invalid crash report id: {id}"
        )));
    }
    Ok(crashes_dir().join(id))
}

pub(super) async fn crash_report_read(args: Value) -> Result<Value, ApplicationError> {
    let args: CrashIdArgs = parse(args)?;
    let content = tokio::fs::read_to_string(checked_crash_path(&args.id)?)
        .await
        .map_err(|error| ApplicationError::not_found(format!("Crash report unavailable: {error}")))?;
    serialize(content)
}

pub(super) async fn crash_report_delete(args: Value) -> Result<Value, ApplicationError> {
    let args: CrashIdArgs = parse(args)?;
    match tokio::fs::remove_file(checked_crash_path(&args.id)?).await {
        Ok(()) => Ok(Value::Null),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(internal_error(error)),
    }
}

pub(super) async fn clear_local_app_data(
    domains: &ServerApplicationDomains,
) -> Result<Value, ApplicationError> {
    let running = ExecutionProcess::find_running(&domains.pool)
        .await
        .map_err(internal_error)?;
    if !running.is_empty() {
        domains
            .deployment
            .container()
            .kill_all_running_processes()
            .await
            .map_err(internal_error)?;
        let still_running = ExecutionProcess::find_running(&domains.pool)
            .await
            .map_err(internal_error)?;
        if !still_running.is_empty() {
            return Err(ApplicationError::conflict(
                "Some running processes could not be stopped. Please stop them manually and try again.",
            ));
        }
    }
    let _ = remove_path_if_exists(&utils::assets::profiles_path());
    let _ = remove_path_if_exists(&utils::cache_dir());
    ExecutorConfigs::reload();
    reset_database_rows(&domains.pool).await?;
    let default_config = Config::default();
    let _ = remove_path_if_exists(&utils::assets::settings_path());
    save_config_to_file(&default_config, &utils::assets::settings_path())
        .await
        .map_err(internal_error)?;
    {
        let mut config = domains.deployment.config().write().await;
        *config = default_config;
    }
    WorktreeManager::set_workspace_dir_override(None);
    let _ = load_config_from_file(&utils::assets::settings_path()).await;
    serialize(ClearLocalDataResponse {
        cleared: true,
        requires_reload: true,
    })
}

fn remove_path_if_exists(path: &Path) -> Result<(), ApplicationError> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(internal_error)
    } else {
        std::fs::remove_file(path).map_err(internal_error)
    }
}

async fn reset_database_rows(pool: &sqlx::SqlitePool) -> Result<(), ApplicationError> {
    let mut connection = pool.acquire().await.map_err(internal_error)?;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *connection)
        .await
        .map_err(internal_error)?;
    let table_names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_sqlx_migrations'",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(internal_error)?;
    for table_name in table_names {
        let escaped = table_name.replace('"', "\"\"");
        let statement = format!("DELETE FROM \"{escaped}\"");
        sqlx::query(&statement)
            .execute(&mut *connection)
            .await
            .map_err(internal_error)?;
    }
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *connection)
        .await
        .map_err(internal_error)?;
    drop(connection);
    LegacyAgentMigration::run(pool)
        .await
        .map_err(internal_error)?;
    Ok(())
}
