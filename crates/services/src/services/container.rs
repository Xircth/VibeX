use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Error as AnyhowError, anyhow};
use async_trait::async_trait;
use db::{
    DBService,
    models::{
        coding_agent_turn::{CodingAgentTurn, CreateCodingAgentTurn},
        execution_process::{
            CreateExecutionProcess, ExecutionContext, ExecutionProcess, ExecutionProcessError,
            ExecutionProcessRunReason, ExecutionProcessStatus,
        },
        execution_process_logs::ExecutionProcessLogs,
        execution_process_repo_state::{
            CreateExecutionProcessRepoState, ExecutionProcessRepoState,
        },
        repo::Repo,
        session::{CreateSession, Session, SessionError, SessionStatus},
        task::{Task, TaskStatus},
        workspace::{Workspace, WorkspaceError},
        workspace_repo::WorkspaceRepo,
    },
};
#[cfg(feature = "qa-mode")]
use executors::executors::qa_mock::QaMockExecutor;
#[cfg(not(feature = "qa-mode"))]
use executors::profile::ExecutorConfigs;
use executors::{
    actions::{ExecutorAction, ExecutorActionType},
    executors::{ExecutorError, StandardCodingAgentExecutor},
    logs::utils::ConversationPatch,
    profile::ExecutorProfileId,
};
use futures::{StreamExt, future, stream::BoxStream};
use git::{GitService, GitServiceError};
use json_patch::{Patch, PatchOperation, ReplaceOperation};
use serde_json::{Value, json};
use sqlx::Error as SqlxError;
use thiserror::Error;
use tokio::{sync::RwLock, task::JoinHandle};
use tokio_stream::wrappers::BroadcastStream;
use utils::{
    log_msg::LogMsg,
    msg_store::MsgStore,
    text::{git_branch_id, short_uuid},
};
use uuid::Uuid;

use crate::services::{
    container_actions, container_workflow,
    notification::NotificationService,
    workspace_manager::WorkspaceError as WorkspaceManagerError,
    workspace_paths::{self, WorkspacePathRepo},
    worktree_manager::WorktreeError,
};
pub type ContainerRef = String;

fn build_workspace_branch_name(prefix: &str, workspace_id: &Uuid, task_title: &str) -> String {
    let task_title_id = git_branch_id(task_title);
    let branch_id = if task_title_id.is_empty() {
        short_uuid(workspace_id)
    } else {
        format!("{}-{}", short_uuid(workspace_id), task_title_id)
    };

    if prefix.is_empty() {
        branch_id
    } else {
        format!("{}/{}", prefix, branch_id)
    }
}

fn compact_normalized_log_history(history: &[LogMsg]) -> LogMsg {
    let mut snapshot = json!({ "entries": [] });

    for msg in history {
        let LogMsg::JsonPatch(patch) = msg else {
            continue;
        };

        if let Err(error) = json_patch::patch(&mut snapshot, patch) {
            tracing::warn!("Failed to compact normalized log patch history: {error}");
        }
    }

    let entries = snapshot
        .get("entries")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));

    LogMsg::JsonPatch(Patch(vec![PatchOperation::Replace(ReplaceOperation {
        path: "/entries"
            .try_into()
            .expect("normalized log snapshot path should be valid"),
        value: entries,
    })]))
}

#[cfg(test)]
mod tests {
    use json_patch::{AddOperation, Patch, PatchOperation, ReplaceOperation};
    use serde_json::json;
    use utils::log_msg::LogMsg;
    use uuid::Uuid;

    use super::{build_workspace_branch_name, compact_normalized_log_history};

    #[test]
    fn workspace_branch_name_omits_separator_when_title_slug_is_empty() {
        let workspace_id = Uuid::parse_str("5f3a0000-0000-0000-0000-000000000000").unwrap();

        assert_eq!(
            build_workspace_branch_name("vu", &workspace_id, "新会话"),
            "vu/5f3a"
        );
    }

    #[test]
    fn workspace_branch_name_keeps_title_slug_when_available() {
        let workspace_id = Uuid::parse_str("5f3a0000-0000-0000-0000-000000000000").unwrap();

        assert_eq!(
            build_workspace_branch_name("vu", &workspace_id, "New Session"),
            "vu/5f3a-new-session"
        );
    }

    #[test]
    fn compact_normalized_log_history_replays_latest_entries_snapshot() {
        let history = vec![
            LogMsg::JsonPatch(Patch(vec![PatchOperation::Add(AddOperation {
                path: "/entries/0".try_into().unwrap(),
                value: json!({ "type": "NORMALIZED_ENTRY", "content": "old" }),
            })])),
            LogMsg::JsonPatch(Patch(vec![PatchOperation::Replace(ReplaceOperation {
                path: "/entries/0".try_into().unwrap(),
                value: json!({ "type": "NORMALIZED_ENTRY", "content": "new" }),
            })])),
            LogMsg::JsonPatch(Patch(vec![PatchOperation::Add(AddOperation {
                path: "/entries/1".try_into().unwrap(),
                value: json!({ "type": "NORMALIZED_ENTRY", "content": "next" }),
            })])),
        ];

        let LogMsg::JsonPatch(snapshot) = compact_normalized_log_history(&history) else {
            panic!("expected compacted history to be a json patch");
        };

        assert_eq!(snapshot.0.len(), 1);
        let PatchOperation::Replace(replace) = &snapshot.0[0] else {
            panic!("expected snapshot to replace the entries array");
        };
        assert_eq!(replace.path.to_string(), "/entries");
        assert_eq!(
            replace.value,
            json!([
                { "type": "NORMALIZED_ENTRY", "content": "new" },
                { "type": "NORMALIZED_ENTRY", "content": "next" }
            ])
        );
    }
}

