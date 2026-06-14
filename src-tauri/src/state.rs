use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use agents::AgentRuntime;
use deployment::Deployment;
use local_deployment::LocalDeployment;
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
    pub deployment: Arc<LocalDeployment>,
    pub file_tree_watchers: Arc<Mutex<HashSet<String>>>,
    pub conversation_streams: Arc<Mutex<HashSet<String>>>,
    pub desktop_toast_state: Arc<Mutex<DesktopToastRuntimeState>>,
    pub local_usage_cache: Arc<Mutex<HashMap<String, LocalUsageCacheEntry>>>,
    pub agent_runtime: Arc<AgentRuntime>,
    pub delegation: crate::delegation::DelegationState,
}

impl AppState {
    pub async fn new() -> Result<Self, deployment::DeploymentError> {
        let deployment = LocalDeployment::new().await?;
        let pool = deployment.db().pool.clone();
        let agent_runtime = Arc::new(AgentRuntime::new(agent_runtime_sink(pool.clone())));
        // Build the delegation broker over the runtime + DB and start its
        // listener + resolver. Live from startup; ClaudeCode MCP injection (so
        // the agent auto-calls it) lands in a follow-up.
        let delegation = crate::delegation::build_delegation(agent_runtime.clone(), pool);
        Ok(Self {
            deployment: Arc::new(deployment),
            file_tree_watchers: Arc::new(Mutex::new(HashSet::new())),
            conversation_streams: Arc::new(Mutex::new(HashSet::new())),
            desktop_toast_state: Arc::new(Mutex::new(DesktopToastRuntimeState::default())),
            local_usage_cache: Arc::new(Mutex::new(HashMap::new())),
            agent_runtime,
            delegation,
        })
    }
}
