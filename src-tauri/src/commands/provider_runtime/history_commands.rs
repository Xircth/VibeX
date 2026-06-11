use std::{sync::Arc, time::Duration};

use db::models::{
    coding_agent_turn::CodingAgentTurn, execution_process::ExecutionProcess,
    execution_process_logs::ExecutionProcessLogs, session::Session,
};
use deployment::Deployment;
use serde_json::{Value, json};
use utils::log_msg::LogMsg;
use uuid::Uuid;

use super::{
    CODEX_APP_SERVERS, CODEX_REQUEST_TIMEOUT_SECS, CodexAppServer, PROVIDER_EVENT_HISTORY,
    ProviderCapabilityState, ProviderCommand, ProviderHistorySnapshot, ProviderId, ProviderModel,
    ProviderRuntimeEvent, ProviderRuntimeStatus, ProviderSessionSummary, ProviderTurnRequest,
    app_error_from_native, codex_response_success, codex_workspace_cwd_param,
    ensure_codex_app_server_for_workspace, ensure_provider_session, fallback_acp_turn,
    kill_active_native_turn, load_claude_sdk_commands, load_claude_sdk_models,
    load_codex_app_server_models, load_opencode_sdk_commands, load_opencode_sdk_models,
    load_provider_workspace, native_provider_error_event, probe_native_runtime_with_dependencies,
    provider_capabilities, provider_fallback_policy, provider_fallback_status,
    provider_runtime_contract, provider_slash_commands, repo_root_path,
    resolve_provider_workspace_dir, send_codex_app_server_workspace_request, send_codex_request,
    send_codex_response, send_codex_turn_interrupt, session_executor_matches_provider,
    should_force_acp_fallback, try_native_provider_turn, try_steer_active_codex_turn,
    validate_provider_executor_profile,
};
use crate::{error::AppError, state::AppState};

pub(super) fn provider_history_retention_marker() -> Value {
    json!({
        "raw_provider_events": "live_only",
        "persisted_history": "normalized_logs_only",
        "description": "In-memory provider events are available only for the current app process; persisted history is reconstructed from execution logs.",
    })
}

async fn load_provider_history_from_db(
    state: &tauri::State<'_, AppState>,
    provider: ProviderId,
    loader: &str,
    session: Session,
) -> Result<ProviderHistorySnapshot, AppError> {
    let pool = &state.deployment.db().pool;
    let session_id = session.id.to_string();
    let in_memory_events = PROVIDER_EVENT_HISTORY
        .lock()
        .await
        .get(&provider.history_key(&session_id))
        .cloned()
        .unwrap_or_default();
    let processes = ExecutionProcess::find_by_session_id(pool, session.id, false).await?;

    let mut turns = Vec::new();
    for process in processes {
        let turn = CodingAgentTurn::find_by_execution_process_id(pool, process.id).await?;
        let raw_logs = ExecutionProcessLogs::find_by_execution_id(pool, process.id).await?;
        let parsed_logs = ExecutionProcessLogs::parse_logs(&raw_logs).unwrap_or_default();
        let log_count = parsed_logs.len();
        let log_preview: Vec<Value> = parsed_logs
            .into_iter()
            .take(24)
            .map(|entry| match entry {
                LogMsg::Stdout(value) => json!({ "type": "stdout", "value": value }),
                LogMsg::Stderr(value) => json!({ "type": "stderr", "value": value }),
                LogMsg::SessionId(value) => json!({ "type": "session_id", "value": value }),
                LogMsg::MessageId(value) => json!({ "type": "message_id", "value": value }),
                LogMsg::Ready => json!({ "type": "ready" }),
                LogMsg::Finished => json!({ "type": "finished" }),
                LogMsg::JsonPatch(value) => json!({ "type": "json_patch", "value": value }),
            })
            .collect();
        turns.push(json!({
            "execution_process": {
                "id": process.id,
                "status": process.status,
                "run_reason": process.run_reason,
                "started_at": process.started_at,
                "completed_at": process.completed_at,
            },
            "turn": turn,
            "raw_log_count": log_count,
            "raw_log_preview": log_preview,
        }));
    }

    Ok(ProviderHistorySnapshot {
        provider,
        session_id,
        events: in_memory_events,
        raw: Some(json!({
            "source": loader,
            "history_retention": provider_history_retention_marker(),
            "provider": provider,
            "session": {
                "id": session.id,
                "workspace_id": session.workspace_id,
                "name": session.name,
                "status": session.status,
                "executor": session.executor,
            },
            "turns": turns,
        })),
    })
}

