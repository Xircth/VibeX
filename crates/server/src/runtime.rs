use std::{
    path::{Component, Path as FsPath},
    sync::Arc,
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
use remote_protocol::{
    CapabilityId, CommandRequest, ConversationId, CreatePairingRequest, DeviceId, ErrorCode,
    ErrorEnvelope, OperationId, RedeemPairingRequest, ServerCapabilities,
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
        Self::from_auth_with_preview_proxy(
            config,
            Arc::new(StaticServerAuth::new(credentials)),
            core,
            preview_proxy,
        )
    }

    pub fn from_sqlite_auth(
        config: ServerConfig,
        pool: sqlx::SqlitePool,
        core: ApplicationCore<R>,
    ) -> Self {
        Self::from_auth_with_preview_proxy(
            config,
            Arc::new(SqliteServerAuth::new(pool)),
            core,
            crate::PreviewProxyRegistry::default(),
        )
    }

    pub fn from_sqlite_auth_with_preview_proxy(
        config: ServerConfig,
        pool: sqlx::SqlitePool,
        core: ApplicationCore<R>,
        preview_proxy: crate::PreviewProxyRegistry,
    ) -> Self {
        Self::from_auth_with_preview_proxy(
            config,
            Arc::new(SqliteServerAuth::new(pool)),
            core,
            preview_proxy,
        )
    }

    pub fn from_auth_with_preview_proxy(
        config: ServerConfig,
        auth: Arc<dyn ServerAuth>,
        core: ApplicationCore<R>,
        preview_proxy: crate::PreviewProxyRegistry,
    ) -> Self {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let capabilities = ServerCapabilities {
            server_version: config.server_version.clone(),
            protocol_version: remote_protocol::PROTOCOL_VERSION.to_string(),
            minimum_client_version: config.minimum_client_version.clone(),
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
            .route_layer(middleware::from_fn_with_state(
                Arc::clone(&self.state),
                require_token::<R>,
            ));
        Router::new()
            .route("/health", get(health))
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

async fn static_asset<R>(
    State(state): State<Arc<ServerState<R>>>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let Some(root) = state.config.static_root.as_ref() else {
        return StatusCode::NOT_FOUND.into_response();
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
    if !origin_allowed(&state.config, &origin) {
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

fn origin_allowed(config: &ServerConfig, origin: &str) -> bool {
    if config.allowed_origins.contains(origin) {
        return true;
    }
    origin
        .parse::<axum::http::Uri>()
        .ok()
        .and_then(|uri| {
            uri.authority()
                .map(|authority| authority.as_str().to_owned())
        })
        .is_some_and(|authority| authority == config.listen_addr.to_string())
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

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
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
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(ToOwned::to_owned)
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
    match state.auth.create_pairing(&credential, request).await {
        Ok(challenge) => (StatusCode::CREATED, Json(challenge)).into_response(),
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
