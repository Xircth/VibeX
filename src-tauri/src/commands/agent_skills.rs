//! Per-agent skills CRUD (list / read / save / delete) across global and
//! project scopes, mirroring the codeg skills settings backend. Each agent's
//! skill directories follow that agent CLI's own conventions; a skill is a
//! directory containing `SKILL.md` (or, for Codex, a flat `{id}.md` file).

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use agents::{AgentType, agent_type_from_executor_key, codex_home};
use serde::{Deserialize, Serialize};
use tokio::fs;
use utils::path::normalize_windows_extended_path_prefix;

use crate::error::AppError;

/// Every agent VibeX manages. Order is used for stable scan/display output.
const ALL_AGENTS: [AgentType; 7] = [
    AgentType::ClaudeCode,
    AgentType::Codex,
    AgentType::OpenCode,
    AgentType::Gemini,
    AgentType::OpenClaw,
    AgentType::Cline,
    AgentType::Hermes,
];

/// Snake_case identifier for an agent (matches the frontend `AgentType`).
fn agent_key(agent: AgentType) -> &'static str {
    match agent {
        AgentType::ClaudeCode => "claude_code",
        AgentType::Codex => "codex",
        AgentType::OpenCode => "open_code",
        AgentType::Gemini => "gemini",
        AgentType::OpenClaw => "open_claw",
        AgentType::Cline => "cline",
        AgentType::Hermes => "hermes",
    }
}

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

// ===========================================================================
// Local skills view + skills.sh marketplace + global hosting
//
// The settings UI mirrors the MCP page: a "本地 Skill" list (scanned across
// every agent's global skill dirs + ~/.agents/skills + the global store
// ~/.vibex/skills, deduped by name and grouped by prefix) and a "Skill 市场"
// backed by skills.sh. Installing shells out to the `skills` CLI
// (`npx skills add`) into a staging dir, then mirrors the skill — via symlink
// or file copy — into the chosen targets. "全局" hosting records the skill in
// ~/.vibex/skills and mirrors it into all seven agents.
// ===========================================================================

