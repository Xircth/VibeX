use std::{
    collections::BTreeSet,
    net::IpAddr,
    path::{Component, Path as FsPath},
    sync::{Arc, OnceLock, RwLock},
};

use application::{ApplicationCore, CommandRegistry, ConversationRepository};
use axum::{
    Json, Router,
    body::Body,
    extract::{Extension, OriginalUri, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use local_deployment::pty::PtyService;
use remote_protocol::{
    CapabilityId, CommandRequest, ConversationId, CreatePairingRequest, DeviceId,
    DevicePermissionPreset, ErrorCode, ErrorEnvelope, IssuedPairingInvitation, OperationId,
    PairingInvitationPayload, RedeemPairingRequest, ServerCapabilities,
};
use serde::Deserialize;
use serde_json::json;

use crate::{
    AuthStoreError, AuthenticatedCredential, ServerAuth, ServerConfig, ServerCredentials,
    ServerToken, SqliteServerAuth, auth::StaticServerAuth,
};

pub(crate) struct ServerState<R> {
    pub(crate) auth: Arc<dyn ServerAuth>,
    pub(crate) capabilities: ServerCapabilities,
    pub(crate) core: Arc<ApplicationCore<R>>,
    pub(crate) commands: CommandRegistry<R>,
    pub(crate) config: ServerConfig,
    pub(crate) preview_proxy: crate::PreviewProxyRegistry,
    pub(crate) preview_client: reqwest::Client,
    pub(crate) pty: PtyService,
}

pub struct ServerRuntime<R> {
    config: ServerConfig,
    state: Arc<ServerState<R>>,
}

impl<R> ServerRuntime<R>
where
    R: ConversationRepository + Send + Sync + 'static,
{
    pub fn new(config: ServerConfig, token: ServerToken, core: ApplicationCore<R>) -> Self {
        Self::from_credentials(config, ServerCredentials::from_token(&token), core)
    }

    pub fn from_credentials(
        config: ServerConfig,
        credentials: ServerCredentials,
        core: ApplicationCore<R>,
    ) -> Self {
        Self::from_credentials_with_preview_proxy(
            config,
            credentials,
            core,
            crate::PreviewProxyRegistry::default(),
        )
    }

    pub fn from_credentials_with_preview_proxy(
        config: ServerConfig,
        credentials: ServerCredentials,
        core: ApplicationCore<R>,
        preview_proxy: crate::PreviewProxyRegistry,
    ) -> Self {
        Self::from_auth_with_preview_proxy_inner(
            config,
            Arc::new(StaticServerAuth::new(credentials)),
            core,
            preview_proxy,
            PtyService::new(),
        )
    }

    pub fn from_sqlite_auth(
        config: ServerConfig,
        pool: sqlx::SqlitePool,
        core: ApplicationCore<R>,
    ) -> Self {
        Self::from_auth_with_preview_proxy_inner(
            config,
            Arc::new(SqliteServerAuth::new(pool)),
            core,
            crate::PreviewProxyRegistry::default(),
            PtyService::new(),
        )
    }

    pub fn from_sqlite_auth_with_preview_proxy_and_pty(
        config: ServerConfig,
        pool: sqlx::SqlitePool,
        core: ApplicationCore<R>,
        preview_proxy: crate::PreviewProxyRegistry,
        pty: PtyService,
    ) -> Self {
        Self::from_auth_with_preview_proxy_inner(
            config,
            Arc::new(SqliteServerAuth::new(pool)),
            core,
            preview_proxy,
            pty,
        )
    }

    pub fn from_auth_with_preview_proxy(
        config: ServerConfig,
        auth: Arc<dyn ServerAuth>,
        core: ApplicationCore<R>,
        preview_proxy: crate::PreviewProxyRegistry,
    ) -> Self {
        Self::from_auth_with_preview_proxy_inner(
            config,
            auth,
            core,
            preview_proxy,
            PtyService::new(),
        )
    }

    fn from_auth_with_preview_proxy_inner(
        config: ServerConfig,
        auth: Arc<dyn ServerAuth>,
        core: ApplicationCore<R>,
        preview_proxy: crate::PreviewProxyRegistry,
        pty: PtyService,
    ) -> Self {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let capabilities = ServerCapabilities {
            server_version: config.server_version.clone(),
            protocol_version: remote_protocol::PROTOCOL_VERSION.to_string(),
            minimum_client_version: config.minimum_client_version.clone(),
            host_id: config.host_id.clone(),
            reachability: config.reachability.clone(),
            capabilities: vec![
                CapabilityId::new("conversation.read"),
                CapabilityId::new("conversation.write"),
                CapabilityId::new("conversation.attach"),
                CapabilityId::new("conversation.permission"),
                CapabilityId::new("conversation.question"),
                CapabilityId::new("conversation.cancel"),
                CapabilityId::new("conversation.steer"),
                CapabilityId::new("application.call"),
                CapabilityId::new("plugin.read"),
                CapabilityId::new("plugin.write"),
                CapabilityId::new("plugin.surface"),
                CapabilityId::new("artifact.read"),
                CapabilityId::new("artifact.preview"),
                CapabilityId::new("preview.proxy"),
                CapabilityId::new("automation.read"),
                CapabilityId::new("automation.write"),
                CapabilityId::new("delegation.read"),
                CapabilityId::new("delegation.cancel"),
                CapabilityId::new("workflow.read"),
                CapabilityId::new("workflow.write"),
                CapabilityId::new("workflow.run"),
                CapabilityId::new("workflow.approve"),
                CapabilityId::new("device.pair"),
                CapabilityId::new("device.revoke"),
                CapabilityId::new("notification.summary"),
                CapabilityId::new("offline.read"),
                CapabilityId::new("file.read"),
                CapabilityId::new("file.write"),
                CapabilityId::new("git.read"),
                CapabilityId::new("git.write"),
                CapabilityId::new("terminal"),
                CapabilityId::new("workspace.read"),
                CapabilityId::new("workspace.write"),
                CapabilityId::new("project.write"),
                CapabilityId::new("session.write"),
                CapabilityId::new("agent.read"),
                CapabilityId::new("agent.write"),
            ],
        };
        let core = Arc::new(core);
        Self {
            config: config.clone(),
            state: Arc::new(ServerState {
                auth,
                capabilities,
                commands: CommandRegistry::from_core(Arc::clone(&core)),
                core,
                config,
                preview_proxy,
                preview_client: crate::preview_proxy::preview_client()
                    .expect("build loopback-only preview client"),
                pty,
            }),
        }
    }

    pub const fn config(&self) -> &ServerConfig {
        &self.config
    }

    pub fn router(&self) -> Router {
        let protected = Router::new()
            .route("/capabilities", get(capabilities::<R>))
            .route("/ws", get(crate::ws::ws_handler::<R>))
            .route("/call/{command}", post(application_call::<R>))
            .route("/auth/pairings", post(create_pairing::<R>))
            .route("/auth/devices/{device_id}", delete(revoke_device::<R>))
            .route(
                "/conversations/{conversation_id}/offline",
                get(offline_conversation::<R>),
            )
            .route(
                "/conversations/{conversation_id}/notification-summary",
                get(notification_summary::<R>),
            )
            .route("/terminals/{session_id}/output", get(terminal_output::<R>))
            .route_layer(middleware::from_fn_with_state(
                Arc::clone(&self.state),
                require_token::<R>,
            ));
        Router::new()
            .route("/health", get(health::<R>))
            .route("/api/v1/auth/pairings/redeem", post(redeem_pairing::<R>))
            .route(
                "/api/v1/previews/{lease_id}",
                get(crate::preview_proxy::proxy_root::<R>),
            )
            .route(
                "/api/v1/previews/{lease_id}/{*path}",
                get(crate::preview_proxy::proxy_path::<R>),
            )
            .nest("/api/v1", protected)
            .fallback(get(static_asset::<R>))
            .with_state(Arc::clone(&self.state))
            .layer(middleware::from_fn_with_state(
                Arc::clone(&self.state),
                enforce_origin::<R>,
            ))
    }

    pub fn preview_proxy_registry(&self) -> crate::PreviewProxyRegistry {
        self.state.preview_proxy.clone()
    }
}

fn host_listen_page(path: &str) -> Response {
    let path = path.trim_start_matches('/');
    if path == "api" || path.starts_with("api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !path.is_empty() && path != "index.html" {
        return StatusCode::NOT_FOUND.into_response();
    }
    const HTML: &str = r#"<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>VibeX Host</title><style>html,body{margin:0;min-height:100%;background:#eef1f5;color:#46505b;font:16px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}main{box-sizing:border-box;max-width:22.5rem;margin:18vh auto 0;padding:28px 24px;border:1px solid #0b16280f;border-radius:14px;background:#fafbfc}h1{margin:0 0 8px;color:#1d2530;font-size:1.125rem;font-weight:600}p{margin:0;color:#727b85}</style><body><main><h1>VibeX Host</h1><p>远程协议已在运行。请在本机控制台出示配对邀请，不要扫描这个地址。</p></main></body></html>"#;
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        )],
        HTML,
    )
        .into_response()
}

