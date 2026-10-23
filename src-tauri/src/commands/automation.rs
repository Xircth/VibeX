//! Tauri background runner for the transport-neutral Automation v2 core.

use std::{
    collections::HashSet,
    sync::{LazyLock, Mutex},
    time::Duration,
};

use application::{
    Principal, StartWorkflowRequest, WorkflowExecutionPort, WorkflowStoreExecutionPort,
};
use async_trait::async_trait;
use automation::{
    AgentRuntimeVersionEvidence, AutomationEngine, AutomationRetentionService, AutomationRunner,
    AutomationTarget, ClaimedRun, ComponentVersionEvidence, ConnectionLaunch, FileOwnerLock,
    IsolationSpec, PreparedWorkspace, ResolvedVersionEvidence, RetentionError, RetentionPolicy,
    RunError, RunExecutionRequest, RunStatus, StartupReconciler, SystemClock,
    ToolLockVersionEvidence, TurnLaunchSpec, TurnLauncherPort, WorkspaceError,
    WorkspacePreparationRequest, WorkspacePreparerPort, WorkspaceRetentionPort,
};
use chrono::Utc;
use db::models::{
    automation_v2::{AutomationRunRecord, SqliteAutomationStore},
    conversation_turn::ConversationTurnRecord,
    project_repo::ProjectRepo,
    session::{CreateSession, Session},
    workspace::Workspace,
};
use plugins::PromptBlock;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::{
    commands::sessions::{
        ProjectSessionRepoInput, create_worktree_workspace_for_project_session,
        resolve_project_workspace,
    },
    conversation_service::{ConversationSessionService, ConversationStartTurnInput},
    error::AppError,
    state::AppState,
};

const POLL_INTERVAL_SECS: u64 = 30;
static OWNED_DATA_DIRS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

struct EngineOwnershipMarker {
    data_dir_key: String,
}

impl EngineOwnershipMarker {
    fn register(data_dir_key: String) -> Self {
        OWNED_DATA_DIRS
            .lock()
            .expect("Automation ownership registry poisoned")
            .insert(data_dir_key.clone());
        Self { data_dir_key }
    }
}

impl Drop for EngineOwnershipMarker {
    fn drop(&mut self) {
        OWNED_DATA_DIRS
            .lock()
            .expect("Automation ownership registry poisoned")
            .remove(&self.data_dir_key);
    }
}

/// Lease identity is the Host data directory, the same path `FileOwnerLock` uses.
/// Tauri `app_data_dir()` is a different folder in debug (`dev_assets/` vs
/// Application Support), so status and run gates must not use it.
fn automation_engine_data_dir_key() -> String {
    utils::assets::host_data_dir()
        .to_string_lossy()
        .into_owned()
}

pub fn this_host_owns_automation_engine() -> bool {
    OWNED_DATA_DIRS
        .lock()
        .expect("Automation ownership registry poisoned")
        .contains(&automation_engine_data_dir_key())
}

fn store(state: &AppState) -> SqliteAutomationStore {
    SqliteAutomationStore::new(state.deployment.db().pool.clone())
}