#[derive(Debug, Clone, Serialize)]
pub struct LocalSkill {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// Prefix group (text before the first '-'); UI may collapse same-prefix
    /// skills (e.g. `minimax-search`, `minimax-tts` → group `minimax`).
    pub group: String,
    /// Recorded in the global store (~/.vibex/skills).
    pub global: bool,
    /// Agents whose skill dirs currently carry this skill (snake_case keys).
    pub apps: Vec<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillMarketItem {
    pub id: String,
    pub skill_id: String,
    pub name: String,
    pub installs: Option<u64>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalSkillContent {
    pub id: String,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillMarketDetail {
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SkillSearchResponse {
    #[serde(default)]
    skills: Vec<SkillSearchRow>,
}

#[derive(Debug, Deserialize)]
struct SkillSearchRow {
    #[serde(default)]
    id: String,
    #[serde(default, rename = "skillId")]
    skill_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    installs: Option<u64>,
    #[serde(default)]
    source: String,
}

fn vibex_skills_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".vibex")
        .join("skills")
}

/// The agent-specific directory VibeX writes skills into when hosting.
fn agent_primary_skill_dir(agent: AgentType) -> Option<PathBuf> {
    let home = dirs::home_dir();
    match agent {
        AgentType::ClaudeCode => home.map(|h| h.join(".claude").join("skills")),
        AgentType::Codex => codex_home().map(|c| c.join("skills")),
        AgentType::OpenCode => home.map(|h| h.join(".config").join("opencode").join("skills")),
        AgentType::Gemini => home.map(|h| h.join(".gemini").join("skills")),
        AgentType::OpenClaw => home.map(|h| h.join(".openclaw").join("skills")),
        AgentType::Cline => home.map(|h| h.join(".cline").join("skills")),
        AgentType::Hermes => hermes_home().map(|h| h.join("skills")),
    }
}

/// Prefix before the first '-', or the whole name when there is none.
fn skill_group(name: &str) -> String {
    match name.split_once('-') {
        Some((prefix, _)) if !prefix.is_empty() => prefix.to_string(),
        _ => name.to_string(),
    }
}

/// Every global skill directory across all agents, plus the global store.
fn global_scan_dirs() -> Vec<SkillDir> {
    let mut dirs: Vec<SkillDir> = Vec::new();
    for agent in ALL_AGENTS {
        for dir in skill_dirs(agent, None) {
            if dir.scope == AgentSkillScope::Global {
                dirs.push(dir);
            }
        }
    }
    dirs.push(SkillDir {
        scope: AgentSkillScope::Global,
        path: vibex_skills_dir(),
        read_only: false,
    });
    dirs
}

async fn scan_all_skills() -> Vec<LocalSkill> {
    #[derive(Default)]
    struct Agg {
        description: Option<String>,
        apps: BTreeSet<&'static str>,
        global: bool,
        path: String,
    }

    let mut map: BTreeMap<String, Agg> = BTreeMap::new();
    let vibex = vibex_skills_dir();

    for agent in ALL_AGENTS {
        let allow_md = allows_markdown_file(agent);
        for dir in skill_dirs(agent, None)
            .into_iter()
            .filter(|d| d.scope == AgentSkillScope::Global)
        {
            for item in list_skills_in_dir(&dir, allow_md).await {
                let entry = map.entry(item.id.clone()).or_default();
                entry.apps.insert(agent_key(agent));
                if entry.description.is_none() {
                    entry.description = item.description.clone();
                }
                if entry.path.is_empty() {
                    entry.path = item.path.clone();
                }
            }
        }
    }

    let vibex_dir = SkillDir {
        scope: AgentSkillScope::Global,
        path: vibex,
        read_only: false,
    };
    for item in list_skills_in_dir(&vibex_dir, false).await {
        let entry = map.entry(item.id.clone()).or_default();
        entry.global = true;
        if entry.description.is_none() {
            entry.description = item.description.clone();
        }
        if entry.path.is_empty() {
            entry.path = item.path.clone();
        }
    }

    let mut out: Vec<LocalSkill> = map
        .into_iter()
        .map(|(name, agg)| LocalSkill {
            id: name.clone(),
            group: skill_group(&name),
            name,
            description: agg.description,
            global: agg.global,
            apps: agg.apps.into_iter().map(str::to_string).collect(),
            path: agg.path,
        })
        .collect();
    out.sort_by(|a, b| a.group.cmp(&b.group).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Find an existing on-disk instance of a skill (dir with SKILL.md, or a flat
/// `{id}.md`) across every global scan dir.
fn locate_skill_entry(skill_id: &str) -> Option<PathBuf> {
    for dir in global_scan_dirs() {
        let entry = dir.path.join(skill_id);
        if skill_content_path(&entry).is_some() {
            return Some(entry);
        }
        let md = dir.path.join(format!("{skill_id}.md"));
        if md.exists() {
            return Some(md);
        }
    }
    None
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn symlink_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(src, dst)
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, dst)
    }
}

fn remove_if_exists(path: &Path) -> Result<(), AppError> {
    if std::fs::symlink_metadata(path).is_ok() {
        remove_skill_entry(path)
            .map_err(|e| AppError::Internal(format!("删除 {} 失败: {e}", display_path(path))))?;
    }
    Ok(())
}

/// Place `src` (a skill directory) at `dest`, replacing any existing entry.
/// When `link` is set, attempts a symlink first and silently falls back to a
/// copy if the OS rejects it (Windows without Developer Mode / admin).
fn place_skill(src: &Path, dest: &Path, link: bool) -> Result<(), AppError> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Internal(format!("创建目录失败: {e}")))?;
    }
    remove_if_exists(dest)?;
    if link && symlink_dir(src, dest).is_ok() {
        return Ok(());
    }
    copy_dir_all(src, dest)
        .map_err(|e| AppError::Internal(format!("复制技能到 {} 失败: {e}", display_path(dest))))
}

/// Apply an exact hosting target set: present in selected agents (or all when
/// global), absent from the rest; recorded in the global store iff `global`.
fn apply_hosting(
    src: &Path,
    skill_id: &str,
    global: bool,
    agents: &BTreeSet<String>,
    link: bool,
) -> Result<(), AppError> {
    for agent in ALL_AGENTS {
        let Some(dir) = agent_primary_skill_dir(agent) else {
            continue;
        };
        let dest = dir.join(skill_id);
        if global || agents.contains(agent_key(agent)) {
            place_skill(src, &dest, link)?;
        } else {
            remove_if_exists(&dest)?;
        }
    }
    let vibex = vibex_skills_dir().join(skill_id);
    if global {
        place_skill(src, &vibex, link)?;
    } else {
        remove_if_exists(&vibex)?;
    }
    Ok(())
}

