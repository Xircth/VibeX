use std::{path::PathBuf, process::Stdio, sync::Arc};

use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    session::{Session, SessionStatus},
    workspace::Workspace,
};
use deployment::Deployment;
use serde_json::{Value, json};
use services::services::container::ContainerService;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::Mutex,
};
use uuid::Uuid;

use super::{
    ACP_FALLBACK_ENV, NATIVE_ACTIVE_TURNS, NativeProcessHandle, ProviderId, ProviderRuntimeEvent,
    ProviderTurnRequest, acp_fallback_config, app_error_from_native,
    apply_native_commit_reminder_to_request, apply_profile_defaults_to_request,
    build_claude_sdk_bridge_args, build_claude_sdk_bridge_input, build_opencode_sdk_bridge_args,
    build_opencode_sdk_bridge_input, create_native_execution_process, extract_thread_id,
    extract_turn_id, load_provider_workspace, new_provider_hidden_command,
    prompt_with_display_images, provider_executor_profile_id, provider_option_string,
    push_native_provider_event_to_conversation, push_provider_event,
    register_native_conversation_sink, resolve_native_provider_request,
    resolve_provider_workspace_dir, should_force_acp_fallback, start_codex_native_turn,
    write_claude_sdk_bridge_input_file, write_opencode_sdk_bridge_input_file,
};
use crate::{error::AppError, state::AppState};

pub(super) fn provider_visible_prompt(request: &ProviderTurnRequest) -> String {
    let display_text = provider_option_string(&request.provider_options, "display_text")
        .or_else(|| provider_option_string(&request.provider_options, "displayText"))
        .unwrap_or(request.text.as_str());
    prompt_with_display_images(display_text, &request.images)
}

