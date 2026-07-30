use std::{
    path::{Component, Path as FsPath},
    sync::Arc,
};

use application::{ApplicationCore, CommandRegistry, ConversationRepository, Principal};
use axum::{
    Json, Router,
    body::Body,
    extract::{OriginalUri, Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use remote_protocol::{
    CapabilityId, CommandRequest, ErrorCode, ErrorEnvelope, OperationId, ServerCapabilities,
};
use serde_json::json;

use crate::{ServerConfig, ServerCredentials, ServerToken, auth::TokenDigest};

pub(crate) struct ServerState<R> {
    pub(crate) token_digest: TokenDigest,
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
                CapabilityId::new("conversation.cancel"),
                CapabilityId::new("application.call"),
                CapabilityId::new("plugin.read"),
                CapabilityId::new("plugin.write"),
                CapabilityId::new("artifact.read"),
                CapabilityId::new("artifact.preview"),
                CapabilityId::new("preview.proxy"),
                CapabilityId::new("automation.read"),
                CapabilityId::new("automation.write"),
                CapabilityId::new("delegation.read"),
                CapabilityId::new("delegation.cancel"),
            ],
        };
        let core = Arc::new(core);
        Self {
            config: config.clone(),
            state: Arc::new(ServerState {
                token_digest: credentials.token_digest,
                capabilities,
                commands: CommandRegistry::from_core(Arc::clone(&core)),
                core,
                config,
                preview_proxy,
                preview_client: reqwest::Client::new(),
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
            .route_layer(middleware::from_fn_with_state(
                Arc::clone(&self.state),
                require_token::<R>,
            ));
        Router::new()
            .route("/health", get(health))
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
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("authorization, content-type, x-vibex-protocol-version"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
}

async fn application_call<R>(
    State(state): State<Arc<ServerState<R>>>,
    Path(command): Path<String>,
    Json(request): Json<CommandRequest<serde_json::Value>>,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    let principal = Principal::remote(
        "server-token",
        [
            "conversation.read".to_string(),
            "conversation.write".to_string(),
            "application.call".to_string(),
            "plugin.read".to_string(),
            "plugin.write".to_string(),
            "artifact.read".to_string(),
            "artifact.preview".to_string(),
            "automation.read".to_string(),
            "automation.write".to_string(),
            "delegation.read".to_string(),
            "delegation.cancel".to_string(),
        ],
    );
    match state
        .commands
        .execute_name(&principal, &command, request.operation_id, request.args)
        .await
    {
        Ok(response) => Json(response).into_response(),
        Err(error) => {
            let status = match error.code {
                ErrorCode::BadRequest => StatusCode::BAD_REQUEST,
                ErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
                ErrorCode::Forbidden => StatusCode::FORBIDDEN,
                ErrorCode::NotFound => StatusCode::NOT_FOUND,
                ErrorCode::Conflict => StatusCode::CONFLICT,
                ErrorCode::CapabilityUnavailable => StatusCode::NOT_IMPLEMENTED,
                ErrorCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (status, Json(error)).into_response()
        }
    }
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}

async fn capabilities<R>(State(state): State<Arc<ServerState<R>>>, headers: HeaderMap) -> Response {
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
    Json(state.capabilities.clone()).into_response()
}

async fn require_token<R>(
    State(state): State<Arc<ServerState<R>>>,
    request: Request,
    next: Next,
) -> Response {
    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|candidate| state.token_digest.verifies(candidate))
        || request
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok())
            .and_then(ws_token_from_protocols)
            .is_some_and(|candidate| state.token_digest.verifies(&candidate));
    if authorized {
        return next.run(request).await;
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

fn ws_token_from_protocols(protocols: &str) -> Option<String> {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

    protocols
        .split(',')
        .map(str::trim)
        .find_map(|protocol| protocol.strip_prefix("vibex.token."))
        .and_then(|encoded| URL_SAFE_NO_PAD.decode(encoded).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
}
