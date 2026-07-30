use std::sync::Arc;

use application::{ApplicationCore, ConversationRepository};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use remote_protocol::{CapabilityId, ErrorCode, ErrorEnvelope, OperationId, ServerCapabilities};
use serde_json::json;

use crate::{ServerConfig, ServerCredentials, ServerToken, auth::TokenDigest};

struct ServerState<R> {
    token_digest: TokenDigest,
    capabilities: ServerCapabilities,
    _core: Arc<ApplicationCore<R>>,
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
        let capabilities = ServerCapabilities {
            server_version: config.server_version.clone(),
            protocol_version: remote_protocol::PROTOCOL_VERSION.to_string(),
            minimum_client_version: config.minimum_client_version.clone(),
            capabilities: vec![
                CapabilityId::new("conversation.read"),
                CapabilityId::new("conversation.attach"),
            ],
        };
        Self {
            config,
            state: Arc::new(ServerState {
                token_digest: credentials.token_digest,
                capabilities,
                _core: Arc::new(core),
            }),
        }
    }

    pub const fn config(&self) -> &ServerConfig {
        &self.config
    }

    pub fn router(&self) -> Router {
        let protected = Router::new()
            .route("/capabilities", get(capabilities::<R>))
            .route_layer(middleware::from_fn_with_state(
                Arc::clone(&self.state),
                require_token::<R>,
            ));
        Router::new()
            .route("/health", get(health))
            .nest("/api/v1", protected)
            .with_state(Arc::clone(&self.state))
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
        .is_some_and(|candidate| state.token_digest.verifies(candidate));
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