async fn start_claude_sdk_native_turn(
    state: &tauri::State<'_, AppState>,
    request: ProviderTurnRequest,
    visible_prompt: &str,
    workspace: &Workspace,
    workspace_dir: PathBuf,
    session: &Session,
) -> Result<ProviderRuntimeEvent, AppError> {
    let request =
        resolve_native_provider_request(&state.deployment.db().pool, session, request).await?;
    let provider = ProviderId::Claude;
    let workspace_id = workspace.id;
    let turn_id = Uuid::new_v4().to_string();
    let bridge_input = build_claude_sdk_bridge_input(&request, &workspace_dir)?;
    let bridge_input_path = write_claude_sdk_bridge_input_file(&bridge_input)?;
    let program = "node";
    let args = build_claude_sdk_bridge_args(&bridge_input_path);
    let runtime_source = "native_claude_agent_sdk";

    let mut command = new_provider_hidden_command(program, args.clone()).await;
    command
        .current_dir(&workspace_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        let _ = std::fs::remove_file(&bridge_input_path);
        app_error_from_native(provider, error.to_string())
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| app_error_from_native(provider, "missing stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| app_error_from_native(provider, "missing stderr"))?;
    let child = Arc::new(Mutex::new(child));
    let process = create_native_execution_process(
        state,
        workspace,
        session,
        &request,
        visible_prompt,
        request.thread_id.clone(),
        Some(turn_id.clone()),
    )
    .await?;
    let conversation_sink = register_native_conversation_sink(state, process.id, session.id).await;

    NATIVE_ACTIVE_TURNS.lock().await.insert(
        turn_id.clone(),
        NativeProcessHandle {
            provider,
            child: child.clone(),
        },
    );

    let event = ProviderRuntimeEvent {
        provider,
        workspace_id: workspace_id.to_string(),
        thread_id: request.thread_id.clone(),
        turn_id: Some(turn_id.clone()),
        event: json!({
            "type": "execution_started",
            "runtime_source": runtime_source,
            "execution_process_id": process.id,
            "session_id": session.id,
            "program": program,
            "args": args,
        }),
    };
    push_provider_event(&session.id.to_string(), event.clone()).await;

    let stdout_session_id = session.id.to_string();
    let stdout_workspace_id = workspace_id.to_string();
    let stdout_thread_id = request.thread_id.clone();
    let stdout_turn_id = turn_id.clone();
    let stdout_pool = state.deployment.db().pool.clone();
    let stdout_process_id = process.id;
    let stdout_sink = conversation_sink.clone();
    let stdout_reader = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let parsed = serde_json::from_str::<Value>(&line).unwrap_or_else(|_| {
                json!({
                    "type": "text_delta",
                    "text": line,
                })
            });
            if let Some(thread_id) = extract_thread_id(&parsed)
                && let Err(error) = CodingAgentTurn::update_agent_session_id(
                    &stdout_pool,
                    stdout_process_id,
                    &thread_id,
                )
                .await
            {
                tracing::error!(
                    "Failed to persist Claude SDK session id for process {}: {}",
                    stdout_process_id,
                    error
                );
            }
            push_provider_event(
                &stdout_session_id,
                ProviderRuntimeEvent {
                    provider,
                    workspace_id: stdout_workspace_id.clone(),
                    thread_id: extract_thread_id(&parsed).or_else(|| stdout_thread_id.clone()),
                    turn_id: extract_turn_id(&parsed).or_else(|| Some(stdout_turn_id.clone())),
                    event: parsed.clone(),
                },
            )
            .await;
            push_native_provider_event_to_conversation(&stdout_sink, &parsed).await;
        }
    });

    let stderr_session_id = session.id.to_string();
    let stderr_workspace_id = workspace_id.to_string();
    let stderr_turn_id = turn_id.clone();
    let stderr_sink = conversation_sink.clone();
    let stderr_reader = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            push_provider_event(
                &stderr_session_id,
                ProviderRuntimeEvent {
                    provider,
                    workspace_id: stderr_workspace_id.clone(),
                    thread_id: None,
                    turn_id: Some(stderr_turn_id.clone()),
                    event: json!({
                        "type": "stderr",
                        "message": line,
                    }),
                },
            )
            .await;
            push_native_provider_event_to_conversation(
                &stderr_sink,
                &json!({
                    "type": "stderr",
                    "message": line,
                }),
            )
            .await;
        }
    });

    let wait_session_id = session.id.to_string();
    let wait_workspace_id = workspace_id.to_string();
    let wait_turn_id = turn_id.clone();
    let wait_pool = state.deployment.db().pool.clone();
    let wait_process_id = process.id;
    let wait_session_uuid = session.id;
    let wait_msg_stores = state.deployment.container().msg_stores().clone();
    tokio::spawn(async move {
        let status = child.lock().await.wait().await;
        let _ = stdout_reader.await;
        let _ = stderr_reader.await;
        let _ = std::fs::remove_file(&bridge_input_path);
        NATIVE_ACTIVE_TURNS.lock().await.remove(&wait_turn_id);
        let (event, process_status, exit_code) = match status {
            Ok(status) if status.success() => (
                json!({
                    "method": "turn/completed",
                    "runtime_source": runtime_source,
                    "exit_code": status.code(),
                }),
                ExecutionProcessStatus::Completed,
                status.code().map(i64::from),
            ),
            Ok(status) => (
                json!({
                    "method": "turn/error",
                    "runtime_source": runtime_source,
                    "exit_code": status.code(),
                }),
                ExecutionProcessStatus::Failed,
                status.code().map(i64::from),
            ),
            Err(error) => (
                json!({
                    "method": "turn/error",
                    "runtime_source": runtime_source,
                    "error": error.to_string(),
                }),
                ExecutionProcessStatus::Failed,
                None,
            ),
        };
        if let Err(error) = ExecutionProcess::update_completion(
            &wait_pool,
            wait_process_id,
            process_status,
            exit_code,
        )
        .await
        {
            tracing::error!(
                "Failed to mark native provider process {} complete: {}",
                wait_process_id,
                error
            );
        }
        if let Err(error) =
            Session::update_status(&wait_pool, wait_session_uuid, SessionStatus::InReview).await
        {
            tracing::error!(
                "Failed to mark native provider session {} in review: {}",
                wait_session_uuid,
                error
            );
        }
        push_provider_event(
            &wait_session_id,
            ProviderRuntimeEvent {
                provider,
                workspace_id: wait_workspace_id,
                thread_id: None,
                turn_id: Some(wait_turn_id),
                event,
            },
        )
        .await;
        if let Some(msg_store) = wait_msg_stores.write().await.remove(&wait_process_id) {
            msg_store.push_finished();
        }
    });

    Ok(event)
}