fn parse_agent_keys(keys: &[String]) -> Result<BTreeSet<String>, AppError> {
    let mut set = BTreeSet::new();
    for key in keys {
        let agent = agent_type_from_executor_key(key)
            .ok_or_else(|| AppError::BadRequest(format!("Unknown agent type: {key}")))?;
        set.insert(agent_key(agent).to_string());
    }
    Ok(set)
}

fn staging_dir() -> PathBuf {
    std::env::temp_dir().join(format!("vibex-skill-{}", uuid::Uuid::new_v4()))
}

/// BFS the staging tree for the installed skill directory (prefer an exact
/// name match; otherwise any directory carrying SKILL.md).
fn find_installed_skill_dir(root: &Path, skill_id: &str) -> Option<PathBuf> {
    let mut best: Option<PathBuf> = None;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if skill_content_path(&path).is_some() {
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if name == skill_id {
                        return Some(path);
                    }
                    if best.is_none() {
                        best = Some(path.clone());
                    }
                }
                stack.push(path);
            }
        }
    }
    best
}

/// Run `npx skills add <source> --skill <id>` into a staging project dir.
async fn run_skills_add(source: &str, skill_id: &str, staging: &Path) -> Result<(), AppError> {
    use tokio::process::Command;
    // Project-scope install (no -g) into `staging` so the output is fully
    // contained; we relocate it ourselves afterwards. `--agent claude-code`
    // is just a placement vehicle — the real targeting is done by mirroring.
    let cli_args = [
        "-y",
        "skills",
        "add",
        source,
        "--skill",
        skill_id,
        "--yes",
        "--agent",
        "claude-code",
    ];
    let mut command = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("npx");
        for arg in cli_args {
            c.arg(arg);
        }
        c
    } else {
        let mut c = Command::new("npx");
        for arg in cli_args {
            c.arg(arg);
        }
        c
    };
    command.current_dir(staging);

    let output = tokio::time::timeout(std::time::Duration::from_secs(180), command.output())
        .await
        .map_err(|_| AppError::Internal("skills 安装超时（180 秒）".to_string()))?
        .map_err(|e| {
            AppError::Internal(format!("无法运行 npx skills（请确认已安装 Node.js）: {e}"))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Internal(format!(
            "skills 安装失败: {}",
            stderr.trim()
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn scan_local_skills() -> Result<Vec<LocalSkill>, AppError> {
    Ok(scan_all_skills().await)
}

#[tauri::command]
pub async fn read_local_skill(skill_id: String) -> Result<LocalSkillContent, AppError> {
    let id = validate_skill_id(&skill_id)?;
    let entry = locate_skill_entry(&id)
        .ok_or_else(|| AppError::NotFound(format!("Skill not found: {id}")))?;
    let content_path = skill_content_path(&entry)
        .ok_or_else(|| AppError::Internal(format!("Skill content file missing for {id}")))?;
    let content = fs::read_to_string(&content_path)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to read skill {id}: {e}")))?;
    Ok(LocalSkillContent {
        id,
        path: display_path(&entry),
        content,
    })
}

/// Extract the leaderboard skills embedded in the skills.sh homepage RSC
/// payload (objects like `{"source":..,"skillId":..,"name":..,"installs":N}`),
/// sorted by install count. The site has no list/leaderboard JSON endpoint, so
/// the homepage is the source of truth for "most popular".
fn parse_popular_skills(html: &str, limit: usize) -> Vec<SkillMarketItem> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r#"\\"source\\":\\"(.*?)\\",\\"skillId\\":\\"(.*?)\\",\\"name\\":\\"(.*?)\\",\\"installs\\":(\d+)"#,
        )
        .expect("valid popular-skills regex")
    });

    let mut seen = BTreeSet::new();
    let mut items: Vec<SkillMarketItem> = Vec::new();
    for cap in RE.captures_iter(html) {
        let source = cap[1].to_string();
        let skill_id = cap[2].to_string();
        let name = cap[3].to_string();
        let installs = cap[4].parse::<u64>().ok();
        let id = format!("{source}/{skill_id}");
        if !seen.insert(id.clone()) {
            continue;
        }
        items.push(SkillMarketItem {
            id,
            skill_id,
            name,
            installs,
            source,
        });
    }
    items.sort_by(|a, b| b.installs.unwrap_or(0).cmp(&a.installs.unwrap_or(0)));
    items.truncate(limit);
    items
}

