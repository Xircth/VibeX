use std::{path::Path, sync::Arc};

use async_trait::async_trait;
use enum_dispatch::enum_dispatch;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    actions::{
        coding_agent_follow_up::CodingAgentFollowUpRequest,
        coding_agent_initial::CodingAgentInitialRequest, review::ReviewRequest,
        script::ScriptRequest,
    },
    approvals::ExecutorApprovalService,
    env::ExecutionEnv,
    executors::{
        BaseCodingAgent, CodingAgent, ExecutorError, SpawnedChild, StandardCodingAgentExecutor,
    },
    profile::{ExecutorConfig, ExecutorConfigs},
};
pub mod coding_agent_follow_up;
pub mod coding_agent_initial;
pub mod review;
pub mod script;

pub use review::RepoReviewContext;

pub(crate) fn effective_working_dir(
    current_dir: &Path,
    working_dir: Option<&str>,
) -> std::path::PathBuf {
    match working_dir {
        Some(rel_path) => current_dir.join(rel_path),
        None => current_dir.to_path_buf(),
    }
}

pub(crate) fn configured_coding_agent(
    executor_config: &ExecutorConfig,
    approvals: Arc<dyn ExecutorApprovalService>,
) -> Result<CodingAgent, ExecutorError> {
    let profile_id = executor_config.profile_id();
    let mut agent = ExecutorConfigs::get_cached()
        .get_coding_agent(&profile_id)
        .ok_or(ExecutorError::UnknownExecutorType(profile_id.to_string()))?;

    if executor_config.has_overrides() {
        agent.apply_overrides(executor_config);
    }
    agent.use_approvals(approvals);

    Ok(agent)
}

#[enum_dispatch]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "type")]
pub enum ExecutorActionType {
    CodingAgentInitialRequest,
    CodingAgentFollowUpRequest,
    ScriptRequest,
    ReviewRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ExecutorAction {
    pub typ: ExecutorActionType,
    pub next_action: Option<Box<ExecutorAction>>,
}

impl ExecutorAction {
    pub fn new(typ: ExecutorActionType, next_action: Option<Box<ExecutorAction>>) -> Self {
        Self { typ, next_action }
    }
    pub fn append_action(mut self, action: ExecutorAction) -> Self {
        if let Some(next) = self.next_action {
            self.next_action = Some(Box::new(next.append_action(action)));
        } else {
            self.next_action = Some(Box::new(action));
        }
        self
    }

    pub fn typ(&self) -> &ExecutorActionType {
        &self.typ
    }

    pub fn next_action(&self) -> Option<&ExecutorAction> {
        self.next_action.as_deref()
    }

    pub fn base_executor(&self) -> Option<BaseCodingAgent> {
        match self.typ() {
            ExecutorActionType::CodingAgentInitialRequest(request) => Some(request.base_executor()),
            ExecutorActionType::CodingAgentFollowUpRequest(request) => {
                Some(request.base_executor())
            }
            ExecutorActionType::ReviewRequest(request) => Some(request.base_executor()),
            ExecutorActionType::ScriptRequest(_) => None,
        }
    }
}

#[async_trait]
#[enum_dispatch(ExecutorActionType)]
pub trait Executable {
    async fn spawn(
        &self,
        current_dir: &Path,
        approvals: Arc<dyn ExecutorApprovalService>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError>;
}

#[async_trait]
impl Executable for ExecutorAction {
    async fn spawn(
        &self,
        current_dir: &Path,
        approvals: Arc<dyn ExecutorApprovalService>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        self.typ.spawn(current_dir, approvals, env).await
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        sync::Arc,
    };

    use super::{configured_coding_agent, effective_working_dir};
    use crate::{
        approvals::NoopExecutorApprovalService,
        executors::{
            BaseCodingAgent, CodingAgent,
            codex::{AskForApproval, ReasoningEffort},
        },
        model_selector::PermissionPolicy,
        profile::ExecutorConfig,
    };

    #[test]
    fn effective_working_dir_uses_current_dir_without_override() {
        assert_eq!(
            effective_working_dir(Path::new("/workspace"), None),
            PathBuf::from("/workspace")
        );
    }

    #[test]
    fn effective_working_dir_resolves_relative_override_below_current_dir() {
        assert_eq!(
            effective_working_dir(Path::new("/workspace"), Some("app")),
            PathBuf::from("/workspace").join("app")
        );
    }

    #[test]
    fn effective_working_dir_preserves_nested_relative_components() {
        assert_eq!(
            effective_working_dir(Path::new("/workspace"), Some("apps/web")),
            PathBuf::from("/workspace").join("apps").join("web")
        );
    }

    #[test]
    fn configured_coding_agent_applies_executor_overrides() {
        let config = ExecutorConfig {
            executor: BaseCodingAgent::Codex,
            variant: None,
            model_id: Some("gpt-test-model".to_string()),
            agent_id: None,
            reasoning_id: Some("high".to_string()),
            permission_policy: Some(PermissionPolicy::Plan),
        };

        let agent = configured_coding_agent(&config, Arc::new(NoopExecutorApprovalService))
            .expect("codex default profile should resolve");

        let CodingAgent::Codex(agent) = agent else {
            panic!("expected codex agent");
        };
        assert_eq!(agent.model.as_deref(), Some("gpt-test-model"));
        assert_eq!(agent.model_reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(agent.ask_for_approval, Some(AskForApproval::OnRequest));
    }

    #[test]
    fn configured_coding_agent_reports_unknown_profile_id() {
        let config = ExecutorConfig {
            executor: BaseCodingAgent::Codex,
            variant: Some("MISSING_VARIANT".to_string()),
            model_id: None,
            agent_id: None,
            reasoning_id: None,
            permission_policy: None,
        };

        let err = configured_coding_agent(&config, Arc::new(NoopExecutorApprovalService))
            .expect_err("missing variant should fail");

        assert!(err.to_string().contains("CODEX:MISSING_VARIANT"));
    }
}