pub fn start_automation_engine(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let key = automation_engine_data_dir_key();
        let Some(engine) = (match AutomationEngine::acquire(&key, FileOwnerLock::default()).await {
            Ok(engine) => engine,
            Err(error) => {
                tracing::warn!("automation owner lock failed: {error}");
                return;
            }
        }) else {
            tracing::info!("another host owns the Automation Engine for this data directory");
            return;
        };
        let _ownership_marker = EngineOwnershipMarker::register(key);
        let automation_store = {
            let state = app.state::<AppState>();
            store(state.inner())
        };
        let recovery = StartupReconciler::new(automation_store.clone(), SystemClock);
        match recovery.reconcile().await {
            Ok(report) => {
                for run in report.catch_up_runs {
                    execute_run(app.clone(), run, None).await;
                }
            }
            Err(error) => tracing::warn!("automation startup reconciliation failed: {error}"),
        }
        let service = engine.with_claim_store(automation_store, SystemClock);
        let mut interval = tokio::time::interval(Duration::from_secs(POLL_INTERVAL_SECS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut next_retention = std::time::Instant::now();
        loop {
            interval.tick().await;
            if let Err(error) = reconcile_running_turns(&app).await {
                tracing::warn!("automation terminal reconciliation failed: {error}");
            }
            if std::time::Instant::now() >= next_retention {
                let retention = AutomationRetentionService::new(
                    {
                        let state = app.state::<AppState>();
                        store(state.inner())
                    },
                    TauriRetentionWorkspaces { app: app.clone() },
                    RetentionPolicy::default(),
                );
                if let Err(error) = retention.enforce(Utc::now()).await {
                    tracing::warn!("automation retention failed: {error}");
                }
                next_retention = std::time::Instant::now() + Duration::from_secs(60 * 60);
            }
            match service.tick().await {
                Ok(claimed) => {
                    for run in claimed {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            execute_run(app, run, None).await;
                        });
                    }
                }
                Err(error) => tracing::warn!("automation tick failed: {error}"),
            }
        }
    });
}

#[derive(Clone)]
struct TauriRetentionWorkspaces {
    app: AppHandle,
}

#[async_trait]
impl WorkspaceRetentionPort for TauriRetentionWorkspaces {
    async fn release_retained_workspace(&self, workspace_id: Uuid) -> Result<(), RetentionError> {
        let state = self.app.state::<AppState>();
        let workspace = Workspace::find_by_id(&state.deployment.db().pool, workspace_id)
            .await
            .map_err(|error| RetentionError::Workspace(error.to_string()))?;
        if let Some(workspace) = workspace {
            state
                .deployment
                .container()
                .delete(&workspace)
                .await
                .map_err(|error| RetentionError::Workspace(error.to_string()))?;
        }
        Ok(())
    }
}

async fn reconcile_running_turns(app: &AppHandle) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let automation_store = store(state.inner());
    for run in automation_store.running_runs().await? {
        if reconcile_run_terminal(state.inner(), &automation_store, &run).await? {
            continue;
        }
        if run.snapshot.cancellation_requested
            && let Some(conversation_id) = run.snapshot.conversation_id
        {
            ConversationSessionService::new(state.conversation_context())
                .cancel_turn(
                    conversation_id,
                    Some("automation run cancelled".to_string()),
                )
                .await?;
        }
        if run.snapshot.cancellation_requested
            && let Some(workflow_run_id) = run.workflow_run_id
        {
            workflows::WorkflowCore::new(workflows::WorkflowStore::new(
                state.deployment.db().pool.clone(),
            ))
            .cancel(
                workflow_run_id,
                Uuid::new_v4(),
                Some("automation run cancelled"),
            )
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
        }
        let refreshed = automation_store
            .run(run.snapshot.run_id)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!("automation run {} not found", run.snapshot.run_id))
            })?;
        reconcile_run_terminal(state.inner(), &automation_store, &refreshed).await?;
    }
    Ok(())
}

