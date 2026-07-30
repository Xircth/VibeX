//! Thin Tauri adapter for the transport-neutral Automation v2 core.

use std::{
    collections::HashSet,
    sync::{LazyLock, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use automation::{
    AgentRuntimeVersionEvidence, AgentSelectionIntent, AutomationDraft, AutomationDraftInput,
    AutomationEngine, AutomationRunner, ClaimedRun, ComponentVersionEvidence, ConnectionLaunch,
    FileOwnerLock, IsolationSpec, PluginActionCatalogPort, PreparedWorkspace,
    ResolvedVersionEvidence, RunError, RunExecutionRequest, RunStatus, ScheduleService,
    ScheduleSpec, StartupReconciler, SystemClock, ToolLockVersionEvidence, TurnLaunchSpec,
    TurnLaunchSpecInput, TurnLauncherPort, WorkspaceError, WorkspacePreparationRequest,
    WorkspacePreparerPort, WorkspaceTarget,
};
use chrono::{DateTime, Utc};
use db::models::{
    automation::{Automation, AutomationInput, AutomationRun},
    automation_v2::{AutomationRecord, AutomationRunRecord, SqliteAutomationStore},
    conversation_turn::ConversationTurnRecord,
    project_repo::ProjectRepo,
    session::{CreateSession, Session},
    workspace::Workspace,
};
use plugins::{PluginAction, PluginId, PromptBlock};
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

struct OfficeActionCatalog<'a> {
    manifest: &'a plugins::PluginManifest,
}

impl PluginActionCatalogPort for OfficeActionCatalog<'_> {
    fn contains(&self, reference: &automation::PluginActionRef) -> bool {
        reference.plugin_id == self.manifest.id
            && self
                .manifest
                .actions
                .iter()
                .any(|action| action.id == reference.action.id)
    }
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

fn store(state: &AppState) -> SqliteAutomationStore {
    SqliteAutomationStore::new(state.deployment.db().pool.clone())
}

#[tauri::command]
pub async fn automation_list(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Automation>, AppError> {
    store(state.inner())
        .list()
        .await?
        .into_iter()
        .map(record_to_dto)
        .collect()
}

#[tauri::command]
pub async fn automation_create(
    state: tauri::State<'_, AppState>,
    input: AutomationInput,
) -> Result<Automation, AppError> {
    let draft = input_to_draft(state.inner(), input).await?;
    record_to_dto(store(state.inner()).create(draft, Utc::now()).await?)
}

#[tauri::command]
pub async fn automation_update(
    state: tauri::State<'_, AppState>,
    id: Uuid,
    input: AutomationInput,
) -> Result<Automation, AppError> {
    let draft = input_to_draft(state.inner(), input).await?;
    record_to_dto(store(state.inner()).update(id, draft, Utc::now()).await?)
}

#[tauri::command]
pub async fn automation_set_enabled(
    state: tauri::State<'_, AppState>,
    id: Uuid,
    enabled: bool,
) -> Result<(), AppError> {
    store(state.inner())
        .set_enabled(id, enabled, Utc::now())
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn automation_delete(
    state: tauri::State<'_, AppState>,
    id: Uuid,
) -> Result<(), AppError> {
    store(state.inner()).delete(id).await?;
    Ok(())
}

#[tauri::command]
pub async fn automation_runs(
    state: tauri::State<'_, AppState>,
    automation_id: Uuid,
    limit: Option<i64>,
) -> Result<Vec<AutomationRun>, AppError> {
    store(state.inner())
        .runs(automation_id, limit.unwrap_or(20))
        .await?
        .into_iter()
        .map(run_to_dto)
        .collect()
}

#[tauri::command]
pub async fn automation_unseen_failures(
    state: tauri::State<'_, AppState>,
) -> Result<i64, AppError> {
    store(state.inner())
        .unseen_failure_count()
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn automation_mark_seen(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    store(state.inner()).mark_all_seen().await?;
    Ok(())
}

#[tauri::command]
pub async fn automation_preview_next_runs(
    cron: String,
    timezone: String,
    count: Option<usize>,
) -> Result<Vec<DateTime<Utc>>, AppError> {
    ScheduleService::new(SystemClock)
        .preview(
            &ScheduleSpec::Schedule { cron, timezone },
            count.unwrap_or(5),
        )
        .map_err(|error| AppError::BadRequest(error.to_string()))
}

#[tauri::command]
pub async fn automation_run_now(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: Uuid,
) -> Result<AutomationRun, AppError> {
    let data_dir_key = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Internal(error.to_string()))?
        .to_string_lossy()
        .to_string();
    if !OWNED_DATA_DIRS
        .lock()
        .expect("Automation ownership registry poisoned")
        .contains(&data_dir_key)
    {
        return Err(AppError::Conflict(
            "this host does not own the Automation Engine lease".to_string(),
        ));
    }
    let automation_store = store(state.inner());
    let run = automation_store.run_now(id, Utc::now()).await?;
    let dto = run_to_dto(run.clone())?;
    if run.snapshot.status == RunStatus::Running {
        tauri::async_runtime::spawn(execute_run(
            app,
            ClaimedRun {
                run_id: run.snapshot.run_id,
                automation_id: id,
                scheduled_for: run.started_at,
                next_run_at: None,
            },
        ));
    }
    Ok(dto)
}

#[tauri::command]
pub async fn automation_cancel_run(
    state: tauri::State<'_, AppState>,
    run_id: Uuid,
) -> Result<(), AppError> {
    let automation_store = store(state.inner());
    if !automation_store.request_cancel(run_id).await? {
        return Err(AppError::BadRequest(format!(
            "automation run {run_id} is not running"
        )));
    }
    let run = automation_store
        .run(run_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("automation run {run_id} not found")))?;
    if reconcile_run_terminal(state.inner(), &automation_store, &run).await? {
        return Ok(());
    }
    if let Some(conversation_id) = run.snapshot.conversation_id {
        ConversationSessionService::new(state.conversation_context())
            .cancel_turn(
                conversation_id,
                Some("automation run cancelled".to_string()),
            )
            .await?;
        let refreshed = automation_store
            .run(run_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("automation run {run_id} not found")))?;
        reconcile_run_terminal(state.inner(), &automation_store, &refreshed).await?;
    }
    Ok(())
}

pub fn start_automation_engine(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let data_dir = match app.path().app_data_dir() {
            Ok(path) => path,
            Err(error) => {
                tracing::warn!("automation data directory unavailable: {error}");
                return;
            }
        };
        let key = data_dir.to_string_lossy().to_string();
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
                    execute_run(app.clone(), run).await;
                }
            }
            Err(error) => tracing::warn!("automation startup reconciliation failed: {error}"),
        }
        let service = engine.with_claim_store(automation_store, SystemClock);
        let mut interval = tokio::time::interval(Duration::from_secs(POLL_INTERVAL_SECS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(error) = reconcile_running_turns(&app).await {
                tracing::warn!("automation terminal reconciliation failed: {error}");
            }
            match service.tick().await {
                Ok(claimed) => {
                    for run in claimed {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            execute_run(app, run).await;
                        });
                    }
                }
                Err(error) => tracing::warn!("automation tick failed: {error}"),
            }
        }
    });
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