async fn load_claude_history(
    state: &tauri::State<'_, AppState>,
    session: Session,
) -> Result<ProviderHistorySnapshot, AppError> {
    load_provider_history_from_db(state, ProviderId::Claude, "claude_history_loader", session).await
}

async fn load_codex_history(
    state: &tauri::State<'_, AppState>,
    session: Session,
) -> Result<ProviderHistorySnapshot, AppError> {
    load_provider_history_from_db(state, ProviderId::Codex, "codex_history_loader", session).await
}

async fn load_opencode_history(
    state: &tauri::State<'_, AppState>,
    session: Session,
) -> Result<ProviderHistorySnapshot, AppError> {
    load_provider_history_from_db(
        state,
        ProviderId::Opencode,
        "opencode_history_loader",
        session,
    )
    .await
}

#[tauri::command]
pub async fn provider_runtime_get_capabilities(
    provider: ProviderId,
) -> Result<ProviderCapabilityState, AppError> {
    Ok(provider_capabilities(provider))
}

#[tauri::command]
pub async fn provider_runtime_get_status(
    provider: ProviderId,
) -> Result<ProviderRuntimeStatus, AppError> {
    let (native, dependencies) = probe_native_runtime_with_dependencies(provider).await;
    Ok(ProviderRuntimeStatus {
        provider,
        contract: provider_runtime_contract(provider),
        native,
        fallback: provider_fallback_status(provider),
        dependencies,
    })
}

#[tauri::command]
pub async fn provider_runtime_get_commands(
    state: tauri::State<'_, AppState>,
    provider: ProviderId,
    workspace_id: Option<Uuid>,
    repo_id: Option<Uuid>,
) -> Result<Vec<ProviderCommand>, AppError> {
    let _ = repo_id;
    if provider == ProviderId::Claude
        && let Some(workspace_id) = workspace_id
    {
        let mut workspace = load_provider_workspace(&state, workspace_id).await?;
        let workspace_dir = resolve_provider_workspace_dir(&state, &mut workspace).await?;
        return load_claude_sdk_commands(&workspace_dir).await;
    }
    if provider == ProviderId::Opencode
        && let Some(workspace_id) = workspace_id
    {
        let mut workspace = load_provider_workspace(&state, workspace_id).await?;
        let workspace_dir = resolve_provider_workspace_dir(&state, &mut workspace).await?;
        return load_opencode_sdk_commands(&workspace_dir).await;
    }

    Ok(provider_slash_commands(provider))
}

#[tauri::command]
pub async fn provider_runtime_list_models(
    provider: ProviderId,
) -> Result<Vec<ProviderModel>, AppError> {
    match provider {
        ProviderId::Claude => load_claude_sdk_models(&repo_root_path()).await,
        ProviderId::Codex => load_codex_app_server_models().await,
        ProviderId::Opencode => load_opencode_sdk_models(&repo_root_path()).await,
    }
}

