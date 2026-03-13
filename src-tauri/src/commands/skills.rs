use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;

use crate::error::AppError;

// --- Default skills data ---

static DEFAULT_SKILLS_JSON: &str = include_str!("../../../crates/executors/default_skills.json");

static PRECONFIGURED_SKILLS: LazyLock<HashMap<String, SkillEntry>> = LazyLock::new(|| {
    let raw: Value =
        serde_json::from_str(DEFAULT_SKILLS_JSON).expect("Failed to parse default_skills.json");
    let skills_obj = raw
        .get("skills")
        .and_then(|v| v.as_object())
        .expect("default_skills.json must have a 'skills' object");

    skills_obj
        .iter()
        .filter_map(|(key, val)| {
            serde_json::from_value::<SkillEntry>(val.clone())
                .ok()
                .map(|entry| (key.clone(), entry))
        })
        .collect()
});

// --- Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SkillEntry {
    name: String,
    description: String,
    category: String,
    icon: String,
    tags: Vec<String>,
    content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PopularSkill {
    pub key: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub icon: String,
    pub tags: Vec<String>,
    pub installed: bool,
}

// --- Helpers ---

fn skills_base_dir() -> PathBuf {
    dirs::home_dir()
        .expect("Cannot resolve home directory")
        .join(".claude")
        .join("skills")
}

fn skill_dir(key: &str) -> PathBuf {
    skills_base_dir().join(key)
}

fn skill_file(key: &str) -> PathBuf {
    skill_dir(key).join("SKILL.md")
}

fn is_skill_installed(key: &str) -> bool {
    skill_file(key).exists()
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn get_popular_skills() -> Result<Vec<PopularSkill>, AppError> {
    let skills: Vec<PopularSkill> = PRECONFIGURED_SKILLS
        .iter()
        .map(|(key, entry)| PopularSkill {
            key: key.clone(),
            name: entry.name.clone(),
            description: entry.description.clone(),
            category: entry.category.clone(),
            icon: entry.icon.clone(),
            tags: entry.tags.clone(),
            installed: is_skill_installed(key),
        })
        .collect();

    Ok(skills)
}

#[tauri::command]
pub async fn install_skill(key: String) -> Result<(), AppError> {
    let entry = PRECONFIGURED_SKILLS
        .get(&key)
        .ok_or_else(|| AppError::NotFound(format!("Skill not found: {}", key)))?;

    let dir = skill_dir(&key);
    fs::create_dir_all(&dir).await.map_err(|e| {
        AppError::Internal(format!("Failed to create skill directory {:?}: {}", dir, e))
    })?;

    let file = skill_file(&key);
    fs::write(&file, &entry.content).await.map_err(|e| {
        AppError::Internal(format!("Failed to write skill file {:?}: {}", file, e))
    })?;

    tracing::info!("Installed skill '{}' to {:?}", key, file);
    Ok(())
}

#[tauri::command]
pub async fn uninstall_skill(key: String) -> Result<(), AppError> {
    if !PRECONFIGURED_SKILLS.contains_key(&key) {
        return Err(AppError::NotFound(format!("Skill not found: {}", key)));
    }

    let dir = skill_dir(&key);
    if dir.exists() {
        fs::remove_dir_all(&dir).await.map_err(|e| {
            AppError::Internal(format!(
                "Failed to remove skill directory {:?}: {}",
                dir, e
            ))
        })?;
        tracing::info!("Uninstalled skill '{}' from {:?}", key, dir);
    }

    Ok(())
}
