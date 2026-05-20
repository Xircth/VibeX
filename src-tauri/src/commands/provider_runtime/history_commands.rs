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
    Ok(ProviderRuntimeStatus {
        provider,
        contract: provider_runtime_contract(provider),
        native: probe_native_runtime(provider).await,
        fallback: provider_fallback_status(provider),
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
    if provider == ProviderId::Claude {
        return load_claude_sdk_models(&repo_root_path()).await;
    }
    if provider == ProviderId::Opencode {
        return load_opencode_sdk_models(&repo_root_path()).await;
    }

    let models: Vec<(String, String)> = match provider {
        ProviderId::Claude => unreachable!("Claude models are loaded from Agent SDK metadata"),
        ProviderId::Codex => vec![
            ("gpt-5.5".to_string(), "GPT-5.5".to_string()),
            ("gpt-5.4".to_string(), "GPT-5.4".to_string()),
        ],
        ProviderId::Opencode => unreachable!("OpenCode models are loaded from SDK metadata"),
    };

    Ok(models
        .iter()
        .map(|(id, label)| ProviderModel {
            provider,
            id: id.to_string(),
            label: label.to_string(),
            source: match provider {
                ProviderId::Codex => CapabilitySource::AppServer,
                ProviderId::Claude => {
                    unreachable!("Claude models are loaded from Agent SDK metadata")
                }
                ProviderId::Opencode => {
                    unreachable!("OpenCode models are loaded from SDK metadata")
                }
            },
        })
        .collect())
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
    match try_native_provider_turn(&state, request.clone(), workspace_id, &session).await {
        Ok(event) => Ok(event),
        Err(native_error) => {
            let native_error_message = native_error.to_string();
            fallback_acp_turn(
                state,
                request,
                workspace_id,
                session,
                Some(native_error_message),
            )
            .await
        }
    }
}

#[tauri::command]
pub async fn provider_runtime_interrupt(
    provider: ProviderId,
    thread_id: Option<String>,
    turn_id: Option<String>,
) -> Result<(), AppError> {
    if provider == ProviderId::Codex
        && let (Some(thread_id), Some(turn_id)) = (thread_id.as_deref(), turn_id.as_deref())
    {
        let servers: Vec<Arc<CodexAppServer>> =
            CODEX_APP_SERVERS.lock().await.values().cloned().collect();
        for server in servers {
            let response = send_codex_request(
                &server,
                "turn/interrupt",
                json!({ "threadId": thread_id, "turnId": turn_id }),
                Duration::from_secs(5),
            )
            .await;
            if response.is_ok() {
                return Ok(());
            }
        }
    }

    let Some(turn_id) = turn_id else {
        return Err(AppError::BadRequest(format!(
            "{} interrupt requires a turn id",
            provider.label()
        )));
    };
    let Some(handle) = NATIVE_ACTIVE_TURNS.lock().await.remove(&turn_id) else {
        return Err(AppError::NotFound(format!("Turn {turn_id} is not active")));
    };
    if handle.provider != provider {
        return Err(AppError::BadRequest(format!(
            "Turn {turn_id} belongs to a different provider"
        )));
    }
    handle
        .child
        .lock()
        .await
        .kill()
        .await
        .map_err(|error| app_error_from_native(provider, error.to_string()))?;
    Ok(())
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

