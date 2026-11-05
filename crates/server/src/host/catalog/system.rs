use std::{path::Path, time::Duration};

use application::ApplicationError;
use db::models::{execution_process::ExecutionProcess, project::Project, workspace::Workspace};
use deployment::Deployment;
use executors::profile::ExecutorConfigs;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::{
    config::{Config, load_config_from_file, publish_config_runtime, save_config_to_file},
    settings_store::{read_section, write_section},
    worktree_manager::WorktreeManager,
    worktree_settings::{load_project_settings, should_prompt_cleanup},
};
use utils::proxy::{DetectedProxy, capture_inherited_proxy, detect_proxy};
use uuid::Uuid;

use super::unwrap_named;
use crate::{
    domains::{ServerApplicationDomains, internal_error, parse, serialize},
    host::events::current_host_events,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&settings).map_err(internal_error)?,
    )
    .map_err(internal_error)?;
    current_host_events().emit("log-settings://changed", &settings);
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
    if let Some(url) = settings
        .proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
    {
        reqwest::Proxy::all(url).map_err(|error| {
            ApplicationError::bad_request(format!("Invalid proxy URL: {error}"))
        })?;
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
                body: body
                    .get("body")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostUpgradeResult {
    from_version: String,
    to_version: String,
}

pub(super) async fn apply_host_upgrade() -> Result<Value, ApplicationError> {
    let current = utils::version::APP_VERSION.to_string();
    let latest = latest_release_version().await?;
    if !utils::version::is_newer(&latest, &current) {
        return Err(ApplicationError::bad_request(
            "Host is already on the latest version",
        ));
    }
    let platform = host_family_platform()?;
    let version = utils::version::normalize(&latest).to_string();
    let archive = format!("VibeX-{version}-{platform}-server.tar.gz");
    let tag = format!("v{version}");
    let repository = std::env::var("VIBEX_UPDATE_REPOSITORY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_UPDATE_REPOSITORY.to_string());
    let canonical = format!("https://github.com/{repository}/releases/download/{tag}/{archive}");
    let bytes = download_release_bytes(&canonical).await?;
    let tmp = utils::path::unique_vibex_scratch_dir("upgrade").map_err(internal_error)?;
    let archive_path = tmp.join(&archive);
    tokio::fs::write(&archive_path, bytes)
        .await
        .map_err(internal_error)?;
    let release_dir = tmp.clone();
    tokio::task::spawn_blocking({
        let archive_path = archive_path.clone();
        let release_dir = release_dir.clone();
        move || extract_tar_gz(&archive_path, &release_dir)
    })
    .await
    .map_err(|error| ApplicationError::internal(error.to_string()))?
    .map_err(internal_error)?;
    let install_dir = std::env::current_exe()
        .map_err(internal_error)?
        .parent()
        .ok_or_else(|| ApplicationError::internal("Host executable has no parent directory"))?
        .to_path_buf();
    let data_dir = std::env::var("VIBEX_DATA_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(utils::assets::asset_dir);
    let plan = crate::plan_host_upgrade(&release_dir, &install_dir, &data_dir)
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    crate::apply_host_upgrade(&plan)
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    schedule_host_restart();
    serialize(HostUpgradeResult {
        from_version: current,
        to_version: version,
    })
}

fn host_family_platform() -> Result<String, ApplicationError> {
    let os = if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "windows"
    } else {
        return Err(ApplicationError::internal(
            "Host upgrades are not supported on this operating system",
        ));
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        return Err(ApplicationError::internal(
            "Host upgrades are not supported on this architecture",
        ));
    };
    Ok(format!("{os}-{arch}"))
}

async fn latest_release_version() -> Result<String, ApplicationError> {
    let status: AppReleaseStatus = serde_json::from_value(check_app_release().await?)
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    status
        .latest_version
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            ApplicationError::internal(
                status
                    .error
                    .unwrap_or_else(|| "latest Host version is unavailable".to_string()),
            )
        })
}

async fn download_release_bytes(canonical: &str) -> Result<Vec<u8>, ApplicationError> {
    let mirrors = [
        "",
        "https://ghfast.top/",
        "https://ghproxy.net/",
        "https://mirror.ghproxy.com/",
    ];
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(internal_error)?;
    let mut last_error = None;
    for prefix in mirrors {
        let url = if prefix.is_empty() {
            canonical.to_string()
        } else {
            format!("{prefix}{canonical}")
        };
        match client
            .get(&url)
            .header(reqwest::header::USER_AGENT, "VibeX")
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                return response
                    .bytes()
                    .await
                    .map(|bytes| bytes.to_vec())
                    .map_err(internal_error);
            }
            Ok(response) => {
                last_error = Some(format!("{} returned {}", url, response.status()));
            }
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    Err(ApplicationError::internal(last_error.unwrap_or_else(
        || "failed to download Host family".to_string(),
    )))
}

