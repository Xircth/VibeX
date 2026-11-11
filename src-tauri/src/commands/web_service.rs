use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, LazyLock},
};

use axum::Router;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::{net::TcpListener, sync::Mutex, task::JoinHandle};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

const SETTINGS_FILE_NAME: &str = "web-service-settings.json";
const SETTINGS_SECTION: &str = "web_service";
const DEFAULT_PORT: u16 = 17891;

static WEB_SERVICE_RUNTIME: LazyLock<Mutex<Option<WebServiceRuntime>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(Debug)]
struct WebServiceRuntime {
    port: u16,
    address: String,
    addresses: Vec<String>,
    listen_addresses: Vec<utils::net::AdvertisedListenAddress>,
    allow_lan: bool,
    started_at: String,
    handles: Vec<JoinHandle<()>>,
    serves_web_ui: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServiceConfig {
    pub port: u16,
    pub token: Option<String>,
    pub auto_start: bool,
    #[serde(default)]
    pub allow_lan: bool,
}

impl Default for WebServiceConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            token: None,
            auto_start: true,
            allow_lan: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServerStatus {
    pub running: bool,
    pub port: u16,
    pub address: Option<String>,
    #[serde(default)]
    pub addresses: Vec<String>,
    #[serde(default)]
    pub listen_addresses: Vec<utils::net::AdvertisedListenAddress>,
    pub token_configured: bool,
    pub started_at: Option<String>,
    pub message: Option<String>,
    #[serde(default)]
    pub host_id: Option<String>,
    #[serde(default)]
    pub reachability: Vec<remote_protocol::ReachabilityOrigin>,
    #[serde(default)]
    pub serves_web_ui: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortProbeResult {
    pub port: u16,
    pub available: bool,
    pub message: Option<String>,
}

fn legacy_settings_path() -> PathBuf {
    utils::assets::asset_dir().join(SETTINGS_FILE_NAME)
}

fn validate_port(port: u16) -> Result<(), AppError> {
    if port == 0 {
        return Err(AppError::BadRequest(
            "Web service port must be between 1 and 65535".to_string(),
        ));
    }
    Ok(())
}

fn normalize_config(mut config: WebServiceConfig) -> Result<WebServiceConfig, AppError> {
    validate_port(config.port)?;
    config.token = config
        .token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    Ok(config)
}

async fn load_config() -> Result<WebServiceConfig, AppError> {
    if let Some(config) = services::services::settings_store::read_section(
        &utils::assets::settings_path(),
        SETTINGS_SECTION,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
    {
        return normalize_config(config);
    }

    let legacy_path = legacy_settings_path();
    let config = if legacy_path.exists() {
        let content = tokio::fs::read_to_string(&legacy_path)
            .await
            .map_err(|error| {
                AppError::Internal(format!(
                    "Failed to read web service settings {}: {error}",
                    legacy_path.display()
                ))
            })?;
        serde_json::from_str(&content).map_err(|error| {
            AppError::Internal(format!(
                "Invalid web service settings {}: {error}",
                legacy_path.display()
            ))
        })?
    } else {
        WebServiceConfig::default()
    };
    services::services::settings_store::write_section(
        &utils::assets::settings_path(),
        SETTINGS_SECTION,
        &config,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    normalize_config(config)
}

async fn save_config(config: &WebServiceConfig) -> Result<WebServiceConfig, AppError> {
    let config = normalize_config(config.clone())?;
    services::services::settings_store::write_section(
        &utils::assets::settings_path(),
        SETTINGS_SECTION,
        &config,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(config)
}

fn advertised_listen_addresses(
    port: u16,
    allow_lan: bool,
) -> Vec<utils::net::AdvertisedListenAddress> {
    utils::net::advertised_listen_addresses(port, allow_lan)
}

fn advertised_addresses(port: u16, allow_lan: bool) -> Vec<String> {
    advertised_listen_addresses(port, allow_lan)
        .into_iter()
        .map(|address| address.origin)
        .collect()
}

#[cfg(test)]
fn reachability_from_addresses(addresses: &[String]) -> Vec<remote_protocol::ReachabilityOrigin> {
    crate::commands::host_tunnel::merge_host_reachability(addresses, Vec::new())
}

async fn composed_reachability(addresses: &[String]) -> Vec<remote_protocol::ReachabilityOrigin> {
    crate::commands::host_tunnel::merge_host_reachability(
        addresses,
        crate::commands::host_tunnel::published_origins().await,
    )
}

async fn load_or_create_host_id() -> Result<String, AppError> {
    tokio::task::spawn_blocking(|| {
        utils::assets::load_or_create_host_id(&utils::assets::asset_dir())
    })
    .await
    .map_err(|error| AppError::Internal(format!("Failed to persist host identity: {error}")))?
    .map_err(|error| AppError::Internal(format!("Failed to persist host identity: {error}")))
}

fn resolve_static_root(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    if let Ok(root) = std::env::var("VIBEX_STATIC_ROOT") {
        let path = PathBuf::from(root);
        if path.join("index.html").is_file() {
            return Some(path);
        }
    }
    let mut roots = Vec::new();
    if let Some(app) = app
        && let Ok(dir) = app.path().resource_dir()
    {
        roots.push(dir.join("web"));
        roots.push(dir.join("../web"));
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut current = exe.parent().map(PathBuf::from);
        while let Some(dir) = current {
            roots.push(dir.join("web"));
            roots.push(dir.join("frontend/dist"));
            current = dir.parent().map(PathBuf::from);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut current = Some(cwd);
        while let Some(dir) = current {
            roots.push(dir.join("web"));
            roots.push(dir.join("frontend/dist"));
            current = dir.parent().map(PathBuf::from);
        }
    }
    roots
        .into_iter()
        .find(|path| path.join("index.html").is_file())
}

fn issue_host_token() -> server::ServerToken {
    server::ServerToken::new(format!(
        "vbx_{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    ))
}

async fn status_from_runtime(config: WebServiceConfig) -> WebServerStatus {
    let host_id = load_or_create_host_id().await.ok();
    let snapshot = {
        let runtime = WEB_SERVICE_RUNTIME.lock().await;
        runtime.as_ref().map(|runtime| {
            (
                runtime.port,
                runtime.address.clone(),
                runtime.addresses.clone(),
                runtime.listen_addresses.clone(),
                runtime.started_at.clone(),
                runtime.serves_web_ui,
            )
        })
    };
    if let Some((port, address, addresses, listen_addresses, started_at, serves_web_ui)) = snapshot
    {
        let reachability = composed_reachability(&addresses).await;
        return WebServerStatus {
            running: true,
            port,
            address: Some(address),
            addresses,
            listen_addresses,
            token_configured: config.token.is_some(),
            started_at: Some(started_at),
            message: None,
            host_id,
            reachability,
            serves_web_ui,
        };
    }

    WebServerStatus {
        running: false,
        port: config.port,
        address: None,
        addresses: Vec::new(),
        listen_addresses: Vec::new(),
        token_configured: config.token.is_some(),
        started_at: None,
        message: None,
        host_id,
        reachability: Vec::new(),
        serves_web_ui: true,
    }
}

#[tauri::command]
pub async fn get_web_service_config() -> Result<WebServiceConfig, AppError> {
    load_config().await
}

#[tauri::command]
pub async fn update_web_service_config(
    app: tauri::AppHandle,
    config: WebServiceConfig,
) -> Result<WebServiceConfig, AppError> {
    let previous = load_config().await?;
    let normalized = normalize_config(config)?;
    if let Some(raw) = normalized.token.as_deref() {
        let token = server::ServerToken::try_new(raw.to_string()).map_err(|_| {
            AppError::BadRequest(
                "Host token must contain at least 32 characters with mixed values".to_string(),
            )
        })?;
        server::SqliteTokenHashStore::new(app.state::<AppState>().deployment.db().pool.clone())
            .provision(Some(token))
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
    }
    let saved = save_config(&normalized).await?;
    let running = WEB_SERVICE_RUNTIME.lock().await.is_some();
    if running && (previous.allow_lan != saved.allow_lan || previous.port != saved.port) {
        stop_web_server_with_config(saved.clone()).await;
        if let Err(error) = start_web_server(app.clone()).await {
            let _ = save_config(&previous).await;
            let _ = start_web_server(app).await;
            return Err(error);
        }
    }
    Ok(saved)
}

#[tauri::command]
pub async fn get_web_server_status() -> Result<WebServerStatus, AppError> {
    let config = load_config().await?;
    Ok(status_from_runtime(config).await)
}

#[tauri::command]
pub async fn start_web_server(app: tauri::AppHandle) -> Result<WebServerStatus, AppError> {
    let mut config = load_config().await?;
    let state = app.state::<AppState>();
    let pool = state.deployment.db().pool.clone();
    let store = server::SqliteTokenHashStore::new(pool.clone());
    let supplied = config
        .token
        .as_deref()
        .and_then(|value| server::ServerToken::try_new(value.to_string()).ok());
    let provisioned = store
        .provision(supplied)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    if let Some(issued) = provisioned.issued_token {
        config.token = Some(issued.expose_once());
        config = save_config(&config).await?;
    }
    {
        let runtime = WEB_SERVICE_RUNTIME.lock().await;
        if let Some(current) = runtime.as_ref()
            && current.allow_lan == config.allow_lan
            && current.port == config.port
        {
            drop(runtime);
            return Ok(status_from_runtime(config).await);
        }
    }
    if WEB_SERVICE_RUNTIME.lock().await.is_some() {
        stop_web_server_with_config(config.clone()).await;
    }
    let listen = std::net::SocketAddr::from((
        if config.allow_lan {
            std::net::Ipv4Addr::UNSPECIFIED
        } else {
            std::net::Ipv4Addr::LOCALHOST
        },
        config.port,
    ));
    let host_id = load_or_create_host_id().await?;
    let advertised = advertised_addresses(config.port, config.allow_lan);
    let mut server_config = server::ServerConfig::default()
        .with_listen_addr(listen, config.allow_lan)
        .map_err(|error| AppError::BadRequest(error.to_string()))?
        .with_host_identity(host_id, composed_reachability(&advertised).await);
    let static_root = resolve_static_root(Some(&app));
    let serves_web_ui = if let Some(static_root) = static_root {
        server_config = server_config.with_static_root(static_root);
        true
    } else if app.asset_resolver().get("index.html".to_string()).is_some() {
        let resolver_app = app.clone();
        server_config = server_config.with_static_asset_resolver(Arc::new(move |path| {
            resolver_app
                .asset_resolver()
                .get(path.to_string())
                .map(|asset| server::EmbeddedAsset {
                    bytes: asset.bytes,
                    mime_type: asset.mime_type,
                })
        }));
        true
    } else {
        false
    };
    let runtime = server::ServerRuntime::from_host(
        server_config,
        Arc::new(server::SqliteServerAuth::new(
            state.deployment.db().pool.clone(),
        )),
        state.host.clone(),
        state.local_deployment.pty().clone(),
    );
    start_web_server_with_router(config, runtime.router(), serves_web_ui).await
}

async fn bind_web_service_listeners(
    port: u16,
    allow_lan: bool,
) -> Result<(Vec<TcpListener>, SocketAddr), AppError> {
    let bind_ip = server::ServerConfig::bind_ip(allow_lan);
    match TcpListener::bind((bind_ip, port)).await {
        Ok(listener) => {
            let local_addr = listener.local_addr().map_err(|error| {
                AppError::Internal(format!("Failed to read web service address: {error}"))
            })?;
            Ok((vec![listener], local_addr))
        }
        Err(error) if !allow_lan => Err(AppError::Conflict(format!(
            "Failed to bind web service on {bind_ip}:{port}: {error}"
        ))),
        Err(wildcard_error) => {
            let loopback_listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
                .await
                .map_err(|_| {
                    AppError::Conflict(format!(
                        "Failed to bind web service on {bind_ip}:{port}: {wildcard_error}"
                    ))
                })?;
            let local_addr = loopback_listener.local_addr().map_err(|error| {
                AppError::Internal(format!("Failed to read web service address: {error}"))
            })?;
            let bound_port = local_addr.port();
            let mut listeners = vec![loopback_listener];
            let candidate_lan_ips = advertised_listen_addresses(bound_port, true)
                .into_iter()
                .filter(|item| item.interface != "loopback" && item.family == "ipv4")
                .filter_map(|item| item.ip.parse::<std::net::Ipv4Addr>().ok())
                .collect::<Vec<_>>();
            for lan_ip in &candidate_lan_ips {
                if let Ok(listener) = TcpListener::bind((*lan_ip, bound_port)).await {
                    listeners.push(listener);
                }
            }
            if !candidate_lan_ips.is_empty() && listeners.len() == 1 {
                return Err(AppError::Conflict(format!(
                    "Failed to bind web service on {bind_ip}:{port}: {wildcard_error}"
                )));
            }
            Ok((listeners, local_addr))
        }
    }
}

async fn start_web_server_with_router(
    config: WebServiceConfig,
    service_router: Router,
    serves_web_ui: bool,
) -> Result<WebServerStatus, AppError> {
    validate_port(config.port)?;

    {
        let runtime = WEB_SERVICE_RUNTIME.lock().await;
        if runtime.is_some() {
            drop(runtime);
            return Ok(status_from_runtime(config).await);
        }
    }

    let (listeners, local_addr) = bind_web_service_listeners(config.port, config.allow_lan).await?;
    let listen_addresses = advertised_listen_addresses(local_addr.port(), config.allow_lan);
    let addresses = listen_addresses
        .iter()
        .map(|item| item.origin.clone())
        .collect::<Vec<_>>();
    let address = addresses
        .first()
        .cloned()
        .unwrap_or_else(|| format!("http://{local_addr}"));
    let started_at = Utc::now().to_rfc3339();
    let mut handles = Vec::with_capacity(listeners.len());
    for listener in listeners {
        let router = service_router.clone();
        handles.push(tokio::spawn(async move {
            let listener = axum::serve::ListenerExt::tap_io(listener, |tcp_stream| {
                let _ = tcp_stream.set_nodelay(true);
            });
            if let Err(error) = axum::serve(listener, router).await {
                tracing::warn!("VibeX web service stopped with error: {}", error);
            }
        }));
    }

    let mut runtime = WEB_SERVICE_RUNTIME.lock().await;
    *runtime = Some(WebServiceRuntime {
        port: local_addr.port(),
        address,
        addresses,
        listen_addresses,
        allow_lan: config.allow_lan,
        started_at,
        handles,
        serves_web_ui,
    });
    drop(runtime);
    crate::commands::host_tunnel::sync_relay().await;

    Ok(status_from_runtime(config).await)
}

#[tauri::command]
pub async fn stop_web_server() -> Result<WebServerStatus, AppError> {
    let config = load_config().await?;
    Ok(stop_web_server_with_config(config).await)
}

async fn stop_web_server_with_config(config: WebServiceConfig) -> WebServerStatus {
    let removed = {
        let mut runtime = WEB_SERVICE_RUNTIME.lock().await;
        runtime.take()
    };
    if let Some(runtime) = removed {
        for handle in runtime.handles {
            handle.abort();
            let _ = handle.await;
        }
    }
    crate::commands::host_tunnel::stop_quick_tunnel().await;
    status_from_runtime(config).await
}

#[tauri::command]
pub async fn probe_web_service_port(port: u16) -> Result<PortProbeResult, AppError> {
    validate_port(port)?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    match TcpListener::bind(addr).await {
        Ok(listener) => {
            drop(listener);
            Ok(PortProbeResult {
                port,
                available: true,
                message: None,
            })
        }
        Err(error) => Ok(PortProbeResult {
            port,
            available: false,
            message: Some(error.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn generate_web_service_token(
    app: tauri::AppHandle,
) -> Result<WebServiceConfig, AppError> {
    let mut config = load_config().await?;
    let plaintext = issue_host_token().expose_once();
    let store =
        server::SqliteTokenHashStore::new(app.state::<AppState>().deployment.db().pool.clone());
    let persisted = server::ServerToken::try_new(plaintext.clone())
        .map_err(|error| AppError::Internal(error.to_string()))?;
    store
        .provision(Some(persisted))
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    config.token = Some(plaintext);
    save_config(&config).await
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateHostPairingRequest {
    pub preset: Option<String>,
    #[serde(default)]
    pub ttl_seconds: Option<i64>,
}

#[tauri::command]
pub async fn create_host_device_pairing(
    app: tauri::AppHandle,
    request: CreateHostPairingRequest,
) -> Result<remote_protocol::IssuedPairingInvitation, AppError> {
    let preset = match request.preset.as_deref() {
        None | Some("") => remote_protocol::DevicePermissionPreset::Workstation,
        Some("companion") => remote_protocol::DevicePermissionPreset::Companion,
        Some("workstation") => remote_protocol::DevicePermissionPreset::Workstation,
        Some(other) => {
            return Err(AppError::BadRequest(format!(
                "unknown pairing preset: {other}"
            )));
        }
    };
    use server::ServerAuth;
    let auth = server::SqliteServerAuth::new(app.state::<AppState>().deployment.db().pool.clone());
    let creator = server::AuthenticatedCredential::host_console_owner();
    let challenge = auth
        .create_pairing(
            &creator,
            remote_protocol::CreatePairingRequest {
                preset: Some(preset),
                requested_scopes: Vec::new(),
                ttl_seconds: request.ttl_seconds,
            },
        )
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    // A device that pairs expects to find this Host again after a restart.
    if let Ok(mut config) = load_config().await
        && !config.auto_start
    {
        config.auto_start = true;
        save_config(&config).await?;
    }
    let host_id = load_or_create_host_id().await?;
    let addresses = {
        let runtime = WEB_SERVICE_RUNTIME.lock().await;
        runtime
            .as_ref()
            .map(|current| current.addresses.clone())
            .unwrap_or_default()
    };
    let reachability = composed_reachability(&addresses).await;
    let payload = remote_protocol::PairingInvitationPayload::from_challenge(
        host_id,
        preset,
        &challenge,
        reachability,
    );
    let issued = remote_protocol::IssuedPairingInvitation::from_payload(challenge, payload);
    let code_for_beacon = issued.connection_code.clone();
    let host_id_for_beacon = issued.host_id.clone();
    tokio::spawn(async move {
        crate::commands::host_tunnel::publish_pairing_code_beacon(
            &code_for_beacon,
            &host_id_for_beacon,
        )
        .await;
    });
    Ok(issued)
}

#[tauri::command]
pub async fn list_host_devices(
    app: tauri::AppHandle,
) -> Result<Vec<server::PairedDeviceRecord>, AppError> {
    use server::ServerAuth;
    let auth = server::SqliteServerAuth::new(app.state::<AppState>().deployment.db().pool.clone());
    auth.list_devices(&server::AuthenticatedCredential::host_console_owner())
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[tauri::command]
pub async fn list_host_connect_requests(
    app: tauri::AppHandle,
) -> Result<Vec<remote_protocol::PendingDeviceConnectRequest>, AppError> {
    use server::ServerAuth;
    let auth = server::SqliteServerAuth::new(app.state::<AppState>().deployment.db().pool.clone());
    auth.list_connect_requests(&server::AuthenticatedCredential::host_console_owner())
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[derive(Debug, Clone, Deserialize)]
pub struct RespondHostConnectRequest {
    pub request_id: String,
    pub approve: bool,
}

#[tauri::command]
pub async fn respond_host_connect_request(
    app: tauri::AppHandle,
    request: RespondHostConnectRequest,
) -> Result<(), AppError> {
    let request_id = request
        .request_id
        .parse::<remote_protocol::PairingId>()
        .map_err(|error| AppError::BadRequest(format!("invalid connect request id: {error}")))?;
    use server::ServerAuth;
    let auth = server::SqliteServerAuth::new(app.state::<AppState>().deployment.db().pool.clone());
    auth.respond_connect_request(
        &server::AuthenticatedCredential::host_console_owner(),
        request_id,
        request.approve,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))
}

#[derive(Debug, Clone, Deserialize)]
pub struct RevokeHostDeviceRequest {
    pub device_id: String,
}

#[tauri::command]
pub async fn revoke_host_device(
    app: tauri::AppHandle,
    request: RevokeHostDeviceRequest,
) -> Result<remote_protocol::RevokeDeviceResponse, AppError> {
    let device_id = request
        .device_id
        .parse::<remote_protocol::DeviceId>()
        .map_err(|error| AppError::BadRequest(format!("invalid device id: {error}")))?;
    use server::ServerAuth;
    let auth = server::SqliteServerAuth::new(app.state::<AppState>().deployment.db().pool.clone());
    auth.revoke_device(
        &server::AuthenticatedCredential::host_console_owner(),
        device_id,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))
}

pub(crate) async fn listening_port() -> Option<u16> {
    WEB_SERVICE_RUNTIME
        .lock()
        .await
        .as_ref()
        .map(|runtime| runtime.port)
}

pub(crate) async fn ensure_listening(app: tauri::AppHandle) -> Result<WebServerStatus, AppError> {
    if WEB_SERVICE_RUNTIME.lock().await.is_some() {
        let config = load_config().await?;
        crate::commands::host_tunnel::sync_relay().await;
        return Ok(status_from_runtime(config).await);
    }
    start_web_server(app).await
}

pub async fn ensure_web_service_autostart(app: tauri::AppHandle) -> Result<(), AppError> {
    let config = load_config().await?;
    if config.auto_start || crate::commands::host_tunnel::should_keep_listening().await {
        start_web_server(app).await?;
    } else {
        crate::commands::host_tunnel::sync_relay().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{net::TcpListener as StdTcpListener, time::Duration};

    use axum::Router;

    use super::{
        WebServiceConfig, advertised_addresses, advertised_listen_addresses,
        reachability_from_addresses, start_web_server_with_router, stop_web_server_with_config,
    };

    #[test]
    fn advertised_lan_addresses_exclude_loopback_from_reachability() {
        let addresses = advertised_addresses(17891, true);
        let reachability = reachability_from_addresses(&addresses);
        assert!(
            addresses
                .iter()
                .any(|address| address.contains("127.0.0.1"))
        );
        assert!(
            reachability
                .iter()
                .all(|item| !item.origin.contains("127.0.0.1"))
        );
    }

    #[test]
    fn advertised_addresses_without_lan_are_loopback_only() {
        assert_eq!(
            advertised_addresses(17891, false),
            vec!["http://127.0.0.1:17891".to_string()]
        );
        let listen = advertised_listen_addresses(17891, false);
        assert_eq!(listen.len(), 1);
        assert_eq!(listen[0].interface, "loopback");
        assert_eq!(listen[0].family, "ipv4");
    }

    static TEST_RUNTIME_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
        std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

    #[tokio::test(flavor = "multi_thread")]
    async fn starting_web_service_returns_the_running_status_without_hanging() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
        let port = StdTcpListener::bind(("127.0.0.1", 0))
            .expect("an ephemeral test port should be available")
            .local_addr()
            .expect("test listener should expose its address")
            .port();
        let config = WebServiceConfig {
            port,
            token: None,
            auto_start: false,
            allow_lan: false,
        };

        let outcome = tokio::time::timeout(
            Duration::from_secs(2),
            start_web_server_with_router(config.clone(), Router::new(), false),
        )
        .await;

        // Always release a listener that may have been created before the
        // command stalled, so this regression test remains deterministic.
        let _ = stop_web_server_with_config(config).await;

        let status = outcome
            .expect("start_web_server should return instead of hanging")
            .expect("start_web_server should succeed on an available port");
        assert!(status.running);
        assert!(status.address.is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn toggling_allow_lan_rebinds_port_immediately_without_losing_service() {
        let _guard = TEST_RUNTIME_LOCK.lock().await;
        let port = StdTcpListener::bind(("127.0.0.1", 0))
            .expect("an ephemeral test port should be available")
            .local_addr()
            .expect("test listener should expose its address")
            .port();
        let loopback_config = WebServiceConfig {
            port,
            token: None,
            auto_start: false,
            allow_lan: false,
        };
        let lan_config = WebServiceConfig {
            port,
            token: None,
            auto_start: false,
            allow_lan: true,
        };

        let first = start_web_server_with_router(loopback_config.clone(), Router::new(), true)
            .await
            .expect("initial loopback start");
        assert!(first.running);

        let stopped = stop_web_server_with_config(lan_config.clone()).await;
        assert!(!stopped.running);

        let second = start_web_server_with_router(lan_config.clone(), Router::new(), true)
            .await
            .expect("lan start immediately after stop");
        assert!(second.running);

        let _ = stop_web_server_with_config(loopback_config.clone()).await;
        let third = start_web_server_with_router(loopback_config.clone(), Router::new(), true)
            .await
            .expect("loopback start immediately after lan stop");
        assert!(third.running);

        let _ = stop_web_server_with_config(loopback_config).await;
    }
}