async fn reconcile_run_terminal(
    state: &AppState,
    automation_store: &SqliteAutomationStore,
    run: &AutomationRunRecord,
) -> Result<bool, AppError> {
    if let Some(workflow_run_id) = run.workflow_run_id {
        let workflow = workflows::WorkflowStore::new(state.deployment.db().pool.clone())
            .run(workflow_run_id)
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
        let terminal = match workflow.status.as_str() {
            "completed" => Some((RunStatus::Completed, None)),
            "failed" => Some((RunStatus::Failed, Some("workflow failed".to_string()))),
            "cancelled" => Some((RunStatus::Cancelled, None)),
            "interrupted" => Some((
                RunStatus::Interrupted,
                Some("workflow interrupted".to_string()),
            )),
            _ => None,
        };
        if let Some((status, error)) = terminal {
            return automation::RunStorePort::settle(
                automation_store,
                run.snapshot.run_id,
                status,
                error,
            )
            .await
            .map_err(|error| AppError::Internal(error.to_string()));
        }
        return Ok(false);
    }
    let Some(turn_id) = run.snapshot.turn_id else {
        return Ok(false);
    };
    let Some(turn) = ConversationTurnRecord::find_by_id(automation_store.pool(), turn_id).await?
    else {
        return Ok(false);
    };
    let terminal = match turn.status.as_str() {
        "completed" => Some((RunStatus::Completed, None)),
        "failed" => Some((
            RunStatus::Failed,
            turn.error_json
                .or(turn.stop_reason)
                .or_else(|| Some("conversation turn failed".to_string())),
        )),
        "cancelled" => Some((RunStatus::Cancelled, None)),
        "interrupted" => Some((RunStatus::Interrupted, turn.stop_reason)),
        _ => None,
    };
    if let Some((status, error)) = terminal {
        if status == RunStatus::Cancelled
            && let Err(cleanup_error) = cleanup_cancelled_workspace(state, run).await
        {
            tracing::warn!(
                run_id = %run.snapshot.run_id,
                "cancelled Automation worktree cleanup failed: {cleanup_error}"
            );
        }
        return automation::RunStorePort::settle(
            automation_store,
            run.snapshot.run_id,
            status,
            error,
        )
        .await
        .map_err(|error| AppError::Internal(error.to_string()));
    }
    Ok(false)
}

async fn cleanup_cancelled_workspace(
    state: &AppState,
    run: &AutomationRunRecord,
) -> Result<(), AppError> {
    let Some(workspace_id) = run.snapshot.workspace_id else {
        return Ok(());
    };
    let isolation: Option<String> =
        sqlx::query_scalar("SELECT isolation FROM automations WHERE id = ?")
            .bind(run.snapshot.automation_id)
            .fetch_optional(&state.deployment.db().pool)
            .await?;
    if isolation.as_deref() != Some("worktree_per_run") {
        return Ok(());
    }
    if let Some(workspace) =
        Workspace::find_by_id(&state.deployment.db().pool, workspace_id).await?
    {
        state.deployment.container().delete(&workspace).await?;
    }
    Ok(())
}

async fn execute_run(app: AppHandle, claimed: ClaimedRun, debug_step_id: Option<String>) {
    let automation_store = {
        let state = app.state::<AppState>();
        store(state.inner())
    };
    let automation = match automation_store.find(claimed.automation_id).await {
        Ok(Some(automation)) => automation,
        Ok(None) => {
            let _ = automation::RunStorePort::settle(
                &automation_store,
                claimed.run_id,
                RunStatus::Failed,
                Some("automation disappeared after claim".to_string()),
            )
            .await;
            return;
        }
        Err(error) => {
            tracing::warn!("automation load after claim failed: {error}");
            return;
        }
    };
    match automation.target {
        AutomationTarget::Turn(launch_spec) => {
            let runner = AutomationRunner::new(
                automation_store,
                TauriWorkspacePreparer { app: app.clone() },
                TauriTurnLauncher { app },
            );
            if let Err(error) = runner
                .execute(&RunExecutionRequest {
                    run_id: claimed.run_id,
                    automation_id: claimed.automation_id,
                    launch_spec,
                })
                .await
                && error != RunError::Cancelled
            {
                tracing::warn!(
                    "automation run {} failed to launch: {error}",
                    claimed.run_id
                );
            }
        }
        AutomationTarget::Workflow(spec) => {
            if let Err(error) = execute_workflow_automation(
                app,
                automation_store,
                claimed.run_id,
                claimed.automation_id,
                spec,
                debug_step_id,
            )
            .await
            {
                tracing::warn!(
                    "automation workflow run {} failed to launch: {error}",
                    claimed.run_id
                );
            }
        }
    }
}

