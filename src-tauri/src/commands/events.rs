use db::models::scratch::ScratchType;
use deployment::Deployment;
use executors::profile::ExecutorProfileId;
use futures::StreamExt;
use services::services::container::ContainerService;
use tauri::{AppHandle, Emitter};
use utils::log_msg::LogMsg;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

/// Subscribe to diff stream for a workspace.
/// Frontend listens to "diff-stream:{workspace_id}" event.
#[tauri::command]
pub async fn subscribe_diff_stream(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    stats_only: Option<bool>,
) -> Result<(), AppError> {
    let pool = &state.deployment.db().pool;
    let workspace = db::models::workspace::Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let channel = format!("diff-stream:{}", workspace_id);
    let deployment = state.deployment.clone();
    let stats = stats_only.unwrap_or(false);

    tokio::spawn(async move {
        match deployment.container().stream_diff(&workspace, stats).await {
            Ok(mut stream) => {
                while let Some(Ok(msg)) = stream.next().await {
                    if app.emit(&channel, &msg).is_err() {
                        break;
                    }
                }
            }
            Err(e) => {
                tracing::error!(
                    "Failed to start diff stream for workspace {}: {}",
                    workspace_id,
                    e
                );
            }
        }
    });

    Ok(())
}

/// Subscribe to conversation/execution log stream for an execution process.
/// Frontend listens to "conversation-stream:{execution_process_id}" event.
#[tauri::command]
pub async fn subscribe_conversation_stream(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    execution_process_id: Uuid,
    normalized: Option<bool>,
) -> Result<(), AppError> {
    let channel = format!("conversation-stream:{}", execution_process_id);
    let deployment = state.deployment.clone();
    let use_normalized = normalized.unwrap_or(true);

    tokio::spawn(async move {
        let stream_opt = if use_normalized {
            deployment
                .container()
                .stream_normalized_logs(&execution_process_id)
                .await
        } else {
            deployment
                .container()
                .stream_raw_logs(&execution_process_id)
                .await
        };

        if let Some(mut stream) = stream_opt {
            while let Some(Ok(msg)) = stream.next().await {
                if app.emit(&channel, &msg).is_err() {
                    break;
                }
            }
        }

        // Best-effort completion signal so frontend historic log loaders
        // don't wait forever when backend streams end without an explicit Finished.
        let _ = app.emit(&channel, &LogMsg::Finished);
    });

    Ok(())
}

/// Subscribe to execution processes list for a session.
/// Frontend listens to "execution-processes-stream:{session_id}" event.
#[tauri::command]
pub async fn subscribe_execution_processes_stream(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: Uuid,
    show_soft_deleted: Option<bool>,
) -> Result<(), AppError> {
    let channel = format!("execution-processes-stream:{}", session_id);
    let deployment = state.deployment.clone();
    let soft_deleted = show_soft_deleted.unwrap_or(false);

    tokio::spawn(async move {
        match deployment
            .events()
            .stream_execution_processes_for_session_raw(session_id, soft_deleted)
            .await
        {
            Ok(mut stream) => {
                while let Some(Ok(msg)) = stream.next().await {
                    if app.emit(&channel, &msg).is_err() {
                        break;
                    }
                }
            }
            Err(e) => {
                tracing::error!(
                    "Failed to start execution processes stream for session {}: {}",
                    session_id,
                    e
                );
            }
        }
    });

    Ok(())
}

/// Subscribe to tasks stream for a project.
/// Frontend listens to "tasks-stream:{project_id}" event.
#[tauri::command]
pub async fn subscribe_tasks_stream(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    project_id: Uuid,
) -> Result<(), AppError> {
    let channel = format!("tasks-stream:{}", project_id);
    let deployment = state.deployment.clone();

    tokio::spawn(async move {
        match deployment.events().stream_tasks_raw(project_id).await {
            Ok(mut stream) => {
                while let Some(Ok(msg)) = stream.next().await {
                    if app.emit(&channel, &msg).is_err() {
                        break;
                    }
                }
            }
            Err(e) => {
                tracing::error!(
                    "Failed to start tasks stream for project {}: {}",
                    project_id,
                    e
                );
            }
        }
    });

    Ok(())
}

