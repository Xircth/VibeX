//! Worktree-backed child workspaces, shared by workflow `write_isolated`
//! steps and collaboration members' WriteIsolated sessions.

use db::models::{
    task::{CreateTask, Task, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use uuid::Uuid;

use crate::ConversationContext;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IsolatedWorkspaceError {
    #[error("write_isolated requires at least one repository")]
    NoRepositories,
    #[error("{0}")]
    Other(String),
}

impl IsolatedWorkspaceError {
    fn other(message: impl Into<String>) -> Self {
        Self::Other(message.into())
    }
}

/// Create (or reuse) a worktree-backed child workspace of
/// `parent_workspace_id` on `branch`, covering every repo of the parent.
/// Shared by workflow `write_isolated` steps and collaboration members'
/// WriteIsolated sessions. Returns the workspace id and checkpoint evidence.
pub async fn create_isolated_workspace(
    context: &ConversationContext,
    parent_workspace_id: Uuid,
    isolated_workspace_id: Uuid,
    branch: String,
    title: String,
    purpose: &str,
) -> Result<(Uuid, serde_json::Value), IsolatedWorkspaceError> {
    let pool = &context.deployment.db().pool;
    let parent = Workspace::find_by_id(pool, parent_workspace_id)
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?
        .ok_or_else(|| IsolatedWorkspaceError::other("workflow workspace not found"))?;
    let repos = WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, parent.id)
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
    if repos.is_empty() {
        return Err(IsolatedWorkspaceError::NoRepositories);
    }
    let agent_working_dir = match repos.as_slice() {
        [repo] => Some(repo.repo.default_working_dir.as_deref().map_or_else(
            || repo.repo.name.clone(),
            |subdir| {
                std::path::PathBuf::from(&repo.repo.name)
                    .join(subdir)
                    .to_string_lossy()
                    .into_owned()
            },
        )),
        _ => None,
    };
    let workspace = if let Some(existing) = Workspace::find_by_id(pool, isolated_workspace_id)
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?
    {
        existing
    } else {
        let task = Task::create(
            pool,
            &CreateTask {
                project_id: parent.project_id,
                title,
                description: None,
                status: Some(TaskStatus::Todo),
                parent_workspace_id: Some(parent.id),
                image_ids: None,
            },
            Uuid::new_v4(),
        )
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
        let workspace = Workspace::create(
            pool,
            &CreateWorkspace {
                project_id: parent.project_id,
                parent_workspace_id: Some(parent.id),
                branch: branch.clone(),
                container_ref: None,
                use_worktree: true,
                agent_working_dir,
            },
            isolated_workspace_id,
            task.id,
        )
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
        WorkspaceRepo::create_many(
            pool,
            workspace.id,
            &repos
                .iter()
                .map(|repo| CreateWorkspaceRepo {
                    repo_id: repo.repo.id,
                    target_branch: repo.target_branch.clone(),
                })
                .collect::<Vec<_>>(),
        )
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
        workspace
    };

    if let Err(error) = context
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await
    {
        let _ = context.deployment.container().delete(&workspace).await;
        let _ = Workspace::delete(pool, workspace.id).await;
        let _ = Task::delete(pool, workspace.task_id).await;
        return Err(IsolatedWorkspaceError::other(format!(
            "failed to create isolated {purpose} worktree: {error}"
        )));
    }
    let materialized = Workspace::find_by_id(pool, workspace.id)
        .await
        .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?
        .ok_or_else(|| IsolatedWorkspaceError::other("isolated workspace disappeared"))?;
    let mut checkpoints = Vec::new();
    for repo in &repos {
        let path = materialized
            .repo_path(&repo.repo)
            .ok_or_else(|| IsolatedWorkspaceError::other("isolated repo path is unavailable"))?;
        let head = context
            .deployment
            .git()
            .get_head_info(&path)
            .map_err(|error| IsolatedWorkspaceError::other(error.to_string()))?;
        checkpoints.push(serde_json::json!({
            "repoId": repo.repo.id,
            "path": path,
            "targetBranch": repo.target_branch,
            "headCommit": head.oid,
        }));
    }
    Ok((
        workspace.id,
        serde_json::json!({
            "isolated": true,
            "workspaceId": workspace.id,
            "parentWorkspaceId": parent.id,
            "branch": branch,
            "checkpoint": checkpoints,
            "autoMerge": false,
        }),
    ))
}

/// Provisions member-session worktrees through the deployment's git/container.
pub struct DeploymentWorkspaceProvisioner<'a> {
    pub context: &'a ConversationContext,
}

#[async_trait::async_trait]
impl crate::collaboration::IsolatedWorkspaceProvisioner for DeploymentWorkspaceProvisioner<'_> {
    async fn provision(
        &self,
        plan: &crate::collaboration::MemberWritePlan,
        conversation_id: Uuid,
        isolated_workspace_id: Uuid,
    ) -> Result<Option<(Uuid, serde_json::Value)>, String> {
        match create_isolated_workspace(
            self.context,
            plan.workspace_id,
            isolated_workspace_id,
            format!("member/{}/{conversation_id}", plan.member_id),
            format!("Member session {conversation_id}"),
            "member session",
        )
        .await
        {
            Ok(created) => Ok(Some(created)),
            Err(IsolatedWorkspaceError::NoRepositories) => Ok(None),
            Err(IsolatedWorkspaceError::Other(message)) => Err(message),
        }
    }
}

/// Execution workspace for a turn (see `collaboration::execution_workspace_id`).
pub async fn execution_workspace_id(
    context: &ConversationContext,
    conversation_id: Uuid,
    session_workspace_id: Uuid,
) -> Result<Uuid, crate::collaboration::CollaborationError> {
    crate::collaboration::execution_workspace_id(
        &context.deployment.db().pool,
        conversation_id,
        session_workspace_id,
        &DeploymentWorkspaceProvisioner { context },
    )
    .await
}
