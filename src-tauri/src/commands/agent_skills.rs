//! Thin Tauri command layer over `agents::skills`. All per-agent skills logic
//! (list / read / save / delete across scopes, the skills.sh marketplace, and
//! global hosting) lives in the `agents` crate; these handlers only translate
//! IPC calls and errors.

use agents::skills::{self, AgentSkillScope};

// Re-export the moved types so existing paths (`commands::agent_skills::*`)
// keep resolving for any callers/tests.
pub use agents::skills::{
    AgentSkillContent, AgentSkillItem, AgentSkillLocation, AgentSkillsListResult, LocalSkill,
    LocalSkillContent, SkillMarketDetail, SkillMarketItem,
};

use crate::error::AppError;

#[tauri::command]
pub async fn list_agent_skills(
    agent_type: String,
    workspace_path: Option<String>,
) -> Result<AgentSkillsListResult, AppError> {
    skills::list_agent_skills(agent_type, workspace_path)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn read_agent_skill(
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    workspace_path: Option<String>,
) -> Result<AgentSkillContent, AppError> {
    skills::read_agent_skill(agent_type, scope, skill_id, workspace_path)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn save_agent_skill(
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    content: String,
    workspace_path: Option<String>,
) -> Result<AgentSkillItem, AppError> {
    skills::save_agent_skill(agent_type, scope, skill_id, content, workspace_path)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn delete_agent_skill(
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    workspace_path: Option<String>,
) -> Result<(), AppError> {
    skills::delete_agent_skill(agent_type, scope, skill_id, workspace_path)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn scan_local_skills() -> Result<Vec<LocalSkill>, AppError> {
    skills::scan_local_skills().await.map_err(AppError::from)
}

#[tauri::command]
pub async fn read_local_skill(skill_id: String) -> Result<LocalSkillContent, AppError> {
    skills::read_local_skill(skill_id)
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
    source: String,
    skill_id: String,
    global: bool,
    apps: Vec<String>,
    link: bool,
) -> Result<Vec<LocalSkill>, AppError> {
    skills::install_market_skill(source, skill_id, global, apps, link)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn set_skill_hosting(
    skill_id: String,
    global: bool,
    apps: Vec<String>,
    link: bool,
) -> Result<Vec<LocalSkill>, AppError> {
    skills::set_skill_hosting(skill_id, global, apps, link)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn uninstall_skill(skill_id: String) -> Result<Vec<LocalSkill>, AppError> {
    skills::uninstall_skill(skill_id)
        .await
        .map_err(AppError::from)
}
