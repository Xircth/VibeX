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
    NATIVE_ACTIVE_TURNS, NativeConversationSink, NativeProcessHandle, ProviderId,
    ProviderRuntimeEvent, ProviderTurnRequest, app_error_from_native,
    create_native_execution_process, extract_thread_id, extract_turn_id,
    new_provider_hidden_command, normalize_provider_runtime_event,
    push_claude_provider_event_to_conversation, push_opencode_provider_event_to_conversation,
    push_provider_event, register_native_conversation_sink,
};
use crate::{error::AppError, state::AppState};

pub(super) struct BridgeRunSpec {
    pub(super) provider: ProviderId,
    pub(super) runtime_source: &'static str,
    pub(super) program: &'static str,
    pub(super) args: Vec<String>,
    pub(super) input_path: PathBuf,
    pub(super) workspace_dir: PathBuf,
    pub(super) workspace_id: Uuid,
    pub(super) turn_id: String,
}

async fn push_bridge_event_to_conversation(
    provider: ProviderId,
    sink: &NativeConversationSink,
    event: &Value,
) {
    match provider {
        ProviderId::Claude => push_claude_provider_event_to_conversation(sink, event).await,
        ProviderId::Opencode => push_opencode_provider_event_to_conversation(sink, event).await,
        ProviderId::Codex => {}
    }
}

fn parse_bridge_stdout_line(line: String) -> Value {
    serde_json::from_str::<Value>(&line).unwrap_or_else(|_| {
        json!({
            "type": "text_delta",
            "text": line,
        })
    })
}

struct BridgeStdoutContext {
    provider: ProviderId,
    session_id: String,
    workspace_id: String,
    thread_id: Option<String>,
    turn_id: String,
    pool: sqlx::SqlitePool,
    process_id: Uuid,
    sink: NativeConversationSink,
}

async fn bridge_stdout_loop(stdout: tokio::process::ChildStdout, context: BridgeStdoutContext) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let parsed = parse_bridge_stdout_line(line);
        if let Some(thread_id) = extract_thread_id(&parsed)
            && let Err(error) = CodingAgentTurn::update_agent_session_id(
                &context.pool,
                context.process_id,
                &thread_id,
            )
            .await
        {
            tracing::error!(
                "Failed to persist {} SDK session id for process {}: {}",
                context.provider.label(),
                context.process_id,
                error
            );
        }
        push_provider_event(
            &context.session_id,
            ProviderRuntimeEvent {
                provider: context.provider,
                workspace_id: context.workspace_id.clone(),
                thread_id: extract_thread_id(&parsed).or_else(|| context.thread_id.clone()),
                turn_id: extract_turn_id(&parsed).or_else(|| Some(context.turn_id.clone())),
                normalized: Vec::new(),
                event: parsed.clone(),
            },
        )
        .await;
        push_bridge_event_to_conversation(context.provider, &context.sink, &parsed).await;
    }
}

async fn bridge_stderr_loop(
    stderr: tokio::process::ChildStderr,
    provider: ProviderId,
    session_id: String,
    workspace_id: String,
    turn_id: String,
    sink: NativeConversationSink,
) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let event = json!({
            "type": "stderr",
            "message": line,
        });
        push_provider_event(
            &session_id,
            ProviderRuntimeEvent {
                provider,
                workspace_id: workspace_id.clone(),
                thread_id: None,
                turn_id: Some(turn_id.clone()),
                normalized: Vec::new(),
                event: event.clone(),
            },
        )
        .await;
        push_bridge_event_to_conversation(provider, &sink, &event).await;
    }
}

fn bridge_completion_event(
    runtime_source: &str,
    status: std::io::Result<std::process::ExitStatus>,
) -> (Value, ExecutionProcessStatus, Option<i64>) {
    match status {
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
    }
}

#[cfg(test)]
pub(super) fn bridge_completion_status_for_test(
    runtime_source: &str,
    status: std::io::Result<std::process::ExitStatus>,
) -> (Value, ExecutionProcessStatus, Option<i64>) {
    bridge_completion_event(runtime_source, status)
}

pub(super) async fn start_bridge_native_turn(
    state: &tauri::State<'_, AppState>,
    request: &ProviderTurnRequest,
    visible_prompt: &str,
    workspace: &Workspace,
    session: &Session,
    spec: BridgeRunSpec,
) -> Result<ProviderRuntimeEvent, AppError> {
    let mut command = new_provider_hidden_command(spec.program, spec.args.clone()).await;
    command
        .current_dir(&spec.workspace_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        let _ = std::fs::remove_file(&spec.input_path);
        app_error_from_native(spec.provider, error.to_string())
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| app_error_from_native(spec.provider, "missing stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| app_error_from_native(spec.provider, "missing stderr"))?;
    let child = Arc::new(Mutex::new(child));
    let process = create_native_execution_process(
        state,
        workspace,
        session,
        request,
        visible_prompt,
        request.thread_id.clone(),
        Some(spec.turn_id.clone()),
    )
    .await?;
    let conversation_sink = register_native_conversation_sink(state, process.id, session.id).await;

    NATIVE_ACTIVE_TURNS.lock().await.insert(
        spec.turn_id.clone(),
        NativeProcessHandle {
            provider: spec.provider,
            process_id: process.id,
            session_id: session.id,
            child: child.clone(),
        },
    );

    let event = normalize_provider_runtime_event(ProviderRuntimeEvent {
        provider: spec.provider,
        workspace_id: spec.workspace_id.to_string(),
        thread_id: request.thread_id.clone(),
        turn_id: Some(spec.turn_id.clone()),
        normalized: Vec::new(),
        event: json!({
            "type": "execution_started",
            "runtime_source": spec.runtime_source,
            "execution_process_id": process.id,
            "session_id": session.id,
            "program": spec.program,
            "args": spec.args,
        }),
    });
    push_provider_event(&session.id.to_string(), event.clone()).await;

    let stdout_reader = tokio::spawn(bridge_stdout_loop(
        stdout,
        BridgeStdoutContext {
            provider: spec.provider,
            session_id: session.id.to_string(),
            workspace_id: spec.workspace_id.to_string(),
            thread_id: request.thread_id.clone(),
            turn_id: spec.turn_id.clone(),
            pool: state.deployment.db().pool.clone(),
            process_id: process.id,
            sink: conversation_sink.clone(),
        },
    ));
    let stderr_reader = tokio::spawn(bridge_stderr_loop(
        stderr,
        spec.provider,
        session.id.to_string(),
        spec.workspace_id.to_string(),
        spec.turn_id.clone(),
        conversation_sink.clone(),
    ));

    let wait_session_id = session.id.to_string();
    let wait_workspace_id = spec.workspace_id.to_string();
    let wait_turn_id = spec.turn_id.clone();
    let wait_pool = state.deployment.db().pool.clone();
    let wait_process_id = process.id;
    let wait_session_uuid = session.id;
    let wait_msg_stores = state.deployment.container().msg_stores().clone();
    let wait_input_path = spec.input_path;
    let runtime_source = spec.runtime_source;
    let provider = spec.provider;
    tokio::spawn(async move {
        let status = child.lock().await.wait().await;
        let _ = stdout_reader.await;
        let _ = stderr_reader.await;
        let _ = std::fs::remove_file(&wait_input_path);
        NATIVE_ACTIVE_TURNS.lock().await.remove(&wait_turn_id);
        let (event, process_status, exit_code) = bridge_completion_event(runtime_source, status);
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
                normalized: Vec::new(),
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