fn extract_tar_gz(archive: &Path, destination: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|error| error.to_string())?;
    let decoder = flate2::read::GzDecoder::new(file);
    tar::Archive::new(decoder)
        .unpack(destination)
        .map_err(|error| error.to_string())?;
    if destination.join("SHA256SUMS").is_file() {
        return Ok(());
    }
    let nested = std::fs::read_dir(destination)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .find(|entry| entry.path().join("SHA256SUMS").is_file());
    if let Some(entry) = nested {
        let nested = entry.path();
        for file in std::fs::read_dir(&nested).map_err(|error| error.to_string())? {
            let file = file.map_err(|error| error.to_string())?;
            let _ = std::fs::rename(file.path(), destination.join(file.file_name()));
        }
    }
    Ok(())
}

fn schedule_host_restart() {
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let _ = std::process::Command::new("systemctl")
            .args(["restart", "vibex-server.service"])
            .status();
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "restart", "vibex-server.service"])
            .status();
    });
}

pub(super) async fn worktree_cleanup(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: ProjectIdArgs = parse(args)?;
    Project::find_by_id(&domains.pool, args.project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            ApplicationError::not_found(format!("Project {} not found", args.project_id))
        })?;
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
        .map_err(|error| {
            ApplicationError::not_found(format!("Crash report unavailable: {error}"))
        })?;
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
    db::reset_local_database(&domains.pool)
        .await
        .map_err(internal_error)?;
    let default_config = Config::default();
    let _ = remove_path_if_exists(&utils::assets::settings_path());
    save_config_to_file(&default_config, &utils::assets::settings_path())
        .await
        .map_err(internal_error)?;
    publish_config_runtime(&default_config).await;
    crate::apply_host_multi_agent_setting(
        domains
            .plugin_control_plane
            .official_product_mcp_gate()
            .as_ref(),
        domains.delegation_broker.as_deref(),
        &default_config,
    );
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SystemDataDirSettingsView {
    current_data_dir: String,
    default_data_dir: String,
    is_custom: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SystemDataDirUpdateResponse {
    current_data_dir: String,
    default_data_dir: String,
    is_custom: bool,
    migrated: bool,
    requires_reload: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct UpdateDataDirArgs {
    #[serde(alias = "dataDir")]
    data_dir: String,
}

pub(super) fn get_data_dir_settings() -> Result<Value, ApplicationError> {
    let settings = utils::assets::get_data_dir_settings();
    serialize(SystemDataDirSettingsView {
        current_data_dir: settings.current_data_dir.to_string_lossy().into_owned(),
        default_data_dir: settings.default_data_dir.to_string_lossy().into_owned(),
        is_custom: settings.is_custom,
    })
}

pub(super) async fn update_data_dir_settings(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let parsed: UpdateDataDirArgs = unwrap_named(args, &["settings", "payload"])?;
    let current = utils::assets::get_data_dir_settings();
    let target_dir = validate_target_data_dir(&parsed.data_dir, &current.current_data_dir)?;

    if same_directory_path(&current.current_data_dir, &target_dir) {
        return serialize(SystemDataDirUpdateResponse {
            current_data_dir: current.current_data_dir.to_string_lossy().into_owned(),
            default_data_dir: current.default_data_dir.to_string_lossy().into_owned(),
            is_custom: current.is_custom,
            migrated: false,
            requires_reload: false,
        });
    }

    let old_data_dir = current.current_data_dir.clone();

    // 1. Remap active pool paths and checkpoint WAL before copying db.sqlite
    remap_sqlite_data_dir_paths(&domains.pool, &old_data_dir, &target_dir).await?;
    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&domains.pool)
        .await;

    // 2. Copy all files and subdirectories from old_data_dir to target_dir
    let src_for_copy = old_data_dir.clone();
    let dst_for_copy = target_dir.clone();
    tokio::task::spawn_blocking(move || copy_data_dir_tree(&src_for_copy, &dst_for_copy))
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))??;

    // 3. Remap paths in copied target_dir/db.sqlite and target_dir/settings.json
    let target_db_path = target_dir.join("db.sqlite");
    if target_db_path.is_file() {
        remap_sqlite_file_data_dir_paths(&target_db_path, &old_data_dir, &target_dir).await?;
    }
    remap_settings_json_paths(&target_dir.join("settings.json"), &old_data_dir, &target_dir)?;

    // 4. Persist custom_data_dir in bootstrap.json
    let updated = utils::assets::set_custom_data_dir(Some(&target_dir)).map_err(internal_error)?;

    serialize(SystemDataDirUpdateResponse {
        current_data_dir: updated.current_data_dir.to_string_lossy().into_owned(),
        default_data_dir: updated.default_data_dir.to_string_lossy().into_owned(),
        is_custom: updated.is_custom,
        migrated: true,
        requires_reload: true,
    })
}

