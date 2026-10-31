//! Loopback HTTP entry for product MCP processes.

use std::{path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use delegation::{DelegationListener, TokenEntry, TokenPermissions, TokenRegistry};
use delegation_proto::BrokerMessage;
use plugins::OfficialMcpRuntime;
use tokio::net::TcpListener;
use uuid::Uuid;

#[async_trait::async_trait]
pub trait ProductMcpSessionLookup: Send + Sync {
    async fn resolve(&self, conversation_id: Uuid) -> Option<(String, PathBuf)>;
    async fn is_space_session(&self, conversation_id: Uuid) -> bool;
}

#[derive(Clone)]
struct GatewayState {
    listener: Arc<DelegationListener>,
    tokens: Arc<TokenRegistry>,
    gate: Arc<OfficialMcpRuntime>,
    sessions: Arc<dyn ProductMcpSessionLookup>,
}

pub async fn start_product_mcp_gateway(
    listener: Arc<DelegationListener>,
    tokens: Arc<TokenRegistry>,
    gate: Arc<OfficialMcpRuntime>,
    sessions: Arc<dyn ProductMcpSessionLookup>,
) -> Result<String, std::io::Error> {
    let listener_tcp = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener_tcp.local_addr()?;
    let base = format!("http://{addr}");
    gate.set_http_base(Some(base.clone()));
    let state = GatewayState {
        listener,
        tokens,
        gate,
        sessions,
    };
    let app = Router::new()
        .route("/internal/companion", post(companion))
        .with_state(state);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener_tcp, app).await {
            tracing::warn!("product MCP gateway stopped: {error}");
        }
    });
    Ok(base)
}

async fn companion(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(mut message): Json<BrokerMessage>,
) -> Result<Json<delegation_proto::BrokerResponse>, StatusCode> {
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let product = headers
        .get("x-vibex-product")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("delegation");
    let expected = state.gate.token_for_product(product);
    if expected.as_deref() != Some(bearer) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let conversation_id = headers
        .get("x-vibex-conversation-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Uuid::parse_str(value).ok());
    if let Some(conversation_id) = conversation_id
        && let Some((connection_id, working_root)) = state.sessions.resolve(conversation_id).await
    {
        let ephemeral = Uuid::new_v4().to_string();
        let permissions = if product == "session" {
            let bits = state.gate.session_features();
            TokenPermissions {
                feedback: bits & plugins::SESSION_FEAT_FEEDBACK != 0,
                ask: bits & plugins::SESSION_FEAT_ASK != 0,
                session_info: bits & plugins::SESSION_FEAT_SESSIONS != 0,
                session_control: bits & plugins::SESSION_FEAT_SESSION_CONTROL != 0,
                ..TokenPermissions::default()
            }
        } else {
            let space_session = state.sessions.is_space_session(conversation_id).await;
            TokenPermissions {
                delegation: true,
                session_info: true,
                workspace_write: true,
                collaboration: true,
                space_session,
                ..TokenPermissions::default()
            }
        };
        state.tokens.register_with_permissions(
            ephemeral.clone(),
            TokenEntry {
                parent_connection_id: connection_id.clone(),
                parent_conversation_id: conversation_id,
                working_root,
            },
            permissions,
        );
        struct EphemeralTokenGuard<'a> {
            tokens: &'a TokenRegistry,
            token: String,
        }
        impl Drop for EphemeralTokenGuard<'_> {
            fn drop(&mut self) {
                self.tokens.revoke(&self.token);
            }
        }
        let guard = EphemeralTokenGuard {
            tokens: &state.tokens,
            token: ephemeral.clone(),
        };
        rewrite_token(&mut message, &ephemeral, &connection_id);
        let response = state.listener.handle_message(message).await;
        drop(guard);
        return Ok(Json(response));
    }

    Ok(Json(unbound_conversation_response()))
}

fn unbound_conversation_response() -> delegation_proto::BrokerResponse {
    delegation_proto::BrokerResponse::Error {
        code: "missing_conversation".to_string(),
        message: "host conversation context is missing".to_string(),
    }
}

fn rewrite_token(message: &mut BrokerMessage, token: &str, connection_id: &str) {
    match message {
        BrokerMessage::Call(req) => {
            req.token = token.to_string();
            req.parent_connection_id = connection_id.to_string();
        }
        BrokerMessage::Status(req) => req.token = token.to_string(),
        BrokerMessage::CancelTask(req) => req.token = token.to_string(),
        BrokerMessage::Cancel(req) => req.token = token.to_string(),
        BrokerMessage::Feedback(req) => req.token = token.to_string(),
        BrokerMessage::CommitFeedback(req) => req.token = token.to_string(),
        BrokerMessage::Ask(req) => req.token = token.to_string(),
        BrokerMessage::SessionInfo(req) => req.token = token.to_string(),
        BrokerMessage::SessionSend(req) => req.token = token.to_string(),
        BrokerMessage::SessionCancel(req) => req.token = token.to_string(),
        BrokerMessage::SessionWait(req) => req.token = token.to_string(),
        BrokerMessage::Collaborate(req) => req.token = token.to_string(),
        BrokerMessage::Ping => {}
    }
}
