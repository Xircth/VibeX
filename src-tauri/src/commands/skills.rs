use std::{collections::HashMap, path::PathBuf, sync::LazyLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;

use crate::error::AppError;

// --- Default skills data ---

static DEFAULT_SKILLS_JSON: &str = include_str!("../../../crates/executors/default_skills.json");
static DEFAULT_AIMAX_COMMANDS_JSON: &str =
    include_str!("../../../crates/executors/default_aimax_commands.json");

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

/// Validate that a skill key contains only safe characters (alphanumeric, '-', '_')
/// to prevent path traversal attacks via `../` or other special sequences.
fn validate_skill_key(key: &str) -> Result<(), AppError> {
    if key.is_empty() {
        return Err(AppError::BadRequest("Skill key cannot be empty".into()));
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::BadRequest(format!(
            "Invalid skill key '{}': only alphanumeric characters, '-' and '_' are allowed",
            key
        )));
    }
    Ok(())
}

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
    validate_skill_key(&key)?;
    let entry = PRECONFIGURED_SKILLS
        .get(&key)
        .ok_or_else(|| AppError::NotFound(format!("Skill not found: {}", key)))?;

    let dir = skill_dir(&key);
    fs::create_dir_all(&dir).await.map_err(|e| {
        AppError::Internal(format!("Failed to create skill directory {:?}: {}", dir, e))
    })?;

    let file = skill_file(&key);
    fs::write(&file, &entry.content)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to write skill file {:?}: {}", file, e)))?;

    tracing::info!("Installed skill '{}' to {:?}", key, file);
    Ok(())
}

#[tauri::command]
pub async fn uninstall_skill(key: String) -> Result<(), AppError> {
    validate_skill_key(&key)?;
    if !PRECONFIGURED_SKILLS.contains_key(&key) {
        return Err(AppError::NotFound(format!("Skill not found: {}", key)));
    }

    let dir = skill_dir(&key);
    if dir.exists() {
        fs::remove_dir_all(&dir).await.map_err(|e| {
            AppError::Internal(format!("Failed to remove skill directory {:?}: {}", dir, e))
        })?;
        tracing::info!("Uninstalled skill '{}' from {:?}", key, dir);
    }

    Ok(())
}

// --- ai-max command helpers ---

fn aimax_commands_dir() -> PathBuf {
    dirs::home_dir()
        .expect("Cannot resolve home directory")
        .join(".claude")
        .join("commands")
        .join("aimax")
}

fn is_aimax_installed() -> bool {
    let dir = aimax_commands_dir();
    if !dir.exists() {
        return false;
    }
    std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .any(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
        })
        .unwrap_or(false)
}

#[tauri::command]
pub async fn ensure_aimax_installed() -> Result<bool, AppError> {
    if is_aimax_installed() {
        tracing::debug!("ai-max commands already installed, skipping");
        return Ok(false);
    }

    let raw: Value = serde_json::from_str(DEFAULT_AIMAX_COMMANDS_JSON).map_err(|e| {
        AppError::Internal(format!(
            "Failed to parse default_aimax_commands.json: {}",
            e
        ))
    })?;

    let commands = raw
        .get("commands")
        .and_then(|v| v.as_object())
        .ok_or_else(|| {
            AppError::Internal("default_aimax_commands.json missing 'commands' object".into())
        })?;

    let dest_dir = aimax_commands_dir();
    fs::create_dir_all(&dest_dir).await.map_err(|e| {
        AppError::Internal(format!(
            "Failed to create aimax commands dir {:?}: {}",
            dest_dir, e
        ))
    })?;

    for (_key, val) in commands {
        let filename = val
            .get("filename")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Internal("ai-max command entry missing 'filename'".into()))?;
        let content = val
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Internal("ai-max command entry missing 'content'".into()))?;

        let file = dest_dir.join(filename);
        fs::write(&file, content).await.map_err(|e| {
            AppError::Internal(format!(
                "Failed to write ai-max command file {:?}: {}",
                file, e
            ))
        })?;
    }

    tracing::info!("Installed ai-max commands to {:?}", dest_dir);
    Ok(true)
}