fn normalize_dir_for_comparison(path: &Path) -> std::path::PathBuf {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    utils::path::normalize_windows_extended_path_prefix(canonical)
}

fn same_directory_path(a: &Path, b: &Path) -> bool {
    let norm_a = normalize_dir_for_comparison(a);
    let norm_b = normalize_dir_for_comparison(b);
    if cfg!(windows) {
        norm_a
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .eq_ignore_ascii_case(norm_b.to_string_lossy().trim_end_matches(['\\', '/']))
    } else {
        norm_a == norm_b
    }
}

fn is_strict_subdirectory(candidate: &Path, parent: &Path) -> bool {
    if same_directory_path(candidate, parent) {
        return false;
    }
    let norm_parent = normalize_dir_for_comparison(parent);
    let norm_candidate = if candidate.exists() {
        normalize_dir_for_comparison(candidate)
    } else {
        utils::path::normalize_windows_extended_path_prefix(candidate.to_path_buf())
    };
    if cfg!(windows) {
        let parent_prefix = format!(
            "{}\\",
            norm_parent
                .to_string_lossy()
                .trim_end_matches(['\\', '/'])
                .replace('/', "\\")
                .to_ascii_lowercase()
        );
        let candidate_str = norm_candidate
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        candidate_str.starts_with(&parent_prefix)
    } else {
        norm_candidate.starts_with(&norm_parent)
    }
}

pub(crate) fn validate_target_data_dir(
    raw_path: &str,
    current_data_dir: &Path,
) -> Result<std::path::PathBuf, ApplicationError> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(ApplicationError::bad_request(
            "Data directory path cannot be empty",
        ));
    }
    let path = std::path::PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(ApplicationError::bad_request(
            "Data directory path must be an absolute path",
        ));
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(ApplicationError::bad_request(
            "Data directory path cannot contain '..' traversal segments",
        ));
    }
    if is_strict_subdirectory(&path, current_data_dir) {
        return Err(ApplicationError::bad_request(
            "Target data directory cannot be inside the current data directory",
        ));
    }
    if !utils::assets::probe_writable_dir(&path) {
        return Err(ApplicationError::bad_request(
            "Target data directory cannot be created or is not writable",
        ));
    }
    Ok(normalize_dir_for_comparison(&path))
}

pub(crate) fn copy_data_dir_tree(src: &Path, dst: &Path) -> Result<(), ApplicationError> {
    if !src.exists() {
        std::fs::create_dir_all(dst).map_err(internal_error)?;
        return Ok(());
    }
    std::fs::create_dir_all(dst).map_err(internal_error)?;
    // Remove stale WAL/SHM in destination before copying checkpointed db.sqlite
    let _ = std::fs::remove_file(dst.join("db.sqlite-wal"));
    let _ = std::fs::remove_file(dst.join("db.sqlite-shm"));
    copy_dir_recursive_inner(src, dst)
}

fn copy_dir_recursive_inner(src: &Path, dst: &Path) -> Result<(), ApplicationError> {
    std::fs::create_dir_all(dst).map_err(internal_error)?;
    for entry in std::fs::read_dir(src).map_err(internal_error)? {
        let entry = entry.map_err(internal_error)?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name.starts_with(".vibex-write-probe-")
            || name == "db.sqlite-wal"
            || name == "db.sqlite-shm"
        {
            continue;
        }
        let from_path = entry.path();
        if same_directory_path(&from_path, dst) {
            continue;
        }
        let to_path = dst.join(&file_name);
        let file_type = entry.file_type().map_err(internal_error)?;
        if file_type.is_dir() {
            copy_dir_recursive_inner(&from_path, &to_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&from_path, &to_path).map_err(internal_error)?;
        }
    }
    Ok(())
}

