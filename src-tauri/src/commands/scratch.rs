use db::models::scratch::{
    CreateScratch, Scratch, ScratchType, ScratchUpdateOutcome, UpdateScratch,
};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

#[tauri::command]
pub async fn create_scratch(
    state: tauri::State<'_, AppState>,
    scratch_type: ScratchType,
    id: Uuid,
    payload: CreateScratch,
) -> Result<Scratch, AppError> {
    payload.payload.validate_type(scratch_type)?;

    let scratch = Scratch::create(&state.deployment.db().pool, id, &payload).await?;
    Ok(scratch)
}

#[tauri::command]
pub async fn get_scratch(
    state: tauri::State<'_, AppState>,
    scratch_type: ScratchType,
    id: Uuid,
) -> Result<Scratch, AppError> {
    let scratch = Scratch::find_by_id(&state.deployment.db().pool, id, &scratch_type)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!("Scratch {} ({}) not found", id, scratch_type))
        })?;

    Ok(scratch)
}

#[tauri::command]
pub async fn update_scratch(
    state: tauri::State<'_, AppState>,
    scratch_type: ScratchType,
    id: Uuid,
    payload: UpdateScratch,
) -> Result<ScratchUpdateOutcome, AppError> {
    payload.payload.validate_type(scratch_type)?;
    Ok(Scratch::update(&state.deployment.db().pool, id, &scratch_type, &payload).await?)
}

#[tauri::command]
pub async fn delete_scratch(
    state: tauri::State<'_, AppState>,
    scratch_type: ScratchType,
    id: Uuid,
) -> Result<(), AppError> {
    Scratch::delete(&state.deployment.db().pool, id, &scratch_type).await?;
    Ok(())
}