fn workspace_base_dir(workspace: &Workspace, container_ref: &str, repos: &[Repo]) -> PathBuf {
    let container_path = std::path::Path::new(container_ref);
    let repo = match repos {
        [repo] => Some(WorkspacePathRepo {
            name: &repo.name,
            path: &repo.path,
        }),
        _ => None,
    };

    workspace_paths::workspace_base_dir(container_path, workspace.use_worktree, repo)
}

fn normalized_workspace_agent_working_dir(
    workspace: &Workspace,
    container_ref: &str,
    repos: &[Repo],
) -> Option<String> {
    let repo_name = match repos {
        [repo] => Some(repo.name.as_str()),
        _ => None,
    };
    workspace_paths::normalize_agent_working_dir(
        workspace.agent_working_dir.as_deref(),
        workspace.use_worktree,
        std::path::Path::new(container_ref),
        repo_name,
    )
}

#[derive(Debug, Error)]
pub enum ContainerError {
    #[error(transparent)]
    GitServiceError(#[from] GitServiceError),
    #[error(transparent)]
    Sqlx(#[from] SqlxError),
    #[error(transparent)]
    ExecutorError(#[from] ExecutorError),
    #[error(transparent)]
    Worktree(#[from] WorktreeError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error(transparent)]
    WorkspaceManager(#[from] WorkspaceManagerError),
    #[error(transparent)]
    Session(#[from] SessionError),
    #[error(transparent)]
    ExecutionProcess(#[from] ExecutionProcessError),
    #[error("Io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Failed to kill process: {0}")]
    KillFailed(std::io::Error),
    #[error(transparent)]
    Other(#[from] AnyhowError), // Catches any unclassified errors
}

#[async_trait]
pub trait ContainerService {
    fn msg_stores(&self) -> &Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>>;

    fn db(&self) -> &DBService;

    fn git(&self) -> &GitService;

    fn notification_service(&self) -> &NotificationService;

    fn workspace_to_current_dir(&self, workspace: &Workspace, repos: &[Repo]) -> PathBuf;

    async fn available_agent_slash_commands(
        &self,
        executor_profile_id: ExecutorProfileId,
        workspace_id: Option<Uuid>,
        repo_id: Option<Uuid>,
    ) -> Result<Option<BoxStream<'static, Patch>>, ContainerError> {
        let agent_workdir = if let Some(workspace_id) = workspace_id {
            let workspace = Workspace::find_by_id(&self.db().pool, workspace_id)
                .await?
                .ok_or(SqlxError::RowNotFound)?;

            let container_ref = match workspace.container_ref.as_deref() {
                Some(container_ref) if !container_ref.is_empty() => container_ref,
                _ => &self.ensure_container_exists(&workspace).await?,
            };

            if container_ref.is_empty() {
                return Err(ContainerError::Other(anyhow!("Workspace path is empty")));
            }

            let repos =
                WorkspaceRepo::find_repos_for_workspace(&self.db().pool, workspace.id).await?;
            let workspace_path = workspace_base_dir(&workspace, container_ref, &repos);
            match normalized_workspace_agent_working_dir(&workspace, container_ref, &repos) {
                Some(dir) => Some(workspace_path.join(dir)),
                None => Some(workspace_path),
            }
        } else if let Some(repo_id) = repo_id {
            Repo::find_by_id(&self.db().pool, repo_id)
                .await
                .ok()
                .flatten()
                .map(|repo| repo.path)
        } else {
            None
        }
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

        #[cfg(feature = "qa-mode")]
        {
            let _ = executor_profile_id;
            let agent = QaMockExecutor;
            let stream = agent.available_slash_commands(&agent_workdir).await?;
            return Ok(Some(stream));
        }
        #[cfg(not(feature = "qa-mode"))]
        {
            let executor =
                ExecutorConfigs::get_cached().get_coding_agent_or_default(&executor_profile_id);

            let stream = executor.available_slash_commands(&agent_workdir).await?;
            Ok(Some(stream))
        }
    }

    async fn store_db_stream_handle(&self, id: Uuid, handle: JoinHandle<()>);

    async fn take_db_stream_handle(&self, id: &Uuid) -> Option<JoinHandle<()>>;

    async fn create(&self, workspace: &Workspace) -> Result<ContainerRef, ContainerError>;

    async fn kill_all_running_processes(&self) -> Result<(), ContainerError>;

    async fn delete(&self, workspace: &Workspace) -> Result<(), ContainerError>;

    /// Check if a task has any running execution processes
    async fn has_running_processes(&self, task_id: Uuid) -> Result<bool, ContainerError> {
        let workspaces = Workspace::fetch_all(&self.db().pool, Some(task_id)).await?;

        for workspace in workspaces {
            let sessions = Session::find_by_workspace_id(&self.db().pool, workspace.id).await?;
            for session in sessions {
                if let Ok(processes) =
                    ExecutionProcess::find_by_session_id(&self.db().pool, session.id, false).await
                {
                    for process in processes {
                        if process.status == ExecutionProcessStatus::Running {
                            return Ok(true);
                        }
                    }
                }
            }
        }

        Ok(false)
    }

    /// A context is finalized when
    /// - Always when the execution process has failed or been killed
    /// - Never when the run reason is DevServer
    /// - Never when a setup script has no next_action (parallel mode)
    /// - The next action is None (no follow-up actions)
    fn should_finalize(&self, ctx: &ExecutionContext) -> bool {
        let action = ctx.execution_process.executor_action().unwrap();
        container_workflow::should_finalize_execution(
            &ctx.execution_process.status,
            &ctx.execution_process.run_reason,
            action,
        )
    }

    async fn mark_session_and_task_in_review(&self, session_id: Uuid, task_id: Uuid) {
        if let Err(e) =
            Session::update_status(&self.db().pool, session_id, SessionStatus::InReview).await
        {
            tracing::error!("Failed to update session status to InReview: {e}");
        }

        if let Err(e) = Task::update_status(&self.db().pool, task_id, TaskStatus::InReview).await {
            tracing::error!("Failed to update task status to InReview: {e}");
        }
    }

    async fn record_after_head_commits(&self, ctx: &ExecutionContext) {
        let workspace_root = self.workspace_to_current_dir(&ctx.workspace, &ctx.repos);
        let workspace_root_is_git_checkout = workspace_root.join(".git").exists();

        for repo in &ctx.repos {
            let repo_path = workspace_paths::workspace_repo_path(
                &workspace_root,
                ctx.workspace.use_worktree,
                ctx.workspace.agent_working_dir.as_deref(),
                &repo.name,
                workspace_root_is_git_checkout,
            );
            if let Ok(head) = self.git().get_head_info(&repo_path)
                && let Err(err) = ExecutionProcessRepoState::update_after_head_commit(
                    &self.db().pool,
                    ctx.execution_process.id,
                    repo.id,
                    &head.oid,
                )
                .await
            {
                tracing::warn!(
                    "Failed to update after_head_commit for repo {} on process {}: {}",
                    repo.id,
                    ctx.execution_process.id,
                    err
                );
            }
        }
    }

    /// Finalize task execution by updating status to InReview and sending notifications
    async fn finalize_task(&self, ctx: &ExecutionContext) {
        self.mark_session_and_task_in_review(ctx.session.id, ctx.task.id)
            .await;

        // Skip notification if process was intentionally killed by user
        if matches!(ctx.execution_process.status, ExecutionProcessStatus::Killed) {
            return;
        }

        let Some((title, message)) = container_workflow::completion_notification(
            &ctx.execution_process.status,
            &ctx.task.title,
            &ctx.workspace.branch,
            ctx.session.executor.as_deref(),
        ) else {
            tracing::warn!(
                "Tried to notify workspace completion for {} but process is still running!",
                ctx.workspace.id
            );
            return;
        };
        self.notification_service().notify(&title, &message).await;
    }

    /// Cleanup executions marked as running in the db, call at startup
    async fn cleanup_orphan_executions(&self) -> Result<(), ContainerError> {
        let running_processes = ExecutionProcess::find_running(&self.db().pool).await?;
        for process in running_processes {
            tracing::info!(
                "Found orphaned execution process {} for session {}",
                process.id,
                process.session_id
            );
            // Update the execution process status first
            if let Err(e) = ExecutionProcess::update_completion(
                &self.db().pool,
                process.id,
                ExecutionProcessStatus::Failed,
                None, // No exit code for orphaned processes
            )
            .await
            {
                tracing::error!(
                    "Failed to update orphaned execution process {} status: {}",
                    process.id,
                    e
                );
                continue;
            }
            // Capture after-head commit OID per repository
            if let Ok(ctx) = ExecutionProcess::load_context(&self.db().pool, process.id).await {
                self.record_after_head_commits(&ctx).await;
            }
            // Process marked as failed
            tracing::info!("Marked orphaned execution process {} as failed", process.id);
            // Update task status to InReview for coding agent and setup script failures
            if container_workflow::should_mark_session_in_review_after_orphan_cleanup(
                &process.run_reason,
            ) && let Ok(Some(session)) =
                Session::find_by_id(&self.db().pool, process.session_id).await
                && let Ok(Some(workspace)) =
                    Workspace::find_by_id(&self.db().pool, session.workspace_id).await
                && let Ok(Some(task)) = workspace.parent_task(&self.db().pool).await
            {
                self.mark_session_and_task_in_review(session.id, task.id)
                    .await;
            }
        }
        Ok(())
    }

    /// Backfill before_head_commit for legacy execution processes.
    /// Rules:
    /// - If a process has after_head_commit and missing before_head_commit,
    ///   then set before_head_commit to the previous process's after_head_commit.
    /// - If there is no previous process, set before_head_commit to the base branch commit.
    async fn backfill_before_head_commits(&self) -> Result<(), ContainerError> {
        let pool = &self.db().pool;
        let rows = ExecutionProcess::list_missing_before_context(pool).await?;
        for row in rows {
            // Skip if no after commit at all (shouldn't happen due to WHERE)
            // Prefer previous process after-commit if present
            let mut before = row.prev_after_head_commit.clone();

            // Fallback to base branch commit OID
            if before.is_none() {
                let repo_path = std::path::Path::new(row.repo_path.as_deref().unwrap_or_default());
                match self
                    .git()
                    .get_branch_oid(repo_path, row.target_branch.as_str())
                {
                    Ok(oid) => before = Some(oid),
                    Err(e) => {
                        tracing::warn!(
                            "Backfill: Failed to resolve base branch OID for workspace {} (branch {}): {}",
                            row.workspace_id,
                            row.target_branch,
                            e
                        );
                    }
                }
            }

            if let Some(before_oid) = before
                && let Err(e) = ExecutionProcessRepoState::update_before_head_commit(
                    pool,
                    row.id,
                    row.repo_id,
                    &before_oid,
                )
                .await
            {
                tracing::warn!(
                    "Backfill: Failed to update before_head_commit for process {}: {}",
                    row.id,
                    e
                );
            }
        }

        Ok(())
    }

    /// Backfill repo names that were migrated with a sentinel placeholder.
    /// Also backfills dev_script_working_dir and agent_working_dir for single-repo projects.
    async fn backfill_repo_names(&self) -> Result<(), ContainerError> {
        let pool = &self.db().pool;
        let repos = Repo::list_needing_name_fix(pool).await?;

        if repos.is_empty() {
            return Ok(());
        }

        tracing::info!("Backfilling {} repo names", repos.len());

        for repo in repos {
            let name = repo
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&repo.id.to_string())
                .to_string();

            Repo::update_name(pool, repo.id, &name, &name).await?;
        }

        Ok(())
    }

    /// Attempts to run the archive script for a workspace if configured.
    /// Silently returns Ok if no archive script is configured or if conditions aren't met.
    async fn try_run_archive_script(&self, workspace_id: Uuid) -> Result<(), ContainerError> {
        let pool = &self.db().pool;
        let workspace = Workspace::find_by_id(pool, workspace_id)
            .await?
            .ok_or(ContainerError::Other(anyhow!("Workspace not found")))?;
        if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
            .await
            .unwrap_or(true)
        {
            return Ok(());
        }
        if self.ensure_container_exists(&workspace).await.is_err() {
            return Ok(());
        }
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
        let Some(action) = container_actions::archive_actions_for_repos(&repos) else {
            return Ok(());
        };
        let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
            Some(s) => s,
            None => {
                Session::create(
                    pool,
                    &CreateSession {
                        executor: None,
                        task_id: None,
                        name: None,
                        initial_prompt: None,
                        status: Some(SessionStatus::Todo),
                    },
                    Uuid::new_v4(),
                    workspace.id,
                )
                .await?
            }
        };
        self.start_execution(
            &workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::ArchiveScript,
        )
        .await?;

        Ok(())
    }

    /// Archive a workspace: set archived flag, stop running dev servers, and run archive script.
    async fn archive_workspace(&self, workspace_id: Uuid) -> Result<(), ContainerError> {
        let pool = &self.db().pool;

        Workspace::set_archived(pool, workspace_id, true).await?;

        // Stop running dev servers
        if let Ok(dev_servers) =
            ExecutionProcess::find_running_dev_servers_by_workspace(pool, workspace_id).await
        {
            for dev_server in dev_servers {
                if let Err(e) = self
                    .stop_execution(&dev_server, ExecutionProcessStatus::Killed)
                    .await
                {
                    tracing::error!(
                        "Failed to stop dev server {} for workspace {}: {}",
                        dev_server.id,
                        workspace_id,
                        e
                    );
                }
            }
        }

        // Run archive script (silently skips if not configured)
        if let Err(e) = self.try_run_archive_script(workspace_id).await {
            tracing::error!(
                "Failed to run archive script for workspace {}: {}",
                workspace_id,
                e
            );
        }

        Ok(())
    }

    /// Reset a session to a specific process: restore worktrees, stop processes, drop later processes.
    async fn reset_session_to_process(
        &self,
        session_id: Uuid,
        target_process_id: Uuid,
        perform_git_reset: bool,
        force_when_dirty: bool,
    ) -> Result<(), ContainerError> {
        let pool = &self.db().pool;

        let process = ExecutionProcess::find_by_id(pool, target_process_id)
            .await?
            .ok_or_else(|| ContainerError::Other(anyhow!("Process not found")))?;
        if process.session_id != session_id {
            return Err(ContainerError::Other(anyhow!(
                "Process does not belong to this session"
            )));
        }

        let session = Session::find_by_id(pool, session_id)
            .await?
            .ok_or_else(|| ContainerError::Other(anyhow!("Session not found")))?;
        let workspace = Workspace::find_by_id(pool, session.workspace_id)
            .await?
            .ok_or_else(|| ContainerError::Other(anyhow!("Workspace not found")))?;

        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
        let repo_states =
            ExecutionProcessRepoState::find_by_execution_process_id(pool, target_process_id)
                .await?;

        let container_ref = self.ensure_container_exists(&workspace).await?;
        let workspace_dir = std::path::PathBuf::from(container_ref);
        let is_dirty = self
            .is_container_clean(&workspace)
            .await
            .map(|is_clean| !is_clean)
            .unwrap_or(false);

        for repo in &repos {
            let repo_state = repo_states.iter().find(|s| s.repo_id == repo.id);
            let before_head_commit = repo_state.and_then(|s| s.before_head_commit.as_deref());
            let previous_after_head_commit = if before_head_commit.is_none() {
                ExecutionProcess::find_prev_after_head_commit(
                    pool,
                    session_id,
                    target_process_id,
                    repo.id,
                )
                .await?
            } else {
                None
            };
            let target_oid = container_workflow::reset_target_oid(
                before_head_commit,
                previous_after_head_commit.as_deref(),
            );
            let worktree_path = workspace
                .repo_path(repo)
                .unwrap_or_else(|| workspace_dir.clone());
            if let Some(oid) = target_oid {
                self.git().reconcile_worktree_to_commit(
                    &worktree_path,
                    &oid,
                    container_workflow::reset_options(
                        perform_git_reset,
                        force_when_dirty,
                        is_dirty,
                    ),
                );
            }
        }

        self.finish_reset_to_process(&workspace, session_id, target_process_id)
            .await?;

        Ok(())
    }

    async fn finish_reset_to_process(
        &self,
        workspace: &Workspace,
        session_id: Uuid,
        target_process_id: Uuid,
    ) -> Result<(), ContainerError> {
        self.try_stop(workspace, false).await;
        ExecutionProcess::drop_at_and_after(&self.db().pool, session_id, target_process_id).await?;

        Ok(())
    }

    async fn try_stop(&self, workspace: &Workspace, include_dev_server: bool) {
        // stop execution processes for this workspace's sessions
        let sessions = match Session::find_by_workspace_id(&self.db().pool, workspace.id).await {
            Ok(s) => s,
            Err(_) => return,
        };

        for session in sessions {
            self.try_stop_session_processes(workspace.id, session.id, include_dev_server)
                .await;
        }
    }

    async fn try_stop_session_processes(
        &self,
        workspace_id: Uuid,
        session_id: Uuid,
        include_dev_server: bool,
    ) {
        if let Ok(processes) =
            ExecutionProcess::find_by_session_id(&self.db().pool, session_id, false).await
        {
            for process in processes {
                if container_workflow::should_stop_execution(
                    &process.status,
                    &process.run_reason,
                    include_dev_server,
                ) {
                    self.stop_execution(&process, ExecutionProcessStatus::Killed)
                        .await
                        .unwrap_or_else(|e| {
                            tracing::debug!(
                                "Failed to stop execution process {} for workspace {}: {}",
                                process.id,
                                workspace_id,
                                e
                            );
                        });
                }
            }
        }
    }

    async fn create_start_execution_process(
        &self,
        workspace: &Workspace,
        session_id: Uuid,
        executor_action: &ExecutorAction,
        run_reason: &ExecutionProcessRunReason,
    ) -> Result<ExecutionProcess, ContainerError> {
        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db().pool, workspace.id).await?;
        if repositories.is_empty() {
            return Err(ContainerError::Other(anyhow!(
                "Workspace has no repositories configured"
            )));
        }

        let workspace_root = workspace
            .container_ref
            .as_ref()
            .map(PathBuf::from)
            .ok_or_else(|| ContainerError::Other(anyhow!("Container ref not found")))?;

        let mut repo_states = Vec::with_capacity(repositories.len());
        for repo in &repositories {
            let repo_path = workspace
                .repo_path(repo)
                .unwrap_or_else(|| workspace_root.clone());
            let before_head_commit = self.git().get_head_info(&repo_path).ok().map(|h| h.oid);
            repo_states.push(CreateExecutionProcessRepoState {
                repo_id: repo.id,
                before_head_commit,
                after_head_commit: None,
                merge_commit: None,
            });
        }
        let create_execution_process = CreateExecutionProcess {
            session_id,
            executor_action: executor_action.clone(),
            run_reason: run_reason.clone(),
        };

        ExecutionProcess::create(
            &self.db().pool,
            &create_execution_process,
            Uuid::new_v4(),
            &repo_states,
        )
        .await
        .map_err(ContainerError::from)
    }

    async fn finish_failed_start(
        &self,
        execution_process_id: Uuid,
        session_id: Uuid,
        task_id: Option<Uuid>,
        start_error: &ContainerError,
    ) -> Result<(), ContainerError> {
        if let Err(update_error) = ExecutionProcess::update_completion(
            &self.db().pool,
            execution_process_id,
            ExecutionProcessStatus::Failed,
            None,
        )
        .await
        {
            tracing::error!(
                "Failed to mark execution process {} as failed after start error: {}",
                execution_process_id,
                update_error
            );
        }
        Session::update_status(&self.db().pool, session_id, SessionStatus::InReview).await?;
        if let Some(task_id) = task_id {
            Task::update_status(&self.db().pool, task_id, TaskStatus::InReview).await?;
        }

        let log_message = LogMsg::Stderr(format!("Failed to start execution: {start_error}"));
        if let Ok(json_line) = serde_json::to_string(&log_message) {
            let _ = ExecutionProcessLogs::append_log_line(
                &self.db().pool,
                execution_process_id,
                &format!("{json_line}\n"),
            )
            .await;
        }

        if let ContainerError::ExecutorError(ExecutorError::ExecutableNotFound { program }) =
            start_error
        {
            let error_message = container_workflow::missing_executable_start_error_entry(program);
            let patch = ConversationPatch::add_normalized_entry(2, error_message);
            if let Ok(json_line) = serde_json::to_string::<LogMsg>(&LogMsg::JsonPatch(patch)) {
                let _ = ExecutionProcessLogs::append_log_line(
                    &self.db().pool,
                    execution_process_id,
                    &format!("{json_line}\n"),
                )
                .await;
            }
        };

        Ok(())
    }

    async fn create_start_coding_agent_turn(
        &self,
        execution_process_id: Uuid,
        executor_action: &ExecutorAction,
    ) -> Result<(), ContainerError> {
        if let Some(prompt) = container_workflow::coding_agent_turn_prompt(executor_action) {
            let create_coding_agent_turn = CreateCodingAgentTurn {
                execution_process_id,
                prompt: Some(prompt.to_string()),
            };

            CodingAgentTurn::create(&self.db().pool, &create_coding_agent_turn, Uuid::new_v4())
                .await?;
        }

        Ok(())
    }

    async fn start_success_log_streaming(
        &self,
        workspace: &Workspace,
        execution_process_id: Uuid,
        executor_action: &ExecutorAction,
    ) -> Result<(), ContainerError> {
        let repos = WorkspaceRepo::find_repos_for_workspace(&self.db().pool, workspace.id).await?;
        let workspace_root = self.workspace_to_current_dir(workspace, &repos);
        #[cfg_attr(feature = "qa-mode", allow(unused_variables))]
        if let Some(msg_store) = self.get_msg_store_by_id(&execution_process_id).await
            && let Some(normalization_target) =
                container_workflow::log_normalization_target(executor_action, &workspace_root)
        {
            #[cfg(feature = "qa-mode")]
            {
                let executor = QaMockExecutor;
                executor.normalize_logs(msg_store, &normalization_target.working_dir);
            }
            #[cfg(not(feature = "qa-mode"))]
            {
                if let Some(executor) = ExecutorConfigs::get_cached()
                    .get_coding_agent(&normalization_target.executor_profile_id)
                {
                    executor.normalize_logs(msg_store, &normalization_target.working_dir);
                } else {
                    tracing::error!(
                        "Failed to resolve profile '{:?}' for normalization",
                        normalization_target.executor_profile_id
                    );
                }
            }
        }

        let db_stream_handle = self.spawn_stream_raw_logs_to_db(&execution_process_id);
        self.store_db_stream_handle(execution_process_id, db_stream_handle)
            .await;
        Ok(())
    }

    async fn ensure_container_exists(
        &self,
        workspace: &Workspace,
    ) -> Result<ContainerRef, ContainerError>;

    async fn is_container_clean(&self, workspace: &Workspace) -> Result<bool, ContainerError>;

    async fn start_execution_inner(
        &self,
        workspace: &Workspace,
        execution_process: &ExecutionProcess,
        executor_action: &ExecutorAction,
    ) -> Result<(), ContainerError>;

    async fn stop_execution(
        &self,
        execution_process: &ExecutionProcess,
        status: ExecutionProcessStatus,
    ) -> Result<(), ContainerError>;

    async fn try_commit_changes(&self, ctx: &ExecutionContext) -> Result<bool, ContainerError>;

    async fn copy_project_files(
        &self,
        source_dir: &Path,
        target_dir: &Path,
        copy_files: &str,
    ) -> Result<(), ContainerError>;

    /// Stream diff updates as LogMsg for WebSocket endpoints.
    async fn stream_diff(
        &self,
        workspace: &Workspace,
        stats_only: bool,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>>, ContainerError>;

    /// Fetch the MsgStore for a given execution ID, panicking if missing.
    async fn get_msg_store_by_id(&self, uuid: &Uuid) -> Option<Arc<MsgStore>> {
        let map = self.msg_stores().read().await;
        map.get(uuid).cloned()
    }

    async fn git_branch_prefix(&self) -> String;

    async fn git_branch_from_workspace(&self, workspace_id: &Uuid, task_title: &str) -> String {
        let prefix = self.git_branch_prefix().await;
        build_workspace_branch_name(&prefix, workspace_id, task_title)
    }

    async fn stream_raw_logs(
        &self,
        id: &Uuid,
    ) -> Option<futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>>> {
        if let Some(store) = self.get_msg_store_by_id(id).await {
            // First try in-memory store
            return Some(
                store
                    .history_plus_stream()
                    .filter(|msg| {
                        future::ready(matches!(
                            msg,
                            Ok(LogMsg::Stdout(..) | LogMsg::Stderr(..) | LogMsg::Finished)
                        ))
                    })
                    .boxed(),
            );
        } else {
            // Fallback: load from DB and create direct stream
            let log_records =
                match ExecutionProcessLogs::find_by_execution_id(&self.db().pool, *id).await {
                    Ok(records) if !records.is_empty() => records,
                    Ok(_) => return None, // No logs exist
                    Err(e) => {
                        tracing::error!("Failed to fetch logs for execution {}: {}", id, e);
                        return None;
                    }
                };

            let messages = match ExecutionProcessLogs::parse_logs(&log_records) {
                Ok(msgs) => msgs,
                Err(e) => {
                    tracing::error!("Failed to parse logs for execution {}: {}", id, e);
                    return None;
                }
            };

            // Direct stream from parsed messages
            let stream = futures::stream::iter(
                messages
                    .into_iter()
                    .filter(|m| matches!(m, LogMsg::Stdout(_) | LogMsg::Stderr(_)))
                    .chain(std::iter::once(LogMsg::Finished))
                    .map(Ok::<_, std::io::Error>),
            )
            .boxed();

            Some(stream)
        }
    }

    async fn stream_normalized_logs(
        &self,
        id: &Uuid,
    ) -> Option<futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>>> {
        // First try in-memory store (existing behavior)
        if let Some(store) = self.get_msg_store_by_id(id).await {
            let live_rx = store.get_receiver();
            let initial_msg = compact_normalized_log_history(&store.get_history());
            let initial_stream = futures::stream::iter(vec![Ok(initial_msg)]);
            let live_stream = BroadcastStream::new(live_rx).filter_map(|msg| async move {
                match msg {
                    Ok(log_msg @ (LogMsg::JsonPatch(_) | LogMsg::Finished)) => {
                        Some(Ok::<_, std::io::Error>(log_msg))
                    }
                    Ok(_) => None,
                    Err(_) => None,
                }
            });

            Some(
                initial_stream
                    .chain(live_stream)
                    .chain(futures::stream::once(async {
                        Ok::<_, std::io::Error>(LogMsg::Finished)
                    }))
                    .boxed(),
            )
        } else {
            // Fallback: load from DB and normalize
            let log_records =
                match ExecutionProcessLogs::find_by_execution_id(&self.db().pool, *id).await {
                    Ok(records) if !records.is_empty() => records,
                    Ok(_) => return None, // No logs exist
                    Err(e) => {
                        tracing::error!("Failed to fetch logs for execution {}: {}", id, e);
                        return None;
                    }
                };

            let raw_messages = match ExecutionProcessLogs::parse_logs(&log_records) {
                Ok(msgs) => msgs,
                Err(e) => {
                    tracing::error!("Failed to parse logs for execution {}: {}", id, e);
                    return None;
                }
            };

            if raw_messages
                .iter()
                .all(|msg| matches!(msg, LogMsg::JsonPatch(_) | LogMsg::Finished))
            {
                let initial_msg = compact_normalized_log_history(&raw_messages);
                return Some(
                    futures::stream::iter(vec![
                        Ok(initial_msg),
                        Ok::<_, std::io::Error>(LogMsg::Finished),
                    ])
                    .boxed(),
                );
            }

            // Create temporary store and populate
            // Include JsonPatch messages (already normalized) and Stdout/Stderr (need normalization)
            let temp_store = Arc::new(MsgStore::new());
            for msg in raw_messages {
                if matches!(
                    msg,
                    LogMsg::Stdout(_) | LogMsg::Stderr(_) | LogMsg::JsonPatch(_)
                ) {
                    temp_store.push(msg);
                }
            }
            temp_store.push_finished();

            let process = match ExecutionProcess::find_by_id(&self.db().pool, *id).await {
                Ok(Some(process)) => process,
                Ok(None) => {
                    tracing::error!("No execution process found for ID: {}", id);
                    return None;
                }
                Err(e) => {
                    tracing::error!("Failed to fetch execution process {}: {}", id, e);
                    return None;
                }
            };

            // Get the workspace to determine correct directory
            let (workspace, _session) =
                match process.parent_workspace_and_session(&self.db().pool).await {
                    Ok(Some((workspace, session))) => (workspace, session),
                    Ok(None) => {
                        tracing::error!(
                            "No workspace/session found for session ID: {}",
                            process.session_id
                        );
                        return None;
                    }
                    Err(e) => {
                        tracing::error!(
                            "Failed to fetch workspace for session {}: {}",
                            process.session_id,
                            e
                        );
                        return None;
                    }
                };

            if let Err(err) = self.ensure_container_exists(&workspace).await {
                tracing::warn!(
                    "Failed to recreate worktree before log normalization for workspace {}: {}",
                    workspace.id,
                    err
                );
            }

            let repos = WorkspaceRepo::find_repos_for_workspace(&self.db().pool, workspace.id)
                .await
                .unwrap_or_default();
            let current_dir = self.workspace_to_current_dir(&workspace, &repos);

            let executor_action = if let Ok(executor_action) = process.executor_action() {
                executor_action
            } else {
                tracing::error!(
                    "Failed to parse executor action: {:?}",
                    process.executor_action()
                );
                return None;
            };

            let Some(normalization_target) =
                container_workflow::log_normalization_target(executor_action, &current_dir)
            else {
                tracing::debug!(
                    "Executor action doesn't support log normalization: {:?}",
                    process.executor_action()
                );
                return None;
            };

            #[cfg(feature = "qa-mode")]
            {
                let executor = QaMockExecutor;
                executor.normalize_logs(temp_store.clone(), &normalization_target.working_dir);
            }
            #[cfg(not(feature = "qa-mode"))]
            {
                let executor = ExecutorConfigs::get_cached()
                    .get_coding_agent_or_default(&normalization_target.executor_profile_id);
                executor.normalize_logs(temp_store.clone(), &normalization_target.working_dir);
            }

            Some(
                temp_store
                    .history_plus_stream()
                    .filter(|msg| future::ready(matches!(msg, Ok(LogMsg::JsonPatch(..)))))
                    .chain(futures::stream::once(async {
                        Ok::<_, std::io::Error>(LogMsg::Finished)
                    }))
                    .boxed(),
            )
        }
    }

    fn spawn_stream_raw_logs_to_db(&self, execution_id: &Uuid) -> JoinHandle<()> {
        let execution_id = *execution_id;
        let msg_stores = self.msg_stores().clone();
        let db = self.db().clone();

        tokio::spawn(async move {
            // Get the message store for this execution
            let store = {
                let map = msg_stores.read().await;
                map.get(&execution_id).cloned()
            };

            if let Some(store) = store {
                let mut stream = store.history_plus_stream();

                while let Some(Ok(msg)) = stream.next().await {
                    match &msg {
                        LogMsg::Stdout(_) | LogMsg::Stderr(_) => {
                            // Serialize this individual message as a JSONL line
                            match serde_json::to_string(&msg) {
                                Ok(jsonl_line) => {
                                    let jsonl_line_with_newline = format!("{jsonl_line}\n");

                                    // Append this line to the database
                                    if let Err(e) = ExecutionProcessLogs::append_log_line(
                                        &db.pool,
                                        execution_id,
                                        &jsonl_line_with_newline,
                                    )
                                    .await
                                    {
                                        tracing::error!(
                                            "Failed to append log line for execution {}: {}",
                                            execution_id,
                                            e
                                        );
                                    }
                                }
                                Err(e) => {
                                    tracing::error!(
                                        "Failed to serialize log message for execution {}: {}",
                                        execution_id,
                                        e
                                    );
                                }
                            }
                        }
                        LogMsg::SessionId(agent_session_id) => {
                            // Append this line to the database
                            if let Err(e) = CodingAgentTurn::update_agent_session_id(
                                &db.pool,
                                execution_id,
                                agent_session_id,
                            )
                            .await
                            {
                                tracing::error!(
                                    "Failed to update agent_session_id {} for execution process {}: {}",
                                    agent_session_id,
                                    execution_id,
                                    e
                                );
                            }
                        }
                        LogMsg::MessageId(agent_message_id) => {
                            if let Err(e) = CodingAgentTurn::update_agent_message_id(
                                &db.pool,
                                execution_id,
                                agent_message_id,
                            )
                            .await
                            {
                                tracing::error!(
                                    "Failed to update agent_message_id {} for execution process {}: {}",
                                    agent_message_id,
                                    execution_id,
                                    e
                                );
                            }
                        }
                        LogMsg::Finished => {
                            break;
                        }
                        LogMsg::JsonPatch(_) | LogMsg::Ready => continue,
                    }
                }
            }
        })
    }

    async fn start_execution(
        &self,
        workspace: &Workspace,
        session: &Session,
        executor_action: &ExecutorAction,
        run_reason: &ExecutionProcessRunReason,
    ) -> Result<ExecutionProcess, ContainerError> {
        // Update linked task/session status when starting a non-dev execution
        let task = if let Some(task_id) = session.task_id {
            Task::find_by_id(&self.db().pool, task_id).await?
        } else {
            workspace.parent_task(&self.db().pool).await?
        };
        if container_workflow::should_mark_session_in_progress_on_start(run_reason) {
            Session::update_status(&self.db().pool, session.id, SessionStatus::InProgress).await?;
            if let Some(task) = task.as_ref()
                && container_workflow::should_mark_task_in_progress_on_start(
                    run_reason,
                    &task.status,
                )
            {
                Task::update_status(&self.db().pool, task.id, TaskStatus::InProgress).await?;
            }
        }
        let execution_process = self
            .create_start_execution_process(workspace, session.id, executor_action, run_reason)
            .await?;
        if container_workflow::should_unarchive_workspace_on_start(run_reason) {
            Workspace::set_archived(&self.db().pool, workspace.id, false).await?;
        }

        self.create_start_coding_agent_turn(execution_process.id, executor_action)
            .await?;

        if let Err(start_error) = self
            .start_execution_inner(workspace, &execution_process, executor_action)
            .await
        {
            self.finish_failed_start(
                execution_process.id,
                session.id,
                task.as_ref().map(|task| task.id),
                &start_error,
            )
            .await?;
            return Err(start_error);
        }

        self.start_success_log_streaming(workspace, execution_process.id, executor_action)
            .await?;
        Ok(execution_process)
    }

    async fn try_start_next_action(&self, ctx: &ExecutionContext) -> Result<(), ContainerError> {
        let action = ctx.execution_process.executor_action()?;
        let next_action = if let Some(next_action) = action.next_action() {
            next_action
        } else {
            tracing::debug!("No next action configured");
            return Ok(());
        };

        let next_run_reason = container_workflow::next_action_run_reason(action, next_action);

        self.start_execution(&ctx.workspace, &ctx.session, next_action, &next_run_reason)
            .await?;

        tracing::debug!("Started next action: {:?}", next_action);
        Ok(())
    }
}
