#[path = "host_tunnel_relay.rs"]
mod relay;

use std::time::Duration;

use chrono::Utc;
use remote_protocol::ReachabilityOrigin;
use serde::{Deserialize, Serialize};
use utils::tunnel::{
    DEFAULT_TUNNEL_PORT, TunnelEndpoint, extract_relay_token, install_command,
    parse_tunnel_endpoint, probe_origins, scheme_hint_from_input,
};
use uuid::Uuid;

pub use self::relay::stop_quick_tunnel;
use self::relay::{
    ensure_quick_tunnel, quick_tunnel_origin, relay_snapshot, set_quick_tunnel_origin, start_relay,
    stop_relay,
};
use crate::error::AppError;

const SETTINGS_SECTION: &str = "host_tunnel";
const LEGACY_OFFICIAL_RELAY_HOST: &str = "vibex.xforever.xin";
const ERR_NEED_COMMAND: &str = "Generate a setup command first";
const ERR_HOST_UNREACHABLE: &str = "Could not reach a Dimo Host at that address. For a new VPS tunnel, generate a setup command first.";
const ERR_RELAY_WAIT: &str = "The public tunnel is waiting for this Host. Confirm the VPS command is still running, then try again.";
const ERR_HEALTH: &str = "Reached the tunnel, but this Host did not answer. Confirm the remote connection service is running.";
const RELAY_CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const HEALTH_RETRY_ATTEMPTS: u32 = 8;
const HEALTH_RETRY_DELAY: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct HostTunnelStore {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    active_id: Option<String>,
    #[serde(default)]
    saved: Vec<SavedTunnel>,
    #[serde(default)]
    pending: Option<PendingSetup>,
    #[serde(default)]
    relays: Vec<RelayCredential>,
    #[serde(default)]
    account_lease: Option<AccountRelayLease>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountRelayLease {
    pub lease_token: String,
    pub expires_at: i64,
    pub relay_host: String,
    pub relay_port: u16,
    pub tenant_origin: String,
    pub host_id: String,
    pub lease_version: i64,
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub server_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RelayCredential {
    host: String,
    port: u16,
    token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedTunnel {
    id: String,
    origin: String,
    host: String,
    port: u16,
    kind: String,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingSetup {
    host: String,
    port: u16,
    token: String,
    command: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SavedTunnelView {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub origin: String,
    pub host: String,
    pub port: u16,
    pub kind: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingTunnelView {
    pub host: String,
    pub port: u16,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostTunnelStatus {
    pub enabled: bool,
    pub saved: Vec<SavedTunnelView>,
    pub active_id: Option<String>,
    pub pending: Option<PendingTunnelView>,
    pub relay_state: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TunnelCheckResult {
    pub origin: String,
    pub http: bool,
}

#[derive(Clone)]
struct RelayState {
    status: String,
    error: Option<String>,
    connected_key: Option<String>,
}

impl Default for RelayState {
    fn default() -> Self {
        Self {
            status: "idle".to_string(),
            error: None,
            connected_key: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RelaySyncMode {
    PendingCustom {
        host: String,
        port: u16,
        token: String,
    },
    OfficialQuickTunnel,
    SavedCustomRelay {
        host: String,
        port: u16,
        token: String,
    },
    Idle,
}

fn migrate_legacy_relay_domain(lease: &mut AccountRelayLease) -> bool {
    let mut changed = false;
    if lease
        .relay_host
        .trim()
        .eq_ignore_ascii_case(LEGACY_OFFICIAL_RELAY_HOST)
    {
        lease.relay_host = utils::tunnel::DEFAULT_OFFICIAL_RELAY_HOST.to_string();
        changed = true;
    }
    if lease.tenant_origin.contains(LEGACY_OFFICIAL_RELAY_HOST) {
        lease.tenant_origin = lease.tenant_origin.replace(
            LEGACY_OFFICIAL_RELAY_HOST,
            utils::tunnel::DEFAULT_OFFICIAL_RELAY_HOST,
        );
        changed = true;
    }
    changed
}

async fn load_store() -> Result<HostTunnelStore, AppError> {
    let mut store: HostTunnelStore = services::services::settings_store::read_section(
        &utils::assets::settings_path(),
        SETTINGS_SECTION,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
    .unwrap_or_default();

    if store
        .account_lease
        .as_mut()
        .is_some_and(migrate_legacy_relay_domain)
        && !cfg!(test)
    {
        let _ = services::services::settings_store::write_section(
            &utils::assets::settings_path(),
            SETTINGS_SECTION,
            &store,
        )
        .await;
    }
    Ok(store)
}

async fn save_store(store: &HostTunnelStore) -> Result<(), AppError> {
    services::services::settings_store::write_section(
        &utils::assets::settings_path(),
        SETTINGS_SECTION,
        store,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    publish_browser_origins(store);
    Ok(())
}

fn active_published_origin(store: &HostTunnelStore) -> Option<String> {
    if !store.enabled {
        return None;
    }
    store
        .saved
        .iter()
        .find(|item| Some(item.id.as_str()) == store.active_id.as_deref())
        .map(|item| item.origin.clone())
}

fn valid_account_lease(store: &HostTunnelStore) -> Option<&AccountRelayLease> {
    let lease = store.account_lease.as_ref()?;
    if lease.lease_token.trim().is_empty()
        || lease.relay_host.trim().is_empty()
        || lease.relay_port == 0
    {
        return None;
    }
    if lease.expires_at > 0 && Utc::now().timestamp() >= lease.expires_at {
        return None;
    }
    Some(lease)
}

fn load_or_create_host_id_sync() -> Option<String> {
    utils::assets::load_or_create_host_id(&utils::assets::asset_dir()).ok()
}

fn default_official_quick_origin(store: &HostTunnelStore) -> Option<String> {
    let lease = valid_account_lease(store)?;
    if let Some(origin) = quick_tunnel_origin() {
        return Some(origin);
    }
    let mut normalized = lease.clone();
    migrate_legacy_relay_domain(&mut normalized);
    if !normalized.tenant_origin.trim().is_empty() {
        return Some(normalized.tenant_origin.trim().to_string());
    }
    let endpoint = TunnelEndpoint {
        host: normalized.relay_host.trim().to_string(),
        port: normalized.relay_port,
    };
    let host_id = if !normalized.host_id.trim().is_empty() {
        normalized.host_id.trim().to_string()
    } else {
        load_or_create_host_id_sync().unwrap_or_else(|| "default".to_string())
    };
    let scheme = if endpoint.port == 443 {
        "https"
    } else {
        "http"
    };
    Some(utils::tunnel::format_tenant_origin(
        scheme, &endpoint, &host_id,
    ))
}

fn all_published_origin_strings(store: &HostTunnelStore) -> Vec<String> {
    let mut origins = Vec::new();
    if store.enabled {
        if let Some(custom) = active_published_origin(store) {
            origins.push(custom);
        }
        if let Some(quick) = default_official_quick_origin(store)
            && !origins.contains(&quick)
        {
            origins.push(quick);
        }
    } else if let Some(quick) = quick_tunnel_origin()
        && !origins.contains(&quick)
    {
        origins.push(quick);
    }
    origins
}

fn publish_browser_origins(store: &HostTunnelStore) {
    let origins = all_published_origin_strings(store);
    server::set_extra_browser_origins(origins.clone());
    server::set_published_reachability(
        origins
            .into_iter()
            .map(remote_protocol::ReachabilityOrigin::published),
    );
}

fn view_saved(item: &SavedTunnel) -> SavedTunnelView {
    SavedTunnelView {
        id: item.id.clone(),
        name: None,
        origin: item.origin.clone(),
        host: item.host.clone(),
        port: item.port,
        kind: item.kind.clone(),
        created_at: item.created_at.clone(),
    }
}

fn status_from(store: &HostTunnelStore, relay: &RelayState) -> HostTunnelStatus {
    let mut saved: Vec<SavedTunnelView> = store.saved.iter().map(view_saved).collect();
    let enabled = store.enabled;
    let mut active_id = if enabled {
        store.active_id.clone()
    } else {
        None
    };
    let mut relay_state = relay.status.clone();

    if let Some(quick_origin) = default_official_quick_origin(store) {
        let lease_port = valid_account_lease(store)
            .map(|l| l.relay_port)
            .unwrap_or(443);
        let lease_name = valid_account_lease(store)
            .and_then(|l| l.server_name.clone())
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty());
        let host = quick_origin
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap_or(&quick_origin)
            .to_string();
        if !saved
            .iter()
            .any(|item| item.id == "auto-quick-tunnel" || item.origin == quick_origin)
        {
            saved.insert(
                0,
                SavedTunnelView {
                    id: "auto-quick-tunnel".to_string(),
                    name: lease_name,
                    origin: quick_origin,
                    host,
                    port: lease_port,
                    kind: "quick".to_string(),
                    created_at: None,
                },
            );
        }
        if enabled && active_id.is_none() {
            active_id = Some("auto-quick-tunnel".to_string());
        }
        if enabled && relay_state == "idle" {
            relay_state = "connected".to_string();
        }
    } else if active_id.as_deref() == Some("auto-quick-tunnel") {
        active_id = saved.first().map(|item| item.id.clone());
    }

    HostTunnelStatus {
        enabled,
        saved,
        active_id,
        pending: store.pending.as_ref().map(|pending| PendingTunnelView {
            host: pending.host.clone(),
            port: pending.port,
            command: pending.command.clone(),
        }),
        relay_state,
        last_error: relay.error.clone(),
    }
}

async fn host_listen_port() -> u16 {
    if let Some(port) = crate::commands::web_service::listening_port().await {
        return port;
    }
    #[derive(Deserialize)]
    struct PortOnly {
        port: Option<u16>,
    }
    let config: Option<PortOnly> = services::services::settings_store::read_section(
        &utils::assets::settings_path(),
        "web_service",
    )
    .await
    .ok()
    .flatten();
    config
        .and_then(|item| item.port)
        .filter(|port| *port > 0)
        .unwrap_or(17891)
}

pub async fn published_origins() -> Vec<ReachabilityOrigin> {
    let store = load_store().await.unwrap_or_default();
    all_published_origin_strings(&store)
        .into_iter()
        .map(ReachabilityOrigin::published)
        .collect()
}

pub async fn should_keep_listening() -> bool {
    let Ok(store) = load_store().await else {
        return false;
    };
    store.enabled || store.pending.is_some()
}

pub fn merge_host_reachability(
    lan_addresses: &[String],
    published: Vec<ReachabilityOrigin>,
) -> Vec<ReachabilityOrigin> {
    let mut items: Vec<ReachabilityOrigin> = Vec::new();
    for origin in published {
        if !items.iter().any(|item| item.origin == origin.origin) {
            items.push(origin);
        }
    }
    for origin in lan_addresses
        .iter()
        .filter(|origin| !remote_protocol::is_loopback_origin(origin))
        .map(ReachabilityOrigin::lan)
    {
        if !items.iter().any(|item| item.origin == origin.origin) {
            items.push(origin);
        }
    }
    items
}

fn decide_relay_sync_mode(store: &HostTunnelStore) -> RelaySyncMode {
    if let Some(pending) = store.pending.as_ref() {
        return RelaySyncMode::PendingCustom {
            host: pending.host.clone(),
            port: pending.port,
            token: pending.token.clone(),
        };
    }
    if store.active_id.as_deref() == Some("auto-quick-tunnel")
        || (store.active_id.is_none() && valid_account_lease(store).is_some())
    {
        return RelaySyncMode::OfficialQuickTunnel;
    }
    if store.enabled
        && let Some(active) = store
            .saved
            .iter()
            .find(|item| Some(item.id.as_str()) == store.active_id.as_deref())
        && active.kind == "relay"
        && let Some(token) = active.token.clone()
    {
        return RelaySyncMode::SavedCustomRelay {
            host: active.host.clone(),
            port: active.port,
            token,
        };
    }
    RelaySyncMode::Idle
}

pub async fn sync_relay() {
    let store = load_store().await.unwrap_or_default();
    publish_browser_origins(&store);
    let listening_port = crate::commands::web_service::listening_port().await;
    let local_port = listening_port.unwrap_or(17891);

    match decide_relay_sync_mode(&store) {
        RelaySyncMode::PendingCustom { host, port, token } => {
            stop_quick_tunnel().await;
            start_relay(host, port, token, local_port).await;
        }
        RelaySyncMode::OfficialQuickTunnel => {
            if listening_port.is_some() && valid_account_lease(&store).is_some() {
                ensure_quick_tunnel(local_port).await;
            } else {
                stop_quick_tunnel().await;
            }
            stop_relay().await;
        }
        RelaySyncMode::SavedCustomRelay { host, port, token } => {
            stop_quick_tunnel().await;
            start_relay(host, port, token, local_port).await;
        }
        RelaySyncMode::Idle => {
            stop_quick_tunnel().await;
            stop_relay().await;
        }
    }
}

/// Forgets a lease the relay rejected, unless the frontend already stored a newer one; the
/// next lease renewal reconnects the relay.
async fn drop_rejected_account_lease(rejected_token: &str) {
    let Ok(mut store) = load_store().await else {
        return;
    };
    let still_current = store
        .account_lease
        .as_ref()
        .is_some_and(|lease| lease.lease_token.trim() == rejected_token);
    if !still_current {
        return;
    }
    store.account_lease = None;
    set_quick_tunnel_origin(None);
    if store.active_id.as_deref() == Some("auto-quick-tunnel") {
        store.active_id = store.saved.first().map(|item| item.id.clone());
    }
    if let Err(error) = save_store(&store).await {
        tracing::warn!(%error, "failed to forget the rejected relay lease");
    }
}

async fn promote_pending_if_connected(host: &str, port: u16, token: &str, host_id: &str) {
    let Ok(mut store) = load_store().await else {
        return;
    };
    let Some(pending) = store.pending.as_ref() else {
        return;
    };
    if pending.host != host || pending.port != port || pending.token != token {
        return;
    }
    let created_at = pending.created_at.clone();
    let scheme = if port == 443 { "https" } else { "http" };
    let origin = utils::tunnel::format_tenant_origin(
        scheme,
        &TunnelEndpoint {
            host: host.to_string(),
            port,
        },
        host_id,
    );
    let id = Uuid::new_v4().to_string();
    store.saved.retain(|item| item.origin != origin);
    remember_relay(&mut store, host, port, token);
    store.saved.push(SavedTunnel {
        id: id.clone(),
        origin,
        host: host.to_string(),
        port,
        kind: "relay".to_string(),
        token: Some(token.to_string()),
        created_at: Some(created_at),
    });
    store.active_id = Some(id);
    store.enabled = true;
    store.pending = None;
    let _ = save_store(&store).await;
}

async fn probe_health(origin: &str) -> Result<bool, AppError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .danger_accept_invalid_certs(true)
        .no_proxy()
        .build()
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let url = format!("{}/health", origin.trim_end_matches('/'));
    let response = match client.get(&url).send().await {
        Ok(response) => response,
        Err(_) => return Ok(false),
    };
    if !response.status().is_success() {
        return Ok(false);
    }
    let body = response
        .json::<serde_json::Value>()
        .await
        .unwrap_or(serde_json::Value::Null);
    Ok(
        body.get("status").and_then(|value| value.as_str()) == Some("ok")
            || body.get("ok").and_then(|value| value.as_bool()) == Some(true),
    )
}

async fn probe_endpoint(
    endpoint: &TunnelEndpoint,
    scheme_hint: Option<&str>,
) -> Result<Option<String>, AppError> {
    probe_endpoint_until(endpoint, scheme_hint, 1, Duration::ZERO).await
}

async fn probe_endpoint_until(
    endpoint: &TunnelEndpoint,
    scheme_hint: Option<&str>,
    attempts: u32,
    delay: Duration,
) -> Result<Option<String>, AppError> {
    let host_id = tokio::task::spawn_blocking(load_or_create_host_id_sync)
        .await
        .ok()
        .flatten();
    let attempts = attempts.max(1);
    for attempt in 0..attempts {
        for origin in probe_origins(endpoint, scheme_hint) {
            if let Some(ref hid) = host_id {
                let tenant_origin = format!("{}/t/{}", origin.trim_end_matches('/'), hid);
                if probe_health(&tenant_origin).await? {
                    return Ok(Some(tenant_origin));
                }
            }
            if probe_health(&origin).await? {
                return Ok(Some(origin));
            }
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(delay).await;
        }
    }
    Ok(None)
}

fn pending_setup_ready(store: &HostTunnelStore, relay: &RelayState) -> Result<(), String> {
    if store.pending.is_some() {
        return Ok(());
    }
    let Some(active_id) = store.active_id.as_deref() else {
        return Err(ERR_NEED_COMMAND.to_string());
    };
    let Some(active) = store.saved.iter().find(|item| item.id == active_id) else {
        return Err(ERR_NEED_COMMAND.to_string());
    };
    if active.kind == "relay" && (relay.status == "connected" || relay.status == "connecting") {
        return Ok(());
    }
    Err(ERR_NEED_COMMAND.to_string())
}

fn parse_address(address: &str) -> Result<(TunnelEndpoint, Option<&'static str>), AppError> {
    let endpoint =
        parse_tunnel_endpoint(address, DEFAULT_TUNNEL_PORT).map_err(AppError::BadRequest)?;
    Ok((endpoint, scheme_hint_from_input(address)))
}

fn upsert_saved(store: &mut HostTunnelStore, tunnel: SavedTunnel) {
    store
        .saved
        .retain(|item| item.origin != tunnel.origin && item.id != tunnel.id);
    store.active_id = Some(tunnel.id.clone());
    store.saved.push(tunnel);
}

fn remember_relay(store: &mut HostTunnelStore, host: &str, port: u16, token: &str) {
    store
        .relays
        .retain(|item| item.host != host || item.port != port);
    store.relays.push(RelayCredential {
        host: host.to_string(),
        port,
        token: token.to_string(),
    });
}

fn relay_token_for(store: &HostTunnelStore, host: &str, port: u16) -> Option<String> {
    if let Some(pending) = store.pending.as_ref()
        && pending.host == host
        && pending.port == port
    {
        return Some(pending.token.clone());
    }
    store
        .saved
        .iter()
        .find(|item| item.host == host && item.port == port)
        .and_then(|item| item.token.clone())
        .or_else(|| {
            store
                .relays
                .iter()
                .find(|item| item.host == host && item.port == port)
                .map(|item| item.token.clone())
        })
}

async fn wait_until_relay_connected(timeout: Duration) -> bool {
    let started = tokio::time::Instant::now();
    loop {
        if relay_snapshot().await.status == "connected" {
            return true;
        }
        if started.elapsed() >= timeout {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn persist_checked_origin(
    endpoint: TunnelEndpoint,
    origin: String,
    token: Option<String>,
) -> Result<TunnelCheckResult, AppError> {
    let mut store = load_store().await?;
    if let Some(token) = token.as_deref() {
        remember_relay(&mut store, &endpoint.host, endpoint.port, token);
    }
    let existing_created_at = store
        .saved
        .iter()
        .find(|item| item.origin == origin)
        .and_then(|item| item.created_at.clone());
    let kind = if token.is_some() { "relay" } else { "existing" };
    upsert_saved(
        &mut store,
        SavedTunnel {
            id: Uuid::new_v4().to_string(),
            origin: origin.clone(),
            host: endpoint.host,
            port: endpoint.port,
            kind: kind.to_string(),
            token,
            created_at: Some(existing_created_at.unwrap_or_else(|| Utc::now().to_rfc3339())),
        },
    );
    store.enabled = true;
    store.pending = None;
    save_store(&store).await?;
    sync_relay().await;
    Ok(TunnelCheckResult {
        http: origin.starts_with("http://"),
        origin,
    })
}

async fn current_status() -> Result<HostTunnelStatus, AppError> {
    let store = load_store().await?;
    let relay = relay_snapshot().await;
    Ok(status_from(&store, &relay))
}

#[tauri::command]
pub async fn get_host_tunnel(app: tauri::AppHandle) -> Result<HostTunnelStatus, AppError> {
    if should_keep_listening().await {
        let _ = crate::commands::web_service::ensure_listening(app).await;
    }
    sync_relay().await;
    let _ = promote_if_relay_already_up().await;
    current_status().await
}

async fn promote_if_relay_already_up() -> Result<(), AppError> {
    let store = load_store().await?;
    let Some(pending) = store.pending.clone() else {
        return Ok(());
    };
    let relay = relay_snapshot().await;
    if relay.status == "connected" {
        let host_id = tokio::task::spawn_blocking(load_or_create_host_id_sync)
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| "default".to_string());
        promote_pending_if_connected(&pending.host, pending.port, &pending.token, &host_id).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_host_tunnel_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<HostTunnelStatus, AppError> {
    let mut store = load_store().await?;
    store.enabled = enabled;
    if !enabled {
        store.pending = None;
    } else if store.active_id.is_none() && valid_account_lease(&store).is_some() {
        store.active_id = Some("auto-quick-tunnel".to_string());
    }
    save_store(&store).await?;
    if enabled {
        crate::commands::web_service::ensure_listening(app).await?;
    }
    sync_relay().await;
    current_status().await
}

#[tauri::command]
pub async fn check_existing_host_tunnel(
    app: tauri::AppHandle,
    address: String,
) -> Result<TunnelCheckResult, AppError> {
    crate::commands::web_service::ensure_listening(app).await?;
    let (endpoint, hint) = parse_address(&address)?;
    let input_token = extract_relay_token(&address);
    if let Some(origin) = probe_endpoint(&endpoint, hint).await? {
        return persist_checked_origin(endpoint, origin, input_token).await;
    }

    let mut store = load_store().await?;
    let Some(token) =
        input_token.or_else(|| relay_token_for(&store, &endpoint.host, endpoint.port))
    else {
        return Err(AppError::BadRequest(ERR_HOST_UNREACHABLE.to_string()));
    };
    remember_relay(&mut store, &endpoint.host, endpoint.port, &token);
    store.enabled = true;
    save_store(&store).await?;
    let local_port = host_listen_port().await;
    start_relay(
        endpoint.host.clone(),
        endpoint.port,
        token.clone(),
        local_port,
    )
    .await;
    if !wait_until_relay_connected(RELAY_CONNECT_TIMEOUT).await {
        return Err(AppError::BadRequest(ERR_RELAY_WAIT.to_string()));
    }
    let Some(origin) =
        probe_endpoint_until(&endpoint, hint, HEALTH_RETRY_ATTEMPTS, HEALTH_RETRY_DELAY).await?
    else {
        return Err(AppError::BadRequest(ERR_HEALTH.to_string()));
    };
    persist_checked_origin(endpoint, origin, Some(token)).await
}

#[tauri::command]
pub async fn select_saved_host_tunnel(id: Option<String>) -> Result<HostTunnelStatus, AppError> {
    let mut store = load_store().await?;
    let target_id = id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(ref target) = target_id {
        if target == "auto-quick-tunnel" {
            if valid_account_lease(&store).is_none() {
                return Err(AppError::BadRequest(
                    "Sign in to your Dimo account to use the Official Cloud Relay".to_string(),
                ));
            }
        } else if !store.saved.iter().any(|item| &item.id == target) {
            return Err(AppError::BadRequest("Unknown tunnel".to_string()));
        }
        store.active_id = Some(target.clone());
        store.enabled = true;
    } else {
        store.active_id = None;
        store.enabled = false;
    }
    store.pending = None;
    save_store(&store).await?;
    sync_relay().await;
    current_status().await
}

#[tauri::command]
pub async fn set_account_relay_lease(
    mut lease: Option<AccountRelayLease>,
) -> Result<HostTunnelStatus, AppError> {
    if let Some(ref mut next) = lease {
        migrate_legacy_relay_domain(next);
    }
    let mut store = load_store().await?;
    let server_changed = match (store.account_lease.as_ref(), lease.as_ref()) {
        (Some(prev), Some(next)) => {
            prev.relay_host != next.relay_host
                || prev.relay_port != next.relay_port
                || prev.tenant_origin != next.tenant_origin
                || prev.server_id != next.server_id
        }
        (Some(_), None) | (None, Some(_)) => true,
        (None, None) => false,
    };
    store.account_lease = lease;
    if valid_account_lease(&store).is_none() {
        set_quick_tunnel_origin(None);
        if store.active_id.as_deref() == Some("auto-quick-tunnel") {
            store.active_id = store.saved.first().map(|item| item.id.clone());
        }
    } else if store.enabled && store.active_id.is_none() {
        store.active_id = Some("auto-quick-tunnel".to_string());
    }
    if server_changed {
        set_quick_tunnel_origin(None);
        stop_quick_tunnel().await;
    }
    save_store(&store).await?;
    sync_relay().await;
    current_status().await
}

#[tauri::command]
pub async fn start_create_host_tunnel(
    app: tauri::AppHandle,
    address: String,
) -> Result<HostTunnelStatus, AppError> {
    crate::commands::web_service::ensure_listening(app).await?;
    let (endpoint, _) = parse_address(&address)?;
    let mut store = load_store().await?;
    let token = extract_relay_token(&address)
        .or_else(|| relay_token_for(&store, &endpoint.host, endpoint.port))
        .unwrap_or_else(|| format!("vbx_tun_{}", Uuid::new_v4().simple()));
    let command = install_command(&token, endpoint.port, &endpoint.host);
    remember_relay(&mut store, &endpoint.host, endpoint.port, &token);
    store.enabled = true;
    store.pending = Some(PendingSetup {
        host: endpoint.host,
        port: endpoint.port,
        token,
        command,
        created_at: Utc::now().to_rfc3339(),
    });
    save_store(&store).await?;
    sync_relay().await;
    current_status().await
}

#[tauri::command]
pub async fn confirm_create_host_tunnel(
    app: tauri::AppHandle,
) -> Result<HostTunnelStatus, AppError> {
    crate::commands::web_service::ensure_listening(app).await?;
    let store = load_store().await?;
    let relay = relay_snapshot().await;
    pending_setup_ready(&store, &relay).map_err(AppError::BadRequest)?;
    sync_relay().await;
    let _ = wait_until_relay_connected(Duration::from_secs(3)).await;
    let _ = promote_if_relay_already_up().await;
    current_status().await
}

#[tauri::command]
pub async fn cancel_create_host_tunnel() -> Result<HostTunnelStatus, AppError> {
    let mut store = load_store().await?;
    store.pending = None;
    save_store(&store).await?;
    sync_relay().await;
    current_status().await
}

#[tauri::command]
pub async fn remove_saved_host_tunnel(id: String) -> Result<HostTunnelStatus, AppError> {
    let mut store = load_store().await?;
    if let Some(item) = store.saved.iter().find(|item| item.id == id).cloned()
        && let Some(token) = item.token.as_deref()
    {
        remember_relay(&mut store, &item.host, item.port, token);
    }
    store.saved.retain(|item| item.id != id);
    if store.active_id.as_deref() == Some(id.as_str()) {
        store.active_id = store.saved.first().map(|item| item.id.clone());
    }
    save_store(&store).await?;
    sync_relay().await;
    current_status().await
}

#[cfg(test)]
mod tests {
    use super::{
        AccountRelayLease, ERR_NEED_COMMAND, HostTunnelStore, RelayState, RelaySyncMode,
        SavedTunnel, decide_relay_sync_mode, merge_host_reachability, migrate_legacy_relay_domain,
        pending_setup_ready, relay::terminal_lease_rejection, relay_token_for, remember_relay,
    };

    #[test]
    fn published_plaintext_public_origins_stay_in_reachability() {
        let merged = merge_host_reachability(
            &["http://192.168.1.20:17891".to_string()],
            vec![
                remote_protocol::ReachabilityOrigin::published("http://203.0.113.10:13630"),
                remote_protocol::ReachabilityOrigin::published("https://gate.example.ts.net"),
            ],
        );
        assert_eq!(
            merged
                .iter()
                .map(|item| (item.origin.as_str(), item.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("http://203.0.113.10:13630", "published"),
                ("https://gate.example.ts.net", "published"),
                ("http://192.168.1.20:17891", "lan"),
            ]
        );
    }

    #[test]
    fn published_origins_join_lan_and_drop_loopback() {
        let merged = merge_host_reachability(
            &[
                "http://127.0.0.1:17891".to_string(),
                "http://192.168.1.20:17891".to_string(),
            ],
            vec![remote_protocol::ReachabilityOrigin::published(
                "https://gate.example.ts.net",
            )],
        );
        assert_eq!(
            merged
                .iter()
                .map(|item| (item.origin.as_str(), item.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("https://gate.example.ts.net", "published"),
                ("http://192.168.1.20:17891", "lan"),
            ]
        );
    }

    #[test]
    fn only_unrecoverable_relay_rejections_drop_the_lease() {
        assert_eq!(
            terminal_lease_rejection("relay rejected control session: host_revoked"),
            Some("host_revoked")
        );
        assert_eq!(
            terminal_lease_rejection("relay rejected control session: lease_expired"),
            Some("lease_expired")
        );
        assert_eq!(
            terminal_lease_rejection("relay rejected control session: relay_lease_unconfigured"),
            None
        );
        assert_eq!(terminal_lease_rejection("connection reset"), None);
    }

    #[test]
    fn removed_relay_keeps_token_for_reconnect() {
        let mut store = HostTunnelStore {
            enabled: true,
            active_id: Some("t1".to_string()),
            saved: vec![SavedTunnel {
                id: "t1".to_string(),
                origin: "http://203.0.113.10:13630".to_string(),
                host: "203.0.113.10".to_string(),
                port: 13630,
                kind: "relay".to_string(),
                token: Some("vbx_tun_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()),
                created_at: None,
            }],
            pending: None,
            relays: Vec::new(),
            account_lease: None,
        };
        let item = store.saved[0].clone();
        remember_relay(
            &mut store,
            &item.host,
            item.port,
            item.token.as_deref().unwrap(),
        );
        store.saved.clear();
        store.active_id = None;
        assert_eq!(
            relay_token_for(&store, "203.0.113.10", 13630).as_deref(),
            Some("vbx_tun_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
    }

    #[test]
    fn confirm_requires_a_generated_command_until_the_relay_is_saved() {
        let store = HostTunnelStore::default();
        let relay = RelayState::default();
        assert_eq!(
            pending_setup_ready(&store, &relay).unwrap_err(),
            ERR_NEED_COMMAND
        );
    }

    #[test]
    fn confirm_succeeds_after_the_generated_command_is_saved() {
        let store = HostTunnelStore {
            pending: Some(super::PendingSetup {
                host: "203.0.113.10".to_string(),
                port: 17891,
                token: "vbx_tun_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
                command: "curl".to_string(),
                created_at: "now".to_string(),
            }),
            ..HostTunnelStore::default()
        };
        assert!(pending_setup_ready(&store, &RelayState::default()).is_ok());
    }

    #[test]
    fn confirm_succeeds_when_pending_was_already_promoted() {
        let store = HostTunnelStore {
            enabled: true,
            active_id: Some("t1".to_string()),
            saved: vec![SavedTunnel {
                id: "t1".to_string(),
                origin: "http://203.0.113.10:17891".to_string(),
                host: "203.0.113.10".to_string(),
                port: 17891,
                kind: "relay".to_string(),
                token: Some("vbx_tun_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()),
                created_at: None,
            }],
            pending: None,
            relays: Vec::new(),
            account_lease: None,
        };
        let relay = RelayState {
            status: "connected".to_string(),
            error: None,
            connected_key: Some(
                "203.0.113.10:17891:vbx_tun_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            ),
        };
        assert!(pending_setup_ready(&store, &relay).is_ok());
    }

    #[test]
    fn official_quick_tunnel_requires_valid_account_lease_and_migrates_legacy_domain() {
        let signed_out_store = HostTunnelStore {
            enabled: true,
            ..HostTunnelStore::default()
        };
        let signed_out_status = super::status_from(&signed_out_store, &RelayState::default());
        assert!(
            !signed_out_status
                .saved
                .iter()
                .any(|item| item.id == "auto-quick-tunnel")
        );

        let mut legacy_lease = AccountRelayLease {
            lease_token: "vbx_rly_v1.payload.sig".to_string(),
            expires_at: chrono::Utc::now().timestamp() + 3600,
            relay_host: "vibex.xforever.xin".to_string(),
            relay_port: 443,
            tenant_origin: "https://vibex.xforever.xin/t/my-host".to_string(),
            host_id: "my-host".to_string(),
            lease_version: 1,
            server_id: Some("official-cn-main".to_string()),
            server_name: Some("官方主云中继节点 (华东)".to_string()),
        };
        assert!(migrate_legacy_relay_domain(&mut legacy_lease));
        assert_eq!(legacy_lease.relay_host, "dimo-ai.com");
        assert_eq!(legacy_lease.tenant_origin, "https://dimo-ai.com/t/my-host");
        assert!(!migrate_legacy_relay_domain(&mut legacy_lease));

        let signed_in_store = HostTunnelStore {
            enabled: true,
            account_lease: Some(legacy_lease),
            ..HostTunnelStore::default()
        };
        let signed_in_status = super::status_from(&signed_in_store, &RelayState::default());
        assert!(
            signed_in_status
                .saved
                .iter()
                .any(|item| item.id == "auto-quick-tunnel"
                    && item.origin == "https://dimo-ai.com/t/my-host"
                    && item.host == "dimo-ai.com"
                    && item.name.as_deref() == Some("官方主云中继节点 (华东)"))
        );
        assert_eq!(
            signed_in_status.active_id.as_deref(),
            Some("auto-quick-tunnel")
        );
    }

    #[test]
    fn relay_sync_mode_prevents_quick_tunnel_and_custom_relay_running_together() {
        let lease = AccountRelayLease {
            lease_token: "vbx_rly_v1.payload.sig".to_string(),
            expires_at: chrono::Utc::now().timestamp() + 3600,
            relay_host: "dimo-ai.com".to_string(),
            relay_port: 443,
            tenant_origin: "https://dimo-ai.com/t/my-host".to_string(),
            host_id: "my-host".to_string(),
            lease_version: 1,
            server_id: None,
            server_name: None,
        };
        let custom_saved = SavedTunnel {
            id: "custom-1".to_string(),
            origin: "http://203.0.113.10:17891".to_string(),
            host: "203.0.113.10".to_string(),
            port: 17891,
            kind: "relay".to_string(),
            token: Some("vbx_tun_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()),
            created_at: None,
        };

        let quick_active = HostTunnelStore {
            enabled: true,
            active_id: Some("auto-quick-tunnel".to_string()),
            saved: vec![custom_saved.clone()],
            account_lease: Some(lease.clone()),
            ..HostTunnelStore::default()
        };
        assert_eq!(
            decide_relay_sync_mode(&quick_active),
            RelaySyncMode::OfficialQuickTunnel
        );

        let default_quick = HostTunnelStore {
            enabled: true,
            active_id: None,
            saved: vec![custom_saved.clone()],
            account_lease: Some(lease.clone()),
            ..HostTunnelStore::default()
        };
        assert_eq!(
            decide_relay_sync_mode(&default_quick),
            RelaySyncMode::OfficialQuickTunnel
        );

        let custom_active = HostTunnelStore {
            enabled: true,
            active_id: Some("custom-1".to_string()),
            saved: vec![custom_saved],
            account_lease: Some(lease),
            ..HostTunnelStore::default()
        };
        assert_eq!(
            decide_relay_sync_mode(&custom_active),
            RelaySyncMode::SavedCustomRelay {
                host: "203.0.113.10".to_string(),
                port: 17891,
                token: "vbx_tun_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            }
        );
    }
}
