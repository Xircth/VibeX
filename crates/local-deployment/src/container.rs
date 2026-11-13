use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::anyhow;
use async_trait::async_trait;
use command_group::AsyncGroupChild;
use db::{
    DBService,
    models::{
        execution_process::{ExecutionContext, ExecutionProcess, ExecutionProcessStatus},
        execution_process_repo_state::ExecutionProcessRepoState,
        repo::Repo,
        task::{Task, TaskStatus},
        workspace::Workspace,
        workspace_repo::WorkspaceRepo,
    },
};
use deployment::DeploymentError;
use executors::{
    actions::ExecutorAction,
    env::{ExecutionEnv, RepoContext},
    executors::{CancellationToken, ExecutorExitSignal, SpawnedChild},
};
use futures::{FutureExt, TryStreamExt, stream::select};
use git::GitService;
use services::services::{
    config::Config,
    container::{ContainerError, ContainerRef, ContainerService},
    diff_stream::{self, DiffStreamHandle},
    image::ImageService,
    notification::NotificationService,
    workspace_manager::WorkspaceManager,
    workspace_paths,
    worktree_settings::run_project_workspace_delete_command,
};
use tokio::{sync::RwLock, task::JoinHandle};
use tokio_util::io::ReaderStream;
use utils::{
    log_msg::LogMsg,
    msg_store::MsgStore,
    text::{git_branch_id, short_uuid},
};
use uuid::Uuid;

use crate::{command, copy, process_completion};

mod destruction;
mod workspace;

#[derive(Clone)]
pub struct LocalContainerService {
    db: DBService,
    child_store: Arc<RwLock<HashMap<Uuid, Arc<RwLock<AsyncGroupChild>>>>>,
    cancellation_tokens: Arc<RwLock<HashMap<Uuid, CancellationToken>>>,
    msg_stores: Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>>,
    /// Tracks background tasks that stream logs to the database.
    /// When stopping execution, we await these to ensure logs are fully persisted.
    db_stream_handles: Arc<RwLock<HashMap<Uuid, JoinHandle<()>>>>,
    exit_monitor_handles: Arc<RwLock<HashMap<Uuid, JoinHandle<()>>>>,
    config: Arc<RwLock<Config>>,
    git: GitService,
    image_service: ImageService,
    notification_service: NotificationService,
    settings_path: PathBuf,
    pty: crate::pty::PtyService,
}

impl LocalContainerService {
    pub fn settings_path(&self) -> &Path {
        &self.settings_path
    }
    fn workspace_with_container_ref(workspace: &Workspace, container_ref: &Path) -> Workspace {
        let mut next = workspace.clone();
        next.container_ref = Some(container_ref.to_string_lossy().to_string());
        next
    }

    fn workspace_repo_path(
        workspace: &Workspace,
        workspace_root: &Path,
        repo_name: &str,
    ) -> PathBuf {
        workspace_paths::workspace_repo_path(
            workspace_root,
            workspace.use_worktree,
            workspace.agent_working_dir.as_deref(),
            repo_name,
            workspace_root.join(".git").exists(),
        )
    }

    fn normalized_workspace_base_dir(workspace: &Workspace, repos: &[Repo]) -> PathBuf {
        let container_path = workspace.container_path().unwrap_or_default();
        let repo = match repos {
            [repo] => Some(workspace_paths::WorkspacePathRepo {
                name: &repo.name,
                path: &repo.path,
            }),
            _ => None,
        };

        workspace_paths::local_runtime_workspace_base_dir(
            &container_path,
            workspace.use_worktree,
            repo,
        )
    }

    fn is_direct_external_worktree(
        workspace: &Workspace,
        workspace_root: &Path,
        repositories: &[Repo],
    ) -> bool {
        if !workspace.use_worktree || WorkspaceManager::is_app_owned_workspace_dir(workspace_root) {
            return false;
        }

        let [repo] = repositories else {
            return false;
        };

        Self::workspace_with_container_ref(workspace, workspace_root)
            .repo_path(repo)
            .is_some_and(|repo_path| repo_path == workspace_root)
    }

    fn discover_workspace_dir_from_existing_worktree(
        &self,
        repositories: &[Repo],
        branch_name: &str,
    ) -> Option<PathBuf> {
        for repo in repositories {
            let worktree_path = match self
                .git()
                .find_worktree_path_for_branch(&repo.path, branch_name)
            {
                Ok(path) => path,
                Err(err) => {
                    tracing::debug!(
                        "Failed to discover worktree for branch '{}' in repo '{}': {}",
                        branch_name,
                        repo.name,
                        err
                    );
                    continue;
                }
            };

            let Some(found_worktree_path) = worktree_path else {
                continue;
            };

            let workspace_root = if found_worktree_path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == repo.name)
            {
                found_worktree_path
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or(found_worktree_path.clone())
            } else {
                found_worktree_path
            };

            if workspace_root.exists() {
                return Some(workspace_root);
            }
        }

