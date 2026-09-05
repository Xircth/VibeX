use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};

use agents::{AgentEventEnvelope, AgentId, AgentRuntime, runtime_event_channel};
use deployment::Deployment;
use local_deployment::{LocalDeployment, pty::PtyService};
use tauri::Manager;
use tokio::sync::{Mutex, mpsc};

use crate::commands::{
    desktop_toast::DesktopToastPayload, local_history::LocalHistoryImportRuntime,
};

#[derive(Default)]
pub struct DesktopToastRuntimeState {
    pub ready: bool,
    pub pending: Vec<DesktopToastPayload>,
}

#[derive(Default)]
pub struct AgentManagementRuntimeState {
    warmup_complete: Mutex<bool>,
    local_runtime_discovery_complete: Mutex<bool>,
    local_runtime_discovery_progress: Mutex<LocalRuntimeDiscoveryProgress>,
    built_in_probes: Mutex<HashSet<AgentId>>,
    local_runtimes: Mutex<HashMap<AgentId, LocalRuntimeEvidence>>,
    acp_adapters: Mutex<HashMap<AgentId, LocalRuntimeEvidence>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalRuntimeEvidence {
    pub path: PathBuf,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalRuntimeDiscoveryProgress {
    pub started: bool,
    pub running: bool,
    pub completed: u32,
    pub total: u32,
    pub found: u32,
    pub checked_agent_ids: HashSet<AgentId>,
    pub timed_out: bool,
}

impl AgentManagementRuntimeState {
    pub async fn run_warmup_once<Fut>(&self, work: Fut)
    where
        Fut: std::future::Future<Output = ()>,
    {
        let mut complete = self.warmup_complete.lock().await;
        if *complete {
            return;
        }
        work.await;
        *complete = true;
    }

    pub async fn run_local_runtime_discovery_once<Fut>(&self, work: Fut)
    where
        Fut: std::future::Future<Output = ()>,
    {
        let mut complete = self.local_runtime_discovery_complete.lock().await;
        if *complete {
            return;
        }
        work.await;
        *complete = true;
    }

    pub async fn refresh_local_runtime_discovery<Fut>(&self, work: Fut)
    where
        Fut: std::future::Future<Output = ()>,
    {
        let mut complete = self.local_runtime_discovery_complete.lock().await;
        work.await;
        *complete = true;
    }

    pub async fn reset(&self) {
        *self.warmup_complete.lock().await = false;
        *self.local_runtime_discovery_complete.lock().await = false;
        *self.local_runtime_discovery_progress.lock().await = Default::default();
        self.built_in_probes.lock().await.clear();
        self.local_runtimes.lock().await.clear();
        self.acp_adapters.lock().await.clear();
    }

    pub async fn begin_local_runtime_discovery(&self, total: u32) {
        *self.local_runtime_discovery_progress.lock().await = LocalRuntimeDiscoveryProgress {
            started: true,
            running: true,
            total,
            ..Default::default()
        };
    }

    pub async fn record_local_runtime_discovery(&self, agent_id: AgentId, found: bool) {
        let mut progress = self.local_runtime_discovery_progress.lock().await;
        if progress.checked_agent_ids.insert(agent_id) {
            progress.completed =
                u32::try_from(progress.checked_agent_ids.len()).unwrap_or(u32::MAX);
            if found {
                progress.found = progress.found.saturating_add(1);
            }
        }
    }

    pub async fn finish_local_runtime_discovery(&self, timed_out: bool) {
        let mut progress = self.local_runtime_discovery_progress.lock().await;
        progress.started = true;
        progress.running = false;
        progress.timed_out = timed_out;
    }

    pub async fn local_runtime_discovery_progress(&self) -> LocalRuntimeDiscoveryProgress {
        self.local_runtime_discovery_progress.lock().await.clone()
    }

    pub async fn should_probe_built_in(&self, agent_id: &AgentId, force: bool) -> bool {
        self.built_in_probes.lock().await.insert(agent_id.clone()) || force
    }

    pub async fn replace_local_runtime(
        &self,
        agent_id: AgentId,
        evidence: Option<LocalRuntimeEvidence>,
    ) {
        let mut local_runtimes = self.local_runtimes.lock().await;
        match evidence {
            Some(evidence) => {
                local_runtimes.insert(agent_id, evidence);
            }
            None => {
                local_runtimes.remove(&agent_id);
            }
        }
    }

    pub async fn local_runtime(&self, agent_id: &AgentId) -> Option<LocalRuntimeEvidence> {
        self.local_runtimes.lock().await.get(agent_id).cloned()
    }

    pub async fn local_runtimes(&self) -> HashMap<AgentId, LocalRuntimeEvidence> {
        self.local_runtimes.lock().await.clone()
    }

    pub async fn replace_acp_adapter(
        &self,
        agent_id: AgentId,
        evidence: Option<LocalRuntimeEvidence>,
    ) {
        let mut acp_adapters = self.acp_adapters.lock().await;
        match evidence {
            Some(evidence) => {
                acp_adapters.insert(agent_id, evidence);
            }
            None => {
                acp_adapters.remove(&agent_id);
            }
        }
    }

    pub async fn acp_adapters(&self) -> HashMap<AgentId, LocalRuntimeEvidence> {
        self.acp_adapters.lock().await.clone()
    }
}

pub struct AppState {
    pub app_handle: tauri::AppHandle,
    pub local_deployment: Arc<LocalDeployment>,
    pub deployment: Arc<dyn Deployment>,
    /// PTY session registry for terminal commands. A shared (Arc-backed) handle to the
    /// same registry the deployment owns — kept as a first-class field because
    /// `PtyService` lives in `local-deployment` and cannot be exposed through the
    /// object-safe `Deployment` trait without an upward crate dependency.
    pub pty: PtyService,
    pub file_tree_watchers: Arc<Mutex<HashSet<String>>>,
    pub conversation_streams: Arc<Mutex<HashSet<String>>>,
    pub desktop_toast_state: Arc<Mutex<DesktopToastRuntimeState>>,
    pub agent_management_runtime: Arc<AgentManagementRuntimeState>,
    pub agent_runtime: Arc<AgentRuntime>,
    pub conversation_agent_events: StdMutex<Option<mpsc::Receiver<AgentEventEnvelope>>>,
    pub delegation: crate::delegation::DelegationState,
    pub conversation_turn_locks: Arc<Mutex<HashMap<uuid::Uuid, Arc<Mutex<()>>>>>,
    pub conversation_runtime_states:
        Arc<Mutex<HashMap<uuid::Uuid, conversations::ConversationRuntimeState>>>,
    /// Per-conversation live incremental projectors (消灭双投影). Cache the folded
    /// state so each newly-appended event turns into row ops in O(1) amortized instead
    /// of re-projecting the turn every frame. Bounded by least recent use, and dropped
    /// when a conversation closes (`forget_conversation_runtime`).
    pub conversation_row_projectors: conversations::ConversationRowProjectors,
    pub plugin_preview_host: Arc<dyn plugins::PluginPreviewHost>,
    pub plugin_control_plane: Arc<plugins::PluginControlPlane>,
    pub plugin_worker_runtime: Arc<plugins::PluginWorkerRuntimeProvider>,
    pub plugin_capability_broker: Arc<plugins::HostCapabilityBroker>,
    pub plugin_app_surfaces: Arc<plugins::PluginAppSurfaceHost>,
    pub remote_desktop: Arc<crate::remote_desktop::RemoteDesktopRegistry>,
    pub local_history_import: Arc<StdMutex<LocalHistoryImportRuntime>>,
}

impl AppState {
    pub async fn new(app_handle: tauri::AppHandle) -> Result<Self, deployment::DeploymentError> {
        let local_deployment = Arc::new(LocalDeployment::new().await?);
        let deployment: Arc<dyn Deployment> = local_deployment.clone();
        let pty = local_deployment.pty().clone();
        let pool = deployment.db().pool.clone();
        // The event-sourced `conversation_events` log is the single authoritative
        // record (批次D). The first-generation `agent_*` shadow tables are retired;
        // runtime events now flow through one lossless receiver into that log.
        let (agent_event_sink, conversation_agent_events) = runtime_event_channel();
        let agent_runtime = Arc::new(AgentRuntime::new(agent_event_sink));
        let plugin_control_plane = Arc::new(plugins::PluginControlPlane::new(Arc::new(
            plugins::SqlitePluginRegistry::new(pool.clone()),
        )));
        let plugin_worker_runtime = Arc::new(plugins::PluginWorkerRuntimeProvider::new(
            crate::managed_artifacts::directory(&app_handle).map_err(|error| {
                deployment::DeploymentError::Other(anyhow::anyhow!(error.to_string()))
            })?,
        ));
        let plugin_preview_host: Arc<dyn plugins::PluginPreviewHost> = Arc::new(
            plugins::ExternalProcessPreviewHost::new(plugin_control_plane.clone()),
        );
        let plugin_capability_broker = Arc::new(plugins::HostCapabilityBroker::new(
            plugin_control_plane.clone(),
            plugin_preview_host.clone(),
        ));
        plugin_control_plane
            .install_bundled_official_plugins(&utils::assets::asset_dir(), None)
            .await
            .map_err(|error| deployment::DeploymentError::Other(anyhow::anyhow!(error)))?;
        let enabled_worker_exists = plugin_control_plane
            .catalog()
            .await
            .map_err(|error| deployment::DeploymentError::Other(anyhow::anyhow!(error)))?
            .iter()
            .any(|plugin| {
                plugin.activation == plugins::PluginActivation::Enabled
                    && plugin.entrypoints.worker.is_some()
            });
        let recovery_failures = if enabled_worker_exists {
            match plugin_worker_runtime.resolve().await {
                Ok(node) => {
                    let candidate_root = app_handle
                        .path()
                        .app_data_dir()
                        .map_err(|error| {
                            deployment::DeploymentError::Other(anyhow::anyhow!(error.to_string()))
                        })?
                        .join("plugins")
                        .join("dev-candidates");
                    plugin_control_plane
                        .recover_enabled_workers(
                            &node,
                            &candidate_root,
                            plugin_capability_broker.clone(),
                        )
                        .await
                        .map_err(|error| {
                            deployment::DeploymentError::Other(anyhow::anyhow!(error))
                        })?
                }
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
        if let Ok(node) = plugin_worker_runtime.resolve().await
            && let Ok(candidate_root) = app_handle
                .path()
                .app_data_dir()
                .map(|dir| dir.join("plugins").join("dev-candidates"))
        {
            // Fire and forget: the refresh task manages its own lifetime, so
            // the join handle is dropped rather than awaited here.
            drop(plugins::PluginControlPlane::spawn_developer_link_refresh(
                plugin_control_plane.clone(),
                node,
                candidate_root,
                plugin_capability_broker.clone(),
            ));
        }
        let remote_desktop = Arc::new(
            crate::remote_desktop::RemoteDesktopRegistry::new()
                .map_err(|error| deployment::DeploymentError::Other(anyhow::anyhow!(error)))?,
        );
        let plugin_app_surfaces = Arc::new(plugins::PluginAppSurfaceHost::new(
            plugin_control_plane.clone(),
        ));
        let conversation_turn_locks = Arc::new(Mutex::new(HashMap::new()));
        let conversation_runtime_states = Arc::new(Mutex::new(HashMap::new()));
        let conversation_row_projectors = Arc::new(Mutex::new(HashMap::new()));
        let conversation_context = conversations::ConversationContext {
            deployment: deployment.clone(),
            agent_runtime: agent_runtime.clone(),
            turn_locks: conversation_turn_locks.clone(),
            runtime_states: conversation_runtime_states.clone(),
            row_projectors: conversation_row_projectors.clone(),
            host: Arc::new(crate::conversation_service::AppConversationHost {
                deployment: deployment.clone(),
                official_mcp: plugin_control_plane.official_product_mcp_gate(),
            }),
            event_publisher: Arc::new(server::ChatDeliveryPublisher::new(Arc::new(
                crate::conversation_service::AppConversationEventPublisher {
                    app_handle: app_handle.clone(),
                    deployment: deployment.clone(),
                    row_projectors: conversation_row_projectors.clone(),
                },
            ))),
        };
        plugin_control_plane
            .sync_official_product_mcp_gate()
            .await
            .map_err(|error| deployment::DeploymentError::Other(anyhow::anyhow!(error)))?;
        // Build the delegation broker over the same ConversationContext used by
        // desktop commands, so companion send/wait cannot grow a second runtime.
        let delegation = crate::delegation::build_delegation(
            agent_runtime.clone(),
            pool,
            conversation_context,
            plugin_control_plane.official_product_mcp_gate(),
        );
        if let Err(error) = server::start_product_mcp_gateway(
            delegation.listener.clone(),
            delegation.tokens.clone(),
            plugin_control_plane.official_product_mcp_gate(),
            Arc::new(crate::delegation::RuntimeConversationLookup {
                runtime: agent_runtime.clone(),
            }),
        )
        .await
        {
            tracing::error!(%error, "product MCP gateway failed to start");
        }
        crate::commands::plugin_control::refresh_official_product_runtime(
            &plugin_control_plane,
            &delegation.broker,
        )
        .await
        .map_err(|error| deployment::DeploymentError::Other(anyhow::anyhow!(error.to_string())))?;
        Ok(Self {
            app_handle,
            local_deployment,
            deployment,
            pty,
            file_tree_watchers: Arc::new(Mutex::new(HashSet::new())),
            conversation_streams: Arc::new(Mutex::new(HashSet::new())),
            desktop_toast_state: Arc::new(Mutex::new(DesktopToastRuntimeState::default())),
            agent_management_runtime: Arc::new(AgentManagementRuntimeState::default()),
            agent_runtime,
            conversation_agent_events: StdMutex::new(Some(conversation_agent_events)),
            delegation,
            conversation_turn_locks,
            conversation_runtime_states,
            conversation_row_projectors,
            plugin_preview_host,
            plugin_control_plane,
            plugin_worker_runtime,
            plugin_capability_broker,
            plugin_app_surfaces,
            remote_desktop,
            local_history_import: Arc::new(StdMutex::new(LocalHistoryImportRuntime::default())),
        })
    }

    /// Assemble the [`conversations::ConversationContext`] the orchestration core needs,
    /// injecting the src-tauri-coupled [`AppConversationHost`]. Cheap (Arc clones).
    pub fn conversation_context(&self) -> conversations::ConversationContext {
        conversations::ConversationContext {
            deployment: self.deployment.clone(),
            agent_runtime: self.agent_runtime.clone(),
            turn_locks: self.conversation_turn_locks.clone(),
            runtime_states: self.conversation_runtime_states.clone(),
            row_projectors: self.conversation_row_projectors.clone(),
            host: Arc::new(crate::conversation_service::AppConversationHost {
                deployment: self.deployment.clone(),
                official_mcp: self.plugin_control_plane.official_product_mcp_gate(),
            }),
            event_publisher: Arc::new(server::ChatDeliveryPublisher::new(Arc::new(
                crate::conversation_service::AppConversationEventPublisher {
                    app_handle: self.app_handle.clone(),
                    deployment: self.deployment.clone(),
                    row_projectors: self.conversation_row_projectors.clone(),
                },
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::{AgentManagementRuntimeState, LocalRuntimeEvidence};

    #[tokio::test]
    async fn local_runtime_discovery_reports_real_progress() {
        let runtime = AgentManagementRuntimeState::default();
        let claude = agents::AgentId::parse("claude_code").unwrap();
        let codex = agents::AgentId::parse("codex").unwrap();

        runtime.begin_local_runtime_discovery(12).await;
        runtime
            .record_local_runtime_discovery(claude.clone(), true)
            .await;
        runtime
            .record_local_runtime_discovery(codex.clone(), false)
            .await;

        let progress = runtime.local_runtime_discovery_progress().await;
        assert!(progress.running);
        assert_eq!(progress.completed, 2);
        assert_eq!(progress.total, 12);
        assert_eq!(progress.found, 1);
        assert!(progress.checked_agent_ids.contains(&claude));
        assert!(progress.checked_agent_ids.contains(&codex));

        runtime.finish_local_runtime_discovery(false).await;
        let progress = runtime.local_runtime_discovery_progress().await;
        assert!(!progress.running);
        assert!(!progress.timed_out);
    }

    #[tokio::test]
    async fn local_data_reset_allows_agent_discovery_to_run_again() {
        let runtime = AgentManagementRuntimeState::default();
        let runs = Arc::new(AtomicUsize::new(0));
        let local_runs = Arc::new(AtomicUsize::new(0));

        let first_runs = runs.clone();
        runtime
            .run_warmup_once(async move {
                first_runs.fetch_add(1, Ordering::SeqCst);
            })
            .await;
        runtime
            .run_warmup_once(async {
                panic!("warmup must remain shared before reset");
            })
            .await;
        let first_local_runs = local_runs.clone();
        runtime
            .run_local_runtime_discovery_once(async move {
                first_local_runs.fetch_add(1, Ordering::SeqCst);
            })
            .await;
        runtime.run_local_runtime_discovery_once(async {}).await;

        runtime.reset().await;

        let second_runs = runs.clone();
        runtime
            .run_warmup_once(async move {
                second_runs.fetch_add(1, Ordering::SeqCst);
            })
            .await;
        let second_local_runs = local_runs.clone();
        runtime
            .run_local_runtime_discovery_once(async move {
                second_local_runs.fetch_add(1, Ordering::SeqCst);
            })
            .await;

        assert_eq!(runs.load(Ordering::SeqCst), 2);
        assert_eq!(local_runs.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn local_data_reset_forgets_previous_agent_probe_attempts() {
        let runtime = AgentManagementRuntimeState::default();
        let claude = agents::AgentId::parse("claude_code").unwrap();

        assert!(runtime.should_probe_built_in(&claude, false).await);
        assert!(!runtime.should_probe_built_in(&claude, false).await);
        runtime
            .replace_local_runtime(
                claude.clone(),
                Some(LocalRuntimeEvidence {
                    path: r"C:\Users\developer\AppData\Roaming\npm\claude.cmd".into(),
                    version: Some("2.1.173".to_string()),
                }),
            )
            .await;
        assert!(runtime.local_runtime(&claude).await.is_some());
        runtime
            .replace_acp_adapter(
                claude.clone(),
                Some(LocalRuntimeEvidence {
                    path: r"C:\Users\developer\AppData\Roaming\npm\claude-agent-acp.cmd".into(),
                    version: Some("0.69.0".to_string()),
                }),
            )
            .await;
        assert!(!runtime.acp_adapters().await.is_empty());

        runtime.reset().await;

        assert!(runtime.should_probe_built_in(&claude, false).await);
        assert!(runtime.local_runtime(&claude).await.is_none());
        assert!(runtime.acp_adapters().await.is_empty());
    }
}
