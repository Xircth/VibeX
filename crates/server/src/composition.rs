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
use conversations::{ConversationAgentEventRecorder, ConversationContext, DefaultConversationHost};
use db::models::automation_v2::SqliteAutomationStore;
use deployment::{Deployment, DeploymentError};
use local_deployment::LocalDeployment;
use plugins::{PluginControlPlane, PluginPreviewHost, SqlitePluginRegistry};
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
    #[error("host identity failed: {0}")]
    HostIdentity(String),
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
    pub async fn bootstrap(
        mut config: ServerBootstrapConfig,
    ) -> Result<Self, ServerBootstrapError> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        config.server.host_id = utils::assets::load_or_create_host_id(&config.data_dir)
            .map_err(|error| ServerBootstrapError::HostIdentity(error.to_string()))?;
        if config.server.reachability.is_empty() {
            let allow_lan = utils::net::listen_allows_lan(config.server.listen_addr);
            config.server.reachability =
                utils::net::advertised_http_origins(config.server.listen_addr.port(), allow_lan)
                    .into_iter()
                    .filter(|origin| !remote_protocol::is_loopback_origin(origin))
                    .map(remote_protocol::ReachabilityOrigin::lan)
                    .collect();
        }
        let deployment = Arc::new(LocalDeployment::new_at(&config.data_dir).await?);
        let pool = deployment.db().pool.clone();
        let provisioned = SqliteTokenHashStore::new(pool.clone())
            .provision(config.token)
            .await?;
        let (agent_event_sink, mut agent_events) = runtime_event_channel();
        let agent_runtime = Arc::new(AgentRuntime::new(agent_event_sink));
        let plugin_control_plane = Arc::new(PluginControlPlane::new(Arc::new(
            SqlitePluginRegistry::new(pool.clone()),
        )));
        let application_deployment: Arc<dyn Deployment> = deployment.clone();
        let row_projectors = Arc::new(Mutex::new(HashMap::new()));
        let conversation_context = ConversationContext {
            deployment: application_deployment,
            agent_runtime: agent_runtime.clone(),
            turn_locks: Arc::new(Mutex::new(HashMap::new())),
            runtime_states: Arc::new(Mutex::new(HashMap::new())),
            row_projectors: row_projectors.clone(),
            host: Arc::new(DefaultConversationHost::with_product_mcp_server_names({
                let gate = plugin_control_plane.official_product_mcp_gate();
                std::sync::Arc::new(move || gate.product_mcp_names())
            })),
            event_publisher: Arc::new(crate::chat_notify::ChatDeliveryPublisher::new(Arc::new(
                crate::host::HostRowOpPublisher::new(pool.clone(), row_projectors),
            ))),
        };
        let agent_event_task = {
            let context = conversation_context.clone();
            tokio::spawn(async move {
                let mut recorder = ConversationAgentEventRecorder::with_context(context);
                while let Some(envelope) = agent_events.recv().await {
                    if let Err(error) = recorder.record(&envelope).await {
                        tracing::warn!(
                            sequence = envelope.sequence,
                            %error,
                            "failed to persist agent runtime event"
                        );
                    }
                    if !matches!(
                        envelope.event,
                        agents::AgentEvent::MessageChunk { .. }
                            | agents::AgentEvent::ThoughtChunk { .. }
                            | agents::AgentEvent::ToolCallUpdate { .. }
                            | agents::AgentEvent::TerminalOutput { .. }
                            | agents::AgentEvent::RawAcpDiagnostic { .. }
                    ) {
                        crate::host::events::global_host_events().emit("agent-events", &envelope);
                    }
                }
            })
        };
        let _terminal_task = {
            let pool = pool.clone();
            tokio::spawn(async move {
                use agents::terminal::AgentTerminalLifecycleEvent;
                use db::models::session::Session;
                let mut rx = agents::terminal::agent_terminal_registry().subscribe_lifecycle();
                loop {
                    match rx.recv().await {
                        Ok(AgentTerminalLifecycleEvent::Created(event)) => {
                            let workspace_id = Session::find_by_id(&pool, event.session_id.0)
                                .await
                                .ok()
                                .flatten()
                                .map(|session| session.workspace_id);
                            crate::host::events::global_host_events().emit(
                                "agent-terminal-events",
                                serde_json::json!({
                                    "Created": {
                                        "source": "acp",
                                        "session_id": event.terminal_id.0,
                                        "agent_session_id": event.session_id.0,
                                        "workspace_id": workspace_id,
                                        "title": format!("ACP {}", event.command.split_whitespace().next().unwrap_or("Terminal")),
                                        "command": event.command,
                                        "agent_label": "Agent",
                                        "cwd": event.cwd.and_then(|cwd| cwd.to_str().map(str::to_string)),
                                    }
                                }),
                            );
                        }
                        Ok(AgentTerminalLifecycleEvent::Exited { terminal_id, .. }) => {
                            crate::host::events::global_host_events().emit(
                                "agent-terminal-events",
                                serde_json::json!({
                                    "Exited": {
                                        "source": "acp",
                                        "session_id": terminal_id.0,
                                        "workspace_id": null,
                                    }
                                }),
                            );
                        }
                        Ok(AgentTerminalLifecycleEvent::Released { terminal_id }) => {
                            crate::host::events::global_host_events().emit(
                                "agent-terminal-events",
                                serde_json::json!({
                                    "Released": {
                                        "source": "acp",
                                        "session_id": terminal_id.0,
                                        "workspace_id": null,
                                    }
                                }),
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            })
        };
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
        plugin_control_plane
            .install_bundled_official_plugins(&config.data_dir, None)
            .await
            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
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
        if let Err(error) = plugin_control_plane.import_queued_developer_links().await {
            tracing::warn!(%error, "queued linked Plugin inbox import failed");
        }
        if let Ok(node) = worker_runtime.resolve().await {
            let _ = plugins::PluginControlPlane::spawn_developer_link_refresh(
                plugin_control_plane.clone(),
                node,
                config.data_dir.join("plugins").join("dev-candidates"),
                capability_broker.clone(),
            );
        }
        plugin_control_plane
            .sync_official_product_mcp_gate()
            .await
            .map_err(|error| ServerBootstrapError::Plugin(error.to_string()))?;
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
        let (delegation_runtime, companion_memory) = HeadlessDelegationRuntime::start(
            agent_runtime.clone(),
            pool.clone(),
            conversation_context.clone(),
            plugin_control_plane.official_product_mcp_gate(),
        );
        let core = crate::host_application_core(
            pool.clone(),
            conversation_context.clone(),
            plugin_control_plane,
            Some(companion_memory),
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
        let runtime = ServerRuntime::from_sqlite_auth_with_preview_proxy_and_pty(
            config.server,
            pool.clone(),
            core,
            preview_proxy,
            deployment.pty().clone(),
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