        None
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn new(
        db: DBService,
        msg_stores: Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>>,
        config: Arc<RwLock<Config>>,
        git: GitService,
        image_service: ImageService,
        settings_path: PathBuf,
        pty: crate::pty::PtyService,
    ) -> Self {
        let child_store = Arc::new(RwLock::new(HashMap::new()));
        let cancellation_tokens = Arc::new(RwLock::new(HashMap::new()));
        let db_stream_handles = Arc::new(RwLock::new(HashMap::new()));
        let exit_monitor_handles = Arc::new(RwLock::new(HashMap::new()));
        let notification_service = NotificationService::new(config.clone());

        let container = LocalContainerService {
            db,
            child_store,
            cancellation_tokens,
            msg_stores,
            db_stream_handles,
            exit_monitor_handles,
            config,
            git,
            image_service,
            notification_service,
            settings_path,
            pty,
        };

        if let Err(error) = container.cleanup_orphan_executions().await {
            tracing::error!("Failed to clean up orphaned execution processes: {error}");
        }

        container.spawn_workspace_cleanup();

        container
    }

    pub async fn get_child_from_store(&self, id: &Uuid) -> Option<Arc<RwLock<AsyncGroupChild>>> {
        let map = self.child_store.read().await;
        map.get(id).cloned()
    }

    pub async fn add_child_to_store(&self, id: Uuid, exec: AsyncGroupChild) {
        let mut map = self.child_store.write().await;
        map.insert(id, Arc::new(RwLock::new(exec)));
    }

    pub async fn remove_child_from_store(&self, id: &Uuid) {
        let mut map = self.child_store.write().await;
        map.remove(id);
    }

    async fn add_cancellation_token(&self, id: Uuid, token: CancellationToken) {
        let mut map = self.cancellation_tokens.write().await;
        map.insert(id, token);
    }

    async fn take_cancellation_token(&self, id: &Uuid) -> Option<CancellationToken> {
        let mut map = self.cancellation_tokens.write().await;
        map.remove(id)
    }

    async fn add_db_stream_handle(&self, id: Uuid, handle: JoinHandle<()>) {
        let mut map = self.db_stream_handles.write().await;
        map.insert(id, handle);
    }

    async fn take_db_stream_handle(&self, id: &Uuid) -> Option<JoinHandle<()>> {
        let mut map = self.db_stream_handles.write().await;
        map.remove(id)
    }

    async fn add_exit_monitor_handle(&self, id: Uuid, handle: JoinHandle<()>) {
        let mut map = self.exit_monitor_handles.write().await;
        map.insert(id, handle);
    }

    async fn take_exit_monitor_handle(&self, id: &Uuid) -> Option<JoinHandle<()>> {
        let mut map = self.exit_monitor_handles.write().await;
        map.remove(id)
    }

    async fn finish_msg_store_and_db_stream(&self, execution_id: &Uuid) {
        let db_stream_handle = self.take_db_stream_handle(execution_id).await;
        if let Some(msg) = self.msg_stores.write().await.remove(execution_id) {
            msg.push_finished();
        }
        if let Some(handle) = db_stream_handle {
            let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
        }
    }

    async fn mark_task_in_review_after_stop_if_needed(&self, execution_id: Uuid) {
        if let Ok(ctx) = ExecutionProcess::load_context(&self.db.pool, execution_id).await
            && process_completion::should_mark_task_in_review_after_stop(
                &ctx.execution_process.run_reason,
            )
            && let Err(e) =
                Task::update_status(&self.db.pool, ctx.task.id, TaskStatus::InReview).await
        {
            tracing::error!("Failed to update task status to InReview: {e}");
        }
    }

    async fn finish_stopped_execution(&self, execution_id: &Uuid) {
        self.finish_msg_store_and_db_stream(execution_id).await;
        self.mark_task_in_review_after_stop_if_needed(*execution_id)
            .await;
        self.update_after_head_commits(*execution_id).await;
    }

    fn canonicalize_for_safety(path: &Path) -> PathBuf {
        if let Ok(path) = std::fs::canonicalize(path) {
            return path;
        }

        let mut missing_segments = Vec::new();
        let mut cursor = path;
        while !cursor.exists() {
            let Some(name) = cursor.file_name() else {
                break;
            };
            missing_segments.push(name.to_os_string());
            let Some(parent) = cursor.parent() else {
                break;
            };
            cursor = parent;
        }

        let mut resolved = std::fs::canonicalize(cursor).unwrap_or_else(|_| cursor.to_path_buf());
        for segment in missing_segments.iter().rev() {
            resolved.push(segment);
        }
        resolved
    }

    fn path_overlaps_repo(path: &Path, repo: &Repo) -> bool {
        let path = Self::canonicalize_for_safety(path);
        let repo_path = Self::canonicalize_for_safety(&repo.path);
        path == repo_path || path.starts_with(&repo_path) || repo_path.starts_with(&path)
    }

    fn is_registered_direct_worktree(
        &self,
        workspace: &Workspace,
        repositories: &[Repo],
        candidate_path: &Path,
    ) -> bool {
        let [repo] = repositories else {
            return false;
        };

        self.git
            .is_worktree_path_for_branch(&repo.path, &workspace.branch, candidate_path)
            .unwrap_or(false)
    }

