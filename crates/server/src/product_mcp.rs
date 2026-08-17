//! Loopback HTTP entry for product MCP processes.

use std::{path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use delegation::{
    DelegationListener, TokenEntry, TokenPermissions, TokenRegistry,
};
use delegation_proto::BrokerMessage;
use plugins::OfficialProductMcpGate;
use tokio::net::TcpListener;
use uuid::Uuid;

#[async_trait::async_trait]
pub trait ProductMcpSessionLookup: Send + Sync {
    async fn resolve(&self, conversation_id: Uuid) -> Option<(String, PathBuf)>;
}

#[derive(Clone)]
struct GatewayState {
    listener: Arc<DelegationListener>,
    tokens: Arc<TokenRegistry>,
    gate: Arc<OfficialProductMcpGate>,
    sessions: Arc<dyn ProductMcpSessionLookup>,
}

pub async fn start_product_mcp_gateway(
    listener: Arc<DelegationListener>,
    tokens: Arc<TokenRegistry>,
    gate: Arc<OfficialProductMcpGate>,
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
    let expected = match product {
        "session" => state.gate.session_token(),
        _ => state.gate.delegation_token(),
    };
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
            TokenPermissions {
                feedback: true,
                ask: true,
                session_info: true,
                session_control: true,
                ..TokenPermissions::default()
            }
        } else {
            TokenPermissions {
                delegation: true,
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
        rewrite_token(&mut message, &ephemeral, &connection_id);
        let response = state.listener.handle_message(message).await;
        state.tokens.revoke(&ephemeral);
        return Ok(Json(response));
    }

    Ok(Json(state.listener.handle_message(message).await))
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
    }
}
