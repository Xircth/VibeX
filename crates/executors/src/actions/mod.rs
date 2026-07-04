use std::{path::Path, sync::Arc};

use async_trait::async_trait;
use enum_dispatch::enum_dispatch;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    actions::script::ScriptRequest,
    approvals::ExecutorApprovalService,
    env::ExecutionEnv,
    executors::{AgentKind, ExecutorError, SpawnedChild},
};
pub mod script;

pub(crate) fn effective_working_dir(
    current_dir: &Path,
    working_dir: Option<&str>,
) -> std::path::PathBuf {
    match working_dir {
        Some(rel_path) => current_dir.join(rel_path),
        None => current_dir.to_path_buf(),
    }
}

#[enum_dispatch]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "type")]
pub enum ExecutorActionType {
    ScriptRequest,
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

    pub fn base_executor(&self) -> Option<AgentKind> {
        match self.typ() {
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
    use std::path::{Path, PathBuf};

    use super::effective_working_dir;

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
}