/// Subscribe to projects stream.
/// Frontend listens to "projects-stream" event.
#[tauri::command]
pub async fn subscribe_projects_stream(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let channel = "projects-stream".to_string();
    let deployment = state.deployment.clone();

    tokio::spawn(async move {
        match deployment.events().stream_projects_raw().await {
            Ok(mut stream) => {
                while let Some(Ok(msg)) = stream.next().await {
                    if app.emit(&channel, &msg).is_err() {
                        break;
                    }
                }
            }
            Err(e) => {
                tracing::error!("Failed to start projects stream: {}", e);
            }
        }
    });

    Ok(())
}

/// Subscribe to scratch stream.
/// Frontend listens to "scratch-stream:{scratch_id}" event.
#[tauri::command]
pub async fn subscribe_scratch_stream(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    scratch_id: Uuid,
    scratch_type: ScratchType,
) -> Result<(), AppError> {
    let channel = format!("scratch-stream:{}", scratch_id);
    let deployment = state.deployment.clone();

    tokio::spawn(async move {
        match deployment
            .events()
            .stream_scratch_raw(scratch_id, &scratch_type)
            .await
        {
            Ok(mut stream) => {
                while let Some(Ok(msg)) = stream.next().await {
                    if app.emit(&channel, &msg).is_err() {
                        break;
                    }
                }
            }
            Err(e) => {
                tracing::error!("Failed to start scratch stream for {}: {}", scratch_id, e);
            }
        }
    });

    Ok(())
}

/// Subscribe to log stream for a process (e.g. dev server).
/// Frontend listens to "log-stream:{process_id}" event.
#[tauri::command]
pub async fn subscribe_log_stream(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    process_id: Uuid,
) -> Result<(), AppError> {
    let channel = format!("log-stream:{}", process_id);
    let deployment = state.deployment.clone();

    tokio::spawn(async move {
        let stream_opt = deployment.container().stream_raw_logs(&process_id).await;

        if let Some(mut stream) = stream_opt {
            while let Some(Ok(msg)) = stream.next().await {
                if app.emit(&channel, &msg).is_err() {
                    break;
                }
            }
        }
    });
    Ok(())
}

/// Subscribe to slash commands stream for an agent.
/// Frontend listens to "slash-commands-stream:{executor}:{variant}:{workspace_id}:{repo_id}" event.
#[tauri::command]
pub async fn subscribe_slash_commands_stream(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    executor_profile_id: ExecutorProfileId,
    workspace_id: Option<Uuid>,
    repo_id: Option<Uuid>,
) -> Result<(), AppError> {
    let variant_str = executor_profile_id.variant.as_deref().unwrap_or("default");
    let ws_str = workspace_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "none".to_string());
    let repo_str = repo_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "none".to_string());
    let channel = format!(
        "slash-commands-stream:{}:{}:{}:{}",
        executor_profile_id.executor, variant_str, ws_str, repo_str
    );
    let deployment = state.deployment.clone();

    tokio::spawn(async move {
        match deployment
            .container()
            .available_agent_slash_commands(executor_profile_id.clone(), workspace_id, repo_id)
            .await
        {
            Ok(Some(mut stream)) => {
                while let Some(patch) = stream.next().await {
                    let msg = LogMsg::JsonPatch(patch);
                    if app.emit(&channel, &msg).is_err() {
                        break;
                    }
                }
                // Signal completion
                let _ = app.emit(&channel, &LogMsg::Finished);
            }
            Ok(None) => {
                let _ = app.emit(&channel, &LogMsg::Finished);
            }
            Err(e) => {
                tracing::error!(
                    "Failed to start slash commands stream for {:?}: {}",
                    executor_profile_id,
                    e
                );
                let _ = app.emit(&channel, &LogMsg::Finished);
            }
        }
    });

    Ok(())
}
