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
        execution_process::{
            ExecutionContext, ExecutionProcess, ExecutionProcessStatus,
        },
        execution_process_repo_state::ExecutionProcessRepoState,
        repo::Repo,
        task::{Task, TaskStatus},
        workspace::Workspace,
        workspace_repo::WorkspaceRepo,
    },
};
use deployment::DeploymentError;
use executors::{
    actions::{Executable, ExecutorAction},
    approvals::{ExecutorApprovalService, NoopExecutorApprovalService},
    env::{ExecutionEnv, RepoContext},
    executors::{CancellationToken, ExecutorExitSignal, SpawnedChild},
};
use futures::{FutureExt, TryStreamExt, stream::select};
use git::GitService;
use services::services::{
    approvals::{Approvals, executor_approvals::ExecutorApprovalBridge},
    config::{Config, DEFAULT_COMMIT_REMINDER_PROMPT},
    container::{ContainerError, ContainerRef, ContainerService},
    diff_stream::{self, DiffStreamHandle},
    image::ImageService,
    notification::NotificationService,
    workspace_manager::{RepoWorkspaceInput, WorkspaceManager},
    workspace_paths,
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
    approvals: Approvals,
    notification_service: NotificationService,
}

impl LocalContainerService {
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
        approvals: Approvals,
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
            approvals,
            notification_service,
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

    pub async fn cleanup_workspace(db: &DBService, workspace: &Workspace) {
        let Some(container_ref) = &workspace.container_ref else {
            return;
        };
        let workspace_dir = PathBuf::from(container_ref);

        if !workspace.use_worktree {
            let _ = Workspace::clear_container_ref(&db.pool, workspace.id).await;
            return;
        }

        let repositories = WorkspaceRepo::find_repos_for_workspace(&db.pool, workspace.id)
            .await
            .unwrap_or_default();

        if repositories.is_empty() {
            tracing::warn!(
                "No repositories found for workspace {}, cleaning up workspace directory only",
                workspace.id
            );
            if !WorkspaceManager::is_app_owned_workspace_dir(&workspace_dir) {
                tracing::warn!(
                    "Refusing to remove workspace directory outside VibeX-owned storage: {}",
                    workspace_dir.display()
                );
            } else if workspace_dir.exists()
                && let Err(e) = tokio::fs::remove_dir_all(&workspace_dir).await
            {
                tracing::warn!("Failed to remove workspace directory: {}", e);
            }
        } else {
            WorkspaceManager::cleanup_workspace(&workspace_dir, &repositories)
                .await
                .unwrap_or_else(|e| {
                    tracing::warn!(
                        "Failed to clean up workspace for workspace {}: {}",
                        workspace.id,
                        e
                    );
                });
        }

        // Clear container_ref so this workspace won't be picked up again
        let _ = Workspace::clear_container_ref(&db.pool, workspace.id).await;
    }

