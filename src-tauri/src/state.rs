use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use agents::AgentRuntime;
use deployment::Deployment;
use local_deployment::{LocalDeployment, pty::PtyService};
use tokio::sync::Mutex;

use crate::commands::{
    desktop_toast::DesktopToastPayload,
    local_usage::{ProjectUsageProviderStatus, ProjectUsageSessionSummary},
};

#[derive(Default)]
pub struct DesktopToastRuntimeState {
    pub ready: bool,
    pub pending: Vec<DesktopToastPayload>,
}

#[derive(Clone, Default)]
pub struct LocalUsageCacheEntry {
    pub sessions: Vec<ProjectUsageSessionSummary>,
    pub provider_status: Vec<ProjectUsageProviderStatus>,
    pub scanned_at_ms: i64,
}

pub struct AppState {
    pub app_handle: tauri::AppHandle,
    pub deployment: Arc<dyn Deployment>,
    /// PTY session registry for terminal commands. A shared (Arc-backed) handle to the
    /// same registry the deployment owns — kept as a first-class field because
    /// `PtyService` lives in `local-deployment` and cannot be exposed through the
    /// object-safe `Deployment` trait without an upward crate dependency.
    pub pty: PtyService,
    pub file_tree_watchers: Arc<Mutex<HashSet<String>>>,
    pub conversation_streams: Arc<Mutex<HashSet<String>>>,
    pub desktop_toast_state: Arc<Mutex<DesktopToastRuntimeState>>,
    pub local_usage_cache: Arc<Mutex<HashMap<String, LocalUsageCacheEntry>>>,
    pub agent_runtime: Arc<AgentRuntime>,
    pub delegation: crate::delegation::DelegationState,
    pub conversation_turn_locks: Arc<Mutex<HashMap<uuid::Uuid, Arc<Mutex<()>>>>>,
    pub conversation_runtime_states:
        Arc<Mutex<HashMap<uuid::Uuid, conversations::ConversationRuntimeState>>>,
    /// Per-conversation live incremental projectors (消灭双投影). Cache the folded
    /// state so each newly-appended event turns into row ops in O(1) amortized instead
    /// of re-projecting the turn every frame. Dropped when a conversation closes
    /// (`forget_conversation_runtime`).
    pub conversation_row_projectors:
        Arc<Mutex<HashMap<uuid::Uuid, conversations::IncrementalRowProjector>>>,
    pub office_runtime: Arc<crate::office_runtime::OfficeRuntime>,
    pub remote_desktop: Arc<crate::remote_desktop::RemoteDesktopRegistry>,
}

impl AppState {
    pub async fn new(app_handle: tauri::AppHandle) -> Result<Self, deployment::DeploymentError> {
        let deployment = LocalDeployment::new().await?;
        let pty = deployment.pty().clone();
        let pool = deployment.db().pool.clone();
        // The event-sourced `conversation_events` log is the single authoritative
        // record (批次D). The first-generation `agent_*` shadow tables are retired, so
        // the runtime uses the no-op sink instead of the old SQLite mirror.
        let agent_runtime = Arc::new(AgentRuntime::default());
        let office_runtime = Arc::new(
            crate::office_runtime::OfficeRuntime::new(
                pool.clone(),
                utils::assets::asset_dir().join("managed-tools"),
            )
            .await?,
        );
        let remote_desktop = Arc::new(
            crate::remote_desktop::RemoteDesktopRegistry::new()
                .map_err(|error| deployment::DeploymentError::Other(anyhow::anyhow!(error)))?,
        );
        if office_runtime.should_restore_enabled_on_startup() {
            let runtime = office_runtime.clone();
            tokio::spawn(async move {
                if let Err(error) = runtime.restore_enabled_on_startup().await {
                    tracing::warn!(
                        "managed Office plugin startup restore remains not-ready: {error}"
                    );
                }
            });
        }
        // Build the delegation broker over the runtime + DB and start its
        // listener + resolver. Live from startup; ClaudeCode MCP injection (so
        // the agent auto-calls it) lands in a follow-up.
        let delegation = crate::delegation::build_delegation(agent_runtime.clone(), pool);
        Ok(Self {
            app_handle,
            deployment: Arc::new(deployment),
            pty,
            file_tree_watchers: Arc::new(Mutex::new(HashSet::new())),
            conversation_streams: Arc::new(Mutex::new(HashSet::new())),
            desktop_toast_state: Arc::new(Mutex::new(DesktopToastRuntimeState::default())),
            local_usage_cache: Arc::new(Mutex::new(HashMap::new())),
            agent_runtime,
            delegation,
            conversation_turn_locks: Arc::new(Mutex::new(HashMap::new())),
            conversation_runtime_states: Arc::new(Mutex::new(HashMap::new())),
            conversation_row_projectors: Arc::new(Mutex::new(HashMap::new())),
            office_runtime,
            remote_desktop,
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
            }),
            event_publisher: Arc::new(crate::conversation_service::AppConversationEventPublisher {
                app_handle: self.app_handle.clone(),
                deployment: self.deployment.clone(),
                row_projectors: self.conversation_row_projectors.clone(),
            }),
        }
    }
}
