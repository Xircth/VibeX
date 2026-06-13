//! Per-agent skills CRUD (list / read / save / delete) across global and
//! project scopes, mirroring the codeg skills settings backend. Each agent's
//! skill directories follow that agent CLI's own conventions; a skill is a
//! directory containing `SKILL.md` (or, for Codex, a flat `{id}.md` file).

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

use agents::{AgentType, agent_type_from_executor_key, codex_home};
use serde::{Deserialize, Serialize};
use tokio::fs;
use utils::path::normalize_windows_extended_path_prefix;

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSkillScope {
    Global,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSkillItem {
    pub id: String,
    pub scope: AgentSkillScope,
    pub path: String,
    pub description: Option<String>,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSkillLocation {
    pub scope: AgentSkillScope,
    pub path: String,
    pub exists: bool,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSkillsListResult {
    pub supported: bool,
    pub locations: Vec<AgentSkillLocation>,
    pub skills: Vec<AgentSkillItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSkillContent {
    pub skill: AgentSkillItem,
    pub content: String,
}

struct SkillDir {
    scope: AgentSkillScope,
    path: PathBuf,
    read_only: bool,
}

fn hermes_home() -> Option<PathBuf> {
    std::env::var_os("HERMES_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".hermes")))
}

/// Whether the agent also supports a flat `{id}.md` skill layout (Codex only).
fn allows_markdown_file(agent: AgentType) -> bool {
    matches!(agent, AgentType::Codex)
}

/// All skill directories for an agent, tagged by scope and read-only status.
/// Mirrors codeg's `skill_storage_spec`.
fn skill_dirs(agent: AgentType, workspace: Option<&Path>) -> Vec<SkillDir> {
    let home = dirs::home_dir();
    let mut out: Vec<SkillDir> = Vec::new();

    let globals: Vec<(PathBuf, bool)> = match agent {
        AgentType::ClaudeCode => home
            .iter()
            .map(|h| (h.join(".claude").join("skills"), false))
            .collect(),
        AgentType::Codex => {
            let mut dirs = Vec::new();
            if let Some(codex) = codex_home() {
                dirs.push((codex.join("skills"), false));
                dirs.push((codex.join("skills").join(".system"), true));
            }
            if let Some(h) = &home {
                dirs.push((h.join(".agents").join("skills"), false));
            }
            dirs
        }
        AgentType::OpenCode => home
            .iter()
            .flat_map(|h| {
                vec![
                    (h.join(".config").join("opencode").join("skills"), false),
                    (h.join(".agents").join("skills"), false),
                ]
            })
            .collect(),
        AgentType::Gemini => home
            .iter()
            .flat_map(|h| {
                vec![
                    (h.join(".gemini").join("skills"), false),
                    (h.join(".agents").join("skills"), false),
                ]
            })
            .collect(),
        AgentType::OpenClaw => home
            .iter()
            .map(|h| (h.join(".openclaw").join("skills"), false))
            .collect(),
        AgentType::Cline => home
            .iter()
            .flat_map(|h| {
                vec![
                    (h.join(".agents").join("skills"), false),
                    (h.join(".cline").join("skills"), false),
                ]
            })
            .collect(),
        AgentType::Hermes => hermes_home()
            .into_iter()
            .map(|h| (h.join("skills"), false))
            .collect(),
    };
    for (path, read_only) in globals {
        out.push(SkillDir {
            scope: AgentSkillScope::Global,
            path,
            read_only,
        });
    }

    if let Some(workspace) = workspace {
        let relatives: &[&str] = match agent {
            AgentType::ClaudeCode => &[".claude/skills"],
            AgentType::Codex => &[".codex/skills", ".agents/skills"],
            AgentType::OpenCode => &[".agents/skills", ".opencode/skills"],
            AgentType::Gemini => &[".gemini/skills", ".agents/skills"],
            AgentType::OpenClaw => &["skills"],
            AgentType::Cline => &[
                ".agents/skills",
                ".cline/skills",
                ".clinerules/skills",
                ".claude/skills",
            ],
            AgentType::Hermes => &[],
        };
        for relative in relatives {
            let mut path = workspace.to_path_buf();
            for segment in relative.split('/') {
                path = path.join(segment);
            }
            out.push(SkillDir {
                scope: AgentSkillScope::Project,
                path,
                read_only: false,
            });
        }
    }

    out
}

fn display_path(path: &Path) -> String {
    normalize_windows_extended_path_prefix(path)
        .display()
        .to_string()
}

fn validate_skill_id(raw: &str) -> Result<String, AppError> {
    let id = raw.trim();
    if id.is_empty() {
        return Err(AppError::BadRequest("技能名不能为空".to_string()));
    }
    if id.starts_with('.') {
        return Err(AppError::BadRequest("技能名不能以点开头".to_string()));
    }
    if id.contains('/') || id.contains('\\') {
        return Err(AppError::BadRequest("技能名不能包含路径分隔符".to_string()));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(AppError::BadRequest(
            "技能名只能包含字母、数字、- _ .".to_string(),
        ));
    }
    Ok(id.to_string())
}

/// Parse a `short-description` / `description` value from YAML frontmatter.
fn parse_frontmatter_description(content: &str) -> Option<String> {
    let trimmed = content.trim_start();
    let rest = trimmed.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let frontmatter = &rest[..end];

    let mut description = None;
    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("short-description:") {
            let value = value.trim().trim_matches(['"', '\'']).trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
        if description.is_none()
            && let Some(value) = line.strip_prefix("description:")
        {
            let value = value.trim().trim_matches(['"', '\'']).trim();
            if !value.is_empty() {
                description = Some(value.to_string());
            }
        }
    }
    description
}

async fn read_skill_description(skill_path: &Path) -> Option<String> {
    let content_path = skill_content_path(skill_path)?;
    let content = fs::read_to_string(&content_path).await.ok()?;
    parse_frontmatter_description(&content)
}

/// The markdown file holding a skill's content, given its on-disk entry (a
/// directory with `SKILL.md`, or a flat `.md` file).
fn skill_content_path(skill_path: &Path) -> Option<PathBuf> {
    if skill_path.is_dir() {
        for candidate in ["SKILL.md", "skill.md"] {
            let path = skill_path.join(candidate);
            if path.exists() {
                return Some(path);
            }
        }
        None
    } else if skill_path.extension().and_then(|e| e.to_str()) == Some("md") {
        Some(skill_path.to_path_buf())
    } else {
        None
    }
}

async fn list_skills_in_dir(dir: &SkillDir, allow_md: bool) -> Vec<AgentSkillItem> {
    let mut items = Vec::new();
    let Ok(mut entries) = fs::read_dir(&dir.path).await else {
        return items;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            if skill_content_path(&path).is_some() {
                items.push(AgentSkillItem {
                    id: name.to_string(),
                    scope: dir.scope,
                    path: display_path(&path),
                    description: read_skill_description(&path).await,
                    read_only: dir.read_only,
                });
            }
        } else if allow_md && path.extension().and_then(|e| e.to_str()) == Some("md") {
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(name)
                .to_string();
            items.push(AgentSkillItem {
                id,
                scope: dir.scope,
                path: display_path(&path),
                description: read_skill_description(&path).await,
                read_only: dir.read_only,
            });
        }
    }
    items
}

fn scope_rank(scope: AgentSkillScope) -> u8 {
    match scope {
        AgentSkillScope::Global => 0,
        AgentSkillScope::Project => 1,
    }
}

fn parse_agent(agent_type: &str) -> Result<AgentType, AppError> {
    agent_type_from_executor_key(agent_type)
        .ok_or_else(|| AppError::BadRequest(format!("Unknown agent type: {agent_type}")))
}

fn workspace_dir(workspace_path: Option<String>) -> Option<PathBuf> {
    workspace_path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
}

#[tauri::command]
pub async fn list_agent_skills(
    agent_type: String,
    workspace_path: Option<String>,
) -> Result<AgentSkillsListResult, AppError> {
    let agent = parse_agent(&agent_type)?;
    let workspace = workspace_dir(workspace_path);
    let dirs = skill_dirs(agent, workspace.as_deref());
    let allow_md = allows_markdown_file(agent);

    let locations = dirs
        .iter()
        .map(|dir| AgentSkillLocation {
            scope: dir.scope,
            path: display_path(&dir.path),
            exists: dir.path.exists(),
            read_only: dir.read_only,
        })
        .collect();

    let mut seen: BTreeSet<(u8, String)> = BTreeSet::new();
    let mut skills = Vec::new();
    for dir in &dirs {
        for item in list_skills_in_dir(dir, allow_md).await {
            if seen.insert((scope_rank(item.scope), item.id.clone())) {
                skills.push(item);
            }
        }
    }
    skills.sort_by(|a, b| {
        scope_rank(a.scope)
            .cmp(&scope_rank(b.scope))
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(AgentSkillsListResult {
        supported: true,
        locations,
        skills,
    })
}

/// Resolve an existing skill's on-disk entry within a directory.
fn resolve_skill_entry(dir: &SkillDir, id: &str, allow_md: bool) -> Option<PathBuf> {
    let skill_dir = dir.path.join(id);
    if skill_content_path(&skill_dir).is_some() {
        return Some(skill_dir);
    }
    if allow_md {
        let md = dir.path.join(format!("{id}.md"));
        if md.exists() {
            return Some(md);
        }
    }
    None
}

#[tauri::command]
pub async fn read_agent_skill(
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    workspace_path: Option<String>,
) -> Result<AgentSkillContent, AppError> {
    let agent = parse_agent(&agent_type)?;
    let id = validate_skill_id(&skill_id)?;
    let workspace = workspace_dir(workspace_path);
    let allow_md = allows_markdown_file(agent);

    for dir in skill_dirs(agent, workspace.as_deref())
        .into_iter()
        .filter(|dir| dir.scope == scope)
    {
        if let Some(entry) = resolve_skill_entry(&dir, &id, allow_md) {
            let content_path = skill_content_path(&entry).ok_or_else(|| {
                AppError::Internal(format!("Skill content file missing for {id}"))
            })?;
            let content = fs::read_to_string(&content_path)
                .await
                .map_err(|e| AppError::Internal(format!("Failed to read skill {id}: {e}")))?;
            return Ok(AgentSkillContent {
                skill: AgentSkillItem {
                    id,
                    scope,
                    path: display_path(&entry),
                    description: parse_frontmatter_description(&content),
                    read_only: dir.read_only,
                },
                content,
            });
        }
    }

    Err(AppError::NotFound(format!("Skill not found: {id}")))
}

#[tauri::command]
pub async fn save_agent_skill(
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    content: String,
    workspace_path: Option<String>,
) -> Result<AgentSkillItem, AppError> {
    let agent = parse_agent(&agent_type)?;
    let id = validate_skill_id(&skill_id)?;
    let workspace = workspace_dir(workspace_path);
    let allow_md = allows_markdown_file(agent);

    let target = skill_dirs(agent, workspace.as_deref())
        .into_iter()
        .find(|dir| dir.scope == scope && !dir.read_only)
        .ok_or_else(|| AppError::BadRequest("当前作用域没有可写的技能目录".to_string()))?;

    // Preserve an existing flat-file layout (Codex); otherwise use a directory.
    let md_file = target.path.join(format!("{id}.md"));
    let (content_path, entry_path) = if allow_md && md_file.exists() {
        (md_file.clone(), md_file)
    } else {
        let skill_dir = target.path.join(&id);
        (skill_dir.join("SKILL.md"), skill_dir)
    };

    if let Some(parent) = content_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to create skill directory: {e}")))?;
    }
    fs::write(&content_path, &content)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to write skill {id}: {e}")))?;

    Ok(AgentSkillItem {
        id,
        scope,
        path: display_path(&entry_path),
        description: parse_frontmatter_description(&content),
        read_only: false,
    })
}

/// Symlink-safe removal: drop a symlink/file directly, recurse real directories.
fn remove_skill_entry(path: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        std::fs::remove_file(path)
    } else {
        std::fs::remove_dir_all(path)
    }
}

#[tauri::command]
pub async fn delete_agent_skill(
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    workspace_path: Option<String>,
) -> Result<(), AppError> {
    let agent = parse_agent(&agent_type)?;
    let id = validate_skill_id(&skill_id)?;
    let workspace = workspace_dir(workspace_path);
    let allow_md = allows_markdown_file(agent);

    for dir in skill_dirs(agent, workspace.as_deref())
        .into_iter()
        .filter(|dir| dir.scope == scope)
    {
        if let Some(entry) = resolve_skill_entry(&dir, &id, allow_md) {
            if dir.read_only {
                return Err(AppError::BadRequest("系统技能为只读，无法删除".to_string()));
            }
            remove_skill_entry(&entry)
                .map_err(|e| AppError::Internal(format!("Failed to delete skill {id}: {e}")))?;
            return Ok(());
        }
    }

    Err(AppError::NotFound(format!("Skill not found: {id}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_skill_ids() {
        assert_eq!(validate_skill_id("  my-skill ").unwrap(), "my-skill");
        assert!(validate_skill_id("").is_err());
        assert!(validate_skill_id(".hidden").is_err());
        assert!(validate_skill_id("a/b").is_err());
        assert!(validate_skill_id("a b").is_err());
    }

    #[test]
    fn parses_frontmatter_description() {
        let content = "---\nname: x\nshort-description: hello world\n---\nbody";
        assert_eq!(
            parse_frontmatter_description(content).as_deref(),
            Some("hello world")
        );
        let fallback = "---\ndescription: \"fallback\"\n---\nbody";
        assert_eq!(
            parse_frontmatter_description(fallback).as_deref(),
            Some("fallback")
        );
        assert_eq!(parse_frontmatter_description("no frontmatter"), None);
    }

    #[test]
    fn codex_is_the_only_markdown_file_agent() {
        assert!(allows_markdown_file(AgentType::Codex));
        assert!(!allows_markdown_file(AgentType::ClaudeCode));
    }

    #[test]
    fn every_agent_has_a_writable_global_skill_dir() {
        for agent in [
            AgentType::ClaudeCode,
            AgentType::Codex,
            AgentType::OpenCode,
            AgentType::Gemini,
            AgentType::OpenClaw,
            AgentType::Cline,
            AgentType::Hermes,
        ] {
            let dirs = skill_dirs(agent, None);
            assert!(
                dirs.iter()
                    .any(|d| matches!(d.scope, AgentSkillScope::Global) && !d.read_only),
                "{agent:?} should have a writable global skills dir"
            );
        }
    }
}