pub(crate) async fn remap_sqlite_file_data_dir_paths(
    db_file: &Path,
    old_dir: &Path,
    new_dir: &Path,
) -> Result<(), ApplicationError> {
    use std::str::FromStr;
    let options = sqlx::sqlite::SqliteConnectOptions::from_str(&format!(
        "sqlite://{}",
        db_file.to_string_lossy()
    ))
    .map_err(internal_error)?
    .create_if_missing(false);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(internal_error)?;
    let res = remap_sqlite_data_dir_paths(&pool, old_dir, new_dir).await;
    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool)
        .await;
    pool.close().await;
    res
}

pub(crate) async fn remap_sqlite_data_dir_paths(
    pool: &sqlx::SqlitePool,
    old_dir: &Path,
    new_dir: &Path,
) -> Result<(), ApplicationError> {
    let old_native = old_dir
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_string();
    let new_native = new_dir
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_string();
    if old_native.is_empty() || old_native == new_native {
        return Ok(());
    }

    let old_slash = old_native.replace('\\', "/");
    let new_slash = new_native.replace('\\', "/");
    let old_backslash = old_native.replace('/', "\\");
    let new_backslash = new_native.replace('/', "\\");

    let targets = [
        ("workspaces", "container_ref"),
        ("workspaces", "agent_working_dir"),
        ("repos", "path"),
        ("projects", "root_path"),
        ("collaboration_space_collection_items", "file_path"),
    ];

    let mut pairs = vec![(old_slash.clone(), new_slash.clone())];
    if old_backslash != old_slash || new_backslash != new_slash {
        pairs.push((old_backslash, new_backslash));
    }

    for (table, column) in targets {
        for (old_base, new_base) in &pairs {
            let exact_sql = format!("UPDATE {table} SET {column} = ?1 WHERE {column} = ?2");
            let _ = sqlx::query(&exact_sql)
                .bind(new_base)
                .bind(old_base)
                .execute(pool)
                .await;

            for sep in ['/', '\\'] {
                let old_prefix = format!("{old_base}{sep}");
                let new_prefix = format!("{new_base}{sep}");
                let prefix_sql = format!(
                    "UPDATE {table} SET {column} = ?1 || substr({column}, length(?2) + 1) \
                     WHERE {column} IS NOT NULL AND substr({column}, 1, length(?2)) = ?2"
                );
                let _ = sqlx::query(&prefix_sql)
                    .bind(&new_prefix)
                    .bind(&old_prefix)
                    .execute(pool)
                    .await;
            }
        }
    }
    Ok(())
}

pub(crate) fn remap_path_string_prefix(value: &str, old_dir: &Path, new_dir: &Path) -> Option<String> {
    let old_native = old_dir
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_string();
    let new_native = new_dir
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_string();
    if old_native.is_empty() {
        return None;
    }
    let old_slash = old_native.replace('\\', "/");
    let new_slash = new_native.replace('\\', "/");
    let old_backslash = old_native.replace('/', "\\");
    let new_backslash = new_native.replace('/', "\\");

    for (old_base, new_base) in [(&old_slash, &new_slash), (&old_backslash, &new_backslash)] {
        if value == old_base {
            return Some(new_base.clone());
        }
        for sep in ['/', '\\'] {
            let old_prefix = format!("{old_base}{sep}");
            if let Some(rest) = value.strip_prefix(&old_prefix) {
                return Some(format!("{new_base}{sep}{rest}"));
            }
        }
    }
    None
}