async fn execute_run(app: AppHandle, claimed: ClaimedRun) {
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
    let runner = AutomationRunner::new(
        automation_store,
        TauriWorkspacePreparer { app: app.clone() },
        TauriTurnLauncher { app },
    );
    if let Err(error) = runner
        .execute(&RunExecutionRequest {
            run_id: claimed.run_id,
            automation_id: claimed.automation_id,
            launch_spec: automation.launch_spec,
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
                            .unwrap_or_else(|| "main".to_string()),
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
                for repo in repos {
                    let clean = match state.deployment.git().is_worktree_clean(&repo.path) {
                        Ok(clean) => clean,
                        Err(error) => {
                            let _ = automation_store.release_shared_root(request.run_id).await;
                            return Err(workspace_adapter_error(error));
                        }
                    };
                    if !clean {
                        let _ = automation_store.release_shared_root(request.run_id).await;
                        return Err(WorkspaceError::DirtySharedRoot);
                    }
                    let current = match state.deployment.git().get_current_branch(&repo.path) {
                        Ok(current) => current,
                        Err(error) => {
                            let _ = automation_store.release_shared_root(request.run_id).await;
                            return Err(workspace_adapter_error(error));
                        }
                    };
                    if let Some(expected) = request.target.branch.as_ref()
                        && expected != &current
                    {
                        let _ = automation_store.release_shared_root(request.run_id).await;
                        return Err(WorkspaceError::WrongBranch {
                            expected: expected.clone(),
                            actual: current,
                        });
                    }
                }
                workspace
            }
        };
        if let Err(error) = state
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
        {
            if shared_root_leased {
                let _ = automation_store.release_shared_root(request.run_id).await;
            }
            return Err(workspace_adapter_error(error));
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
        for action in &spec.plugin_actions {
            let manifest = state.office_runtime.bundled_plugin();
            if action.plugin_id.as_str() != manifest.id.as_str() {
                return Err(RunError::Launcher(format!(
                    "plugin {} is unavailable",
                    action.plugin_id.as_str()
                )));
            }
            state
                .office_runtime
                .resolve_bundled_action(action.action.id.as_str())
                .map_err(|error| RunError::Launcher(error.to_string()))?;
            plugins.push(ComponentVersionEvidence {
                id: manifest.id.as_str().to_string(),
                version: manifest.version.clone(),
            });
            let lock = state
                .office_runtime
                .detect()
                .await
                .map_err(|error| RunError::Launcher(error.to_string()))?
                .ok_or_else(|| {
                    RunError::Launcher(format!(
                        "plugin {} has no resolved ToolInstallationLock",
                        manifest.id.as_str()
                    ))
                })?;
            tool_locks.push(ToolLockVersionEvidence {
                tool_id: lock.tool_id,
                version: lock.version,
                target: lock.target,
                sha256: lock.sha256,
            });
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
        let text = spec
            .prompt_blocks
            .iter()
            .map(|block| match block {
                PromptBlock::Text { text } => text.as_str(),
            })
            .collect::<Vec<_>>()
            .join("\n");
        let (turn, _) = ConversationSessionService::new(state.conversation_context())
            .start_turn(ConversationStartTurnInput {
                agent_id: spec.agent.agent_id.clone(),
                workspace_id: workspace.workspace_id,
                conversation_id,
                executor_profile_id: spec.agent.executor_profile_id.clone(),
                text,
                images: Vec::new(),
                mode_override: spec.mode_id.clone(),
                config_overrides: spec.config_values.clone(),
            })
            .await
            .map_err(|error| RunError::Launcher(error.to_string()))?;
        Ok(turn.turn_id)
    }
}

async fn input_to_draft(
    state: &AppState,
    input: AutomationInput,
) -> Result<AutomationDraft, AppError> {
    let workspace = resolve_project_workspace(state, input.project_id, None).await?;
    let root_folder = if let Some(path) = workspace.container_ref.clone() {
        path
    } else {
        ProjectRepo::find_repos_for_project(&state.deployment.db().pool, input.project_id)
            .await?
            .into_iter()
            .next()
            .map(|repo| repo.path.to_string_lossy().to_string())
            .ok_or_else(|| AppError::BadRequest("project has no repository".to_string()))?
    };
    let agent_id = agents::AgentId::parse(
        input
            .executor
            .as_deref()
            .unwrap_or("codex")
            .to_ascii_lowercase(),
    )
    .map_err(|error| AppError::BadRequest(error.to_string()))?;
    let plugin_actions = input
        .plugin_action_json
        .as_deref()
        .map(parse_plugin_action_ref)
        .transpose()?
        .into_iter()
        .collect();
    let trigger = if input.trigger_kind == "cron" {
        let cron = input
            .cron
            .clone()
            .filter(|cron| !cron.trim().is_empty())
            .ok_or_else(|| {
                AppError::BadRequest("scheduled automation requires cron".to_string())
            })?;
        ScheduleSpec::Schedule {
            cron,
            timezone: iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string()),
        }
    } else {
        ScheduleSpec::Manual
    };
    let isolation = if input.isolation == "shared_in_root" {
        IsolationSpec::SharedInRoot
    } else {
        IsolationSpec::WorktreePerRun
    };
    let draft = AutomationDraft {
        name: input.name.clone(),
        enabled: input.enabled,
        trigger,
        launch: AutomationDraftInput(TurnLaunchSpecInput {
            prompt_blocks: vec![PromptBlock::Text {
                text: input.prompt.clone(),
            }],
            display_text: input.prompt,
            agent: AgentSelectionIntent {
                agent_id,
                executor_profile_id: None,
            },
            mode_id: None,
            config_values: Vec::new(),
            plugin_actions,
            skills: Vec::new(),
            workspace: WorkspaceTarget {
                project_id: input.project_id,
                root_folder,
                branch: Some(workspace.branch),
                isolation,
            },
            label_snapshot: Some(input.name),
        }),
    };
    TurnLaunchSpec::from_automation_draft(draft.launch.clone())
        .and_then(|spec| {
            spec.validate_plugin_actions(&OfficeActionCatalog {
                manifest: state.office_runtime.bundled_plugin(),
            })
        })
        .map_err(|error| AppError::BadRequest(format!("{}: {error}", error.code())))?;
    Ok(draft)
}