async fn static_asset<R>(
    State(state): State<Arc<ServerState<R>>>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let Some(root) = state.config.static_root.as_ref() else {
        return host_listen_page(uri.path());
    };
    let path = uri.path().trim_start_matches('/');
    if path == "api" || path.starts_with("api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let relative = if path.is_empty() { "index.html" } else { path };
    let relative_path = FsPath::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let root = match tokio::fs::canonicalize(root).await {
        Ok(root) => root,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let requested = root.join(relative_path);
    let selected = match tokio::fs::canonicalize(&requested).await {
        Ok(path) if path.starts_with(&root) && path.is_file() => path,
        _ => root.join("index.html"),
    };
    if !selected.starts_with(&root) || !selected.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let bytes = match tokio::fs::read(&selected).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let content_type = match selected
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
    {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    (
        [(header::CONTENT_TYPE, HeaderValue::from_static(content_type))],
        Body::from(bytes),
    )
        .into_response()
}

static EXTRA_BROWSER_ORIGINS: OnceLock<RwLock<BTreeSet<String>>> = OnceLock::new();

fn extra_browser_origins() -> &'static RwLock<BTreeSet<String>> {
    EXTRA_BROWSER_ORIGINS.get_or_init(|| RwLock::new(BTreeSet::new()))
}

/// Origins browsers use when the Host is reached through a published tunnel
/// whose port differs from the local listen port.
pub fn set_extra_browser_origins(origins: impl IntoIterator<Item = impl Into<String>>) {
    let Ok(mut guard) = extra_browser_origins().write() else {
        return;
    };
    guard.clear();
    guard.extend(origins.into_iter().map(Into::into));
}

async fn enforce_origin<R>(
    State(state): State<Arc<ServerState<R>>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(origin) = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned)
    else {
        return next.run(request).await;
    };
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    if !origin_matches_request_host(&origin, host) && !origin_allowed(&state.config, &origin) {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorEnvelope::new(
                ErrorCode::Forbidden,
                "request origin is not allowed",
                false,
                OperationId::new(),
            )),
        )
            .into_response();
    }
    if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        apply_cors_headers(response.headers_mut(), &origin);
        return response;
    }
    let mut response = next.run(request).await;
    apply_cors_headers(response.headers_mut(), &origin);
    response
}