async fn start_opencode_sdk_native_turn(
    state: &tauri::State<'_, AppState>,
    request: ProviderTurnRequest,
    visible_prompt: &str,
    workspace: &Workspace,
    workspace_dir: PathBuf,
    session: &Session,
) -> Result<ProviderRuntimeEvent, AppError> {
    let request =
        resolve_native_provider_request(&state.deployment.db().pool, session, request).await?;
    let provider = ProviderId::Opencode;
    let workspace_id = workspace.id;
    let turn_id = Uuid::new_v4().to_string();
    let bridge_input = build_opencode_sdk_bridge_input(&request, &workspace_dir)?;
    let bridge_input_path = write_opencode_sdk_bridge_input_file(&bridge_input)?;
    let program = "node";
    let args = build_opencode_sdk_bridge_args(&bridge_input_path);
    let runtime_source = "native_opencode_sdk";

    let mut command = new_provider_hidden_command(program, args.clone()).await;
    command
        .current_dir(&workspace_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        let _ = std::fs::remove_file(&bridge_input_path);
        app_error_from_native(provider, error.to_string())
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| app_error_from_native(provider, "missing stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| app_error_from_native(provider, "missing stderr"))?;
    let child = Arc::new(Mutex::new(child));
    let process = create_native_execution_process(
        state,
        workspace,
        session,
        &request,
        visible_prompt,
        request.thread_id.clone(),
        Some(turn_id.clone()),
    )
    .await?;
    let conversation_sink = register_native_conversation_sink(state, process.id, session.id).await;

    NATIVE_ACTIVE_TURNS.lock().await.insert(
        turn_id.clone(),
        NativeProcessHandle {
            provider,
            child: child.clone(),
        },
    );

    let event = ProviderRuntimeEvent {
        provider,
        workspace_id: workspace_id.to_string(),
        thread_id: request.thread_id.clone(),
        turn_id: Some(turn_id.clone()),
        event: json!({
            "type": "execution_started",
            "runtime_source": runtime_source,
            "execution_process_id": process.id,
            "session_id": session.id,
            "program": program,
            "args": args,
        }),
    };
    push_provider_event(&session.id.to_string(), event.clone()).await;

    let stdout_session_id = session.id.to_string();
    let stdout_workspace_id = workspace_id.to_string();
    let stdout_thread_id = request.thread_id.clone();
    let stdout_turn_id = turn_id.clone();
    let stdout_pool = state.deployment.db().pool.clone();
    let stdout_process_id = process.id;
    let stdout_sink = conversation_sink.clone();
    let stdout_reader = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let parsed = serde_json::from_str::<Value>(&line).unwrap_or_else(|_| {
                json!({
                    "type": "text_delta",
                    "text": line,
                })
            });
            if let Some(thread_id) = extract_thread_id(&parsed)
                && let Err(error) = CodingAgentTurn::update_agent_session_id(
                    &stdout_pool,
                    stdout_process_id,
                    &thread_id,
                )
                .await
            {
                tracing::error!(
                    "Failed to persist OpenCode SDK session id for process {}: {}",
                    stdout_process_id,
                    error
                );
            }
            push_provider_event(
                &stdout_session_id,
                ProviderRuntimeEvent {
                    provider,
                    workspace_id: stdout_workspace_id.clone(),
                    thread_id: extract_thread_id(&parsed).or_else(|| stdout_thread_id.clone()),
                    turn_id: extract_turn_id(&parsed).or_else(|| Some(stdout_turn_id.clone())),
                    event: parsed.clone(),
                },
            )
            .await;
            push_native_provider_event_to_conversation(&stdout_sink, &parsed).await;
        }
    });

    let stderr_session_id = session.id.to_string();
    let stderr_workspace_id = workspace_id.to_string();
    let stderr_turn_id = turn_id.clone();
    let stderr_sink = conversation_sink.clone();
    let stderr_reader = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            push_provider_event(
                &stderr_session_id,
                ProviderRuntimeEvent {
                    provider,
                    workspace_id: stderr_workspace_id.clone(),
                    thread_id: None,
                    turn_id: Some(stderr_turn_id.clone()),
                    event: json!({
                        "type": "stderr",
                        "message": line,
                    }),
                },
            )
            .await;
            push_native_provider_event_to_conversation(
                &stderr_sink,
                &json!({
                    "type": "stderr",
                    "message": line,
                }),
            )
            .await;
        }
    });

    let wait_session_id = session.id.to_string();
    let wait_workspace_id = workspace_id.to_string();
    let wait_turn_id = turn_id.clone();
    let wait_pool = state.deployment.db().pool.clone();
    let wait_process_id = process.id;
    let wait_session_uuid = session.id;
    let wait_msg_stores = state.deployment.container().msg_stores().clone();
    tokio::spawn(async move {
        let status = child.lock().await.wait().await;
        let _ = stdout_reader.await;
        let _ = stderr_reader.await;
        let _ = std::fs::remove_file(&bridge_input_path);
        NATIVE_ACTIVE_TURNS.lock().await.remove(&wait_turn_id);
        let (event, process_status, exit_code) = match status {
            Ok(status) if status.success() => (
                json!({
                    "method": "turn/completed",
                    "runtime_source": runtime_source,
                    "exit_code": status.code(),
                }),
                ExecutionProcessStatus::Completed,
                status.code().map(i64::from),
            ),
            Ok(status) => (
                json!({
                    "method": "turn/error",
                    "runtime_source": runtime_source,
                    "exit_code": status.code(),
                }),
                ExecutionProcessStatus::Failed,
                status.code().map(i64::from),
            ),
            Err(error) => (
                json!({
                    "method": "turn/error",
                    "runtime_source": runtime_source,
                    "error": error.to_string(),
                }),
                ExecutionProcessStatus::Failed,
                None,
            ),
        };
        if let Err(error) = ExecutionProcess::update_completion(
            &wait_pool,
            wait_process_id,
            process_status,
            exit_code,
        )
        .await
        {
            tracing::error!(
                "Failed to mark native provider process {} complete: {}",
                wait_process_id,
                error
            );
        }
        if let Err(error) =
            Session::update_status(&wait_pool, wait_session_uuid, SessionStatus::InReview).await
        {
            tracing::error!(
                "Failed to mark native provider session {} in review: {}",
                wait_session_uuid,
                error
            );
        }
        push_provider_event(
            &wait_session_id,
            ProviderRuntimeEvent {
                provider,
                workspace_id: wait_workspace_id,
                thread_id: None,
                turn_id: Some(wait_turn_id),
                event,
            },
        )
        .await;
        if let Some(msg_store) = wait_msg_stores.write().await.remove(&wait_process_id) {
            msg_store.push_finished();
        }
    });

    Ok(event)
}

