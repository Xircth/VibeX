//! Per-agent skills CRUD (list / read / save / delete) across global and
//! project scopes, mirroring the codeg skills settings backend. Each agent's
//! skill directories follow that agent CLI's own conventions; a skill is a
//! directory containing `SKILL.md` (or, for Codex, a flat `{id}.md` file).

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    future::Future,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tokio::fs;
use ts_rs::TS;
use workspace_utils::{
    path::normalize_windows_extended_path_prefix, process::new_hidden_tokio_command,
};

use crate::AgentKind;

tokio::task_local! {
    static SAVED_AGENT_ENVIRONMENT: HashMap<String, String>;
}

pub async fn with_saved_agent_environment<F>(
    environment: HashMap<String, String>,
    future: F,
) -> F::Output
where
    F: Future,
{
    SAVED_AGENT_ENVIRONMENT.scope(environment, future).await
}

/// Error surface for the per-agent skills logic. Command handlers map this onto
/// their own `AppError`.
#[derive(Debug, thiserror::Error)]
pub enum SkillError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentSkillsStrategy {
    Unsupported,
    Directory,
    AgentCommand,
    AcpExtension,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSkillsSurface {
    pub agent_type: AgentKind,
    pub strategy: AgentSkillsStrategy,
    pub global_supported: bool,
    pub project_supported: bool,
}

pub fn skills_surface(agent_type: AgentKind) -> AgentSkillsSurface {
    match agent_type {
        AgentKind::ClaudeCode
        | AgentKind::Codex
        | AgentKind::Antigravity
        | AgentKind::Openclaw
        | AgentKind::Opencode
        | AgentKind::Cline
        | AgentKind::Codebuddy
        | AgentKind::KimiCode
        | AgentKind::Pi
        | AgentKind::Grok
        | AgentKind::Cursor
        | AgentKind::DeepseekHarness
        | AgentKind::Qoder
        | AgentKind::Kiro
        | AgentKind::Auggie
        | AgentKind::Trae
        | AgentKind::CommandCode
        | AgentKind::ZCode
        | AgentKind::Omp => AgentSkillsSurface {
            agent_type,
            strategy: AgentSkillsStrategy::Directory,
            global_supported: true,
            project_supported: true,
        },
        AgentKind::Hermes => AgentSkillsSurface {
            agent_type,
            strategy: AgentSkillsStrategy::Directory,
            global_supported: true,
            project_supported: false,
        },
        AgentKind::QaMock => AgentSkillsSurface {
            agent_type,
            strategy: AgentSkillsStrategy::Unsupported,
            global_supported: false,
            project_supported: false,
        },
    }
}

/// Every agent VibeX manages. Order is used for stable scan/display output.
const ALL_AGENTS: [AgentKind; 20] = [
    AgentKind::ClaudeCode,
    AgentKind::Codex,
    AgentKind::Antigravity,
    AgentKind::Openclaw,
    AgentKind::Opencode,
    AgentKind::Cline,
    AgentKind::Hermes,
    AgentKind::Codebuddy,
    AgentKind::KimiCode,
    AgentKind::Pi,
    AgentKind::Grok,
    AgentKind::Cursor,
    AgentKind::DeepseekHarness,
    AgentKind::Qoder,
    AgentKind::Kiro,
    AgentKind::Auggie,
    AgentKind::Trae,
    AgentKind::CommandCode,
    AgentKind::ZCode,
    AgentKind::Omp,
];

pub fn skill_capable_agent_ids() -> Vec<String> {
    crate::contribution_capability::skill_projectable_agent_ids()
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
    pub global_supported: bool,
    pub project_supported: bool,
    pub locations: Vec<AgentSkillLocation>,
    pub skills: Vec<AgentSkillItem>,
}

/// User-declared skills storage for an arbitrary ACP Agent. Unknown Agents are
/// intentionally excluded until the user declares either the shared
/// `.agents/skills` convention, a dedicated absolute directory, or both.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomAgentSkillStorage {
    pub agent_id: String,
    pub shared_store: bool,
    pub directory: Option<PathBuf>,
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
    configured_dir(
        "HERMES_HOME",
        dirs::home_dir().map(|home| home.join(".hermes")),
    )
}

fn zcode_home() -> Option<PathBuf> {
    configured_dir(
        "ZCODE_HOME",
        dirs::home_dir().map(|home| home.join(".zcode")),
    )
}