fn origin_matches_request_host(origin: &str, host_header: Option<&str>) -> bool {
    let Some(host_header) = host_header.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let Ok(uri) = origin.parse::<axum::http::Uri>() else {
        return false;
    };
    if !matches!(uri.scheme_str(), Some("http") | Some("https")) {
        return false;
    }
    let Some(authority) = uri.authority() else {
        return false;
    };
    if authority.as_str().eq_ignore_ascii_case(host_header) {
        return true;
    }
    let origin_port = authority.port_u16().unwrap_or(match uri.scheme_str() {
        Some("https") => 443,
        _ => 80,
    });
    let (header_host, header_port) = split_host_header(host_header, origin_port);
    authority.host().eq_ignore_ascii_case(&header_host) && origin_port == header_port
}

fn split_host_header(host_header: &str, default_port: u16) -> (String, u16) {
    if let Some(rest) = host_header.strip_prefix('[')
        && let Some((host, remainder)) = rest.split_once(']')
    {
        if let Some(port) = remainder
            .strip_prefix(':')
            .and_then(|value| value.parse().ok())
        {
            return (host.to_string(), port);
        }
        return (host.to_string(), default_port);
    }
    if let Some((host, port)) = host_header.rsplit_once(':')
        && let Ok(port) = port.parse::<u16>()
        && host.chars().filter(|ch| *ch == ':').count() == 0
    {
        return (host.to_string(), port);
    }
    (host_header.to_string(), default_port)
}

