use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{IsolationSpec, WorkspaceTarget};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspacePreparationRequest {
    pub automation_id: Uuid,
    pub run_id: Uuid,
    pub target: WorkspaceTarget,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedWorkspace {
    pub workspace_id: Uuid,
    pub root_folder: String,
    pub branch: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SharedRootState {
    pub clean: bool,
    pub current_branch: String,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum WorkspaceError {
    #[error("workspace adapter failed: {0}")]
    Adapter(String),
    #[error("shared root has uncommitted changes")]
    DirtySharedRoot,
    #[error("shared root is already leased by another automation run")]
    SharedRootBusy,
    #[error("shared root is on {actual}, expected {expected}")]
    WrongBranch { expected: String, actual: String },
}

impl WorkspaceError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Adapter(_) => "automation_workspace_adapter_failed",
            Self::DirtySharedRoot => "automation_shared_root_dirty",
            Self::SharedRootBusy => "automation_shared_root_busy",
            Self::WrongBranch { .. } => "automation_shared_root_wrong_branch",
        }
    }
}

#[async_trait]
pub trait GitWorkspacePort: Clone + Send + Sync + 'static {
    async fn create_worktree(
        &self,
        root_folder: &str,
        base_branch: Option<&str>,
        run_branch: &str,
    ) -> Result<PreparedWorkspace, WorkspaceError>;

    async fn shared_root_state(&self, root_folder: &str)
    -> Result<SharedRootState, WorkspaceError>;
}

#[derive(Clone, Debug)]
pub struct WorkspaceService<G> {
    git: G,
}

impl<G> WorkspaceService<G>
where
    G: GitWorkspacePort,
{
    pub fn new(git: G) -> Self {
        Self { git }
    }

    pub async fn prepare(
        &self,
        request: &WorkspacePreparationRequest,
    ) -> Result<PreparedWorkspace, WorkspaceError> {
        match request.target.isolation {
            IsolationSpec::WorktreePerRun => {
                let branch = format!(
                    "automation/{}/run-{}",
                    request.automation_id, request.run_id
                );
                self.git
                    .create_worktree(
                        &request.target.root_folder,
                        request.target.branch.as_deref(),
                        &branch,
                    )
                    .await
            }
            IsolationSpec::SharedInRoot => {
                let state = self
                    .git
                    .shared_root_state(&request.target.root_folder)
                    .await?;
                if !state.clean {
                    return Err(WorkspaceError::DirtySharedRoot);
                }
                if let Some(expected) = request.target.branch.as_ref()
                    && expected != &state.current_branch
                {
                    return Err(WorkspaceError::WrongBranch {
                        expected: expected.clone(),
                        actual: state.current_branch,
                    });
                }
                Ok(PreparedWorkspace {
                    workspace_id: Uuid::new_v4(),
                    root_folder: request.target.root_folder.clone(),
                    branch: state.current_branch,
                })
            }
        }
    }
}
