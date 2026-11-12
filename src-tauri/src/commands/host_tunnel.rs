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
    DEFAULT_TUNNEL_PORT, TunnelEndpoint, extract_relay_token, install_command,
    parse_tunnel_endpoint, probe_origins, scheme_hint_from_input,
};
use uuid::Uuid;

use crate::error::AppError;

const SETTINGS_SECTION: &str = "host_tunnel";
const ERR_NEED_COMMAND: &str = "Generate a setup command first";
const ERR_HOST_UNREACHABLE: &str = "Could not reach a VibeX Host at that address. For a new VPS tunnel, generate a setup command first.";
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

struct QuickTunnelRuntime {
    local_port: u16,
    handle: JoinHandle<()>,
}

static QUICK_TUNNEL: std::sync::LazyLock<Mutex<Option<QuickTunnelRuntime>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

static QUICK_TUNNEL_ORIGIN: std::sync::LazyLock<std::sync::RwLock<Option<String>>> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(None));

fn quick_tunnel_origin() -> Option<String> {
    QUICK_TUNNEL_ORIGIN
        .read()
        .ok()
        .and_then(|guard| guard.clone())
}

fn set_quick_tunnel_origin(origin: Option<String>) {
    if let Ok(mut guard) = QUICK_TUNNEL_ORIGIN.write() {
        *guard = origin;
    }
}

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

fn default_official_quick_origin(store: &HostTunnelStore) -> Option<String> {
    let lease = valid_account_lease(store)?;
    if let Some(origin) = quick_tunnel_origin() {
        return Some(origin);
    }
    if !lease.tenant_origin.trim().is_empty() {
        return Some(lease.tenant_origin.trim().to_string());
    }
    let endpoint = TunnelEndpoint {
        host: lease.relay_host.trim().to_string(),
        port: lease.relay_port,
    };
    let host_id = if !lease.host_id.trim().is_empty() {
        lease.host_id.trim().to_string()
    } else {
        load_or_create_host_id_sync().unwrap_or_else(|| "default".to_string())
    };
    let scheme = if endpoint.port == 443 { "https" } else { "http" };
    Some(utils::tunnel::format_tenant_origin(
        scheme, &endpoint, &host_id,
    ))
}