fn origin_allowed(config: &ServerConfig, origin: &str) -> bool {
    if extra_browser_origins()
        .read()
        .ok()
        .is_some_and(|origins| origins.contains(origin))
    {
        return true;
    }
    if config.allowed_origins.contains(origin) {
        return true;
    }
    if config.reachability.iter().any(|item| item.origin == origin) {
        return true;
    }
    let Ok(uri) = origin.parse::<axum::http::Uri>() else {
        return false;
    };
    if !matches!(uri.scheme_str(), Some("http") | Some("https")) {
        return false;
    }
    let Some(authority) = uri.authority() else {
        return false;
    };
    let origin_port = authority.port_u16().unwrap_or(match uri.scheme_str() {
        Some("https") => 443,
        _ => 80,
    });
    let host = authority.host();
    let listen_ip = config.listen_addr.ip();
    if is_loopback_host(host) {
        return listen_ip.is_loopback() || listen_ip.is_unspecified();
    }
    if origin_port != config.listen_addr.port() {
        return false;
    }
    let Ok(origin_ip) = host.parse::<IpAddr>() else {
        return false;
    };
    origin_ip == listen_ip || (listen_ip.is_unspecified() && is_lan_ip(origin_ip))
}

fn is_loopback_host(host: &str) -> bool {
    let host = host
        .trim_matches(|character| character == '[' || character == ']')
        .to_ascii_lowercase();
    host == "localhost"
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn is_lan_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_multicast()
        }
        IpAddr::V6(ip) => ip.is_unique_local() && !ip.is_loopback() && !ip.is_multicast(),
    }
}

fn bearer_token(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let rest = trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
        .or_else(|| trimmed.strip_prefix("BEARER "))?;
    let token = rest.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_owned())
    }
}

fn apply_cors_headers(headers: &mut HeaderMap, origin: &str) {
    if let Ok(origin) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("authorization, content-type, x-vibex-protocol-version"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
}

async fn application_call<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Path(command): Path<String>,
    Json(request): Json<CommandRequest<serde_json::Value>>,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    let principal = credential.principal();
    match state
        .commands
        .execute_name(&principal, &command, request.operation_id, request.args)
        .await
    {
        Ok(response) => Json(response).into_response(),
        Err(error) => application_error_response(error),
    }
}

async fn health<R>(State(state): State<Arc<ServerState<R>>>) -> Json<serde_json::Value>
where
    R: Send + Sync + 'static,
{
    let mut body = json!({ "status": "ok" });
    if !state.config.host_id.is_empty() {
        body["host_id"] = json!(state.config.host_id);
    }
    if let Some(name) = utils::net::local_hostname() {
        body["name"] = json!(name);
    }
    Json(body)
}

