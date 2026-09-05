//! Thin Tauri adapter for the transport-neutral Automation v2 core.

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
    AgentRuntimeVersionEvidence, AutomationDraft, AutomationDraftInput, AutomationEngine,
    AutomationRetentionService, AutomationRunner, AutomationSpec, AutomationTarget, ClaimedRun,
    ComponentVersionEvidence, ConnectionLaunch, FileOwnerLock, IsolationSpec,
    PORTABLE_AUTOMATION_SPEC_VERSION, PluginActionCatalogPort, PortableAutomationTarget,
    PortableTurnLaunchSpec, PortableWorkflowLaunchSpec, PortableWorkspaceRef, PreparedWorkspace,
    ResolvedVersionEvidence, RetentionError, RetentionPolicy, RunError, RunExecutionRequest,
    RunStatus, ScheduleService, ScheduleSpec, StartupReconciler, SystemClock,
    ToolLockVersionEvidence, TurnLaunchSpec, TurnLaunchSpecInput, TurnLauncherPort,
    WorkflowAutomationDraft, WorkspaceError, WorkspacePreparationRequest, WorkspacePreparerPort,
    WorkspaceRetentionPort, WorkspaceTarget,
};
use chrono::{DateTime, Utc};
use db::models::{
    automation_v2::{AutomationRecord, AutomationRunRecord, SqliteAutomationStore},
    conversation_turn::ConversationTurnRecord,
    project::Project,
    project_repo::ProjectRepo,
    session::{CreateSession, Session},
    workspace::Workspace,
};
use plugins::PromptBlock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use workflows::WorkflowStore;

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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDraftRequest {
    pub name: String,
    pub enabled: bool,
    pub trigger: ScheduleSpec,
    pub launch: AutomationDraftInput,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationView {
    pub id: Uuid,
    pub name: String,
    pub enabled: bool,
    pub spec_version: u16,
    pub trigger: ScheduleSpec,
    pub next_run_at: Option<DateTime<Utc>>,
    pub target: AutomationTarget,
    pub launch: Option<TurnLaunchSpec>,
    pub migration_required: bool,
    pub unseen_failure_count: i64,
    pub last_run_status: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunView {
    pub id: Uuid,
    pub automation_id: Uuid,
    pub trigger: String,
    pub scheduled_for: Option<DateTime<Utc>>,
    pub status: String,
    pub cancellation_requested: bool,
    pub conversation_id: Option<Uuid>,
    pub turn_id: Option<Uuid>,
    pub workspace_id: Option<Uuid>,
    pub workflow_run_id: Option<Uuid>,
    pub stop_reason: Option<String>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub seen: bool,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTemplateView {
    pub id: String,
    pub draft: AutomationDraft,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct AutomationEngineStatus {
    pub active: bool,
}

struct EngineOwnershipMarker {
    data_dir_key: String,
}

struct UnifiedActionCatalog {
    actions: HashSet<(String, String)>,
}

impl PluginActionCatalogPort for UnifiedActionCatalog {
    fn contains(&self, reference: &automation::PluginActionRef) -> bool {
        self.actions.contains(&(
            reference.plugin_id.as_str().to_owned(),
            reference.action.id.as_str().to_owned(),
        ))
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

/// Lease identity is the Host data directory, the same path `FileOwnerLock` uses.
/// Tauri `app_data_dir()` is a different folder in debug (`dev_assets/` vs
/// Application Support), so status and run gates must not use it.
fn automation_engine_data_dir_key() -> String {
    utils::assets::host_data_dir()
        .to_string_lossy()
        .into_owned()
}

fn this_host_owns_automation_engine() -> bool {
    OWNED_DATA_DIRS
        .lock()
        .expect("Automation ownership registry poisoned")
        .contains(&automation_engine_data_dir_key())
}

fn require_automation_engine_owner() -> Result<(), AppError> {
    if this_host_owns_automation_engine() {
        Ok(())
    } else {
        Err(AppError::Conflict(
            "this host does not own the Automation Engine lease".to_string(),
        ))
    }
}

fn store(state: &AppState) -> SqliteAutomationStore {
    SqliteAutomationStore::new(state.deployment.db().pool.clone())
}

#[tauri::command]
pub async fn automation_engine_status() -> Result<AutomationEngineStatus, AppError> {
    Ok(AutomationEngineStatus {
        active: this_host_owns_automation_engine(),
    })
}

#[tauri::command]
pub async fn automation_list(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AutomationView>, AppError> {
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
    input: AutomationDraftRequest,
) -> Result<AutomationView, AppError> {
    let draft = input_to_draft(state.inner(), input).await?;
    record_to_dto(store(state.inner()).create(draft, Utc::now()).await?)
}

#[tauri::command]
pub async fn automation_create_workflow(
    state: tauri::State<'_, AppState>,
    input: WorkflowAutomationDraft,
) -> Result<AutomationView, AppError> {
    record_to_dto(
        store(state.inner())
            .create_workflow(input, Utc::now())
            .await?,
    )
}

#[tauri::command]
pub async fn automation_update(
    state: tauri::State<'_, AppState>,
    id: Uuid,
    input: AutomationDraftRequest,
) -> Result<AutomationView, AppError> {
    let draft = input_to_draft(state.inner(), input).await?;
    record_to_dto(store(state.inner()).update(id, draft, Utc::now()).await?)
}

#[tauri::command]
pub async fn automation_update_workflow(
    state: tauri::State<'_, AppState>,
    id: Uuid,
    input: WorkflowAutomationDraft,
) -> Result<AutomationView, AppError> {
    record_to_dto(
        store(state.inner())
            .update_workflow(id, input, Utc::now())
            .await?,
    )
}

async fn portable_workspace(
    state: &AppState,
    workspace: &WorkspaceTarget,
) -> Result<PortableWorkspaceRef, AppError> {
    let project = Project::find_by_id(&state.deployment.db().pool, workspace.project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Automation project not found".to_string()))?;
    let root_folder_name = std::path::Path::new(&workspace.root_folder)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::Conflict("Automation workspace root is not portable".to_string()))?
        .to_string();
    Ok(PortableWorkspaceRef {
        project_name: project.name,
        root_folder_name,
        branch: workspace.branch.clone(),
        isolation: workspace.isolation.clone(),
    })
}

async fn resolve_portable_workspace(
    state: &AppState,
    reference: &PortableWorkspaceRef,
) -> Result<WorkspaceTarget, AppError> {
    let projects = Project::find_all(&state.deployment.db().pool).await?;
    let matches = projects
        .into_iter()
        .filter(|project| project.name == reference.project_name)
        .collect::<Vec<_>>();
    let [project] = matches.as_slice() else {
        return Err(AppError::Conflict(format!(
            "Project `{}` is missing or ambiguous",
            reference.project_name
        )));
    };
    let repos =
        ProjectRepo::find_repos_for_project(&state.deployment.db().pool, project.id).await?;
    let roots = repos
        .into_iter()
        .filter(|repo| {
            repo.name == reference.root_folder_name
                || std::path::Path::new(&repo.path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    == Some(reference.root_folder_name.as_str())
        })
        .collect::<Vec<_>>();
    let [repo] = roots.as_slice() else {
        return Err(AppError::Conflict(format!(
            "Workspace root `{}` is missing or ambiguous in project `{}`",
            reference.root_folder_name, reference.project_name
        )));
    };
    Ok(WorkspaceTarget {
        project_id: project.id,
        root_folder: repo.path.to_string_lossy().into_owned(),
        branch: reference.branch.clone(),
        isolation: reference.isolation.clone(),
    })
}

#[tauri::command]
pub async fn automation_export_spec(
    state: tauri::State<'_, AppState>,
    id: Uuid,
) -> Result<String, AppError> {
    let record = store(state.inner())
        .find(id)
        .await?
        .ok_or_else(|| AppError::NotFound("Automation not found".to_string()))?;
    let target = match record.target {
        AutomationTarget::Turn(spec) => PortableAutomationTarget::Turn(PortableTurnLaunchSpec {
            prompt_blocks: spec.prompt_blocks,
            display_text: spec.display_text,
            agent: spec.agent,
            mode_id: spec.mode_id,
            config_values: spec.config_values,
            plugin_actions: spec.plugin_actions,
            skills: spec.skills,
            workspace: portable_workspace(state.inner(), &spec.workspace).await?,
            label_snapshot: spec.label_snapshot,
        }),
        AutomationTarget::Workflow(spec) => {
            let version = WorkflowStore::new(state.deployment.db().pool.clone())
                .version(spec.definition_version_id)
                .await
                .map_err(|error| AppError::Internal(error.to_string()))?;
            let source_path = version.source_path.ok_or_else(|| {
                AppError::Conflict(
                    "Workflow version has no portable source identity; publish it from Studio first"
                        .to_string(),
                )
            })?;
            PortableAutomationTarget::Workflow(PortableWorkflowLaunchSpec {
                source_path,
                version_digest: version.digest,
                input: spec.input,
                policy_override: spec.policy_override,
                workspace: portable_workspace(state.inner(), &spec.workspace).await?,
            })
        }
    };
    let spec = AutomationSpec {
        format_version: PORTABLE_AUTOMATION_SPEC_VERSION,
        name: record.name,
        trigger: record.trigger,
        target,
    };
    spec.validate()
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    serde_json::to_string_pretty(&spec).map_err(AppError::from)
}

#[tauri::command]
pub async fn automation_import_spec(
    state: tauri::State<'_, AppState>,
    json: String,
) -> Result<AutomationView, AppError> {
    let spec: AutomationSpec = serde_json::from_str(&json)
        .map_err(|error| AppError::BadRequest(format!("Invalid Automation JSON: {error}")))?;
    spec.validate()
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    let record = match spec.target {
        PortableAutomationTarget::Turn(launch) => {
            let workspace = resolve_portable_workspace(state.inner(), &launch.workspace).await?;
            let draft = AutomationDraft {
                name: spec.name,
                enabled: false,
                trigger: spec.trigger,
                launch: AutomationDraftInput(TurnLaunchSpecInput {
                    prompt_blocks: launch.prompt_blocks,
                    display_text: launch.display_text,
                    agent: launch.agent,
                    mode_id: launch.mode_id,
                    config_values: launch.config_values,
                    plugin_actions: launch.plugin_actions,
                    skills: launch.skills,
                    workspace,
                    label_snapshot: launch.label_snapshot,
                }),
            };
            store(state.inner()).create(draft, Utc::now()).await?
        }
        PortableAutomationTarget::Workflow(launch) => {
            let workspace = resolve_portable_workspace(state.inner(), &launch.workspace).await?;
            let version = WorkflowStore::new(state.deployment.db().pool.clone())
                .version_by_source_digest(&launch.source_path, &launch.version_digest)
                .await
                .map_err(|error| AppError::Conflict(error.to_string()))?;
            store(state.inner())
                .create_workflow(
                    WorkflowAutomationDraft {
                        name: spec.name,
                        enabled: false,
                        trigger: spec.trigger,
                        launch: automation::WorkflowLaunchSpec {
                            spec_version: automation::WORKFLOW_AUTOMATION_SPEC_VERSION,
                            definition_version_id: version.id,
                            input: launch.input,
                            policy_override: launch.policy_override,
                            workspace,
                        },
                    },
                    Utc::now(),
                )
                .await?
        }
    };
    record_to_dto(record)
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
) -> Result<Vec<AutomationRunView>, AppError> {
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
pub async fn automation_templates() -> Result<Vec<AutomationTemplateView>, AppError> {
    Ok(automation::BuiltinTemplateCatalog::all()
        .into_iter()
        .map(|template| AutomationTemplateView {
            id: template.id,
            draft: template.draft,
        })
        .collect())
}

#[tauri::command]
pub async fn automation_run_now(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: Uuid,
    debug_step_id: Option<String>,
) -> Result<AutomationRunView, AppError> {
    require_automation_engine_owner()?;
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
            debug_step_id,
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
    } else if let Some(workflow_run_id) = run.workflow_run_id {
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
                        // Empty string means "use the repository's actual
                        // branch"; the backend resolves it instead of assuming
                        // a hard-coded "main" that may not exist.
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

async fn input_to_draft(
    state: &AppState,
    input: AutomationDraftRequest,
) -> Result<AutomationDraft, AppError> {
    let mut launch = input.launch.0;
    // Saving a draft must not prepare a Workspace or check out its selected
    // branch. The frontend only supplies the durable project identity; path
    // authority remains with the backend project model until execution.
    launch.workspace.root_folder = ProjectRepo::find_repos_for_project(
        &state.deployment.db().pool,
        launch.workspace.project_id,
    )
    .await?
    .into_iter()
    .next()
    .map(|repo| repo.path.to_string_lossy().to_string())
    .ok_or_else(|| AppError::BadRequest("project has no repository".to_string()))?;
    launch.workspace.branch = launch
        .workspace
        .branch
        .map(|branch| branch.trim().to_string())
        .filter(|branch| !branch.is_empty());
    let draft = AutomationDraft {
        name: input.name,
        enabled: input.enabled,
        trigger: input.trigger,
        launch: AutomationDraftInput(launch),
    };
    let action_catalog = unified_action_catalog(state).await?;
    TurnLaunchSpec::from_automation_draft(draft.launch.clone())
        .and_then(|spec| spec.validate_plugin_actions(&action_catalog))
        .map_err(|error| AppError::BadRequest(format!("{}: {error}", error.code())))?;
    Ok(draft)
}

async fn unified_action_catalog(state: &AppState) -> Result<UnifiedActionCatalog, AppError> {
    let actions = state
        .plugin_control_plane
        .catalog()
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
        .into_iter()
        .filter(|plugin| plugin.activation == plugins::PluginActivation::Enabled)
        .flat_map(|plugin| {
            let plugin_id = plugin.id().to_owned();
            plugin
                .package
                .invocations
                .into_iter()
                .filter(|invocation| invocation.kind == plugins::InvocationKind::Action)
                .map(move |invocation| (plugin_id.clone(), invocation.id))
        })
        .collect();
    Ok(UnifiedActionCatalog { actions })
}

fn record_to_dto(record: AutomationRecord) -> Result<AutomationView, AppError> {
    let launch = match &record.target {
        AutomationTarget::Turn(spec) => Some(spec.clone()),
        AutomationTarget::Workflow(_) => None,
    };
    Ok(AutomationView {
        id: record.id,
        name: record.name,
        enabled: record.enabled,
        spec_version: record.spec_version,
        trigger: record.trigger,
        next_run_at: record.next_run_at,
        target: record.target,
        launch,
        migration_required: record.legacy_migration_status == "migration_required",
        unseen_failure_count: record.unseen_failure_count,
        last_run_status: record.last_run_status,
        created_at: record.created_at,
        updated_at: record.updated_at,
    })
}

fn run_to_dto(run: AutomationRunRecord) -> Result<AutomationRunView, AppError> {
    Ok(AutomationRunView {
        id: run.snapshot.run_id,
        automation_id: run.snapshot.automation_id,
        trigger: run.trigger,
        scheduled_for: run.scheduled_for,
        status: match run.snapshot.status {
            RunStatus::Running => "running",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Interrupted => "interrupted",
            RunStatus::Skipped => "skipped",
        }
        .to_string(),
        cancellation_requested: run.snapshot.cancellation_requested,
        conversation_id: run.snapshot.conversation_id,
        turn_id: run.snapshot.turn_id,
        workspace_id: run.snapshot.workspace_id,
        workflow_run_id: run.workflow_run_id,
        stop_reason: run.stop_reason,
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

#[cfg(test)]
mod tests {
    use super::*;

    // Async-aware so the guard may be held across the awaits below without
    // risking a runtime deadlock.
    static OWNERSHIP_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn engine_status_is_active_when_this_host_holds_the_host_data_dir_lease() {
        let _guard = OWNERSHIP_TEST_LOCK.lock().await;
        let _marker = EngineOwnershipMarker::register(automation_engine_data_dir_key());
        let status = automation_engine_status().await.expect("engine status");
        assert!(status.active);
        assert!(require_automation_engine_owner().is_ok());
    }

    #[tokio::test]
    async fn engine_status_ignores_a_lease_registered_on_a_foreign_data_dir() {
        let _guard = OWNERSHIP_TEST_LOCK.lock().await;
        let _marker =
            EngineOwnershipMarker::register("/tmp/com.vibex.app-app-data-dir".to_string());
        let status = automation_engine_status().await.expect("engine status");
        assert!(!status.active);
        let error = require_automation_engine_owner().expect_err("foreign dir is not owner");
        assert!(
            error
                .to_string()
                .contains("does not own the Automation Engine lease")
        );
    }

    #[test]
    fn engine_lease_key_is_the_host_data_directory() {
        assert_eq!(
            automation_engine_data_dir_key(),
            utils::assets::host_data_dir().to_string_lossy().as_ref()
        );
    }
}
