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
use conversations::{
    ConversationContext, DefaultConversationHost, IncrementalRowProjector,
    start_agent_event_persistence,
};
use db::models::automation_v2::SqliteAutomationStore;
use deployment::{Deployment, DeploymentError};
use local_deployment::LocalDeployment;
use plugins::{ManifestSource, PluginService};
use sqlx::SqlitePool;
use tokio::{sync::Mutex, task::JoinHandle};

use crate::{
    ServerArtifactEventSink, ServerConfig, ServerRuntime, ServerToken, SqliteTokenHashStore,
    automation_runtime::HeadlessAutomationRuntime, delegation_runtime::HeadlessDelegationRuntime,
};

const OFFICE_MANIFEST: &str =
    include_str!("../../../assets/plugins/office/manifest.vibex-plugin.json");

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
    deployment: Arc<LocalDeployment>,
    _agent_runtime: Arc<AgentRuntime>,
    conversation_context: ConversationContext,
    managed_tools_root: PathBuf,
    plugin_service: Arc<PluginService>,
    artifact_service: ArtifactService,
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
        let execution = Arc::new(ConversationSessionExecutionPort::new(
            conversation_context.clone(),
        ));
        let repository = SqliteConversationRepository::new(pool.clone());
        let core = ApplicationCore::with_execution(repository, execution);
        let runtime = ServerRuntime::from_credentials(config.server, provisioned.credentials, core);
        let agent_event_task =
            start_agent_event_persistence(pool.clone(), deployment.clone(), agent_runtime.clone());
        let delegation_runtime =
            HeadlessDelegationRuntime::start(agent_runtime.clone(), pool.clone());

        let plugin_service = Arc::new(PluginService::new());
        let office_manifest = plugin_service
            .import_manifest(OFFICE_MANIFEST, ManifestSource::Bundled)
            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
        sqlx::query(
            "INSERT INTO plugin_v2_registry
             (plugin_id, schema_version, name, normalized_manifest_json, source, membership,
              legacy_plugin_id, created_at, updated_at)
             VALUES (?,2,?,?,'bundled','builtin',NULL,datetime('now','subsec'),
                     datetime('now','subsec'))
             ON CONFLICT(plugin_id) DO UPDATE SET
              name=excluded.name, normalized_manifest_json=excluded.normalized_manifest_json,
              updated_at=datetime('now','subsec')",
        )
        .bind(office_manifest.id.as_str())
        .bind(&office_manifest.name)
        .bind(OFFICE_MANIFEST)
        .execute(&pool)
        .await?;
        sqlx::query(
            "INSERT OR IGNORE INTO plugin_v2_activation
             (plugin_id, enabled, updated_at)
             VALUES (?,0,datetime('now','subsec'))",
        )
        .bind(office_manifest.id.as_str())
        .execute(&pool)
        .await?;
        let artifact_repository = Arc::new(SqliteArtifactRepository::new(pool.clone()));
        let artifact_service = ArtifactService::new(
            artifact_repository,
            Arc::new(ServerArtifactEventSink::new(pool.clone())),
            Arc::new(LocalArtifactFilesystem),
        );

        let managed_tools_root = config.data_dir.join("managed-tools");
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
            deployment,
            _agent_runtime: agent_runtime,
            conversation_context,
            managed_tools_root,
            plugin_service,
            artifact_service,
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
        self.serve_with_shutdown(std::future::pending()).await
    }

    pub async fn serve_with_shutdown(
        mut self,
        shutdown: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> std::io::Result<()> {
        let listen_addr = self.runtime.config().listen_addr;
        let listener = tokio::net::TcpListener::bind(listen_addr).await?;
        let automation_task = self.automation_owner.take().map(|engine| {
            let runtime = HeadlessAutomationRuntime::new(
                self.deployment.clone(),
                self.conversation_context.clone(),
                self.managed_tools_root.clone(),
            );
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