async fn execute_workflow_automation(
    app: AppHandle,
    store: SqliteAutomationStore,
    automation_run_id: Uuid,
    automation_id: Uuid,
    spec: automation::WorkflowLaunchSpec,
    debug_step_id: Option<String>,
) -> Result<(), String> {
    use automation::RunStorePort;

    let policy_override = match spec.policy_override.map(serde_json::from_value).transpose() {
        Ok(policy) => policy,
        Err(error) => {
            let _ = store
                .settle(
                    automation_run_id,
                    RunStatus::Failed,
                    Some(error.to_string()),
                )
                .await;
            return Err(error.to_string());
        }
    };
    let preparer = TauriWorkspacePreparer { app: app.clone() };
    let workspace = match preparer
        .prepare(&WorkspacePreparationRequest {
            automation_id,
            run_id: automation_run_id,
            target: spec.workspace,
        })
        .await
    {
        Ok(workspace) => workspace,
        Err(error) => {
            let _ = store
                .settle(
                    automation_run_id,
                    RunStatus::Failed,
                    Some(error.to_string()),
                )
                .await;
            return Err(error.to_string());
        }
    };
    let state = app.state::<AppState>();
    let workflows = WorkflowStoreExecutionPort::with_conversations(
        state.deployment.db().pool.clone(),
        state.conversation_context(),
    );
    let run = match workflows
        .start(
            &Principal::local_desktop(),
            automation_run_id,
            StartWorkflowRequest {
                definition_version_id: spec.definition_version_id,
                workspace_id: workspace.workspace_id,
                input: spec.input,
                policy_override,
                debug_step_id,
            },
        )
        .await
    {
        Ok(run) => run,
        Err(error) => {
            let _ = preparer.release(&workspace).await;
            let _ = store
                .settle(
                    automation_run_id,
                    RunStatus::Failed,
                    Some(error.to_string()),
                )
                .await;
            return Err(error.to_string());
        }
    };
    if let Err(error) = store
        .attach_workflow_run(automation_run_id, run.id, workspace.workspace_id)
        .await
    {
        let _ = workflows
            .cancel(
                Uuid::new_v4(),
                application::CancelWorkflowRequest {
                    run_id: run.id,
                    reason: Some("automation launch correlation failed".to_string()),
                },
            )
            .await;
        let _ = preparer.release(&workspace).await;
        let _ = store
            .settle(
                automation_run_id,
                RunStatus::Failed,
                Some(error.to_string()),
            )
            .await;
        return Err(error.to_string());
    }
    Ok(())
}

#[derive(Clone)]
struct TauriWorkspacePreparer {
    app: AppHandle,
}

