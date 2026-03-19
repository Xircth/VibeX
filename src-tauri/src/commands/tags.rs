use db::models::tag::{CreateTag, Tag, UpdateTag};
use deployment::Deployment;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

#[tauri::command]
pub async fn get_tags(
    state: tauri::State<'_, AppState>,
    search: Option<String>,
) -> Result<Vec<Tag>, AppError> {
    let mut tags = Tag::find_all(&state.deployment.db().pool).await?;

    // Filter by search query if provided
    if let Some(search_query) = search {
        let search_lower = search_query.to_lowercase();
        tags.retain(|tag| tag.tag_name.to_lowercase().contains(&search_lower));
    }

    Ok(tags)
}

#[tauri::command]
pub async fn create_tag(
    state: tauri::State<'_, AppState>,
    payload: CreateTag,
) -> Result<Tag, AppError> {
    let tag = Tag::create(&state.deployment.db().pool, &payload).await?;
    Ok(tag)
}

#[tauri::command]
pub async fn update_tag(
    state: tauri::State<'_, AppState>,
    tag_id: Uuid,
    payload: UpdateTag,
) -> Result<Tag, AppError> {
    let updated_tag = Tag::update(&state.deployment.db().pool, tag_id, &payload).await?;
    Ok(updated_tag)
}

#[tauri::command]
pub async fn delete_tag(state: tauri::State<'_, AppState>, tag_id: Uuid) -> Result<(), AppError> {
    let rows_affected = Tag::delete(&state.deployment.db().pool, tag_id).await?;
    if rows_affected == 0 {
        Err(AppError::NotFound(format!("Tag {} not found", tag_id)))
    } else {
        Ok(())
    }
}