fn parse_plugin_action_ref(json: &str) -> Result<automation::PluginActionRef, AppError> {
    let mut value: serde_json::Value = serde_json::from_str(json)
        .map_err(|error| AppError::BadRequest(format!("invalid PluginAction: {error}")))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| AppError::BadRequest("PluginAction must be an object".to_string()))?;
    let plugin_id = object
        .remove("pluginId")
        .ok_or_else(|| AppError::BadRequest("PluginAction.pluginId is required".to_string()))?;
    let action_id = object
        .remove("actionId")
        .ok_or_else(|| AppError::BadRequest("PluginAction.actionId is required".to_string()))?;
    object.insert("id".to_string(), action_id);
    Ok(automation::PluginActionRef {
        plugin_id: serde_json::from_value::<PluginId>(plugin_id)
            .map_err(|error| AppError::BadRequest(error.to_string()))?,
        action: serde_json::from_value::<PluginAction>(value)
            .map_err(|error| AppError::BadRequest(error.to_string()))?,
    })
}

fn record_to_dto(record: AutomationRecord) -> Result<Automation, AppError> {
    let (trigger_kind, cron) = match &record.trigger {
        ScheduleSpec::Manual => ("manual".to_string(), None),
        ScheduleSpec::Schedule { cron, .. } => ("cron".to_string(), Some(cron.clone())),
    };
    let plugin_action_json = record
        .launch_spec
        .plugin_actions
        .first()
        .map(flatten_plugin_action)
        .transpose()?;
    Ok(Automation {
        id: record.id,
        name: record.name,
        project_id: record.launch_spec.workspace.project_id,
        executor: Some(record.launch_spec.agent.agent_id.into_string()),
        prompt: record.launch_spec.display_text,
        plugin_action_json,
        isolation: match record.launch_spec.workspace.isolation {
            IsolationSpec::WorktreePerRun => "worktree_per_run".to_string(),
            IsolationSpec::SharedInRoot => "shared_in_root".to_string(),
        },
        trigger_kind,
        cron,
        enabled: record.enabled,
        next_run_at: record.next_run_at,
        created_at: record.created_at,
        updated_at: record.updated_at,
    })
}

