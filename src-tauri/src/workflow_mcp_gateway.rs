use std::{collections::BTreeSet, sync::Arc};

use application::{
    ApplicationCore, ConversationSessionExecutionPort, SqliteConversationRepository,
    WorkflowStoreExecutionPort,
};
use async_trait::async_trait;
use remote_protocol::{
    CreatePairingRequest, DeviceCredential, DeviceId, PairingChallenge, RedeemPairingRequest,
    RevokeDeviceResponse,
};
use server::{
    AuthStoreError, AuthenticatedCredential, CredentialKind, PreviewProxyRegistry, ServerAuth,
    ServerConfig, ServerRuntime,
};
use sha2::{Digest, Sha256};
use tokio::task::JoinHandle;

use crate::state::AppState;

/// Loopback-only application-command gateway used by Host-managed Plugin MCP
/// processes. Its bearer token is generated per Desktop lifetime and is never
/// written into plugin content or user configuration.
pub struct WorkflowMcpGatewayConnection {
    pub endpoint: String,
    task: JoinHandle<()>,
}

struct WorkflowMcpAuth {
    token_digest: [u8; 32],
    credential: AuthenticatedCredential,
}

impl WorkflowMcpAuth {
    fn new(token: &str) -> Self {
        Self {
            token_digest: Sha256::digest(token.as_bytes()).into(),
            credential: AuthenticatedCredential {
                credential_id: "workflow-plugin-mcp".to_owned(),
                kind: CredentialKind::Server,
                subject: "workflow-plugin-mcp".to_owned(),
                device_id: None,
                scopes: [
                    "workflow.read",
                    "workflow.write",
                    "workflow.run",
                    "workflow.approve",
                ]
                .into_iter()
                .map(str::to_owned)
                .collect::<BTreeSet<_>>(),
            },
        }
    }

    fn matches(&self, candidate: &str) -> bool {
        let candidate: [u8; 32] = Sha256::digest(candidate.as_bytes()).into();
        self.token_digest
            .iter()
            .zip(candidate)
            .fold(0_u8, |difference, (expected, actual)| {
                difference | (expected ^ actual)
            })
            == 0
    }
}

#[async_trait]
impl ServerAuth for WorkflowMcpAuth {
    async fn authenticate(
        &self,
        candidate: &str,
    ) -> Result<Option<AuthenticatedCredential>, AuthStoreError> {
        Ok(self.matches(candidate).then(|| self.credential.clone()))
    }

    async fn is_active(
        &self,
        credential: &AuthenticatedCredential,
    ) -> Result<bool, AuthStoreError> {
        Ok(credential == &self.credential)
    }

    async fn create_pairing(
        &self,
        _creator: &AuthenticatedCredential,
        _request: CreatePairingRequest,
    ) -> Result<PairingChallenge, AuthStoreError> {
        Err(AuthStoreError::PairingUnavailable)
    }

    async fn redeem_pairing(
        &self,
        _request: RedeemPairingRequest,
    ) -> Result<DeviceCredential, AuthStoreError> {
        Err(AuthStoreError::PairingUnavailable)
    }

    async fn revoke_device(
        &self,
        _actor: &AuthenticatedCredential,
        _device_id: DeviceId,
    ) -> Result<RevokeDeviceResponse, AuthStoreError> {
        Err(AuthStoreError::PairingUnavailable)
    }

    async fn list_devices(
        &self,
        _actor: &AuthenticatedCredential,
    ) -> Result<Vec<server::PairedDeviceRecord>, AuthStoreError> {
        Err(AuthStoreError::PairingUnavailable)
    }
}

impl Drop for WorkflowMcpGatewayConnection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn start(state: &AppState) -> Result<WorkflowMcpGatewayConnection, String> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let config = ServerConfig::default()
        .with_listen_addr(address, false)
        .map_err(|error| error.to_string())?;
    let token = format!(
        "vbx_plugin_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let core = ApplicationCore::with_execution_and_workflows(
        SqliteConversationRepository::new(state.deployment.db().pool.clone()),
        std::sync::Arc::new(ConversationSessionExecutionPort::new(
            state.conversation_context(),
        )),
        std::sync::Arc::new(WorkflowStoreExecutionPort::with_conversations(
            state.deployment.db().pool.clone(),
            state.conversation_context(),
        )),
    );
    let runtime = ServerRuntime::from_auth_with_preview_proxy(
        config,
        Arc::new(WorkflowMcpAuth::new(&token)),
        core,
        PreviewProxyRegistry::default(),
    );
    let router = runtime.router();
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!(%error, "Workflow Plugin MCP gateway stopped");
        }
    });
    Ok(WorkflowMcpGatewayConnection {
        endpoint: format!("http://{address}"),
        task,
    })
}
