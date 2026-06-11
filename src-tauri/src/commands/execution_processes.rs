use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus},
    execution_process_repo_state::ExecutionProcessRepoState,
    session::Session,
};
use deployment::Deployment;
use services::services::container::ContainerService;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

#[tauri::command]
pub async fn get_execution_process(
    state: tauri::State<'_, AppState>,
    id: Uuid,
) -> Result<ExecutionProcess, AppError> {
    let process = ExecutionProcess::find_by_id(&state.deployment.db().pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Execution process {} not found", id)))?;
    Ok(process)
}

#[tauri::command]
pub async fn stop_execution_process(
    state: tauri::State<'_, AppState>,
    id: Uuid,
) -> Result<(), AppError> {
    let process = ExecutionProcess::find_by_id(&state.deployment.db().pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Execution process {} not found", id)))?;

    if should_stop_as_codex_native_process(&state, &process).await?
        && crate::commands::provider_runtime::interrupt_codex_native_execution_process(
            &state.deployment.db().pool,
            process.id,
        )
        .await?
    {
        return Ok(());
    }

    state
        .deployment
        .container()
        .stop_execution(&process, ExecutionProcessStatus::Killed)
        .await?;

    Ok(())
}

async fn should_stop_as_codex_native_process(
    state: &tauri::State<'_, AppState>,
    process: &ExecutionProcess,
) -> Result<bool, AppError> {
    if process.run_reason != ExecutionProcessRunReason::CodingAgent {
        return Ok(false);
    }

    let Some(session) =
        Session::find_by_id(&state.deployment.db().pool, process.session_id).await?
    else {
        return Ok(false);
    };

    Ok(session.executor.as_deref() == Some("codex"))
}

#[tauri::command]
pub async fn get_execution_process_repo_states(
    state: tauri::State<'_, AppState>,
    id: Uuid,
) -> Result<Vec<ExecutionProcessRepoState>, AppError> {
    // Verify the execution process exists
    let _process = ExecutionProcess::find_by_id(&state.deployment.db().pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Execution process {} not found", id)))?;

    let repo_states =
        ExecutionProcessRepoState::find_by_execution_process_id(&state.deployment.db().pool, id)
            .await?;
    Ok(repo_states)
}
