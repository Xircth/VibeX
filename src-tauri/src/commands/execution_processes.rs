use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    execution_process_repo_state::ExecutionProcessRepoState,
};
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

    state
        .deployment
        .container()
        .stop_execution(&process, ExecutionProcessStatus::Killed)
        .await?;

    Ok(())
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
