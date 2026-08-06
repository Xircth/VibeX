//! Thin Tauri command layer over `agents::skills`. All per-agent skills logic
//! (list / read / save / delete across scopes, the skills.sh marketplace, and
//! global hosting) lives in the `agents` crate; these handlers only translate
//! IPC calls and errors.

use std::{collections::HashMap, path::PathBuf};

use agents::skills::{self, AgentSkillScope, CustomAgentSkillStorage};
// Re-export the moved types so existing paths (`commands::agent_skills::*`)
// keep resolving for any callers/tests.
pub use agents::skills::{
    AgentSkillContent, AgentSkillItem, AgentSkillLocation, AgentSkillsListResult, LocalSkill,
    LocalSkillContent, SkillMarketDetail, SkillMarketItem,
};
use db::models::agent_management::UserAgentDefinitionRepository;

use crate::{error::AppError, state::AppState};

async fn saved_skill_environment(
    state: &AppState,
    agent_type: Option<&str>,
) -> Result<HashMap<String, String>, AppError> {
    let documents = if let Some(agent_type) = agent_type {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT env_json FROM agent_setting WHERE agent_type = ?",
        )
        .bind(agent_type)
        .fetch_all(&state.deployment.db().pool)
        .await?
    } else {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT env_json FROM agent_setting WHERE env_json IS NOT NULL",
        )
        .fetch_all(&state.deployment.db().pool)
        .await?
    };
    let mut merged = HashMap::new();
    for document in documents.into_iter().flatten() {
        let values: HashMap<String, String> = serde_json::from_str(&document)
            .map_err(|error| AppError::Internal(error.to_string()))?;
        for (key, value) in values {
            if (key.ends_with("_HOME") || key.ends_with("_DIR") || key.starts_with("XDG_"))
                && !value.trim().is_empty()
            {
                merged.insert(key, value);
            }
        }
    }
    Ok(merged)
}

async fn custom_skill_targets(state: &AppState) -> Result<Vec<CustomAgentSkillStorage>, AppError> {
    UserAgentDefinitionRepository::new(state.deployment.db().pool.clone())
        .list()
        .await
        .map_err(|error| AppError::Internal(error.to_string()))
        .map(|definitions| {
            definitions
                .into_iter()
                .filter(|definition| {
                    definition.skills_shared_store
                        || definition
                            .skills_directory
                            .as_ref()
                            .is_some_and(|directory| PathBuf::from(directory).is_absolute())
                })
                .map(|definition| CustomAgentSkillStorage {
                    agent_id: definition.agent_id.to_string(),
                    shared_store: definition.skills_shared_store,
                    directory: definition
                        .skills_directory
                        .map(PathBuf::from)
                        .filter(|directory| directory.is_absolute()),
                })
                .collect()
        })
}

async fn custom_skill_target(
    state: &AppState,
    agent_type: &str,
) -> Result<Option<CustomAgentSkillStorage>, AppError> {
    Ok(custom_skill_targets(state)
        .await?
        .into_iter()
        .find(|target| target.agent_id == agent_type))
}

#[tauri::command]
pub async fn list_agent_skills(
    state: tauri::State<'_, AppState>,
    agent_type: String,
    workspace_path: Option<String>,
) -> Result<AgentSkillsListResult, AppError> {
    let storage = custom_skill_target(&state, &agent_type).await?;
    let environment = saved_skill_environment(&state, Some(&agent_type)).await?;
    skills::with_saved_agent_environment(
        environment,
        skills::list_agent_skills_with_storage(agent_type, workspace_path, storage),
    )
    .await
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn read_agent_skill(
    state: tauri::State<'_, AppState>,
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    workspace_path: Option<String>,
) -> Result<AgentSkillContent, AppError> {
    let storage = custom_skill_target(&state, &agent_type).await?;
    let environment = saved_skill_environment(&state, Some(&agent_type)).await?;
    skills::with_saved_agent_environment(
        environment,
        skills::read_agent_skill_with_storage(agent_type, scope, skill_id, workspace_path, storage),
    )
    .await
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn save_agent_skill(
    state: tauri::State<'_, AppState>,
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    content: String,
    workspace_path: Option<String>,
) -> Result<AgentSkillItem, AppError> {
    let storage = custom_skill_target(&state, &agent_type).await?;
    let environment = saved_skill_environment(&state, Some(&agent_type)).await?;
    skills::with_saved_agent_environment(
        environment,
        skills::save_agent_skill_with_storage(
            agent_type,
            scope,
            skill_id,
            content,
            workspace_path,
            storage,
        ),
    )
    .await
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn delete_agent_skill(
    state: tauri::State<'_, AppState>,
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    workspace_path: Option<String>,
) -> Result<(), AppError> {
    let storage = custom_skill_target(&state, &agent_type).await?;
    let environment = saved_skill_environment(&state, Some(&agent_type)).await?;
    skills::with_saved_agent_environment(
        environment,
        skills::delete_agent_skill_with_storage(
            agent_type,
            scope,
            skill_id,
            workspace_path,
            storage,
        ),
    )
    .await
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn scan_local_skills(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<LocalSkill>, AppError> {
    skills::with_saved_agent_environment(
        saved_skill_environment(&state, None).await?,
        skills::scan_local_skills_with_custom_targets(custom_skill_targets(&state).await?),
    )
    .await
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn read_local_skill(
    state: tauri::State<'_, AppState>,
    skill_id: String,
) -> Result<LocalSkillContent, AppError> {
    skills::with_saved_agent_environment(
        saved_skill_environment(&state, None).await?,
        skills::read_local_skill_with_custom_targets(skill_id, custom_skill_targets(&state).await?),
    )
    .await
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn search_skill_market(query: Option<String>) -> Result<Vec<SkillMarketItem>, AppError> {
    skills::search_skill_market(query)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn get_market_skill_detail(
    source: String,
    skill_id: String,
) -> Result<SkillMarketDetail, AppError> {
    skills::get_market_skill_detail(source, skill_id)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn install_market_skill(
    state: tauri::State<'_, AppState>,
    source: String,
    skill_id: String,
    global: bool,
    apps: Vec<String>,
    link: bool,
) -> Result<Vec<LocalSkill>, AppError> {
    skills::with_saved_agent_environment(
        saved_skill_environment(&state, None).await?,
        skills::install_market_skill_with_custom_targets(
            source,
            skill_id,
            global,
            apps,
            link,
            custom_skill_targets(&state).await?,
        ),
    )
    .await
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn set_skill_hosting(
    state: tauri::State<'_, AppState>,
    skill_id: String,
    global: bool,
    apps: Vec<String>,
    link: bool,
) -> Result<Vec<LocalSkill>, AppError> {
    skills::with_saved_agent_environment(
        saved_skill_environment(&state, None).await?,
        skills::set_skill_hosting_with_custom_targets(
            skill_id,
            global,
            apps,
            link,
            custom_skill_targets(&state).await?,
        ),
    )
    .await
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn uninstall_skill(
    state: tauri::State<'_, AppState>,
    skill_id: String,
) -> Result<Vec<LocalSkill>, AppError> {
    skills::with_saved_agent_environment(
        saved_skill_environment(&state, None).await?,
        skills::uninstall_skill_with_custom_targets(skill_id, custom_skill_targets(&state).await?),
    )
    .await
    .map_err(AppError::from)
}
