use std::sync::Arc;

use deployment::Deployment;
use local_deployment::LocalDeployment;

pub struct AppState {
    pub deployment: Arc<LocalDeployment>,
}

impl AppState {
    pub async fn new() -> Result<Self, deployment::DeploymentError> {
        let deployment = LocalDeployment::new().await?;
        Ok(Self {
            deployment: Arc::new(deployment),
        })
    }
}
