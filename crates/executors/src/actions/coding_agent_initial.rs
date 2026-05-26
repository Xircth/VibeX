use std::{path::Path, sync::Arc};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    actions::{Executable, effective_working_dir},
    approvals::ExecutorApprovalService,
    env::ExecutionEnv,
    executors::{BaseCodingAgent, ExecutorError, SpawnedChild, StandardCodingAgentExecutor},
    profile::ExecutorConfig,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct CodingAgentInitialRequest {
    pub prompt: String,
    /// Unified executor identity + overrides
    #[serde(alias = "executor_profile_id", alias = "profile_variant_label")]
    pub executor_config: ExecutorConfig,
    /// Optional relative path to execute the agent in (relative to container_ref).
    /// If None, uses the container_ref directory directly.
    #[serde(default)]
    pub working_dir: Option<String>,
}

impl CodingAgentInitialRequest {
    pub fn base_executor(&self) -> BaseCodingAgent {
        self.executor_config.executor
    }

    pub fn effective_dir(&self, current_dir: &Path) -> std::path::PathBuf {
        effective_working_dir(current_dir, self.working_dir.as_deref())
    }
}

#[async_trait]
impl Executable for CodingAgentInitialRequest {
    #[cfg_attr(feature = "qa-mode", allow(unused_variables))]
    async fn spawn(
        &self,
        current_dir: &Path,
        approvals: Arc<dyn ExecutorApprovalService>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let effective_dir = self.effective_dir(current_dir);

        #[cfg(feature = "qa-mode")]
        {
            tracing::info!("QA mode: using mock executor instead of real agent");
            let executor = crate::executors::qa_mock::QaMockExecutor;
            return executor.spawn(&effective_dir, &self.prompt, env).await;
        }

        #[cfg(not(feature = "qa-mode"))]
        {
            let agent =
                crate::actions::configured_coding_agent(&self.executor_config, approvals.clone())?;
            agent.spawn(&effective_dir, &self.prompt, env).await
        }
    }
}