pub(crate) fn remap_settings_json_paths(
    settings_file: &Path,
    old_dir: &Path,
    new_dir: &Path,
) -> Result<(), ApplicationError> {
    if !settings_file.is_file() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(settings_file).map_err(internal_error)?;
    let Ok(mut root) = serde_json::from_str::<Value>(&raw) else {
        return Ok(());
    };
    let mut changed = false;
    if let Some(obj) = root.as_object_mut() {
        if let Some(Value::String(ws_dir)) = obj.get_mut("workspace_dir")
            && let Some(remapped) = remap_path_string_prefix(ws_dir, old_dir, new_dir)
        {
            *ws_dir = remapped;
            changed = true;
        }
        if let Some(Value::Object(config_obj)) = obj.get_mut("config")
            && let Some(Value::String(ws_dir)) = config_obj.get_mut("workspace_dir")
            && let Some(remapped) = remap_path_string_prefix(ws_dir, old_dir, new_dir)
        {
            *ws_dir = remapped;
            changed = true;
        }
    }
    if changed {
        let encoded = serde_json::to_vec_pretty(&root).map_err(internal_error)?;
        std::fs::write(settings_file, encoded).map_err(internal_error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn copy_and_remap_data_dir_migrates_files_and_rewrites_sqlite_and_settings_paths() {
        let temp = tempfile::tempdir().expect("tempdir");
        let old_dir = temp.path().join("old_data");
        let new_dir = temp.path().join("new_data");
        std::fs::create_dir_all(old_dir.join("worktrees/wt-1")).expect("mkdir worktrees");
        std::fs::write(old_dir.join("worktrees/wt-1/README.md"), b"# Migrated").expect("write");
        std::fs::write(
            old_dir.join("settings.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "workspace_dir": format!("{}/worktrees", old_dir.to_string_lossy()),
            }))
            .unwrap(),
        )
        .expect("write settings.json");

        // Create a SQLite DB in old_dir with the target tables/columns
        let db_path = old_dir.join("db.sqlite");
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true),
            )
            .await
            .expect("open sqlite");

        sqlx::query("CREATE TABLE workspaces (id TEXT PRIMARY KEY, container_ref TEXT, agent_working_dir TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE projects (id TEXT PRIMARY KEY, root_path TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE collaboration_space_collection_items (id TEXT PRIMARY KEY, file_path TEXT)")
            .execute(&pool)
            .await
            .unwrap();

        let old_wt = format!("{}/worktrees/wt-1", old_dir.to_string_lossy());
        let old_repo = format!("{}\\repos\\repo-1", old_dir.to_string_lossy());
        let external_repo = "D:/external/project".to_string();
        let old_doc = format!("{}/spaces/sp-1/doc.md", old_dir.to_string_lossy());

        sqlx::query("INSERT INTO workspaces (id, container_ref, agent_working_dir) VALUES ('w1', ?1, ?1)")
            .bind(&old_wt)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO repos (id, path) VALUES ('r1', ?1), ('r2', ?2)")
            .bind(&old_repo)
            .bind(&external_repo)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO projects (id, root_path) VALUES ('p1', ?1)")
            .bind(&old_repo)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO collaboration_space_collection_items (id, file_path) VALUES ('c1', ?1)")
            .bind(&old_doc)
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let validated_target = validate_target_data_dir(&new_dir.to_string_lossy(), &old_dir)
            .expect("validate target dir");
        copy_data_dir_tree(&old_dir, &validated_target).expect("copy tree");
        remap_sqlite_file_data_dir_paths(
            &validated_target.join("db.sqlite"),
            &old_dir,
            &validated_target,
        )
        .await
        .expect("remap sqlite");
        remap_settings_json_paths(
            &validated_target.join("settings.json"),
            &old_dir,
            &validated_target,
        )
        .expect("remap settings.json");

        assert!(validated_target.join("worktrees/wt-1/README.md").is_file());

        let check_pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(validated_target.join("db.sqlite")),
            )
            .await
            .expect("open migrated sqlite");

        let migrated_wt: String =
            sqlx::query_scalar("SELECT container_ref FROM workspaces WHERE id = 'w1'")
                .fetch_one(&check_pool)
                .await
                .unwrap();
        assert!(
            migrated_wt.ends_with("worktrees/wt-1"),
            "unexpected container_ref: {migrated_wt}"
        );
        assert!(!migrated_wt.contains("old_data"));

        let migrated_repo: String = sqlx::query_scalar("SELECT path FROM repos WHERE id = 'r1'")
            .fetch_one(&check_pool)
            .await
            .unwrap();
        assert!(!migrated_repo.contains("old_data"));

        let untouched_external: String =
            sqlx::query_scalar("SELECT path FROM repos WHERE id = 'r2'")
                .fetch_one(&check_pool)
                .await
                .unwrap();
        assert_eq!(untouched_external, external_repo);

        let migrated_doc: String = sqlx::query_scalar(
            "SELECT file_path FROM collaboration_space_collection_items WHERE id = 'c1'",
        )
        .fetch_one(&check_pool)
        .await
        .unwrap();
        assert!(!migrated_doc.contains("old_data"));
        check_pool.close().await;

        let migrated_settings: Value = serde_json::from_str(
            &std::fs::read_to_string(validated_target.join("settings.json")).unwrap(),
        )
        .unwrap();
        let ws_dir = migrated_settings["workspace_dir"].as_str().unwrap();
        assert!(!ws_dir.contains("old_data"));

        // Subdirectory of current_data_dir must be rejected
        let nested = old_dir.join("nested_target");
        assert!(validate_target_data_dir(&nested.to_string_lossy(), &old_dir).is_err());
    }
}
