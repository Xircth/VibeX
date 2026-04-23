use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use deployment::Deployment;
use local_deployment::LocalDeployment;
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
    pub deployment: Arc<LocalDeployment>,
    pub file_tree_watchers: Arc<Mutex<HashSet<String>>>,
    pub conversation_streams: Arc<Mutex<HashSet<String>>>,
    pub desktop_toast_state: Arc<Mutex<DesktopToastRuntimeState>>,
    pub local_usage_cache: Arc<Mutex<HashMap<String, LocalUsageCacheEntry>>>,
}

impl AppState {
    pub async fn new() -> Result<Self, deployment::DeploymentError> {
        let deployment = LocalDeployment::new().await?;
        Ok(Self {
            deployment: Arc::new(deployment),
            file_tree_watchers: Arc::new(Mutex::new(HashSet::new())),
            conversation_streams: Arc::new(Mutex::new(HashSet::new())),
            desktop_toast_state: Arc::new(Mutex::new(DesktopToastRuntimeState::default())),
            local_usage_cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}