    async fn repair_workspace_storage_mode(
        &self,
        workspace: &mut Workspace,
        repositories: &[Repo],
    ) -> Result<(), ContainerError> {
        if !workspace.use_worktree {
            return Ok(());
        }

        let Some(container_ref) = workspace.container_ref.clone() else {
            return Ok(());
        };
        let container_path = PathBuf::from(&container_ref);
        if self.is_registered_direct_worktree(workspace, repositories, &container_path) {
            return Ok(());
        }
        let Some(overlapping_repo) = repositories
            .iter()
            .find(|repo| Self::path_overlaps_repo(&container_path, repo))
        else {
            return Ok(());
        };

        tracing::error!(
            "Workspace {} has unsafe worktree container_ref {} overlapping repo {}; repairing before use",
            workspace.id,
            container_path.display(),
            overlapping_repo.path.display()
        );

        let current_branch = self.git.get_current_branch(&overlapping_repo.path).ok();
        if current_branch
            .as_deref()
            .is_some_and(|branch| branch.eq_ignore_ascii_case(&workspace.branch))
        {
            Workspace::update_storage_mode(
                &self.db.pool,
                workspace.id,
                false,
                Some(overlapping_repo.path.to_string_lossy().as_ref()),
                overlapping_repo.default_working_dir.as_deref(),
            )
            .await?;
            workspace.use_worktree = false;
            workspace.container_ref = Some(overlapping_repo.path.to_string_lossy().to_string());
            workspace.agent_working_dir = overlapping_repo.default_working_dir.clone();
            return Ok(());
        }

        Workspace::clear_container_ref(&self.db.pool, workspace.id).await?;
        workspace.container_ref = None;
        Ok(())
    }

    pub async fn cleanup_workspace(
        db: &DBService,
        workspace: &Workspace,
        settings_path: &Path,
    ) -> Result<(), services::services::worktree_settings::WorktreeSettingsError> {
        let Some(container_ref) = &workspace.container_ref else {
            return Ok(());
        };
        let workspace_dir = PathBuf::from(container_ref);

        if !workspace.use_worktree {
            Workspace::clear_container_ref(&db.pool, workspace.id).await?;
            return Ok(());
        }

        let repositories = WorkspaceRepo::find_repos_for_workspace(&db.pool, workspace.id).await?;
        if workspace_dir.exists() {
            run_project_workspace_delete_command(
                settings_path,
                workspace.project_id,
                workspace.id,
                &workspace_dir,
                &repositories,
            )
            .await?;
        }

        if repositories.is_empty() {
            if !WorkspaceManager::is_app_owned_workspace_dir(&workspace_dir) {
                return Err(
                    services::services::workspace_manager::WorkspaceError::UnsafeWorkspacePath(
                        workspace_dir,
                    )
                    .into(),
                );
            }
            if workspace_dir.exists() {
                tokio::fs::remove_dir_all(&workspace_dir).await?;
            }
        } else {
            WorkspaceManager::cleanup_workspace(&workspace_dir, &repositories).await?;
        }
        Workspace::clear_container_ref(&db.pool, workspace.id).await?;
        Ok(())
    }

    pub async fn cleanup_expired_workspaces(
        db: &DBService,
        settings_path: &Path,
        pty: &crate::pty::PtyService,
    ) -> Result<(), DeploymentError> {
        if std::env::var("DISABLE_WORKTREE_CLEANUP").is_ok() {
            tracing::info!(
                "Expired workspace cleanup is disabled via DISABLE_WORKTREE_CLEANUP environment variable"
            );
            return Ok(());
        }

        let expired_workspaces = Workspace::find_expired_for_cleanup(&db.pool).await?;
        if expired_workspaces.is_empty() {
            tracing::debug!("No expired workspaces found");
            return Ok(());
        }
        tracing::info!(
            "Found {} expired workspaces to clean up",
            expired_workspaces.len()
        );
        for workspace in &expired_workspaces {
            let operation =
                services::services::workspace_lifecycle::workspace_operation(workspace.id);
            let _permit = operation.write().await;
            let status = services::services::workspace_lifecycle::initialization_status(workspace)
                .await
                .map_err(|e| DeploymentError::Other(anyhow!(e)))?;
            if matches!(status.phase.as_str(), "running" | "preparing" | "failed") {
                continue;
            }
            if Self::workspace_is_busy(db, pty, workspace)
                .await
                .map_err(|e| DeploymentError::Other(anyhow!(e)))?
            {
                continue;
            }
            if let Err(error) = Self::cleanup_workspace(db, workspace, settings_path).await {
                tracing::warn!(
                    workspace_id = %workspace.id,
                    %error,
                    "Expired worktree cleanup cancelled"
                );
            }
        }
        Ok(())
    }