async fn fetch_popular_skills(limit: usize) -> Result<Vec<SkillMarketItem>, AppError> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 vibex-skills-market/1.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let response = client
        .get("https://www.skills.sh/")
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("获取 skills.sh 热门技能失败: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "skills.sh 热门技能请求失败: HTTP {}",
            response.status()
        )));
    }
    let html = response
        .text()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(parse_popular_skills(&html, limit))
}

#[tauri::command]
pub async fn search_skill_market(query: Option<String>) -> Result<Vec<SkillMarketItem>, AppError> {
    let q = query.unwrap_or_default();
    // skills.sh search requires at least 2 characters; with a shorter/empty
    // query we surface the 50 most-installed skills (scraped from the homepage
    // leaderboard) so the market isn't empty on open.
    if q.trim().chars().count() < 2 {
        return fetch_popular_skills(50).await;
    }
    let client = reqwest::Client::builder()
        .user_agent("vibex-skills-market/1.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let response = client
        .get("https://skills.sh/api/search")
        .query(&[("q", q.as_str())])
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("搜索 skills.sh 失败: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "skills.sh 搜索失败: HTTP {}",
            response.status()
        )));
    }
    let text = response
        .text()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let parsed: SkillSearchResponse = serde_json::from_str(&text)
        .map_err(|e| AppError::Internal(format!("解析 skills.sh 响应失败: {e}")))?;
    Ok(parsed
        .skills
        .into_iter()
        .map(|row| SkillMarketItem {
            id: row.id,
            skill_id: row.skill_id,
            name: row.name,
            installs: row.installs,
            source: row.source,
        })
        .collect())
}

/// Pull the skill description out of a skills.sh skill page. The page embeds a
/// JSON-LD block carrying the full SKILL.md description; the only other
/// `"description"` value is the site's own boilerplate, which we skip.
fn parse_skill_description(html: &str) -> Option<String> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#""description":"((?:[^"\\]|\\.)*)""#).expect("valid description regex")
    });
    const SITE_BOILERPLATE: &str = "Discover and install skills for AI agents.";

    for cap in RE.captures_iter(html) {
        // Re-parse the captured value as a JSON string to undo escaping.
        let Ok(text) = serde_json::from_str::<String>(&format!("\"{}\"", &cap[1])) else {
            continue;
        };
        let trimmed = text.trim();
        if trimmed.is_empty() || trimmed == SITE_BOILERPLATE {
            continue;
        }
        return Some(trimmed.to_string());
    }
    None
}

#[tauri::command]
pub async fn get_market_skill_detail(
    source: String,
    skill_id: String,
) -> Result<SkillMarketDetail, AppError> {
    let url = format!(
        "https://www.skills.sh/{}/{}",
        source.trim().trim_matches('/'),
        skill_id.trim()
    );
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 vibex-skills-market/1.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("获取技能详情失败: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "技能详情请求失败: HTTP {}",
            response.status()
        )));
    }
    let html = response
        .text()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(SkillMarketDetail {
        description: parse_skill_description(&html),
    })
}

#[tauri::command]
pub async fn install_market_skill(
    source: String,
    skill_id: String,
    global: bool,
    apps: Vec<String>,
    link: bool,
) -> Result<Vec<LocalSkill>, AppError> {
    let id = validate_skill_id(&skill_id)?;
    if source.trim().is_empty() {
        return Err(AppError::BadRequest("缺少技能来源".to_string()));
    }
    if !global && apps.is_empty() {
        return Err(AppError::BadRequest(
            "请至少选择一个 Agent，或勾选「全局」".to_string(),
        ));
    }
    let agents = parse_agent_keys(&apps)?;
    let staging = staging_dir();
    std::fs::create_dir_all(&staging)
        .map_err(|e| AppError::Internal(format!("创建暂存目录失败: {e}")))?;

    let result = async {
        run_skills_add(source.trim(), &id, &staging).await?;
        let installed = find_installed_skill_dir(&staging, &id)
            .ok_or_else(|| AppError::Internal("安装后未找到技能目录".to_string()))?;
        apply_hosting(&installed, &id, global, &agents, link)
    }
    .await;

    let _ = std::fs::remove_dir_all(&staging);
    result?;
    Ok(scan_all_skills().await)
}