async fn capabilities<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    headers: HeaderMap,
) -> Response {
    if let Some(requested) = headers
        .get("x-vibex-protocol-version")
        .and_then(|value| value.to_str().ok())
    {
        let requested_major = requested
            .split_once('.')
            .map_or(requested, |(major, _)| major);
        let supported = remote_protocol::PROTOCOL_VERSION;
        let supported_major = supported
            .split_once('.')
            .map_or(supported, |(major, _)| major);
        if requested_major != supported_major {
            return (
                StatusCode::CONFLICT,
                Json(
                    ErrorEnvelope::new(
                        ErrorCode::Conflict,
                        format!(
                            "protocol major {requested_major} is incompatible with {supported}"
                        ),
                        false,
                        OperationId::new(),
                    )
                    .with_details(json!({ "supported_protocol": supported })),
                ),
            )
                .into_response();
        }
    }
    let mut capabilities = state.capabilities.clone();
    capabilities
        .capabilities
        .retain(|capability| credential.grants_capability(capability.as_str()));
    Json(capabilities).into_response()
}

async fn require_token<R>(
    State(state): State<Arc<ServerState<R>>>,
    mut request: Request,
    next: Next,
) -> Response {
    let candidate = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(bearer_token)
        .or_else(|| {
            request
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|value| value.to_str().ok())
                .and_then(ws_token_from_protocols)
        });
    if let Some(candidate) = candidate {
        match state.auth.authenticate(&candidate).await {
            Ok(Some(credential)) => {
                request.extensions_mut().insert(credential);
                return next.run(request).await;
            }
            Ok(None) => {}
            Err(error) => return auth_error_response(error),
        }
    }

    (
        StatusCode::UNAUTHORIZED,
        Json(ErrorEnvelope::new(
            ErrorCode::Unauthorized,
            "invalid or missing bearer token",
            false,
            OperationId::new(),
        )),
    )
        .into_response()
}

async fn create_pairing<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Json(request): Json<CreatePairingRequest>,
) -> Response {
    let preset = request
        .preset
        .unwrap_or(DevicePermissionPreset::Workstation);
    match state.auth.create_pairing(&credential, request).await {
        Ok(challenge) => {
            let payload = PairingInvitationPayload::from_challenge(
                state.config.host_id.clone(),
                preset,
                &challenge,
                state.config.reachability.clone(),
            );
            (
                StatusCode::CREATED,
                Json(IssuedPairingInvitation::from_payload(challenge, payload)),
            )
                .into_response()
        }
        Err(error) => auth_error_response(error),
    }
}

async fn redeem_pairing<R>(
    State(state): State<Arc<ServerState<R>>>,
    Json(request): Json<RedeemPairingRequest>,
) -> Response {
    match state.auth.redeem_pairing(request).await {
        Ok(credential) => (StatusCode::CREATED, Json(credential)).into_response(),
        Err(error) => auth_error_response(error),
    }
}

async fn revoke_device<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Path(device_id): Path<String>,
) -> Response {
    let device_id = match device_id.parse::<DeviceId>() {
        Ok(device_id) => device_id,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorEnvelope::new(
                    ErrorCode::BadRequest,
                    "device id is invalid",
                    false,
                    OperationId::new(),
                )),
            )
                .into_response();
        }
    };
    match state.auth.revoke_device(&credential, device_id).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => auth_error_response(error),
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
struct OfflineQuery {
    #[serde(default)]
    after_sequence: i64,
}

async fn offline_conversation<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Path(conversation_id): Path<String>,
    Query(query): Query<OfflineQuery>,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    let conversation_id = match ConversationId::parse(&conversation_id) {
        Ok(conversation_id) => conversation_id,
        Err(_) => return bad_request("conversation id is invalid"),
    };
    if query.after_sequence < 0 {
        return bad_request("after_sequence must be non-negative");
    }
    match state
        .core
        .offline_conversation_cache(
            &credential.principal(),
            conversation_id,
            query.after_sequence,
        )
        .await
    {
        Ok(cache) => Json(cache).into_response(),
        Err(error) => application_error_response(error.into_envelope()),
    }
}

async fn notification_summary<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    Path(conversation_id): Path<String>,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    let conversation_id = match ConversationId::parse(&conversation_id) {
        Ok(conversation_id) => conversation_id,
        Err(_) => return bad_request("conversation id is invalid"),
    };
    match state
        .core
        .terminal_notification_summary(&credential.principal(), conversation_id)
        .await
    {
        Ok(summary) => Json(summary).into_response(),
        Err(error) => application_error_response(error.into_envelope()),
    }
}

