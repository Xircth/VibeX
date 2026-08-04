use std::collections::BTreeMap;

use serde_json::Value;
use services::services::settings_store::{merge_object_section, read_section};

use crate::error::AppError;

const SETTINGS_SECTION: &str = "frontend";

pub type FrontendPreferences = BTreeMap<String, Value>;

#[tauri::command]
pub async fn get_frontend_preferences() -> Result<FrontendPreferences, AppError> {
    read_section(&utils::assets::settings_path(), SETTINGS_SECTION)
        .await
        .map(|preferences| preferences.unwrap_or_default())
        .map_err(|error| AppError::Internal(error.to_string()))
}

#[tauri::command]
pub async fn update_frontend_preferences(
    preferences: FrontendPreferences,
) -> Result<FrontendPreferences, AppError> {
    merge_object_section(
        &utils::assets::settings_path(),
        SETTINGS_SECTION,
        preferences.into_iter().collect(),
    )
    .await
    .map(|stored| stored.into_iter().collect())
    .map_err(|error| AppError::Internal(error.to_string()))
}
