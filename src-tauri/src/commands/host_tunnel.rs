use std::{sync::Arc, time::Duration};

use chrono::Utc;
use remote_protocol::ReachabilityOrigin;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    sync::Mutex,
    task::JoinHandle,
};
use utils::tunnel::{
    DEFAULT_TUNNEL_PORT, TunnelEndpoint, extract_relay_token, format_origin, install_command,
    parse_tunnel_endpoint, probe_origins, scheme_hint_from_input,
};
use uuid::Uuid;

use crate::error::AppError;

const SETTINGS_SECTION: &str = "host_tunnel";

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
    pub origin: String,
    pub host: String,
    pub port: u16,
    pub kind: String,
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

struct RelayRuntime {
    handle: JoinHandle<()>,
    state: Arc<Mutex<RelayState>>,
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

static RELAY: std::sync::LazyLock<Mutex<Option<RelayRuntime>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

async fn load_store() -> Result<HostTunnelStore, AppError> {
    services::services::settings_store::read_section(
        &utils::assets::settings_path(),
        SETTINGS_SECTION,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))
    .map(|value| value.unwrap_or_default())
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

fn publish_browser_origins(store: &HostTunnelStore) {
    server::set_extra_browser_origins(active_published_origin(store));
}

fn view_saved(item: &SavedTunnel) -> SavedTunnelView {
    SavedTunnelView {
        id: item.id.clone(),
        origin: item.origin.clone(),
        host: item.host.clone(),
        port: item.port,
        kind: item.kind.clone(),
    }
}

fn status_from(store: &HostTunnelStore, relay: &RelayState) -> HostTunnelStatus {
    HostTunnelStatus {
        enabled: store.enabled,
        saved: store.saved.iter().map(view_saved).collect(),
        active_id: store.active_id.clone(),
        pending: store.pending.as_ref().map(|pending| PendingTunnelView {
            host: pending.host.clone(),
            port: pending.port,
            command: pending.command.clone(),
        }),
        relay_state: relay.status.clone(),
        last_error: relay.error.clone(),
    }
}

async fn relay_snapshot() -> RelayState {
    let runtime = RELAY.lock().await;
    if let Some(runtime) = runtime.as_ref() {
        runtime.state.lock().await.clone()
    } else {
        RelayState::default()
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
    let Ok(store) = load_store().await else {
        return Vec::new();
    };
    if !store.enabled {
        return Vec::new();
    }
    active_published_origin(&store)
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

pub async fn sync_relay() {
    let Ok(store) = load_store().await else {
        return;
    };
    publish_browser_origins(&store);
    let local_port = host_listen_port().await;
    if let Some(pending) = store.pending.as_ref() {
        start_relay(
            pending.host.clone(),
            pending.port,
            pending.token.clone(),
            local_port,
        )
        .await;
        return;
    }
    if store.enabled
        && let Some(active) = store
            .saved
            .iter()
            .find(|item| Some(item.id.as_str()) == store.active_id.as_deref())
        && active.kind == "relay"
        && let Some(token) = active.token.clone()
    {
        start_relay(active.host.clone(), active.port, token, local_port).await;
        return;
    }
    stop_relay().await;
}

async fn start_relay(host: String, port: u16, token: String, local_port: u16) {
    let key = format!("{host}:{port}:{token}");
    {
        let current = RELAY.lock().await;
        if let Some(runtime) = current.as_ref() {
            let state = runtime.state.lock().await;
            if state.connected_key.as_deref() == Some(key.as_str())
                && (state.status == "connected" || state.status == "connecting")
            {
                return;
            }
        }
    }
    stop_relay().await;
    let state = Arc::new(Mutex::new(RelayState {
        status: "connecting".to_string(),
        error: None,
        connected_key: Some(key.clone()),
    }));
    let handle = tokio::spawn(run_relay(host, port, token, local_port, key, state.clone()));
    *RELAY.lock().await = Some(RelayRuntime { handle, state });
}

async fn stop_relay() {
    if let Some(runtime) = RELAY.lock().await.take() {
        runtime.handle.abort();
    }
}

async fn run_relay(
    host: String,
    port: u16,
    token: String,
    local_port: u16,
    key: String,
    state: Arc<Mutex<RelayState>>,
) {
    loop {
        match maintain_control(&host, port, &token, local_port, &key, &state).await {
            Ok(()) => {
                let mut snapshot = state.lock().await;
                snapshot.status = "connecting".to_string();
            }
            Err(error) => {
                let mut snapshot = state.lock().await;
                snapshot.status = "connecting".to_string();
                snapshot.error = Some(error);
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn maintain_control(
    host: &str,
    port: u16,
    token: &str,
    local_port: u16,
    key: &str,
    state: &Arc<Mutex<RelayState>>,
) -> Result<(), String> {
    let stream = TcpStream::connect((host, port))
        .await
        .map_err(|error| error.to_string())?;
    let _ = stream.set_nodelay(true);
    let (reader, mut writer) = stream.into_split();
    writer
        .write_all(format!("VIBEX-CTRL {token}\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    {
        let mut snapshot = state.lock().await;
        snapshot.status = "connected".to_string();
        snapshot.error = None;
        snapshot.connected_key = Some(key.to_string());
    }
    promote_pending_if_connected(host, port, token).await;
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        if let Some(id) = line.trim().strip_prefix("OPEN ") {
            let host = host.to_string();
            let token = token.to_string();
            let id = id.to_string();
            tokio::spawn(async move {
                let _ = open_data_path(host, port, token, id, local_port).await;
            });
        }
    }
    Err("tunnel control closed".to_string())
}

async fn promote_pending_if_connected(host: &str, port: u16, token: &str) {
    let Ok(mut store) = load_store().await else {
        return;
    };
    let Some(pending) = store.pending.as_ref() else {
        return;
    };
    if pending.host != host || pending.port != port || pending.token != token {
        return;
    }
    let origin = format_origin(
        "http",
        &TunnelEndpoint {
            host: host.to_string(),
            port,
        },
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
    });
    store.active_id = Some(id);
    store.enabled = true;
    store.pending = None;
    let _ = save_store(&store).await;
}

async fn open_data_path(
    host: String,
    port: u16,
    token: String,
    id: String,
    local_port: u16,
) -> Result<(), String> {
    let mut local = TcpStream::connect(("127.0.0.1", local_port))
        .await
        .map_err(|error| error.to_string())?;
    let _ = local.set_nodelay(true);
    let mut remote = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|error| error.to_string())?;
    let _ = remote.set_nodelay(true);
    remote
        .write_all(format!("VIBEX-DATA {token} {id}\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
    Ok(())
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
    for origin in probe_origins(endpoint, scheme_hint) {
        if probe_health(&origin).await? {
            return Ok(Some(origin));
        }
    }
    Ok(None)
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
        promote_pending_if_connected(&pending.host, pending.port, &pending.token).await;
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
        return Err(AppError::BadRequest(
            "Could not reach a VibeX Host at that address".to_string(),
        ));
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
    if !wait_until_relay_connected(Duration::from_secs(8)).await {
        return Err(AppError::BadRequest(
            "Could not reach a VibeX Host at that address".to_string(),
        ));
    }
    tokio::time::sleep(Duration::from_millis(250)).await;
    let Some(origin) = probe_endpoint(&endpoint, Some("http")).await? else {
        return Err(AppError::BadRequest(
            "Could not reach a VibeX Host at that address".to_string(),
        ));
    };
    persist_checked_origin(endpoint, origin, Some(token)).await
}

#[tauri::command]
pub async fn select_saved_host_tunnel(id: String) -> Result<HostTunnelStatus, AppError> {
    let mut store = load_store().await?;
    if !store.saved.iter().any(|item| item.id == id) {
        return Err(AppError::BadRequest("Unknown tunnel".to_string()));
    }
    store.active_id = Some(id);
    store.enabled = true;
    store.pending = None;
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
    let command = install_command(&token, endpoint.port);
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
    current_status().await
}

#[tauri::command]
pub async fn confirm_create_host_tunnel(
    app: tauri::AppHandle,
) -> Result<HostTunnelStatus, AppError> {
    let store = load_store().await?;
    if store.pending.is_none() {
        return Err(AppError::BadRequest(
            "Generate a setup command first".to_string(),
        ));
    }
    crate::commands::web_service::ensure_listening(app).await?;
    sync_relay().await;
    tokio::time::sleep(Duration::from_millis(400)).await;
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
        HostTunnelStore, SavedTunnel, merge_host_reachability, relay_token_for, remember_relay,
    };

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
            }],
            pending: None,
            relays: Vec::new(),
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
}