#[tauri::command]
pub async fn set_skill_hosting(
    skill_id: String,
    global: bool,
    apps: Vec<String>,
    link: bool,
) -> Result<Vec<LocalSkill>, AppError> {
    let id = validate_skill_id(&skill_id)?;
    let agents = parse_agent_keys(&apps)?;
    let located = locate_skill_entry(&id)
        .ok_or_else(|| AppError::NotFound(format!("Skill not found: {id}")))?;

    // Snapshot the source into staging first so re-hosting never reads from a
    // target it is about to overwrite or remove.
    let staging = staging_dir();
    let src = staging.join(&id);
    std::fs::create_dir_all(&src)
        .map_err(|e| AppError::Internal(format!("创建暂存目录失败: {e}")))?;
    let snapshot = if located.is_dir() {
        copy_dir_all(&located, &src)
    } else {
        std::fs::copy(&located, src.join("SKILL.md")).map(|_| ())
    };

    let result = snapshot
        .map_err(|e| AppError::Internal(format!("快照技能失败: {e}")))
        .and_then(|_| apply_hosting(&src, &id, global, &agents, link));

    let _ = std::fs::remove_dir_all(&staging);
    result?;
    Ok(scan_all_skills().await)
}

#[tauri::command]
pub async fn uninstall_skill(skill_id: String) -> Result<Vec<LocalSkill>, AppError> {
    let id = validate_skill_id(&skill_id)?;
    for dir in global_scan_dirs() {
        remove_if_exists(&dir.path.join(&id))?;
        remove_if_exists(&dir.path.join(format!("{id}.md")))?;
    }
    Ok(scan_all_skills().await)
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
    fn groups_skills_by_prefix() {
        assert_eq!(skill_group("minimax-search"), "minimax");
        assert_eq!(skill_group("minimax-tts"), "minimax");
        assert_eq!(skill_group("standalone"), "standalone");
        assert_eq!(skill_group("-leading"), "-leading");
    }

    #[test]
    fn parses_popular_skills_from_homepage_payload() {
        let html = r#"x[{\"source\":\"vercel-labs/skills\",\"skillId\":\"find-skills\",\"name\":\"find-skills\",\"installs\":2002939,\"isOfficial\":true},{\"source\":\"a/b\",\"skillId\":\"low\",\"name\":\"Low\",\"installs\":5}]y"#;
        let items = parse_popular_skills(html, 50);
        assert_eq!(items.len(), 2);
        // Sorted by installs descending.
        assert_eq!(items[0].skill_id, "find-skills");
        assert_eq!(items[0].id, "vercel-labs/skills/find-skills");
        assert_eq!(items[0].installs, Some(2002939));
        assert_eq!(items[1].skill_id, "low");
    }

    #[test]
    fn parses_skill_description_skipping_site_boilerplate() {
        let html = r#"<script>{"name":"x","description":"A great skill that does things.\nUse it often."}</script>
        <script>{"url":"https://www.skills.sh","description":"Discover and install skills for AI agents."}</script>"#;
        // The site boilerplate appears second; the skill description must win
        // regardless of order, so put the real one first here and confirm.
        assert_eq!(
            parse_skill_description(html).as_deref(),
            Some("A great skill that does things.\nUse it often.")
        );
        assert_eq!(
            parse_skill_description(
                r#"{"description":"Discover and install skills for AI agents."}"#
            ),
            None
        );
    }

    #[test]
    fn every_agent_has_a_primary_skill_dir() {
        for agent in ALL_AGENTS {
            assert!(
                agent_primary_skill_dir(agent).is_some(),
                "{agent:?} should resolve a primary skills dir"
            );
        }
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
