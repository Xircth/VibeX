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
use automation::{
    AutomationEngine, EngineError, FileOwnerLock, StartupReconciler, StartupRecoveryReport,
    SystemClock,
};
use conversations::{
    ConversationContext, DefaultConversationHost, IncrementalRowProjector,
    start_agent_event_persistence,
};
use db::models::automation_v2::SqliteAutomationStore;
use deployment::{Deployment, DeploymentError};
use local_deployment::LocalDeployment;
use office_runtime::OfficeRuntime;
use plugins::PluginService;
use sqlx::SqlitePool;
use tokio::{sync::Mutex, task::JoinHandle};

use crate::{
    PreviewProxyRegistry, ServerConfig, ServerRuntime, ServerToken, SqliteTokenHashStore,
    automation_runtime::HeadlessAutomationRuntime, delegation_runtime::HeadlessDelegationRuntime,
    domains::ServerApplicationDomains,
};

#[derive(Debug, thiserror::Error)]
pub enum ServerBootstrapError {
    #[error(transparent)]
    Deployment(#[from] DeploymentError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Automation(#[from] EngineError),
    #[error("plugin bootstrap failed: {0}")]
    Plugin(String),
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
    _agent_runtime: Arc<AgentRuntime>,
    office_runtime: Arc<OfficeRuntime>,
    automation_runtime: HeadlessAutomationRuntime,
    automation_owner: Option<AutomationEngine<File>>,
    automation_recovery: Option<StartupRecoveryReport>,
    agent_event_task: Option<JoinHandle<()>>,
    _delegation_runtime: HeadlessDelegationRuntime,
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
        let conversation_context = ConversationContext {
            deployment: application_deployment,
            agent_runtime: agent_runtime.clone(),
            turn_locks: Arc::new(Mutex::new(HashMap::new())),
            runtime_states: Arc::new(Mutex::new(HashMap::new())),
            row_projectors: Arc::new(Mutex::new(
                HashMap::<uuid::Uuid, IncrementalRowProjector>::new(),
            )),
            host: Arc::new(DefaultConversationHost),
        };
        let agent_event_task =
            start_agent_event_persistence(pool.clone(), deployment.clone(), agent_runtime.clone());
        let delegation_runtime =
            HeadlessDelegationRuntime::start(agent_runtime.clone(), pool.clone());

        let managed_tools_root = config.data_dir.join("managed-tools");
        let office_runtime = Arc::new(
            OfficeRuntime::new(pool.clone(), managed_tools_root.clone())
                .await
                .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?,
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
        let automation_runtime = HeadlessAutomationRuntime::new(
            deployment.clone(),
            conversation_context.clone(),
            managed_tools_root,
        );
        let preview_proxy = PreviewProxyRegistry::default();
        let domains = Arc::new(ServerApplicationDomains::new(
            pool.clone(),
            office_runtime.clone(),
            preview_proxy.clone(),
            automation_runtime.clone(),
            automation_owner.is_some(),
            conversation_context.clone(),
            deployment.clone(),
        ));
        let execution = Arc::new(ConversationSessionExecutionPort::new(
            conversation_context.clone(),
        ));
        let repository = SqliteConversationRepository::new(pool.clone());
        let core = ApplicationCore::with_ports(repository, execution, domains);
        let runtime = ServerRuntime::from_credentials_with_preview_proxy(
            config.server,
            provisioned.credentials,
            core,
            preview_proxy,
        );

        Ok(Self {
            pool,
            runtime,
            issued_token: provisioned.issued_token,
            _agent_runtime: agent_runtime,
            office_runtime,
            automation_runtime,
            automation_owner,
            automation_recovery,
            agent_event_task: Some(agent_event_task),
            _delegation_runtime: delegation_runtime,
        })
    }

    pub const fn runtime(&self) -> &ServerRuntime<SqliteConversationRepository> {
        &self.runtime
    }

    pub const fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Runtime port retained by the headless composition for domain adapters
    /// such as delegation and durable conversation event persistence.
    pub const fn agent_runtime(&self) -> &Arc<AgentRuntime> {
        &self._agent_runtime
    }

    pub fn take_issued_token(&mut self) -> Option<ServerToken> {
        self.issued_token.take()
    }

    pub fn plugin_service(&self) -> &PluginService {
        self.office_runtime.plugin_service()
    }

    pub fn artifact_service(&self) -> &artifacts::ArtifactService {
        self.office_runtime.artifact_service_ref()
    }

    pub const fn owns_automation_engine(&self) -> bool {
        self.automation_owner.is_some()
    }

    pub const fn automation_recovery(&self) -> Option<&StartupRecoveryReport> {
        self.automation_recovery.as_ref()
    }

    pub async fn serve(self) -> std::io::Result<()> {
        self.serve_with_shutdown(std::future::pending()).await
    }

    pub async fn serve_with_shutdown(
        mut self,
        shutdown: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> std::io::Result<()> {
        let listen_addr = self.runtime.config().listen_addr;
        let listener = tokio::net::TcpListener::bind(listen_addr).await?;
        let automation_task = self.automation_owner.take().map(|engine| {
            let runtime = self.automation_runtime.clone();
            let recovery = self.automation_recovery.take();
            tokio::spawn(runtime.run(engine, recovery))
        });
        tracing::info!(%listen_addr, "vibex-server listening");
        let result = axum::serve(listener, self.runtime.router())
            .with_graceful_shutdown(shutdown)
            .await;
        if let Some(task) = automation_task {
            task.abort();
            let _ = task.await;
        }
        if let Some(task) = self.agent_event_task.take() {
            task.abort();
            let _ = task.await;
        }
        result
    }
}

impl Drop for HeadlessServer {
    fn drop(&mut self) {
        if let Some(task) = self.agent_event_task.take() {
            task.abort();
        }
    }
}