async fn terminal_output<R>(
    State(state): State<Arc<ServerState<R>>>,
    Path(session_id): Path<uuid::Uuid>,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    if !state.pty.session_exists(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorEnvelope::new(
                ErrorCode::NotFound,
                format!("terminal {session_id} was not found"),
                false,
                OperationId::new(),
            )),
        )
            .into_response();
    }
    let Ok(receiver) = state.pty.subscribe_output(session_id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorEnvelope::new(
                ErrorCode::NotFound,
                format!("terminal {session_id} was not found"),
                false,
                OperationId::new(),
            )),
        )
            .into_response();
    };
    let stream = futures::stream::unfold(receiver, |mut receiver| async move {
        let chunk = receiver.recv().await?;
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, chunk);
        Some((
            Ok::<_, std::convert::Infallible>(axum::response::sse::Event::default().data(encoded)),
            receiver,
        ))
    });
    axum::response::Sse::new(stream).into_response()
}

fn bad_request(message: &str) -> Response {
    application_error_response(ErrorEnvelope::new(
        ErrorCode::BadRequest,
        message,
        false,
        OperationId::new(),
    ))
}

fn application_error_response(error: ErrorEnvelope) -> Response {
    (status_for_error_code(error.code), Json(error)).into_response()
}

fn status_for_error_code(code: ErrorCode) -> StatusCode {
    match code {
        ErrorCode::BadRequest => StatusCode::BAD_REQUEST,
        ErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
        ErrorCode::Forbidden => StatusCode::FORBIDDEN,
        ErrorCode::NotFound => StatusCode::NOT_FOUND,
        ErrorCode::Conflict => StatusCode::CONFLICT,
        ErrorCode::CapabilityUnavailable => StatusCode::NOT_IMPLEMENTED,
        ErrorCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn auth_error_response(error: AuthStoreError) -> Response {
    let reason = match &error {
        AuthStoreError::InvalidScope => Some("invalid_device_scope"),
        AuthStoreError::InvalidPairing => Some("invalid_pairing"),
        AuthStoreError::PairingExpired => Some("pairing_expired"),
        AuthStoreError::PairingRedeemed => Some("pairing_redeemed"),
        AuthStoreError::InvalidDeviceName => Some("invalid_device_name"),
        AuthStoreError::DeviceNotFound => Some("device_not_found"),
        AuthStoreError::Forbidden => Some("credential_scope_forbidden"),
        AuthStoreError::PairingUnavailable => Some("pairing_unavailable"),
        AuthStoreError::Database(_) => None,
    };
    let (status, code, message) = match error {
        AuthStoreError::InvalidScope | AuthStoreError::InvalidDeviceName => (
            StatusCode::BAD_REQUEST,
            ErrorCode::BadRequest,
            error.to_string(),
        ),
        AuthStoreError::InvalidPairing => (
            StatusCode::UNAUTHORIZED,
            ErrorCode::Unauthorized,
            error.to_string(),
        ),
        AuthStoreError::PairingExpired | AuthStoreError::PairingRedeemed => {
            (StatusCode::CONFLICT, ErrorCode::Conflict, error.to_string())
        }
        AuthStoreError::DeviceNotFound => (
            StatusCode::NOT_FOUND,
            ErrorCode::NotFound,
            error.to_string(),
        ),
        AuthStoreError::Forbidden => (
            StatusCode::FORBIDDEN,
            ErrorCode::Forbidden,
            error.to_string(),
        ),
        AuthStoreError::PairingUnavailable => (
            StatusCode::NOT_IMPLEMENTED,
            ErrorCode::CapabilityUnavailable,
            error.to_string(),
        ),
        AuthStoreError::Database(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::Internal,
            "authentication store failed".to_owned(),
        ),
    };
    let mut envelope = ErrorEnvelope::new(code, message, false, OperationId::new());
    if let Some(reason) = reason {
        envelope = envelope.with_details(json!({ "reason": reason }));
    }
    (status, Json(envelope)).into_response()
}

fn ws_token_from_protocols(protocols: &str) -> Option<String> {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

    protocols
        .split(',')
        .map(str::trim)
        .find_map(|protocol| protocol.strip_prefix("vibex.token."))
        .and_then(|encoded| URL_SAFE_NO_PAD.decode(encoded).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

#[cfg(test)]
mod origin_allowed_tests {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    use remote_protocol::ReachabilityOrigin;

    use super::{
        ServerConfig, origin_allowed, origin_matches_request_host, set_extra_browser_origins,
    };

    fn config(listen: &str, allow_lan: bool) -> ServerConfig {
        ServerConfig::default()
            .with_listen_addr(listen.parse::<SocketAddr>().expect("listen"), allow_lan)
            .expect("listen policy")
    }

    #[test]
    fn loopback_listen_accepts_the_browser_origin() {
        set_extra_browser_origins(Vec::<String>::new());
        let config = ServerConfig::default();
        assert!(origin_allowed(&config, "http://127.0.0.1:17891"));
        assert!(origin_allowed(&config, "http://localhost:17891"));
        assert!(origin_allowed(&config, "http://127.0.0.1:3001"));
        assert!(!origin_allowed(&config, "http://192.168.1.20:17891"));
        assert!(!origin_allowed(&config, "https://attacker.invalid"));
    }

    #[test]
    fn unspecified_listen_accepts_loopback_and_lan_on_the_same_port() {
        set_extra_browser_origins(Vec::<String>::new());
        let config = config("0.0.0.0:17891", true);
        assert!(origin_allowed(&config, "http://127.0.0.1:17891"));
        assert!(origin_allowed(&config, "http://localhost:17891"));
        assert!(origin_allowed(&config, "http://127.0.0.1:3001"));
        assert!(origin_allowed(&config, "http://192.168.1.20:17891"));
        assert!(!origin_allowed(&config, "http://192.168.1.20:3001"));
        assert!(!origin_allowed(&config, "https://attacker.invalid"));
        assert!(!origin_allowed(&config, "http://8.8.8.8:17891"));
    }

    #[test]
    fn bearer_token_trims_and_accepts_common_prefixes() {
        use super::bearer_token;
        assert_eq!(
            bearer_token("Bearer secret-token"),
            Some("secret-token".to_string())
        );
        assert_eq!(
            bearer_token("  bearer secret-token  "),
            Some("secret-token".to_string())
        );
        assert_eq!(bearer_token("Bearer "), None);
        assert_eq!(bearer_token("Basic abc"), None);
    }

    #[test]
    fn published_reachability_is_accepted() {
        set_extra_browser_origins(Vec::<String>::new());
        let config = ServerConfig {
            listen_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 17891),
            reachability: vec![ReachabilityOrigin {
                origin: "https://host.example.ts.net".to_string(),
                kind: "tailscale".to_string(),
            }],
            ..ServerConfig::default()
        };
        assert!(origin_allowed(&config, "https://host.example.ts.net"));
    }

    #[test]
    fn public_tunnel_origin_matching_host_header_is_allowed() {
        set_extra_browser_origins(Vec::<String>::new());
        assert!(origin_matches_request_host(
            "http://47.109.140.92:13630",
            Some("47.109.140.92:13630")
        ));
        assert!(!origin_matches_request_host(
            "http://attacker.invalid",
            Some("47.109.140.92:13630")
        ));
    }

    #[test]
    fn extra_browser_origin_can_use_a_public_tunnel_port() {
        set_extra_browser_origins(["http://47.109.140.92:13630"]);
        let config = ServerConfig::default();
        assert!(origin_allowed(&config, "http://47.109.140.92:13630"));
        assert!(!origin_allowed(&config, "http://8.8.8.8:17891"));
        set_extra_browser_origins(Vec::<String>::new());
    }
}
