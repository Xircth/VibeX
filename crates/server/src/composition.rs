use std::{
    collections::HashMap,
    fs::File,
    path::{Path, PathBuf},
    sync::Arc,
};

use agents::AgentRuntime;
use application::{
    ApplicationCore, ConversationSessionExecutionPort, SqliteConversationRepository,
};
use artifacts::{ArtifactService, LocalArtifactFilesystem, SqliteArtifactRepository};
use automation::{
    AutomationEngine, EngineError, FileOwnerLock, StartupReconciler, StartupRecoveryReport,
    SystemClock,
};
use conversations::{ConversationContext, DefaultConversationHost, IncrementalRowProjector};
use db::models::automation_v2::SqliteAutomationStore;
use deployment::{Deployment, DeploymentError};
use local_deployment::LocalDeployment;
use plugins::PluginService;
use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::{
    ServerArtifactEventSink, ServerConfig, ServerRuntime, ServerToken, SqliteTokenHashStore,
};

#[derive(Debug, thiserror::Error)]
pub enum ServerBootstrapError {
    #[error(transparent)]
    Deployment(#[from] DeploymentError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Automation(#[from] EngineError),
}

pub struct ServerBootstrapConfig {
    pub data_dir: PathBuf,
    pub server: ServerConfig,
    pub token: Option<ServerToken>,
}

impl ServerBootstrapConfig {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self {
            data_dir: data_dir.as_ref().to_path_buf(),
            server: ServerConfig::default(),
            token: None,
        }
    }

    pub fn with_token(mut self, token: ServerToken) -> Self {
        self.token = Some(token);
        self
    }
}

pub struct HeadlessServer {
    pool: SqlitePool,
    runtime: ServerRuntime<SqliteConversationRepository>,
    issued_token: Option<ServerToken>,
    _deployment: Arc<LocalDeployment>,
    _agent_runtime: Arc<AgentRuntime>,
    plugin_service: Arc<PluginService>,
    artifact_service: ArtifactService,
    automation_owner: Option<AutomationEngine<File>>,
    automation_recovery: Option<StartupRecoveryReport>,
}

impl HeadlessServer {
    pub async fn bootstrap(config: ServerBootstrapConfig) -> Result<Self, ServerBootstrapError> {
        let deployment = Arc::new(LocalDeployment::new_at(&config.data_dir).await?);
        let pool = deployment.db().pool.clone();
        let provisioned = SqliteTokenHashStore::new(pool.clone())
            .provision(config.token)
            .await?;
        let agent_runtime = Arc::new(AgentRuntime::default());
        let application_deployment: Arc<dyn Deployment> = deployment.clone();
        let execution = Arc::new(ConversationSessionExecutionPort::new(ConversationContext {
            deployment: application_deployment,
            agent_runtime: agent_runtime.clone(),
            turn_locks: Arc::new(Mutex::new(HashMap::new())),
            runtime_states: Arc::new(Mutex::new(HashMap::new())),
            row_projectors: Arc::new(Mutex::new(
                HashMap::<uuid::Uuid, IncrementalRowProjector>::new(),
            )),
            host: Arc::new(DefaultConversationHost),
        }));
        let repository = SqliteConversationRepository::new(pool.clone());
        let core = ApplicationCore::with_execution(repository, execution);
        let runtime = ServerRuntime::from_credentials(config.server, provisioned.credentials, core);

        let plugin_service = Arc::new(PluginService::new());
        let artifact_repository = Arc::new(SqliteArtifactRepository::new(pool.clone()));
        let artifact_service = ArtifactService::new(
            artifact_repository,
            Arc::new(ServerArtifactEventSink::new(pool.clone())),
            Arc::new(LocalArtifactFilesystem),
        );

        let data_dir_key = config.data_dir.to_string_lossy().into_owned();
        let automation_owner =
            AutomationEngine::acquire(&data_dir_key, FileOwnerLock::default()).await?;
        let automation_recovery = if automation_owner.is_some() {
            Some(
                StartupReconciler::new(SqliteAutomationStore::new(pool.clone()), SystemClock)
                    .reconcile()
                    .await?,
            )
        } else {
            None
        };

        Ok(Self {
            pool,
            runtime,
            issued_token: provisioned.issued_token,
            _deployment: deployment,
            _agent_runtime: agent_runtime,
            plugin_service,
            artifact_service,
            automation_owner,
            automation_recovery,
        })
    }

    pub const fn runtime(&self) -> &ServerRuntime<SqliteConversationRepository> {
        &self.runtime
    }

    pub const fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub fn take_issued_token(&mut self) -> Option<ServerToken> {
        self.issued_token.take()
    }

    pub fn plugin_service(&self) -> &PluginService {
        &self.plugin_service
    }

    pub const fn artifact_service(&self) -> &ArtifactService {
        &self.artifact_service
    }

    pub const fn owns_automation_engine(&self) -> bool {
        self.automation_owner.is_some()
    }

    pub const fn automation_recovery(&self) -> Option<&StartupRecoveryReport> {
        self.automation_recovery.as_ref()
    }

    pub async fn serve(self) -> std::io::Result<()> {
        let listen_addr = self.runtime.config().listen_addr;
        let listener = tokio::net::TcpListener::bind(listen_addr).await?;
        tracing::info!(%listen_addr, "vibex-server listening");
        axum::serve(listener, self.runtime.router()).await
    }
}
