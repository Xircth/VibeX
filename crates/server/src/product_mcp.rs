//! Loopback HTTP entry for product MCP processes.

use std::{collections::BTreeSet, path::PathBuf, sync::Arc};

use application::{CommandRegistry, Principal, RegisteredCommand, SqliteConversationRepository};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use delegation::{DelegationListener, TokenEntry, TokenPermissions, TokenRegistry};
use delegation_proto::BrokerMessage;
use plugins::OfficialMcpRuntime;
use remote_protocol::CommandRequest;
use tokio::{net::TcpListener, sync::RwLock};
use uuid::Uuid;

#[async_trait::async_trait]
pub trait ProductMcpSessionLookup: Send + Sync {
    async fn resolve(&self, conversation_id: Uuid) -> Option<(String, PathBuf)>;
    async fn is_space_session(&self, conversation_id: Uuid) -> bool;
}

/// Late-bound application command registry attached once `HostRuntime::build`
/// finishes initializing `CommandRegistry`.
#[derive(Clone, Default)]
pub struct ProductMcpCommandHost {
    commands: Arc<RwLock<Option<CommandRegistry<SqliteConversationRepository>>>>,
}

impl ProductMcpCommandHost {
    pub async fn attach_commands(&self, commands: CommandRegistry<SqliteConversationRepository>) {
        *self.commands.write().await = Some(commands);
    }

    async fn commands(&self) -> Option<CommandRegistry<SqliteConversationRepository>> {
        self.commands.read().await.clone()
    }
}

#[derive(Clone)]
struct GatewayState {
    listener: Arc<DelegationListener>,
    tokens: Arc<TokenRegistry>,
    gate: Arc<OfficialMcpRuntime>,
    sessions: Arc<dyn ProductMcpSessionLookup>,
    command_host: ProductMcpCommandHost,
}

pub async fn start_product_mcp_gateway(
    listener: Arc<DelegationListener>,
    tokens: Arc<TokenRegistry>,
    gate: Arc<OfficialMcpRuntime>,
    sessions: Arc<dyn ProductMcpSessionLookup>,
    command_host: ProductMcpCommandHost,
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
        command_host,
    };
    let app = Router::new()
        .route("/internal/companion", post(companion))
        .route("/api/v1/call/{command}", post(v1_call))
        .with_state(state);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener_tcp, app).await {
            tracing::warn!("product MCP gateway stopped: {error}");
        }
    });
    Ok(base)
}

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())?;
    let trimmed = raw.trim();
    trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
        .or_else(|| trimmed.strip_prefix("BEARER "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

fn superagent_scopes() -> BTreeSet<String> {
    let mut scopes = RegisteredCommand::all()
        .into_iter()
        .map(|cmd| cmd.required_scope().to_owned())
        .collect::<BTreeSet<_>>();
    for extra in [
        "workspace.write",
        "artifact.read",
        "artifact.preview",
        "plugin.read",
        "plugin.write",
        "plugin.surface",
        "delegation.read",
        "delegation.cancel",
    ] {
        scopes.insert(extra.to_owned());
    }
    scopes
}

async fn v1_call(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Path(command): Path<String>,
    Json(request): Json<CommandRequest<serde_json::Value>>,
) -> Response {
    let Some(bearer) = extract_bearer(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !state.gate.is_valid_product_token(bearer) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(commands) = state.command_host.commands().await else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error_code": "host_starting",
                "message": "Host command registry is still initializing",
            })),
        )
            .into_response();
    };
    let principal = Principal::remote("dimo-superagent-mcp", superagent_scopes());
    match commands
        .execute_name(&principal, &command, request.operation_id, request.args)
        .await
    {
        Ok(response) => Json(response).into_response(),
        Err(error) => crate::runtime::application_error_response(error),
    }
}

async fn companion(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(mut message): Json<BrokerMessage>,
) -> Result<Json<delegation_proto::BrokerResponse>, StatusCode> {
    let bearer = extract_bearer(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let product = headers
        .get("x-dimo-product")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("superagent");
    let expected = state.gate.token_for_product(product);
    if expected.as_deref() != Some(bearer) && !state.gate.is_valid_product_token(bearer) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let conversation_id = headers
        .get("x-dimo-conversation-id")
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
        } else if product == "superagent" {
            let delegation_on = state.gate.allow_delegation_mcp();
            let bits = state.gate.session_features();
            let space_session =
                delegation_on && state.sessions.is_space_session(conversation_id).await;
            TokenPermissions {
                delegation: delegation_on,
                feedback: bits & plugins::SESSION_FEAT_FEEDBACK != 0,
                ask: bits & plugins::SESSION_FEAT_ASK != 0,
                session_info: delegation_on || (bits & plugins::SESSION_FEAT_SESSIONS != 0),
                session_control: bits & plugins::SESSION_FEAT_SESSION_CONTROL != 0,
                workspace_write: delegation_on,
                collaboration: delegation_on,
                space_session,
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