    pub async fn cleanup_expired_workspaces(db: &DBService) -> Result<(), DeploymentError> {
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
            Self::cleanup_workspace(db, workspace).await;
        }
        Ok(())
    }

    pub fn spawn_workspace_cleanup(&self) {
        let db = self.db.clone();
        let cleanup_expired = Self::cleanup_expired_workspaces;
        tokio::spawn(async move {
            WorkspaceManager::cleanup_orphan_workspaces(&db.pool).await;

            let mut cleanup_interval =
                tokio::time::interval(tokio::time::Duration::from_secs(1800)); // 30 minutes
            loop {
                cleanup_interval.tick().await;
                tracing::info!("Starting periodic workspace cleanup...");
                cleanup_expired(&db).await.unwrap_or_else(|e| {
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

        for repo in &repos {
            if let Some(copy_files) = &repo.copy_files
                && !copy_files.trim().is_empty()
            {
                let worktree_path = Self::workspace_repo_path(workspace, workspace_dir, &repo.name);
                self.copy_project_files(&repo.path, &worktree_path, copy_files)
                    .await
                    .unwrap_or_else(|e| {
                        tracing::warn!(
                            "Failed to copy project files for repo '{}': {}",
                            repo.name,
                            e
                        );
                    });
            }
        }

        if let Err(e) = self
            .image_service
            .copy_images_by_task_to_worktree(
                workspace_dir,
                workspace.task_id,
                workspace.agent_working_dir.as_deref(),
            )
            .await
        {
            tracing::warn!("Failed to copy task images to workspace: {}", e);
        }

        Ok(())
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

        let config = self.config.read().await;
        let commit_reminder_enabled = config.commit_reminder_enabled;
        let commit_reminder_prompt = config
            .commit_reminder_prompt
            .clone()
            .unwrap_or_else(|| DEFAULT_COMMIT_REMINDER_PROMPT.to_string());
        drop(config);
        let mut env = ExecutionEnv::new(
            repo_context,
            commit_reminder_enabled,
            commit_reminder_prompt,
        );

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

    fn create_executor_approval_service(
        &self,
        executor_action: &ExecutorAction,
        execution_id: Uuid,
    ) -> Arc<dyn ExecutorApprovalService> {
        if process_completion::should_create_executor_approval_bridge(
            executor_action.base_executor(),
        ) {
            return ExecutorApprovalBridge::new(
                self.approvals.clone(),
                self.db.clone(),
                self.notification_service.clone(),
                execution_id,
            );
        }

        Arc::new(NoopExecutorApprovalService {})
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
        let workspace_repos =
            WorkspaceRepo::find_by_workspace_id(&self.db.pool, workspace.id).await?;
        if workspace_repos.is_empty() {
            return Err(ContainerError::Other(anyhow!(
                "Workspace has no repositories configured"
            )));
        }

        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;

        if !workspace.use_worktree {
            let repo = repositories.first().ok_or_else(|| {
                ContainerError::Other(anyhow!(
                    "Opening without a worktree requires one repository"
                ))
            })?;
            let container_ref = workspace
                .container_ref
                .clone()
                .unwrap_or_else(|| repo.path.to_string_lossy().to_string());
            if workspace.container_ref.is_none() {
                Workspace::update_container_ref(&self.db.pool, workspace.id, &container_ref)
                    .await?;
            }
            self.copy_files_and_images(Path::new(&container_ref), workspace)
                .await?;
            return Ok(container_ref);
        }

        let task = workspace
            .parent_task(&self.db.pool)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;

        let workspace_dir_name =
            LocalContainerService::dir_name_from_workspace(&workspace.id, &task.title);
        let workspace_dir = WorkspaceManager::get_workspace_base_dir().join(&workspace_dir_name);

        let target_branches: HashMap<_, _> = workspace_repos
            .iter()
            .map(|wr| (wr.repo_id, wr.target_branch.clone()))
            .collect();

        let workspace_inputs: Vec<RepoWorkspaceInput> = repositories
            .iter()
            .map(|repo| {
                let target_branch = target_branches.get(&repo.id).cloned().unwrap_or_default();
                RepoWorkspaceInput::new(repo.clone(), target_branch)
            })
            .collect();

        let created_workspace = WorkspaceManager::create_workspace(
            &workspace_dir,
            &workspace_inputs,
            &workspace.branch,
        )
        .await?;

        // Copy project files and images to workspace
        self.copy_files_and_images(&created_workspace.workspace_dir, workspace)
            .await?;

        Self::create_workspace_config_files(
            &created_workspace.workspace_dir,
            &repositories,
            workspace.use_worktree,
        )
        .await?;

        Workspace::update_container_ref(
            &self.db.pool,
            workspace.id,
            &created_workspace.workspace_dir.to_string_lossy(),
        )
        .await?;

        Ok(created_workspace
            .workspace_dir
            .to_string_lossy()
            .to_string())
    }

    async fn delete(&self, workspace: &Workspace) -> Result<(), ContainerError> {
        self.try_stop(workspace, true).await;
        Self::cleanup_workspace(&self.db, workspace).await;
        Ok(())
    }

    async fn ensure_container_exists(
        &self,
        workspace: &Workspace,
    ) -> Result<ContainerRef, ContainerError> {
        Workspace::touch(&self.db.pool, workspace.id).await?;
        let workspace_repos =
            WorkspaceRepo::find_by_workspace_id(&self.db.pool, workspace.id).await?;
        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;

        if repositories.is_empty() {
            return Err(ContainerError::Other(anyhow!(
                "Workspace has no repositories configured"
            )));
        }

        let mut workspace = workspace.clone();
        self.repair_workspace_storage_mode(&mut workspace, &repositories)
            .await?;

        if !workspace.use_worktree {
            let repo = repositories.first().ok_or_else(|| {
                ContainerError::Other(anyhow!(
                    "Opening without a worktree requires one repository"
                ))
            })?;
            let workspace_dir = workspace
                .container_ref
                .as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| repo.path.clone());
            if !workspace_dir.exists() {
                return Err(ContainerError::Other(anyhow!(
                    "Repository path does not exist: {}",
                    workspace_dir.display()
                )));
            }
            if workspace.container_ref.is_none() {
                Workspace::update_container_ref(
                    &self.db.pool,
                    workspace.id,
                    &workspace_dir.to_string_lossy(),
                )
                .await?;
            }

            self.copy_files_and_images(&workspace_dir, &workspace)
                .await?;
            return Ok(workspace_dir.to_string_lossy().to_string());
        }

        let workspace_dir = if let Some(container_ref) = &workspace.container_ref {
            PathBuf::from(container_ref)
        } else if let Some(discovered_workspace_dir) =
            self.discover_workspace_dir_from_existing_worktree(&repositories, &workspace.branch)
        {
            discovered_workspace_dir
        } else {
            let task = workspace
                .parent_task(&self.db.pool)
                .await?
                .ok_or(sqlx::Error::RowNotFound)?;
            let workspace_dir_name =
                LocalContainerService::dir_name_from_workspace(&workspace.id, &task.title);
            WorkspaceManager::get_workspace_base_dir().join(&workspace_dir_name)
        };

        if Self::is_direct_external_worktree(&workspace, &workspace_dir, &repositories) {
            if !workspace_dir.exists() {
                return Err(ContainerError::Other(anyhow!(
                    "External worktree path does not exist: {}",
                    workspace_dir.display()
                )));
            }

            let workspace_dir_ref = workspace_dir.to_string_lossy().to_string();
            if workspace.container_ref.as_deref() != Some(workspace_dir_ref.as_str()) {
                Workspace::update_container_ref(&self.db.pool, workspace.id, &workspace_dir_ref)
                    .await?;
            }

            self.copy_files_and_images(&workspace_dir, &workspace)
                .await?;
            return Ok(workspace_dir.to_string_lossy().to_string());
        }

        let target_branches: HashMap<_, _> = workspace_repos
            .iter()
            .map(|wr| (wr.repo_id, wr.target_branch.clone()))
            .collect();

        let workspace_inputs: Vec<RepoWorkspaceInput> = repositories
            .iter()
            .map(|repo| {
                let target_branch = target_branches.get(&repo.id).cloned().unwrap_or_default();
                RepoWorkspaceInput::new(repo.clone(), target_branch)
            })
            .collect();

        WorkspaceManager::ensure_workspace_exists(
            &workspace_dir,
            &workspace_inputs,
            &workspace.branch,
        )
        .await?;

        if workspace.container_ref.is_none() {
            Workspace::update_container_ref(
                &self.db.pool,
                workspace.id,
                &workspace_dir.to_string_lossy(),
            )
            .await?;
        }

        // Copy project files and images (fast no-op if already exist)
        self.copy_files_and_images(&workspace_dir, &workspace)
            .await?;

        Self::create_workspace_config_files(&workspace_dir, &repositories, workspace.use_worktree)
            .await?;

        Ok(workspace_dir.to_string_lossy().to_string())
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

        let approvals_service =
            self.create_executor_approval_service(executor_action, execution_process.id);

        let env = self
            .build_execution_env(workspace, execution_process, current_dir.clone(), &repos)
            .await?;

        // Create the child and stream, add to execution tracker with timeout
        let spawned = tokio::time::timeout(
            Duration::from_secs(30),
            executor_action.spawn(&current_dir, approvals_service, &env),
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

        let _container_ref = self.ensure_container_exists(workspace).await?;
        let workspace_root = Self::normalized_workspace_base_dir(workspace, &repositories);

        for repo in repositories {
            let worktree_path = Self::workspace_repo_path(workspace, &workspace_root, &repo.name);
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
mod tests {
    use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};

    use db::{
        DBService,
        models::{
            execution_process::{ExecutionProcess, ExecutionProcessStatus},
            execution_process_logs::ExecutionProcessLogs,
            execution_process_repo_state::{
                CreateExecutionProcessRepoState, ExecutionProcessRepoState,
            },
            repo::Repo,
            workspace::Workspace,
        },
    };
    use executors::{
        actions::{
            ExecutorAction, ExecutorActionType,
            script::{ScriptContext, ScriptRequest, ScriptRequestLanguage},
        },
    };
    use git::GitService;
    use services::services::{
        approvals::Approvals, config::Config, image::ImageService,
        notification::NotificationService, workspace_manager::WorkspaceManager,
        worktree_manager::WorktreeManager,
    };
    use sqlx::{SqlitePool, types::chrono::Utc};
    use tempfile::TempDir;
    use tokio::sync::RwLock;
    use utils::msg_store::MsgStore;
    use uuid::Uuid;

    use super::{ContainerService, LocalContainerService};

    fn sample_workspace(
        container_ref: Option<&str>,
        use_worktree: bool,
        agent_working_dir: Option<&str>,
    ) -> Workspace {
        Workspace {
            id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            task_id: Uuid::new_v4(),
            parent_workspace_id: None,
            container_ref: container_ref.map(ToOwned::to_owned),
            branch: "feature/worktree".to_string(),
            use_worktree,
            agent_working_dir: agent_working_dir.map(ToOwned::to_owned),
            setup_completed_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            archived: false,
            pinned: false,
            name: None,
        }
    }

    fn sample_repo(name: &str, path: &str) -> Repo {
        Repo {
            id: Uuid::new_v4(),
            path: PathBuf::from(path),
            name: name.to_string(),
            display_name: name.to_string(),
            setup_script: None,
            cleanup_script: None,
            archive_script: None,
            copy_files: None,
            parallel_setup_script: false,
            dev_server_script: None,
            default_target_branch: None,
            default_working_dir: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn temp_external_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("vibex-external-{name}-{}", Uuid::new_v4()))
    }

    fn long_running_script() -> &'static str {
        #[cfg(windows)]
        {
            "ping -n 6 127.0.0.1 > nul"
        }
        #[cfg(not(windows))]
        {
            "sleep 5"
        }
    }

    fn env_probe_script() -> String {
        #[cfg(windows)]
        {
            format!(
                "echo PROJECT=%VK_PROJECT_NAME% & echo WORKSPACE=%VK_WORKSPACE_ID% & echo SESSION=%VK_SESSION_ID% & {}",
                long_running_script()
            )
        }
        #[cfg(not(windows))]
        {
            format!(
                "printf 'PROJECT=%s\\nWORKSPACE=%s\\nSESSION=%s\\n' \"$VK_PROJECT_NAME\" \"$VK_WORKSPACE_ID\" \"$VK_SESSION_ID\"; {}",
                long_running_script()
            )
        }
    }

    async fn wait_for_stdout(
        container: &LocalContainerService,
        process_id: Uuid,
        expected: &[String],
    ) -> String {
        for _ in 0..40 {
            if let Some(store) = container.msg_stores.read().await.get(&process_id).cloned() {
                let stdout = store
                    .get_history()
                    .into_iter()
                    .filter_map(|msg| match msg {
                        utils::log_msg::LogMsg::Stdout(text) => Some(text),
                        _ => None,
                    })
                    .collect::<String>();
                if expected.iter().all(|value| stdout.contains(value)) {
                    return stdout;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        container
            .msg_stores
            .read()
            .await
            .get(&process_id)
            .map(|store| {
                store
                    .get_history()
                    .into_iter()
                    .filter_map(|msg| match msg {
                        utils::log_msg::LogMsg::Stdout(text) => Some(text),
                        _ => None,
                    })
                    .collect::<String>()
            })
            .unwrap_or_default()
    }

    async fn execution_process_test_pool() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::query(
            r#"
            CREATE TABLE execution_processes (
                id BLOB PRIMARY KEY NOT NULL,
                session_id BLOB NOT NULL,
                run_reason TEXT NOT NULL,
                executor_action TEXT NOT NULL,
                status TEXT NOT NULL,
                exit_code INTEGER,
                dropped INTEGER NOT NULL DEFAULT 0,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn workspace_path_test_pool() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        for statement in [
            r#"
            CREATE TABLE workspaces (
                id BLOB PRIMARY KEY NOT NULL,
                project_id BLOB NOT NULL,
                task_id BLOB NOT NULL,
                parent_workspace_id BLOB,
                container_ref TEXT,
                branch TEXT NOT NULL,
                use_worktree INTEGER NOT NULL,
                agent_working_dir TEXT,
                setup_completed_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                archived INTEGER NOT NULL DEFAULT 0,
                pinned INTEGER NOT NULL DEFAULT 0,
                name TEXT
            )
            "#,
            r#"
            CREATE TABLE repos (
                id BLOB PRIMARY KEY NOT NULL,
                path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                display_name TEXT NOT NULL,
                setup_script TEXT,
                cleanup_script TEXT,
                archive_script TEXT,
                copy_files TEXT,
                parallel_setup_script INTEGER NOT NULL DEFAULT 0,
                dev_server_script TEXT,
                default_target_branch TEXT,
                default_working_dir TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
            )
            "#,
            r#"
            CREATE TABLE workspace_repos (
                id BLOB PRIMARY KEY NOT NULL,
                workspace_id BLOB NOT NULL,
                repo_id BLOB NOT NULL,
                target_branch TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
            )
            "#,
            r#"
            CREATE TABLE images (
                id BLOB PRIMARY KEY NOT NULL,
                file_path TEXT NOT NULL,
                original_name TEXT NOT NULL,
                mime_type TEXT,
                size_bytes INTEGER NOT NULL,
                hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
            )
            "#,
            r#"
            CREATE TABLE task_images (
                id BLOB PRIMARY KEY NOT NULL,
                task_id BLOB NOT NULL,
                image_id BLOB NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
            )
            "#,
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        pool
    }

    async fn stop_execution_test_pool() -> SqlitePool {
        let pool = workspace_path_test_pool().await;
        for statement in [
            r#"
            CREATE TABLE projects (
                id BLOB PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                default_agent_working_dir TEXT,
                default_main_branch TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
            )
            "#,
            r#"
            CREATE TABLE tasks (
                id BLOB PRIMARY KEY NOT NULL,
                project_id BLOB NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                status TEXT NOT NULL DEFAULT 'todo',
                parent_workspace_id BLOB,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
            )
            "#,
            r#"
            CREATE TABLE sessions (
                id BLOB PRIMARY KEY NOT NULL,
                workspace_id BLOB NOT NULL,
                task_id BLOB,
                name TEXT,
                initial_prompt TEXT,
                status TEXT NOT NULL DEFAULT 'todo',
                executor TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
            )
            "#,
            r#"
            CREATE TABLE execution_processes (
                id BLOB PRIMARY KEY NOT NULL,
                session_id BLOB NOT NULL,
                run_reason TEXT NOT NULL,
                executor_action TEXT NOT NULL,
                status TEXT NOT NULL,
                exit_code INTEGER,
                dropped INTEGER NOT NULL DEFAULT 0,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            "#,
            r#"
            CREATE TABLE execution_process_repo_states (
                id BLOB PRIMARY KEY NOT NULL,
                execution_process_id BLOB NOT NULL,
                repo_id BLOB NOT NULL,
                before_head_commit TEXT,
                after_head_commit TEXT,
                merge_commit TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
            )
            "#,
            r#"
            CREATE TABLE coding_agent_turns (
                id BLOB PRIMARY KEY NOT NULL,
                execution_process_id BLOB NOT NULL,
                agent_session_id TEXT,
                agent_message_id TEXT,
                prompt TEXT,
                summary TEXT,
                seen INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
            )
            "#,
            r#"
            CREATE TABLE execution_process_logs (
                execution_id BLOB NOT NULL,
                logs TEXT NOT NULL,
                byte_size INTEGER NOT NULL,
                inserted_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
            )
            "#,
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        pool
    }

    fn test_container(pool: SqlitePool) -> LocalContainerService {
        let msg_stores = Arc::new(RwLock::new(HashMap::<Uuid, Arc<MsgStore>>::new()));
        let config = Arc::new(RwLock::new(Config::default()));
        LocalContainerService {
            db: DBService { pool: pool.clone() },
            child_store: Arc::new(RwLock::new(HashMap::new())),
            cancellation_tokens: Arc::new(RwLock::new(HashMap::new())),
            msg_stores: msg_stores.clone(),
            db_stream_handles: Arc::new(RwLock::new(HashMap::new())),
            exit_monitor_handles: Arc::new(RwLock::new(HashMap::new())),
            config: config.clone(),
            git: GitService::new(),
            image_service: ImageService::new(pool).unwrap(),
            approvals: Approvals::new(msg_stores),
            notification_service: NotificationService::new(config),
        }
    }

    async fn insert_workspace_with_repo(pool: &SqlitePool, workspace: &Workspace, repo: &Repo) {
        sqlx::query(
            r#"
            INSERT INTO workspaces (
                id, project_id, task_id, parent_workspace_id, container_ref,
                branch, use_worktree, agent_working_dir, setup_completed_at,
                archived, pinned, name
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(workspace.id)
        .bind(workspace.project_id)
        .bind(workspace.task_id)
        .bind(workspace.parent_workspace_id)
        .bind(&workspace.container_ref)
        .bind(&workspace.branch)
        .bind(workspace.use_worktree)
        .bind(&workspace.agent_working_dir)
        .bind(workspace.setup_completed_at)
        .bind(workspace.archived)
        .bind(workspace.pinned)
        .bind(&workspace.name)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            r#"
            INSERT INTO repos (
                id, path, name, display_name, setup_script, cleanup_script,
                archive_script, copy_files, parallel_setup_script, dev_server_script,
                default_target_branch, default_working_dir
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(repo.id)
        .bind(repo.path.to_string_lossy().to_string())
        .bind(&repo.name)
        .bind(&repo.display_name)
        .bind(&repo.setup_script)
        .bind(&repo.cleanup_script)
        .bind(&repo.archive_script)
        .bind(&repo.copy_files)
        .bind(repo.parallel_setup_script)
        .bind(&repo.dev_server_script)
        .bind(&repo.default_target_branch)
        .bind(&repo.default_working_dir)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            r#"
            INSERT INTO workspace_repos (id, workspace_id, repo_id, target_branch)
            VALUES (?, ?, ?, ?)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(workspace.id)
        .bind(repo.id)
        .bind("main")
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_stop_project_and_task(pool: &SqlitePool, workspace: &Workspace) {
        sqlx::query(
            r#"
            INSERT INTO projects (id, name)
            VALUES (?, 'Project')
            "#,
        )
        .bind(workspace.project_id)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            r#"
            INSERT INTO tasks (id, project_id, title, description, status)
            VALUES (?, ?, 'Task', 'Description', 'inprogress')
            "#,
        )
        .bind(workspace.task_id)
        .bind(workspace.project_id)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_stop_session_execution(
        pool: &SqlitePool,
        workspace: &Workspace,
        session_id: Uuid,
        execution_process_id: Uuid,
        run_reason: &str,
        status: &str,
    ) {
        sqlx::query(
            r#"
            INSERT INTO sessions (id, workspace_id, task_id, status)
            VALUES (?, ?, ?, 'inprogress')
            "#,
        )
        .bind(session_id)
        .bind(workspace.id)
        .bind(workspace.task_id)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            r#"
            INSERT INTO execution_processes (
                id, session_id, run_reason, executor_action, status,
                exit_code, dropped, started_at, completed_at, created_at, updated_at
            ) VALUES (?, ?, ?, '{}', ?, NULL, 0,
                '2026-05-20T00:00:00Z', NULL,
                '2026-05-20T00:00:00Z', '2026-05-20T00:00:00Z'
            )
            "#,
        )
        .bind(execution_process_id)
        .bind(session_id)
        .bind(run_reason)
        .bind(status)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_execution_process_with_created_at(
        pool: &SqlitePool,
        session_id: Uuid,
        execution_process_id: Uuid,
        run_reason: &str,
        status: &str,
        created_at: &str,
    ) {
        sqlx::query(
            r#"
            INSERT INTO execution_processes (
                id, session_id, run_reason, executor_action, status,
                exit_code, dropped, started_at, completed_at, created_at, updated_at
            ) VALUES (?, ?, ?, '{}', ?, NULL, 0,
                ?, NULL, ?, ?
            )
            "#,
        )
        .bind(execution_process_id)
        .bind(session_id)
        .bind(run_reason)
        .bind(status)
        .bind(created_at)
        .bind(created_at)
        .bind(created_at)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_stop_execution_context(
        pool: &SqlitePool,
        workspace: &Workspace,
        session_id: Uuid,
        execution_process_id: Uuid,
        run_reason: &str,
    ) {
        insert_stop_project_and_task(pool, workspace).await;
        insert_stop_session_execution(
            pool,
            workspace,
            session_id,
            execution_process_id,
            run_reason,
            "running",
        )
        .await;
    }

    #[tokio::test]
    async fn new_marks_orphaned_running_executions_failed() {
        let pool = execution_process_test_pool().await;
        let process_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();

        sqlx::query(
            r#"
            INSERT INTO execution_processes (
                id, session_id, run_reason, executor_action, status,
                exit_code, dropped, started_at, completed_at, created_at, updated_at
            ) VALUES (?, ?, 'setupscript', '{}', 'running', NULL, 0,
                '2026-05-20T00:00:00Z', NULL,
                '2026-05-20T00:00:00Z', '2026-05-20T00:00:00Z'
            )
            "#,
        )
        .bind(process_id)
        .bind(session_id)
        .execute(&pool)
        .await
        .unwrap();

        let msg_stores = Arc::new(RwLock::new(HashMap::<Uuid, Arc<MsgStore>>::new()));
        let _container = LocalContainerService::new(
            DBService { pool: pool.clone() },
            msg_stores.clone(),
            Arc::new(RwLock::new(Config::default())),
            GitService::new(),
            ImageService::new(pool.clone()).unwrap(),
            Approvals::new(msg_stores),
        )
        .await;

        let (status, completed_at): (String, Option<String>) =
            sqlx::query_as("SELECT status, completed_at FROM execution_processes WHERE id = ?")
                .bind(process_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(status, "failed");
        assert!(completed_at.is_some());
    }

    #[tokio::test]
    async fn cleanup_orphan_executions_records_after_head_commit() {
        let pool = stop_execution_test_pool().await;
        let temp_root = TempDir::new().unwrap();
        let repo_path = temp_root.path().join("repo");
        let git = GitService::new();
        git.initialize_repo_with_main_branch(&repo_path).unwrap();
        fs::write(repo_path.join("README.md"), "hello\n").unwrap();
        git.commit(&repo_path, "seed").unwrap();
        let expected_head = git.get_head_info(&repo_path).unwrap().oid;
        let workspace = sample_workspace(Some(&repo_path.to_string_lossy()), false, None);
        let repo = sample_repo("repo", &repo_path.to_string_lossy());
        let session_id = Uuid::new_v4();
        let process_id = Uuid::new_v4();
        insert_workspace_with_repo(&pool, &workspace, &repo).await;
        insert_stop_execution_context(&pool, &workspace, session_id, process_id, "setupscript")
            .await;
        ExecutionProcessRepoState::create_many(
            &pool,
            process_id,
            &[CreateExecutionProcessRepoState {
                repo_id: repo.id,
                before_head_commit: None,
                after_head_commit: None,
                merge_commit: None,
            }],
        )
        .await
        .unwrap();
        let container = test_container(pool.clone());

        container.cleanup_orphan_executions().await.unwrap();

        let process = ExecutionProcess::find_by_id(&pool, process_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(process.status, ExecutionProcessStatus::Failed);
        let repo_states =
            ExecutionProcessRepoState::find_by_execution_process_id(&pool, process_id)
                .await
                .unwrap();
        assert_eq!(repo_states.len(), 1);
        assert_eq!(repo_states[0].after_head_commit, Some(expected_head));
    }

    #[tokio::test]
    async fn stop_execution_without_child_cleans_logs_and_marks_task_in_review() {
        let pool = stop_execution_test_pool().await;
        let temp_root = TempDir::new().unwrap();
        let workspace = sample_workspace(
            Some(&temp_root.path().to_string_lossy()),
            true,
            Some("frontend"),
        );
        let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
        let session_id = Uuid::new_v4();
        let process_id = Uuid::new_v4();
        insert_workspace_with_repo(&pool, &workspace, &repo).await;
        insert_stop_execution_context(&pool, &workspace, session_id, process_id, "setupscript")
            .await;
        let container = test_container(pool.clone());
        let store = Arc::new(MsgStore::new());
        store.push_stdout("running");
        container
            .msg_stores
            .write()
            .await
            .insert(process_id, store.clone());
        let (stream_done_tx, stream_done_rx) = tokio::sync::oneshot::channel();
        container.db_stream_handles.write().await.insert(
            process_id,
            tokio::spawn(async move {
                let _ = stream_done_tx.send(());
            }),
        );
        let process = ExecutionProcess::find_by_id(&pool, process_id)
            .await
            .unwrap()
            .unwrap();

        container
            .stop_execution(&process, ExecutionProcessStatus::Killed)
            .await
            .unwrap();

        stream_done_rx.await.unwrap();
        let process = ExecutionProcess::find_by_id(&pool, process_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(process.status, ExecutionProcessStatus::Killed);
        assert!(process.completed_at.is_some());
        assert!(container.msg_stores.read().await.get(&process_id).is_none());
        assert!(
            container
                .db_stream_handles
                .read()
                .await
                .get(&process_id)
                .is_none()
        );
        assert!(matches!(
            store.get_history().last(),
            Some(utils::log_msg::LogMsg::Finished)
        ));
        let task_status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id = ?")
            .bind(workspace.task_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(task_status, "inreview");
    }

    #[tokio::test]
    async fn stop_execution_without_child_leaves_dev_server_task_status_unchanged() {
        let pool = stop_execution_test_pool().await;
        let temp_root = TempDir::new().unwrap();
        let workspace = sample_workspace(
            Some(&temp_root.path().to_string_lossy()),
            true,
            Some("frontend"),
        );
        let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
        let session_id = Uuid::new_v4();
        let process_id = Uuid::new_v4();
        insert_workspace_with_repo(&pool, &workspace, &repo).await;
        insert_stop_execution_context(&pool, &workspace, session_id, process_id, "devserver").await;
        let container = test_container(pool.clone());
        let store = Arc::new(MsgStore::new());
        store.push_stdout("running");
        container
            .msg_stores
            .write()
            .await
            .insert(process_id, store.clone());
        let process = ExecutionProcess::find_by_id(&pool, process_id)
            .await
            .unwrap()
            .unwrap();

        container
            .stop_execution(&process, ExecutionProcessStatus::Killed)
            .await
            .unwrap();

        let process = ExecutionProcess::find_by_id(&pool, process_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(process.status, ExecutionProcessStatus::Killed);
        assert!(container.msg_stores.read().await.get(&process_id).is_none());
        assert!(matches!(
            store.get_history().last(),
            Some(utils::log_msg::LogMsg::Finished)
        ));
        let task_status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id = ?")
            .bind(workspace.task_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(task_status, "inprogress");
    }

    #[tokio::test]
    async fn stop_execution_without_child_records_after_head_commit() {
        let pool = stop_execution_test_pool().await;
        let temp_root = TempDir::new().unwrap();
        let repo_path = temp_root.path().join("repo");
        let git = GitService::new();
        git.initialize_repo_with_main_branch(&repo_path).unwrap();
        fs::write(repo_path.join("README.md"), "hello\n").unwrap();
        git.commit(&repo_path, "seed").unwrap();
        let expected_head = git.get_head_info(&repo_path).unwrap().oid;
        let workspace = sample_workspace(Some(&repo_path.to_string_lossy()), false, None);
        let repo = sample_repo("repo", &repo_path.to_string_lossy());
        let session_id = Uuid::new_v4();
        let process_id = Uuid::new_v4();
        insert_workspace_with_repo(&pool, &workspace, &repo).await;
        insert_stop_execution_context(&pool, &workspace, session_id, process_id, "setupscript")
            .await;
        ExecutionProcessRepoState::create_many(
            &pool,
            process_id,
            &[CreateExecutionProcessRepoState {
                repo_id: repo.id,
                before_head_commit: None,
                after_head_commit: None,
                merge_commit: None,
            }],
        )
        .await
        .unwrap();
        let container = test_container(pool.clone());
        let process = ExecutionProcess::find_by_id(&pool, process_id)
            .await
            .unwrap()
            .unwrap();

        container
            .stop_execution(&process, ExecutionProcessStatus::Killed)
            .await
            .unwrap();

        let repo_states =
            ExecutionProcessRepoState::find_by_execution_process_id(&pool, process_id)
                .await
                .unwrap();
        assert_eq!(repo_states.len(), 1);
        assert_eq!(repo_states[0].after_head_commit, Some(expected_head));
    }

    #[tokio::test]
    async fn start_execution_script_stores_db_stream_handle_on_success() {
        let pool = stop_execution_test_pool().await;
        let temp_root = TempDir::new().unwrap();
        let workspace = sample_workspace(
            Some(&temp_root.path().to_string_lossy()),
            true,
            Some("frontend"),
        );
        let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
        let session_id = Uuid::new_v4();
        insert_workspace_with_repo(&pool, &workspace, &repo).await;
        insert_stop_project_and_task(&pool, &workspace).await;
        sqlx::query(
            r#"
            INSERT INTO sessions (id, workspace_id, task_id, status)
            VALUES (?, ?, ?, 'todo')
            "#,
        )
        .bind(session_id)
        .bind(workspace.id)
        .bind(workspace.task_id)
        .execute(&pool)
        .await
        .unwrap();

        let container = test_container(pool.clone());
        let action = ExecutorAction::new(
            ExecutorActionType::ScriptRequest(ScriptRequest {
                script: env_probe_script(),
                language: ScriptRequestLanguage::Bash,
                context: ScriptContext::SetupScript,
                working_dir: None,
            }),
            None,
        );
        let session = db::models::session::Session::find_by_id(&pool, session_id)
            .await
            .unwrap()
            .unwrap();

        let process = container
            .start_execution(
                &workspace,
                &session,
                &action,
                &db::models::execution_process::ExecutionProcessRunReason::SetupScript,
            )
            .await
            .unwrap();

        assert!(container.msg_stores.read().await.contains_key(&process.id));
        assert!(container.child_store.read().await.contains_key(&process.id));
        assert!(
            container
                .db_stream_handles
                .read()
                .await
                .contains_key(&process.id)
        );
        assert!(
            container
                .exit_monitor_handles
                .read()
                .await
                .contains_key(&process.id)
        );

        let stdout = wait_for_stdout(
            &container,
            process.id,
            &[
                "PROJECT=Project".to_string(),
                format!("WORKSPACE={}", workspace.id),
                format!("SESSION={}", session_id),
            ],
        )
        .await;
        assert!(stdout.contains("PROJECT=Project"), "{stdout}");
        assert!(
            stdout.contains(&format!("WORKSPACE={}", workspace.id)),
            "{stdout}"
        );
        assert!(
            stdout.contains(&format!("SESSION={session_id}")),
            "{stdout}"
        );

        container
            .stop_execution(&process, ExecutionProcessStatus::Killed)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn try_stop_without_dev_server_stops_only_running_non_dev_processes() {
        let pool = stop_execution_test_pool().await;
        let temp_root = TempDir::new().unwrap();
        let workspace = sample_workspace(
            Some(&temp_root.path().to_string_lossy()),
            true,
            Some("frontend"),
        );
        let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
        let coding_session_id = Uuid::new_v4();
        let dev_session_id = Uuid::new_v4();
        let completed_session_id = Uuid::new_v4();
        let coding_process_id = Uuid::new_v4();
        let dev_process_id = Uuid::new_v4();
        let completed_process_id = Uuid::new_v4();
        insert_workspace_with_repo(&pool, &workspace, &repo).await;
        insert_stop_execution_context(
            &pool,
            &workspace,
            coding_session_id,
            coding_process_id,
            "setupscript",
        )
        .await;
        insert_stop_session_execution(
            &pool,
            &workspace,
            dev_session_id,
            dev_process_id,
            "devserver",
            "running",
        )
        .await;
        insert_stop_session_execution(
            &pool,
            &workspace,
            completed_session_id,
            completed_process_id,
            "setupscript",
            "completed",
        )
        .await;
        let container = test_container(pool.clone());

        container.try_stop(&workspace, false).await;

        let coding_process = ExecutionProcess::find_by_id(&pool, coding_process_id)
            .await
            .unwrap()
            .unwrap();
        let dev_process = ExecutionProcess::find_by_id(&pool, dev_process_id)
            .await
            .unwrap()
            .unwrap();
        let completed_process = ExecutionProcess::find_by_id(&pool, completed_process_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(coding_process.status, ExecutionProcessStatus::Killed);
        assert_eq!(dev_process.status, ExecutionProcessStatus::Running);
        assert_eq!(completed_process.status, ExecutionProcessStatus::Completed);
    }

    #[tokio::test]
    async fn reset_session_to_process_stops_workspace_and_drops_target_tail() {
        let pool = stop_execution_test_pool().await;
        let temp_root = TempDir::new().unwrap();
        let repo_path = temp_root.path().join("repo");
        fs::create_dir_all(&repo_path).unwrap();
        let workspace = sample_workspace(Some(&repo_path.to_string_lossy()), false, None);
        let repo = sample_repo("repo", &repo_path.to_string_lossy());
        let target_session_id = Uuid::new_v4();
        let dev_session_id = Uuid::new_v4();
        let previous_process_id = Uuid::new_v4();
        let target_process_id = Uuid::new_v4();
        let running_process_id = Uuid::new_v4();
        let dev_process_id = Uuid::new_v4();
        insert_workspace_with_repo(&pool, &workspace, &repo).await;
        insert_stop_project_and_task(&pool, &workspace).await;
        sqlx::query(
            r#"
            INSERT INTO sessions (id, workspace_id, task_id, status)
            VALUES (?, ?, ?, 'inprogress'), (?, ?, ?, 'inprogress')
            "#,
        )
        .bind(target_session_id)
        .bind(workspace.id)
        .bind(workspace.task_id)
        .bind(dev_session_id)
        .bind(workspace.id)
        .bind(workspace.task_id)
        .execute(&pool)
        .await
        .unwrap();
        insert_execution_process_with_created_at(
            &pool,
            target_session_id,
            previous_process_id,
            "setupscript",
            "completed",
            "2026-05-20T00:00:00Z",
        )
        .await;
        insert_execution_process_with_created_at(
            &pool,
            target_session_id,
            target_process_id,
            "setupscript",
            "completed",
            "2026-05-20T00:01:00Z",
        )
        .await;
        insert_execution_process_with_created_at(
            &pool,
            target_session_id,
            running_process_id,
            "setupscript",
            "running",
            "2026-05-20T00:02:00Z",
        )
        .await;
        insert_execution_process_with_created_at(
            &pool,
            dev_session_id,
            dev_process_id,
            "devserver",
            "running",
            "2026-05-20T00:03:00Z",
        )
        .await;
        let container = test_container(pool.clone());

        container
            .reset_session_to_process(target_session_id, target_process_id, false, false)
            .await
            .unwrap();

        let previous: (String, bool) =
            sqlx::query_as("SELECT status, dropped FROM execution_processes WHERE id = ?")
                .bind(previous_process_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let target: (String, bool) =
            sqlx::query_as("SELECT status, dropped FROM execution_processes WHERE id = ?")
                .bind(target_process_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let running: (String, bool) =
            sqlx::query_as("SELECT status, dropped FROM execution_processes WHERE id = ?")
                .bind(running_process_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let dev_server: (String, bool) =
            sqlx::query_as("SELECT status, dropped FROM execution_processes WHERE id = ?")
                .bind(dev_process_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(previous, ("completed".to_string(), false));
        assert_eq!(target, ("completed".to_string(), true));
        assert_eq!(running, ("killed".to_string(), true));
        assert_eq!(dev_server, ("running".to_string(), false));
    }

    #[tokio::test]
    async fn finalize_task_marks_session_and_task_in_review() {
        let pool = stop_execution_test_pool().await;
        let temp_root = TempDir::new().unwrap();
        let workspace = sample_workspace(
            Some(&temp_root.path().to_string_lossy()),
            true,
            Some("frontend"),
        );
        let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
        let session_id = Uuid::new_v4();
        let process_id = Uuid::new_v4();
        insert_workspace_with_repo(&pool, &workspace, &repo).await;
        insert_stop_execution_context(&pool, &workspace, session_id, process_id, "setupscript")
            .await;
        ExecutionProcess::update_completion(
            &pool,
            process_id,
            ExecutionProcessStatus::Completed,
            Some(0),
        )
        .await
        .unwrap();
        let container = test_container(pool.clone());
        let ctx = ExecutionProcess::load_context(&pool, process_id)
            .await
            .unwrap();

        container.finalize_task(&ctx).await;

        let session_status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let task_status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id = ?")
            .bind(workspace.task_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(session_status, "inreview");
        assert_eq!(task_status, "inreview");
    }

    #[tokio::test]
    async fn new_marks_orphaned_coding_agent_session_and_task_in_review() {
        let pool = stop_execution_test_pool().await;
        let temp_root = TempDir::new().unwrap();
        let workspace = sample_workspace(
            Some(&temp_root.path().to_string_lossy()),
            true,
            Some("frontend"),
        );
        let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
        let session_id = Uuid::new_v4();
        let process_id = Uuid::new_v4();
        insert_workspace_with_repo(&pool, &workspace, &repo).await;
        insert_stop_execution_context(&pool, &workspace, session_id, process_id, "setupscript")
            .await;
        let msg_stores = Arc::new(RwLock::new(HashMap::<Uuid, Arc<MsgStore>>::new()));
        let _container = LocalContainerService::new(
            DBService { pool: pool.clone() },
            msg_stores.clone(),
            Arc::new(RwLock::new(Config::default())),
            GitService::new(),
            ImageService::new(pool.clone()).unwrap(),
            Approvals::new(msg_stores),
        )
        .await;

        let session_status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let task_status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id = ?")
            .bind(workspace.task_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(session_status, "inreview");
        assert_eq!(task_status, "inreview");
    }

    #[tokio::test]
    async fn ensure_container_exists_reuses_configured_direct_external_worktree() {
        let pool = workspace_path_test_pool().await;
        let external_root = TempDir::new().unwrap();
        let source_root = TempDir::new().unwrap();
        let workspace = sample_workspace(
            Some(&external_root.path().to_string_lossy()),
            true,
            Some("frontend"),
        );
        let repo = sample_repo("repo", &source_root.path().join("repo").to_string_lossy());
        insert_workspace_with_repo(&pool, &workspace, &repo).await;
        let container = test_container(pool.clone());

        let container_ref = container.ensure_container_exists(&workspace).await.unwrap();

        assert_eq!(container_ref, external_root.path().to_string_lossy());
        assert!(!external_root.path().join("repo").exists());
        let stored_ref: String =
            sqlx::query_scalar("SELECT container_ref FROM workspaces WHERE id = ?")
                .bind(workspace.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored_ref, external_root.path().to_string_lossy());
    }

    #[tokio::test]
    async fn ensure_container_exists_rejects_missing_direct_external_worktree() {
        let pool = workspace_path_test_pool().await;
        let temp_root = TempDir::new().unwrap();
        let missing_external_root = temp_root.path().join("missing-worktree");
        let workspace = sample_workspace(
            Some(&missing_external_root.to_string_lossy()),
            true,
            Some("frontend"),
        );
        let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
        insert_workspace_with_repo(&pool, &workspace, &repo).await;
        let container = test_container(pool);

        let error = container
            .ensure_container_exists(&workspace)
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("External worktree path does not exist")
        );
    }

    #[tokio::test]
    async fn ensure_container_exists_discovers_existing_direct_external_worktree() {
        let pool = workspace_path_test_pool().await;
        let temp_root = TempDir::new().unwrap();
        let repo_path = temp_root.path().join("repo");
        let git = GitService::new();
        git.initialize_repo_with_main_branch(&repo_path).unwrap();
        fs::write(repo_path.join("README.md"), "hello\n").unwrap();
        git.commit(&repo_path, "seed").unwrap();

        let branch = "feature/discovered-worktree";
        let worktree_path = temp_root.path().join("direct-worktree");
        WorktreeManager::create_worktree(&repo_path, branch, &worktree_path, "main", true)
            .await
            .unwrap();

        let mut workspace = sample_workspace(None, true, Some("frontend"));
        workspace.branch = branch.to_string();
        let repo = sample_repo("repo", &repo_path.to_string_lossy());
        insert_workspace_with_repo(&pool, &workspace, &repo).await;
        let container = test_container(pool.clone());

        let container_ref = container.ensure_container_exists(&workspace).await.unwrap();

        let expected_path = LocalContainerService::canonicalize_for_safety(&worktree_path);
        assert_eq!(
            LocalContainerService::canonicalize_for_safety(PathBuf::from(&container_ref).as_path()),
            expected_path
        );
        let stored_ref: String =
            sqlx::query_scalar("SELECT container_ref FROM workspaces WHERE id = ?")
                .bind(workspace.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            LocalContainerService::canonicalize_for_safety(PathBuf::from(&stored_ref).as_path()),
            expected_path
        );
    }

    #[test]
    fn normalized_workspace_base_dir_uses_repo_path_without_worktree() {
        let workspace = sample_workspace(Some("C:/ignored/container"), false, Some("frontend"));
        let repo = sample_repo("repo", "C:/source/repo");

        assert_eq!(
            LocalContainerService::normalized_workspace_base_dir(&workspace, &[repo]),
            PathBuf::from("C:/source/repo")
        );
    }

    #[test]
    fn normalized_workspace_base_dir_keeps_worktree_container_ref() {
        let workspace = sample_workspace(Some("C:/worktrees/repo-feature"), true, Some("frontend"));
        let repo = sample_repo("repo", "C:/source/repo");

        assert_eq!(
            LocalContainerService::normalized_workspace_base_dir(&workspace, &[repo]),
            PathBuf::from("C:/worktrees/repo-feature")
        );
    }

    #[test]
    fn direct_external_worktree_detects_single_repo_checkout_root() {
        let workspace = sample_workspace(None, true, Some("frontend"));
        let repo = sample_repo("repo", "C:/source/repo");
        let external_root = temp_external_path("direct");

        assert!(LocalContainerService::is_direct_external_worktree(
            &workspace,
            &external_root,
            &[repo]
        ));
    }

    #[test]
    fn direct_external_worktree_excludes_app_owned_workspace_dirs() {
        let workspace = sample_workspace(None, true, Some("frontend"));
        let repo = sample_repo("repo", "C:/source/repo");
        let app_owned_root = WorkspaceManager::get_workspace_base_dir().join("workspace-123");

        assert!(!LocalContainerService::is_direct_external_worktree(
            &workspace,
            &app_owned_root,
            &[repo]
        ));
    }

    #[test]
    fn direct_external_worktree_excludes_agent_dirs_targeting_repo_folder() {
        let workspace = sample_workspace(None, true, Some("repo/frontend"));
        let repo = sample_repo("repo", "C:/source/repo");
        let external_root = temp_external_path("repo-folder");

        assert!(!LocalContainerService::is_direct_external_worktree(
            &workspace,
            &external_root,
            &[repo]
        ));
    }

    #[test]
    fn workspace_repo_path_preserves_git_checkout_root() {
        let workspace = sample_workspace(None, true, None);
        let repo_name = "repo";
        let checkout_root = temp_external_path("checkout");
        fs::create_dir_all(&checkout_root).unwrap();
        fs::write(
            checkout_root.join(".git"),
            "gitdir: ../repo.git/worktrees/checkout",
        )
        .unwrap();

        assert_eq!(
            LocalContainerService::workspace_repo_path(&workspace, &checkout_root, repo_name),
            checkout_root
        );
    }
}
