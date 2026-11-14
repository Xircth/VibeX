use std::{
    collections::{HashMap, VecDeque},
    net::SocketAddr,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{Mutex, RwLock, mpsc, oneshot},
};

pub const DEFAULT_RELAY_PORT: u16 = 17890;
const CTRL_PING_INTERVAL: Duration = Duration::from_secs(15);
const CTRL_READ_TIMEOUT: Duration = Duration::from_secs(45);
const HTTP_PROXY_TIMEOUT: Duration = Duration::from_secs(25);
const DATA_OPEN_TIMEOUT: Duration = Duration::from_secs(6);
const PREWARM_MAX_IDLE: Duration = Duration::from_secs(40);
const PREWARM_TARGET_POOL_SIZE: usize = 3;
const MAX_HTTP_BODY_BYTES: usize = 16 * 1024 * 1024;
const BEACON_TTL: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlServerFrame {
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
pub enum ControlClientFrame {
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

#[derive(Debug, Clone)]
pub struct ProxiedHttpResponse {
    pub host_id: String,
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

struct PrewarmedStream {
    created_at: Instant,
    stream: TcpStream,
}

pub struct HostSession {
    pub session_id: u64,
    pub host_id: String,
    pub token_sha256: String,
    pub host_name: RwLock<String>,
    pub lan_origins: RwLock<Vec<String>>,
    pub peer_slash24: Option<String>,
    ctrl_tx: mpsc::UnboundedSender<String>,
    pending_http: Mutex<HashMap<String, oneshot::Sender<ProxiedHttpResponse>>>,
    prewarmed_data: Mutex<VecDeque<PrewarmedStream>>,
    pending_data: Mutex<HashMap<String, oneshot::Sender<TcpStream>>>,
}

#[derive(Clone)]
struct BeaconEntry {
    created_at: Instant,
    timestamp_unix: i64,
    payload: serde_json::Value,
}

pub struct RelayServerState {
    next_session_id: AtomicU64,
    hosts: RwLock<HashMap<String, Arc<HostSession>>>,
    bound_tokens: RwLock<HashMap<String, String>>,
    token_store_path: Option<PathBuf>,
    beacons: RwLock<HashMap<String, VecDeque<BeaconEntry>>>,
}

impl Default for RelayServerState {
    fn default() -> Self {
        Self::new(None)
    }
}

impl RelayServerState {
    pub fn new(token_store_path: Option<PathBuf>) -> Self {
        let initial_tokens = token_store_path
            .as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(&raw).ok())
            .unwrap_or_default();
        Self {
            next_session_id: AtomicU64::new(1),
            hosts: RwLock::new(HashMap::new()),
            bound_tokens: RwLock::new(initial_tokens),
            token_store_path,
            beacons: RwLock::new(HashMap::new()),
        }
    }

    async fn verify_and_bind_host_token(&self, host_id: &str, token: &str) -> bool {
        if host_id.is_empty() || token.len() < 16 {
            return false;
        }
        let candidate_hash = sha256_hex(token);
        {
            let guard = self.bound_tokens.read().await;
            if let Some(existing) = guard.get(host_id) {
                return constant_time_eq(existing.as_bytes(), candidate_hash.as_bytes());
            }
        }
        let mut guard = self.bound_tokens.write().await;
        if let Some(existing) = guard.get(host_id) {
            return constant_time_eq(existing.as_bytes(), candidate_hash.as_bytes());
        }
        guard.insert(host_id.to_string(), candidate_hash);
        if let Some(path) = &self.token_store_path
            && let Ok(serialized) = serde_json::to_string_pretty(&*guard)
        {
            let _ = std::fs::write(path, serialized);
        }
        true
    }

    async fn verify_existing_host_token(&self, host_id: &str, token: &str) -> bool {
        let candidate_hash = sha256_hex(token);
        let guard = self.bound_tokens.read().await;
        guard.get(host_id).is_some_and(|existing| {
            constant_time_eq(existing.as_bytes(), candidate_hash.as_bytes())
        })
    }

    async fn get_host(&self, host_id: &str) -> Option<Arc<HostSession>> {
        self.hosts.read().await.get(host_id).cloned()
    }
}

pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn ipv4_slash24(addr: SocketAddr) -> Option<String> {
    match addr.ip() {
        std::net::IpAddr::V4(ip) => {
            let o = ip.octets();
            Some(format!("{}.{}.{}", o[0], o[1], o[2]))
        }
        std::net::IpAddr::V6(ip) => ip.to_ipv4_mapped().map(|v4| {
            let o = v4.octets();
            format!("{}.{}.{}", o[0], o[1], o[2])
        }),
    }
}

struct ChannelListener {
    rx: mpsc::UnboundedReceiver<(TcpStream, SocketAddr)>,
    local_addr: SocketAddr,
}

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
struct ClientPeerAddr(SocketAddr);

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, ChannelListener>>
    for ClientPeerAddr
{
    fn connect_info(stream: axum::serve::IncomingStream<'_, ChannelListener>) -> Self {
        Self(*stream.remote_addr())
    }
}

impl axum::serve::Listener for ChannelListener {
    type Io = TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.rx.recv().await {
            Some(pair) => pair,
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> tokio::io::Result<Self::Addr> {
        Ok(self.local_addr)
    }
}

pub async fn run_relay_server(
    listener: TcpListener,
    state: Arc<RelayServerState>,
) -> anyhow::Result<()> {
    let local_addr = listener.local_addr()?;
    let (http_tx, http_rx) = mpsc::unbounded_channel::<(TcpStream, SocketAddr)>();
    let channel_listener = ChannelListener {
        rx: http_rx,
        local_addr,
    };

    let router = build_http_router(state.clone());
    let _axum_task = tokio::spawn(async move {
        let _ = axum::serve(
            channel_listener,
            router.into_make_service_with_connect_info::<ClientPeerAddr>(),
        )
        .await;
    });

    loop {
        let (stream, peer_addr) = match listener.accept().await {
            Ok(pair) => pair,
            Err(err) => {
                tracing::warn!("accept error on relay listener: {err}");
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let state = state.clone();
        let http_tx = http_tx.clone();
        tokio::spawn(async move {
            dispatch_connection(stream, peer_addr, state, http_tx).await;
        });
    }
}

async fn dispatch_connection(
    stream: TcpStream,
    peer_addr: SocketAddr,
    state: Arc<RelayServerState>,
    http_tx: mpsc::UnboundedSender<(TcpStream, SocketAddr)>,
) {
    let mut peek_buf = [0u8; 2048];
    let n = match tokio::time::timeout(Duration::from_secs(4), stream.peek(&mut peek_buf)).await {
        Ok(Ok(n)) if n > 0 => n,
        _ => return,
    };
    let head = &peek_buf[..n];

    if head.starts_with(b"VIBEX-CTRL ") {
        handle_control_connection(stream, peer_addr, state).await;
        return;
    }
    if head.starts_with(b"VIBEX-DATA ") {
        handle_data_connection(stream, state).await;
        return;
    }
    if is_tunnel_upgrade_request(head) {
        handle_tunnel_upgrade_connection(stream, peer_addr, state).await;
        return;
    }
    if is_websocket_upgrade_for_tenant(head) {
        handle_websocket_proxy_connection(stream, state).await;
        return;
    }

    let _ = http_tx.send((stream, peer_addr));
}

fn is_tunnel_upgrade_request(head: &[u8]) -> bool {
    head.starts_with(b"GET /v1/tunnel ") || head.starts_with(b"GET /v1/tunnel?")
}

async fn handle_tunnel_upgrade_connection(
    mut stream: TcpStream,
    peer_addr: SocketAddr,
    state: Arc<RelayServerState>,
) {
    let mut peek_buf = [0u8; 4096];
    let mut header_end = None;
    for _ in 0..8 {
        let Ok(Ok(n)) =
            tokio::time::timeout(Duration::from_secs(4), stream.peek(&mut peek_buf)).await
        else {
            return;
        };
        if n == 0 {
            return;
        }
        if let Some(pos) = peek_buf[..n].windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = Some(pos + 4);
            break;
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    let Some(end_len) = header_end else {
        return;
    };

    let mut header_bytes = vec![0u8; end_len];
    if tokio::time::timeout(Duration::from_secs(4), stream.read_exact(&mut header_bytes))
        .await
        .is_err()
    {
        return;
    }

    let header_text = String::from_utf8_lossy(&header_bytes);
    let effective_peer = extract_forwarded_peer_addr(&header_text, peer_addr);

    let response =
        b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";
    if tokio::time::timeout(Duration::from_secs(4), stream.write_all(response))
        .await
        .is_err()
    {
        return;
    }

    let mut inner_peek = [0u8; 512];
    let Ok(Ok(n)) =
        tokio::time::timeout(Duration::from_secs(5), stream.peek(&mut inner_peek)).await
    else {
        return;
    };
    let head = &inner_peek[..n];
    if head.starts_with(b"VIBEX-CTRL ") {
        handle_control_connection(stream, effective_peer, state).await;
    } else if head.starts_with(b"VIBEX-DATA ") {
        handle_data_connection(stream, state).await;
    }
}

fn extract_forwarded_peer_addr(headers: &str, fallback: SocketAddr) -> SocketAddr {
    for line in headers.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("x-real-ip:")
            && let Ok(ip) = rest.trim().parse::<std::net::IpAddr>()
        {
            return SocketAddr::new(ip, fallback.port());
        }
        if let Some(rest) = lower.strip_prefix("x-forwarded-for:")
            && let Some(first) = rest.split(',').next()
            && let Ok(ip) = first.trim().parse::<std::net::IpAddr>()
        {
            return SocketAddr::new(ip, fallback.port());
        }
    }
    fallback
}

fn is_websocket_upgrade_for_tenant(head: &[u8]) -> bool {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.lines();
    let Some(first_line) = lines.next() else {
        return false;
    };
    if !first_line.starts_with("GET /t/") {
        return false;
    }
    lines.any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("upgrade:") && lower.contains("websocket")
    })
}

async fn handle_control_connection(
    stream: TcpStream,
    peer_addr: SocketAddr,
    state: Arc<RelayServerState>,
) {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    let Ok(Ok(Some(first_line))) =
        tokio::time::timeout(Duration::from_secs(5), lines.next_line()).await
    else {
        return;
    };

    let parts: Vec<&str> = first_line.split_whitespace().collect();
    // Format: VIBEX-CTRL v2 <host_id> <token> [name_b64] [lan_origins_b64]
    let (host_id, token, host_name, lan_origins) = if parts.len() >= 4 && parts[1] == "v2" {
        let host_id = parts[2].trim().to_string();
        let token = parts[3].trim().to_string();
        let host_name = parts
            .get(4)
            .and_then(|b64| BASE64.decode(b64).ok())
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "VibeX Desktop".to_string());
        let lan_origins = parts
            .get(5)
            .and_then(|b64| BASE64.decode(b64).ok())
            .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
            .unwrap_or_default();
        (host_id, token, host_name, lan_origins)
    } else if parts.len() == 2 {
        (
            "default".to_string(),
            parts[1].trim().to_string(),
            "VibeX Desktop".to_string(),
            Vec::new(),
        )
    } else {
        return;
    };

    if !state.verify_and_bind_host_token(&host_id, &token).await {
        let _ = writer.write_all(b"ERR unauthorized_host_token\n").await;
        return;
    }

    let (ctrl_tx, mut ctrl_rx) = mpsc::unbounded_channel::<String>();
    let session_id = state.next_session_id.fetch_add(1, Ordering::Relaxed);
    let session = Arc::new(HostSession {
        session_id,
        host_id: host_id.clone(),
        token_sha256: sha256_hex(&token),
        host_name: RwLock::new(host_name),
        lan_origins: RwLock::new(lan_origins),
        peer_slash24: ipv4_slash24(peer_addr),
        ctrl_tx: ctrl_tx.clone(),
        pending_http: Mutex::new(HashMap::new()),
        prewarmed_data: Mutex::new(VecDeque::new()),
        pending_data: Mutex::new(HashMap::new()),
    });

    state
        .hosts
        .write()
        .await
        .insert(host_id.clone(), session.clone());
    let _ = ctrl_tx.send(format!("OK {host_id}\n"));
    if let Ok(replenish) = serde_json::to_string(&ControlServerFrame::ReplenishPool {
        count: PREWARM_TARGET_POOL_SIZE,
    }) {
        let _ = ctrl_tx.send(format!("{replenish}\n"));
    }

    let write_task = tokio::spawn(async move {
        while let Some(msg) = ctrl_rx.recv().await {
            if writer.write_all(msg.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let mut ping_interval = tokio::time::interval(CTRL_PING_INTERVAL);
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = ping_interval.tick() => {
                if let Ok(frame) = serde_json::to_string(&ControlServerFrame::Ping {
                    ts: chrono::Utc::now().timestamp_millis(),
                })
                    && ctrl_tx.send(format!("{frame}\n")).is_err()
                {
                    break;
                }
                // Evict stale pre-warmed streams and ask Host to replenish if needed
                let needed = {
                    let mut pool = session.prewarmed_data.lock().await;
                    while pool.front().is_some_and(|item| item.created_at.elapsed() >= PREWARM_MAX_IDLE) {
                        pool.pop_front();
                    }
                    PREWARM_TARGET_POOL_SIZE.saturating_sub(pool.len())
                };
                if needed > 0
                    && let Ok(replenish) = serde_json::to_string(&ControlServerFrame::ReplenishPool { count: needed })
                {
                    let _ = ctrl_tx.send(format!("{replenish}\n"));
                }
            }
            line_res = tokio::time::timeout(CTRL_READ_TIMEOUT, lines.next_line()) => {
                let Ok(Ok(Some(line))) = line_res else {
                    break;
                };
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed == "PONG" {
                    continue;
                }
                if let Ok(frame) = serde_json::from_str::<ControlClientFrame>(trimmed) {
                    match frame {
                        ControlClientFrame::Pong { .. } => {}
                        ControlClientFrame::UpdateMeta { name, lan_origins } => {
                            if !name.trim().is_empty() {
                                *session.host_name.write().await = name;
                            }
                            *session.lan_origins.write().await = lan_origins;
                        }
                        ControlClientFrame::HttpRes {
                            host_id: res_host_id,
                            id,
                            status,
                            headers,
                            body_b64,
                        } => {
                            // Strict tenant check: never accept a response whose host_id mismatches this control stream
                            if res_host_id != session.host_id {
                                tracing::warn!(
                                    "tenant mismatch on HttpRes: expected {}, got {}",
                                    session.host_id,
                                    res_host_id
                                );
                                continue;
                            }
                            let Some(sender) = session.pending_http.lock().await.remove(&id) else {
                                continue;
                            };
                            let body = BASE64.decode(body_b64).unwrap_or_default();
                            let _ = sender.send(ProxiedHttpResponse {
                                host_id: res_host_id,
                                status,
                                headers,
                                body,
                            });
                        }
                    }
                }
            }
        }
    }

    write_task.abort();
    let mut hosts = state.hosts.write().await;
    if hosts
        .get(&host_id)
        .is_some_and(|current| current.session_id == session_id)
    {
        hosts.remove(&host_id);
    }
}

async fn handle_data_connection(stream: TcpStream, state: Arc<RelayServerState>) {
    let mut reader = BufReader::new(stream);
    let mut first_line = String::new();
    let Ok(Ok(n)) =
        tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut first_line)).await
    else {
        return;
    };
    if n == 0 {
        return;
    }
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    // Format: VIBEX-DATA v2 <host_id> <token> <conn_id_or_POOL>
    let (host_id, token, conn_id) = if parts.len() >= 5 && parts[1] == "v2" {
        (parts[2].trim(), parts[3].trim(), parts[4].trim())
    } else if parts.len() == 3 {
        ("default", parts[1].trim(), parts[2].trim())
    } else {
        return;
    };

    if !state.verify_existing_host_token(host_id, token).await {
        return;
    }
    let Some(session) = state.get_host(host_id).await else {
        return;
    };

    let stream = reader.into_inner();
    if conn_id == "POOL" {
        let mut pool = session.prewarmed_data.lock().await;
        while pool.len() >= PREWARM_TARGET_POOL_SIZE * 2 {
            pool.pop_front();
        }
        pool.push_back(PrewarmedStream {
            created_at: Instant::now(),
            stream,
        });
    } else if let Some(sender) = session.pending_data.lock().await.remove(conn_id) {
        let _ = sender.send(stream);
    }
}

async fn acquire_host_data_stream(session: &Arc<HostSession>) -> Option<TcpStream> {
    // 1. Try pre-warmed stream first (0ms handshake)
    loop {
        let candidate = session.prewarmed_data.lock().await.pop_front();
        let Some(mut item) = candidate else {
            break;
        };
        if item.created_at.elapsed() >= PREWARM_MAX_IDLE {
            continue;
        }
        let activate_line = format!("USE {}\n", session.host_id);
        if item
            .stream
            .write_all(activate_line.as_bytes())
            .await
            .is_ok()
        {
            if let Ok(replenish) =
                serde_json::to_string(&ControlServerFrame::ReplenishPool { count: 1 })
            {
                let _ = session.ctrl_tx.send(format!("{replenish}\n"));
            }
            return Some(item.stream);
        }
    }

    // 2. Fallback: request an immediate on-demand data stream from the Host
    let conn_id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = oneshot::channel();
    session
        .pending_data
        .lock()
        .await
        .insert(conn_id.clone(), tx);
    let open_frame = serde_json::to_string(&ControlServerFrame::OpenData {
        host_id: session.host_id.clone(),
        conn_id: conn_id.clone(),
    })
    .ok()?;
    if session.ctrl_tx.send(format!("{open_frame}\n")).is_err() {
        session.pending_data.lock().await.remove(&conn_id);
        return None;
    }
    match tokio::time::timeout(DATA_OPEN_TIMEOUT, rx).await {
        Ok(Ok(stream)) => Some(stream),
        _ => {
            session.pending_data.lock().await.remove(&conn_id);
            None
        }
    }
}

async fn handle_websocket_proxy_connection(
    mut client_stream: TcpStream,
    state: Arc<RelayServerState>,
) {
    // Read up to the end of HTTP headers (\r\n\r\n)
    let mut header_buf = Vec::with_capacity(2048);
    let mut byte = [0u8; 1];
    let read_res = tokio::time::timeout(Duration::from_secs(5), async {
        while header_buf.len() < 16384 {
            let n = client_stream.read(&mut byte).await?;
            if n == 0 {
                break;
            }
            header_buf.push(byte[0]);
            if header_buf.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        Ok::<_, std::io::Error>(())
    })
    .await;
    if read_res.is_err() || !header_buf.ends_with(b"\r\n\r\n") {
        return;
    }

    let raw_headers = String::from_utf8_lossy(&header_buf);
    let mut lines = raw_headers.split("\r\n");
    let Some(request_line) = lines.next() else {
        return;
    };
    let req_parts: Vec<&str> = request_line.split_whitespace().collect();
    if req_parts.len() < 3 {
        return;
    }
    let method = req_parts[0];
    let full_uri = req_parts[1];
    let version = req_parts[2];

    let Some((host_id, stripped_path)) = parse_tenant_path(full_uri) else {
        let _ = client_stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
            .await;
        return;
    };

    let Some(session) = state.get_host(&host_id).await else {
        let _ = client_stream
            .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            .await;
        return;
    };

    let Some(mut host_stream) = acquire_host_data_stream(&session).await else {
        let _ = client_stream
            .write_all(b"HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\n\r\n")
            .await;
        return;
    };

    // Rewrite request line and normalize Host / strip Origin so Host local server accepts WebSocket
    let mut rewritten = format!("{method} {stripped_path} {version}\r\nHost: 127.0.0.1\r\n");
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("host:") || lower.starts_with("origin:") {
            continue;
        }
        rewritten.push_str(line);
        rewritten.push_str("\r\n");
    }
    rewritten.push_str("\r\n");

    if host_stream.write_all(rewritten.as_bytes()).await.is_err() {
        return;
    }

    let _ = tokio::io::copy_bidirectional(&mut client_stream, &mut host_stream).await;
}

fn parse_tenant_path(uri: &str) -> Option<(String, String)> {
    let rest = uri.strip_prefix("/t/")?;
    let (host_id, tail) = match rest.find(['/', '?']) {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    if host_id.trim().is_empty() {
        return None;
    }
    let normalized_tail = if tail.starts_with('?') {
        format!("/{tail}")
    } else if tail.is_empty() {
        "/".to_string()
    } else {
        tail.to_string()
    };
    Some((host_id.to_string(), normalized_tail))
}

fn build_http_router(state: Arc<RelayServerState>) -> Router {
    Router::new()
        .route("/health", get(relay_health_handler))
        .route("/v1/discover/same-net", get(discover_same_net_handler))
        .route(
            "/v1/beacon/{topic}",
            post(publish_beacon_handler).get(query_beacon_handler),
        )
        .route("/t/{host_id}", any(proxy_tenant_root_handler))
        .route("/t/{host_id}/", any(proxy_tenant_root_handler))
        .route("/t/{host_id}/{*path}", any(proxy_tenant_path_handler))
        .with_state(state)
}

async fn relay_health_handler(State(state): State<Arc<RelayServerState>>) -> impl IntoResponse {
    let online_hosts = state.hosts.read().await.len();
    Json(json!({
        "status": "ok",
        "service": "vibex-relay-server",
        "online_hosts": online_hosts,
    }))
}

async fn discover_same_net_handler() -> impl IntoResponse {
    // Public subnet enumeration is disabled to prevent cross-user host and LAN IP disclosure.
    Json(json!({
        "slash24": serde_json::Value::Null,
        "hosts": [],
    }))
}

fn is_allowed_private_beacon_topic(topic: &str) -> bool {
    let Some(hex_part) = topic
        .strip_prefix("vbx-h-")
        .or_else(|| topic.strip_prefix("vbx-p-"))
    else {
        return false;
    };
    hex_part.len() == 32 && hex_part.bytes().all(|b| b.is_ascii_hexdigit())
}

async fn publish_beacon_handler(
    State(state): State<Arc<RelayServerState>>,
    Path(topic): Path<String>,
    body: String,
) -> impl IntoResponse {
    let topic = topic.trim().to_string();
    if !is_allowed_private_beacon_topic(&topic) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let mut beacons = state.beacons.write().await;
    let queue = beacons.entry(topic).or_default();
    while queue
        .front()
        .is_some_and(|item| item.created_at.elapsed() >= BEACON_TTL)
    {
        queue.pop_front();
    }
    while queue.len() >= 16 {
        queue.pop_front();
    }
    queue.push_back(BeaconEntry {
        created_at: Instant::now(),
        timestamp_unix: chrono::Utc::now().timestamp(),
        payload,
    });
    StatusCode::OK.into_response()
}

async fn query_beacon_handler(
    State(state): State<Arc<RelayServerState>>,
    Path(topic): Path<String>,
) -> impl IntoResponse {
    let topic = topic.trim();
    if !is_allowed_private_beacon_topic(topic) {
        return Json(json!({ "entries": [] }));
    }
    let mut beacons = state.beacons.write().await;
    let Some(queue) = beacons.get_mut(topic) else {
        return Json(json!({ "entries": [] }));
    };
    while queue
        .front()
        .is_some_and(|item| item.created_at.elapsed() >= BEACON_TTL)
    {
        queue.pop_front();
    }
    let entries: Vec<serde_json::Value> = queue
        .iter()
        .rev()
        .map(|entry| {
            json!({
                "ts": entry.timestamp_unix,
                "payload": entry.payload,
            })
        })
        .collect();
    Json(json!({ "entries": entries }))
}

async fn proxy_tenant_root_handler(
    State(state): State<Arc<RelayServerState>>,
    Path(host_id): Path<String>,
    request: Request,
) -> Response {
    proxy_tenant_inner(state, host_id, "/".to_string(), request).await
}

async fn proxy_tenant_path_handler(
    State(state): State<Arc<RelayServerState>>,
    Path((host_id, path)): Path<(String, String)>,
    request: Request,
) -> Response {
    let normalized = if path.starts_with('/') {
        path
    } else {
        format!("/{path}")
    };
    proxy_tenant_inner(state, host_id, normalized, request).await
}

async fn proxy_tenant_inner(
    state: Arc<RelayServerState>,
    host_id: String,
    stripped_path: String,
    request: Request,
) -> Response {
    let host_id = host_id.trim().to_string();
    let Some(session) = state.get_host(&host_id).await else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "status": "offline",
                "host_id": host_id,
                "message": "Target VibeX Host is not currently connected to the relay",
            })),
        )
            .into_response();
    };

    if stripped_path == "/health" && request.method() == axum::http::Method::GET {
        let host_name = session.host_name.read().await.clone();
        let mut resp = Json(json!({
            "status": "ok",
            "version": "0.4.3",
            "release": false,
            "host_id": session.host_id,
            "name": host_name,
        }))
        .into_response();
        if let Ok(hv) = HeaderValue::from_str(&session.host_id) {
            resp.headers_mut().insert("x-vibex-routed-host-id", hv);
        }
        return resp;
    }

    let method = request.method().as_str().to_string();
    let path_and_query = match request.uri().query() {
        Some(q) if !q.is_empty() => format!("{stripped_path}?{q}"),
        _ => stripped_path,
    };

    let mut headers = Vec::new();
    for (name, value) in request.headers() {
        let lower = name.as_str().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "host" | "origin" | "connection" | "transfer-encoding" | "content-length"
        ) {
            continue;
        }
        if let Ok(val_str) = value.to_str() {
            headers.push((name.as_str().to_string(), val_str.to_string()));
        }
    }

    let Ok(body_bytes) = to_bytes(request.into_body(), MAX_HTTP_BODY_BYTES).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };

    let req_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    session.pending_http.lock().await.insert(req_id.clone(), tx);

    let frame = match serde_json::to_string(&ControlServerFrame::HttpReq {
        host_id: host_id.clone(),
        id: req_id.clone(),
        method,
        path: path_and_query,
        headers,
        body_b64: BASE64.encode(&body_bytes),
    }) {
        Ok(s) => s,
        Err(_) => {
            session.pending_http.lock().await.remove(&req_id);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if session.ctrl_tx.send(format!("{frame}\n")).is_err() {
        session.pending_http.lock().await.remove(&req_id);
        return StatusCode::BAD_GATEWAY.into_response();
    }

    let proxied = match tokio::time::timeout(HTTP_PROXY_TIMEOUT, rx).await {
        Ok(Ok(res)) => res,
        _ => {
            session.pending_http.lock().await.remove(&req_id);
            return StatusCode::GATEWAY_TIMEOUT.into_response();
        }
    };

    // Double check tenant isolation before returning response to caller
    if proxied.host_id != host_id {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let status = StatusCode::from_u16(proxied.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response_headers = HeaderMap::new();
    for (k, v) in proxied.headers {
        let lower = k.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "transfer-encoding" | "connection" | "content-length"
        ) {
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(&v),
        ) {
            response_headers.insert(name, val);
        }
    }
    if let Ok(routed_val) = HeaderValue::from_str(&host_id) {
        response_headers.insert(
            HeaderName::from_static("x-vibex-routed-host-id"),
            routed_val,
        );
    }
    response_headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );

    (status, response_headers, Body::from(proxied.body)).into_response()
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn shared_cloud_discovery_beacon_topic_is_rejected() {
        assert!(!is_allowed_private_beacon_topic("vbx-cloud-hosts-v1"));
        assert!(!is_allowed_private_beacon_topic(""));
        assert!(!is_allowed_private_beacon_topic("vbx-h-short"));
        assert!(!is_allowed_private_beacon_topic(
            "vbx-h-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
        ));
    }

    #[test]
    fn private_host_and_pairing_code_beacon_topics_are_accepted() {
        let host_hash = &sha256_hex("vibex-host-v1:test-host")[..32];
        let pair_hash = &sha256_hex("vibex-pair-code-v1:ABCD2345")[..32];
        assert!(is_allowed_private_beacon_topic(&format!(
            "vbx-h-{host_hash}"
        )));
        assert!(is_allowed_private_beacon_topic(&format!(
            "vbx-p-{pair_hash}"
        )));
    }
}
