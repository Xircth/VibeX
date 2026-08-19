use std::{
    collections::HashMap,
    fs::File,
    path::{Path, PathBuf},
    sync::Arc,
};

use agents::{AgentRuntime, runtime_event_channel};
use application::SqliteConversationRepository;
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
use plugins::{ConflictDecision, PluginControlPlane, PluginPreviewHost, SqlitePluginRegistry};
use sqlx::SqlitePool;
use tokio::{sync::Mutex, task::JoinHandle};

use crate::{
    PreviewProxyRegistry, ServerConfig, ServerRuntime, ServerToken, SqliteTokenHashStore,
    automation_runtime::HeadlessAutomationRuntime, delegation_runtime::HeadlessDelegationRuntime,
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
    #[error("conversation recovery failed: {0}")]
    Conversation(String),
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
    automation_runtime: HeadlessAutomationRuntime,
    automation_owner: Option<AutomationEngine<File>>,
    automation_recovery: Option<StartupRecoveryReport>,
    agent_event_task: Option<JoinHandle<()>>,
    _delegation_runtime: HeadlessDelegationRuntime,
    workflow_dispatch_task: JoinHandle<()>,
}

impl HeadlessServer {
    pub async fn bootstrap(config: ServerBootstrapConfig) -> Result<Self, ServerBootstrapError> {
        let deployment = Arc::new(LocalDeployment::new_at(&config.data_dir).await?);
        let pool = deployment.db().pool.clone();
        let provisioned = SqliteTokenHashStore::new(pool.clone())
            .provision(config.token)
            .await?;
        let (agent_event_sink, agent_events) = runtime_event_channel();
        let agent_runtime = Arc::new(AgentRuntime::new(agent_event_sink));
        let plugin_control_plane = Arc::new(PluginControlPlane::new(Arc::new(
            SqlitePluginRegistry::new(pool.clone()),
        )));
        let application_deployment: Arc<dyn Deployment> = deployment.clone();
        let conversation_context = ConversationContext {
            deployment: application_deployment,
            agent_runtime: agent_runtime.clone(),
            turn_locks: Arc::new(Mutex::new(HashMap::new())),
            runtime_states: Arc::new(Mutex::new(HashMap::new())),
            row_projectors: Arc::new(Mutex::new(
                HashMap::<uuid::Uuid, IncrementalRowProjector>::new(),
            )),
            host: Arc::new(DefaultConversationHost::with_product_mcp_server_names({
                let gate = plugin_control_plane.official_product_mcp_gate();
                std::sync::Arc::new(move || gate.product_mcp_names())
            })),
            event_publisher: Arc::new(conversations::NoopConversationEventPublisher),
        };
        let agent_event_task =
            start_agent_event_persistence(conversation_context.clone(), agent_events);
        let conversation_service =
            conversations::ConversationSessionService::new(conversation_context.clone());
        conversation_service
            .recover_interrupted_turns()
            .await
            .map_err(|error| ServerBootstrapError::Conversation(error.to_string()))?;
        conversations::ConversationRelationControl::new(pool.clone())
            .backfill_legacy_delegations()
            .await
            .map_err(|error| ServerBootstrapError::Conversation(error.to_string()))?;
        conversation_service
            .dispatch_queued_inputs()
            .await
            .map_err(|error| ServerBootstrapError::Conversation(error.to_string()))?;

        let preview_host: Arc<dyn PluginPreviewHost> = Arc::new(
            plugins::ExternalProcessPreviewHost::new(plugin_control_plane.clone()),
        );
        let capability_broker = Arc::new(plugins::HostCapabilityBroker::new(
            plugin_control_plane.clone(),
            preview_host.clone(),
        ));
        let worker_runtime = Arc::new(plugins::PluginWorkerRuntimeProvider::new(
            config.data_dir.clone(),
        ));
        let bundled_plugin_roots = utils::assets::materialize_builtin_plugins(&config.data_dir)
            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
        for builtin_root in bundled_plugin_roots {
            let mut builtin =
                plugins::PluginPackage::inspect(&builtin_root, plugins::PluginSourceKind::Builtin)
                    .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
            let installed = plugin_control_plane
                .plugin(builtin.id.as_str())
                .await
                .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
            match installed {
                None => {
                    plugin_control_plane
                        .import(builtin, ConflictDecision::Reject)
                        .await
                        .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
                }
                Some(installed)
                    if installed.package_digest
                        != plugins::package_content_digest(&builtin_root)
                            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))? =>
                {
                    if installed.config_schema.is_some() {
                        builtin
                            .write_config(installed.config.clone())
                            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
                        builtin = plugins::PluginPackage::inspect(
                            &builtin_root,
                            plugins::PluginSourceKind::Builtin,
                        )
                        .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
                    }
                    if installed.activation == plugins::PluginActivation::Enabled {
                        let grants = plugins::candidate_capability_grants(&builtin, &[], &[])
                            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
                        let node = worker_runtime
                            .resolve()
                            .await
                            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
                        plugin_control_plane
                            .update_and_activate(&node, builtin, &grants, capability_broker.clone())
                            .await
                            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
                    } else {
                        plugin_control_plane
                            .import(builtin, ConflictDecision::Replace)
                            .await
                            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
                    }
                }
                Some(_) => {}
            }
        }
        let enabled_worker_exists = plugin_control_plane
            .catalog()
            .await
            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?
            .iter()
            .any(|plugin| {
                plugin.activation == plugins::PluginActivation::Enabled
                    && plugin.entrypoints.worker.is_some()
            });
        let recovery_failures = if enabled_worker_exists {
            match worker_runtime.resolve().await {
                Ok(node) => plugin_control_plane
                    .recover_enabled_workers(
                        &node,
                        &config.data_dir.join("plugins").join("dev-candidates"),
                        capability_broker.clone(),
                    )
                    .await
                    .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?,
                Err(error) => {
                    tracing::warn!(%error, "Plugin Worker Runtime could not be provisioned");
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        for failure in recovery_failures {
            tracing::warn!(
                plugin_id = %failure.plugin_id,
                code = %failure.code,
                error = %failure.message,
                "enabled plugin Worker could not be restored"
            );
        }
        plugin_control_plane
            .sync_official_product_mcp_gate()
            .await
            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
        let delegation_runtime = HeadlessDelegationRuntime::start(
            agent_runtime.clone(),
            pool.clone(),
            conversation_context.clone(),
            plugin_control_plane.official_product_mcp_gate(),
        );
        let app_surfaces = Arc::new(plugins::PluginAppSurfaceHost::new(
            plugin_control_plane.clone(),
        ));
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
            plugin_control_plane.clone(),
        );
        let preview_proxy = PreviewProxyRegistry::default();
        crate::start_chat_inbound(pool.clone(), conversation_context.clone());
        application::WorkflowStoreExecutionPort::with_conversations(
            pool.clone(),
            conversation_context.clone(),
        )
        .reconcile_interrupted()
        .await
        .map_err(|error| ServerBootstrapError::Conversation(error.to_string()))?;
        let core = crate::host_application_core(
            pool.clone(),
            conversation_context.clone(),
            plugin_control_plane,
            preview_host,
            capability_broker,
            app_surfaces,
            preview_proxy.clone(),
            automation_runtime.clone(),
            automation_owner.is_some(),
            deployment.clone(),
            config.data_dir.join("plugins/runtimes"),
            worker_runtime,
        );
        let workflow_dispatcher =
            application::WorkflowAgentDispatcher::new(conversation_context.clone());
        let workflow_dispatch_task = tokio::spawn(async move {
            loop {
                match workflow_dispatcher.tick().await {
                    Ok(true) => continue,
                    Ok(false) => tokio::time::sleep(std::time::Duration::from_secs(2)).await,
                    Err(error) => {
                        tracing::warn!(%error, "workflow dispatcher tick failed");
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                }
            }
        });
        let runtime = ServerRuntime::from_sqlite_auth_with_preview_proxy(
            config.server,
            pool.clone(),
            core,
            preview_proxy,
        );

        Ok(Self {
            pool,
            runtime,
            issued_token: provisioned.issued_token,
            _agent_runtime: agent_runtime,
            automation_runtime,
            automation_owner,
            automation_recovery,
            agent_event_task: Some(agent_event_task),
            _delegation_runtime: delegation_runtime,
            workflow_dispatch_task,
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
        self.workflow_dispatch_task.abort();
        if let Some(task) = self.agent_event_task.take() {
            task.abort();
        }
    }
}
