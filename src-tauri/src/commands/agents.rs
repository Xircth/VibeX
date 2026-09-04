use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
};

use agents::{
    AgentAutoApproveMode, AgentAvailableCommand, AgentConnectionId, AgentConnectionSnapshot,
    AgentContentBlock, AgentListedSession, AgentManagementSnapshot, AgentPermissionId,
    AgentPermissionResponse, AgentPreparedSessionSnapshot, AgentPromptId, AgentPromptSnapshot,
    AgentSessionControlsSnapshot, AgentSessionId, AgentSessionListPage, AgentSessionSnapshot,
    AgentTerminalId, AgentTerminalOutputSnapshot, CancelAgentPromptInput, ConnectAgentInput,
    LaunchComponentEvidence, LaunchGate, LaunchGateError, RespondAgentPermissionInput,
    ResumeAgentSessionInput, RuntimeSnapshot, SendAgentPromptInput, SessionAuthenticationEvidence,
    SessionControlPreferences, SessionGate, SessionGateInput, SessionLaunchLock,
    discover_path_acp_launch_lock, lifecycle_ready_for_path_acp,
    resolve_session_authentication_evidence, terminal::agent_terminal_registry,
};
use api_types::{AgentAuthenticationStatus, AgentId, AgentLifecycleState};
use db::models::{
    agent_capability_catalog::AgentCapabilityCatalogRecord,
    agent_management::{SessionDefaultRecord, SessionDefaultRepository},
    conversation::DbConversationSummary,
    session::{CreateSession, Session, SessionStatus},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::agent_management::AgentManagementApplicationService;
use sha2::{Digest, Sha256};
use sqlx::Row;
use utils::path::remove_dir_all_retrying;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

impl From<agents::AgentError> for AppError {
    fn from(error: agents::AgentError) -> Self {
        match error {
            agents::AgentError::ConnectionNotFound(message) => AppError::NotFound(format!(
                "Agent Runtime connection `{message}` was not found"
            )),
            agents::AgentError::SessionNotFound(message) => {
                AppError::NotFound(format!("Agent Runtime session `{message}` was not found"))
            }
            agents::AgentError::PromptNotFound(message) => {
                AppError::NotFound(format!("Agent Runtime prompt `{message}` was not found"))
            }
            agents::AgentError::SteeringUnsupported => {
                AppError::BadRequest("Agent does not support in-flight steering".to_string())
            }
            agents::AgentError::PromptConflict { expected, active } => AppError::Conflict(format!(
                "Active prompt changed: expected `{expected}`, active is `{active}`"
            )),
            agents::AgentError::UnsupportedAgent(message) => AppError::NotFound(format!(
                "Agent `{message}` is not registered in the local Runtime"
            )),
            agents::AgentError::UnsupportedPlatform { agent, platform } => AppError::BadRequest(
                format!("Agent `{agent}` is unsupported on platform `{platform}`"),
            ),
            agents::AgentError::AuthenticationRequired(message) => {
                AppError::BadRequest(format!("Agent 需要先完成认证：{message}"))
            }
            agents::AgentError::SessionLoadFailed(reason) => {
                AppError::BadRequest(match reason {
                    agents::SessionLoadFailureReason::ResourceNotFound => {
                        "代理侧已不存在该会话。可见历史仍在，但 Agent 隐藏上下文已丢失。确认重新绑定后才能继续。".to_string()
                    }
                    agents::SessionLoadFailureReason::AuthenticationRequired { message } => message,
                    agents::SessionLoadFailureReason::Unsupported => {
                        "该代理无法恢复原会话。确认重新绑定后将冷启动，不会保留 Agent 侧上下文。".to_string()
                    }
                    agents::SessionLoadFailureReason::Other { message } => message,
                })
            }
            agents::AgentError::InvalidDistribution(message)
            | agents::AgentError::Runtime(message) => AppError::Internal(message),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectRequest {
    pub agent_id: AgentId,
    pub workspace_id: String,
    pub working_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNewSessionRequest {
    pub connection_id: String,
    pub acp_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPrepareSessionRequest {
    pub agent_id: AgentId,
    pub workspace_id: String,
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreparedSessionModeRequest {
    pub session_id: String,
    pub mode_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreparedSessionConfigRequest {
    pub session_id: String,
    pub key: String,
    pub value: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendPromptRequest {
    pub connection_id: String,
    pub session_id: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCancelPromptRequest {
    pub connection_id: String,
    pub session_id: String,
    pub prompt_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRespondPermissionRequest {
    pub connection_id: String,
    pub permission_id: String,
    pub response: AgentPermissionResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionRequest {
    pub connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResumeSessionRequest {
    pub agent_id: AgentId,
    pub workspace_id: String,
    pub working_dir: String,
    pub session_id: String,
    pub external_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTerminalSnapshotRequest {
    pub terminal_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentListSessionsRequest {
    pub agent_id: AgentId,
    pub workspace_id: String,
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDeleteRemoteSessionRequest {
    pub agent_id: AgentId,
    pub workspace_id: String,
    pub acp_session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentImportRemoteSessionRequest {
    pub agent_id: AgentId,
    pub workspace_id: String,
    pub acp_session_id: String,
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionDefaultsWriteRequest {
    pub agent_id: AgentId,
    pub defaults: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionDefaultsView {
    pub values: BTreeMap<String, serde_json::Value>,
    pub stale_ids: Vec<String>,
}

const CAPABILITY_CATALOG_TTL: chrono::Duration = chrono::Duration::minutes(10);

/// Read the matching persisted capability catalog. This command is deliberately
/// side-effect free: opening a selector must never start an ACP process.
#[tauri::command]
pub async fn agent_capability_catalog(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<Option<AgentSessionControlsSnapshot>, AppError> {
    let pool = &state.deployment.db().pool;
    read_matching_open_capability_catalog_for_pool(pool, &agent_id).await
}

#[tauri::command]
pub async fn agent_capability_catalog_fresh(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<bool, AppError> {
    let pool = &state.deployment.db().pool;
    let launch = match agent_runtime_launch_settings_from_pool(pool, &agent_id).await {
        Ok(launch) => launch,
        Err(_) => return Ok(false),
    };
    let fingerprint = open_capability_catalog_fingerprint(pool, &launch.launch_lock).await?;
    Ok(
        match AgentCapabilityCatalogRecord::find_matching(pool, agent_id.as_str(), &fingerprint)
            .await?
        {
            Some(record) => !record.is_stale_at(chrono::Utc::now(), CAPABILITY_CATALOG_TTL),
            None => false,
        },
    )
}

fn catalog_controls_if_fresh(
    record: AgentCapabilityCatalogRecord,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<AgentSessionControlsSnapshot> {
    if record.is_stale_at(now, CAPABILITY_CATALOG_TTL) {
        return None;
    }
    serde_json::from_str(&record.controls_json).ok()
}

async fn read_matching_open_capability_catalog_for_pool(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<Option<AgentSessionControlsSnapshot>, AppError> {
    let launch = match agent_runtime_launch_settings_from_pool(pool, agent_id).await {
        Ok(launch) => launch,
        Err(_) => return Ok(None),
    };
    let fingerprint = open_capability_catalog_fingerprint(pool, &launch.launch_lock).await?;
    let Some(record) =
        AgentCapabilityCatalogRecord::find_matching(pool, agent_id.as_str(), &fingerprint).await?
    else {
        return Ok(None);
    };
    Ok(catalog_controls_if_fresh(record, chrono::Utc::now()))
}

async fn open_capability_catalog_fingerprint(
    pool: &sqlx::SqlitePool,
    launch_lock: &SessionLaunchLock,
) -> Result<String, AppError> {
    let mut digest = Sha256::new();
    // v3 invalidates catalogs captured before effort/permission were merged
    // from Grok's vendor `_meta` into the standard session-control snapshot.
    digest.update(b"open-agent-capability-catalog-v3:");
    digest.update(launch_lock.agent_id.as_str().as_bytes());
    digest.update(b"\0");
    digest.update(
        launch_lock
            .absolute_acp_program
            .to_string_lossy()
            .as_bytes(),
    );
    for argument in &launch_lock.args {
        digest.update(b"\0arg:");
        digest.update(argument.as_bytes());
    }
    for (key, value) in &launch_lock.env {
        digest.update(b"\0env:");
        digest.update(key.as_bytes());
        digest.update(b"=");
        digest.update(value.as_bytes());
    }
    digest.update(b"\0runtime:");
    digest.update(launch_lock.runtime_version.as_bytes());
    digest.update(b"\0acp:");
    digest.update(launch_lock.acp_version.as_bytes());
    if let Some(row) = sqlx::query(
        r#"SELECT updated_at, COALESCE(config_json, ''), COALESCE(env_json, '')
           FROM agent_setting WHERE agent_type = ?"#,
    )
    .bind(launch_lock.agent_id.as_str())
    .fetch_optional(pool)
    .await?
    {
        digest.update(b"\0setting:");
        digest.update(row.try_get::<String, _>(0)?.as_bytes());
        digest.update(row.try_get::<String, _>(1)?.as_bytes());
        digest.update(row.try_get::<String, _>(2)?.as_bytes());
    }
    for row in sqlx::query(
        r#"SELECT provider_id, revision, fingerprint, updated_at
           FROM agent_config_binding
           WHERE agent_id = ?
           ORDER BY provider_id"#,
    )
    .bind(launch_lock.agent_id.as_str())
    .fetch_all(pool)
    .await?
    {
        digest.update(b"\0config:");
        for index in 0..4 {
            digest.update(row.try_get::<String, _>(index)?.as_bytes());
            digest.update(b"\0");
        }
    }
    if let Some(row) = sqlx::query(
        r#"SELECT authentication, observation_generation,
                  runtime_available, acp_handshake, authentication_required
           FROM agent_probe WHERE agent_id = ?"#,
    )
    .bind(launch_lock.agent_id.as_str())
    .fetch_optional(pool)
    .await?
    {
        digest.update(b"\0auth:");
        digest.update(row.try_get::<String, _>(0)?.as_bytes());
        digest.update(b"\0");
        digest.update(row.try_get::<i64, _>(1)?.to_le_bytes());
        digest.update(b"\0");
        for index in 2..5 {
            digest.update(if row.try_get::<bool, _>(index)? {
                b"1"
            } else {
                b"0"
            });
            digest.update(b"\0");
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

/// Prompt enhancement uses the exact persisted catalogs used by session
/// creation. Candidate order follows the user's Agent bar order and no Agent
/// identity is privileged.
async fn prompt_enhancement_catalog_candidates(
    pool: &sqlx::SqlitePool,
) -> Result<Vec<(AgentId, Vec<(String, String)>)>, AppError> {
    let agent_ids = sqlx::query_scalar::<_, String>(
        r#"SELECT membership.agent_id
           FROM agent_membership membership
           JOIN agent_installation installation
             ON installation.agent_id = membership.agent_id
           WHERE membership.enabled = 1
             AND membership.retired = 0
             AND installation.current_lock_id IS NOT NULL
           ORDER BY membership.position, membership.agent_id"#,
    )
    .fetch_all(pool)
    .await?;
    let mut candidates = Vec::new();
    for raw_agent_id in agent_ids {
        let Ok(agent_id) = AgentId::parse(raw_agent_id) else {
            continue;
        };
        let Some(snapshot) =
            read_matching_open_capability_catalog_for_pool(pool, &agent_id).await?
        else {
            continue;
        };
        let selections = model_selections_from_capability_catalog(&snapshot);
        if !selections.is_empty() {
            candidates.push((agent_id, selections));
        }
    }
    Ok(candidates)
}

pub(crate) async fn prompt_enhancement_capability_catalog_models(
    pool: &sqlx::SqlitePool,
) -> Result<Vec<String>, AppError> {
    let mut models = Vec::new();
    for (_, candidate_selections) in prompt_enhancement_catalog_candidates(pool).await? {
        for (_, model) in candidate_selections {
            if !models.contains(&model) {
                models.push(model);
            }
        }
    }
    Ok(models)
}

fn model_selections_from_capability_catalog(
    snapshot: &AgentSessionControlsSnapshot,
) -> Vec<(String, String)> {
    let mut selections = Vec::new();
    for option in snapshot
        .config_options
        .iter()
        .filter(|option| option.category.as_deref() == Some("model"))
    {
        for choice in &option.choices {
            let Some(model) = choice.value.as_str().map(str::trim) else {
                continue;
            };
            if !model.is_empty()
                && !selections
                    .iter()
                    .any(|(key, existing)| key == &option.key && existing == model)
            {
                selections.push((option.key.clone(), model.to_string()));
            }
        }
    }
    selections
}

#[cfg(test)]
fn models_from_capability_catalog(snapshot: &AgentSessionControlsSnapshot) -> Vec<String> {
    let mut models = Vec::new();
    for (_, model) in model_selections_from_capability_catalog(snapshot) {
        if !models.contains(&model) {
            models.push(model);
        }
    }
    models
}

/// Discover and persist a verified catalog explicitly. Normal selector reads
/// stay side-effect free; the create form escalates here once when no matching
/// catalog or live-workspace snapshot exists.
#[tauri::command]
pub async fn agent_refresh_capability_catalog(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<bool, AppError> {
    refresh_capability_catalog_for_agent(&state, agent_id).await
}

async fn refresh_capability_catalog_for_agent(
    state: &AppState,
    agent_id: AgentId,
) -> Result<bool, AppError> {
    let pool = &state.deployment.db().pool;
    let launch = agent_runtime_launch_settings_for_session_from_pool(pool, &agent_id).await?;
    let launch_lock = launch.launch_lock;
    let fingerprint = open_capability_catalog_fingerprint(pool, &launch_lock).await?;
    let expected_generation =
        AgentCapabilityCatalogRecord::find_matching(pool, agent_id.as_str(), &fingerprint)
            .await?
            .map(|record| record.generation);
    let session_id = AgentSessionId(Uuid::new_v4());
    let working_dir = std::env::temp_dir()
        .join("vibex-agent-capability-probe")
        .join(agent_id.as_str())
        .join(session_id.to_string());
    std::fs::create_dir_all(&working_dir).map_err(|error| {
        AppError::Internal(format!(
            "failed to create capability probe directory: {error}"
        ))
    })?;

    let discovery = settle_session_authentication(
        pool,
        &agent_id,
        state
            .agent_runtime
            .prepare_session(agents::EnsureAgentSessionInput {
                agent_id: agent_id.clone(),
                launch_lock: launch_lock.clone(),
                workspace_id: Uuid::new_v4(),
                working_dir: working_dir.clone(),
                additional_directories: Vec::new(),
                session_id,
                acp_session_id: format!("vibex-capability-probe-{}", session_id),
                auto_approve_mode: launch.auto_approve_mode,
                env: launch.env,
                preferences: Default::default(),
            })
            .await,
    )
    .await;
    let persist_result = match discovery {
        Ok(prepared) => {
            async {
                // Authentication settlement can change the management projection.
                // Persist under the post-handshake fingerprint so the catalog is
                // immediately readable rather than born stale.
                let persist_fingerprint =
                    open_capability_catalog_fingerprint(pool, &launch_lock).await?;
                let persist_expected_generation = AgentCapabilityCatalogRecord::find_matching(
                    pool,
                    agent_id.as_str(),
                    &persist_fingerprint,
                )
                .await?
                .map(|record| record.generation);
                let controls_json = serde_json::to_string(&prepared.controls)?;
                AgentCapabilityCatalogRecord::replace_if_generation(
                    pool,
                    agent_id.as_str(),
                    &persist_fingerprint,
                    &controls_json,
                    persist_expected_generation,
                )
                .await?;
                Ok::<(), AppError>(())
            }
            .await
        }
        Err(error) => {
            if let Some(expected_generation) = expected_generation {
                let _ = AgentCapabilityCatalogRecord::record_refresh_error_if_generation(
                    pool,
                    agent_id.as_str(),
                    &fingerprint,
                    expected_generation,
                    "probe_failed",
                )
                .await;
            }
            Err(error)
        }
    };
    let discard_result = state
        .agent_runtime
        .discard_prepared_session(session_id)
        .await
        .map_err(AppError::from);
    let directory_result = remove_dir_all_retrying(&working_dir)
        .await
        .map_err(|error| {
            AppError::Internal(format!(
                "failed to remove capability probe directory: {error}"
            ))
        });
    capability_probe_result(persist_result, discard_result, directory_result)?;
    Ok(true)
}

/// Catalog persistence is the user-visible outcome. Session teardown and the
/// throwaway working directory are best-effort: Windows commonly holds the
/// probe cwd after the ACP process exits (os error 32).
fn capability_probe_result(
    persist: Result<(), AppError>,
    discard: Result<(), AppError>,
    directory: Result<(), AppError>,
) -> Result<(), AppError> {
    if let Err(error) = &directory {
        tracing::warn!("{error}");
    }
    if persist.is_ok() {
        if let Err(error) = &discard {
            tracing::warn!("{error}");
        }
        return Ok(());
    }
    persist
}

#[tauri::command]
pub async fn refresh_prompt_enhancement_catalogs(
    state: tauri::State<'_, AppState>,
) -> Result<crate::commands::config::PromptEnhancementModelsResponse, AppError> {
    let agent_ids = sqlx::query_scalar::<_, String>(
        r#"SELECT membership.agent_id
           FROM agent_membership membership
           JOIN agent_installation installation
             ON installation.agent_id = membership.agent_id
           WHERE membership.enabled = 1
             AND membership.retired = 0
             AND installation.current_lock_id IS NOT NULL
           ORDER BY membership.position, membership.agent_id"#,
    )
    .fetch_all(&state.deployment.db().pool)
    .await?;
    let mut refreshed_any = false;
    let mut refresh_errors = Vec::new();
    for raw_agent_id in agent_ids {
        let Ok(agent_id) = AgentId::parse(raw_agent_id) else {
            continue;
        };
        match refresh_capability_catalog_for_agent(&state, agent_id.clone()).await {
            Ok(true) => refreshed_any = true,
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(
                    %agent_id,
                    %error,
                    "Agent did not provide a prompt-enhancement capability catalog"
                );
                refresh_errors.push(format!("{agent_id}: {error}"));
            }
        }
    }
    let models = prompt_enhancement_capability_catalog_models(&state.deployment.db().pool).await?;
    if models.is_empty() && !refreshed_any && !refresh_errors.is_empty() {
        return Err(AppError::BadRequest(format!(
            "Unable to refresh Agent model catalogs: {}",
            refresh_errors.join("; ")
        )));
    }
    Ok(crate::commands::config::PromptEnhancementModelsResponse { models })
}

#[tauri::command]
pub async fn agent_session_defaults(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentSessionDefaultsView, AppError> {
    let pool = &state.deployment.db().pool;
    let records = SessionDefaultRepository::new(pool.clone())
        .list_for_agent(&agent_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let mut requested = BTreeMap::new();
    let mut stale_ids = Vec::new();
    for record in records {
        match serde_json::from_str(&record.value_json) {
            Ok(value) => {
                requested.insert(record.option_id, value);
            }
            Err(_) => stale_ids.push(record.option_id),
        }
    }
    let Some(catalog) = read_matching_open_capability_catalog_for_pool(pool, &agent_id).await?
    else {
        stale_ids.extend(requested.into_keys());
        stale_ids.sort();
        stale_ids.dedup();
        return Ok(AgentSessionDefaultsView {
            values: BTreeMap::new(),
            stale_ids,
        });
    };
    let validation = agents::validate_session_defaults(requested, &catalog.config_options);
    stale_ids.extend(validation.stale_ids);
    stale_ids.sort();
    stale_ids.dedup();
    Ok(AgentSessionDefaultsView {
        values: validation.valid,
        stale_ids,
    })
}

#[tauri::command]
pub async fn agent_set_session_defaults(
    state: tauri::State<'_, AppState>,
    request: AgentSessionDefaultsWriteRequest,
) -> Result<(), AppError> {
    let pool = &state.deployment.db().pool;
    let valid = if request.defaults.is_empty() {
        BTreeMap::new()
    } else {
        let catalog = read_matching_open_capability_catalog_for_pool(pool, &request.agent_id)
            .await?
            .ok_or_else(|| {
                AppError::Conflict(
                    "Agent capability catalog is unavailable; refresh it before saving defaults"
                        .to_string(),
                )
            })?;
        let validation =
            agents::validate_session_defaults(request.defaults, &catalog.config_options);
        if !validation.stale_ids.is_empty() {
            return Err(AppError::Conflict(format!(
                "Agent session defaults are no longer advertised: {}",
                validation.stale_ids.join(", ")
            )));
        }
        validation.valid
    };
    let updated_at = chrono::Utc::now().to_rfc3339();
    let records = valid
        .into_iter()
        .map(|(option_id, value)| {
            Ok(SessionDefaultRecord {
                option_id,
                value_json: serde_json::to_string(&value)?,
                updated_at: updated_at.clone(),
            })
        })
        .collect::<Result<Vec<_>, serde_json::Error>>()?;
    SessionDefaultRepository::new(pool.clone())
        .replace_for_agent(&request.agent_id, &records)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[tauri::command]
pub async fn agent_runtime_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<RuntimeSnapshot, AppError> {
    // The live runtime is authoritative for pending permissions now that startup
    // recovery (ADR-0001) voids orphaned ones — the old merge from the retired
    // `agent_permissions` shadow table has no reason to exist (批次D).
    Ok(state.agent_runtime.snapshot().await)
}

#[tauri::command]
pub async fn agent_list_local_history(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentSessionListPage, AppError> {
    let sessions = crate::commands::local_history::scan_local_history_for_agent(
        &state.deployment.db().pool,
        &agent_id,
        |_| {},
    )
    .await?;
    Ok(AgentSessionListPage {
        sessions: sessions
            .into_iter()
            .map(|session| AgentListedSession {
                acp_session_id: session.external_session_id,
                cwd: session
                    .workspace_path
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_default(),
                additional_directories: Vec::new(),
                title: session.title,
                updated_at: session.updated_at.map(|timestamp| timestamp.to_rfc3339()),
                meta: Some(serde_json::json!({
                    "source": "local_history",
                    "messageCount": session.message_count,
                })),
            })
            .collect(),
        next_cursor: None,
        meta: Some(serde_json::json!({ "source": "local_history" })),
    })
}

#[tauri::command]
pub async fn agent_import_local_history(
    state: tauri::State<'_, AppState>,
    request: AgentImportRemoteSessionRequest,
) -> Result<Session, AppError> {
    let workspace_id = parse_uuid("workspace_id", &request.workspace_id)?;
    let pool = &state.deployment.db().pool;
    Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))?;
    if let Some(existing) =
        DbConversationSummary::find_by_external_id(pool, &request.acp_session_id, &request.agent_id)
            .await?
    {
        return Session::find_by_id(pool, existing.id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Session {} not found", existing.id)));
    }

    let mut imported = crate::commands::local_history::load_selected_history_session(
        pool,
        &agents::LocalHistoryImportSelection {
            agent_id: request.agent_id.clone(),
            external_session_id: request.acp_session_id.clone(),
            workspace_id,
        },
    )
    .await
    .map_err(|error| {
        AppError::NotFound(format!(
            "Local Agent history session {} was not found: {error}",
            request.acp_session_id
        ))
    })?;
    if request
        .title
        .as_deref()
        .is_some_and(|title| !title.trim().is_empty())
    {
        imported.title = request.title;
    }
    let conversation_id =
        crate::commands::conversations::import_agent_session_to_conversation_events(
            pool,
            workspace_id,
            &imported,
        )
        .await?;
    Session::find_by_id(pool, conversation_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {conversation_id} not found")))
}

#[tauri::command]
pub async fn agent_list_remote_sessions(
    state: tauri::State<'_, AppState>,
    request: AgentListSessionsRequest,
) -> Result<agents::AgentSessionListPage, AppError> {
    let (connection_id, cwd) =
        connect_agent_for_workspace(state.inner(), &request.agent_id, &request.workspace_id)
            .await?;
    let result = state
        .agent_runtime
        .list_agent_sessions(connection_id, Some(cwd), request.cursor)
        .await
        .map_err(AppError::from);
    let cleanup = state
        .agent_runtime
        .discard_connection(connection_id)
        .await
        .map_err(AppError::from);
    result.and_then(|page| cleanup.map(|()| page))
}

#[tauri::command]
pub async fn agent_delete_remote_session(
    state: tauri::State<'_, AppState>,
    request: AgentDeleteRemoteSessionRequest,
) -> Result<(), AppError> {
    let (connection_id, _cwd) =
        connect_agent_for_workspace(state.inner(), &request.agent_id, &request.workspace_id)
            .await?;
    let result = state
        .agent_runtime
        .delete_agent_session(connection_id, request.acp_session_id)
        .await
        .map_err(AppError::from);
    let cleanup = state
        .agent_runtime
        .discard_connection(connection_id)
        .await
        .map_err(AppError::from);
    result.and(cleanup)
}

#[tauri::command]
pub async fn agent_import_remote_session(
    state: tauri::State<'_, AppState>,
    request: AgentImportRemoteSessionRequest,
) -> Result<Session, AppError> {
    let workspace_id = parse_uuid("workspace_id", &request.workspace_id)?;
    let pool = &state.deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))?;
    if let Some(existing) =
        DbConversationSummary::find_by_external_id(pool, &request.acp_session_id, &request.agent_id)
            .await?
    {
        return Session::find_by_id(pool, existing.id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Session {} not found", existing.id)));
    }

    let session = Session::create(
        pool,
        &CreateSession {
            executor: Some(request.agent_id.as_str().to_string()),
            agent_id: Some(request.agent_id.clone()),
            task_id: Some(workspace.task_id),
            name: request.title,
            initial_prompt: None,
            status: Some(SessionStatus::Todo),
        },
        Uuid::new_v4(),
        workspace_id,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    Session::update_agent_metadata(
        pool,
        session.id,
        Some(&request.acp_session_id),
        Some(&request.agent_id),
    )
    .await?;
    Session::find_by_id(pool, session.id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {} not found", session.id)))
}

async fn connect_agent_for_workspace(
    state: &AppState,
    agent_id: &AgentId,
    workspace_id: &str,
) -> Result<(AgentConnectionId, PathBuf), AppError> {
    let workspace_id = parse_uuid("workspace_id", workspace_id)?;
    let pool = &state.deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))?;
    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace_id).await?;
    let working_dir = crate::workspace_paths::resolve_workspace_default_open_path(
        &workspace,
        &container_ref,
        &repos,
    )
    .to_string_lossy()
    .into_owned();
    let additional_directories = crate::workspace_paths::resolve_workspace_additional_directories(
        &workspace,
        &container_ref,
        &repos,
        &working_dir,
    );
    let launch = agent_runtime_launch_settings_for_session_from_pool(pool, agent_id).await?;
    let connection = state
        .agent_runtime
        .connect(ConnectAgentInput {
            agent_id: agent_id.clone(),
            launch_lock: launch.launch_lock,
            workspace_id,
            working_dir: PathBuf::from(&working_dir),
            additional_directories,
            auto_approve_mode: launch.auto_approve_mode,
            env: launch.env,
        })
        .await?;
    Ok((connection.id, PathBuf::from(working_dir)))
}

#[tauri::command]
pub async fn agent_connection_snapshot(
    state: tauri::State<'_, AppState>,
    request: AgentConnectionRequest,
) -> Result<AgentConnectionSnapshot, AppError> {
    let connection_id = parse_agent_connection_id(&request.connection_id)?;
    state
        .agent_runtime
        .snapshot()
        .await
        .connections
        .into_iter()
        .find(|connection| connection.id == connection_id)
        .ok_or_else(|| AppError::NotFound(format!("Connection {connection_id} not found")))
}

#[tauri::command]
pub async fn agent_load_session(
    state: tauri::State<'_, AppState>,
    request: AgentSessionRequest,
) -> Result<AgentSessionSnapshot, AppError> {
    let session_id = parse_agent_session_id(&request.session_id)?;
    state
        .agent_runtime
        .snapshot()
        .await
        .sessions
        .into_iter()
        .find(|session| session.id == session_id)
        .ok_or_else(|| AppError::NotFound(format!("Agent session {session_id} not found")))
}

#[tauri::command]
pub async fn agent_list_session_commands(
    state: tauri::State<'_, AppState>,
    request: AgentSessionRequest,
) -> Result<Vec<AgentAvailableCommand>, AppError> {
    let session_id = parse_agent_session_id(&request.session_id)?;
    let snapshot = state.agent_runtime.snapshot().await;

    Ok(snapshot
        .events
        .iter()
        .rev()
        .find_map(|envelope| {
            if envelope.session_id != Some(session_id) {
                return None;
            }
            match &envelope.event {
                agents::AgentEvent::AvailableCommands { commands } => Some(commands.clone()),
                _ => None,
            }
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn agent_connect(
    state: tauri::State<'_, AppState>,
    request: AgentConnectRequest,
) -> Result<AgentConnectionSnapshot, AppError> {
    let workspace_id = parse_uuid("workspace_id", &request.workspace_id)?;
    let workspace = Workspace::find_by_id(&state.deployment.db().pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))?;
    let repos =
        WorkspaceRepo::find_repos_for_workspace(&state.deployment.db().pool, workspace_id).await?;
    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let additional_directories = crate::workspace_paths::resolve_workspace_additional_directories(
        &workspace,
        &container_ref,
        &repos,
        &request.working_dir,
    );
    let launch_settings = agent_runtime_launch_settings(&state, &request.agent_id).await?;
    state
        .agent_runtime
        .connect(ConnectAgentInput {
            agent_id: request.agent_id.clone(),
            launch_lock: launch_settings.launch_lock,
            workspace_id,
            working_dir: PathBuf::from(request.working_dir),
            additional_directories,
            auto_approve_mode: launch_settings.auto_approve_mode,
            env: launch_settings.env,
        })
        .await
        .map_err(Into::into)
}

async fn agent_runtime_launch_settings(
    state: &tauri::State<'_, AppState>,
    agent_id: &AgentId,
) -> Result<conversations::AgentRuntimeLaunchSettings, AppError> {
    agent_runtime_launch_settings_from_pool(&state.deployment.db().pool, agent_id).await
}

/// Pool-based variant of [`agent_runtime_launch_settings`] so non-command code
/// (the delegation spawner) can resolve a child agent's auto-approve mode + env
/// without a `tauri::State`.
pub(crate) async fn agent_runtime_launch_settings_from_pool(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<conversations::AgentRuntimeLaunchSettings, AppError> {
    agent_runtime_launch_settings_from_pool_with_auth_revalidation(pool, agent_id, false).await
}

pub(crate) async fn agent_runtime_launch_settings_for_session_from_pool(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<conversations::AgentRuntimeLaunchSettings, AppError> {
    agent_runtime_launch_settings_from_pool_with_auth_revalidation(pool, agent_id, true).await
}

#[derive(Deserialize, Default)]
struct LockedLaunchPayload {
    absolute_acp_program: Option<PathBuf>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    runtime_version: Option<String>,
    acp_version: Option<String>,
}

async fn agent_runtime_launch_settings_from_pool_with_auth_revalidation(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    revalidate_authentication: bool,
) -> Result<conversations::AgentRuntimeLaunchSettings, AppError> {
    let row = sqlx::query(
        r#"SELECT membership.enabled,
                  membership.retired,
                  COALESCE(probe.lifecycle, installation.lifecycle, 'uninstalled') AS lifecycle,
                  COALESCE(probe.authentication, 'not_logged_in') AS authentication,
                  lock.resolved_json,
                  lock.id,
                  installation.ownership,
                  setting.env_json
           FROM agent_membership membership
           LEFT JOIN agent_installation installation
             ON installation.agent_id = membership.agent_id
           LEFT JOIN agent_install_lock lock
             ON lock.id = installation.current_lock_id
           LEFT JOIN agent_probe probe
             ON probe.agent_id = membership.agent_id
           LEFT JOIN agent_setting setting
             ON setting.agent_type = membership.agent_id
           WHERE membership.agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Agent `{agent_id}` has not been added")))?;

    let mut lifecycle = parse_management_lifecycle(row.try_get::<String, _>("lifecycle")?.as_str());
    if revalidate_authentication {
        lifecycle = lifecycle_for_session_creation(lifecycle);
    }
    let authentication =
        parse_management_authentication(row.try_get::<String, _>("authentication")?.as_str());
    let resolved_json = row.try_get::<Option<String>, _>("resolved_json")?;
    let lock_id = row.try_get::<Option<String>, _>("id")?;
    let (lock_id, payload) = match (resolved_json.as_deref(), lock_id.as_deref()) {
        (Some(resolved_json), Some(lock_id)) => {
            let payload: LockedLaunchPayload =
                serde_json::from_str(resolved_json).map_err(|error| {
                    AppError::Internal(format!("invalid current Installation lock: {error}"))
                })?;
            (Some(lock_id.to_string()), Some(payload))
        }
        _ => (None, None),
    };
    let ownership = row
        .try_get::<Option<String>, _>("ownership")?
        .unwrap_or_else(|| "managed".to_string());
    let mut current_lock = match (lock_id.as_deref(), payload) {
        (Some(lock_id), Some(payload)) => {
            Some(session_launch_lock_from_payload(pool, agent_id, lock_id, payload).await?)
        }
        _ => None,
    };
    if current_lock.is_none() {
        current_lock = discover_path_acp_launch_lock(agent_id).await;
    }
    if current_lock.is_some() {
        lifecycle = lifecycle_ready_for_path_acp(lifecycle);
    }
    let snapshot = AgentManagementSnapshot {
        agent_id: agent_id.clone(),
        enabled: row.try_get("enabled")?,
        lifecycle,
        authentication,
        required_components: Vec::new(),
    };
    let authorization = match SessionGate.authorize(SessionGateInput {
        snapshot,
        current_lock,
        requested_defaults: BTreeMap::new(),
        advertised_option_ids: Vec::new(),
        existing_binding: None,
        explicit_rebind: false,
    }) {
        Ok(authorization) => authorization,
        Err(error) => {
            return Err(AppError::BadRequest(
                conversations::session_launch_rejection_from_pool(pool, agent_id, error).await,
            ));
        }
    };
    let launch_lock = SessionLaunchLock {
        agent_id: authorization.agent_id,
        absolute_acp_program: authorization.absolute_acp_program,
        args: authorization.args,
        env: authorization.env,
        runtime_version: authorization.runtime_version,
        acp_version: authorization.acp_version,
    };
    let path_resolved = lock_id.is_none();
    let components = if let Some(lock_id) = lock_id.as_deref() {
        sqlx::query(
            r#"SELECT component_kind, absolute_path, sha256
               FROM agent_install_component
               WHERE lock_id = ?
               ORDER BY component_kind, absolute_path"#,
        )
        .bind(lock_id)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|component| {
            Ok(LaunchComponentEvidence {
                component_kind: component.try_get("component_kind")?,
                absolute_path: PathBuf::from(component.try_get::<String, _>("absolute_path")?),
                expected_sha256: component
                    .try_get::<Option<String>, _>("sha256")?
                    .unwrap_or_default(),
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?
    } else {
        Vec::new()
    };
    let _ = utils::shell::refresh_process_path().await;
    let verified_launch_lock = if ownership == "external" || path_resolved {
        let program = agents::prefer_path_launch_program(&launch_lock.absolute_acp_program);
        if agents::launch_program_available(&program) {
            let mut launch_lock = launch_lock;
            launch_lock.absolute_acp_program = program;
            Ok(launch_lock)
        } else {
            Err(LaunchGateError::Missing {
                component_kind: "acp".to_string(),
                path: program,
            })
        }
    } else {
        match LaunchGate::verify(launch_lock.clone(), &components).await {
            Ok(lock) => Ok(lock),
            Err(error @ LaunchGateError::Missing { .. }) => {
                let program = agents::prefer_path_launch_program(&launch_lock.absolute_acp_program);
                if agents::launch_program_available(&program) {
                    let mut lock = launch_lock;
                    lock.absolute_acp_program = program;
                    Ok(lock)
                } else {
                    Err(error)
                }
            }
            Err(error) => Err(error),
        }
    };
    let mut launch_lock = match verified_launch_lock {
        Ok(lock) => {
            let program = agents::prefer_path_launch_program(&lock.absolute_acp_program);
            if agents::launch_program_available(&program) {
                let mut lock = lock;
                lock.absolute_acp_program = program;
                lock
            } else {
                lock
            }
        }
        Err(error) => {
            if let Some(lock_id) = lock_id.as_deref() {
                sqlx::query(
                    r#"UPDATE agent_installation
                       SET lifecycle = 'needs_repair', updated_at = CURRENT_TIMESTAMP
                       WHERE agent_id = ? AND current_lock_id = ?"#,
                )
                .bind(agent_id.as_str())
                .bind(lock_id)
                .execute(pool)
                .await?;
            }
            db::models::agent_management::DiagnosticRepository::new(pool.clone())
                .append_bounded(&db::models::agent_management::DiagnosticRecord {
                    id: Uuid::new_v4(),
                    agent_id: agent_id.clone(),
                    operation_kind: "launch_gate".to_string(),
                    severity: "error".to_string(),
                    message: "启动前完整性验证失败".to_string(),
                    redacted_output: Some(error.to_string()),
                    created_at: chrono::Utc::now().to_rfc3339(),
                })
                .await
                .map_err(|repository_error| AppError::Internal(repository_error.to_string()))?;
            return Err(AppError::BadRequest(format!(
                "Agent 安装完整性验证失败，需要修复：{error}"
            )));
        }
    };
    let mut env = row
        .try_get::<Option<String>, _>("env_json")?
        .filter(|value| !value.trim().is_empty())
        .map(|value| serde_json::from_str::<HashMap<String, String>>(&value))
        .transpose()
        .map_err(|error| AppError::Internal(format!("invalid Agent environment: {error}")))?
        .unwrap_or_default();
    agents::sanitize_runtime_executable_lock_env(agent_id, &mut launch_lock.env);
    agents::apply_built_in_launch_policy(agent_id, &mut env, &mut launch_lock.args);
    Ok(conversations::AgentRuntimeLaunchSettings {
        auto_approve_mode: AgentAutoApproveMode::Off,
        env,
        launch_lock,
    })
}

fn lifecycle_for_session_creation(lifecycle: AgentLifecycleState) -> AgentLifecycleState {
    if lifecycle == AgentLifecycleState::NeedsAuth {
        AgentLifecycleState::Ready
    } else {
        lifecycle
    }
}

pub(crate) async fn settle_session_authentication<T>(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    result: Result<T, agents::AgentError>,
) -> Result<T, AppError> {
    let (readiness, output) = match result {
        Ok(value) => (SessionAuthenticationEvidence::SessionReady, Ok(value)),
        Err(error @ agents::AgentError::AuthenticationRequired(_)) => (
            SessionAuthenticationEvidence::AuthenticationRequired,
            Err(error),
        ),
        Err(error) => return Err(error.into()),
    };
    let authentication = sqlx::query_scalar::<_, String>(
        "SELECT authentication FROM agent_probe WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await?
    .map(|value| parse_management_authentication(&value))
    .unwrap_or(AgentAuthenticationStatus::NotLoggedIn);
    let resolved = resolve_session_authentication_evidence(authentication, readiness);
    AgentManagementApplicationService::new(pool.clone())
        .sync_authentication(
            agent_id,
            resolved.authentication,
            Some(resolved.authentication_required),
        )
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    output.map_err(Into::into)
}

async fn session_launch_lock_from_payload(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    lock_id: &str,
    payload: LockedLaunchPayload,
) -> Result<SessionLaunchLock, AppError> {
    let acp_component = sqlx::query(
        r#"SELECT absolute_path, version
           FROM agent_install_component
           WHERE lock_id = ?
             AND component_kind IN ('acp', 'acp_adapter', 'combined_runtime')
           ORDER BY CASE component_kind
             WHEN 'acp' THEN 0 WHEN 'acp_adapter' THEN 1 ELSE 2 END
           LIMIT 1"#,
    )
    .bind(lock_id)
    .fetch_optional(pool)
    .await?;
    let runtime_component = sqlx::query(
        r#"SELECT version
           FROM agent_install_component
           WHERE lock_id = ?
             AND component_kind IN ('runtime', 'agent_runtime', 'combined_runtime')
           ORDER BY CASE component_kind
             WHEN 'runtime' THEN 0 WHEN 'agent_runtime' THEN 1 ELSE 2 END
           LIMIT 1"#,
    )
    .bind(lock_id)
    .fetch_optional(pool)
    .await?;
    let absolute_acp_program = match acp_component.as_ref() {
        Some(component) => PathBuf::from(component.try_get::<String, _>("absolute_path")?),
        None => payload.absolute_acp_program.ok_or_else(|| {
            AppError::Internal("Installation lock has no ACP component path".to_string())
        })?,
    };
    let acp_version = match acp_component.as_ref() {
        Some(component) => component.try_get::<String, _>("version")?,
        None => payload.acp_version.ok_or_else(|| {
            AppError::Internal("Installation lock has no ACP version".to_string())
        })?,
    };
    let runtime_version = match runtime_component.as_ref() {
        Some(component) => component.try_get::<String, _>("version")?,
        None => payload.runtime_version.unwrap_or_default(),
    };
    Ok(SessionLaunchLock {
        agent_id: agent_id.clone(),
        absolute_acp_program,
        args: payload.args,
        env: payload.env,
        runtime_version,
        acp_version,
    })
}

fn parse_management_lifecycle(value: &str) -> AgentLifecycleState {
    match value {
        "retired" => AgentLifecycleState::Retired,
        "platform_unsupported" => AgentLifecycleState::PlatformUnsupported,
        "queued" => AgentLifecycleState::Queued,
        "installing" => AgentLifecycleState::Installing,
        "updating" => AgentLifecycleState::Updating,
        "repairing" => AgentLifecycleState::Repairing,
        "needs_auth" => AgentLifecycleState::NeedsAuth,
        "needs_config" => AgentLifecycleState::NeedsConfig,
        "ready" => AgentLifecycleState::Ready,
        "uninstalled" => AgentLifecycleState::Uninstalled,
        _ => AgentLifecycleState::NeedsRepair,
    }
}

fn parse_management_authentication(value: &str) -> AgentAuthenticationStatus {
    match value {
        "account" => AgentAuthenticationStatus::Account,
        "api_key" => AgentAuthenticationStatus::ApiKey,
        "multiple_unknown" => AgentAuthenticationStatus::MultipleUnknown,
        "not_required" => AgentAuthenticationStatus::NotRequired,
        _ => AgentAuthenticationStatus::NotLoggedIn,
    }
}

#[tauri::command]
pub async fn agent_prepare_session(
    state: tauri::State<'_, AppState>,
    request: AgentPrepareSessionRequest,
) -> Result<AgentPreparedSessionSnapshot, AppError> {
    let workspace_id = parse_uuid("workspace_id", &request.workspace_id)?;
    let session_id = parse_agent_session_id(&request.session_id)?;
    let pool = &state.deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))?;
    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let working_dir = crate::workspace_paths::resolve_workspace_default_open_path(
        &workspace,
        &container_ref,
        &repos,
    )
    .to_string_lossy()
    .into_owned();
    let additional_directories = crate::workspace_paths::resolve_workspace_additional_directories(
        &workspace,
        &container_ref,
        &repos,
        &working_dir,
    );
    let launch_settings = agent_runtime_launch_settings_for_session_from_pool(
        &state.deployment.db().pool,
        &request.agent_id,
    )
    .await?;

    let defaults = SessionDefaultRepository::new(state.deployment.db().pool.clone())
        .list_for_agent(&request.agent_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let mut requested_defaults = BTreeMap::new();
    let mut stale = Vec::new();
    for default in defaults {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&default.value_json) else {
            stale.push(default.option_id);
            continue;
        };
        requested_defaults.insert(default.option_id, value);
    }
    let preferences = SessionControlPreferences::from_option_values(&requested_defaults);
    let mut prepared = settle_session_authentication(
        &state.deployment.db().pool,
        &request.agent_id,
        state
            .agent_runtime
            .prepare_session(agents::EnsureAgentSessionInput {
                agent_id: request.agent_id.clone(),
                launch_lock: launch_settings.launch_lock,
                workspace_id,
                working_dir: PathBuf::from(working_dir),
                additional_directories,
                session_id,
                acp_session_id: format!("pending-{session_id}"),
                auto_approve_mode: launch_settings.auto_approve_mode,
                env: launch_settings.env,
                preferences,
            })
            .await,
    )
    .await?;
    let validation =
        agents::validate_session_defaults(requested_defaults, &prepared.controls.config_options);
    stale.extend(validation.stale_ids);
    for (option_id, value) in validation.valid {
        if !session_control_matches(&prepared.controls, &option_id, &value) {
            stale.push(option_id);
        }
    }
    if !stale.is_empty() {
        stale.sort();
        prepared.stale_default_ids = Some(stale);
    }
    Ok(prepared)
}

fn session_control_matches(
    controls: &AgentSessionControlsSnapshot,
    option_id: &str,
    value: &Value,
) -> bool {
    if option_id == "mode" {
        return controls
            .current_mode
            .as_deref()
            .is_some_and(|mode| Some(mode) == value.as_str() || mode == value.to_string());
    }
    controls
        .config_options
        .iter()
        .any(|option| option.key == option_id && option.value.as_ref() == Some(value))
}

#[tauri::command]
pub async fn agent_set_prepared_session_mode(
    state: tauri::State<'_, AppState>,
    request: AgentPreparedSessionModeRequest,
) -> Result<AgentSessionControlsSnapshot, AppError> {
    state
        .agent_runtime
        .set_session_mode(
            parse_agent_session_id(&request.session_id)?,
            request.mode_id,
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_set_prepared_session_config(
    state: tauri::State<'_, AppState>,
    request: AgentPreparedSessionConfigRequest,
) -> Result<AgentSessionControlsSnapshot, AppError> {
    state
        .agent_runtime
        .set_session_config_option(
            parse_agent_session_id(&request.session_id)?,
            request.key,
            request.value,
        )
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_discard_prepared_session(
    state: tauri::State<'_, AppState>,
    request: AgentSessionRequest,
) -> Result<(), AppError> {
    state
        .agent_runtime
        .discard_prepared_session(parse_agent_session_id(&request.session_id)?)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_new_session(
    state: tauri::State<'_, AppState>,
    request: AgentNewSessionRequest,
) -> Result<AgentSessionSnapshot, AppError> {
    let connection_id = parse_agent_connection_id(&request.connection_id)?;
    let agent_id = state
        .agent_runtime
        .snapshot()
        .await
        .connections
        .into_iter()
        .find(|connection| connection.id == connection_id)
        .map(|connection| connection.agent_id)
        .ok_or_else(|| {
            AppError::NotFound(format!("Agent connection {connection_id} was not found"))
        })?;
    settle_session_authentication(
        &state.deployment.db().pool,
        &agent_id,
        state
            .agent_runtime
            .new_session(
                connection_id,
                request
                    .acp_session_id
                    .unwrap_or_else(|| format!("pending-{connection_id}")),
            )
            .await,
    )
    .await
}

#[tauri::command]
pub async fn agent_resume_session(
    state: tauri::State<'_, AppState>,
    request: AgentResumeSessionRequest,
) -> Result<AgentSessionSnapshot, AppError> {
    let workspace_id = parse_uuid("workspace_id", &request.workspace_id)?;
    let workspace = Workspace::find_by_id(&state.deployment.db().pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))?;
    let repos =
        WorkspaceRepo::find_repos_for_workspace(&state.deployment.db().pool, workspace_id).await?;
    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let additional_directories = crate::workspace_paths::resolve_workspace_additional_directories(
        &workspace,
        &container_ref,
        &repos,
        &request.working_dir,
    );
    let launch_settings = agent_runtime_launch_settings_for_session_from_pool(
        &state.deployment.db().pool,
        &request.agent_id,
    )
    .await?;
    settle_session_authentication(
        &state.deployment.db().pool,
        &request.agent_id,
        state
            .agent_runtime
            .resume_session(ResumeAgentSessionInput {
                agent_id: request.agent_id.clone(),
                launch_lock: launch_settings.launch_lock,
                workspace_id,
                working_dir: PathBuf::from(request.working_dir),
                additional_directories,
                session_id: parse_agent_session_id(&request.session_id)?,
                external_session_id: request.external_session_id,
                auto_approve_mode: launch_settings.auto_approve_mode,
                env: launch_settings.env,
                preferences: Default::default(),
            })
            .await
            .map(|(snapshot, _)| snapshot),
    )
    .await
}

#[tauri::command]
pub async fn agent_send_prompt(
    state: tauri::State<'_, AppState>,
    request: AgentSendPromptRequest,
) -> Result<AgentPromptSnapshot, AppError> {
    let connection_id = parse_agent_connection_id(&request.connection_id)?;
    let connection = state
        .agent_runtime
        .snapshot()
        .await
        .connections
        .into_iter()
        .find(|connection| connection.id == connection_id)
        .ok_or_else(|| AppError::NotFound(format!("Agent connection {connection_id} not found")))?;
    agent_runtime_launch_settings_from_pool(&state.deployment.db().pool, &connection.agent_id)
        .await?;
    state
        .agent_runtime
        .send_prompt(SendAgentPromptInput {
            connection_id,
            session_id: parse_agent_session_id(&request.session_id)?,
            blocks: text_prompt_blocks(request.text),
            mode_override: None,
            config_overrides: Vec::new(),
        })
        .await
        .map_err(Into::into)
}

/// Restore the workspace to the checkpoint recorded before the given user
/// message (its `ordinal`). Destructive when `perform_git_reset` is set; the ACP
/// transcript is append-only and is not truncated. Used by retry/rollback.
#[tauri::command]
pub async fn agent_reset_to_checkpoint(
    state: tauri::State<'_, AppState>,
    session_id: String,
    ordinal: i64,
    perform_git_reset: Option<bool>,
    force_when_dirty: Option<bool>,
) -> Result<(), AppError> {
    let session_id = parse_uuid("session_id", &session_id)?;
    state
        .deployment
        .container()
        .reset_agent_session_to_checkpoint(
            session_id,
            ordinal,
            perform_git_reset.unwrap_or(true),
            force_when_dirty.unwrap_or(false),
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn agent_cancel_prompt(
    state: tauri::State<'_, AppState>,
    request: AgentCancelPromptRequest,
) -> Result<(), AppError> {
    state
        .agent_runtime
        .cancel_prompt(CancelAgentPromptInput {
            connection_id: parse_agent_connection_id(&request.connection_id)?,
            session_id: parse_agent_session_id(&request.session_id)?,
            prompt_id: parse_agent_prompt_id(&request.prompt_id)?,
        })
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_disconnect(
    state: tauri::State<'_, AppState>,
    request: AgentConnectionRequest,
) -> Result<AgentConnectionSnapshot, AppError> {
    state
        .agent_runtime
        .disconnect(parse_agent_connection_id(&request.connection_id)?)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_respond_permission(
    state: tauri::State<'_, AppState>,
    request: AgentRespondPermissionRequest,
) -> Result<(), AppError> {
    state
        .agent_runtime
        .respond_permission(RespondAgentPermissionInput {
            connection_id: parse_agent_connection_id(&request.connection_id)?,
            permission_id: parse_agent_permission_id(&request.permission_id)?,
            response: request.response,
        })
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn agent_terminal_snapshot(
    request: AgentTerminalSnapshotRequest,
) -> Result<Option<AgentTerminalOutputSnapshot>, AppError> {
    Ok(agent_terminal_registry()
        .snapshot_output(parse_agent_terminal_id(&request.terminal_id)?)
        .await)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLiveTerminalView {
    pub terminal_id: String,
    pub agent_session_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
}

#[tauri::command]
pub async fn agent_list_live_terminals() -> Result<Vec<AgentLiveTerminalView>, AppError> {
    Ok(agent_terminal_registry()
        .list_live()
        .await
        .into_iter()
        .map(|item| AgentLiveTerminalView {
            terminal_id: item.terminal_id.to_string(),
            agent_session_id: item.agent_session_id.to_string(),
            command: item.command,
            args: item.args,
            cwd: item.cwd.and_then(|path| path.to_str().map(str::to_string)),
        })
        .collect())
}

fn parse_uuid(label: &str, value: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(value).map_err(|_| AppError::BadRequest(format!("Invalid {label}: {value}")))
}

fn parse_agent_connection_id(value: &str) -> Result<AgentConnectionId, AppError> {
    parse_uuid("connection_id", value).map(AgentConnectionId)
}

fn parse_agent_session_id(value: &str) -> Result<AgentSessionId, AppError> {
    parse_uuid("session_id", value).map(AgentSessionId)
}

fn parse_agent_prompt_id(value: &str) -> Result<AgentPromptId, AppError> {
    parse_uuid("prompt_id", value).map(AgentPromptId)
}

fn parse_agent_permission_id(value: &str) -> Result<AgentPermissionId, AppError> {
    parse_uuid("permission_id", value).map(AgentPermissionId)
}

fn parse_agent_terminal_id(value: &str) -> Result<AgentTerminalId, AppError> {
    parse_uuid("terminal_id", value).map(AgentTerminalId)
}

fn text_prompt_blocks(text: String) -> Vec<AgentContentBlock> {
    if text.trim().is_empty() {
        Vec::new()
    } else {
        vec![AgentContentBlock::Text { text }]
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, path::PathBuf, str::FromStr};

    use chrono::{Duration, Utc};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    async fn authentication_projection_pool() -> sqlx::SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_installation (
                 agent_id TEXT PRIMARY KEY,
                 lifecycle TEXT NOT NULL,
                 current_lock_id TEXT
               )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_probe (
                 agent_id TEXT PRIMARY KEY,
                 lifecycle TEXT NOT NULL,
                 authentication TEXT NOT NULL,
                 detail_json TEXT NOT NULL,
                 probed_at TEXT NOT NULL,
                 runtime_available INTEGER NOT NULL DEFAULT 0,
                 acp_handshake INTEGER NOT NULL DEFAULT 0,
                 authentication_required INTEGER NOT NULL DEFAULT 0,
                 observation_generation INTEGER NOT NULL DEFAULT 0
               )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn capability_fingerprint_pool() -> sqlx::SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        for statement in [
            r#"CREATE TABLE agent_setting (
                 agent_type TEXT PRIMARY KEY,
                 updated_at TEXT NOT NULL,
                 config_json TEXT,
                 env_json TEXT
               )"#,
            r#"CREATE TABLE agent_config_binding (
                 agent_id TEXT NOT NULL,
                 provider_id TEXT NOT NULL,
                 revision TEXT NOT NULL,
                 fingerprint TEXT NOT NULL,
                 updated_at TEXT NOT NULL
               )"#,
            r#"CREATE TABLE agent_probe (
                 agent_id TEXT PRIMARY KEY,
                 authentication TEXT NOT NULL,
                 probed_at TEXT NOT NULL,
                 observation_generation INTEGER NOT NULL DEFAULT 0,
                 runtime_available INTEGER NOT NULL,
                 acp_handshake INTEGER NOT NULL,
                 authentication_required INTEGER NOT NULL
               )"#,
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        pool
    }

    fn capability_launch_lock() -> SessionLaunchLock {
        SessionLaunchLock {
            agent_id: AgentId::parse("catalog-agent").unwrap(),
            absolute_acp_program: PathBuf::from("/managed/catalog-agent"),
            args: vec!["acp".to_string()],
            env: BTreeMap::new(),
            runtime_version: "1.0.0".to_string(),
            acp_version: "0.8".to_string(),
        }
    }

    #[tokio::test]
    async fn capability_fingerprint_ignores_probe_observation_time() {
        let pool = capability_fingerprint_pool().await;
        let lock = capability_launch_lock();
        sqlx::query(
            r#"INSERT INTO agent_probe
               VALUES (?, 'not_required', '2026-07-30T01:00:00Z', 7, 1, 1, 0)"#,
        )
        .bind(lock.agent_id.as_str())
        .execute(&pool)
        .await
        .unwrap();
        let before = open_capability_catalog_fingerprint(&pool, &lock)
            .await
            .unwrap();

        sqlx::query("UPDATE agent_probe SET probed_at = '2026-07-30T02:00:00Z'")
            .execute(&pool)
            .await
            .unwrap();

        let after = open_capability_catalog_fingerprint(&pool, &lock)
            .await
            .unwrap();
        assert_eq!(before, after);

        sqlx::query("UPDATE agent_probe SET observation_generation = 8")
            .execute(&pool)
            .await
            .unwrap();
        let next_observation = open_capability_catalog_fingerprint(&pool, &lock)
            .await
            .unwrap();
        assert_ne!(after, next_observation);
    }

    #[test]
    fn stale_capability_catalog_controls_are_not_read() {
        let now = Utc::now();
        let record = AgentCapabilityCatalogRecord {
            agent_type: "catalog-agent".to_string(),
            fingerprint: "fingerprint".to_string(),
            generation: 1,
            controls_json: serde_json::to_string(&AgentSessionControlsSnapshot::default()).unwrap(),
            retrieved_at: (now - Duration::minutes(11)).to_rfc3339(),
            refresh_error_code: None,
        };

        assert!(catalog_controls_if_fresh(record, now).is_none());
    }

    #[test]
    fn model_choices_come_only_from_semantic_catalog_options() {
        let snapshot = AgentSessionControlsSnapshot {
            modes: Vec::new(),
            current_mode: None,
            config_options: vec![
                agents::AgentSessionConfigOption {
                    key: "provider".to_string(),
                    label: "Provider".to_string(),
                    description: None,
                    category: None,
                    value: None,
                    choices: vec![agents::AgentSessionConfigChoice {
                        value: serde_json::Value::String("openai".to_string()),
                        label: "OpenAI".to_string(),
                        description: None,
                    }],
                    dependency: None,
                },
                agents::AgentSessionConfigOption {
                    key: "model".to_string(),
                    label: "Model".to_string(),
                    description: None,
                    category: Some("model".to_string()),
                    value: None,
                    choices: vec![
                        agents::AgentSessionConfigChoice {
                            value: serde_json::Value::String("openai/gpt-5.6-sol".to_string()),
                            label: "GPT 5.6 Sol".to_string(),
                            description: None,
                        },
                        // Values, not presentation labels, are sent back to
                        // the Agent. Duplicates and unusable values are not
                        // transformed into invented fallbacks.
                        agents::AgentSessionConfigChoice {
                            value: serde_json::Value::String("openai/gpt-5.6-sol".to_string()),
                            label: "A different label".to_string(),
                            description: None,
                        },
                        agents::AgentSessionConfigChoice {
                            value: serde_json::Value::String("  ".to_string()),
                            label: "Empty".to_string(),
                            description: None,
                        },
                        agents::AgentSessionConfigChoice {
                            value: serde_json::Value::Bool(true),
                            label: "Not a model".to_string(),
                            description: None,
                        },
                    ],
                    dependency: None,
                },
            ],
            capabilities: None,
            available_commands: None,
        };

        assert_eq!(
            models_from_capability_catalog(&snapshot),
            vec!["openai/gpt-5.6-sol".to_string()]
        );
    }

    #[test]
    fn model_extractor_returns_no_static_fallback_when_catalog_is_empty() {
        let snapshot = AgentSessionControlsSnapshot::default();

        assert!(models_from_capability_catalog(&snapshot).is_empty());
    }

    #[test]
    fn prompt_enhancement_preserves_the_advertised_model_option_key() {
        let snapshot = AgentSessionControlsSnapshot {
            modes: Vec::new(),
            current_mode: None,
            config_options: vec![agents::AgentSessionConfigOption {
                key: "model_id".to_string(),
                label: "Model".to_string(),
                description: None,
                category: Some("model".to_string()),
                value: None,
                choices: vec![agents::AgentSessionConfigChoice {
                    value: serde_json::Value::String("openai/gpt-5.6-sol".to_string()),
                    label: "GPT 5.6 Sol".to_string(),
                    description: None,
                }],
                dependency: None,
            }],
            capabilities: None,
            available_commands: None,
        };

        assert_eq!(
            model_selections_from_capability_catalog(&snapshot),
            vec![("model_id".to_string(), "openai/gpt-5.6-sol".to_string())]
        );
    }

    #[test]
    fn session_creation_revalidates_a_persisted_needs_auth_projection() {
        assert_eq!(
            lifecycle_for_session_creation(AgentLifecycleState::NeedsAuth),
            AgentLifecycleState::Ready
        );
        assert_eq!(
            lifecycle_for_session_creation(AgentLifecycleState::NeedsRepair),
            AgentLifecycleState::NeedsRepair
        );
    }

    #[test]
    fn capability_probe_cleanup_failure_does_not_hide_a_persisted_catalog() {
        assert!(
            capability_probe_result(
                Ok(()),
                Ok(()),
                Err(AppError::Internal(
                    "failed to remove capability probe directory: os error 32".to_string()
                )),
            )
            .is_ok()
        );
        assert!(
            capability_probe_result(
                Ok(()),
                Err(AppError::Internal("session discard failed".to_string())),
                Err(AppError::Internal(
                    "failed to remove capability probe directory: os error 32".to_string()
                )),
            )
            .is_ok()
        );
    }

    #[test]
    fn capability_probe_still_returns_persist_errors() {
        let error = capability_probe_result(
            Err(AppError::Internal(
                "ACP session preparation failed".to_string(),
            )),
            Ok(()),
            Err(AppError::Internal(
                "failed to remove capability probe directory: os error 32".to_string(),
            )),
        );
        assert!(matches!(
            error,
            Err(AppError::Internal(message)) if message.contains("ACP session preparation failed")
        ));
    }

    #[test]
    fn authentication_required_is_a_user_actionable_error() {
        let error = AppError::from(agents::AgentError::AuthenticationRequired(
            "no auth method id provided".to_string(),
        ));
        assert!(matches!(
            error,
            AppError::BadRequest(message)
                if message.contains("需要先完成认证")
                    && message.contains("no auth method id provided")
        ));
    }

    #[tokio::test]
    async fn actual_session_outcome_repairs_stale_authentication_projections() {
        let pool = authentication_projection_pool().await;
        let agent_id = AgentId::parse("opencode").unwrap();
        sqlx::query("INSERT INTO agent_installation VALUES (?, 'needs_auth', 'lock-opencode')")
            .bind(agent_id.as_str())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            r#"INSERT INTO agent_probe
               (agent_id, lifecycle, authentication, detail_json, probed_at,
                authentication_required)
               VALUES (?, 'needs_auth', 'not_logged_in', '{}', 'now', 1)"#,
        )
        .bind(agent_id.as_str())
        .execute(&pool)
        .await
        .unwrap();

        settle_session_authentication(&pool, &agent_id, Ok(()))
            .await
            .unwrap();

        let open_code_state = sqlx::query_as::<_, (String, String, bool, i64)>(
            r#"SELECT lifecycle, authentication, authentication_required,
                      observation_generation
               FROM agent_probe WHERE agent_id = ?"#,
        )
        .bind(agent_id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(open_code_state.0, "ready");
        assert_eq!(open_code_state.1, "not_required");
        assert!(!open_code_state.2);
        assert_eq!(open_code_state.3, 1);

        let grok_error = settle_session_authentication::<()>(
            &pool,
            &agent_id,
            Err(agents::AgentError::AuthenticationRequired(
                "no auth method id provided".to_string(),
            )),
        )
        .await
        .unwrap_err();
        assert!(matches!(grok_error, AppError::BadRequest(_)));

        let grok_state = sqlx::query_as::<_, (String, String, bool, i64)>(
            r#"SELECT lifecycle, authentication, authentication_required,
                      observation_generation
               FROM agent_probe WHERE agent_id = ?"#,
        )
        .bind(agent_id.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(grok_state.0, "needs_auth");
        assert_eq!(grok_state.1, "not_logged_in");
        assert!(grok_state.2);
        assert_eq!(grok_state.3, 2);
    }
}
