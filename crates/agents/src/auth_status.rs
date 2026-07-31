//! Compatibility boundary for the ACP Draft `auth/status` RFD.
//!
//! Draft wire types are intentionally private to this module. Core management
//! code consumes only [`AuthenticationObservation`].

use std::time::Duration;

use agent_client_protocol::{
    Agent, ConnectionTo, JsonRpcRequest, JsonRpcResponse,
    schema::v1::{InitializeRequest, InitializeResponse},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AgentAuthenticationStatus;

pub const AUTH_STATUS_DRAFT_REVISION: &str = "2026-07-21";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AuthenticationObservationState {
    Authenticated,
    Unauthenticated,
    Unknown,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AuthenticationMethod {
    ApiKey,
    Account,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AuthenticationSource {
    AcpAuthStatus,
    NativeConfig,
    BuiltinLocalProvider,
    RuntimeError,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticationObservation {
    pub state: AuthenticationObservationState,
    pub method: AuthenticationMethod,
    pub source: AuthenticationSource,
    pub observed_at: DateTime<Utc>,
    pub capability_generation: u64,
    pub draft_revision: &'static str,
    pub diagnostic_code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionAuthenticationEvidence {
    SessionReady,
    AuthenticationRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedSessionAuthentication {
    pub authentication: AgentAuthenticationStatus,
    pub authentication_required: bool,
}

/// Reconcile a semantic ACP session outcome with explicit local evidence.
/// This is protocol evidence, not a background `session/new` authentication
/// probe and never assigns an account/API-key method from aggregate status.
pub fn resolve_session_authentication_evidence(
    native_authentication: AgentAuthenticationStatus,
    evidence: SessionAuthenticationEvidence,
) -> ResolvedSessionAuthentication {
    match evidence {
        SessionAuthenticationEvidence::SessionReady => ResolvedSessionAuthentication {
            authentication: match native_authentication {
                AgentAuthenticationStatus::NotLoggedIn | AgentAuthenticationStatus::NotRequired => {
                    AgentAuthenticationStatus::NotRequired
                }
                authenticated => authenticated,
            },
            authentication_required: false,
        },
        SessionAuthenticationEvidence::AuthenticationRequired => ResolvedSessionAuthentication {
            authentication: match native_authentication {
                AgentAuthenticationStatus::NotRequired => AgentAuthenticationStatus::NotLoggedIn,
                authentication => authentication,
            },
            authentication_required: true,
        },
    }
}

#[derive(Debug, Deserialize)]
struct DraftAuthStatusResponse {
    authenticated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "initialize", response = serde_json::Value)]
#[serde(transparent)]
struct DraftAwareInitializeRequest(InitializeRequest);

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "auth/status", response = DraftAuthStatusWireResponse)]
struct DraftAuthStatusRequest {}

#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcResponse)]
struct DraftAuthStatusWireResponse {
    authenticated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AcpAuthStatusAdapterError {
    #[error("malformed auth/status response: {0}")]
    Malformed(String),
}

pub struct AcpAuthStatusAdapter;

impl AcpAuthStatusAdapter {
    /// Runs the standard initialization request while retaining the raw
    /// capabilities object needed to detect draft extensions that the stable
    /// SDK schema intentionally ignores.
    pub async fn initialize(
        connection: &ConnectionTo<Agent>,
        request: InitializeRequest,
    ) -> Result<(InitializeResponse, serde_json::Value), agent_client_protocol::Error> {
        let raw_response = connection
            .send_request(DraftAwareInitializeRequest(request))
            .block_task()
            .await?;
        let raw_capabilities = raw_response
            .get("agentCapabilities")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let response = serde_json::from_value(raw_response)
            .map_err(agent_client_protocol::Error::into_internal_error)?;
        Ok((response, raw_capabilities))
    }

    pub fn is_advertised(agent_capabilities: &serde_json::Value) -> bool {
        agent_capabilities
            .get("auth")
            .and_then(|auth| auth.get("status"))
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    }

    pub fn decode_response(
        response: &serde_json::Value,
        capability_generation: u64,
    ) -> Result<AuthenticationObservation, AcpAuthStatusAdapterError> {
        let response: DraftAuthStatusResponse = serde_json::from_value(response.clone())
            .map_err(|error| AcpAuthStatusAdapterError::Malformed(error.to_string()))?;
        Ok(AuthenticationObservation {
            state: if response.authenticated {
                AuthenticationObservationState::Authenticated
            } else {
                AuthenticationObservationState::Unauthenticated
            },
            method: AuthenticationMethod::Unknown,
            source: AuthenticationSource::AcpAuthStatus,
            observed_at: Utc::now(),
            capability_generation,
            draft_revision: AUTH_STATUS_DRAFT_REVISION,
            diagnostic_code: None,
        })
    }

    pub fn degraded(
        capability_generation: u64,
        diagnostic_code: impl Into<String>,
    ) -> AuthenticationObservation {
        AuthenticationObservation {
            state: AuthenticationObservationState::Degraded,
            method: AuthenticationMethod::Unknown,
            source: AuthenticationSource::RuntimeError,
            observed_at: Utc::now(),
            capability_generation,
            draft_revision: AUTH_STATUS_DRAFT_REVISION,
            diagnostic_code: Some(diagnostic_code.into()),
        }
    }

    /// Queries the draft method only when initialization explicitly advertised
    /// support. Protocol errors and timeouts degrade authentication knowledge;
    /// they do not imply a corrupt installation.
    pub async fn observe_if_advertised(
        connection: &ConnectionTo<Agent>,
        raw_capabilities: &serde_json::Value,
        capability_generation: u64,
        timeout: Duration,
    ) -> Option<AuthenticationObservation> {
        if !Self::is_advertised(raw_capabilities) {
            return None;
        }

        let request = connection
            .send_request(DraftAuthStatusRequest::default())
            .block_task();
        match tokio::time::timeout(timeout, request).await {
            Ok(Ok(response)) => Some(AuthenticationObservation {
                state: if response.authenticated {
                    AuthenticationObservationState::Authenticated
                } else {
                    AuthenticationObservationState::Unauthenticated
                },
                method: AuthenticationMethod::Unknown,
                source: AuthenticationSource::AcpAuthStatus,
                observed_at: Utc::now(),
                capability_generation,
                draft_revision: AUTH_STATUS_DRAFT_REVISION,
                diagnostic_code: None,
            }),
            Ok(Err(_)) => Some(Self::degraded(
                capability_generation,
                "auth_status_rpc_failed",
            )),
            Err(_) => Some(Self::degraded(capability_generation, "auth_status_timeout")),
        }
    }
}