fn configured_value(variable: &str) -> Option<String> {
    SAVED_AGENT_ENVIRONMENT
        .try_with(|environment| environment.get(variable).cloned())
        .ok()
        .flatten()
        .or_else(|| std::env::var(variable).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn configured_dir(variable: &str, fallback: Option<PathBuf>) -> Option<PathBuf> {
    let value = configured_value(variable);
    match value {
        Some(value) if value == "~" => dirs::home_dir(),
        Some(value) if value.starts_with("~/") => {
            dirs::home_dir().map(|home| home.join(value.trim_start_matches("~/")))
        }
        Some(value) => Some(PathBuf::from(value)),
        None => fallback,
    }
}

fn omp_skill_agent_dir(fallback_home: Option<&Path>) -> Option<PathBuf> {
    let mut environment = BTreeMap::new();
    if let Ok(saved) = SAVED_AGENT_ENVIRONMENT.try_with(|env| env.clone()) {
        environment.extend(saved);
    }
    if let Ok(value) = std::env::var("PI_CODING_AGENT_DIR") {
        environment
            .entry("PI_CODING_AGENT_DIR".to_string())
            .or_insert(value);
    }
    let home = environment
        .get("HOME")
        .or_else(|| environment.get("USERPROFILE"))
        .map(PathBuf::from)
        .or_else(|| fallback_home.map(Path::to_path_buf))
        .or_else(dirs::home_dir)?;
    Some(crate::omp_auth::agent_dir(&home, &environment))
}

fn cline_skills_root(home: Option<PathBuf>) -> Option<PathBuf> {
    let configured = configured_dir("CLINE_DIR", None);
    configured
        .and_then(|data_root| data_root.parent().map(Path::to_path_buf))
        .or_else(|| home.map(|home| home.join(".cline")))
}

fn codex_skills_home() -> Option<PathBuf> {
    configured_dir(
        "CODEX_HOME",
        dirs::home_dir().map(|home| home.join(".codex")),
    )
}

/// Whether the agent also supports a flat `{id}.md` skill layout (Codex only).
fn allows_markdown_file(agent: AgentKind) -> bool {
    matches!(agent, AgentKind::Codex | AgentKind::Pi)
}

fn git_project_root(start: &Path) -> PathBuf {
    let mut current = start;
    loop {
        if current.join(".git").exists() {
            return current.to_path_buf();
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent,
            _ => return start.to_path_buf(),
        }
    }
}

fn project_skill_base(agent: AgentKind, workspace: &Path) -> PathBuf {
    if matches!(agent, AgentKind::DeepseekHarness) {
        git_project_root(workspace)
    } else {
        workspace.to_path_buf()
    }
}

/// All skill directories for an agent, tagged by scope and read-only status.
/// Mirrors codeg's `skill_storage_spec`.
fn skill_dirs(agent: AgentKind, workspace: Option<&Path>) -> Vec<SkillDir> {
    let home = dirs::home_dir();
    let mut out: Vec<SkillDir> = Vec::new();

    let globals: Vec<(PathBuf, bool)> = match agent {
        AgentKind::ClaudeCode => configured_dir(
            "CLAUDE_CONFIG_DIR",
            home.as_ref().map(|home| home.join(".claude")),
        )
        .into_iter()
        .map(|home| (home.join("skills"), false))
        .collect(),
        AgentKind::Codex => {
            let mut dirs = Vec::new();
            if let Some(codex) = codex_skills_home() {
                dirs.push((codex.join("skills"), false));
                dirs.push((codex.join("skills").join(".system"), true));
            }
            if let Some(h) = &home {
                dirs.push((h.join(".agents").join("skills"), false));
            }
            dirs
        }
        AgentKind::Opencode => configured_dir(
            "XDG_CONFIG_HOME",
            home.as_ref().map(|home| home.join(".config")),
        )
        .into_iter()
        .map(|dir| (dir.join("opencode").join("skills"), false))
        .chain(
            home.iter()
                .map(|home| (home.join(".agents").join("skills"), false)),
        )
        .collect(),
        AgentKind::Antigravity => configured_dir(
            "GEMINI_HOME",
            home.as_ref().map(|home| home.join(".gemini")),
        )
        .into_iter()
        .flat_map(|dir| {
            [
                (dir.join("config").join("skills"), false),
                (dir.join("antigravity-cli").join("skills"), true),
            ]
        })
        .chain(
            home.iter()
                .map(|home| (home.join(".agents").join("skills"), false)),
        )
        .collect(),
        AgentKind::Openclaw => configured_dir(
            "OPENCLAW_HOME",
            home.as_ref().map(|home| home.join(".openclaw")),
        )
        .into_iter()
        .map(|dir| (dir.join("skills"), false))
        .collect(),
        AgentKind::Cline => home
            .iter()
            .map(|home| (home.join(".agents").join("skills"), false))
            .chain(
                cline_skills_root(home.clone())
                    .into_iter()
                    .map(|dir| (dir.join("skills"), false)),
            )
            .collect(),
        AgentKind::Hermes => hermes_home()
            .into_iter()
            .map(|h| (h.join("skills"), false))
            .collect(),
        AgentKind::Codebuddy => configured_dir(
            "CODEBUDDY_CONFIG_DIR",
            home.as_ref().map(|home| home.join(".codebuddy")),
        )
        .into_iter()
        .map(|dir| (dir.join("skills"), false))
        .collect(),
        AgentKind::KimiCode => configured_dir(
            "KIMI_CODE_HOME",
            home.as_ref().map(|home| home.join(".kimi-code")),
        )
        .into_iter()
        .map(|dir| (dir.join("skills"), false))
        .collect(),
        AgentKind::Pi => configured_dir(
            "PI_CODING_AGENT_DIR",
            home.as_ref().map(|home| home.join(".pi").join("agent")),
        )
        .into_iter()
        .map(|dir| (dir.join("skills"), false))
        .chain(
            home.iter()
                .map(|home| (home.join(".agents").join("skills"), false)),
        )
        .collect(),
        AgentKind::Grok => {
            configured_dir("GROK_HOME", home.as_ref().map(|home| home.join(".grok")))
                .into_iter()
                .map(|dir| (dir.join("skills"), false))
                .collect()
        }
        AgentKind::Cursor => configured_dir(
            "CURSOR_CONFIG_DIR",
            home.as_ref().map(|home| home.join(".cursor")),
        )
        .iter()
        .flat_map(|cursor_root| {
            let mut directories = vec![
                (cursor_root.join("skills"), false),
                (cursor_root.join("skills-cursor"), true),
            ];
            if let Some(home) = dirs::home_dir() {
                directories.push((home.join(".agents").join("skills"), false));
            }
            directories
        })
        .collect(),
        AgentKind::DeepseekHarness => {
            configured_dir("DSH_HOME", home.as_ref().map(|home| home.join(".dsh")))
                .into_iter()
                .map(|dir| (dir.join("skills"), false))
                .chain(
                    home.iter()
                        .map(|home| (home.join(".agents").join("skills"), false)),
                )
                .collect()
        }
        AgentKind::Qoder => configured_dir(
            "QODER_CONFIG_DIR",
            home.as_ref().map(|home| home.join(".qoder")),
        )
        .into_iter()
        .map(|dir| (dir.join("skills"), false))
        .collect(),
        AgentKind::Kiro => {
            configured_dir("KIRO_HOME", home.as_ref().map(|home| home.join(".kiro")))
                .into_iter()
                .map(|dir| (dir.join("skills"), false))
                .collect()
        }
        AgentKind::Auggie => configured_dir(
            "AUGMENT_HOME",
            home.as_ref().map(|home| home.join(".augment")),
        )
        .into_iter()
        .map(|dir| (dir.join("skills"), false))
        .chain(
            home.iter()
                .map(|home| (home.join(".agents").join("skills"), false)),
        )
        .collect(),
        AgentKind::Trae => {
            configured_dir("TRAE_HOME", home.as_ref().map(|home| home.join(".trae")))
                .into_iter()
                .map(|dir| (dir.join("skills"), false))
                .chain(
                    home.iter()
                        .map(|home| (home.join(".agents").join("skills"), false)),
                )
                .collect()
        }
        AgentKind::CommandCode => configured_dir(
            "COMMAND_CODE_HOME",
            home.as_ref().map(|home| home.join(".commandcode")),
        )
        .into_iter()
        .map(|dir| (dir.join("skills"), false))
        .chain(
            home.iter()
                .map(|home| (home.join(".agents").join("skills"), false)),
        )
        .collect(),
        AgentKind::ZCode => zcode_home()
            .into_iter()
            .map(|dir| (dir.join("skills"), false))
            .chain(
                home.iter()
                    .map(|home| (home.join(".agents").join("skills"), false)),
            )
            .collect(),
        AgentKind::Omp => omp_skill_agent_dir(home.as_deref())
            .into_iter()
            .map(|dir| (dir.join("skills"), false))
            .collect(),
        AgentKind::QaMock => Vec::new(),
    };
    for (path, read_only) in globals {
        out.push(SkillDir {
            scope: AgentSkillScope::Global,
            path,
            read_only,
        });
    }

    if let Some(workspace) = workspace {
        let project_base = project_skill_base(agent, workspace);
        let relatives: &[&str] = match agent {
            AgentKind::ClaudeCode => &[".claude/skills"],
            AgentKind::Codex => &[".codex/skills", ".agents/skills"],
            AgentKind::Opencode => &[".agents/skills", ".opencode/skills"],
            AgentKind::Antigravity => &[".gemini/skills", ".agents/skills"],
            AgentKind::Openclaw => &["skills"],
            AgentKind::Cline => &[
                ".agents/skills",
                ".cline/skills",
                ".clinerules/skills",
                ".claude/skills",
            ],
            AgentKind::Hermes => &[],
            AgentKind::Codebuddy => &[".codebuddy/skills"],
            AgentKind::KimiCode => &[".kimi-code/skills"],
            AgentKind::Pi => &[".pi/skills", ".agents/skills"],
            AgentKind::Grok => &[".grok/skills"],
            AgentKind::Cursor => &[".cursor/skills", ".agents/skills"],
            AgentKind::DeepseekHarness => &[".dsh/skills", ".agents/skills"],
            AgentKind::Qoder => &[".qoder/skills"],
            AgentKind::Kiro => &[".kiro/skills"],
            AgentKind::Auggie => &[".augment/skills", ".agents/skills"],
            AgentKind::Trae => &[".trae/skills", ".agents/skills"],
            AgentKind::CommandCode => &[".commandcode/skills", ".agents/skills"],
            AgentKind::ZCode => &[".zcode/skills", ".agents/skills"],
            AgentKind::Omp => &[".agents/skills"],
            AgentKind::QaMock => &[],
        };
        for relative in relatives {
            let mut path = project_base.clone();
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

fn custom_skill_dirs(storage: &CustomAgentSkillStorage, workspace: Option<&Path>) -> Vec<SkillDir> {
    let mut dirs = Vec::new();
    if let Some(directory) = storage
        .directory
        .as_ref()
        .filter(|directory| directory.is_absolute())
    {
        dirs.push(SkillDir {
            scope: AgentSkillScope::Global,
            path: directory.clone(),
            read_only: false,
        });
    }
    if storage.shared_store {
        if let Some(home) = dirs::home_dir() {
            dirs.push(SkillDir {
                scope: AgentSkillScope::Global,
                path: home.join(".agents").join("skills"),
                read_only: false,
            });
        }
        if let Some(workspace) = workspace {
            dirs.push(SkillDir {
                scope: AgentSkillScope::Project,
                path: workspace.join(".agents").join("skills"),
                read_only: false,
            });
        }
    }
    dirs
}

fn declared_custom_storage<'a>(
    agent_type: &str,
    storage: Option<&'a CustomAgentSkillStorage>,
) -> Option<&'a CustomAgentSkillStorage> {
    storage.filter(|storage| {
        storage.agent_id == agent_type
            && (storage.shared_store
                || storage
                    .directory
                    .as_ref()
                    .is_some_and(|directory| directory.is_absolute()))
    })
}

fn resolved_skill_dirs(
    agent_type: &str,
    storage: Option<&CustomAgentSkillStorage>,
    workspace: Option<&Path>,
) -> Result<(Vec<SkillDir>, bool), SkillError> {
    if let Some(agent) = AgentKind::from_lenient(agent_type) {
        return Ok((skill_dirs(agent, workspace), allows_markdown_file(agent)));
    }
    let storage = declared_custom_storage(agent_type, storage).ok_or_else(|| {
        SkillError::Validation(format!("Unknown or undeclared agent: {agent_type}"))
    })?;
    Ok((custom_skill_dirs(storage, workspace), false))
}

fn display_path(path: &Path) -> String {
    normalize_windows_extended_path_prefix(path)
        .display()
        .to_string()
}

fn validate_skill_id(raw: &str) -> Result<String, SkillError> {
    let id = raw.trim();
    if id.is_empty() {
        return Err(SkillError::Validation("技能名不能为空".to_string()));
    }
    if id.starts_with('.') {
        return Err(SkillError::Validation("技能名不能以点开头".to_string()));
    }
    if id.contains('/') || id.contains('\\') {
        return Err(SkillError::Validation(
            "技能名不能包含路径分隔符".to_string(),
        ));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(SkillError::Validation(
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

const MAX_SKILL_NESTING: u32 = 4;

async fn list_skills_in_dir(dir: &SkillDir, allow_md: bool) -> Vec<AgentSkillItem> {
    let mut items = Vec::new();
    let mut stack = vec![(dir.path.clone(), 0_u32)];
    while let Some((path, depth)) = stack.pop() {
        if depth > MAX_SKILL_NESTING {
            continue;
        }
        let Ok(mut entries) = fs::read_dir(&path).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let entry_path = entry.path();
            let Some(name) = entry_path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            if entry_path.is_dir() {
                if skill_content_path(&entry_path).is_some() {
                    items.push(AgentSkillItem {
                        id: name.to_string(),
                        scope: dir.scope,
                        path: display_path(&entry_path),
                        description: read_skill_description(&entry_path).await,
                        read_only: dir.read_only,
                    });
                } else {
                    stack.push((entry_path, depth + 1));
                }
            } else if allow_md && entry_path.extension().and_then(|e| e.to_str()) == Some("md") {
                let id = entry_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(name)
                    .to_string();
                items.push(AgentSkillItem {
                    id,
                    scope: dir.scope,
                    path: display_path(&entry_path),
                    description: read_skill_description(&entry_path).await,
                    read_only: dir.read_only,
                });
            }
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

fn workspace_dir(workspace_path: Option<String>) -> Option<PathBuf> {
    workspace_path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
}

pub async fn list_agent_skills(
    agent_type: String,
    workspace_path: Option<String>,
) -> Result<AgentSkillsListResult, SkillError> {
    list_agent_skills_with_storage(agent_type, workspace_path, None).await
}

pub async fn list_agent_skills_with_storage(
    agent_type: String,
    workspace_path: Option<String>,
    storage: Option<CustomAgentSkillStorage>,
) -> Result<AgentSkillsListResult, SkillError> {
    let workspace = workspace_dir(workspace_path);
    let Some((dirs, allow_md)) =
        resolved_skill_dirs(&agent_type, storage.as_ref(), workspace.as_deref()).ok()
    else {
        return Ok(AgentSkillsListResult {
            supported: false,
            global_supported: false,
            project_supported: false,
            locations: Vec::new(),
            skills: Vec::new(),
        });
    };

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

    let (global_supported, project_supported) =
        if let Some(agent) = AgentKind::from_lenient(&agent_type) {
            let surface = skills_surface(agent);
            (surface.global_supported, surface.project_supported)
        } else {
            let storage = storage.as_ref().expect("resolved custom storage");
            (
                storage.directory.is_some() || storage.shared_store,
                storage.shared_store,
            )
        };
    Ok(AgentSkillsListResult {
        supported: true,
        global_supported,
        project_supported,
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

pub async fn read_agent_skill(
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    workspace_path: Option<String>,
) -> Result<AgentSkillContent, SkillError> {
    read_agent_skill_with_storage(agent_type, scope, skill_id, workspace_path, None).await
}

pub async fn read_agent_skill_with_storage(
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    workspace_path: Option<String>,
    storage: Option<CustomAgentSkillStorage>,
) -> Result<AgentSkillContent, SkillError> {
    let id = validate_skill_id(&skill_id)?;
    let workspace = workspace_dir(workspace_path);
    let (dirs, allow_md) =
        resolved_skill_dirs(&agent_type, storage.as_ref(), workspace.as_deref())?;

    for dir in dirs.into_iter().filter(|dir| dir.scope == scope) {
        if let Some(entry) = resolve_skill_entry(&dir, &id, allow_md) {
            let content_path = skill_content_path(&entry)
                .ok_or_else(|| SkillError::Other(format!("Skill content file missing for {id}")))?;
            let content = fs::read_to_string(&content_path)
                .await
                .map_err(|e| SkillError::Other(format!("Failed to read skill {id}: {e}")))?;
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

    Err(SkillError::NotFound(format!("Skill not found: {id}")))
}

pub async fn save_agent_skill(
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    content: String,
    workspace_path: Option<String>,
) -> Result<AgentSkillItem, SkillError> {
    save_agent_skill_with_storage(agent_type, scope, skill_id, content, workspace_path, None).await
}

pub async fn save_agent_skill_with_storage(
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    content: String,
    workspace_path: Option<String>,
    storage: Option<CustomAgentSkillStorage>,
) -> Result<AgentSkillItem, SkillError> {
    let id = validate_skill_id(&skill_id)?;
    let workspace = workspace_dir(workspace_path);
    let (dirs, allow_md) =
        resolved_skill_dirs(&agent_type, storage.as_ref(), workspace.as_deref())?;

    let target = dirs
        .into_iter()
        .find(|dir| dir.scope == scope && !dir.read_only)
        .ok_or_else(|| SkillError::Validation("当前作用域没有可写的技能目录".to_string()))?;

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
            .map_err(|e| SkillError::Other(format!("Failed to create skill directory: {e}")))?;
    }
    fs::write(&content_path, &content)
        .await
        .map_err(|e| SkillError::Other(format!("Failed to write skill {id}: {e}")))?;

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
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileTypeExt;
            if file_type.is_symlink_dir() {
                return std::fs::remove_dir(path).or_else(|_| std::fs::remove_file(path));
            }
            return std::fs::remove_file(path).or_else(|_| std::fs::remove_dir(path));
        }
        #[cfg(not(windows))]
        {
            return std::fs::remove_file(path).or_else(|_| std::fs::remove_dir(path));
        }
    }
    if metadata.is_file() {
        clear_readonly_if_needed(path);
        return std::fs::remove_file(path);
    }
    let mut last_err = None;
    for attempt in 0..3 {
        if attempt > 0 {
            clear_readonly_recursive(path);
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => last_err = Some(err),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("remove_dir_all failed")))
}

fn clear_readonly_if_needed(path: &Path) {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        let mut perms = meta.permissions();
        if perms.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
}

fn clear_readonly_recursive(path: &Path) {
    clear_readonly_if_needed(path);
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let child = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&child) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            clear_readonly_recursive(&child);
        } else {
            clear_readonly_if_needed(&child);
        }
    }
}

pub async fn delete_agent_skill(
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    workspace_path: Option<String>,
) -> Result<(), SkillError> {
    delete_agent_skill_with_storage(agent_type, scope, skill_id, workspace_path, None).await
}

pub async fn delete_agent_skill_with_storage(
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    workspace_path: Option<String>,
    storage: Option<CustomAgentSkillStorage>,
) -> Result<(), SkillError> {
    let id = validate_skill_id(&skill_id)?;
    let workspace = workspace_dir(workspace_path);
    let (dirs, allow_md) =
        resolved_skill_dirs(&agent_type, storage.as_ref(), workspace.as_deref())?;

    for dir in dirs.into_iter().filter(|dir| dir.scope == scope) {
        if let Some(entry) = resolve_skill_entry(&dir, &id, allow_md) {
            if dir.read_only {
                return Err(SkillError::Validation(
                    "系统技能为只读，无法删除".to_string(),
                ));
            }
            remove_skill_entry(&entry)
                .map_err(|e| SkillError::Other(format!("Failed to delete skill {id}: {e}")))?;
            return Ok(());
        }
    }

    Err(SkillError::NotFound(format!("Skill not found: {id}")))
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
// ~/.vibex/skills and mirrors it into every locally supported Agent adapter.
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillMarketItem {
    pub id: String,
    pub skill_id: String,
    pub name: String,
    pub installs: Option<u64>,
    pub source: String,
    #[serde(default)]
    pub weekly_installs: Vec<u64>,
    #[serde(default)]
    pub is_official: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalSkillContent {
    pub id: String,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum PluginSkillProjectionStatus {
    Projected,
    Removed,
    Collision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct PluginSkillProjectionResult {
    pub skill_id: String,
    pub agent_id: String,
    pub status: PluginSkillProjectionStatus,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillMarketDetail {
    pub description: Option<String>,
    pub content: Option<String>,
    pub installs: Option<u64>,
    #[serde(default)]
    pub weekly_installs: Vec<u64>,
    #[serde(default)]
    pub is_official: bool,
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
    #[serde(default, rename = "weeklyInstalls")]
    weekly_installs: Vec<u64>,
    #[serde(default, rename = "isOfficial")]
    is_official: bool,
}

fn vibex_skills_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".vibex")
        .join("skills")
}

/// The agent-specific directory VibeX writes skills into when hosting.
fn agent_primary_skill_dir(agent: AgentKind) -> Option<PathBuf> {
    let home = dirs::home_dir();
    match agent {
        AgentKind::ClaudeCode => {
            configured_dir("CLAUDE_CONFIG_DIR", home.map(|home| home.join(".claude")))
                .map(|home| home.join("skills"))
        }
        AgentKind::Codex => codex_skills_home().map(|c| c.join("skills")),
        AgentKind::Opencode => {
            configured_dir("XDG_CONFIG_HOME", home.map(|home| home.join(".config")))
                .map(|dir| dir.join("opencode").join("skills"))
        }
        AgentKind::Antigravity => {
            configured_dir("GEMINI_HOME", home.map(|home| home.join(".gemini")))
                .map(|dir| dir.join("config").join("skills"))
        }
        AgentKind::Openclaw => {
            configured_dir("OPENCLAW_HOME", home.map(|home| home.join(".openclaw")))
                .map(|dir| dir.join("skills"))
        }
        AgentKind::Cline => home.map(|home| home.join(".agents").join("skills")),
        AgentKind::Hermes => hermes_home().map(|h| h.join("skills")),
        AgentKind::Codebuddy => configured_dir(
            "CODEBUDDY_CONFIG_DIR",
            home.map(|home| home.join(".codebuddy")),
        )
        .map(|dir| dir.join("skills")),
        AgentKind::KimiCode => {
            configured_dir("KIMI_CODE_HOME", home.map(|home| home.join(".kimi-code")))
                .map(|dir| dir.join("skills"))
        }
        AgentKind::Pi => configured_dir(
            "PI_CODING_AGENT_DIR",
            home.map(|home| home.join(".pi").join("agent")),
        )
        .map(|dir| dir.join("skills")),
        AgentKind::Grok => configured_dir("GROK_HOME", home.map(|home| home.join(".grok")))
            .map(|dir| dir.join("skills")),
        AgentKind::Cursor => {
            configured_dir("CURSOR_CONFIG_DIR", home.map(|home| home.join(".cursor")))
                .map(|home| home.join("skills"))
        }
        AgentKind::DeepseekHarness => {
            configured_dir("DSH_HOME", home.map(|home| home.join(".dsh")))
                .map(|dir| dir.join("skills"))
        }
        AgentKind::Qoder => {
            configured_dir("QODER_CONFIG_DIR", home.map(|home| home.join(".qoder")))
                .map(|dir| dir.join("skills"))
        }
        AgentKind::Kiro => configured_dir("KIRO_HOME", home.map(|home| home.join(".kiro")))
            .map(|dir| dir.join("skills")),
        AgentKind::Auggie => configured_dir("AUGMENT_HOME", home.map(|home| home.join(".augment")))
            .map(|dir| dir.join("skills")),
        AgentKind::Trae => configured_dir("TRAE_HOME", home.map(|home| home.join(".trae")))
            .map(|dir| dir.join("skills")),
        AgentKind::CommandCode => configured_dir(
            "COMMAND_CODE_HOME",
            home.map(|home| home.join(".commandcode")),
        )
        .map(|dir| dir.join("skills")),
        AgentKind::ZCode => zcode_home().map(|dir| dir.join("skills")),
        AgentKind::Omp => omp_skill_agent_dir(home.as_deref()).map(|dir| dir.join("skills")),
        AgentKind::QaMock => None,
    }
}

struct SkillHostingLayout {
    store: PathBuf,
    agent_dirs: BTreeMap<String, PathBuf>,
}

fn system_skill_hosting_layout() -> SkillHostingLayout {
    SkillHostingLayout {
        store: vibex_skills_dir(),
        agent_dirs: ALL_AGENTS
            .into_iter()
            .filter_map(|agent| {
                agent_primary_skill_dir(agent).map(|dir| (agent.as_str().to_string(), dir))
            })
            .collect(),
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
fn global_scan_dirs(custom_targets: &[CustomAgentSkillStorage]) -> Vec<SkillDir> {
    let mut dirs: Vec<SkillDir> = Vec::new();
    for agent in ALL_AGENTS {
        for dir in skill_dirs(agent, None) {
            if dir.scope == AgentSkillScope::Global {
                dirs.push(dir);
            }
        }
    }
    for target in custom_targets {
        dirs.extend(
            custom_skill_dirs(target, None)
                .into_iter()
                .filter(|dir| dir.scope == AgentSkillScope::Global),
        );
    }
    dirs.push(SkillDir {
        scope: AgentSkillScope::Global,
        path: vibex_skills_dir(),
        read_only: false,
    });
    dirs
}

async fn scan_all_skills(custom_targets: &[CustomAgentSkillStorage]) -> Vec<LocalSkill> {
    #[derive(Default)]
    struct Agg {
        description: Option<String>,
        apps: BTreeSet<String>,
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
                entry.apps.insert(agent.as_str().to_string());
                if entry.description.is_none() {
                    entry.description = item.description.clone();
                }
                if entry.path.is_empty() {
                    entry.path = item.path.clone();
                }
            }
        }
    }

    for target in custom_targets {
        for dir in custom_skill_dirs(target, None)
            .into_iter()
            .filter(|dir| dir.scope == AgentSkillScope::Global)
        {
            for item in list_skills_in_dir(&dir, false).await {
                let entry = map.entry(item.id.clone()).or_default();
                entry.apps.insert(target.agent_id.clone());
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
            apps: agg.apps.into_iter().collect(),
            path: agg.path,
        })
        .collect();
    out.sort_by(|a, b| a.group.cmp(&b.group).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Find an existing on-disk instance of a skill (dir with SKILL.md, or a flat
/// `{id}.md`) across every global scan dir.
fn locate_skill_entry(
    skill_id: &str,
    custom_targets: &[CustomAgentSkillStorage],
) -> Option<PathBuf> {
    for dir in global_scan_dirs(custom_targets) {
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

fn remove_if_exists(path: &Path) -> Result<(), SkillError> {
    if std::fs::symlink_metadata(path).is_ok() {
        remove_skill_entry(path)
            .map_err(|e| SkillError::Other(format!("删除 {} 失败: {e}", display_path(path))))?;
    }
    Ok(())
}

/// Place `src` (a skill directory) at `dest`, replacing any existing entry.
/// When `link` is set, attempts a symlink first and silently falls back to a
/// copy if the OS rejects it (Windows without Developer Mode / admin).
fn place_skill(src: &Path, dest: &Path, link: bool) -> Result<(), SkillError> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| SkillError::Other(format!("创建目录失败: {e}")))?;
    }
    remove_if_exists(dest)?;
    if link && symlink_dir(src, dest).is_ok() {
        return Ok(());
    }
    copy_dir_all(src, dest)
        .map_err(|e| SkillError::Other(format!("复制技能到 {} 失败: {e}", display_path(dest))))
}

fn merge_hosting_destination(
    destinations: &mut BTreeMap<PathBuf, bool>,
    destination: PathBuf,
    selected: bool,
) {
    let destination = physical_path_key(&destination);
    destinations
        .entry(destination)
        .and_modify(|existing| *existing |= selected)
        .or_insert(selected);
}

fn physical_path_key(path: &Path) -> PathBuf {
    use std::path::Component;

    let mut lexical = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                lexical.pop();
            }
            other => lexical.push(other.as_os_str()),
        }
    }
    // Resolve the physical parent directory, but deliberately do not
    // canonicalize the final Skill entry. That entry may already be a managed
    // symlink to the VibeX central store; following it would turn the
    // destination key into the source itself and a subsequent replace would
    // delete the central copy.
    let Some(name) = lexical.file_name().map(|name| name.to_os_string()) else {
        return std::fs::canonicalize(&lexical).unwrap_or(lexical);
    };
    let mut ancestor = lexical.parent().unwrap_or_else(|| Path::new(""));
    let mut suffix = Vec::new();
    while !ancestor.exists() {
        let Some(name) = ancestor.file_name() else {
            break;
        };
        suffix.push(name.to_os_string());
        let Some(parent) = ancestor.parent() else {
            break;
        };
        ancestor = parent;
    }
    let mut normalized = std::fs::canonicalize(ancestor).unwrap_or_else(|_| ancestor.to_path_buf());
    for component in suffix.into_iter().rev() {
        normalized.push(component);
    }
    normalized.join(name)
}

/// Apply an exact hosting target set: present in selected agents (or all when
/// global), absent from the rest; recorded in the global store iff `global`.
///
/// `src` is a short-lived staging snapshot the caller deletes right after this
/// returns, so symlinks must never point at it. Global hosting first
/// materializes a real copy in the global store (~/.vibex/skills) and links
/// the agents to that; non-global hosting has no persistent link source, so
/// it always copies into the agent dirs regardless of `link`.
fn apply_hosting(
    src: &Path,
    skill_id: &str,
    global: bool,
    agents: &BTreeSet<String>,
    link: bool,
    custom_targets: &[CustomAgentSkillStorage],
) -> Result<(), SkillError> {
    apply_hosting_with_layout(
        src,
        skill_id,
        global,
        agents,
        link,
        &system_skill_hosting_layout(),
        custom_targets,
    )
}

fn apply_hosting_with_layout(
    src: &Path,
    skill_id: &str,
    global: bool,
    agents: &BTreeSet<String>,
    link: bool,
    layout: &SkillHostingLayout,
    custom_targets: &[CustomAgentSkillStorage],
) -> Result<(), SkillError> {
    let vibex = layout.store.join(skill_id);
    let (agent_src, agent_link) = if global {
        place_skill(src, &vibex, false)?;
        (vibex.clone(), link)
    } else {
        (src.to_path_buf(), false)
    };

    // Multiple adapters can intentionally share a physical store (for
    // example Cline and a custom Agent using ~/.agents/skills). Collapse by
    // destination and OR the requested state so an unselected adapter can
    // never remove a skill that a selected adapter needs at the same path.
    let mut destinations: BTreeMap<PathBuf, bool> = BTreeMap::new();
    for (agent, dir) in &layout.agent_dirs {
        let dest = dir.join(skill_id);
        let selected = global || agents.contains(agent);
        merge_hosting_destination(&mut destinations, dest, selected);
    }
    for target in custom_targets {
        let Some(dir) = custom_skill_dirs(target, None)
            .into_iter()
            .find(|dir| dir.scope == AgentSkillScope::Global && !dir.read_only)
            .map(|dir| dir.path)
        else {
            continue;
        };
        let dest = dir.join(skill_id);
        let selected = global || agents.contains(&target.agent_id);
        merge_hosting_destination(&mut destinations, dest, selected);
    }
    for (dest, selected) in destinations {
        if selected {
            place_skill(&agent_src, &dest, agent_link)?;
        } else {
            remove_if_exists(&dest)?;
        }
    }
    if !global {
        remove_if_exists(&vibex)?;
    }
    Ok(())
}

fn configure_bundled_skills_with_layout(
    skills: &[(&str, &str)],
    global: bool,
    agents: &BTreeSet<String>,
    link: bool,
    layout: &SkillHostingLayout,
) -> Result<(), SkillError> {
    let validated = skills
        .iter()
        .map(|(id, source)| {
            let id = validate_skill_id(id)?;
            if source.trim().is_empty() {
                return Err(SkillError::Validation(format!(
                    "Bundled skill content is empty: {id}"
                )));
            }
            Ok((id, *source))
        })
        .collect::<Result<Vec<_>, SkillError>>()?;

    let staging = staging_dir();
    std::fs::create_dir_all(&staging)
        .map_err(|error| SkillError::Other(format!("创建暂存目录失败: {error}")))?;
    let result = (|| {
        for (id, source) in validated {
            let skill_dir = staging.join(&id);
            std::fs::create_dir_all(&skill_dir)
                .map_err(|error| SkillError::Other(format!("创建暂存技能失败: {error}")))?;
            std::fs::write(skill_dir.join("SKILL.md"), source)
                .map_err(|error| SkillError::Other(format!("写入暂存技能失败: {error}")))?;
            apply_hosting_with_layout(&skill_dir, &id, global, agents, link, layout, &[])?;
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Project a portable Plugin's Skill directories without overwriting entries
/// not owned by that Plugin. Sources are first copied into a stable VibeX
/// provenance store, then linked to Agent directories with copy fallback.
///
/// The call is declarative: `skills` is the complete set the Plugin currently
/// contributes, and any Skill this Plugin projected earlier but that is absent
/// now is removed from both the store and the Agent directories.
pub fn project_plugin_skills(
    plugin_id: &str,
    skills: &[(String, PathBuf)],
    agents: Vec<String>,
    link: bool,
) -> Result<Vec<PluginSkillProjectionResult>, SkillError> {
    let agents = parse_agent_keys(&agents, &[])?;
    project_plugin_skills_with_layout(
        plugin_id,
        skills,
        &agents,
        link,
        &system_skill_hosting_layout(),
    )
}

pub const HOST_MULTI_AGENT_PLUGIN_ID: &str = "host.multi-agent";
pub const HOST_MULTI_AGENT_SKILL_ID: &str = "vibex-bot";
const LEGACY_MULTI_AGENT_SKILL_ID: &str = "vibex-multi-agent";

const HOST_BOT_SKILL_FILES: &[(&str, &str)] = &[
    ("SKILL.md", include_str!("skills/vibex-bot/SKILL.md")),
    (
        "SPACE-RULES.md",
        include_str!("skills/vibex-bot/SPACE-RULES.md"),
    ),
    ("MEMORY.md", include_str!("skills/vibex-bot/MEMORY.md")),
];

/// `$VIBEX_HOME` when set, otherwise `~/.vibex`.
fn vibex_home_dir() -> PathBuf {
    if let Ok(value) = std::env::var("VIBEX_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".vibex")
}

/// Absolute path of the host Bot skill: `~/.vibex/skills/vibex-bot`
/// (`$VIBEX_HOME/skills/vibex-bot` when `VIBEX_HOME` is set).
///
/// Session layer should point Space hidden sessions at this directory on
/// demand. Ordinary non-Space sessions must not load it from Agent CLI
/// global skill directories.
pub fn vibex_bot_skill_dir() -> PathBuf {
    let dir = vibex_home_dir()
        .join("skills")
        .join(HOST_MULTI_AGENT_SKILL_ID);
    if dir.is_absolute() {
        return dir;
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(&dir))
        .unwrap_or(dir)
}

fn host_multi_agent_projection_skill_ids() -> [String; 2] {
    [
        LEGACY_MULTI_AGENT_SKILL_ID.to_owned(),
        HOST_MULTI_AGENT_SKILL_ID.to_owned(),
    ]
}

/// Install or remove the host Bot skill.
///
/// The skill is written only to [`vibex_bot_skill_dir`]. Leftover projections
/// of `vibex-multi-agent` and `vibex-bot` in Agent CLI global skill dirs are
/// always cleaned first so ordinary sessions do not keep loading them.
pub fn sync_host_multi_agent_skill(enabled: bool) -> Result<(), SkillError> {
    sync_host_multi_agent_skill_with_layout(
        enabled,
        &system_skill_hosting_layout(),
        &vibex_bot_skill_dir(),
    )
}

fn sync_host_multi_agent_skill_with_layout(
    enabled: bool,
    layout: &SkillHostingLayout,
    dest: &Path,
) -> Result<(), SkillError> {
    static SYNC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = SYNC_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    remove_plugin_skill_projections_with_layout(
        HOST_MULTI_AGENT_PLUGIN_ID,
        &host_multi_agent_projection_skill_ids(),
        layout,
    )?;
    if !enabled {
        return remove_if_exists(dest);
    }
    if let Ok(meta) = std::fs::symlink_metadata(dest)
        && (meta.file_type().is_symlink() || !meta.file_type().is_dir())
    {
        remove_if_exists(dest)?;
    }
    std::fs::create_dir_all(dest)
        .map_err(|error| SkillError::Other(format!("创建 {} 失败: {error}", display_path(dest))))?;

    if let Ok(entries) = std::fs::read_dir(dest) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let keep = name.to_str().is_some_and(|file_name| {
                HOST_BOT_SKILL_FILES
                    .iter()
                    .any(|(rel, _)| *rel == file_name)
            });
            if !keep {
                let _ = remove_if_exists(&entry.path());
            }
        }
    }

    for (relative_path, contents) in HOST_BOT_SKILL_FILES {
        let file_path = dest.join(relative_path);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if std::fs::read_to_string(&file_path).ok().as_deref() == Some(*contents) {
            continue;
        }
        std::fs::write(&file_path, contents).map_err(|error| {
            SkillError::Other(format!("写入 {} 失败: {error}", display_path(&file_path)))
        })?;
    }
    Ok(())
}

pub fn remove_plugin_skill_projections(
    plugin_id: &str,
    skill_ids: &[String],
) -> Result<(), SkillError> {
    remove_plugin_skill_projections_with_layout(
        plugin_id,
        skill_ids,
        &system_skill_hosting_layout(),
    )
}

fn remove_plugin_skill_projections_with_layout(
    plugin_id: &str,
    skill_ids: &[String],
    layout: &SkillHostingLayout,
) -> Result<(), SkillError> {
    validate_plugin_projection_id(plugin_id)?;
    for skill_id in skill_ids {
        let skill_id = validate_skill_id(skill_id)?;
        for directory in layout.agent_dirs.values() {
            let destination = physical_path_key(&directory.join(&skill_id));
            if owned_plugin_projection(&destination, plugin_id) {
                remove_if_exists(&destination)?;
            }
        }
    }
    let store = layout.store.join(".plugins").join(plugin_id);
    remove_if_exists(&store)
}

/// Skill ids currently materialized in a Plugin's stable Skill store.
fn stored_plugin_skill_ids(layout: &SkillHostingLayout, plugin_id: &str) -> Vec<String> {
    let store = layout.store.join(".plugins").join(plugin_id);
    let Ok(entries) = std::fs::read_dir(&store) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .collect()
}

/// Drop one Skill's projection from every Agent directory and from the stable
/// store, leaving sibling Skills of the same Plugin untouched.
///
/// Unlike [`remove_plugin_skill_projections_with_layout`] this never removes
/// the Plugin's store directory itself, so it is safe to run for a subset of a
/// Plugin's Skills.
fn prune_plugin_skill_projection_with_layout(
    layout: &SkillHostingLayout,
    plugin_id: &str,
    skill_id: &str,
) -> Result<(), SkillError> {
    let skill_id = validate_skill_id(skill_id)?;
    for directory in layout.agent_dirs.values() {
        let destination = physical_path_key(&directory.join(&skill_id));
        if owned_plugin_projection(&destination, plugin_id) {
            remove_if_exists(&destination)?;
        }
    }
    remove_if_exists(
        &layout
            .store
            .join(".plugins")
            .join(plugin_id)
            .join(&skill_id),
    )
}

fn project_plugin_skills_with_layout(
    plugin_id: &str,
    skills: &[(String, PathBuf)],
    agents: &BTreeSet<String>,
    link: bool,
    layout: &SkillHostingLayout,
) -> Result<Vec<PluginSkillProjectionResult>, SkillError> {
    validate_plugin_projection_id(plugin_id)?;
    // Projection is declarative: once this returns, the stable store holds
    // exactly `skills`. Whatever a previous projection left behind — a domain
    // that has since been switched off, or a Skill a package upgrade dropped —
    // is pruned first, so Agent directories cannot keep serving entries the
    // Plugin no longer contributes.
    let desired = skills
        .iter()
        .map(|(skill_id, _)| skill_id.as_str())
        .collect::<BTreeSet<_>>();
    for stale in stored_plugin_skill_ids(layout, plugin_id) {
        if !desired.contains(stale.as_str()) {
            prune_plugin_skill_projection_with_layout(layout, plugin_id, &stale)?;
        }
    }
    let mut results = Vec::new();
    for (skill_id, skill_file) in skills {
        let skill_id = validate_skill_id(skill_id)?;
        if skill_file.file_name().and_then(|name| name.to_str()) != Some("SKILL.md")
            || !skill_file.is_file()
        {
            return Err(SkillError::Validation(format!(
                "Plugin Skill source is missing: {}",
                display_path(skill_file)
            )));
        }
        let source = skill_file
            .parent()
            .ok_or_else(|| SkillError::Validation("Plugin Skill has no parent directory".into()))?;
        let stable = layout
            .store
            .join(".plugins")
            .join(plugin_id)
            .join(&skill_id);
        place_skill(source, &stable, false)?;
        std::fs::write(stable.join(".vibex-plugin-owner"), plugin_id)
            .map_err(|error| SkillError::Other(format!("记录插件 Skill 来源失败: {error}")))?;

        for (agent_id, directory) in &layout.agent_dirs {
            let destination = physical_path_key(&directory.join(&skill_id));
            if agents.contains(agent_id) {
                if std::fs::symlink_metadata(&destination).is_ok()
                    && !owned_plugin_projection(&destination, plugin_id)
                {
                    results.push(PluginSkillProjectionResult {
                        skill_id: skill_id.clone(),
                        agent_id: agent_id.clone(),
                        status: PluginSkillProjectionStatus::Collision,
                        message: Some(format!(
                            "Skill `{skill_id}` already exists and is not owned by plugin `{plugin_id}`"
                        )),
                    });
                    continue;
                }
                place_skill(&stable, &destination, link)?;
                results.push(PluginSkillProjectionResult {
                    skill_id: skill_id.clone(),
                    agent_id: agent_id.clone(),
                    status: PluginSkillProjectionStatus::Projected,
                    message: None,
                });
            } else if owned_plugin_projection(&destination, plugin_id) {
                remove_if_exists(&destination)?;
                results.push(PluginSkillProjectionResult {
                    skill_id: skill_id.clone(),
                    agent_id: agent_id.clone(),
                    status: PluginSkillProjectionStatus::Removed,
                    message: None,
                });
            }
        }
    }
    Ok(results)
}

fn validate_plugin_projection_id(plugin_id: &str) -> Result<(), SkillError> {
    if plugin_id.is_empty()
        || !plugin_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(SkillError::Validation(format!(
            "Invalid plugin ID for Skill projection: {plugin_id}"
        )));
    }
    Ok(())
}

fn owned_plugin_projection(path: &Path, plugin_id: &str) -> bool {
    std::fs::read_to_string(path.join(".vibex-plugin-owner"))
        .map(|owner| owner == plugin_id)
        .unwrap_or(false)
}

fn parse_agent_keys(
    keys: &[String],
    custom_targets: &[CustomAgentSkillStorage],
) -> Result<BTreeSet<String>, SkillError> {
    let mut set = BTreeSet::new();
    for key in keys {
        if let Some(agent) = AgentKind::from_lenient(key) {
            set.insert(agent.as_str().to_string());
        } else if custom_targets.iter().any(|target| target.agent_id == *key) {
            set.insert(key.clone());
        } else {
            return Err(SkillError::Validation(format!("Unknown agent type: {key}")));
        }
    }
    Ok(set)
}

fn staging_dir() -> PathBuf {
    workspace_utils::path::get_vibex_temp_dir().join(format!("skill-{}", uuid::Uuid::new_v4()))
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
async fn run_skills_add(source: &str, skill_id: &str, staging: &Path) -> Result<(), SkillError> {
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
    let mut command = new_hidden_tokio_command("npx", cli_args);
    command.current_dir(staging);

    let output = tokio::time::timeout(std::time::Duration::from_secs(180), command.output())
        .await
        .map_err(|_| SkillError::Other("skills 安装超时（180 秒）".to_string()))?
        .map_err(|e| {
            SkillError::Other(format!("无法运行 npx skills（请确认已安装 Node.js）: {e}"))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(SkillError::Other(format!(
            "skills 安装失败: {}",
            stderr.trim()
        )));
    }
    Ok(())
}

pub async fn scan_local_skills() -> Result<Vec<LocalSkill>, SkillError> {
    scan_local_skills_with_custom_targets(Vec::new()).await
}

pub async fn scan_local_skills_with_custom_targets(
    custom_targets: Vec<CustomAgentSkillStorage>,
) -> Result<Vec<LocalSkill>, SkillError> {
    Ok(scan_all_skills(&custom_targets).await)
}

pub async fn read_local_skill(skill_id: String) -> Result<LocalSkillContent, SkillError> {
    read_local_skill_with_custom_targets(skill_id, Vec::new()).await
}

pub async fn read_local_skill_with_custom_targets(
    skill_id: String,
    custom_targets: Vec<CustomAgentSkillStorage>,
) -> Result<LocalSkillContent, SkillError> {
    let id = validate_skill_id(&skill_id)?;
    let entry = locate_skill_entry(&id, &custom_targets)
        .ok_or_else(|| SkillError::NotFound(format!("Skill not found: {id}")))?;
    let content_path = skill_content_path(&entry)
        .ok_or_else(|| SkillError::Other(format!("Skill content file missing for {id}")))?;
    let content = fs::read_to_string(&content_path)
        .await
        .map_err(|e| SkillError::Other(format!("Failed to read skill {id}: {e}")))?;
    Ok(LocalSkillContent {
        id,
        path: display_path(&entry),
        content,
    })
}

fn builtin_popular_skills_snapshot() -> Vec<SkillMarketItem> {
    let raw = serde_json::json!([
        {
            "id": "vercel-labs/skills/find-skills",
            "skill_id": "find-skills",
            "name": "find-skills",
            "installs": 4215840u64,
            "source": "vercel-labs/skills",
            "weekly_installs": [310200, 385400, 442100, 512800, 589300, 624500, 668900, 682640],
            "is_official": true
        },
        {
            "id": "mattpocock/skills/grill-me",
            "skill_id": "grill-me",
            "name": "grill-me",
            "installs": 1528400u64,
            "source": "mattpocock/skills",
            "weekly_installs": [112000, 134500, 168200, 189400, 205100, 224800, 241200, 253200],
            "is_official": true
        },
        {
            "id": "heygen-com/hyperframes/hyperframes-cli",
            "skill_id": "hyperframes-cli",
            "name": "hyperframes-cli",
            "installs": 984200u64,
            "source": "heygen-com/hyperframes",
            "weekly_installs": [64200, 78900, 95400, 118600, 136800, 152400, 164900, 173000],
            "is_official": true
        },
        {
            "id": "vercel-labs/agent-browser/agent-browser",
            "skill_id": "agent-browser",
            "name": "agent-browser",
            "installs": 872650u64,
            "source": "vercel-labs/agent-browser",
            "weekly_installs": [58400, 71200, 89500, 104300, 121800, 134600, 142900, 149950],
            "is_official": true
        },
        {
            "id": "vercel-labs/next-skills/next-best-practices",
            "skill_id": "next-best-practices",
            "name": "next-best-practices",
            "installs": 694120u64,
            "source": "vercel-labs/next-skills",
            "weekly_installs": [49200, 61500, 74800, 86200, 94500, 103400, 110200, 114320],
            "is_official": true
        },
        {
            "id": "anthropics/skills/frontend-design",
            "skill_id": "frontend-design",
            "name": "frontend-design",
            "installs": 612890u64,
            "source": "anthropics/skills",
            "weekly_installs": [42100, 53800, 64900, 75200, 84600, 92400, 98100, 101790],
            "is_official": true
        },
        {
            "id": "mattpocock/skills/write-a-prd",
            "skill_id": "write-a-prd",
            "name": "write-a-prd",
            "installs": 538400u64,
            "source": "mattpocock/skills",
            "weekly_installs": [38400, 46900, 55800, 66400, 74200, 81900, 85600, 89200],
            "is_official": true
        },
        {
            "id": "mattpocock/skills/tdd",
            "skill_id": "tdd",
            "name": "tdd",
            "installs": 489300u64,
            "source": "mattpocock/skills",
            "weekly_installs": [34100, 41800, 51200, 60800, 67500, 74300, 78200, 81400],
            "is_official": true
        },
        {
            "id": "shadcn/ui/shadcn",
            "skill_id": "shadcn",
            "name": "shadcn",
            "installs": 452180u64,
            "source": "shadcn/ui",
            "weekly_installs": [31500, 38900, 47600, 55400, 62800, 68400, 72100, 75480],
            "is_official": true
        },
        {
            "id": "supabase/agent-skills/supabase-postgres-best-practices",
            "skill_id": "supabase-postgres-best-practices",
            "name": "supabase-postgres-best-practices",
            "installs": 398640u64,
            "source": "supabase/agent-skills",
            "weekly_installs": [28400, 34600, 41200, 48900, 55200, 60800, 63900, 65640],
            "is_official": true
        },
        {
            "id": "cloudflare/skills/workers-best-practices",
            "skill_id": "workers-best-practices",
            "name": "workers-best-practices",
            "installs": 342900u64,
            "source": "cloudflare/skills",
            "weekly_installs": [24100, 29800, 36400, 42100, 47800, 51900, 54600, 56200],
            "is_official": true
        },
        {
            "id": "stripe/ai/stripe-best-practices",
            "skill_id": "stripe-best-practices",
            "name": "stripe-best-practices",
            "installs": 312450u64,
            "source": "stripe/ai",
            "weekly_installs": [21800, 26900, 32500, 38400, 43200, 47600, 50200, 51850],
            "is_official": true
        },
        {
            "id": "pbakaus/impeccable/impeccable",
            "skill_id": "impeccable",
            "name": "impeccable",
            "installs": 284700u64,
            "source": "pbakaus/impeccable",
            "weekly_installs": [19400, 24100, 29800, 35200, 39800, 43600, 45800, 47000],
            "is_official": false
        },
        {
            "id": "obra/superpowers/systematic-debugging",
            "skill_id": "systematic-debugging",
            "name": "systematic-debugging",
            "installs": 256100u64,
            "source": "obra/superpowers",
            "weekly_installs": [17800, 21900, 26800, 31400, 35600, 39200, 41100, 42300],
            "is_official": false
        },
        {
            "id": "obra/superpowers/test-driven-development",
            "skill_id": "test-driven-development",
            "name": "test-driven-development",
            "installs": 228900u64,
            "source": "obra/superpowers",
            "weekly_installs": [15900, 19800, 24100, 28300, 31900, 34800, 36600, 37500],
            "is_official": false
        },
        {
            "id": "mattpocock/skills/design-an-interface",
            "skill_id": "design-an-interface",
            "name": "design-an-interface",
            "installs": 198400u64,
            "source": "mattpocock/skills",
            "weekly_installs": [13800, 17100, 20900, 24600, 27800, 30200, 31600, 32400],
            "is_official": true
        },
        {
            "id": "anthropics/skills/mcp-builder",
            "skill_id": "mcp-builder",
            "name": "mcp-builder",
            "installs": 176500u64,
            "source": "anthropics/skills",
            "weekly_installs": [12200, 15100, 18400, 21800, 24600, 26900, 28200, 29300],
            "is_official": true
        },
        {
            "id": "prisma/skills/prisma-ORM-v7",
            "skill_id": "prisma-ORM-v7",
            "name": "prisma-ORM-v7",
            "installs": 148200u64,
            "source": "prisma/skills",
            "weekly_installs": [10100, 12600, 15400, 18200, 20600, 22800, 23900, 24600],
            "is_official": true
        },
        {
            "id": "expo/skills/expo-app-design",
            "skill_id": "expo-app-design",
            "name": "expo-app-design",
            "installs": 124600u64,
            "source": "expo/skills",
            "weekly_installs": [8600, 10800, 13100, 15400, 17400, 19100, 19900, 20300],
            "is_official": true
        },
        {
            "id": "playwright/skills/playwright-e2e-testing",
            "skill_id": "playwright-e2e-testing",
            "name": "playwright-e2e-testing",
            "installs": 71040u64,
            "source": "playwright/skills",
            "weekly_installs": [4900, 6100, 7400, 8800, 9900, 10900, 11400, 11640],
            "is_official": true
        }
    ]);
    serde_json::from_value(raw).unwrap_or_default()
}

fn synthetic_weekly_installs(installs: Option<u64>, seed: &str) -> Vec<u64> {
    let total = installs.unwrap_or(800).max(80);
    let base = (total / 10).max(8);
    let hash = seed
        .bytes()
        .fold(17u64, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u64));
    (0..8u64)
        .map(|idx| {
            let growth = 60 + idx * 10;
            let wave = ((hash.wrapping_add(idx * 13)) % 23) + 90;
            base.saturating_mul(growth)
                .saturating_mul(wave)
                / 10_000
        })
        .collect()
}

/// Extract the leaderboard skills embedded in the skills.sh homepage RSC
/// payload (objects like `{"source":..,"skillId":..,"name":..,"installs":N,"weeklyInstalls":[..],"isOfficial":bool}`),
/// sorted by install count.
fn parse_popular_skills(html: &str, limit: usize) -> Vec<SkillMarketItem> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r#"\\"source\\":\\"(.*?)\\",\\"skillId\\":\\"(.*?)\\",\\"name\\":\\"(.*?)\\",\\"installs\\":(\d+)([^}]*)"#,
        )
        .expect("valid popular-skills regex")
    });
    static WEEKLY_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"\\"weeklyInstalls\\":\[([0-9,\s]*)\]"#)
            .expect("valid weeklyInstalls regex")
    });

    let snapshot = builtin_popular_skills_snapshot();
    let mut seen = BTreeSet::new();
    let mut items: Vec<SkillMarketItem> = Vec::new();
    for cap in RE.captures_iter(html) {
        let source = cap[1].to_string();
        let skill_id = cap[2].to_string();
        let name = cap[3].to_string();
        let installs = cap[4].parse::<u64>().ok();
        let tail = cap.get(5).map(|m| m.as_str()).unwrap_or("");
        let id = format!("{source}/{skill_id}");
        if !seen.insert(id.clone()) {
            continue;
        }
        let mut is_official = tail.contains(r#"\"isOfficial\":true"#);
        let mut weekly_installs: Vec<u64> = WEEKLY_RE
            .captures(tail)
            .and_then(|wcap| wcap.get(1))
            .map(|m| {
                m.as_str()
                    .split(',')
                    .filter_map(|s| s.trim().parse::<u64>().ok())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if let Some(known) = snapshot
            .iter()
            .find(|s| s.id.eq_ignore_ascii_case(&id) || s.skill_id.eq_ignore_ascii_case(&skill_id))
        {
            if weekly_installs.is_empty() {
                weekly_installs = known.weekly_installs.clone();
            }
            if !is_official && known.is_official {
                is_official = true;
            }
        }
        if weekly_installs.is_empty() {
            weekly_installs = synthetic_weekly_installs(installs, &id);
        }

        items.push(SkillMarketItem {
            id,
            skill_id,
            name,
            installs,
            source,
            weekly_installs,
            is_official,
        });
    }
    items.sort_by(|a, b| b.installs.unwrap_or(0).cmp(&a.installs.unwrap_or(0)));
    items.truncate(limit);
    items
}

fn order_snapshot_for_view(view: Option<&str>, limit: usize) -> Vec<SkillMarketItem> {
    let mut items = builtin_popular_skills_snapshot();
    match view.map(str::trim).unwrap_or("all-time") {
        "trending" => {
            items.sort_by(|a, b| {
                let a_recent = a.weekly_installs.last().copied().unwrap_or(0);
                let b_recent = b.weekly_installs.last().copied().unwrap_or(0);
                b_recent.cmp(&a_recent)
            });
        }
        "hot" => {
            items.sort_by(|a, b| {
                let a_gain = a
                    .weekly_installs
                    .last()
                    .copied()
                    .unwrap_or(0)
                    .saturating_sub(a.weekly_installs.first().copied().unwrap_or(0));
                let b_gain = b
                    .weekly_installs
                    .last()
                    .copied()
                    .unwrap_or(0)
                    .saturating_sub(b.weekly_installs.first().copied().unwrap_or(0));
                b_gain.cmp(&a_gain)
            });
        }
        _ => {
            items.sort_by(|a, b| b.installs.unwrap_or(0).cmp(&a.installs.unwrap_or(0)));
        }
    }
    items.truncate(limit);
    items
}

async fn fetch_popular_skills_for_view(
    view: Option<&str>,
    limit: usize,
) -> Result<Vec<SkillMarketItem>, SkillError> {
    let url = match view.map(str::trim) {
        Some("trending") => "https://www.skills.sh/trending",
        Some("hot") => "https://www.skills.sh/hot",
        _ => "https://www.skills.sh/",
    };
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 vibex-skills-market/1.0")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| SkillError::Other(e.to_string()))?;
    match client.get(url).send().await {
        Ok(response) if response.status().is_success() => {
            if let Ok(html) = response.text().await {
                let parsed = parse_popular_skills(&html, limit);
                if !parsed.is_empty() {
                    return Ok(parsed);
                }
            }
        }
        _ => {}
    }
    Ok(order_snapshot_for_view(view, limit))
}

pub async fn search_skill_market(
    query: Option<String>,
) -> Result<Vec<SkillMarketItem>, SkillError> {
    search_skill_market_with_view(query, None).await
}

pub async fn search_skill_market_with_view(
    query: Option<String>,
    view: Option<String>,
) -> Result<Vec<SkillMarketItem>, SkillError> {
    let q = query.unwrap_or_default();
    // skills.sh search requires at least 2 characters; with a shorter/empty
    // query we surface the 50 most-installed skills for the requested leaderboard
    // view (`all-time` | `trending` | `hot`) with instant built-in snapshot fallback.
    if q.trim().chars().count() < 2 {
        return fetch_popular_skills_for_view(view.as_deref(), 50).await;
    }
    let snapshot = builtin_popular_skills_snapshot();
    let client = reqwest::Client::builder()
        .user_agent("vibex-skills-market/1.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| SkillError::Other(e.to_string()))?;
    let response = match client
        .get("https://skills.sh/api/search")
        .query(&[("q", q.as_str())])
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp,
        _ => {
            let needle = q.trim().to_ascii_lowercase();
            return Ok(snapshot
                .into_iter()
                .filter(|item| {
                    item.name.to_ascii_lowercase().contains(&needle)
                        || item.skill_id.to_ascii_lowercase().contains(&needle)
                        || item.source.to_ascii_lowercase().contains(&needle)
                })
                .collect());
        }
    };
    let text = response
        .text()
        .await
        .map_err(|e| SkillError::Other(e.to_string()))?;
    let parsed: SkillSearchResponse = serde_json::from_str(&text)
        .map_err(|e| SkillError::Other(format!("解析 skills.sh 响应失败: {e}")))?;
    Ok(parsed
        .skills
        .into_iter()
        .map(|row| {
            let id = if row.id.is_empty() {
                format!("{}/{}", row.source, row.skill_id)
            } else {
                row.id
            };
            let known = snapshot.iter().find(|s| {
                s.id.eq_ignore_ascii_case(&id)
                    || s.skill_id.eq_ignore_ascii_case(&row.skill_id)
            });
            let weekly_installs = if !row.weekly_installs.is_empty() {
                row.weekly_installs
            } else if let Some(k) = known {
                k.weekly_installs.clone()
            } else {
                synthetic_weekly_installs(row.installs, &id)
            };
            let is_official = row.is_official || known.is_some_and(|k| k.is_official);
            SkillMarketItem {
                id,
                skill_id: row.skill_id,
                name: row.name,
                installs: row.installs,
                source: row.source,
                weekly_installs,
                is_official,
            }
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

fn html_fragment_to_markdown(fragment: &str) -> String {
    static TAG_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"<[^>]+>").expect("valid html tag regex")
    });
    let mut s = fragment
        .replace("<h1>", "\n# ")
        .replace("</h1>", "\n\n")
        .replace("<h2>", "\n## ")
        .replace("</h2>", "\n\n")
        .replace("<h3>", "\n### ")
        .replace("</h3>", "\n\n")
        .replace("<h4>", "\n#### ")
        .replace("</h4>", "\n\n")
        .replace("<li>", "- ")
        .replace("</li>", "\n")
        .replace("<p>", "")
        .replace("</p>", "\n\n")
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("<pre><code>", "\n```\n")
        .replace("</code></pre>", "\n```\n\n")
        .replace("<code>", "`")
        .replace("</code>", "`")
        .replace("<strong>", "**")
        .replace("</strong>", "**")
        .replace("<em>", "*")
        .replace("</em>", "*");
    s = TAG_RE.replace_all(&s, "").into_owned();
    s = s
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&");
    s.trim().to_string()
}

fn extract_escaped_rsc_field(html: &str, field_name: &str) -> Option<String> {
    let pattern = format!(r#"\\"{field_name}\\":\\"((?:[^"\\]|\\.)*)\\""#);
    let re = regex::Regex::new(&pattern).ok()?;
    let cap = re.captures(html)?;
    let raw = &cap[1];
    // Unescape once for the RSC outer string, then decode JSON string if needed.
    let unescaped_once = serde_json::from_str::<String>(&format!("\"{raw}\"")).ok()?;
    if let Ok(twice) = serde_json::from_str::<String>(&format!("\"{unescaped_once}\"")) {
        Some(twice)
    } else {
        Some(unescaped_once)
    }
}

fn parse_skill_markdown_from_html(
    html: &str,
    skill_id: &str,
    source: &str,
    description: Option<&str>,
) -> Option<String> {
    let preview = extract_escaped_rsc_field(html, "previewHtml");
    let rest = extract_escaped_rsc_field(html, "restHtml");
    if preview.is_some() || rest.is_some() {
        let combined_html = format!(
            "{}\n{}",
            preview.unwrap_or_default(),
            rest.unwrap_or_default()
        );
        let md = html_fragment_to_markdown(&combined_html);
        if !md.is_empty() {
            return Some(md);
        }
    }
    description.map(|desc| {
        format!(
            "---\nname: {skill_id}\nsource: {source}\n---\n\n# {skill_id}\n\n{desc}\n"
        )
    })
}

async fn fetch_github_raw_skill_markdown(
    client: &reqwest::Client,
    source: &str,
    skill_id: &str,
) -> Option<String> {
    let clean_source = source.trim().trim_matches('/');
    let clean_id = skill_id.trim().trim_matches('/');
    if !clean_source.contains('/') || clean_id.is_empty() {
        return None;
    }
    let candidates = [
        format!("https://raw.githubusercontent.com/{clean_source}/HEAD/skills/{clean_id}/SKILL.md"),
        format!("https://raw.githubusercontent.com/{clean_source}/HEAD/{clean_id}/SKILL.md"),
        format!("https://raw.githubusercontent.com/{clean_source}/HEAD/.claude/skills/{clean_id}/SKILL.md"),
        format!("https://raw.githubusercontent.com/{clean_source}/HEAD/SKILL.md"),
    ];
    for url in candidates {
        if let Ok(resp) = client.get(&url).send().await
            && resp.status().is_success()
            && let Ok(text) = resp.text().await
        {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

pub async fn get_market_skill_detail(
    source: String,
    skill_id: String,
) -> Result<SkillMarketDetail, SkillError> {
    let clean_source = source.trim().trim_matches('/').to_string();
    let clean_skill_id = skill_id.trim().to_string();
    let full_id = format!("{clean_source}/{clean_skill_id}");
    let snapshot_item = builtin_popular_skills_snapshot().into_iter().find(|item| {
        item.id.eq_ignore_ascii_case(&full_id)
            || item.skill_id.eq_ignore_ascii_case(&clean_skill_id)
    });

    let url = format!("https://www.skills.sh/{clean_source}/{clean_skill_id}");
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 vibex-skills-market/1.0")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| SkillError::Other(e.to_string()))?;

    let (raw_md, page_resp) = tokio::join!(
        fetch_github_raw_skill_markdown(&client, &clean_source, &clean_skill_id),
        client.get(&url).send()
    );

    let mut description: Option<String> = None;
    let mut html_body = String::new();
    if let Ok(response) = page_resp
        && response.status().is_success()
        && let Ok(text) = response.text().await
    {
        description = parse_skill_description(&text);
        html_body = text;
    }

    if description.is_none()
        && let Some(ref md) = raw_md
    {
        description = parse_frontmatter_description(md);
    }

    let content = raw_md.or_else(|| {
        parse_skill_markdown_from_html(
            &html_body,
            &clean_skill_id,
            &clean_source,
            description.as_deref(),
        )
    });

    let installs = snapshot_item.as_ref().and_then(|s| s.installs);
    let weekly_installs = snapshot_item
        .as_ref()
        .map(|s| s.weekly_installs.clone())
        .unwrap_or_else(|| synthetic_weekly_installs(installs, &full_id));
    let is_official = snapshot_item.as_ref().is_some_and(|s| s.is_official);

    Ok(SkillMarketDetail {
        description,
        content,
        installs,
        weekly_installs,
        is_official,
    })
}

pub async fn install_market_skill(
    source: String,
    skill_id: String,
    global: bool,
    apps: Vec<String>,
    link: bool,
) -> Result<Vec<LocalSkill>, SkillError> {
    install_market_skill_with_custom_targets(source, skill_id, global, apps, link, Vec::new()).await
}

pub async fn install_market_skill_with_custom_targets(
    source: String,
    skill_id: String,
    global: bool,
    apps: Vec<String>,
    link: bool,
    custom_targets: Vec<CustomAgentSkillStorage>,
) -> Result<Vec<LocalSkill>, SkillError> {
    let id = validate_skill_id(&skill_id)?;
    if source.trim().is_empty() {
        return Err(SkillError::Validation("缺少技能来源".to_string()));
    }
    if !global && apps.is_empty() {
        return Err(SkillError::Validation(
            "请至少选择一个 Agent，或勾选「全局」".to_string(),
        ));
    }
    let agents = parse_agent_keys(&apps, &custom_targets)?;
    let staging = staging_dir();
    std::fs::create_dir_all(&staging)
        .map_err(|e| SkillError::Other(format!("创建暂存目录失败: {e}")))?;

    let result = async {
        run_skills_add(source.trim(), &id, &staging).await?;
        let installed = find_installed_skill_dir(&staging, &id)
            .ok_or_else(|| SkillError::Other("安装后未找到技能目录".to_string()))?;
        apply_hosting(&installed, &id, global, &agents, link, &custom_targets)
    }
    .await;

    let _ = std::fs::remove_dir_all(&staging);
    result?;
    Ok(scan_all_skills(&custom_targets).await)
}

pub async fn set_skill_hosting(
    skill_id: String,
    global: bool,
    apps: Vec<String>,
    link: bool,
) -> Result<Vec<LocalSkill>, SkillError> {
    set_skill_hosting_with_custom_targets(skill_id, global, apps, link, Vec::new()).await
}

pub async fn set_skill_hosting_with_custom_targets(
    skill_id: String,
    global: bool,
    apps: Vec<String>,
    link: bool,
    custom_targets: Vec<CustomAgentSkillStorage>,
) -> Result<Vec<LocalSkill>, SkillError> {
    let id = validate_skill_id(&skill_id)?;
    let agents = parse_agent_keys(&apps, &custom_targets)?;
    let located = locate_skill_entry(&id, &custom_targets)
        .ok_or_else(|| SkillError::NotFound(format!("Skill not found: {id}")))?;

    // Snapshot the source into staging first so re-hosting never reads from a
    // target it is about to overwrite or remove.
    let staging = staging_dir();
    let src = staging.join(&id);
    std::fs::create_dir_all(&src)
        .map_err(|e| SkillError::Other(format!("创建暂存目录失败: {e}")))?;
    let snapshot = if located.is_dir() {
        copy_dir_all(&located, &src)
    } else {
        std::fs::copy(&located, src.join("SKILL.md")).map(|_| ())
    };

    let result = snapshot
        .map_err(|e| SkillError::Other(format!("快照技能失败: {e}")))
        .and_then(|_| apply_hosting(&src, &id, global, &agents, link, &custom_targets));

    let _ = std::fs::remove_dir_all(&staging);
    result?;
    Ok(scan_all_skills(&custom_targets).await)
}

/// Materialize trusted, embedded skills and assign them to either every
/// supported Agent or an exact set of Agent hosts.
pub async fn configure_bundled_skills(
    skills: &[(&str, &str)],
    global: bool,
    apps: Vec<String>,
    link: bool,
) -> Result<Vec<LocalSkill>, SkillError> {
    let agents = parse_agent_keys(&apps, &[])?;
    configure_bundled_skills_with_layout(
        skills,
        global,
        &agents,
        link,
        &system_skill_hosting_layout(),
    )?;
    Ok(scan_all_skills(&[]).await)
}

pub async fn uninstall_skill(skill_id: String) -> Result<Vec<LocalSkill>, SkillError> {
    uninstall_skill_with_custom_targets(skill_id, Vec::new()).await
}

pub async fn uninstall_skill_with_custom_targets(
    skill_id: String,
    custom_targets: Vec<CustomAgentSkillStorage>,
) -> Result<Vec<LocalSkill>, SkillError> {
    let id = validate_skill_id(&skill_id)?;
    for dir in global_scan_dirs(&custom_targets) {
        remove_if_exists(&dir.path.join(&id))?;
        remove_if_exists(&dir.path.join(format!("{id}.md")))?;
    }
    Ok(scan_all_skills(&custom_targets).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skills_surface_is_registry_wide() {
        let surfaces = ALL_AGENTS
            .into_iter()
            .map(skills_surface)
            .collect::<Vec<_>>();

        assert_eq!(surfaces.len(), ALL_AGENTS.len());
        assert!(surfaces.iter().any(|surface| {
            surface.agent_type == AgentKind::Codex
                && surface.strategy == AgentSkillsStrategy::Directory
        }));
    }

    #[test]
    fn validates_skill_ids() {
        assert_eq!(validate_skill_id("  my-skill ").unwrap(), "my-skill");
        assert!(validate_skill_id("").is_err());
        assert!(validate_skill_id(".hidden").is_err());
        assert!(validate_skill_id("a/b").is_err());
        assert!(validate_skill_id("a b").is_err());
    }

    #[tokio::test]
    async fn lists_nested_skill_bundles() {
        let temp = tempfile::tempdir().unwrap();
        let nested = temp.path().join("pack").join("nested-skill");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(
            nested.join("SKILL.md"),
            "---\ndescription: Nested skill\n---\nbody\n",
        )
        .unwrap();
        std::fs::write(temp.path().join("flat.md"), "---\ndescription: Flat\n---\n").unwrap();

        let dir = SkillDir {
            scope: AgentSkillScope::Global,
            path: temp.path().to_path_buf(),
            read_only: false,
        };
        let items = list_skills_in_dir(&dir, true).await;
        let mut ids: Vec<_> = items.into_iter().map(|item| item.id).collect();
        ids.sort();
        assert_eq!(ids, vec!["flat".to_string(), "nested-skill".to_string()]);
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
    fn codex_and_pi_support_markdown_file_skills() {
        assert!(allows_markdown_file(AgentKind::Codex));
        assert!(allows_markdown_file(AgentKind::Pi));
        assert!(!allows_markdown_file(AgentKind::ClaudeCode));
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
        let html = r#"x[{\"source\":\"vercel-labs/skills\",\"skillId\":\"find-skills\",\"name\":\"find-skills\",\"installs\":2002939,\"weeklyInstalls\":[10,20,30,40,50,60,70,80],\"isOfficial\":true},{\"source\":\"a/b\",\"skillId\":\"low\",\"name\":\"Low\",\"installs\":5}]y"#;
        let items = parse_popular_skills(html, 50);
        assert_eq!(items.len(), 2);
        // Sorted by installs descending.
        assert_eq!(items[0].skill_id, "find-skills");
        assert_eq!(items[0].id, "vercel-labs/skills/find-skills");
        assert_eq!(items[0].installs, Some(2002939));
        assert!(items[0].is_official);
        assert_eq!(
            items[0].weekly_installs,
            vec![10, 20, 30, 40, 50, 60, 70, 80]
        );
        assert_eq!(items[1].skill_id, "low");
        assert!(!items[1].is_official);
        assert_eq!(items[1].weekly_installs.len(), 8);
    }

    #[test]
    fn builtin_leaderboard_snapshot_supports_all_time_trending_and_hot_views() {
        let all_time = order_snapshot_for_view(Some("all-time"), 20);
        assert_eq!(all_time.len(), 20);
        assert_eq!(all_time[0].skill_id, "find-skills");
        assert!(all_time.iter().all(|item| item.weekly_installs.len() == 8));

        let trending = order_snapshot_for_view(Some("trending"), 20);
        assert_eq!(trending.len(), 20);
        assert!(
            trending[0].weekly_installs.last().copied().unwrap_or(0)
                >= trending[1].weekly_installs.last().copied().unwrap_or(0)
        );

        let hot = order_snapshot_for_view(Some("hot"), 20);
        assert_eq!(hot.len(), 20);
    }

    #[test]
    fn parses_skill_markdown_from_embedded_rsc_preview_and_rest_html() {
        let html = r#"<script>self.__next_f.push([1,"{\"previewHtml\":\"<h1>Find Skills</h1><p>Discover and install <code>SKILL.md</code> packages.</p>\",\"restHtml\":\"<h2>Usage</h2><pre><code>npx skills add vercel-labs/skills --skill find-skills</code></pre>\"}"])</script>"#;
        let md = parse_skill_markdown_from_html(
            html,
            "find-skills",
            "vercel-labs/skills",
            Some("Fallback description"),
        )
        .expect("extracted markdown");
        assert!(md.contains("# Find Skills"), "md: {md}");
        assert!(md.contains("`SKILL.md`"), "md: {md}");
        assert!(md.contains("## Usage"), "md: {md}");
        assert!(
            md.contains("npx skills add vercel-labs/skills --skill find-skills"),
            "md: {md}"
        );
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
        for agent in ALL_AGENTS {
            let dirs = skill_dirs(agent, None);
            assert!(
                dirs.iter()
                    .any(|d| matches!(d.scope, AgentSkillScope::Global) && !d.read_only),
                "{agent:?} should have a writable global skills dir"
            );
        }
    }

    #[test]
    fn deepseek_project_skills_walk_up_to_the_git_root() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(".git"), "gitdir: /tmp/fake").unwrap();
        let nested = root.path().join("crates").join("agents");
        std::fs::create_dir_all(&nested).unwrap();

        let dirs = skill_dirs(AgentKind::DeepseekHarness, Some(&nested));
        assert!(
            dirs.iter().any(|dir| {
                dir.scope == AgentSkillScope::Project
                    && dir.path == root.path().join(".dsh").join("skills")
            }),
            "DeepSeek project skills must hang off the git root, not the nested cwd"
        );
    }

    #[test]
    fn bundled_skills_are_hosted_to_the_exact_agent_set() {
        let temp = tempfile::tempdir().unwrap();
        let layout = SkillHostingLayout {
            store: temp.path().join("store"),
            agent_dirs: BTreeMap::from([
                ("codex".to_string(), temp.path().join("codex")),
                ("claude_code".to_string(), temp.path().join("claude")),
            ]),
        };

        configure_bundled_skills_with_layout(
            &[("office-pptx", "---\nname: office-pptx\n---\n")],
            false,
            &BTreeSet::from(["codex".to_string()]),
            false,
            &layout,
        )
        .unwrap();

        assert!(temp.path().join("codex/office-pptx/SKILL.md").is_file());
        assert!(!temp.path().join("claude/office-pptx").exists());
        assert!(!temp.path().join("store/office-pptx").exists());

        configure_bundled_skills_with_layout(
            &[("office-pptx", "---\nname: office-pptx\n---\nupdated")],
            false,
            &BTreeSet::from(["claude_code".to_string()]),
            false,
            &layout,
        )
        .unwrap();

        assert!(!temp.path().join("codex/office-pptx").exists());
        assert_eq!(
            std::fs::read_to_string(temp.path().join("claude/office-pptx/SKILL.md")).unwrap(),
            "---\nname: office-pptx\n---\nupdated"
        );
    }

    fn plant_owned_host_skill(agent_dir: &Path, skill_id: &str) {
        let skill = agent_dir.join(skill_id);
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "stale projection").unwrap();
        std::fs::write(
            skill.join(".vibex-plugin-owner"),
            HOST_MULTI_AGENT_PLUGIN_ID,
        )
        .unwrap();
    }

    #[test]
    fn host_bot_skill_is_written_only_under_vibex_home() {
        let temp = tempfile::tempdir().unwrap();
        let codex = temp.path().join("codex");
        let layout = SkillHostingLayout {
            store: temp.path().join("store"),
            agent_dirs: BTreeMap::from([("codex".to_string(), codex.clone())]),
        };
        plant_owned_host_skill(&codex, LEGACY_MULTI_AGENT_SKILL_ID);
        plant_owned_host_skill(&codex, HOST_MULTI_AGENT_SKILL_ID);
        let plugin_store = temp
            .path()
            .join("store/.plugins")
            .join(HOST_MULTI_AGENT_PLUGIN_ID)
            .join(LEGACY_MULTI_AGENT_SKILL_ID);
        std::fs::create_dir_all(&plugin_store).unwrap();
        std::fs::write(plugin_store.join("SKILL.md"), "stale store").unwrap();

        let dest = temp.path().join("vibex-home/skills/vibex-bot");
        sync_host_multi_agent_skill_with_layout(true, &layout, &dest).unwrap();

        assert!(dest.join("SKILL.md").is_file());
        assert!(dest.join("SPACE-RULES.md").is_file());
        assert!(dest.join("MEMORY.md").is_file());
        assert!(
            std::fs::read_to_string(dest.join("SKILL.md"))
                .unwrap()
                .contains("name: vibex-bot")
        );
        assert!(!dest.join("COLLABORATION-SPACE.md").exists());
        assert!(!dest.join("SESSION-AND-DELEGATION.md").exists());
        assert!(
            !codex.join(LEGACY_MULTI_AGENT_SKILL_ID).exists(),
            "legacy Agent CLI projections must be removed"
        );
        assert!(
            !codex.join(HOST_MULTI_AGENT_SKILL_ID).exists(),
            "vibex-bot must not be projected into Agent CLI skill dirs"
        );
        assert!(
            !temp
                .path()
                .join("store/.plugins")
                .join(HOST_MULTI_AGENT_PLUGIN_ID)
                .exists()
        );

        sync_host_multi_agent_skill_with_layout(false, &layout, &dest).unwrap();
        assert!(!dest.exists());
    }

    #[test]
    fn vibex_bot_skill_dir_is_under_vibex_home_skills() {
        let dir = vibex_bot_skill_dir();
        assert!(dir.is_absolute());
        assert_eq!(
            dir.file_name().and_then(|name| name.to_str()),
            Some(HOST_MULTI_AGENT_SKILL_ID)
        );
        assert_eq!(
            dir.parent()
                .and_then(|parent| parent.file_name())
                .and_then(|name| name.to_str()),
            Some("skills")
        );
    }

    #[test]
    fn plugin_projection_never_overwrites_an_unowned_same_name_skill() {
        let temp = tempfile::tempdir().unwrap();
        let layout = SkillHostingLayout {
            store: temp.path().join("store"),
            agent_dirs: BTreeMap::from([
                ("codex".to_string(), temp.path().join("codex")),
                ("claude_code".to_string(), temp.path().join("claude")),
            ]),
        };
        let source = temp.path().join("source/research");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), "plugin skill").unwrap();
        let user_skill = temp.path().join("codex/research");
        std::fs::create_dir_all(&user_skill).unwrap();
        std::fs::write(user_skill.join("SKILL.md"), "user skill").unwrap();

        let results = project_plugin_skills_with_layout(
            "dev.vibex.research",
            &[("research".to_string(), source.join("SKILL.md"))],
            &BTreeSet::from(["codex".to_string(), "claude_code".to_string()]),
            true,
            &layout,
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(user_skill.join("SKILL.md")).unwrap(),
            "user skill"
        );
        assert!(results.iter().any(|result| {
            result.agent_id == "codex" && result.status == PluginSkillProjectionStatus::Collision
        }));
        assert_eq!(
            std::fs::read_to_string(temp.path().join("claude/research/SKILL.md")).unwrap(),
            "plugin skill"
        );
        assert!(owned_plugin_projection(
            &temp.path().join("claude/research"),
            "dev.vibex.research"
        ));
    }

    #[test]
    fn plugin_projection_prunes_skills_the_plugin_no_longer_contributes() {
        let temp = tempfile::tempdir().unwrap();
        let layout = SkillHostingLayout {
            store: temp.path().join("store"),
            agent_dirs: BTreeMap::from([
                ("codex".to_string(), temp.path().join("codex")),
                ("claude_code".to_string(), temp.path().join("claude")),
            ]),
        };
        let sources = temp.path().join("source");
        let skill_source = |id: &str| {
            let dir = sources.join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), format!("---\nname: {id}\n---\n")).unwrap();
            (id.to_string(), dir.join("SKILL.md"))
        };
        let all = vec![skill_source("kept"), skill_source("dropped")];
        let agents = BTreeSet::from(["codex".to_string(), "claude_code".to_string()]);
        let store = temp.path().join("store/.plugins/dev.vibex.science");

        project_plugin_skills_with_layout("dev.vibex.science", &all, &agents, true, &layout)
            .unwrap();
        assert!(temp.path().join("codex/dropped/SKILL.md").is_file());

        // A later projection contributes only `kept`, as happens when a domain
        // is switched off or a package upgrade drops a Skill.
        let results = project_plugin_skills_with_layout(
            "dev.vibex.science",
            &all[..1],
            &agents,
            true,
            &layout,
        )
        .unwrap();

        assert!(temp.path().join("codex/kept/SKILL.md").is_file());
        assert!(!temp.path().join("codex/dropped").exists());
        assert!(!temp.path().join("claude/dropped").exists());
        assert!(!store.join("dropped").exists());
        assert!(
            store.join("kept/SKILL.md").is_file(),
            "pruning one Skill must not disturb its siblings"
        );
        assert!(
            results.iter().all(|result| result.skill_id != "dropped"),
            "a pruned Skill is reconciliation, not a per-Agent projection outcome"
        );
    }

    #[test]
    fn bundled_plugin_development_skill_projects_into_agent_dirs() {
        let source = tempfile::tempdir().unwrap();
        let skill = source.path().join("SKILL.md");
        std::fs::write(
            &skill,
            "---\nname: vibex-plugin-development\ndescription: Develop a plugin.\n---\n# Develop\n",
        )
        .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let layout = SkillHostingLayout {
            store: temp.path().join("store"),
            agent_dirs: BTreeMap::from([("codex".to_string(), temp.path().join("codex"))]),
        };

        let results = project_plugin_skills_with_layout(
            "vibex.plugin-development",
            &[("vibex-plugin-development".to_string(), skill)],
            &BTreeSet::from(["codex".to_string()]),
            false,
            &layout,
        )
        .unwrap();

        assert!(results.iter().any(|result| {
            result.agent_id == "codex" && result.status == PluginSkillProjectionStatus::Projected
        }));
        assert!(
            temp.path()
                .join("codex/vibex-plugin-development/SKILL.md")
                .is_file()
        );
    }

    #[test]
    fn removing_a_plugin_deletes_only_its_owned_skill_projections() {
        let temp = tempfile::tempdir().unwrap();
        let layout = SkillHostingLayout {
            store: temp.path().join("store"),
            agent_dirs: BTreeMap::from([
                ("codex".to_string(), temp.path().join("codex")),
                ("claude_code".to_string(), temp.path().join("claude")),
            ]),
        };
        let source = temp.path().join("source/research");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("SKILL.md"), "plugin skill").unwrap();
        project_plugin_skills_with_layout(
            "dev.vibex.research",
            &[("research".to_string(), source.join("SKILL.md"))],
            &BTreeSet::from(["codex".to_string(), "claude_code".to_string()]),
            true,
            &layout,
        )
        .unwrap();
        let user_skill = temp.path().join("codex/notes");
        std::fs::create_dir_all(&user_skill).unwrap();
        std::fs::write(user_skill.join("SKILL.md"), "user skill").unwrap();

        remove_plugin_skill_projections_with_layout(
            "dev.vibex.research",
            &["research".to_owned(), "notes".to_owned()],
            &layout,
        )
        .unwrap();

        assert!(!temp.path().join("codex/research").exists());
        assert!(!temp.path().join("claude/research").exists());
        assert!(
            !temp
                .path()
                .join("store/.plugins/dev.vibex.research")
                .exists()
        );
        assert_eq!(
            std::fs::read_to_string(user_skill.join("SKILL.md")).unwrap(),
            "user skill"
        );
    }

    #[test]
    fn custom_agent_skills_require_an_explicit_storage_declaration() {
        assert!(resolved_skill_dirs("local-reviewer", None, None).is_err());

        let directory = std::env::temp_dir().join("vibex-custom-agent-skills");
        let storage = CustomAgentSkillStorage {
            agent_id: "local-reviewer".to_string(),
            shared_store: true,
            directory: Some(directory.clone()),
        };
        let workspace = std::env::temp_dir().join("vibex-custom-agent-workspace");
        let (dirs, allow_markdown) =
            resolved_skill_dirs("local-reviewer", Some(&storage), Some(&workspace)).unwrap();

        assert!(!allow_markdown);
        assert_eq!(dirs.first().map(|dir| &dir.path), Some(&directory));
        assert!(dirs.iter().any(|dir| {
            dir.scope == AgentSkillScope::Project
                && dir.path == workspace.join(".agents").join("skills")
        }));
    }

    #[tokio::test]
    async fn saved_cline_data_root_resolves_the_sibling_skills_directory() {
        let root = tempfile::tempdir().unwrap();
        let cline_root = root.path().join(".cline");
        let data_root = cline_root.join("data");
        let environment =
            HashMap::from([("CLINE_DIR".to_string(), data_root.display().to_string())]);

        let paths = with_saved_agent_environment(environment, async {
            skill_dirs(AgentKind::Cline, None)
                .into_iter()
                .map(|dir| dir.path)
                .collect::<Vec<_>>()
        })
        .await;

        assert!(paths.contains(&cline_root.join("skills")));
        assert!(!paths.contains(&data_root.join("skills")));
    }

    #[test]
    fn physical_skill_paths_normalize_parent_segments_and_symlinked_ancestors() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let lexical = real.join("nested").join("..").join("skill");
        let expected = physical_path_key(&real.join("skill"));

        assert_eq!(physical_path_key(&lexical), expected);

        #[cfg(unix)]
        {
            let link = root.path().join("link");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert_eq!(physical_path_key(&link.join("skill")), expected);
        }
    }

    #[cfg(unix)]
    #[test]
    fn existing_managed_skill_symlink_never_collapses_into_the_central_source() {
        let root = tempfile::tempdir().unwrap();
        let central = root.path().join("central").join("example");
        let destination = root.path().join("agent").join("skills").join("example");
        std::fs::create_dir_all(&central).unwrap();
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&central, &destination).unwrap();

        let mut destinations = BTreeMap::new();
        merge_hosting_destination(&mut destinations, destination.clone(), true);

        let key = destinations.keys().next().unwrap();
        assert_eq!(key, &physical_path_key(&destination));
        assert_ne!(key, &std::fs::canonicalize(&central).unwrap());
        place_skill(&central, key, true).unwrap();
        assert!(central.is_dir());
        assert_eq!(
            std::fs::canonicalize(key).unwrap(),
            std::fs::canonicalize(&central).unwrap()
        );
    }

    #[tokio::test]
    async fn saved_hermes_home_expands_tilde_for_skills() {
        let environment = HashMap::from([(
            "HERMES_HOME".to_string(),
            "~/.hermes-vibex-test".to_string(),
        )]);
        let paths = with_saved_agent_environment(environment, async {
            skill_dirs(AgentKind::Hermes, None)
                .into_iter()
                .map(|dir| dir.path)
                .collect::<Vec<_>>()
        })
        .await;

        assert!(
            paths.contains(
                &dirs::home_dir()
                    .unwrap()
                    .join(".hermes-vibex-test")
                    .join("skills")
            )
        );
    }

    #[test]
    fn bundled_skills_can_be_applied_globally_to_every_agent() {
        let temp = tempfile::tempdir().unwrap();
        let layout = SkillHostingLayout {
            store: temp.path().join("store"),
            agent_dirs: BTreeMap::from([
                ("codex".to_string(), temp.path().join("codex")),
                ("claude_code".to_string(), temp.path().join("claude")),
            ]),
        };

        configure_bundled_skills_with_layout(
            &[("office-pptx", "---\nname: office-pptx\n---\n")],
            true,
            &BTreeSet::new(),
            false,
            &layout,
        )
        .unwrap();

        assert!(temp.path().join("store/office-pptx/SKILL.md").is_file());
        assert!(temp.path().join("codex/office-pptx/SKILL.md").is_file());
        assert!(temp.path().join("claude/office-pptx/SKILL.md").is_file());
    }

    #[test]
    fn hermes_and_fixed_custom_storage_report_only_supported_scopes() {
        let hermes = skills_surface(AgentKind::Hermes);
        assert!(hermes.global_supported);
        assert!(!hermes.project_supported);

        let storage = CustomAgentSkillStorage {
            agent_id: "fixed-reviewer".to_string(),
            shared_store: false,
            directory: Some(std::env::temp_dir().join("fixed-reviewer-skills")),
        };
        let (dirs, _) = resolved_skill_dirs("fixed-reviewer", Some(&storage), None).unwrap();
        assert!(dirs.iter().all(|dir| dir.scope == AgentSkillScope::Global));
    }

    #[test]
    fn marketplace_target_validation_accepts_declared_custom_agents() {
        let storage = CustomAgentSkillStorage {
            agent_id: "local-reviewer".to_string(),
            shared_store: true,
            directory: None,
        };
        assert_eq!(
            parse_agent_keys(&["local-reviewer".to_string()], &[storage])
                .unwrap()
                .into_iter()
                .collect::<Vec<_>>(),
            ["local-reviewer"]
        );
    }

    #[test]
    fn vibex_bot_skill_states_space_protocol_and_core_tools() {
        let skill = include_str!("skills/vibex-bot/SKILL.md");
        let playbook = include_str!("skills/vibex-bot/SPACE-RULES.md");
        let memory = include_str!("skills/vibex-bot/MEMORY.md");
        for body in [skill, playbook, memory] {
            assert!(
                !body.contains("我正在查看项目中"),
                "progress examples must stay out of skill text"
            );
            assert!(
                !body.contains("我已经查看了项目的完整架构"),
                "progress examples must stay out of skill text"
            );
            assert!(body.contains("Person"), "missing Person term");
            assert!(body.contains("BotSpace"), "missing BotSpace term");
            assert!(body.contains("GroupSpace"), "missing GroupSpace term");
        }
        for body in [skill, playbook] {
            assert!(body.contains("[PASS]"), "missing silent-pass token");
            assert!(body.contains("@BotName"), "missing GroupSpace @ addressing");
            assert!(
                body.contains("post_space_message"),
                "missing cross-space post tool"
            );
        }
        assert!(
            skill.contains("任务交接") && skill.contains("SPACE-RULES.md"),
            "skill must point at the handoff playbook"
        );
        assert!(
            playbook.contains("【已完成】")
                && playbook.contains("【上下文与约束】")
                && playbook.contains("【待办与闭环要求】"),
            "missing three-part handoff structure"
        );
        assert!(
            playbook.contains("三节都空则输出 `[PASS]`"),
            "empty handoff must fail closed"
        );
        assert!(
            playbook.contains("日志回执") && playbook.contains("叫醒回读"),
            "cross-space posts must distinguish log receipt from wake"
        );
        assert!(playbook.contains("~/.vibex/spaces/<space_id>/collection/"));
        assert!(
            playbook.contains("VIBEX_TEAM_SPACES_ROOT"),
            "collection root override must be named"
        );
        assert!(playbook.contains("space_id") && playbook.contains("session_id"));
        assert!(playbook.contains("负责人"), "missing group lead role");
        assert!(playbook.contains("叫你的人"), "missing asker-replies rule");
        assert!(
            playbook.contains("activity") && playbook.contains("waiting_for_bot"),
            "list_spaces roster must expose live activity"
        );
        assert!(
            playbook.contains("没有 `@` 则只进群日志"),
            "cross-space group posts must wake from body @"
        );
        assert!(
            playbook.contains("像同事发消息"),
            "missing everyday speech register"
        );
        assert!(
            playbook.contains("三种回合"),
            "playbook must distinguish Person / peer / group turns"
        );
        assert!(
            playbook.contains("[Message from …]") && playbook.contains("[Group chat …]"),
            "playbook must key off delivery headers"
        );
        assert!(
            playbook.contains("[上次发言后的群内新消息]")
                && (playbook.contains("严禁播报查看群消息")
                    || playbook.contains("严禁琐碎单步流水账")),
            "playbook must document envelope incremental context and forbid group-message peek / trivial step-by-step announcements"
        );
        assert!(
            playbook.contains("绝口不提协作规则")
                && playbook.contains("严禁复述已有结论")
                && playbook.contains("初步结论与长内容一律走「群收藏」")
                && playbook.contains("按受众定制内容")
                && playbook.contains("收到消息立即回应")
                && playbook.contains("冲突"),
            "playbook must enforce 3-stage rhythm, forbid rule meta-talk and repeating peer conclusions, require collection for long/preliminary outputs, and tailor content to audience"
        );
        assert!(
            skill.contains("[上次发言后的群内新消息]")
                && skill.contains("收到消息立即简短回应")
                && skill.contains("按汇报对象的职责与需求定制内容"),
            "skill must note that GroupSpace envelopes already carry incremental context and state the 3-stage audience-aware principles"
        );
        assert!(
            playbook.contains("interrupt")
                && playbook.contains("list_agents")
                && playbook.contains("thinking_level"),
            "playbook must document manage_bot interrupt, list_agents, and thinking_level"
        );
        assert!(
            skill.contains("list_agents")
                && skill.contains("model")
                && skill.contains("thinking_level"),
            "manage_bot skill table must document list_agents, model, and thinking_level"
        );
        assert!(
            skill.contains("按场景加载") && skill.contains("只加载当前回合用得到的节"),
            "skill must load SPACE-RULES by turn branch"
        );
        assert!(
            skill.contains("`action`: `create` / `rename` / `delete` / `add_bot` / `remove_bot` / `leave` / `set_lead`"),
            "manage_group must name required actions"
        );
        assert!(
            skill.contains("必填 `agent_type`、`task`"),
            "delegate_to_agent must name required args"
        );
        assert!(memory.contains("private"));
        assert!(
            memory.contains("`memory_write` 返回成功才算已记住"),
            "memory writes need a completion check"
        );
        assert!(
            memory.contains("[[topic:<slug>]]") && memory.contains("[[collection:<file>]]"),
            "memory skill must document topic and collection index pointers"
        );
        assert!(
            memory.contains("replace") && memory.contains("remove") && memory.contains("fact_id"),
            "memory skill must document in-place fact update and removal"
        );
        assert!(
            memory.contains("严禁写入密钥与凭证"),
            "memory skill must state the credential guard rule"
        );
        assert!(
            skill.contains("[[topic:...]]") && skill.contains("[[collection:...]]"),
            "SKILL.md router must point to MEMORY.md for topic and collection index pointers"
        );
        for tool in [
            "list_spaces",
            "read_space_messages",
            "post_space_message",
            "manage_bot",
            "manage_group",
            "ask_user_question",
            "request_approval",
            "memory_search",
            "memory_write",
            "delegate_to_agent",
            "get_delegation_status",
            "send_session_input",
        ] {
            assert!(skill.contains(tool), "missing tool {tool}");
        }
    }

    #[test]
    fn shared_hosting_destinations_keep_a_selected_owner() {
        let shared = PathBuf::from("/tmp/shared-skills/example");
        let mut destinations = BTreeMap::new();

        merge_hosting_destination(&mut destinations, shared.clone(), true);
        merge_hosting_destination(&mut destinations, shared.clone(), false);

        assert_eq!(destinations.get(&physical_path_key(&shared)), Some(&true));
    }

    #[test]
    fn sync_host_multi_agent_skill_updates_in_place_without_deleting_live_dir() {
        let temp = tempfile::tempdir().unwrap();
        let layout = SkillHostingLayout {
            store: temp.path().join("store"),
            agent_dirs: BTreeMap::from([("codex".to_string(), temp.path().join("codex"))]),
        };
        let dest = temp.path().join("vibex-bot");

        sync_host_multi_agent_skill_with_layout(true, &layout, &dest).unwrap();
        assert!(dest.join("SKILL.md").is_file());
        assert!(dest.join("SPACE-RULES.md").is_file());
        assert!(dest.join("MEMORY.md").is_file());

        // Write a stale file and hold an open file handle to SKILL.md while re-syncing
        let stale = dest.join("STALE.md");
        std::fs::write(&stale, "stale").unwrap();
        let _open_handle = std::fs::File::open(dest.join("SKILL.md")).unwrap();

        sync_host_multi_agent_skill_with_layout(true, &layout, &dest).unwrap();
        assert!(!stale.exists(), "stale entry should be pruned");
        assert!(dest.join("SKILL.md").is_file());
    }

    #[test]
    fn remove_skill_entry_handles_directory_symlinks_and_readonly_directories() {
        let temp = tempfile::tempdir().unwrap();
        let target_dir = temp.path().join("target-skill");
        std::fs::create_dir_all(&target_dir).unwrap();
        std::fs::write(target_dir.join("SKILL.md"), "---\nname: target\n---\n").unwrap();

        let link_path = temp.path().join("linked-skill");
        if symlink_dir(&target_dir, &link_path).is_ok() {
            remove_if_exists(&link_path).expect("directory symlink must be removable");
            assert!(!link_path.exists());
            assert!(
                target_dir.join("SKILL.md").is_file(),
                "removing directory symlink must not delete target contents"
            );
        }

        let readonly_dir = temp.path().join("readonly-skill");
        std::fs::create_dir_all(&readonly_dir).unwrap();
        let readonly_file = readonly_dir.join("SKILL.md");
        std::fs::write(&readonly_file, "---\nname: ro\n---\n").unwrap();
        let mut perms = std::fs::metadata(&readonly_file).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&readonly_file, perms).unwrap();

        remove_if_exists(&readonly_dir).expect("readonly skill directory must be removable");
        assert!(!readonly_dir.exists());
    }
}