#[async_trait]
impl WorkspacePreparerPort for TauriWorkspacePreparer {
    async fn prepare(
        &self,
        request: &WorkspacePreparationRequest,
    ) -> Result<PreparedWorkspace, WorkspaceError> {
        let state = self.app.state::<AppState>();
        let automation_store = store(state.inner());
        let mut shared_root_leased = false;
        let workspace = match request.target.isolation {
            IsolationSpec::WorktreePerRun => {
                let repos = ProjectRepo::find_repos_for_project(
                    &state.deployment.db().pool,
                    request.target.project_id,
                )
                .await
                .map_err(workspace_adapter_error)?;
                let repo_inputs = repos
                    .iter()
                    .map(|repo| ProjectSessionRepoInput {
                        repo_id: repo.id,
                        target_branch: request
                            .target
                            .branch
                            .clone()
                            .or_else(|| repo.default_target_branch.clone())
                            .unwrap_or_default(),
                    })
                    .collect::<Vec<_>>();
                let branch = format!(
                    "automation/{}/run-{}",
                    request.automation_id, request.run_id
                );
                create_worktree_workspace_for_project_session(
                    state.inner(),
                    request.target.project_id,
                    Some(&format!("Automation {}", request.automation_id)),
                    None,
                    &repo_inputs,
                    Some(&branch),
                    false,
                )
                .await
                .map_err(workspace_adapter_error)?
            }
            IsolationSpec::SharedInRoot => {
                if !automation_store
                    .try_acquire_shared_root(
                        &request.target.root_folder,
                        request.run_id,
                        Utc::now(),
                    )
                    .await
                    .map_err(workspace_adapter_error)?
                {
                    return Err(WorkspaceError::SharedRootBusy);
                }
                shared_root_leased = true;
                let workspace =
                    match resolve_project_workspace(state.inner(), request.target.project_id, None)
                        .await
                    {
                        Ok(workspace) => workspace,
                        Err(error) => {
                            let _ = automation_store.release_shared_root(request.run_id).await;
                            return Err(workspace_adapter_error(error));
                        }
                    };
                let repos = ProjectRepo::find_repos_for_project(
                    &state.deployment.db().pool,
                    request.target.project_id,
                )
                .await
                .map_err(workspace_adapter_error);
                let repos = match repos {
                    Ok(repos) => repos,
                    Err(error) => {
                        let _ = automation_store.release_shared_root(request.run_id).await;
                        return Err(error);
                    }
                };
                let git = state.deployment.git().clone();
                let expected_branch = request.target.branch.clone();
                let repo_paths: Vec<_> = repos.into_iter().map(|repo| repo.path).collect();
                let check = tokio::task::spawn_blocking(
                    move || -> Result<Result<(), WorkspaceError>, git::GitServiceError> {
                        for path in &repo_paths {
                            if !git.is_worktree_clean(path)? {
                                return Ok(Err(WorkspaceError::DirtySharedRoot));
                            }
                            let current = git.get_current_branch(path)?;
                            if let Some(expected) = expected_branch.as_ref()
                                && expected != &current
                            {
                                return Ok(Err(WorkspaceError::WrongBranch {
                                    expected: expected.clone(),
                                    actual: current,
                                }));
                            }
                        }
                        Ok(Ok(()))
                    },
                )
                .await
                .map_err(workspace_adapter_error)?;
                match check {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        let _ = automation_store.release_shared_root(request.run_id).await;
                        return Err(error);
                    }
                    Err(error) => {
                        let _ = automation_store.release_shared_root(request.run_id).await;
                        return Err(workspace_adapter_error(error));
                    }
                }
                workspace
            }
        };
        match state
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
        {
            Ok(_) => {}
            Err(error) => {
                if shared_root_leased {
                    let _ = automation_store.release_shared_root(request.run_id).await;
                }
                return Err(workspace_adapter_error(error));
            }
        }
        let workspace = match Workspace::find_by_id(&state.deployment.db().pool, workspace.id).await
        {
            Ok(Some(workspace)) => workspace,
            Ok(None) => {
                if shared_root_leased {
                    let _ = automation_store.release_shared_root(request.run_id).await;
                }
                return Err(WorkspaceError::Adapter(
                    "prepared workspace disappeared".to_string(),
                ));
            }
            Err(error) => {
                if shared_root_leased {
                    let _ = automation_store.release_shared_root(request.run_id).await;
                }
                return Err(workspace_adapter_error(error));
            }
        };
        Ok(PreparedWorkspace {
            workspace_id: workspace.id,
            root_folder: workspace
                .container_ref
                .unwrap_or_else(|| request.target.root_folder.clone()),
            branch: workspace.branch,
        })
    }

    async fn release(&self, workspace: &PreparedWorkspace) -> Result<(), WorkspaceError> {
        let state = self.app.state::<AppState>();
        let isolation: Option<String> = sqlx::query_scalar(
            "SELECT a.isolation
             FROM automation_runs r
             JOIN automations a ON a.id = r.automation_id
             WHERE r.worktree_workspace_id = ?
             ORDER BY r.started_at DESC
             LIMIT 1",
        )
        .bind(workspace.workspace_id)
        .fetch_optional(&state.deployment.db().pool)
        .await
        .map_err(workspace_adapter_error)?;
        if isolation.as_deref() == Some("worktree_per_run")
            && let Some(workspace) =
                Workspace::find_by_id(&state.deployment.db().pool, workspace.workspace_id)
                    .await
                    .map_err(workspace_adapter_error)?
        {
            state
                .deployment
                .container()
                .delete(&workspace)
                .await
                .map_err(workspace_adapter_error)?;
        }
        Ok(())
    }
}