#[tauri::command]
pub async fn provider_runtime_send_turn(
    state: tauri::State<'_, AppState>,
    request: ProviderTurnRequest,
) -> Result<ProviderRuntimeEvent, AppError> {
    validate_provider_executor_profile(&request)?;
    let workspace_id = Uuid::parse_str(&request.workspace_id).map_err(|_| {
        AppError::BadRequest(format!("Invalid workspace id: {}", request.workspace_id))
    })?;
    let session = ensure_provider_session(
        &state,
        request.provider,
        workspace_id,
        request.session_id.as_deref(),
        &request.text,
    )
    .await?;
    if request.provider == ProviderId::Codex
        && let Some(event) = try_steer_active_codex_turn(
            &state.deployment.db().pool,
            &request,
            workspace_id,
            &session,
        )
        .await?
    {
        return Ok(event);
    }
    if should_force_acp_fallback(&request) {
        return fallback_acp_turn(
            state,
            request,
            workspace_id,
            session,
            Some("native runtime bypassed by provider option `force_acp_fallback`".to_string()),
        )
        .await;
    }
    let fallback_policy = provider_fallback_policy(&request);
    match try_native_provider_turn(&state, request.clone(), workspace_id, &session).await {
        Ok(event) => Ok(event),
        Err(native_error) => {
            let native_error_message = native_error.to_string();
            if fallback_policy.allows_auto_fallback() {
                fallback_acp_turn(
                    state,
                    request,
                    workspace_id,
                    session,
                    Some(native_error_message),
                )
                .await
            } else {
                Ok(native_provider_error_event(
                    &request,
                    workspace_id,
                    session.id,
                    &native_error,
                    fallback_policy.as_str(),
                ))
            }
        }
    }
}

#[tauri::command]
pub async fn provider_runtime_interrupt(
    state: tauri::State<'_, AppState>,
    provider: ProviderId,
    thread_id: Option<String>,
    turn_id: Option<String>,
) -> Result<(), AppError> {
    if provider == ProviderId::Codex
        && let (Some(thread_id), Some(turn_id)) = (thread_id.as_deref(), turn_id.as_deref())
    {
        send_codex_turn_interrupt(thread_id, turn_id)
            .await
            .map_err(AppError::Internal)?;
        return Ok(());
    }

    let Some(turn_id) = turn_id else {
        return Err(AppError::BadRequest(format!(
            "{} interrupt requires a turn id",
            provider.label()
        )));
    };
    kill_active_native_turn(&state, provider, turn_id).await
}

#[tauri::command]
pub async fn provider_runtime_list_sessions(
    state: tauri::State<'_, AppState>,
    provider: ProviderId,
    workspace_id: Option<Uuid>,
) -> Result<Vec<ProviderSessionSummary>, AppError> {
    let Some(workspace_id) = workspace_id else {
        return Ok(Vec::new());
    };
    let sessions = Session::find_by_workspace_id(&state.deployment.db().pool, workspace_id).await?;

    Ok(sessions
        .into_iter()
        .filter(|session| session_executor_matches_provider(session.executor.as_deref(), provider))
        .map(|session| ProviderSessionSummary {
            provider,
            session_id: session.id.to_string(),
            title: session.name.or(session.initial_prompt),
        })
        .collect())
}

