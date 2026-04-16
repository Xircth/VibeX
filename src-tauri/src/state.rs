use std::{collections::HashSet, sync::Arc};

use deployment::Deployment;
use local_deployment::LocalDeployment;
use tokio::sync::Mutex;

pub struct AppState {
    pub deployment: Arc<LocalDeployment>,
    pub file_tree_watchers: Arc<Mutex<HashSet<String>>>,
    pub conversation_streams: Arc<Mutex<HashSet<String>>>,
}

impl AppState {
    pub async fn new() -> Result<Self, deployment::DeploymentError> {
        let deployment = LocalDeployment::new().await?;
        Ok(Self {
            deployment: Arc::new(deployment),
            file_tree_watchers: Arc::new(Mutex::new(HashSet::new())),
            conversation_streams: Arc::new(Mutex::new(HashSet::new())),
        })
    }
}