    pub fn spawn_workspace_cleanup(&self) {
        let db = self.db.clone();
        let settings_path = self.settings_path.clone();
        let pty = self.pty.clone();
        tokio::spawn(async move {
            WorkspaceManager::cleanup_orphan_workspaces(&db.pool).await;

            let mut cleanup_interval =
                tokio::time::interval(tokio::time::Duration::from_secs(1800)); // 30 minutes
            // Burst (the default) replays every tick missed during sleep and
            // showed up as a dozen cleanup logs in one millisecond after resume.
            cleanup_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                cleanup_interval.tick().await;
                tracing::info!("Starting periodic workspace cleanup...");
                Self::cleanup_expired_workspaces(&db, &settings_path, &pty)
                    .await
                    .unwrap_or_else(|e| {
                        tracing::error!("Failed to clean up expired workspaces: {}", e)
                    });
            }
        });
    }

    /// Record the current HEAD commit for each repository as the "after" state.
    /// Errors are silently ignored since this runs after the main execution completes
    /// and failure should not block process finalization.
    async fn update_after_head_commits(&self, exec_id: Uuid) {
        if let Ok(ctx) = ExecutionProcess::load_context(&self.db.pool, exec_id).await {
            self.record_after_head_commits(&ctx).await;
        }
    }

    /// Get the commit message based on the execution run reason.
    async fn get_commit_message(&self, ctx: &ExecutionContext) -> String {
        process_completion::commit_message_for_execution(
            &ctx.execution_process.run_reason,
            None,
            ctx.execution_process.id,
            ctx.workspace.id,
        )
    }

    /// Check which repos have uncommitted changes. Fails if any repo is inaccessible.
    fn check_repos_for_changes(
        &self,
        workspace: &Workspace,
        workspace_root: &Path,
        repos: &[Repo],
    ) -> Result<Vec<(Repo, PathBuf)>, ContainerError> {
        let git = GitService::new();
        let mut repos_with_changes = Vec::new();

        for repo in repos {
            let worktree_path = Self::workspace_repo_path(workspace, workspace_root, &repo.name);

            match git.get_worktree_status(&worktree_path) {
                Ok(ws) if !ws.entries.is_empty() => {
                    repos_with_changes.push((repo.clone(), worktree_path));
                }
                Ok(_) => {
                    tracing::debug!("No changes in repo '{}'", repo.name);
                }
                Err(e) => {
                    return Err(ContainerError::Other(anyhow!(
                        "Pre-flight check failed for repo '{}': {}",
                        repo.name,
                        e
                    )));
                }
            }
        }

        Ok(repos_with_changes)
    }

    async fn has_commits_from_execution(
        &self,
        ctx: &ExecutionContext,
    ) -> Result<bool, ContainerError> {
        let workspace_root = self.workspace_to_current_dir(&ctx.workspace, &ctx.repos);

        let repo_states = ExecutionProcessRepoState::find_by_execution_process_id(
            &self.db.pool,
            ctx.execution_process.id,
        )
        .await?;

        for repo in &ctx.repos {
            let repo_path = Self::workspace_repo_path(&ctx.workspace, &workspace_root, &repo.name);
            let current_head = self.git().get_head_info(&repo_path).ok().map(|h| h.oid);

            let before_head = repo_states
                .iter()
                .find(|s| s.repo_id == repo.id)
                .and_then(|s| s.before_head_commit.clone());

            if current_head != before_head {
                return Ok(true);
            }
        }

        Ok(false)
    }

    /// Commit changes to each repo. Logs failures but continues with other repos.
    fn commit_repos(&self, repos_with_changes: Vec<(Repo, PathBuf)>, message: &str) -> bool {
        let mut any_committed = false;

        for (repo, worktree_path) in repos_with_changes {
            tracing::debug!(
                "Committing changes for repo '{}' at {:?}",
                repo.name,
                &worktree_path
            );

            match self.git().commit(&worktree_path, message) {
                Ok(true) => {
                    any_committed = true;
                    tracing::info!("Committed changes in repo '{}'", repo.name);
                }
                Ok(false) => {
                    tracing::warn!("No changes committed in repo '{}' (unexpected)", repo.name);
                }
                Err(e) => {
                    tracing::warn!("Failed to commit in repo '{}': {}", repo.name, e);
                }
            }
        }

        any_committed
    }

    /// Spawn a background task that polls the child process for completion and
    /// cleans up the execution entry when it exits.
    pub fn spawn_exit_monitor(
        &self,
        exec_id: &Uuid,
        exit_signal: Option<ExecutorExitSignal>,
    ) -> JoinHandle<()> {
        let exec_id = *exec_id;
        let child_store = self.child_store.clone();
        let msg_stores = self.msg_stores.clone();
        let db = self.db.clone();
        let container = self.clone();

        let mut process_exit_rx = self.spawn_os_exit_watcher(exec_id);

        tokio::spawn(async move {
            let mut exit_signal_future = exit_signal
                .map(|rx| rx.boxed()) // wait for result
                .unwrap_or_else(|| std::future::pending().boxed()); // no signal, stall forever

            let status_result: std::io::Result<std::process::ExitStatus>;

            // Wait for process to exit, or exit signal from executor
            tokio::select! {
                // Exit signal with result.
                // Some coding agent processes do not automatically exit after processing the user request; instead the executor
                // signals when processing has finished to gracefully kill the process.
                exit_result = &mut exit_signal_future => {
                    // Executor signaled completion: kill group and use the provided result
                    if let Some(child_lock) = child_store.read().await.get(&exec_id).cloned() {
                        let mut child = child_lock.write().await ;
                        if let Err(err) = command::kill_process_group(&mut child).await {
                            tracing::error!("Failed to kill process group after exit signal: {} {}", exec_id, err);
                        }
                    }

                    status_result = Ok(process_completion::executor_signal_exit_status(
                        exit_result.ok(),
                    ));
                }
                // Process exit
                exit_status_result = &mut process_exit_rx => {
                    status_result = exit_status_result.unwrap_or_else(|e| Err(std::io::Error::other(e)));
                }
            }

            let (exit_code, status) = process_completion::execution_result_from_exit(status_result);

            if !ExecutionProcess::was_stopped(&db.pool, exec_id).await
                && let Err(e) =
                    ExecutionProcess::update_completion(&db.pool, exec_id, status, exit_code).await
            {
                tracing::error!("Failed to update execution process completion: {}", e);
            }

            if let Ok(ctx) = ExecutionProcess::load_context(&db.pool, exec_id).await {
                if process_completion::should_commit_and_consider_next(
                    &ctx.execution_process.status,
                    &ctx.execution_process.run_reason,
                    exit_code,
                ) {
                    // Commit changes (if any) and get feedback about whether changes were made
                    let changes_committed = match container.try_commit_changes(&ctx).await {
                        Ok(committed) => committed,
                        Err(e) => {
                            tracing::error!("Failed to commit changes after execution: {}", e);
                            // Treat commit failures as if changes were made to be safe
                            true
                        }
                    };

                    let has_commits_from_execution =
                        if process_completion::should_inspect_commits_from_execution(
                            &ctx.execution_process.run_reason,
                        ) {
                            container
                                .has_commits_from_execution(&ctx)
                                .await
                                .unwrap_or(false)
                        } else {
                            false
                        };
                    let should_start_next = process_completion::should_start_next_after_commit(
                        &ctx.execution_process.run_reason,
                        changes_committed,
                        has_commits_from_execution,
                    );

                    if should_start_next {
                        // If the process exited successfully, start the next action
                        if let Err(e) = container.try_start_next_action(&ctx).await {
                            tracing::error!("Failed to start next action after completion: {}", e);
                        }
                    } else {
                        tracing::info!(
                            "Skipping cleanup script for workspace {} - no changes made by coding agent",
                            ctx.workspace.id
                        );

                        // Manually finalize task since we're bypassing normal execution flow
                        container.finalize_task(&ctx).await;
                    }
                }

                if container.should_finalize(&ctx) {
                    container.finalize_task(&ctx).await;
                }
            }

            // Now that commit/next-action/finalization steps for this process are complete,
            // capture the HEAD OID as the definitive "after" state (best-effort).
            container.update_after_head_commits(exec_id).await;

            // Wait for DB persistence to complete before cleaning up MsgStore
            let db_stream_handle = container.take_db_stream_handle(&exec_id).await;
            if let Some(msg_arc) = msg_stores.write().await.remove(&exec_id) {
                msg_arc.push_finished();
            }
            if let Some(handle) = db_stream_handle {
                let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
            }

            // Cleanup child handle
            child_store.write().await.remove(&exec_id);
        })
    }

    pub fn spawn_os_exit_watcher(
        &self,
        exec_id: Uuid,
    ) -> tokio::sync::oneshot::Receiver<std::io::Result<std::process::ExitStatus>> {
        let (tx, rx) = tokio::sync::oneshot::channel::<std::io::Result<std::process::ExitStatus>>();
        let child_store = self.child_store.clone();
        tokio::spawn(async move {
            loop {
                let child_lock = {
                    let map = child_store.read().await;
                    map.get(&exec_id).cloned()
                };
                if let Some(child_lock) = child_lock {
                    let mut child_handler = child_lock.write().await;
                    match child_handler.try_wait() {
                        Ok(Some(status)) => {
                            let _ = tx.send(Ok(status));
                            break;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            let _ = tx.send(Err(e));
                            break;
                        }
                    }
                } else {
                    let _ = tx.send(Err(io::Error::other(format!(
                        "Child handle missing for {exec_id}"
                    ))));
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });
        rx
    }

    pub fn dir_name_from_workspace(workspace_id: &Uuid, task_title: &str) -> String {
        let task_title_id = git_branch_id(task_title);
        format!("{}-{}", short_uuid(workspace_id), task_title_id)
    }

    async fn track_child_msgs_in_store(&self, id: Uuid, child: &mut AsyncGroupChild) {
        let store = Arc::new(MsgStore::new());

        let out = child.inner().stdout.take().expect("no stdout");
        let err = child.inner().stderr.take().expect("no stderr");

        // Map stdout bytes -> LogMsg::Stdout
        let out = ReaderStream::new(out)
            .map_ok(|chunk| LogMsg::Stdout(String::from_utf8_lossy(&chunk).into_owned()));

        // Map stderr bytes -> LogMsg::Stderr
        let err = ReaderStream::new(err)
            .map_ok(|chunk| LogMsg::Stderr(String::from_utf8_lossy(&chunk).into_owned()));

        // If you have a JSON Patch source, map it to LogMsg::JsonPatch too, then select all three.

        // Merge and forward into the store
        let merged = select(out, err); // Stream<Item = Result<LogMsg, io::Error>>
        store.clone().spawn_forwarder(merged);

        let mut map = self.msg_stores().write().await;
        map.insert(id, store);
    }

    /// Create a live diff log stream for ongoing attempts for WebSocket
    /// Returns a stream that owns the filesystem watcher - when dropped, watcher is cleaned up
    async fn create_live_diff_stream(
        &self,
        args: diff_stream::DiffStreamArgs,
    ) -> Result<DiffStreamHandle, ContainerError> {
        diff_stream::create(args)
            .await
            .map_err(|e| ContainerError::Other(anyhow!("{e}")))
    }

    /// Copy project files and images to the workspace.
    /// Skips files/images that already exist (fast no-op if all exist).
    async fn copy_files_and_images(
        &self,
        workspace_dir: &Path,
        workspace: &Workspace,
    ) -> Result<(), ContainerError> {
        let repos = WorkspaceRepo::find_repos_with_copy_files(&self.db.pool, workspace.id).await?;

        let mut errors = Vec::new();
        for repo in &repos {
            if let Some(copy_files) = &repo.copy_files
                && !copy_files.trim().is_empty()
            {
                let worktree_path = Self::workspace_repo_path(workspace, workspace_dir, &repo.name);
                if let Err(error) = self
                    .copy_project_files(&repo.path, &worktree_path, copy_files)
                    .await
                {
                    errors.push(format!("{}: {error}", repo.name));
                }
            }
        }
        if let Err(error) = self
            .image_service
            .copy_images_by_task_to_worktree(
                workspace_dir,
                workspace.task_id,
                workspace.agent_working_dir.as_deref(),
            )
            .await
        {
            errors.push(format!("Task images: {error}"));
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(ContainerError::Other(anyhow!(errors.join("; "))))
        }
    }

    /// Create workspace-level CLAUDE.md and AGENTS.md files that import from each repo.
    /// Uses the @import syntax to reference each repo's config files.
    /// Skips creating files if they already exist or if no repos have the source file.
    async fn create_workspace_config_files(
        workspace_dir: &Path,
        repos: &[Repo],
        use_worktree: bool,
    ) -> Result<(), ContainerError> {
        if !use_worktree {
            return Ok(());
        }
        const CONFIG_FILES: [&str; 2] = ["CLAUDE.md", "AGENTS.md"];

        for config_file in CONFIG_FILES {
            let workspace_config_path = workspace_dir.join(config_file);

            if workspace_config_path.exists() {
                tracing::trace!(
                    "Workspace config file {} already exists, skipping",
                    config_file
                );
                continue;
            }

            let mut import_lines = Vec::new();
            for repo in repos {
                let repo_config_path = workspace_dir.join(&repo.name).join(config_file);
                if repo_config_path.exists() {
                    import_lines.push(format!("@{}/{}", repo.name, config_file));
                }
            }

            if import_lines.is_empty() {
                tracing::trace!(
                    "No repos have {}, skipping workspace config creation",
                    config_file
                );
                continue;
            }

            let content = import_lines.join("\n") + "\n";
            if let Err(e) = tokio::fs::write(&workspace_config_path, &content).await {
                tracing::warn!(
                    "Failed to create workspace config file {}: {}",
                    config_file,
                    e
                );
                continue;
            }

            tracing::info!(
                "Created workspace {} with {} import(s)",
                config_file,
                import_lines.len()
            );
        }

        Ok(())
    }

    async fn build_execution_env(
        &self,
        workspace: &Workspace,
        execution_process: &ExecutionProcess,
        current_dir: PathBuf,
        repos: &[Repo],
    ) -> Result<ExecutionEnv, ContainerError> {
        let repo_names: Vec<String> = repos.iter().map(|r| r.name.clone()).collect();
        let repo_context = RepoContext::new(current_dir, repo_names);

        let mut env = ExecutionEnv::new(repo_context);

        let task = workspace
            .parent_task(&self.db.pool)
            .await?
            .ok_or(ContainerError::Other(anyhow!(
                "Task not found for workspace"
            )))?;
        let project = task
            .parent_project(&self.db.pool)
            .await?
            .ok_or(ContainerError::Other(anyhow!("Project not found for task")))?;

        env.insert("VK_PROJECT_NAME", &project.name);
        env.insert("VK_PROJECT_ID", project.id.to_string());
        env.insert("VK_TASK_ID", task.id.to_string());
        env.insert("VK_WORKSPACE_ID", workspace.id.to_string());
        env.insert("VK_WORKSPACE_BRANCH", &workspace.branch);
        env.insert("VK_SESSION_ID", execution_process.session_id.to_string());

        Ok(env)
    }

    async fn register_spawned_execution(&self, execution_id: Uuid, spawned: SpawnedChild) {
        let SpawnedChild {
            mut child,
            exit_signal,
            cancel,
        } = spawned;

        self.track_child_msgs_in_store(execution_id, &mut child)
            .await;
        self.add_child_to_store(execution_id, child).await;

        if let Some(cancel) = cancel {
            self.add_cancellation_token(execution_id, cancel).await;
        }

        let monitor_handle = self.spawn_exit_monitor(&execution_id, exit_signal);
        self.add_exit_monitor_handle(execution_id, monitor_handle)
            .await;
    }
}

#[async_trait]
impl ContainerService for LocalContainerService {
    fn msg_stores(&self) -> &Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>> {
        &self.msg_stores
    }

    fn db(&self) -> &DBService {
        &self.db
    }

    fn git(&self) -> &GitService {
        &self.git
    }

    fn notification_service(&self) -> &NotificationService {
        &self.notification_service
    }

    async fn store_db_stream_handle(&self, id: Uuid, handle: JoinHandle<()>) {
        self.add_db_stream_handle(id, handle).await;
    }

    async fn take_db_stream_handle(&self, id: &Uuid) -> Option<JoinHandle<()>> {
        LocalContainerService::take_db_stream_handle(self, id).await
    }

    async fn git_branch_prefix(&self) -> String {
        self.config.read().await.git_branch_prefix.clone()
    }

    fn workspace_to_current_dir(&self, workspace: &Workspace, repos: &[Repo]) -> PathBuf {
        Self::normalized_workspace_base_dir(workspace, repos)
    }

    async fn create(&self, workspace: &Workspace) -> Result<ContainerRef, ContainerError> {
        self.prepare_workspace(workspace, false, true).await
    }

    async fn provision(
        &self,
        workspace: &Workspace,
        include_uncommitted: bool,
    ) -> Result<ContainerRef, ContainerError> {
        self.prepare_workspace(workspace, include_uncommitted, false)
            .await
    }

    async fn delete(&self, workspace: &Workspace) -> Result<(), ContainerError> {
        self.destroy_workspace(workspace, None).await
    }

    async fn remove(
        &self,
        workspace: &Workspace,
        delete_branches: bool,
    ) -> Result<(), ContainerError> {
        self.destroy_workspace(workspace, Some(delete_branches))
            .await
    }

    async fn ensure_container_exists(
        &self,
        workspace: &Workspace,
    ) -> Result<ContainerRef, ContainerError> {
        self.prepare_workspace(workspace, false, false).await
    }

    async fn is_container_clean(&self, workspace: &Workspace) -> Result<bool, ContainerError> {
        let Some(container_ref) = &workspace.container_ref else {
            return Ok(true);
        };
        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;
        let workspace_dir = Self::normalized_workspace_base_dir(workspace, &repositories);
        if workspace_dir.as_os_str().is_empty() {
            return Ok(true);
        }
        if !workspace_dir.exists() && !PathBuf::from(container_ref).exists() {
            return Ok(true);
        }

        for repo in &repositories {
            let worktree_path = Self::workspace_repo_path(workspace, &workspace_dir, &repo.name);
            if worktree_path.exists() && !self.git().is_worktree_clean(&worktree_path)? {
                return Ok(false);
            }
        }

        Ok(true)
    }

    async fn start_execution_inner(
        &self,
        workspace: &Workspace,
        execution_process: &ExecutionProcess,
        executor_action: &ExecutorAction,
    ) -> Result<(), ContainerError> {
        let _container_ref = workspace
            .container_ref
            .as_ref()
            .ok_or(ContainerError::Other(anyhow!(
                "Container ref not found for workspace"
            )))?;
        let repos = WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;
        let current_dir = Self::normalized_workspace_base_dir(workspace, &repos);

        let env = self
            .build_execution_env(workspace, execution_process, current_dir.clone(), &repos)
            .await?;

        // Create the child and stream, add to execution tracker with timeout
        let spawned = tokio::time::timeout(
            Duration::from_secs(30),
            executor_action.spawn(&current_dir, &env),
        )
        .await
        .map_err(|_| {
            ContainerError::Other(anyhow!(
                "Timeout: process took more than 30 seconds to start"
            ))
        })??;

        self.register_spawned_execution(execution_process.id, spawned)
            .await;

        Ok(())
    }

    async fn stop_execution(
        &self,
        execution_process: &ExecutionProcess,
        status: ExecutionProcessStatus,
    ) -> Result<(), ContainerError> {
        let completion_status = status.clone();
        let exit_code = process_completion::stop_exit_code_for_status(&status);

        ExecutionProcess::update_completion(
            &self.db.pool,
            execution_process.id,
            completion_status,
            exit_code,
        )
        .await?;

        let child = self.get_child_from_store(&execution_process.id).await;

        if child.is_none() {
            tracing::warn!(
                "Execution process {} has no in-memory child handle; marking it as {:?}",
                execution_process.id,
                status
            );

            let _ = self.take_cancellation_token(&execution_process.id).await;
            let _ = self.take_exit_monitor_handle(&execution_process.id).await;
            self.finish_stopped_execution(&execution_process.id).await;

            return Ok(());
        }

        let child = child.expect("checked is_some above");

        // Try graceful cancellation first, then force kill
        if let Some(cancel) = self.take_cancellation_token(&execution_process.id).await {
            cancel.cancel();

            // Wait for exit monitor to finish gracefully
            if let Some(monitor_handle) = self.take_exit_monitor_handle(&execution_process.id).await
            {
                match tokio::time::timeout(Duration::from_secs(5), monitor_handle).await {
                    Ok(_) => {
                        tracing::debug!("Process {} exited gracefully", execution_process.id);
                    }
                    Err(_) => {
                        tracing::debug!(
                            "Graceful shutdown timed out for process {}, force killing",
                            execution_process.id
                        );
                    }
                }
            }
        }

        {
            let mut child_guard = child.write().await;
            if let Err(e) = command::kill_process_group(&mut child_guard).await {
                tracing::error!(
                    "Failed to stop execution process {}: {}",
                    execution_process.id,
                    e
                );
                return Err(e);
            }
        }
        self.remove_child_from_store(&execution_process.id).await;

        self.finish_stopped_execution(&execution_process.id).await;

        tracing::debug!(
            "Execution process {} stopped successfully",
            execution_process.id
        );

        Ok(())
    }

    async fn stream_diff(
        &self,
        workspace: &Workspace,
        stats_only: bool,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>>, ContainerError>
    {
        let workspace_repos =
            WorkspaceRepo::find_by_workspace_id(&self.db.pool, workspace.id).await?;
        let target_branches: HashMap<_, _> = workspace_repos
            .iter()
            .map(|wr| (wr.repo_id, wr.target_branch.clone()))
            .collect();

        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;

        let mut streams = Vec::new();

        let container_ref = self.ensure_container_exists(workspace).await?;
        let mut resolved_workspace = workspace.clone();
        resolved_workspace.container_ref = Some(container_ref);
        let workspace_root =
            Self::normalized_workspace_base_dir(&resolved_workspace, &repositories);

        for repo in repositories {
            let worktree_path =
                Self::workspace_repo_path(&resolved_workspace, &workspace_root, &repo.name);
            let branch = &workspace.branch;

            let Some(target_branch) = target_branches.get(&repo.id) else {
                tracing::warn!(
                    "Skipping diff stream for repo {}: no target branch configured",
                    repo.name
                );
                continue;
            };

            let base_commit = match self
                .git()
                .get_base_commit(&repo.path, branch, target_branch)
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(
                        "Skipping diff stream for repo {}: failed to get base commit: {}",
                        repo.name,
                        e
                    );
                    continue;
                }
            };

            let stream = self
                .create_live_diff_stream(diff_stream::DiffStreamArgs {
                    git_service: self.git().clone(),
                    db: self.db().clone(),
                    workspace_id: workspace.id,
                    repo_id: repo.id,
                    repo_path: repo.path.clone(),
                    worktree_path: worktree_path.clone(),
                    branch: branch.to_string(),
                    target_branch: target_branch.clone(),
                    base_commit: base_commit.clone(),
                    stats_only,
                    path_prefix: Some(repo.name.clone()),
                })
                .await?;

            streams.push(Box::pin(stream));
        }

        if streams.is_empty() {
            return Ok(Box::pin(futures::stream::empty()));
        }

        // Merge all streams into one
        Ok(Box::pin(futures::stream::select_all(streams)))
    }

    async fn try_commit_changes(&self, ctx: &ExecutionContext) -> Result<bool, ContainerError> {
        if !process_completion::should_try_commit_changes(&ctx.execution_process.run_reason) {
            return Ok(false);
        }

        let message = self.get_commit_message(ctx).await;

        let workspace_root = Self::normalized_workspace_base_dir(&ctx.workspace, &ctx.repos);

        let repos_with_changes =
            self.check_repos_for_changes(&ctx.workspace, &workspace_root, &ctx.repos)?;
        if repos_with_changes.is_empty() {
            tracing::debug!("No changes to commit in any repository");
            return Ok(false);
        }

        Ok(self.commit_repos(repos_with_changes, &message))
    }

    /// Copy files from the original project directory to the worktree.
    /// Skips files that already exist at target with same size.
    async fn copy_project_files(
        &self,
        source_dir: &Path,
        target_dir: &Path,
        copy_files: &str,
    ) -> Result<(), ContainerError> {
        let source_dir = source_dir.to_path_buf();
        let target_dir = target_dir.to_path_buf();
        let copy_files = copy_files.to_string();

        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            tokio::task::spawn_blocking(move || {
                copy::copy_project_files_impl(&source_dir, &target_dir, &copy_files)
            }),
        )
        .await
        .map_err(|_| ContainerError::Other(anyhow!("Copy project files timed out after 30s")))?
        .map_err(|e| ContainerError::Other(anyhow!("Copy files task failed: {e}")))?
    }

    async fn kill_all_running_processes(&self) -> Result<(), ContainerError> {
        tracing::info!("Killing all running processes");
        let running_processes = ExecutionProcess::find_running(&self.db.pool).await?;

        tracing::info!(
            "Found {} running processes to kill",
            running_processes.len()
        );

        for process in running_processes {
            tracing::info!(
                "Killing process: id={}, run_reason={:?}",
                process.id,
                process.run_reason
            );
            if let Err(error) = self
                .stop_execution(&process, ExecutionProcessStatus::Killed)
                .await
            {
                tracing::error!(
                    "Failed to cleanly kill running execution process {:?}: {:?}",
                    process,
                    error
                );
            } else {
                tracing::info!("Successfully killed process: id={}", process.id);
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests;
