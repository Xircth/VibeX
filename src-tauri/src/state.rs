use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex as StdMutex},
};

use agents::{AgentEventEnvelope, AgentRuntime, runtime_event_channel};
use deployment::Deployment;
use local_deployment::{LocalDeployment, pty::PtyService};
pub use services::services::agent_management_runtime::{
    AgentManagementRuntimeState, LocalRuntimeDiscoveryProgress, LocalRuntimeEvidence,
};
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
    pub plugin_provider_presets: Arc<server::HostProviderPresetHost>,
    pub plugin_app_surfaces: Arc<plugins::PluginAppSurfaceHost>,
    pub remote_desktop: Arc<crate::remote_desktop::RemoteDesktopRegistry>,
    pub local_history_import: Arc<StdMutex<LocalHistoryImportRuntime>>,
    pub host: server::HostRuntime,
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
        plugin_control_plane.watch_worker_crashes();
        let plugin_worker_runtime = Arc::new(plugins::PluginWorkerRuntimeProvider::new(
            crate::managed_artifacts::directory(&app_handle).map_err(|error| {
                deployment::DeploymentError::Other(anyhow::anyhow!(error.to_string()))
            })?,
        ));
        let plugin_preview_host: Arc<dyn plugins::PluginPreviewHost> = Arc::new(
            plugins::ExternalProcessPreviewHost::new(plugin_control_plane.clone()),
        );
        let events = std::sync::Arc::new(server::HostEventBus::new());
        crate::host_bus::install(events.clone());
        let bind_prompts = std::sync::Arc::new(plugins::ProviderBindPrompts::default());
        let provider_preset_host = std::sync::Arc::new(server::HostProviderPresetHost::new(
            pool.clone(),
            events.clone(),
            bind_prompts.clone(),
            plugin_control_plane.clone(),
        ));
        let remote_profile_host = std::sync::Arc::new(
            crate::plugin_remote_profiles::TauriRemoteProfileHost::new(app_handle.clone()),
        );
        let plugin_conversation_host =
            std::sync::Arc::new(server::HostPluginConversationHost::new(
                pool.clone(),
                utils::assets::host_data_dir()
                    .join("scratch")
                    .join("plugins"),
            ));
        let plugin_capability_broker = std::sync::Arc::new(
            plugins::HostCapabilityBroker::with_hosts_and_prompts(
                plugin_control_plane.clone(),
                plugin_preview_host.clone(),
                provider_preset_host.clone(),
                remote_profile_host,
                bind_prompts,
            )
            .with_conversation_host(plugin_conversation_host.clone()),
        );
        let bundled_roots = plugin_control_plane
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
        let recovery_failures = match plugin_worker_runtime.resolve().await {
            Ok(node) => {
                let activation = plugins::BundledPluginActivation {
                    node_executable: node.clone(),
                    broker: plugin_capability_broker.clone(),
                };
                if let Err(error) = plugin_control_plane
                    .refresh_installed_bundled_plugins(&bundled_roots, Some(&activation))
                    .await
                {
                    tracing::warn!(%error, "official plugin packages could not be refreshed");
                }
                if enabled_worker_exists {
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
                } else {
                    Vec::new()
                }
            }
            Err(error) => {
                tracing::warn!(%error, "Plugin Worker Runtime could not be provisioned");
                Vec::new()
            }
        };
        for failure in recovery_failures {
            tracing::warn!(
                plugin_id = %failure.plugin_id,
                code = %failure.code,
                error = %failure.message,
                "enabled plugin Worker could not be restored"
            );
        }
        if let Ok(node) = plugin_worker_runtime.resolve().await {
            if let Ok(candidate_root) = app_handle
                .path()
                .app_data_dir()
                .map(|dir| dir.join("plugins").join("dev-candidates"))
            {
                let _ = plugins::PluginControlPlane::spawn_developer_link_refresh(
                    plugin_control_plane.clone(),
                    node,
                    candidate_root,
                    plugin_capability_broker.clone(),
                );
            }
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
        let preview_proxy = server::PreviewProxyRegistry::default();
        let agent_management_runtime = Arc::new(AgentManagementRuntimeState::default());
        let host_conversations = conversations::ConversationContext {
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
        let host = server::HostRuntime::build(server::HostRuntimeParts {
            pool: deployment.db().pool.clone(),
            conversations: host_conversations,
            plugin_control_plane: plugin_control_plane.clone(),
            companion_memory: Some(delegation.features.clone()),
            preview_host: plugin_preview_host.clone(),
            capability_broker: plugin_capability_broker.clone(),
            app_surfaces: plugin_app_surfaces.clone(),
            preview_proxy: preview_proxy.clone(),
            automation: server::HeadlessAutomationRuntime::new(
                local_deployment.clone(),
                conversations::ConversationContext {
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
                },
                plugin_control_plane.clone(),
            ),
            automation_ownership: server::AutomationOwnership::from_fn(
                crate::commands::automation::this_host_owns_automation_engine,
            ),
            deployment: local_deployment.clone(),
            runtime_root: utils::assets::asset_dir().join("plugins/runtimes"),
            worker_runtime: plugin_worker_runtime.clone(),
            adapter: application::AdapterCapabilities::desktop_host(),
            events: Some(events),
            terminal_bridges: None,
            agent_management_runtime: Some(agent_management_runtime.clone()),
            conversation_host: Some(plugin_conversation_host),
        });
        Ok(Self {
            app_handle,
            local_deployment,
            deployment,
            pty,
            file_tree_watchers: Arc::new(Mutex::new(HashSet::new())),
            conversation_streams: Arc::new(Mutex::new(HashSet::new())),
            desktop_toast_state: Arc::new(Mutex::new(DesktopToastRuntimeState::default())),
            agent_management_runtime,
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
            plugin_provider_presets: provider_preset_host,
            plugin_app_surfaces,
            remote_desktop,
            local_history_import: Arc::new(StdMutex::new(LocalHistoryImportRuntime::default())),
            host,
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