fn all_published_origin_strings(store: &HostTunnelStore) -> Vec<String> {
    if !store.enabled {
        return Vec::new();
    }
    let mut origins = Vec::new();
    if let Some(custom) = active_published_origin(store) {
        origins.push(custom);
    }
    if let Some(quick) = default_official_quick_origin(store)
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

pub async fn sync_relay() {
    let store = load_store().await.unwrap_or_default();
    publish_browser_origins(&store);
    let listening_port = crate::commands::web_service::listening_port().await;
    let local_port = listening_port.unwrap_or(17891);
    if listening_port.is_some() && valid_account_lease(&store).is_some() {
        ensure_quick_tunnel(local_port).await;
    } else {
        stop_quick_tunnel().await;
    }
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

async fn ensure_quick_tunnel(local_port: u16) {
    if cfg!(test) {
        return;
    }
    {
        let guard = QUICK_TUNNEL.lock().await;
        if let Some(runtime) = guard.as_ref()
            && runtime.local_port == local_port
            && !runtime.handle.is_finished()
        {
            return;
        }
    }
    stop_quick_tunnel().await;
    let handle = tokio::spawn(run_quick_tunnel_supervisor(local_port));
    *QUICK_TUNNEL.lock().await = Some(QuickTunnelRuntime { local_port, handle });
}

pub async fn stop_quick_tunnel() {
    if let Some(runtime) = QUICK_TUNNEL.lock().await.take() {
        runtime.handle.abort();
    }
    set_quick_tunnel_origin(None);
    if let Ok(store) = load_store().await {
        publish_browser_origins(&store);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RelayControlServerFrame {
    Ping {
        ts: i64,
    },
    ReplenishPool {
        count: usize,
    },
    OpenData {
        host_id: String,
        conn_id: String,
    },
    HttpReq {
        host_id: String,
        id: String,
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        body_b64: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RelayControlClientFrame {
    Pong {
        ts: i64,
    },
    UpdateMeta {
        name: String,
        lan_origins: Vec<String>,
    },
    HttpRes {
        host_id: String,
        id: String,
        status: u16,
        headers: Vec<(String, String)>,
        body_b64: String,
    },
}

fn load_or_create_host_id_sync() -> Option<String> {
    utils::assets::load_or_create_host_id(&utils::assets::asset_dir()).ok()
}

async fn connect_to_relay_host(host: &str, port: u16) -> Result<TcpStream, String> {
    use tokio::io::AsyncReadExt;

    let is_nginx_upgrade = (port == 80 || port == 443)
        && host.parse::<std::net::IpAddr>().is_err()
        && !host.eq_ignore_ascii_case("localhost");
    let tcp_port = if is_nginx_upgrade { 80 } else { port };

    let host_owned = host.to_string();
    let resolved = tokio::task::spawn_blocking(move || {
        utils::net::resolve_host_ipv4_direct(&host_owned, tcp_port)
    })
    .await
    .ok()
    .flatten();

    let mut stream = if let Some(addr) = resolved {
        utils::net::connect_tcp_bypassing_tun(addr)
            .await
            .map_err(|err| err.to_string())?
    } else {
        let s = TcpStream::connect((host, tcp_port))
            .await
            .map_err(|err| err.to_string())?;
        let _ = s.set_nodelay(true);
        s
    };

    if is_nginx_upgrade {
        let req = format!(
            "GET /v1/tunnel HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
        );
        stream
            .write_all(req.as_bytes())
            .await
            .map_err(|err| err.to_string())?;

        let mut peek_buf = [0u8; 2048];
        let mut header_end = None;
        for _ in 0..20 {
            let n = tokio::time::timeout(Duration::from_secs(4), stream.peek(&mut peek_buf))
                .await
                .map_err(|_| "relay tunnel upgrade timed out".to_string())?
                .map_err(|err| err.to_string())?;
            if n == 0 {
                return Err("relay closed connection during upgrade".to_string());
            }
            if let Some(pos) = peek_buf[..n].windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = Some(pos + 4);
                break;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        let end_len = header_end.ok_or_else(|| "incomplete relay upgrade response".to_string())?;
        let mut header_bytes = vec![0u8; end_len];
        stream
            .read_exact(&mut header_bytes)
            .await
            .map_err(|err| err.to_string())?;
        let status_line = String::from_utf8_lossy(&header_bytes);
        if !status_line.starts_with("HTTP/1.1 101") && !status_line.starts_with("HTTP/1.0 101") {
            let first = status_line.lines().next().unwrap_or("unknown status");
            return Err(format!("relay upgrade rejected: {first}"));
        }
    }

    Ok(stream)
}

async fn run_quick_tunnel_supervisor(local_port: u16) {
    loop {
        if let Ok(store) = load_store().await
            && let Some(lease) = valid_account_lease(&store)
        {
            let host = lease.relay_host.trim().to_string();
            let port = lease.relay_port;
            let token = lease.lease_token.trim().to_string();
            let state = Arc::new(Mutex::new(RelayState::default()));
            let key = format!("{}:{}:official", host, port);
            let _ = maintain_control(&host, port, &token, local_port, &key, &state).await;
        } else {
            set_quick_tunnel_origin(None);
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

const SHARED_CLOUD_DISCOVERY_TOPIC: &str = "vbx-cloud-hosts-v1";

async fn publish_domestic_beacon(relay_host: &str, relay_port: u16, host_id: &str, origin: &str) {
    let host_name = utils::net::local_hostname().unwrap_or_else(|| "VibeX Desktop".to_string());
    let payload = serde_json::json!({
        "v": 2,
        "host_id": host_id,
        "name": host_name,
        "origin": origin,
        "ts": Utc::now().timestamp(),
    });
    let host_hash = &sha256_hex(&format!("vibex-host-v1:{host_id}"))[..32];
    let topic = format!("vbx-h-{host_hash}");
    let is_domain = relay_host.parse::<std::net::IpAddr>().is_err()
        && !relay_host.eq_ignore_ascii_case("localhost");
    let (base_url, target_port) = if is_domain && (relay_port == 80 || relay_port == 443) {
        (format!("https://{relay_host}/v1/beacon"), 443u16)
    } else {
        (
            format!("http://{relay_host}:{relay_port}/v1/beacon"),
            relay_port,
        )
    };

    let host_owned = relay_host.to_string();
    let resolved = tokio::task::spawn_blocking(move || {
        utils::net::resolve_host_ipv4_direct(&host_owned, target_port)
    })
    .await
    .ok()
    .flatten();

    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .no_proxy();
    if let Some(addr) = resolved {
        builder = builder.resolve(relay_host, addr);
    }
    if let Ok(client) = builder.build() {
        let _ = client
            .post(format!("{base_url}/{topic}"))
            .json(&payload)
            .send()
            .await;
        let _ = client
            .post(format!("{base_url}/{SHARED_CLOUD_DISCOVERY_TOPIC}"))
            .json(&payload)
            .send()
            .await;
    }
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
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

    let host_id = tokio::task::spawn_blocking(load_or_create_host_id_sync)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "default".to_string());
    let host_name = utils::net::local_hostname().unwrap_or_else(|| "VibeX Desktop".to_string());
    let lan_origins: Vec<String> = utils::net::advertised_http_origins(local_port, true)
        .into_iter()
        .filter(|origin| !remote_protocol::is_loopback_origin(origin))
        .collect();

    let stream = connect_to_relay_host(host, port).await?;
    let (reader, mut writer) = stream.into_split();

    let name_b64 = BASE64.encode(host_name.as_bytes());
    let lan_b64 = BASE64.encode(serde_json::to_vec(&lan_origins).unwrap_or_default());
    writer
        .write_all(format!("VIBEX-CTRL v2 {host_id} {token} {name_b64} {lan_b64}\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;

    {
        let mut snapshot = state.lock().await;
        snapshot.status = "connected".to_string();
        snapshot.error = None;
        snapshot.connected_key = Some(key.to_string());
    }

    let endpoint = TunnelEndpoint {
        host: host.to_string(),
        port,
    };
    let tenant_origin = utils::tunnel::format_tenant_origin("http", &endpoint, &host_id);
    set_quick_tunnel_origin(Some(tenant_origin.clone()));
    if let Ok(store) = load_store().await {
        publish_browser_origins(&store);
    }
    promote_pending_if_connected(host, port, token, &host_id).await;
    publish_domestic_beacon(host, port, &host_id, &tenant_origin).await;

    let (ctrl_tx, mut ctrl_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer_task = tokio::spawn(async move {
        while let Some(msg) = ctrl_rx.recv().await {
            if writer.write_all(msg.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let local_http_client = reqwest::Client::builder()
        .no_proxy()
        .pool_max_idle_per_host(16)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| err.to_string())?;

    let mut last_beacon_refresh = tokio::time::Instant::now();
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("OK ") {
            continue;
        }
        if let Some(err_reason) = trimmed.strip_prefix("ERR ") {
            writer_task.abort();
            return Err(format!("relay rejected control session: {err_reason}"));
        }
        // Backwards compatibility with v1 single-host relay script
        if let Some(id) = trimmed.strip_prefix("OPEN ") {
            let host = host.to_string();
            let token = token.to_string();
            let id = id.to_string();
            tokio::spawn(async move {
                let _ = open_data_path(host, port, token, id, local_port).await;
            });
            continue;
        }

        let Ok(frame) = serde_json::from_str::<RelayControlServerFrame>(trimmed) else {
            continue;
        };
        match frame {
            RelayControlServerFrame::Ping { ts } => {
                if let Ok(pong) = serde_json::to_string(&RelayControlClientFrame::Pong { ts }) {
                    let _ = ctrl_tx.send(format!("{pong}\n"));
                }
                if last_beacon_refresh.elapsed() >= Duration::from_secs(45) {
                    last_beacon_refresh = tokio::time::Instant::now();
                    let host_owned = host.to_string();
                    let host_id_owned = host_id.clone();
                    let tenant_origin_owned = tenant_origin.clone();
                    tokio::spawn(async move {
                        publish_domestic_beacon(
                            &host_owned,
                            port,
                            &host_id_owned,
                            &tenant_origin_owned,
                        )
                        .await;
                    });
                }
            }
            RelayControlServerFrame::ReplenishPool { count } => {
                let count = count.min(4);
                for _ in 0..count {
                    let host = host.to_string();
                    let host_id = host_id.clone();
                    let token = token.to_string();
                    tokio::spawn(async move {
                        let _ = open_prewarmed_pool_stream(host, port, host_id, token, local_port)
                            .await;
                    });
                }
            }
            RelayControlServerFrame::OpenData {
                host_id: target_host_id,
                conn_id,
            } => {
                if target_host_id != host_id {
                    continue;
                }
                let host = host.to_string();
                let host_id = host_id.clone();
                let token = token.to_string();
                tokio::spawn(async move {
                    let _ =
                        open_v2_data_path(host, port, host_id, token, conn_id, local_port).await;
                });
            }
            RelayControlServerFrame::HttpReq {
                host_id: req_host_id,
                id,
                method,
                path,
                headers,
                body_b64,
            } => {
                // Strict multi-tenant check: never process a request addressed to another host_id
                if req_host_id != host_id {
                    continue;
                }
                let client = local_http_client.clone();
                let ctrl_tx = ctrl_tx.clone();
                let host_id = host_id.clone();
                tokio::spawn(async move {
                    let url = format!("http://127.0.0.1:{local_port}{path}");
                    let m = reqwest::Method::from_bytes(method.as_bytes())
                        .unwrap_or(reqwest::Method::GET);
                    let mut req = client.request(m, &url);
                    for (k, v) in headers {
                        req = req.header(&k, &v);
                    }
                    let body = BASE64.decode(body_b64).unwrap_or_default();
                    if !body.is_empty() {
                        req = req.body(body);
                    }
                    let (status, out_headers, resp_bytes) = match req.send().await {
                        Ok(resp) => {
                            let status = resp.status().as_u16();
                            let mut hdrs = Vec::new();
                            for (k, v) in resp.headers() {
                                if let Ok(s) = v.to_str() {
                                    hdrs.push((k.as_str().to_string(), s.to_string()));
                                }
                            }
                            let bytes = resp.bytes().await.unwrap_or_default().to_vec();
                            (status, hdrs, bytes)
                        }
                        Err(_) => (502, Vec::new(), Vec::new()),
                    };
                    if let Ok(res_frame) =
                        serde_json::to_string(&RelayControlClientFrame::HttpRes {
                            host_id,
                            id,
                            status,
                            headers: out_headers,
                            body_b64: BASE64.encode(&resp_bytes),
                        })
                    {
                        let _ = ctrl_tx.send(format!("{res_frame}\n"));
                    }
                });
            }
        }
    }

    writer_task.abort();
    Err("tunnel control closed".to_string())
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
    let origin = utils::tunnel::format_tenant_origin(
        "http",
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

async fn open_prewarmed_pool_stream(
    host: String,
    port: u16,
    host_id: String,
    token: String,
    local_port: u16,
) -> Result<(), String> {
    let remote = connect_to_relay_host(&host, port).await?;
    let mut buf_remote = BufReader::new(remote);
    buf_remote
        .get_mut()
        .write_all(format!("VIBEX-DATA v2 {host_id} {token} POOL\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;

    let mut line = String::new();
    loop {
        line.clear();
        let n = buf_remote
            .read_line(&mut line)
            .await
            .map_err(|error| error.to_string())?;
        if n == 0 {
            return Ok(());
        }
        let cmd = line.trim();
        if cmd == "NOOP" {
            continue;
        }
        if let Some(target_host_id) = cmd.strip_prefix("USE ") {
            // Strict tenant check before bridging to local host service
            if target_host_id.trim() != host_id {
                return Err("tenant mismatch on prewarmed data stream".to_string());
            }
            break;
        }
    }

    let mut local = TcpStream::connect(("127.0.0.1", local_port))
        .await
        .map_err(|error| error.to_string())?;
    let _ = local.set_nodelay(true);
    let buffered = buf_remote.buffer().to_vec();
    let mut remote = buf_remote.into_inner();
    if !buffered.is_empty() {
        local
            .write_all(&buffered)
            .await
            .map_err(|error| error.to_string())?;
    }
    let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
    Ok(())
}

async fn open_v2_data_path(
    host: String,
    port: u16,
    host_id: String,
    token: String,
    id: String,
    local_port: u16,
) -> Result<(), String> {
    let mut local = TcpStream::connect(("127.0.0.1", local_port))
        .await
        .map_err(|error| error.to_string())?;
    let _ = local.set_nodelay(true);
    let mut remote = connect_to_relay_host(&host, port).await?;
    remote
        .write_all(format!("VIBEX-DATA v2 {host_id} {token} {id}\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
    Ok(())
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
    let mut remote = connect_to_relay_host(&host, port).await?;
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
    let Some(origin) = probe_endpoint_until(
        &endpoint,
        Some("http"),
        HEALTH_RETRY_ATTEMPTS,
        HEALTH_RETRY_DELAY,
    )
    .await?
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
                    "Sign in to your VibeX account to use the Official Cloud Relay".to_string(),
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
    lease: Option<AccountRelayLease>,
) -> Result<HostTunnelStatus, AppError> {
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
        ERR_NEED_COMMAND, HostTunnelStore, RelayState, SavedTunnel, merge_host_reachability,
        pending_setup_ready, relay_token_for, remember_relay,
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
    fn official_quick_tunnel_requires_valid_account_lease() {
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

        let signed_in_store = HostTunnelStore {
            enabled: true,
            account_lease: Some(super::AccountRelayLease {
                lease_token: "vbx_rly_v1.payload.sig".to_string(),
                expires_at: chrono::Utc::now().timestamp() + 3600,
                relay_host: "vibex.xforever.xin".to_string(),
                relay_port: 443,
                tenant_origin: "https://vibex.xforever.xin/t/my-host".to_string(),
                host_id: "my-host".to_string(),
                lease_version: 1,
                server_id: Some("official-cn-main".to_string()),
                server_name: Some("官方主云中继节点 (华东)".to_string()),
            }),
            ..HostTunnelStore::default()
        };
        let signed_in_status = super::status_from(&signed_in_store, &RelayState::default());
        assert!(
            signed_in_status
                .saved
                .iter()
                .any(|item| item.id == "auto-quick-tunnel"
                    && item.origin == "https://vibex.xforever.xin/t/my-host"
                    && item.name.as_deref() == Some("官方主云中继节点 (华东)"))
        );
        assert_eq!(
            signed_in_status.active_id.as_deref(),
            Some("auto-quick-tunnel")
        );
    }
}