pub(super) async fn try_native_provider_turn(
    state: &tauri::State<'_, AppState>,
    mut request: ProviderTurnRequest,
    workspace_id: Uuid,
    session: &Session,
) -> Result<ProviderRuntimeEvent, AppError> {
    if should_force_acp_fallback(&request) {
        return Err(app_error_from_native(
            request.provider,
            "native runtime disabled by provider option `force_acp_fallback`",
        ));
    }

    apply_profile_defaults_to_request(&mut request);
    let visible_prompt = provider_visible_prompt(&request);
    let mut workspace = load_provider_workspace(state, workspace_id).await?;
    let workspace_dir = resolve_provider_workspace_dir(state, &mut workspace).await?;
    apply_native_commit_reminder_to_request(state, &mut request, &workspace_dir).await;
    match request.provider {
        ProviderId::Codex => {
            start_codex_native_turn(
                state,
                request,
                &visible_prompt,
                &workspace,
                workspace_dir,
                session,
            )
            .await
        }
        ProviderId::Claude => {
            start_claude_sdk_native_turn(
                state,
                request,
                &visible_prompt,
                &workspace,
                workspace_dir,
                session,
            )
            .await
        }
        ProviderId::Opencode => {
            start_opencode_sdk_native_turn(
                state,
                request,
                &visible_prompt,
                &workspace,
                workspace_dir,
                session,
            )
            .await
        }
    }
}

pub(super) async fn fallback_acp_turn(
    state: tauri::State<'_, AppState>,
    request: ProviderTurnRequest,
    workspace_id: Uuid,
    session: Session,
    native_error: Option<String>,
) -> Result<ProviderRuntimeEvent, AppError> {
    let fallback = acp_fallback_config(request.provider);
    if !fallback.enabled {
        let env_name = fallback.env_name.unwrap_or(ACP_FALLBACK_ENV);
        let native_error = native_error.unwrap_or_else(|| "native runtime unavailable".to_string());
        return Err(AppError::BadRequest(format!(
            "{} ACP fallback is disabled by `{}`; native runtime error: {}",
            request.provider.label(),
            env_name,
            native_error
        )));
    }

    let executor_profile_id = provider_executor_profile_id(&request);
    let prompt = prompt_with_display_images(&request.text, &request.images);
    let process = crate::commands::sessions::follow_up(
        state,
        session.id,
        prompt,
        executor_profile_id,
        None,
        None,
        None,
    )
    .await?;

    let mut payload = json!({
        "type": "execution_started",
        "runtime_source": "acp_fallback",
        "execution_process_id": process.id,
        "session_id": session.id,
        "provider": request.provider,
    });
    if let Some(native_error) = native_error
        && let Some(object) = payload.as_object_mut()
    {
        object.insert("fallback_reason".to_string(), json!(native_error));
    }

    Ok(ProviderRuntimeEvent {
        provider: request.provider,
        workspace_id: workspace_id.to_string(),
        thread_id: request.thread_id,
        turn_id: Some(process.id.to_string()),
        event: payload,
    })
}
