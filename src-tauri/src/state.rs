use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use agents::AgentRuntime;
use deployment::Deployment;
use local_deployment::{LocalDeployment, pty::PtyService};
use tokio::sync::Mutex;

use crate::{
    commands::{
        desktop_toast::DesktopToastPayload,
        local_usage::{ProjectUsageProviderStatus, ProjectUsageSessionSummary},
    },
    events::agent_runtime_sink,
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
        Arc<Mutex<HashMap<uuid::Uuid, crate::conversation_service::ConversationRuntimeState>>>,
}

impl AppState {
    pub async fn new() -> Result<Self, deployment::DeploymentError> {
        let deployment = LocalDeployment::new().await?;
        let pty = deployment.pty().clone();
        let pool = deployment.db().pool.clone();
        let agent_runtime = Arc::new(AgentRuntime::new(agent_runtime_sink(pool.clone())));
        // Build the delegation broker over the runtime + DB and start its
        // listener + resolver. Live from startup; ClaudeCode MCP injection (so
        // the agent auto-calls it) lands in a follow-up.
        let delegation = crate::delegation::build_delegation(agent_runtime.clone(), pool);
        Ok(Self {
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
        })
    }
}