#[tauri::command]
pub async fn provider_runtime_load_history(
    state: tauri::State<'_, AppState>,
    provider: ProviderId,
    session_id: Uuid,
) -> Result<ProviderHistorySnapshot, AppError> {
    let session = Session::find_by_id(&state.deployment.db().pool, session_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Session {session_id} not found")))?;

    if !session_executor_matches_provider(session.executor.as_deref(), provider) {
        return Err(AppError::BadRequest(format!(
            "Session {session_id} belongs to a different provider"
        )));
    }

    match provider {
        ProviderId::Claude => load_claude_history(&state, session).await,
        ProviderId::Codex => load_codex_history(&state, session).await,
        ProviderId::Opencode => load_opencode_history(&state, session).await,
    }
}

#[tauri::command]
pub async fn provider_runtime_respond_to_request(
    provider: ProviderId,
    request_id: String,
    response: serde_json::Value,
) -> Result<(), AppError> {
    match provider {
        ProviderId::Codex => {
            let servers: Vec<Arc<CodexAppServer>> =
                CODEX_APP_SERVERS.lock().await.values().cloned().collect();
            if servers.is_empty() {
                return Err(AppError::NotFound(
                    "No active Codex app-server runtime found".to_string(),
                ));
            }
            let mut last_error = None;
            for server in servers {
                match send_codex_response(&server, &request_id, response.clone()).await {
                    Ok(()) => return Ok(()),
                    Err(error) => last_error = Some(error),
                }
            }
            Err(app_error_from_native(
                provider,
                last_error.unwrap_or_else(|| "failed to send response".to_string()),
            ))
        }
        ProviderId::Claude | ProviderId::Opencode => Err(AppError::BadRequest(format!(
            "{} request response routing is not exposed by the selected native CLI surface",
            provider.label()
        ))),
    }
}

#[tauri::command]
pub async fn provider_runtime_codex_list_skills(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    force_reload: Option<bool>,
) -> Result<Value, AppError> {
    let server =
        ensure_codex_app_server_for_workspace(&state, workspace_id, "codex-skills-list").await?;
    let response = send_codex_request(
        &server,
        "skills/list",
        json!({
            "cwds": [codex_workspace_cwd_param(&server)],
            "forceReload": force_reload.unwrap_or(false),
        }),
        Duration::from_secs(CODEX_REQUEST_TIMEOUT_SECS),
    )
    .await
    .and_then(|response| {
        codex_response_success("skills/list", &response)?;
        Ok(response)
    })
    .map_err(|error| app_error_from_native(ProviderId::Codex, error))?;
    Ok(response.get("result").cloned().unwrap_or(response))
}

#[tauri::command]
pub async fn provider_runtime_codex_configure_skill(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    path: Option<String>,
    name: Option<String>,
    enabled: bool,
) -> Result<Value, AppError> {
    send_codex_app_server_workspace_request(
        &state,
        workspace_id,
        "skills/config/write",
        json!({
            "path": path,
            "name": name,
            "enabled": enabled,
        }),
    )
    .await
}

#[tauri::command]
pub async fn provider_runtime_codex_list_hooks(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Value, AppError> {
    let server =
        ensure_codex_app_server_for_workspace(&state, workspace_id, "codex-hooks-list").await?;
    let response = send_codex_request(
        &server,
        "hooks/list",
        json!({
            "cwds": [codex_workspace_cwd_param(&server)],
        }),
        Duration::from_secs(CODEX_REQUEST_TIMEOUT_SECS),
    )
    .await
    .and_then(|response| {
        codex_response_success("hooks/list", &response)?;
        Ok(response)
    })
    .map_err(|error| app_error_from_native(ProviderId::Codex, error))?;
    Ok(response.get("result").cloned().unwrap_or(response))
}

#[tauri::command]
pub async fn provider_runtime_codex_set_hook_enabled(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    hook_key: String,
    enabled: bool,
) -> Result<Value, AppError> {
    let mut hook_state = serde_json::Map::new();
    hook_state.insert(hook_key, json!({ "enabled": enabled }));
    send_codex_app_server_workspace_request(
        &state,
        workspace_id,
        "config/batchWrite",
        json!({
            "edits": [{
                "keyPath": "hooks.state",
                "value": Value::Object(hook_state),
                "mergeStrategy": "upsert",
            }],
            "reloadUserConfig": true,
        }),
    )
    .await
}

#[tauri::command]
pub async fn provider_runtime_codex_list_apps(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    thread_id: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
    force_refetch: Option<bool>,
) -> Result<Value, AppError> {
    let mut params = serde_json::Map::new();
    params.insert(
        "cursor".to_string(),
        cursor.map_or(Value::Null, Value::from),
    );
    params.insert("limit".to_string(), json!(limit.unwrap_or(50)));
    params.insert(
        "forceRefetch".to_string(),
        json!(force_refetch.unwrap_or(false)),
    );
    if let Some(thread_id) = thread_id.filter(|value| !value.trim().is_empty()) {
        params.insert("threadId".to_string(), json!(thread_id));
    }

    send_codex_app_server_workspace_request(&state, workspace_id, "app/list", Value::Object(params))
        .await
}