fn flatten_plugin_action(reference: &automation::PluginActionRef) -> Result<String, AppError> {
    let mut action = serde_json::to_value(&reference.action)
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let object = action
        .as_object_mut()
        .ok_or_else(|| AppError::Internal("PluginAction was not an object".to_string()))?;
    let action_id = object
        .remove("id")
        .ok_or_else(|| AppError::Internal("PluginAction had no id".to_string()))?;
    object.insert(
        "pluginId".to_string(),
        serde_json::Value::String(reference.plugin_id.as_str().to_string()),
    );
    object.insert("actionId".to_string(), action_id);
    serde_json::to_string(&action).map_err(|error| AppError::Internal(error.to_string()))
}

fn run_to_dto(run: AutomationRunRecord) -> Result<AutomationRun, AppError> {
    Ok(AutomationRun {
        id: run.snapshot.run_id,
        automation_id: run.snapshot.automation_id,
        status: match run.snapshot.status {
            RunStatus::Running => "running",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Interrupted => "interrupted",
            RunStatus::Skipped => "skipped",
        }
        .to_string(),
        conversation_id: run.snapshot.conversation_id,
        summary: run.summary,
        error: run.snapshot.error,
        seen: run.seen,
        started_at: run.started_at,
        finished_at: run.finished_at,
    })
}

fn workspace_adapter_error(error: impl std::fmt::Display) -> WorkspaceError {
    WorkspaceError::Adapter(error.to_string())
}
