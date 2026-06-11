use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use agents::codex_home;
use serde::Serialize;
use tokio::fs;

use crate::error::AppError;

#[derive(Debug, Clone, Serialize)]
pub struct AgentLocalSkill {
    pub name: String,
    pub description: Option<String>,
    pub path: String,
    pub invocation: String,
}

fn normalize_agent_type(agent_type: &str) -> &str {
    match agent_type {
        "CLAUDE_CODE" => "claude_code",
        "CODEX" => "codex",
        "OPENCODE" => "open_code",
        other => other,
    }
}

fn resolve_skills_dirs(agent_type: &str) -> Vec<PathBuf> {
    match normalize_agent_type(agent_type) {
        "codex" => {
            let mut dirs = Vec::new();
            if let Some(home) = codex_home() {
                dirs.push(home.join("skills"));
            }
            if let Some(home) = dirs::home_dir() {
                dirs.push(home.join(".agents").join("skills"));
            }
            dirs
        }
        _ => Vec::new(),
    }
}

fn resolve_invocation_prefix(agent_type: &str) -> &'static str {
    match normalize_agent_type(agent_type) {
        "codex" => "$",
        _ => "/",
    }
}

fn is_hidden_skill_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| name.starts_with('.'))
}

fn extract_frontmatter_description(content: &str) -> Option<String> {
    if !content.starts_with("---") {
        return None;
    }

    let end = content[3..].find("---")?;
    let frontmatter = &content[3..3 + end];

    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("description:") {
            let description = rest.trim();
            if !description.is_empty() {
                return Some(description.to_string());
            }
        }
    }

    None
}

fn fallback_description(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && *line != "---" && !line.starts_with('#'))
        .map(ToOwned::to_owned)
}

async fn read_skill_description(skill_dir: &Path) -> Result<Option<String>, AppError> {
    let candidates = ["SKILL.md", "skill.md"];

    for candidate in candidates {
        let path = skill_dir.join(candidate);
        if !path.exists() {
            continue;
        }

        let content = fs::read_to_string(&path).await.map_err(|error| {
            AppError::Internal(format!(
                "Failed to read skill file {}: {}",
                path.display(),
                error
            ))
        })?;

        return Ok(
            extract_frontmatter_description(&content).or_else(|| fallback_description(&content))
        );
    }

    Ok(None)
}

#[tauri::command]
pub async fn list_local_agent_skills(agent_type: String) -> Result<Vec<AgentLocalSkill>, AppError> {
    let skills_dirs = resolve_skills_dirs(&agent_type);
    if skills_dirs.is_empty() {
        return Ok(Vec::new());
    };

    let invocation_prefix = resolve_invocation_prefix(&agent_type);
    let mut skills = Vec::new();
    let mut seen_names = HashSet::new();

    for skills_dir in skills_dirs {
        if !skills_dir.exists() {
            continue;
        }

        let mut entries = fs::read_dir(&skills_dir).await.map_err(|error| {
            AppError::Internal(format!(
                "Failed to read skills directory {}: {}",
                skills_dir.display(),
                error
            ))
        })?;

        while let Some(entry) = entries.next_entry().await.map_err(|error| {
            AppError::Internal(format!(
                "Failed to enumerate skills directory {}: {}",
                skills_dir.display(),
                error
            ))
        })? {
            let path = entry.path();
            if !path.is_dir() || is_hidden_skill_dir(&path) {
                continue;
            }

            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };

            if !seen_names.insert(name.to_string()) {
                continue;
            }

            let description = read_skill_description(&path).await?;
            skills.push(AgentLocalSkill {
                name: name.to_string(),
                description,
                path: path.to_string_lossy().to_string(),
                invocation: format!("{invocation_prefix}{name}"),
            });
        }
    }

    skills.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(skills)
}