#[derive(Clone)]
struct TauriTurnLauncher {
    app: AppHandle,
}

#[async_trait]
impl TurnLauncherPort for TauriTurnLauncher {
    async fn resolve_versions(
        &self,
        spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
    ) -> Result<ResolvedVersionEvidence, RunError> {
        let state = self.app.state::<AppState>();
        let pool = &state.deployment.db().pool;
        let managed_lock: Option<(String, String)> = sqlx::query_as(
            "SELECT l.id, l.registry_version
             FROM agent_installation i
             JOIN agent_install_lock l ON l.id = i.current_lock_id
             WHERE i.agent_id = ?",
        )
        .bind(spec.agent.agent_id.as_str())
        .fetch_optional(pool)
        .await
        .map_err(|error| RunError::Launcher(error.to_string()))?;
        let mut plugins = Vec::new();
        let mut tool_locks = Vec::new();
        let runtime_inventory = state
            .plugin_control_plane
            .runtime_inventory()
            .await
            .map_err(|error| RunError::Launcher(error.to_string()))?;
        for action in &spec.plugin_actions {
            state
                .plugin_control_plane
                .resolve_action(action.plugin_id.as_str(), action.action.id.as_str())
                .await
                .map_err(|error| RunError::Launcher(error.to_string()))?;
            let plugin = state
                .plugin_control_plane
                .plugin(action.plugin_id.as_str())
                .await
                .map_err(|error| RunError::Launcher(error.to_string()))?
                .ok_or_else(|| {
                    RunError::Launcher(format!(
                        "plugin {} is unavailable",
                        action.plugin_id.as_str()
                    ))
                })?;
            plugins.push(ComponentVersionEvidence {
                id: plugin.id().to_owned(),
                version: plugin.version.clone(),
            });
            for required in &plugin.runtimes {
                let lock = runtime_inventory
                    .iter()
                    .find(|runtime| {
                        runtime.id == required.id
                            && required
                                .version
                                .as_deref()
                                .is_none_or(|version| version == runtime.version)
                    })
                    .ok_or_else(|| {
                        RunError::Launcher(format!(
                            "plugin {} Runtime {} is not ready",
                            plugin.id(),
                            required.id
                        ))
                    })?;
                tool_locks.push(ToolLockVersionEvidence {
                    tool_id: lock.id.clone(),
                    version: lock.version.clone(),
                    target: "user-global".to_owned(),
                    sha256: String::new(),
                });
            }
        }
        Ok(ResolvedVersionEvidence {
            agent_runtime: match managed_lock {
                Some((lock_id, registry_version)) => AgentRuntimeVersionEvidence::Managed {
                    agent_id: spec.agent.agent_id.to_string(),
                    registry_version,
                    lock_id,
                },
                None => AgentRuntimeVersionEvidence::External {
                    agent_id: spec.agent.agent_id.to_string(),
                    executor_profile: spec.agent.executor_profile_id.clone(),
                },
            },
            acp_adapter: ComponentVersionEvidence {
                id: "vibex-acp".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            plugins,
            tool_locks,
        })
    }

    async fn create_conversation(
        &self,
        spec: &TurnLaunchSpec,
        workspace: &PreparedWorkspace,
    ) -> Result<Uuid, RunError> {
        let state = self.app.state::<AppState>();
        let workspace_row =
            Workspace::find_by_id(&state.deployment.db().pool, workspace.workspace_id)
                .await
                .map_err(|error| RunError::Launcher(error.to_string()))?
                .ok_or_else(|| RunError::Launcher("workspace disappeared".to_string()))?;
        let id = Uuid::new_v4();
        Session::create(
            &state.deployment.db().pool,
            &CreateSession {
                executor: Some(spec.agent.agent_id.as_str().to_string()),
                agent_id: Some(spec.agent.agent_id.clone()),
                task_id: Some(workspace_row.task_id),
                name: spec.label_snapshot.clone(),
                initial_prompt: Some(spec.display_text.clone()),
                status: None,
            },
            id,
            workspace.workspace_id,
        )
        .await
        .map_err(|error| RunError::Launcher(error.to_string()))?;
        Ok(id)
    }

    async fn create_connection(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
        _conversation_id: Uuid,
        _versions: &ResolvedVersionEvidence,
    ) -> Result<ConnectionLaunch, RunError> {
        Ok(ConnectionLaunch {
            connection_id: format!("automation-{}", Uuid::new_v4()),
        })
    }

    async fn start_turn(
        &self,
        spec: &TurnLaunchSpec,
        workspace: &PreparedWorkspace,
        conversation_id: Uuid,
        _connection_id: &str,
    ) -> Result<Uuid, RunError> {
        let state = self.app.state::<AppState>();
        let mut prompt_parts = spec
            .prompt_blocks
            .iter()
            .map(|block| match block {
                PromptBlock::Text { text } => text.as_str(),
            })
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>();
        prompt_parts.extend(spec.plugin_actions.iter().flat_map(|reference| {
            reference
                .action
                .prompt_blocks
                .iter()
                .map(|block| match block {
                    PromptBlock::Text { text } => text.as_str(),
                })
        }));
        let text = prompt_parts.join("\n");
        let (turn, _) = ConversationSessionService::new(state.conversation_context())
            .start_turn_with_origin(
                ConversationStartTurnInput {
                    agent_id: spec.agent.agent_id.clone(),
                    workspace_id: workspace.workspace_id,
                    conversation_id,
                    executor_profile_id: spec.agent.executor_profile_id.clone(),
                    text,
                    display_text: Some(spec.display_text.clone()),
                    images: Vec::new(),
                    mode_override: spec.mode_id.clone(),
                    config_overrides: spec.config_values.clone(),
                    workflow_refs: spec
                        .plugin_actions
                        .iter()
                        .map(|invocation| agents::ConversationWorkflowRef {
                            plugin_id: invocation.plugin_id.as_str().to_owned(),
                            workflow_id: invocation.action.id.as_str().to_owned(),
                        })
                        .collect(),
                    file_refs: Vec::new(),
                    internal_prompt_contributions: Vec::new(),
                    queued_input_claim: None,
                    operation_id: None,
                },
                conversations::commit_reminder::AUTOMATION_ORIGIN,
            )
            .await
            .map_err(|error| RunError::Launcher(error.to_string()))?;
        Ok(turn.turn_id)
    }
}

fn workspace_adapter_error(error: impl std::fmt::Display) -> WorkspaceError {
    WorkspaceError::Adapter(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    static OWNERSHIP_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn engine_status_is_active_when_this_host_holds_the_host_data_dir_lease() {
        let _guard = OWNERSHIP_TEST_LOCK.lock().await;
        let _marker = EngineOwnershipMarker::register(automation_engine_data_dir_key());
        assert!(this_host_owns_automation_engine());
    }

    #[tokio::test]
    async fn engine_status_ignores_a_lease_registered_on_a_foreign_data_dir() {
        let _guard = OWNERSHIP_TEST_LOCK.lock().await;
        let _marker =
            EngineOwnershipMarker::register("/tmp/com.vibex.app-app-data-dir".to_string());
        assert!(!this_host_owns_automation_engine());
    }

    #[test]
    fn engine_lease_key_is_the_host_data_directory() {
        assert_eq!(
            automation_engine_data_dir_key(),
            utils::assets::host_data_dir().to_string_lossy().as_ref()
        );
    }
}
