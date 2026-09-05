use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::{Path, PathBuf},
};

use api_types::AgentKind;
use chrono::{DateTime, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

mod cursor;
mod jsonl;
mod scan;
mod sqlite;

pub use scan::{
    HistoryPathDestination, HistoryScanEntry, LocalHistoryDestination,
    LocalHistoryImportJobSnapshot, LocalHistoryImportJobStatus, LocalHistoryImportLogEntry,
    LocalHistoryImportPhase, LocalHistoryImportProgress, LocalHistoryImportResult,
    LocalHistoryImportSelection, LocalHistoryScanFolder, LocalHistoryScanPage,
    LocalHistoryScanProgress, LocalHistoryScanSession, LocalHistorySessionStatus,
    build_local_history_scan_page, history_folder_name, history_paths_overlap,
    load_configured_history_session, match_history_destination, merge_history_sources,
    normalize_history_path, scan_configured_history, scan_configured_history_with_progress,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum ImportedAgentMessageRole {
    User,
    Assistant,
    System,
    Tool,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ImportedAgentMessage {
    pub role: ImportedAgentMessageRole,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(
        default,
        skip_serializing_if = "ImportedAgentMessageMetadata::is_empty"
    )]
    pub metadata: ImportedAgentMessageMetadata,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ImportedAgentMessageMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_input: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
}

impl ImportedAgentMessageMetadata {
    fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ImportedAgentSession {
    pub source_agent: AgentKind,
    pub external_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<PathBuf>,
    pub messages: Vec<ImportedAgentMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_source_path: Option<PathBuf>,
}

impl ImportedAgentSession {
    pub fn cap_payloads(&mut self) {
        if self.messages.len() > jsonl::MAX_HISTORY_MESSAGES {
            self.messages.truncate(jsonl::MAX_HISTORY_MESSAGES);
        }
        for message in &mut self.messages {
            message.content = match message.role {
                ImportedAgentMessageRole::Tool => {
                    crate::conversation::cap_preview_bytes(std::mem::take(&mut message.content))
                }
                _ => jsonl::cap_history_text(std::mem::take(&mut message.content)),
            };
            message.metadata.raw_input = message
                .metadata
                .raw_input
                .take()
                .map(crate::conversation::cap_json_value);
            message.metadata.raw_output = message
                .metadata
                .raw_output
                .take()
                .map(crate::conversation::cap_json_value);
        }
    }

    pub fn activity_times(&self) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
        let mut earliest = None;
        let mut latest = None;
        for timestamp in self
            .messages
            .iter()
            .filter_map(|message| message.created_at)
        {
            earliest =
                Some(earliest.map_or(timestamp, |current: DateTime<Utc>| current.min(timestamp)));
            latest =
                Some(latest.map_or(timestamp, |current: DateTime<Utc>| current.max(timestamp)));
        }
        match (earliest, latest) {
            (Some(created_at), Some(updated_at)) => Some((created_at, updated_at)),
            _ => source_file_mtime(self.raw_source_path.as_deref()).map(|time| (time, time)),
        }
    }
}

fn source_file_mtime(path: Option<&Path>) -> Option<DateTime<Utc>> {
    let modified = path?.metadata().ok()?.modified().ok()?;
    Some(DateTime::<Utc>::from(modified))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentHistorySource {
    pub agent_type: AgentKind,
    pub path: PathBuf,
}

#[derive(Debug, Error)]
pub enum AgentHistoryError {
    #[error("history source does not exist: {0}")]
    MissingSource(PathBuf),
    #[error("failed to read history source {path}: {error}")]
    Read { path: PathBuf, error: String },
    #[error("failed to parse history source {path}: {error}")]
    Parse { path: PathBuf, error: String },
}

pub fn default_history_sources(agent_type: AgentKind) -> Vec<AgentHistorySource> {
    match agent_type {
        AgentKind::ClaudeCode => env_or_home_sources(agent_type, "CLAUDE_CONFIG_DIR", ".claude")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("projects"),
                ..source
            })
            .collect(),
        AgentKind::Codex => env_or_home_sources(agent_type, "CODEX_HOME", ".codex")
            .into_iter()
            .flat_map(|source| codex_history_roots(source.path, agent_type))
            .collect(),
        AgentKind::Opencode => xdg_data_or_home_sources(agent_type, "opencode")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("opencode.db"),
                ..source
            })
            .collect(),
        AgentKind::Antigravity => env_or_home_sources(agent_type, "GEMINI_HOME", ".gemini")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("antigravity-acp").join("conversations"),
                ..source
            })
            .collect(),
        AgentKind::Openclaw => env_or_home_sources(agent_type, "OPENCLAW_HOME", ".openclaw")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("agents"),
                ..source
            })
            .collect(),
        AgentKind::Cline => env_or_home_sources(agent_type, "CLINE_DIR", ".cline/data")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("tasks"),
                ..source
            })
            .collect(),
        AgentKind::Hermes => env_or_home_sources(agent_type, "HERMES_HOME", ".hermes")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("state.db"),
                ..source
            })
            .collect(),
        AgentKind::Codebuddy => {
            env_or_home_sources(agent_type, "CODEBUDDY_CONFIG_DIR", ".codebuddy")
                .into_iter()
                .map(|source| AgentHistorySource {
                    path: source.path.join("projects"),
                    ..source
                })
                .collect()
        }
        AgentKind::KimiCode => env_or_home_sources(agent_type, "KIMI_CODE_HOME", ".kimi-code")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("sessions"),
                ..source
            })
            .collect(),
        AgentKind::Pi => pi_history_sources(agent_type),
        AgentKind::Grok => env_or_home_sources(agent_type, "GROK_HOME", ".grok")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("sessions"),
                ..source
            })
            .collect(),
        AgentKind::Cursor => cursor_history_sources(agent_type),
        AgentKind::DeepseekHarness => env_or_home_sources(agent_type, "DSH_HOME", ".dsh")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("sessions"),
                ..source
            })
            .collect(),
        AgentKind::Qoder => env_or_home_sources(agent_type, "QODER_CONFIG_DIR", ".qoder")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("projects"),
                ..source
            })
            .collect(),
        // In-process mock agent: no on-disk history to import.
        AgentKind::QaMock => Vec::new(),
    }
}

/// Resolve history locations from both the current process and VibeX's saved
/// per-Agent environment. Saved settings are considered first so custom homes
/// selected in Settings are immediately reflected by the import picker.
pub fn configured_history_sources(
    agent_type: AgentKind,
    configured_env: &HashMap<String, String>,
) -> Vec<AgentHistorySource> {
    let configured =
        match agent_type {
            AgentKind::ClaudeCode => configured_root(configured_env, "CLAUDE_CONFIG_DIR")
                .map(|path| path.join("projects")),
            AgentKind::Codex => None,
            AgentKind::Opencode => configured_root(configured_env, "XDG_DATA_HOME")
                .map(|path| path.join("opencode").join("opencode.db")),
            AgentKind::Antigravity => configured_root(configured_env, "GEMINI_HOME")
                .map(|path| path.join("antigravity-acp").join("conversations")),
            AgentKind::Openclaw => {
                configured_root(configured_env, "OPENCLAW_HOME").map(|path| path.join("agents"))
            }
            AgentKind::Cline => {
                configured_root(configured_env, "CLINE_DIR").map(|path| path.join("tasks"))
            }
            AgentKind::Hermes => {
                configured_root(configured_env, "HERMES_HOME").map(|path| path.join("state.db"))
            }
            AgentKind::Codebuddy => configured_root(configured_env, "CODEBUDDY_CONFIG_DIR")
                .map(|path| path.join("projects")),
            AgentKind::KimiCode => {
                configured_root(configured_env, "KIMI_CODE_HOME").map(|path| path.join("sessions"))
            }
            AgentKind::Pi => configured_root(configured_env, "PI_CODING_AGENT_SESSION_DIR")
                .or_else(|| {
                    configured_root(configured_env, "PI_CODING_AGENT_DIR")
                        .map(|path| path.join("sessions"))
                }),
            AgentKind::Grok => {
                configured_root(configured_env, "GROK_HOME").map(|path| path.join("sessions"))
            }
            AgentKind::Cursor => configured_root(configured_env, "CURSOR_CONFIG_DIR"),
            AgentKind::DeepseekHarness => {
                configured_root(configured_env, "DEEPSEEK_ACP_SESSIONS_ROOT").or_else(|| {
                    configured_root(configured_env, "DSH_HOME").map(|path| path.join("sessions"))
                })
            }
            AgentKind::Qoder => configured_root(configured_env, "QODER_CONFIG_DIR")
                .map(|path| path.join("projects")),
            AgentKind::QaMock => None,
        }
        .into_iter()
        .collect::<Vec<_>>();

    let configured = if agent_type == AgentKind::Codex {
        configured_root(configured_env, "CODEX_HOME")
            .map(|path| {
                codex_history_roots(path, agent_type)
                    .into_iter()
                    .map(|source| source.path)
                    .collect()
            })
            .unwrap_or_default()
    } else {
        configured
    };

    let mut seen = BTreeSet::new();
    configured
        .into_iter()
        .map(|path| AgentHistorySource { agent_type, path })
        .chain(default_history_sources(agent_type))
        .filter(|source| seen.insert(source.path.clone()))
        .collect()
}

fn codex_history_roots(home: PathBuf, agent_type: AgentKind) -> Vec<AgentHistorySource> {
    ["sessions", "archived_sessions"]
        .into_iter()
        .map(|folder| AgentHistorySource {
            agent_type,
            path: home.join(folder),
        })
        .collect()
}

fn configured_root(configured_env: &HashMap<String, String>, key: &str) -> Option<PathBuf> {
    configured_env
        .get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| expand_configured_history_path(path, dirs::home_dir().as_deref()))
}

fn expand_configured_history_path(path: PathBuf, home: Option<&Path>) -> PathBuf {
    let Some(home) = home else {
        return path;
    };
    if path == Path::new("~") {
        return home.to_path_buf();
    }
    if let Ok(relative) = path.strip_prefix("~/") {
        return home.join(relative);
    }
    if path.is_relative() {
        return home.join(path);
    }
    path
}

pub fn import_history_source(
    source: &AgentHistorySource,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let mut sessions = Vec::new();
    visit_imported_sessions(source, |session| {
        sessions.push(session);
        true
    })?;
    Ok(sessions)
}

/// Yield one imported session at a time so scan/load never retain the whole
/// transcript tree. Database-backed agents still materialize their store once.
pub(super) fn visit_imported_sessions(
    source: &AgentHistorySource,
    mut on_session: impl FnMut(ImportedAgentSession) -> bool,
) -> Result<(), AgentHistoryError> {
    if !source.path.exists() {
        return Err(AgentHistoryError::MissingSource(source.path.clone()));
    }

    if is_database_history_source(source) {
        for session in import_database_history(source)? {
            if !on_session(session) {
                break;
            }
        }
        return Ok(());
    }

    let mut post = SessionPostProcess::new(source);
    for file in history_files(source.agent_type, &source.path)? {
        let mut grouped: BTreeMap<String, ImportedAgentSession> = BTreeMap::new();
        for record in parse_history_file(source.agent_type, &file)? {
            grouped
                .entry(record.external_session_id.clone())
                .and_modify(|session| session.messages.extend(record.messages.clone()))
                .or_insert(record);
        }
        for session in grouped.into_values() {
            let Some(session) = post.finalize(session) else {
                continue;
            };
            if !on_session(session) {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn is_database_history_source(source: &AgentHistorySource) -> bool {
    (matches!(source.agent_type, AgentKind::Opencode | AgentKind::Hermes) && source.path.is_file())
        || source.agent_type == AgentKind::Cursor
        || source.agent_type == AgentKind::Antigravity
}

fn import_database_history(
    source: &AgentHistorySource,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let sessions = if matches!(source.agent_type, AgentKind::Opencode | AgentKind::Hermes)
        && source.path.is_file()
    {
        sqlite::import_agent_database(source.agent_type, &source.path)?
    } else if source.agent_type == AgentKind::Cursor {
        cursor::import_cursor_stores(&source.path)?
    } else {
        sqlite::import_antigravity_conversations(&source.path)?
    };
    Ok(cap_imported_sessions(sessions))
}

struct SessionPostProcess {
    agent_type: AgentKind,
    source_path: PathBuf,
    kimi_workspaces: Option<BTreeMap<String, PathBuf>>,
    codex_titles: BTreeMap<PathBuf, BTreeMap<String, String>>,
}

impl SessionPostProcess {
    fn new(source: &AgentHistorySource) -> Self {
        Self {
            agent_type: source.agent_type,
            source_path: source.path.clone(),
            kimi_workspaces: None,
            codex_titles: BTreeMap::new(),
        }
    }

    fn finalize(&mut self, mut session: ImportedAgentSession) -> Option<ImportedAgentSession> {
        session.cap_payloads();
        match self.agent_type {
            AgentKind::KimiCode => {
                apply_kimi_workspace(&self.source_path, &mut session, &mut self.kimi_workspaces)
            }
            AgentKind::Grok => {
                if !apply_grok_summary(&mut session) {
                    return None;
                }
                apply_grok_ask_answers(&mut session);
            }
            AgentKind::Codex => {
                apply_codex_session_index_title(&mut session, &mut self.codex_titles)
            }
            _ => {}
        }
        Some(session)
    }
}

fn cap_imported_sessions(mut sessions: Vec<ImportedAgentSession>) -> Vec<ImportedAgentSession> {
    for session in &mut sessions {
        session.cap_payloads();
    }
    sessions
}

fn env_or_home_sources(
    agent_type: AgentKind,
    env_var: &str,
    home_relative: &str,
) -> Vec<AgentHistorySource> {
    let mut sources = Vec::new();
    if let Ok(value) = std::env::var(env_var)
        && !value.trim().is_empty()
    {
        sources.push(AgentHistorySource {
            agent_type,
            path: expand_configured_history_path(PathBuf::from(value), dirs::home_dir().as_deref()),
        });
    }
    if let Some(source) = home_source(agent_type, home_relative) {
        sources.push(source);
    }
    sources
}

fn xdg_data_or_home_sources(agent_type: AgentKind, app_dir: &str) -> Vec<AgentHistorySource> {
    let mut sources = Vec::new();
    if let Ok(value) = std::env::var("XDG_DATA_HOME")
        && !value.trim().is_empty()
    {
        sources.push(AgentHistorySource {
            agent_type,
            path: PathBuf::from(value).join(app_dir),
        });
    }
    if let Some(data_dir) = dirs::home_dir().map(|home| home.join(".local").join("share")) {
        sources.push(AgentHistorySource {
            agent_type,
            path: data_dir.join(app_dir),
        });
    }
    sources
}

fn pi_history_sources(agent_type: AgentKind) -> Vec<AgentHistorySource> {
    if let Some(path) = std::env::var_os("PI_CODING_AGENT_SESSION_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        return vec![AgentHistorySource { agent_type, path }];
    }
    if let Some(path) = std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        return vec![AgentHistorySource {
            agent_type,
            path: path.join("sessions"),
        }];
    }
    home_source(agent_type, ".pi/agent/sessions")
        .into_iter()
        .collect()
}

fn cursor_history_sources(agent_type: AgentKind) -> Vec<AgentHistorySource> {
    let mut sources = Vec::new();
    if let Ok(value) = std::env::var("CURSOR_CONFIG_DIR")
        && !value.trim().is_empty()
    {
        sources.push(AgentHistorySource {
            agent_type,
            path: expand_configured_history_path(PathBuf::from(value), dirs::home_dir().as_deref()),
        });
    }
    if let Ok(value) = std::env::var("XDG_CONFIG_HOME")
        && !value.trim().is_empty()
    {
        sources.push(AgentHistorySource {
            agent_type,
            path: PathBuf::from(value).join("cursor"),
        });
    }
    if let Some(source) = home_source(agent_type, ".cursor") {
        sources.push(source);
    }
    sources
}

fn home_source(agent_type: AgentKind, home_relative: &str) -> Option<AgentHistorySource> {
    dirs::home_dir().map(|home| AgentHistorySource {
        agent_type,
        path: home.join(home_relative),
    })
}

pub(super) fn history_files(
    agent_type: AgentKind,
    path: &Path,
) -> Result<Vec<PathBuf>, AgentHistoryError> {
    if path.is_file() {
        return Ok(is_direct_text_history_file(agent_type, path)
            .then(|| path.to_path_buf())
            .into_iter()
            .collect());
    }

    let mut files = Vec::new();
    let mut visited = BTreeSet::new();
    collect_history_files(agent_type, path, &mut files, &mut visited)?;
    files.sort();
    Ok(files)
}

fn is_direct_text_history_file(agent_type: AgentKind, path: &Path) -> bool {
    if agent_type == AgentKind::Antigravity {
        return path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("session-"))
            && matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("json") | Some("jsonl")
            );
    }
    is_text_history_file(agent_type, path)
}

fn collect_history_files(
    agent_type: AgentKind,
    path: &Path,
    files: &mut Vec<PathBuf>,
    visited: &mut BTreeSet<PathBuf>,
) -> Result<(), AgentHistoryError> {
    let canonical = std::fs::canonicalize(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    if !visited.insert(canonical) {
        return Ok(());
    }
    let entries = std::fs::read_dir(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;

    for entry in entries {
        let entry = entry.map_err(|error| AgentHistoryError::Read {
            path: path.to_path_buf(),
            error: error.to_string(),
        })?;
        let path = entry.path();
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|error| AgentHistoryError::Read {
                path: path.clone(),
                error: error.to_string(),
            })?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_history_files(agent_type, &path, files, visited)?;
        } else if is_text_history_file(agent_type, &path) {
            files.push(path);
        }
    }

    Ok(())
}

fn is_text_history_file(agent_type: AgentKind, path: &Path) -> bool {
    let name = path.file_name().and_then(|name| name.to_str());
    if agent_type == AgentKind::KimiCode {
        return name == Some("wire.jsonl");
    }
    if agent_type == AgentKind::Grok {
        return name == Some("updates.jsonl");
    }
    if agent_type == AgentKind::DeepseekHarness {
        return name == Some("session.jsonl") || name == Some("session.jsonl.zstd");
    }
    if agent_type == AgentKind::Antigravity {
        return name.is_some_and(|name| name.starts_with("session-"))
            && matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("json") | Some("jsonl")
            )
            && path
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                == Some("chats");
    }
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("json") | Some("jsonl")
    )
}

pub(super) fn parse_history_file(
    agent_type: AgentKind,
    path: &Path,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    if agent_type == AgentKind::Codex
        && path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
    {
        return parse_codex_rollout(path);
    }
    if agent_type == AgentKind::DeepseekHarness
        && path.file_name().and_then(|name| name.to_str()) == Some("session.jsonl.zstd")
    {
        let raw = read_zstd_jsonl(path)?;
        return parse_jsonl_history(agent_type, path, &raw);
    }
    let raw = std::fs::read_to_string(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    match (
        agent_type,
        path.extension().and_then(|extension| extension.to_str()),
    ) {
        (AgentKind::Pi, Some("jsonl")) => parse_pi_session(path, &raw),
        (
            AgentKind::ClaudeCode | AgentKind::Openclaw | AgentKind::Codebuddy | AgentKind::Qoder,
            Some("jsonl"),
        ) => parse_structured_jsonl(agent_type, path, &raw),
        (AgentKind::Antigravity, Some("jsonl")) => parse_gemini_jsonl_chat(path, &raw),
        (AgentKind::Antigravity, Some("json")) => parse_gemini_chat(path, &raw),
        (AgentKind::Cline, Some("json")) => parse_cline_task(path, &raw),
        (_, Some("jsonl")) => parse_jsonl_history(agent_type, path, &raw),
        _ => parse_json_history(agent_type, path, &raw),
    }
}

fn parse_codex_rollout(path: &Path) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let mut session_id = None;
    let mut workspace_path = None;
    let mut session_timestamp = None;
    let mut messages = Vec::new();
    jsonl::for_each_jsonl_value(path, |value| {
        let envelope = value.get("type").and_then(serde_json::Value::as_str);
        if envelope == Some("session_meta")
            && let Some(payload) = value.get("payload")
        {
            if session_id.is_none() {
                session_id = string_at_any(payload, &["id", "session_id"]);
            }
            if workspace_path.is_none() {
                workspace_path =
                    string_at_any(payload, &["cwd", "workspace_path"]).map(PathBuf::from);
            }
            if session_timestamp.is_none() {
                session_timestamp = timestamp_from_value(AgentKind::Codex, payload)
                    .or_else(|| timestamp_from_value(AgentKind::Codex, &value));
            }
        }
        let Some(payload) = value.get("payload") else {
            return Ok(());
        };
        let parsed = match envelope {
            Some("response_item") => codex_response_item(payload),
            Some("event_msg") => {
                let parsed = codex_event_message(payload);
                match &parsed {
                    Some((role, content))
                        if is_codex_display_event(payload)
                            && messages.iter().any(|message: &ImportedAgentMessage| {
                                message.role == *role
                                    && message.content.trim() == content.as_str().trim()
                            }) =>
                    {
                        None
                    }
                    _ => parsed,
                }
            }
            _ => None,
        };
        if let Some((role, content)) = parsed {
            if role == ImportedAgentMessageRole::User && is_codex_injected_context(&content) {
                return Ok(());
            }
            if messages.len() < jsonl::MAX_HISTORY_MESSAGES {
                messages.push(ImportedAgentMessage {
                    role,
                    content: jsonl::cap_history_text(content),
                    created_at: timestamp_from_value(AgentKind::Codex, &value)
                        .or_else(|| timestamp_from_value(AgentKind::Codex, payload)),
                    metadata: message_metadata(AgentKind::Codex, payload),
                });
            }
        }
        Ok(())
    })?;
    if messages.is_empty() {
        let mut sessions = Vec::new();
        jsonl::for_each_jsonl_value(path, |value| {
            if let Some(record) = imported_session_from_value(AgentKind::Codex, path, &value) {
                sessions.push(record);
            }
            Ok(())
        })?;
        return Ok(sessions);
    }
    if messages.iter().all(|message| message.created_at.is_none())
        && let Some(timestamp) = session_timestamp
    {
        for message in &mut messages {
            message.created_at = Some(timestamp);
        }
    }
    Ok(vec![ImportedAgentSession {
        source_agent: AgentKind::Codex,
        external_session_id: session_id.unwrap_or_else(|| history_file_session_id(path)),
        title: messages
            .iter()
            .find(|message| message.role == ImportedAgentMessageRole::User)
            .map(|message| codex_title_from_content(&message.content)),
        workspace_path,
        messages,
        raw_source_path: Some(path.to_path_buf()),
    }])
}

fn is_codex_display_event(payload: &serde_json::Value) -> bool {
    matches!(
        payload.get("type").and_then(serde_json::Value::as_str),
        Some("user_message" | "agent_message")
    )
}

fn is_codex_injected_context(content: &str) -> bool {
    let content = content.trim_start();
    [
        "<recommended_plugins>",
        "# AGENTS.md instructions for ",
        "<environment_context>",
        "<permissions instructions>",
        "<app-context>",
        "<skills_instructions>",
        "<apps_instructions>",
        "<plugins_instructions>",
    ]
    .iter()
    .any(|prefix| content.starts_with(prefix))
}

fn codex_title_from_content(content: &str) -> String {
    let content = content
        .split_once("## My request:")
        .map(|(_, request)| request.trim_start())
        .filter(|request| !request.is_empty())
        .unwrap_or(content);
    title_from_content(content)
}

fn codex_response_item(payload: &serde_json::Value) -> Option<(ImportedAgentMessageRole, String)> {
    match payload.get("type").and_then(serde_json::Value::as_str)? {
        "message" => Some((role_from_value(payload), content_from_value(payload)?)),
        "function_call" => Some((
            ImportedAgentMessageRole::Tool,
            format!(
                "[tool: {}]\ninput: {}",
                payload
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown"),
                payload
                    .get("arguments")
                    .and_then(json_preview)
                    .unwrap_or_default()
            ),
        )),
        "function_call_output" => Some((
            ImportedAgentMessageRole::Tool,
            format!(
                "[tool result: {}]\n{}",
                payload
                    .get("call_id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown"),
                payload
                    .get("output")
                    .and_then(json_preview)
                    .unwrap_or_default()
            ),
        )),
        _ => None,
    }
}

fn codex_event_message(payload: &serde_json::Value) -> Option<(ImportedAgentMessageRole, String)> {
    let role = match payload.get("type").and_then(serde_json::Value::as_str)? {
        "user_message" => ImportedAgentMessageRole::User,
        "agent_message" | "agent_reasoning" => ImportedAgentMessageRole::Assistant,
        _ => return None,
    };
    let content = string_at_any(payload, &["message", "text", "content"])?;
    Some((role, content))
}

fn parse_pi_session(
    path: &Path,
    raw: &str,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let values = parse_jsonl_values(path, raw)?;
    let header = values
        .iter()
        .find(|value| value.get("type").and_then(serde_json::Value::as_str) == Some("session"));
    let session_id = header
        .and_then(|value| string_at_any(value, &["id", "session_id"]))
        .unwrap_or_else(|| history_file_session_id(path));
    let workspace_path = header
        .and_then(|value| string_at_any(value, &["cwd", "workspace_path"]))
        .map(PathBuf::from);
    let mut messages = Vec::new();
    for (index, value) in values.iter().enumerate() {
        match value.get("type").and_then(serde_json::Value::as_str) {
            Some("message") => {
                let Some(message) = value.get("message") else {
                    continue;
                };
                let Some(content) = content_from_value(message) else {
                    continue;
                };
                messages.push(ImportedAgentMessage {
                    role: role_from_value(message),
                    content,
                    created_at: timestamp_from_value(AgentKind::Pi, value)
                        .or_else(|| timestamp_from_value(AgentKind::Pi, message)),
                    metadata: message_metadata(AgentKind::Pi, message),
                });
            }
            Some("bash_execution") => {
                messages.extend(pi_bash_execution_messages(value, index));
            }
            _ => {}
        }
    }
    Ok((!messages.is_empty())
        .then(|| ImportedAgentSession {
            source_agent: AgentKind::Pi,
            external_session_id: session_id,
            title: messages
                .iter()
                .find(|message| message.role == ImportedAgentMessageRole::User)
                .map(|message| title_from_content(&message.content)),
            workspace_path,
            messages,
            raw_source_path: Some(path.to_path_buf()),
        })
        .into_iter()
        .collect())
}

fn parse_gemini_chat(
    path: &Path,
    raw: &str,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let value = parse_json_value(path, raw)?;
    let Some(messages) = value.get("messages").and_then(serde_json::Value::as_array) else {
        return parse_json_history(AgentKind::Antigravity, path, raw);
    };
    let imported = messages
        .iter()
        .filter_map(|message| {
            let role = match message.get("type").and_then(serde_json::Value::as_str) {
                Some("gemini") | Some("assistant") => ImportedAgentMessageRole::Assistant,
                Some("user") => ImportedAgentMessageRole::User,
                _ => role_from_value(message),
            };
            Some(ImportedAgentMessage {
                role,
                content: content_from_value(message)?,
                created_at: timestamp_from_value(AgentKind::Antigravity, message),
                metadata: message_metadata(AgentKind::Antigravity, message),
            })
        })
        .collect::<Vec<_>>();
    Ok((!imported.is_empty())
        .then(|| ImportedAgentSession {
            source_agent: AgentKind::Antigravity,
            external_session_id: string_at_any(&value, &["sessionId", "session_id", "id"])
                .unwrap_or_else(|| history_file_session_id(path)),
            title: string_at_any(&value, &["title", "summary"]).or_else(|| {
                imported
                    .iter()
                    .find(|message| message.role == ImportedAgentMessageRole::User)
                    .map(|message| title_from_content(&message.content))
            }),
            workspace_path: string_at_any(&value, &["cwd", "workspace", "workspace_path"])
                .map(PathBuf::from),
            messages: imported,
            raw_source_path: Some(path.to_path_buf()),
        })
        .into_iter()
        .collect())
}

fn parse_gemini_jsonl_chat(
    path: &Path,
    raw: &str,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let values = parse_jsonl_values(path, raw)?;
    let mut root = serde_json::Map::new();
    let mut messages = Vec::<serde_json::Value>::new();
    let mut indexes = HashMap::<String, usize>::new();
    for value in values {
        let Some(object) = value.as_object() else {
            continue;
        };
        for key in [
            "kind",
            "sessionId",
            "projectHash",
            "startTime",
            "lastUpdated",
            "cwd",
        ] {
            if let Some(field) = object.get(key)
                && (key == "lastUpdated" || !root.contains_key(key))
            {
                root.insert(key.to_string(), field.clone());
            }
        }
        if object
            .get("type")
            .and_then(serde_json::Value::as_str)
            .is_none()
        {
            continue;
        }
        if let Some(id) = object.get("id").and_then(serde_json::Value::as_str) {
            if let Some(index) = indexes.get(id).copied()
                && let (Some(existing), Some(update)) =
                    (messages[index].as_object_mut(), value.as_object())
            {
                existing.extend(update.clone());
                continue;
            }
            indexes.insert(id.to_string(), messages.len());
        }
        messages.push(value);
    }
    root.insert("messages".to_string(), serde_json::Value::Array(messages));
    let document = serde_json::to_string(&root).map_err(|error| AgentHistoryError::Parse {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    parse_gemini_chat(path, &document)
}

fn parse_cline_task(
    path: &Path,
    raw: &str,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let mut sessions = parse_json_history(AgentKind::Cline, path, raw)?;
    let session_id = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| history_file_session_id(path));
    for session in &mut sessions {
        session.external_session_id.clone_from(&session_id);
    }
    Ok(sessions)
}

fn parse_structured_jsonl(
    agent_type: AgentKind,
    path: &Path,
    raw: &str,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let values = parse_jsonl_values(path, raw)?;
    let session_id = values
        .iter()
        .find_map(|value| {
            string_at_any(value, &["sessionId", "session_id"]).or_else(|| {
                (value.get("type").and_then(serde_json::Value::as_str) == Some("session"))
                    .then(|| string_at_any(value, &["id"]))
                    .flatten()
            })
        })
        .unwrap_or_else(|| history_file_session_id(path));
    let workspace_path = values
        .iter()
        .find_map(|value| string_at_any(value, &["cwd", "workspace", "workspace_path"]))
        .map(PathBuf::from)
        .or_else(|| {
            (agent_type == AgentKind::Openclaw)
                .then(|| {
                    values.iter().find_map(|value| {
                        value
                            .pointer("/message/content")
                            .and_then(content_value_text)
                            .or_else(|| {
                                value
                                    .pointer("/message/content")
                                    .and_then(serde_json::Value::as_str)
                                    .map(str::to_string)
                            })
                            .and_then(|text| openclaw_working_dir(&text))
                    })
                })
                .flatten()
        });
    let mut messages = Vec::new();
    for value in &values {
        messages.extend(match agent_type {
            AgentKind::ClaudeCode | AgentKind::Qoder => claude_code_messages(value),
            AgentKind::Openclaw => openclaw_messages(value),
            AgentKind::Codebuddy => codebuddy_messages(value),
            _ => Vec::new(),
        });
    }
    if messages.is_empty() {
        return parse_jsonl_history(agent_type, path, raw);
    }
    let explicit_title = first_explicit_title(&values, &["customTitle"])
        .or_else(|| first_explicit_title(&values, &["aiTitle"]))
        .or_else(|| first_explicit_title(&values, &["title", "summary", "topic"]));
    Ok(vec![ImportedAgentSession {
        source_agent: agent_type,
        external_session_id: session_id,
        title: explicit_title.or_else(|| {
            messages
                .iter()
                .find(|message| message.role == ImportedAgentMessageRole::User)
                .map(|message| title_from_content(&message.content))
        }),
        workspace_path,
        messages,
        raw_source_path: Some(path.to_path_buf()),
    }])
}

fn claude_code_messages(value: &serde_json::Value) -> Vec<ImportedAgentMessage> {
    if value
        .get("isSidechain")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
        || value.get("isMeta").and_then(serde_json::Value::as_bool) == Some(true)
        || value
            .get("isCompactSummary")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    {
        return Vec::new();
    }
    let envelope_type = value.get("type").and_then(serde_json::Value::as_str);
    if !matches!(envelope_type, Some("user" | "assistant" | "message")) {
        return Vec::new();
    }
    let message = value.get("message").unwrap_or(value);
    let role = role_from_value(message);
    structured_content_messages(AgentKind::ClaudeCode, value, message, role, false)
}

fn openclaw_messages(value: &serde_json::Value) -> Vec<ImportedAgentMessage> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("message") {
        return Vec::new();
    }
    let Some(message) = value.get("message") else {
        return Vec::new();
    };
    let role_name = message
        .get("role")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if role_name == "toolResult" {
        let raw_output = message.get("content").cloned();
        let content = raw_output
            .as_ref()
            .and_then(content_value_text)
            .or_else(|| raw_output.as_ref().and_then(json_preview))
            .unwrap_or_default();
        let is_error = message
            .get("isError")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        return nonempty_message(
            ImportedAgentMessageRole::Tool,
            content,
            timestamp_from_value(AgentKind::Openclaw, value)
                .or_else(|| timestamp_from_value(AgentKind::Openclaw, message)),
            ImportedAgentMessageMetadata {
                kind: Some("tool_result".to_string()),
                tool_call_id: string_at_any(message, &["toolCallId", "tool_call_id"]),
                tool_name: string_at_any(message, &["toolName", "tool_name"]),
                tool_status: Some(if is_error { "failed" } else { "completed" }.to_string()),
                raw_output,
                ..message_metadata(AgentKind::Openclaw, message)
            },
        )
        .into_iter()
        .collect();
    }
    structured_content_messages(
        AgentKind::Openclaw,
        value,
        message,
        role_from_value(message),
        true,
    )
}

fn structured_content_messages(
    agent_type: AgentKind,
    envelope: &serde_json::Value,
    message: &serde_json::Value,
    default_role: ImportedAgentMessageRole,
    openclaw: bool,
) -> Vec<ImportedAgentMessage> {
    let created_at = timestamp_from_value(agent_type, envelope)
        .or_else(|| timestamp_from_value(agent_type, message));
    let Some(content) = message.get("content") else {
        return Vec::new();
    };
    if let Some(text) = content.as_str() {
        let text = if openclaw && default_role == ImportedAgentMessageRole::User {
            strip_openclaw_user_text(text)
        } else {
            text.to_string()
        };
        return nonempty_message(
            default_role,
            text,
            created_at,
            message_metadata(agent_type, message),
        )
        .into_iter()
        .collect();
    }
    let Some(blocks) = content.as_array() else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter_map(|block| {
            let kind = block
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            match kind {
                "text" | "input_text" | "output_text" => {
                    let mut text = string_at_any(block, &["text", "content"])?;
                    if openclaw {
                        text = text
                            .strip_prefix("[[reply_to_current]] ")
                            .unwrap_or(&text)
                            .to_string();
                        if default_role == ImportedAgentMessageRole::User {
                            text = strip_openclaw_user_text(&text);
                        }
                    }
                    nonempty_message(
                        default_role.clone(),
                        text,
                        created_at,
                        message_metadata(agent_type, message),
                    )
                }
                "thinking" | "reasoning" => nonempty_message(
                    ImportedAgentMessageRole::Assistant,
                    string_at_any(block, &["thinking", "text", "content"])?,
                    created_at,
                    ImportedAgentMessageMetadata {
                        kind: Some("reasoning".to_string()),
                        ..message_metadata(agent_type, message)
                    },
                ),
                "image" | "image_url" => nonempty_message(
                    default_role.clone(),
                    image_placeholder(block),
                    created_at,
                    ImportedAgentMessageMetadata {
                        kind: Some("image".to_string()),
                        ..message_metadata(agent_type, message)
                    },
                ),
                "tool_use" | "toolCall" => {
                    let name = string_at_any(block, &["name", "tool"])
                        .unwrap_or_else(|| "unknown".to_string());
                    let raw_input = block
                        .get("input")
                        .or_else(|| block.get("arguments"))
                        .cloned();
                    nonempty_message(
                        ImportedAgentMessageRole::Tool,
                        format!(
                            "[tool: {name}]{}",
                            raw_input
                                .as_ref()
                                .and_then(json_preview)
                                .map(|input| format!("\ninput: {input}"))
                                .unwrap_or_default()
                        ),
                        created_at,
                        ImportedAgentMessageMetadata {
                            kind: Some("tool_call".to_string()),
                            tool_call_id: string_at_any(block, &["id", "toolCallId"]),
                            tool_name: Some(name),
                            raw_input,
                            ..message_metadata(agent_type, message)
                        },
                    )
                }
                "tool_result" => {
                    let raw_output = block.get("content").cloned();
                    let content = raw_output
                        .as_ref()
                        .and_then(content_value_text)
                        .or_else(|| raw_output.as_ref().and_then(json_preview))
                        .unwrap_or_default();
                    let failed = block
                        .get("is_error")
                        .or_else(|| block.get("isError"))
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);
                    nonempty_message(
                        ImportedAgentMessageRole::Tool,
                        content,
                        created_at,
                        ImportedAgentMessageMetadata {
                            kind: Some("tool_result".to_string()),
                            tool_call_id: string_at_any(
                                block,
                                &["tool_use_id", "toolCallId", "id"],
                            ),
                            tool_status: Some(
                                if failed { "failed" } else { "completed" }.to_string(),
                            ),
                            raw_output,
                            ..message_metadata(agent_type, message)
                        },
                    )
                }
                _ => None,
            }
        })
        .collect()
}

fn codebuddy_messages(value: &serde_json::Value) -> Vec<ImportedAgentMessage> {
    let created_at = timestamp_from_value(AgentKind::Codebuddy, value);
    match value.get("type").and_then(serde_json::Value::as_str) {
        Some("message") => {
            let message = value.get("message").unwrap_or(value);
            let role = role_from_value(message);
            structured_content_messages(AgentKind::Codebuddy, value, message, role, false)
        }
        Some("reasoning") => value
            .get("rawContent")
            .or_else(|| value.get("content"))
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|block| {
                nonempty_message(
                    ImportedAgentMessageRole::Assistant,
                    string_at_any(block, &["text", "content"])?,
                    created_at,
                    ImportedAgentMessageMetadata {
                        kind: Some("reasoning".to_string()),
                        model: value
                            .pointer("/providerData/requestModelName")
                            .or_else(|| value.pointer("/providerData/model"))
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string),
                        ..Default::default()
                    },
                )
            })
            .collect(),
        Some("function_call") => {
            let name = string_at_any(value, &["name"]).unwrap_or_else(|| "unknown".to_string());
            let raw_input = value.get("arguments").map(decoded_json_value);
            nonempty_message(
                ImportedAgentMessageRole::Tool,
                format!(
                    "[tool: {name}]{}",
                    raw_input
                        .as_ref()
                        .and_then(json_preview)
                        .map(|input| format!("\ninput: {input}"))
                        .unwrap_or_default()
                ),
                created_at,
                ImportedAgentMessageMetadata {
                    kind: Some("tool_call".to_string()),
                    tool_call_id: string_at_any(value, &["callId", "call_id", "id"]),
                    tool_name: Some(name),
                    raw_input,
                    ..message_metadata(AgentKind::Codebuddy, value)
                },
            )
            .into_iter()
            .collect()
        }
        Some("function_call_result") => {
            let provider_result = value.pointer("/providerData/toolResult");
            let raw_output = provider_result
                .cloned()
                .or_else(|| value.get("output").cloned());
            let content = value
                .pointer("/output/text")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    value
                        .get("output")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                })
                .or_else(|| {
                    provider_result
                        .and_then(|result| result.get("content"))
                        .and_then(content_value_text)
                })
                .or_else(|| raw_output.as_ref().and_then(json_preview))
                .unwrap_or_default();
            let failed = provider_result
                .and_then(|result| result.get("error"))
                .is_some_and(|error| {
                    !error.is_null() && error.as_str().is_none_or(|text| !text.trim().is_empty())
                })
                || value
                    .get("status")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|status| {
                        matches!(
                            status,
                            "error" | "failed" | "failure" | "cancelled" | "canceled"
                        )
                    });
            nonempty_message(
                ImportedAgentMessageRole::Tool,
                content,
                created_at,
                ImportedAgentMessageMetadata {
                    kind: Some("tool_result".to_string()),
                    tool_call_id: string_at_any(value, &["callId", "call_id", "id"]),
                    tool_name: string_at_any(value, &["name"]),
                    tool_status: Some(if failed { "failed" } else { "completed" }.to_string()),
                    raw_output,
                    ..message_metadata(AgentKind::Codebuddy, value)
                },
            )
            .into_iter()
            .collect()
        }
        _ => Vec::new(),
    }
}

fn decoded_json_value(value: &serde_json::Value) -> serde_json::Value {
    value
        .as_str()
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_else(|| value.clone())
}

fn content_value_text(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| content_from_blocks(value))
        .or_else(|| string_at_any(value, &["text", "content"]))
}

fn nonempty_message(
    role: ImportedAgentMessageRole,
    content: String,
    created_at: Option<DateTime<Utc>>,
    metadata: ImportedAgentMessageMetadata,
) -> Option<ImportedAgentMessage> {
    let content = jsonl::cap_history_text(content);
    (!content.trim().is_empty()).then_some(ImportedAgentMessage {
        role,
        content,
        created_at,
        metadata: ImportedAgentMessageMetadata {
            raw_input: metadata.raw_input.map(crate::conversation::cap_json_value),
            raw_output: metadata.raw_output.map(crate::conversation::cap_json_value),
            ..metadata
        },
    })
}

fn parse_jsonl_values(path: &Path, raw: &str) -> Result<Vec<serde_json::Value>, AgentHistoryError> {
    raw.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(index, line)| {
            serde_json::from_str(line.trim()).map_err(|error| AgentHistoryError::Parse {
                path: path.to_path_buf(),
                error: format!("line {}: {error}", index + 1),
            })
        })
        .collect()
}

fn parse_json_value(path: &Path, raw: &str) -> Result<serde_json::Value, AgentHistoryError> {
    serde_json::from_str(raw).map_err(|error| AgentHistoryError::Parse {
        path: path.to_path_buf(),
        error: error.to_string(),
    })
}

fn history_file_session_id(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("unknown")
        .to_string()
}

fn parse_jsonl_history(
    agent_type: AgentKind,
    path: &Path,
    raw: &str,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let mut sessions = Vec::new();
    for (index, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value = serde_json::from_str::<serde_json::Value>(trimmed).map_err(|error| {
            AgentHistoryError::Parse {
                path: path.to_path_buf(),
                error: format!("line {}: {error}", index + 1),
            }
        })?;
        if let Some(record) = imported_session_from_value(agent_type, path, &value) {
            sessions.push(record);
        }
    }
    Ok(sessions)
}

fn parse_json_history(
    agent_type: AgentKind,
    path: &Path,
    raw: &str,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let value = serde_json::from_str::<serde_json::Value>(raw).map_err(|error| {
        AgentHistoryError::Parse {
            path: path.to_path_buf(),
            error: error.to_string(),
        }
    })?;

    let values = value
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_else(|| std::slice::from_ref(&value));
    Ok(values
        .iter()
        .filter_map(|value| imported_session_from_value(agent_type, path, value))
        .collect())
}

fn imported_session_from_value(
    agent_type: AgentKind,
    path: &Path,
    value: &serde_json::Value,
) -> Option<ImportedAgentSession> {
    let (role, content) = message_from_value(agent_type, value)?;
    let external_session_id = session_id_from_value(agent_type, path, value);
    let title = string_at_any(value, &["title", "summary"])
        .or_else(|| (role == ImportedAgentMessageRole::User).then(|| title_from_content(&content)));
    let workspace_path =
        string_at_any(value, &["cwd", "workspace", "workspace_path"]).map(PathBuf::from);
    let created_at = timestamp_from_value(agent_type, value);

    Some(ImportedAgentSession {
        source_agent: agent_type,
        external_session_id,
        title,
        workspace_path,
        messages: vec![ImportedAgentMessage {
            role,
            content,
            created_at,
            metadata: message_metadata(agent_type, value),
        }],
        raw_source_path: Some(path.to_path_buf()),
    })
}

fn message_metadata(
    agent_type: AgentKind,
    value: &serde_json::Value,
) -> ImportedAgentMessageMetadata {
    let mut metadata = ImportedAgentMessageMetadata {
        model: string_at_any(value, &["model", "model_id"]),
        input_tokens: u32_at_any(value, &["input_tokens", "prompt_tokens"]),
        output_tokens: u32_at_any(value, &["output_tokens", "completion_tokens"]),
        cost: value
            .get("cost")
            .or_else(|| value.pointer("/usage/cost"))
            .and_then(serde_json::Value::as_f64),
        parent_session_id: string_at_any(value, &["parentSessionId", "parent_session_id"]),
        ..Default::default()
    };
    match agent_type {
        AgentKind::KimiCode => {
            if let Some(event) = value.get("event") {
                match event.get("type").and_then(serde_json::Value::as_str) {
                    Some("content.part")
                        if event
                            .pointer("/part/type")
                            .and_then(serde_json::Value::as_str)
                            == Some("think") =>
                    {
                        metadata.kind = Some("reasoning".to_string());
                    }
                    Some("tool.call") => {
                        metadata.kind = Some("tool_call".to_string());
                        metadata.tool_call_id = string_at_any(event, &["toolCallId", "id"]);
                        metadata.tool_name = string_at_any(event, &["name", "tool"]);
                        metadata.raw_input = event.get("args").cloned();
                    }
                    Some("tool.result") => {
                        metadata.kind = Some("tool_result".to_string());
                        metadata.tool_call_id = string_at_any(event, &["toolCallId", "id"]);
                        metadata.tool_status = Some("completed".to_string());
                        metadata.raw_output = event
                            .pointer("/result/output")
                            .or_else(|| event.get("result"))
                            .cloned();
                    }
                    _ => {}
                }
            }
        }
        AgentKind::Grok => {
            if let Some(update) = value.pointer("/params/update") {
                match update
                    .get("sessionUpdate")
                    .and_then(serde_json::Value::as_str)
                {
                    Some("agent_thought_chunk") => {
                        metadata.kind = Some("reasoning".to_string());
                    }
                    Some("tool_call") => {
                        metadata.kind = Some("tool_call".to_string());
                        metadata.tool_call_id = string_at_any(update, &["toolCallId", "id"]);
                        metadata.tool_name = update
                            .pointer("/_meta/x.ai~1tool/name")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                            .or_else(|| string_at_any(update, &["title"]));
                        metadata.raw_input = update.get("rawInput").cloned();
                    }
                    Some("tool_call_update") => {
                        metadata.kind = Some("tool_result".to_string());
                        metadata.tool_call_id = string_at_any(update, &["toolCallId", "id"]);
                        metadata.tool_status = string_at_any(update, &["status"]);
                        metadata.raw_output = update
                            .get("rawOutput")
                            .or_else(|| update.get("content"))
                            .cloned();
                    }
                    _ => {}
                }
            }
        }
        _ => {
            let kind = string_at_any(value, &["type", "kind"]);
            if matches!(kind.as_deref(), Some("reasoning" | "thinking" | "thought")) {
                metadata.kind = Some("reasoning".to_string());
            }
            metadata.tool_call_id = string_at_any(value, &["toolCallId", "tool_call_id"]);
            metadata.tool_name = string_at_any(value, &["tool", "tool_name", "name"]);
            metadata.tool_status = string_at_any(value, &["status"]);
            metadata.raw_input = value
                .get("rawInput")
                .or_else(|| value.get("input"))
                .cloned();
            metadata.raw_output = value
                .get("rawOutput")
                .or_else(|| value.get("output"))
                .cloned();
        }
    }
    metadata
}

fn message_from_value(
    agent_type: AgentKind,
    value: &serde_json::Value,
) -> Option<(ImportedAgentMessageRole, String)> {
    match agent_type {
        AgentKind::KimiCode => kimi_message(value),
        AgentKind::Grok => grok_message(value),
        _ => Some((role_from_value(value), content_from_value(value)?)),
    }
}

fn kimi_message(value: &serde_json::Value) -> Option<(ImportedAgentMessageRole, String)> {
    match value.get("type").and_then(serde_json::Value::as_str)? {
        "turn.prompt" => {
            let content = content_from_blocks(value.get("input")?)?;
            Some((ImportedAgentMessageRole::User, content))
        }
        "context.append_loop_event" => {
            let event = value.get("event")?;
            match event.get("type").and_then(serde_json::Value::as_str)? {
                "content.part" => {
                    let part = event.get("part")?;
                    let part_type = part.get("type").and_then(serde_json::Value::as_str)?;
                    let text = match part_type {
                        "text" => part.get("text"),
                        "think" => part.get("think"),
                        _ => None,
                    }
                    .and_then(serde_json::Value::as_str)?
                    .trim();
                    (!text.is_empty()).then(|| {
                        let content = if part_type == "think" {
                            format!("[reasoning]\n{text}")
                        } else {
                            text.to_string()
                        };
                        (ImportedAgentMessageRole::Assistant, content)
                    })
                }
                "tool.call" => {
                    let name = event
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("unknown");
                    let args = event.get("args").and_then(json_preview);
                    Some((
                        ImportedAgentMessageRole::Tool,
                        format!(
                            "[tool: {name}]{}",
                            args.map(|value| format!("\ninput: {value}"))
                                .unwrap_or_default()
                        ),
                    ))
                }
                "tool.result" => {
                    let id = event
                        .get("toolCallId")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("unknown");
                    let output = event
                        .pointer("/result/output")
                        .and_then(json_preview)
                        .unwrap_or_default();
                    Some((
                        ImportedAgentMessageRole::Tool,
                        format!("[tool result: {id}]\n{output}"),
                    ))
                }
                _ => None,
            }
        }
        _ => None,
    }
}

fn grok_message(value: &serde_json::Value) -> Option<(ImportedAgentMessageRole, String)> {
    let update = value.pointer("/params/update")?;
    let kind = update
        .get("sessionUpdate")
        .and_then(serde_json::Value::as_str)?;
    if kind == "user_message_chunk"
        && update
            .pointer("/_meta/hideFromScrollback")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    {
        return None;
    }
    match kind {
        "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" => {
            let text = update
                .pointer("/content/text")
                .and_then(serde_json::Value::as_str)?
                .trim();
            if text.is_empty() {
                return None;
            }
            let role = if kind == "user_message_chunk" {
                ImportedAgentMessageRole::User
            } else {
                ImportedAgentMessageRole::Assistant
            };
            let content = if kind == "agent_thought_chunk" {
                format!("[reasoning]\n{text}")
            } else {
                text.to_string()
            };
            Some((role, content))
        }
        "tool_call" => {
            let name = update
                .pointer("/_meta/x.ai~1tool/name")
                .or_else(|| update.get("title"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown");
            let input = update.get("rawInput").and_then(json_preview);
            Some((
                ImportedAgentMessageRole::Tool,
                format!(
                    "[tool: {name}]{}",
                    input
                        .map(|value| format!("\ninput: {value}"))
                        .unwrap_or_default()
                ),
            ))
        }
        "tool_call_update" => {
            let id = update
                .get("toolCallId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown");
            let status = update
                .get("status")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("updated");
            let output = update
                .get("rawOutput")
                .or_else(|| update.get("content"))
                .and_then(json_preview);
            Some((
                ImportedAgentMessageRole::Tool,
                format!(
                    "[tool result: {id}] {status}{}",
                    output.map(|value| format!("\n{value}")).unwrap_or_default()
                ),
            ))
        }
        _ => None,
    }
}

fn session_id_from_value(agent_type: AgentKind, path: &Path, value: &serde_json::Value) -> String {
    string_at_any(value, &["sessionId", "session_id", "conversation_id", "id"])
        .or_else(|| {
            value
                .get("params")
                .and_then(|params| string_at_any(params, &["sessionId", "session_id"]))
        })
        .or_else(|| match agent_type {
            AgentKind::KimiCode => path
                .ancestors()
                .nth(3)
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                .map(str::to_string),
            AgentKind::Grok | AgentKind::DeepseekHarness => path
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                .map(str::to_string),
            _ => None,
        })
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("unknown")
                .to_string()
        })
}

fn timestamp_from_value(agent_type: AgentKind, value: &serde_json::Value) -> Option<DateTime<Utc>> {
    if let Some(timestamp) = string_at_any(value, &["timestamp", "created_at", "createdAt"])
        .and_then(|raw| parse_timestamp_string(&raw))
    {
        return Some(timestamp);
    }
    let numeric = match agent_type {
        AgentKind::KimiCode => numeric_timestamp(value.get("time")),
        AgentKind::Grok | AgentKind::Codex => numeric_timestamp(value.get("timestamp")),
        _ => numeric_timestamp(value.get("timestamp")),
    }?;
    datetime_from_epoch(numeric)
}

fn parse_timestamp_string(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f")
                .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S"))
                .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f"))
                .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S"))
                .ok()
                .map(|timestamp| timestamp.and_utc())
        })
}

fn numeric_timestamp(value: Option<&serde_json::Value>) -> Option<i64> {
    let value = value?;
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_f64().map(|number| number as i64))
}

fn datetime_from_epoch(numeric: i64) -> Option<DateTime<Utc>> {
    if numeric.abs() >= 1_000_000_000_000 {
        DateTime::from_timestamp_millis(numeric)
    } else {
        DateTime::from_timestamp(numeric, 0)
    }
}

pub(super) fn title_from_content(content: &str) -> String {
    let line = content.lines().next().unwrap_or(content).trim();
    let mut chars = line.chars();
    let title = chars.by_ref().take(80).collect::<String>();
    if chars.next().is_some() {
        format!("{title}…")
    } else {
        title
    }
}

fn read_zstd_jsonl(path: &Path) -> Result<String, AgentHistoryError> {
    let bytes = std::fs::read(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    let decoded = zstd::decode_all(bytes.as_slice()).map_err(|error| AgentHistoryError::Parse {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    Ok(String::from_utf8_lossy(&decoded).into_owned())
}

fn apply_grok_summary(session: &mut ImportedAgentSession) -> bool {
    let Some(session_dir) = session
        .raw_source_path
        .as_ref()
        .and_then(|path| path.parent())
    else {
        return true;
    };
    let Ok(raw) = std::fs::read_to_string(session_dir.join("summary.json")) else {
        return true;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return true;
    };
    if value
        .get("session_kind")
        .and_then(serde_json::Value::as_str)
        == Some("subagent")
    {
        return false;
    }
    if session.workspace_path.is_none() {
        session.workspace_path = value
            .pointer("/info/cwd")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
    }
    if let Some(title) = string_at_any(&value, &["generated_title", "session_summary"]) {
        session.title = Some(title);
    }
    if session
        .messages
        .iter()
        .all(|message| message.created_at.is_none())
    {
        let created = value
            .get("created_at")
            .and_then(serde_json::Value::as_str)
            .and_then(parse_timestamp_string);
        let updated = value
            .get("updated_at")
            .and_then(serde_json::Value::as_str)
            .and_then(parse_timestamp_string);
        if let Some(timestamp) = updated.or(created) {
            for message in &mut session.messages {
                message.created_at = Some(timestamp);
            }
        }
    }
    true
}

fn apply_grok_ask_answers(session: &mut ImportedAgentSession) {
    let Some(session_dir) = session
        .raw_source_path
        .as_ref()
        .and_then(|path| path.parent())
    else {
        return;
    };
    let ask_ids = session
        .messages
        .iter()
        .filter(|message| {
            message.metadata.kind.as_deref() == Some("tool_call")
                && message.metadata.tool_name.as_deref() == Some("ask_user_question")
        })
        .filter_map(|message| message.metadata.tool_call_id.clone())
        .collect::<BTreeSet<_>>();
    if ask_ids.is_empty() {
        return;
    }
    let answers = read_grok_ask_answers(&session_dir.join("chat_history.jsonl"), &ask_ids);
    if answers.is_empty() {
        return;
    }
    let mut filled = BTreeSet::new();
    for message in &mut session.messages {
        if message.metadata.kind.as_deref() != Some("tool_result") {
            continue;
        }
        let Some(id) = message.metadata.tool_call_id.as_deref() else {
            continue;
        };
        let Some(envelope) = answers.get(id) else {
            continue;
        };
        message.content = envelope.clone();
        message.metadata.tool_status = Some("completed".to_string());
        message.metadata.raw_output = serde_json::from_str(envelope).ok();
        filled.insert(id.to_string());
    }
    let mut extras = Vec::new();
    for (index, message) in session.messages.iter().enumerate() {
        if message.metadata.kind.as_deref() != Some("tool_call") {
            continue;
        }
        let Some(id) = message.metadata.tool_call_id.clone() else {
            continue;
        };
        if filled.contains(&id) {
            continue;
        }
        let Some(envelope) = answers.get(&id) else {
            continue;
        };
        extras.push((
            index + 1,
            ImportedAgentMessage {
                role: ImportedAgentMessageRole::Tool,
                content: envelope.clone(),
                created_at: message.created_at,
                metadata: ImportedAgentMessageMetadata {
                    kind: Some("tool_result".to_string()),
                    tool_call_id: Some(id),
                    tool_name: message.metadata.tool_name.clone(),
                    tool_status: Some("completed".to_string()),
                    raw_output: serde_json::from_str(envelope).ok(),
                    ..Default::default()
                },
            },
        ));
    }
    for (offset, (index, extra)) in extras.into_iter().enumerate() {
        session.messages.insert(index + offset, extra);
    }
}

fn read_grok_ask_answers(path: &Path, ask_ids: &BTreeSet<String>) -> BTreeMap<String, String> {
    let mut answers = BTreeMap::new();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return answers;
    };
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if value.get("type").and_then(serde_json::Value::as_str) != Some("tool_result") {
            continue;
        }
        let Some(id) = value
            .get("tool_call_id")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        if !ask_ids.contains(id) {
            continue;
        }
        let content = value
            .get("content")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if let Some(envelope) = grok_history_answer_to_envelope(content) {
            answers.insert(id.to_string(), envelope.to_string());
        }
    }
    answers
}

fn grok_history_answer_to_envelope(content: &str) -> Option<serde_json::Value> {
    let content = content.trim();
    if content.starts_with("The user has indicated they have provided enough answers")
        || content.contains("(No answer provided)")
    {
        return Some(serde_json::json!({ "answers": [], "declined": true }));
    }
    if !content.starts_with("User has answered your questions:") {
        return None;
    }
    let tokens: Vec<&str> = content.split('"').collect();
    let mut answers = Vec::new();
    let mut index = 1;
    while index + 2 < tokens.len() {
        if tokens[index + 1] != "=" {
            break;
        }
        let selected = tokens[index + 2]
            .split(", ")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        answers.push(serde_json::json!({
            "header": "",
            "question": tokens[index],
            "selected": selected,
        }));
        index += 4;
    }
    (!answers.is_empty()).then(|| serde_json::json!({ "answers": answers, "declined": false }))
}

fn apply_codex_session_index_title(
    session: &mut ImportedAgentSession,
    titles: &mut BTreeMap<PathBuf, BTreeMap<String, String>>,
) {
    let Some(index_path) = session
        .raw_source_path
        .as_ref()
        .and_then(|path| codex_session_index_path(path))
    else {
        return;
    };
    let index = titles
        .entry(index_path.clone())
        .or_insert_with(|| load_codex_session_index(&index_path));
    if let Some(title) = index.get(&session.external_session_id) {
        session.title = Some(title.clone());
    }
}

fn codex_session_index_path(rollout: &Path) -> Option<PathBuf> {
    for ancestor in rollout.ancestors() {
        let name = ancestor.file_name()?.to_str()?;
        if name == "sessions" || name == "archived_sessions" {
            return Some(ancestor.parent()?.join("session_index.jsonl"));
        }
    }
    None
}

fn load_codex_session_index(path: &Path) -> BTreeMap<String, String> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let mut titles = BTreeMap::new();
    for line in raw.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(id) = value.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(title) = value
            .get("thread_name")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
        else {
            continue;
        };
        titles.insert(id.to_string(), title.to_string());
    }
    titles
}

fn strip_openclaw_user_text(text: &str) -> String {
    let mut text = text.trim_start();
    if let Some(rest) = text.strip_prefix("Sender (untrusted metadata):")
        && let Some(after_open) = rest.find("```").map(|index| &rest[index + 3..])
        && let Some(after_close) = after_open.find("```").map(|index| &after_open[index + 3..])
    {
        text = after_close.trim_start();
    }
    while let Some(inner) = text.strip_prefix('[').and_then(|rest| {
        rest.find(']')
            .map(|end| (&rest[..end], rest[end + 1..].trim_start()))
    }) {
        let (label, rest) = inner;
        if label.starts_with("Working directory:")
            || label.chars().any(|ch| ch.is_ascii_digit()) && label.contains(':')
        {
            text = rest;
            continue;
        }
        break;
    }
    text.to_string()
}

fn openclaw_working_dir(text: &str) -> Option<PathBuf> {
    let start = text.find("[Working directory:")?;
    let rest = &text[start + "[Working directory:".len()..];
    let end = rest.find(']')?;
    let path = rest[..end].trim();
    (!path.is_empty()).then(|| {
        if path.starts_with('~') {
            expand_configured_history_path(PathBuf::from(path), dirs::home_dir().as_deref())
        } else {
            PathBuf::from(path)
        }
    })
}

fn pi_bash_execution_messages(
    value: &serde_json::Value,
    index: usize,
) -> Vec<ImportedAgentMessage> {
    let command = value
        .get("command")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let output = value
        .get("output")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let exit_code = value
        .get("exitCode")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let created_at = timestamp_from_value(AgentKind::Pi, value);
    let tool_call_id = value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(|id| format!("bash-{id}"))
        .unwrap_or_else(|| format!("bash-{index}"));
    vec![
        ImportedAgentMessage {
            role: ImportedAgentMessageRole::Tool,
            content: format!("[tool: bash]\ninput: {command}"),
            created_at,
            metadata: ImportedAgentMessageMetadata {
                kind: Some("tool_call".to_string()),
                tool_call_id: Some(tool_call_id.clone()),
                tool_name: Some("bash".to_string()),
                raw_input: Some(serde_json::json!({ "command": command })),
                ..Default::default()
            },
        },
        ImportedAgentMessage {
            role: ImportedAgentMessageRole::Tool,
            content: output.to_string(),
            created_at,
            metadata: ImportedAgentMessageMetadata {
                kind: Some("tool_result".to_string()),
                tool_call_id: Some(tool_call_id),
                tool_name: Some("bash".to_string()),
                tool_status: Some(
                    if exit_code == 0 {
                        "completed"
                    } else {
                        "failed"
                    }
                    .to_string(),
                ),
                raw_output: Some(serde_json::Value::String(output.to_string())),
                ..Default::default()
            },
        },
    ]
}

fn apply_kimi_workspace(
    root: &Path,
    session: &mut ImportedAgentSession,
    cache: &mut Option<BTreeMap<String, PathBuf>>,
) {
    let workspaces = cache.get_or_insert_with(|| {
        let Some(home) = root.parent() else {
            return BTreeMap::new();
        };
        let Ok(raw) = std::fs::read_to_string(home.join("session_index.jsonl")) else {
            return BTreeMap::new();
        };
        raw.lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter_map(|value| {
                let id = value.get("sessionId")?.as_str()?.to_string();
                let work_dir = value.get("workDir")?.as_str()?.trim().to_string();
                (!work_dir.is_empty()).then_some((id, PathBuf::from(work_dir)))
            })
            .collect()
    });
    if let Some(workspace) = workspaces.get(&session.external_session_id) {
        session.workspace_path = Some(workspace.clone());
    }
}

fn json_preview(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| serde_json::to_string(value).ok())
}

fn role_from_value(value: &serde_json::Value) -> ImportedAgentMessageRole {
    let role = value
        .get("role")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| string_at_any(message, &["role", "type"]))
        })
        // Envelope types such as `message` are not roles. Only consult the
        // outer type after the nested message has had a chance to identify it.
        .or_else(|| {
            value
                .get("type")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
        .to_ascii_lowercase();
    match role.as_str() {
        "user" | "human" => ImportedAgentMessageRole::User,
        "assistant" | "agent" => ImportedAgentMessageRole::Assistant,
        "system" => ImportedAgentMessageRole::System,
        "tool" | "tool_result" | "tool_use" => ImportedAgentMessageRole::Tool,
        _ => ImportedAgentMessageRole::Unknown,
    }
}

fn content_from_value(value: &serde_json::Value) -> Option<String> {
    string_at_any(value, &["content", "text", "message"])
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| string_at_any(message, &["content", "text"]))
        })
        .or_else(|| {
            value
                .get("item")
                .and_then(|item| string_at_any(item, &["content", "text"]))
        })
        .or_else(|| content_from_blocks(value.get("content")?))
}

fn content_from_blocks(value: &serde_json::Value) -> Option<String> {
    let parts = value
        .as_array()?
        .iter()
        .filter_map(block_text)
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn block_text(item: &serde_json::Value) -> Option<String> {
    if let Some(text) =
        string_at_any(item, &["text", "content"]).filter(|text| !text.trim().is_empty())
    {
        return Some(text);
    }
    match item.get("type").and_then(serde_json::Value::as_str) {
        Some("image") | Some("image_url") => Some(image_placeholder(item)),
        _ => None,
    }
}

fn image_placeholder(item: &serde_json::Value) -> String {
    let attachment = item.get("attachment").unwrap_or(item);
    let label = string_at_any(attachment, &["name", "mediaType", "mime_type", "mime"])
        .or_else(|| string_at_any(item, &["name", "mediaType", "mime_type", "filename"]))
        .unwrap_or_else(|| "image".to_string());
    format!("[image: {label}]")
}

fn first_explicit_title(values: &[serde_json::Value], keys: &[&str]) -> Option<String> {
    values.iter().find_map(|value| {
        string_at_any(value, keys).filter(|title| !title.trim().is_empty() && title != "/compact")
    })
}

fn string_at_any(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|value| match value {
            serde_json::Value::String(value) => Some(value.clone()),
            serde_json::Value::Array(_) => content_from_blocks(value),
            serde_json::Value::Object(_) => None,
            serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {
                None
            }
        })
}

fn u32_at_any(value: &serde_json::Value, keys: &[&str]) -> Option<u32> {
    keys.iter()
        .find_map(|key| {
            value
                .get(*key)
                .or_else(|| value.get("usage").and_then(|usage| usage.get(*key)))
                .and_then(serde_json::Value::as_u64)
        })
        .and_then(|value| u32::try_from(value).ok())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures")
            .join("history")
            .join(name)
    }

    #[test]
    fn default_sources_cover_every_registry_agent() {
        for agent_type in [
            AgentKind::ClaudeCode,
            AgentKind::Codex,
            AgentKind::Opencode,
            AgentKind::Antigravity,
            AgentKind::Openclaw,
            AgentKind::Cline,
            AgentKind::Hermes,
            AgentKind::Codebuddy,
            AgentKind::KimiCode,
            AgentKind::Pi,
            AgentKind::Grok,
            AgentKind::Cursor,
            AgentKind::DeepseekHarness,
            AgentKind::Qoder,
        ] {
            assert!(
                !default_history_sources(agent_type).is_empty(),
                "missing history source for {agent_type:?}"
            );
        }
    }

    #[test]
    fn nested_message_role_wins_over_generic_envelope_type() {
        let value = serde_json::json!({
            "type": "message",
            "message": {
                "role": "assistant",
                "content": "nested reply"
            }
        });

        assert_eq!(role_from_value(&value), ImportedAgentMessageRole::Assistant);
    }

    #[cfg(unix)]
    #[test]
    fn saved_history_home_is_scanned_before_process_defaults() {
        let sources = configured_history_sources(
            AgentKind::Pi,
            &HashMap::from([(
                "PI_CODING_AGENT_SESSION_DIR".to_string(),
                "/tmp/pi-custom-sessions".to_string(),
            )]),
        );

        assert_eq!(
            sources.first().map(|source| source.path.as_path()),
            Some(Path::new("/tmp/pi-custom-sessions"))
        );
    }

    #[test]
    fn saved_tilde_history_home_expands_against_the_user_home() {
        let expected = dirs::home_dir().unwrap().join("profiles/pi/sessions");
        let sources = configured_history_sources(
            AgentKind::Pi,
            &HashMap::from([(
                "PI_CODING_AGENT_SESSION_DIR".to_string(),
                "~/profiles/pi/sessions".to_string(),
            )]),
        );

        assert_eq!(
            sources.first().map(|source| source.path.clone()),
            Some(expected)
        );
    }

    #[cfg(unix)]
    #[test]
    fn configured_codeg_history_roots_keep_each_cli_directory_contract() {
        let antigravity = configured_history_sources(
            AgentKind::Antigravity,
            &HashMap::from([(
                "GEMINI_HOME".to_string(),
                "/profiles/google/.gemini".to_string(),
            )]),
        );
        assert_eq!(
            antigravity[0].path,
            PathBuf::from("/profiles/google/.gemini/antigravity-acp/conversations")
        );

        let cline = configured_history_sources(
            AgentKind::Cline,
            &HashMap::from([("CLINE_DIR".to_string(), "/profiles/cline".to_string())]),
        );
        assert_eq!(cline[0].path, PathBuf::from("/profiles/cline/tasks"));

        let codebuddy = configured_history_sources(
            AgentKind::Codebuddy,
            &HashMap::from([(
                "CODEBUDDY_CONFIG_DIR".to_string(),
                "/profiles/codebuddy".to_string(),
            )]),
        );
        assert_eq!(
            codebuddy[0].path,
            PathBuf::from("/profiles/codebuddy/projects")
        );

        let qoder = configured_history_sources(
            AgentKind::Qoder,
            &HashMap::from([(
                "QODER_CONFIG_DIR".to_string(),
                "/profiles/qoder".to_string(),
            )]),
        );
        assert_eq!(qoder[0].path, PathBuf::from("/profiles/qoder/projects"));
    }

    #[test]
    fn qoder_custom_title_outranks_ai_title() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"read NOTES.md"},"sessionId":"s1"}"#,
                "\n",
                r#"{"type":"ai-title","sessionId":"s1","aiTitle":"Reading project notes"}"#,
                "\n",
                r#"{"type":"custom-title","sessionId":"s1","customTitle":"notes probe"}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = parse_history_file(AgentKind::Qoder, &path).unwrap();
        assert_eq!(sessions[0].title.as_deref(), Some("notes probe"));
    }

    #[cfg(unix)]
    #[test]
    fn generic_history_scan_does_not_follow_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("session.json"),
            r#"{"session_id":"safe","role":"user","content":"hello"}"#,
        )
        .unwrap();
        symlink(temp.path(), temp.path().join("loop")).unwrap();
        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::ClaudeCode,
            path: temp.path().to_path_buf(),
        })
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "safe");
    }

    #[test]
    fn imports_claude_jsonl_fixture() {
        let source = AgentHistorySource {
            agent_type: AgentKind::ClaudeCode,
            path: fixture_path("claude-projects"),
        };

        let sessions = import_history_source(&source).unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "claude-session-1");
        assert_eq!(sessions[0].workspace_path, Some(PathBuf::from("C:/repo")));
        assert_eq!(sessions[0].messages.len(), 2);
        assert_eq!(sessions[0].messages[0].role, ImportedAgentMessageRole::User);
        assert_eq!(
            sessions[0].messages[1].role,
            ImportedAgentMessageRole::Assistant
        );
    }

    #[test]
    fn imports_claude_reasoning_and_tool_blocks_as_independent_events() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("claude-blocks.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","sessionId":"claude-blocks","cwd":"/workspace/claude","message":{"role":"user","content":"Inspect it"}}"#,
                "\n",
                r#"{"type":"assistant","sessionId":"claude-blocks","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Read first"},{"type":"tool_use","id":"tool-1","name":"Read","input":{"path":"Cargo.toml"}},{"type":"text","text":"Done"}]}}"#,
                "\n",
                r#"{"type":"user","sessionId":"claude-blocks","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"workspace"}]}}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::ClaudeCode,
            path,
        })
        .unwrap();

        assert_eq!(sessions[0].messages.len(), 5);
        assert_eq!(
            sessions[0].messages[1].metadata.kind.as_deref(),
            Some("reasoning")
        );
        assert_eq!(
            sessions[0].messages[2].metadata.tool_call_id.as_deref(),
            Some("tool-1")
        );
        assert_eq!(
            sessions[0].messages[4].metadata.kind.as_deref(),
            Some("tool_result")
        );
    }

    #[test]
    fn imports_codex_json_fixture() {
        let source = AgentHistorySource {
            agent_type: AgentKind::Codex,
            path: fixture_path("codex-sessions"),
        };

        let sessions = import_history_source(&source).unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "codex-session-1");
        assert_eq!(sessions[0].messages[0].content, "Inspect the repo");
        assert_eq!(
            sessions[0].messages[0].created_at,
            Some(
                DateTime::parse_from_rfc3339("2026-06-11T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc)
            )
        );
    }

    #[test]
    fn parse_codex_rollout_keeps_envelope_and_unix_timestamps() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"timestamp":"2026-04-02T08:00:00Z","type":"session_meta","payload":{"id":"codex-rollout","cwd":"/tmp/codex"}}"#,
                "\n",
                r#"{"timestamp":1712044800,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}"#,
                "\n",
                r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}],"timestamp":"2026-04-02T08:01:00Z"}}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Codex,
            path,
        })
        .unwrap();
        let times = sessions[0].activity_times().expect("activity times");
        assert_eq!(times.0, DateTime::from_timestamp(1_712_044_800, 0).unwrap());
        assert_eq!(
            times.1,
            DateTime::parse_from_rfc3339("2026-04-02T08:01:00Z")
                .unwrap()
                .with_timezone(&Utc)
        );
    }

    #[test]
    fn load_configured_history_session_reads_only_the_requested_rollout() {
        let temp = tempfile::tempdir().unwrap();
        let sessions_dir = temp.path().join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        std::fs::write(
            sessions_dir.join("keep.jsonl"),
            concat!(
                r#"{"type":"session_meta","payload":{"id":"keep-me","cwd":"/keep"}}"#,
                "\n",
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"keep"}]}}"#,
                "\n"
            ),
        )
        .unwrap();
        std::fs::write(sessions_dir.join("zz-skip.jsonl"), "not-json").unwrap();
        let env = HashMap::from([(
            "CODEX_HOME".to_string(),
            temp.path().to_string_lossy().into_owned(),
        )]);

        let session =
            crate::load_configured_history_session(AgentKind::Codex, &env, "keep-me").unwrap();
        assert_eq!(session.external_session_id, "keep-me");
        assert_eq!(session.messages[0].content, "keep");
        assert!(crate::load_configured_history_session(AgentKind::Codex, &env, "missing").is_err());
    }

    #[test]
    fn skips_oversized_codex_jsonl_lines_without_dropping_the_session() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout-huge.jsonl");
        let huge = "x".repeat(jsonl::MAX_HISTORY_LINE_BYTES + 8);
        std::fs::write(
            &path,
            format!(
                "{}\n{huge}\n{}\n",
                r#"{"timestamp":"2026-08-01T00:00:00Z","type":"session_meta","payload":{"id":"codex-huge-1","cwd":"/workspace/codex"}}"#,
                r#"{"timestamp":"2026-08-01T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Keep me"}]}}"#,
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Codex,
            path,
        })
        .unwrap();

        assert_eq!(sessions[0].external_session_id, "codex-huge-1");
        assert_eq!(sessions[0].messages.len(), 1);
        assert_eq!(sessions[0].messages[0].content, "Keep me");
    }

    #[test]
    fn imports_codex_rollout_event_envelopes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout-2026.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"timestamp":"2026-08-01T00:00:00Z","type":"session_meta","payload":{"id":"codex-rollout-1","cwd":"/workspace/codex"}}"#,
                "\n",
                r#"{"timestamp":"2026-08-01T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Inspect the rollout"}]}}"#,
                "\n",
                r#"{"timestamp":"2026-08-01T00:00:02Z","type":"event_msg","payload":{"type":"agent_message","message":"Inspection complete"}}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Codex,
            path,
        })
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "codex-rollout-1");
        assert_eq!(
            sessions[0].workspace_path,
            Some(PathBuf::from("/workspace/codex"))
        );
        assert_eq!(sessions[0].messages.len(), 2);
        assert_eq!(
            sessions[0].messages[1].role,
            ImportedAgentMessageRole::Assistant
        );
    }

    #[test]
    fn codex_title_skips_injected_recommended_plugins_context() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout-with-context.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"session_meta","payload":{"id":"codex-context-1"}}"#,
                "\n",
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<recommended_plugins>\n- GitHub\n</recommended_plugins>\n# AGENTS.md instructions"}]}}"#,
                "\n",
                r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# Files mentioned by the user:\n\n- picker.png\n\n## My request:\nFix the previous-session picker"}]}}"##,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"agent_message","message":"Done"}}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Codex,
            path,
        })
        .unwrap();

        assert_eq!(
            sessions[0].title.as_deref(),
            Some("Fix the previous-session picker")
        );
        assert_eq!(sessions[0].messages.len(), 2);
    }

    #[test]
    fn imports_openclaw_transcripts() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("openclaw-session.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"message","timestamp":"2026-08-01T00:00:00Z","message":{"role":"user","content":[{"type":"text","text":"Open the claw"}]}}"#,
                "\n",
                r#"{"type":"message","timestamp":"2026-08-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"Done"}]}}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Openclaw,
            path,
        })
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "openclaw-session");
        assert_eq!(sessions[0].messages.len(), 2);
    }

    #[test]
    fn imports_openclaw_thinking_tool_calls_and_results() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("openclaw-tools.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"session","id":"openclaw-tools","cwd":"/workspace/claw"}"#,
                "\n",
                r#"{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Need a file"},{"type":"toolCall","id":"call-1","name":"read","arguments":{"file_path":"a.txt"}}]}}"#,
                "\n",
                r#"{"type":"message","message":{"role":"toolResult","toolCallId":"call-1","toolName":"read","content":[{"type":"text","text":"contents"}],"isError":false}}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Openclaw,
            path,
        })
        .unwrap();

        assert_eq!(sessions[0].external_session_id, "openclaw-tools");
        assert_eq!(sessions[0].messages.len(), 3);
        assert_eq!(
            sessions[0].messages[0].metadata.kind.as_deref(),
            Some("reasoning")
        );
        assert_eq!(
            sessions[0].messages[1].metadata.tool_name.as_deref(),
            Some("read")
        );
        assert_eq!(
            sessions[0].messages[2].metadata.tool_status.as_deref(),
            Some("completed")
        );
    }

    #[test]
    fn imports_cline_task_history_with_the_task_directory_as_session_id() {
        let temp = tempfile::tempdir().unwrap();
        let task = temp.path().join("tasks/task-42");
        std::fs::create_dir_all(&task).unwrap();
        std::fs::write(
            task.join("api_conversation_history.json"),
            r#"[{"role":"user","content":"Fix the task"},{"role":"assistant","content":"Task fixed"}]"#,
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Cline,
            path: temp.path().join("tasks"),
        })
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "task-42");
        assert_eq!(sessions[0].messages.len(), 2);
    }

    #[test]
    fn imports_codebuddy_project_history() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("codebuddy.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"sessionId":"codebuddy-1","message":{"role":"user","content":"Buddy up"}}"#,
                "\n",
                r#"{"sessionId":"codebuddy-1","message":{"role":"assistant","content":"Ready"}}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Codebuddy,
            path,
        })
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "codebuddy-1");
        assert_eq!(sessions[0].messages.len(), 2);
    }

    #[test]
    fn imports_codebuddy_reasoning_and_function_events() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("codebuddy-tools.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"message","role":"user","sessionId":"buddy-tools","cwd":"/workspace/buddy","content":[{"type":"input_text","text":"Run build"}]}"#,
                "\n",
                r#"{"type":"reasoning","sessionId":"buddy-tools","rawContent":[{"type":"reasoning_text","text":"Check package scripts"}]}"#,
                "\n",
                r#"{"type":"function_call","sessionId":"buddy-tools","name":"Bash","callId":"call-1","arguments":"{\"command\":\"pnpm build\"}"}"#,
                "\n",
                r#"{"type":"function_call_result","sessionId":"buddy-tools","name":"Bash","callId":"call-1","status":"completed","output":{"type":"text","text":"Error: failed"},"providerData":{"toolResult":{"content":"Error: failed","error":"failed"}}}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Codebuddy,
            path,
        })
        .unwrap();

        assert_eq!(sessions[0].messages.len(), 4);
        assert_eq!(
            sessions[0].messages[1].metadata.kind.as_deref(),
            Some("reasoning")
        );
        assert_eq!(
            sessions[0].messages[2].metadata.raw_input,
            Some(serde_json::json!({"command": "pnpm build"}))
        );
        assert_eq!(
            sessions[0].messages[3].metadata.tool_status.as_deref(),
            Some("failed")
        );
        assert!(sessions[0].messages[3].metadata.raw_output.is_some());
    }

    #[test]
    fn imports_pi_session_headers_and_messages() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("pi-session.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"session","id":"pi-1","cwd":"/workspace/pi","timestamp":"2026-08-01T00:00:00Z"}"#,
                "\n",
                r#"{"type":"message","timestamp":"2026-08-01T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"Run Pi"}]}}"#,
                "\n",
                r#"{"type":"message","timestamp":"2026-08-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"Pi complete"}]}}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Pi,
            path,
        })
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "pi-1");
        assert_eq!(
            sessions[0].workspace_path,
            Some(PathBuf::from("/workspace/pi"))
        );
        assert_eq!(sessions[0].messages.len(), 2);
    }

    #[test]
    fn rejects_corrupt_jsonl_fixture() {
        let source = AgentHistorySource {
            agent_type: AgentKind::ClaudeCode,
            path: fixture_path("corrupt-jsonl"),
        };

        let error = import_history_source(&source).unwrap_err();

        assert!(matches!(error, AgentHistoryError::Parse { .. }));
    }

    #[test]
    fn imports_kimi_event_stream_and_workspace_index() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join(".kimi-code");
        let sessions_root = home.join("sessions");
        let wire = sessions_root
            .join("bucket")
            .join("kimi-session")
            .join("agents")
            .join("main")
            .join("wire.jsonl");
        std::fs::create_dir_all(wire.parent().unwrap()).unwrap();
        std::fs::write(
            &wire,
            concat!(
                r#"{"type":"turn.prompt","input":[{"type":"text","text":"Build the app"}],"time":1782276649227}"#,
                "\n",
                r#"{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"think","think":"Checking first"}},"time":1782276650000}"#,
                "\n",
                r#"{"type":"context.append_loop_event","event":{"type":"tool.call","toolCallId":"Bash_0","name":"Bash","args":{"command":"pnpm build"}},"time":1782276651425}"#,
                "\n",
                r#"{"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"Bash_0","result":{"output":"success"}},"time":1782276660973}"#,
                "\n",
                r#"{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"Build passed."}},"time":1782276664343}"#,
                "\n"
            ),
        )
        .unwrap();
        std::fs::write(
            home.join("session_index.jsonl"),
            r#"{"sessionId":"kimi-session","workDir":"/workspace/kimi"}"#,
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::KimiCode,
            path: sessions_root,
        })
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "kimi-session");
        assert_eq!(
            sessions[0].workspace_path,
            Some(PathBuf::from("/workspace/kimi"))
        );
        assert_eq!(sessions[0].messages.len(), 5);
        assert_eq!(sessions[0].messages[0].role, ImportedAgentMessageRole::User);
        assert_eq!(
            sessions[0].messages[4].role,
            ImportedAgentMessageRole::Assistant
        );
        assert!(sessions[0].messages[2].content.contains("pnpm build"));
        assert_eq!(
            sessions[0].messages[1].metadata.kind.as_deref(),
            Some("reasoning")
        );
        assert_eq!(
            sessions[0].messages[2].metadata.tool_call_id.as_deref(),
            Some("Bash_0")
        );
        assert_eq!(
            sessions[0].messages[2].metadata.tool_name.as_deref(),
            Some("Bash")
        );
        assert_eq!(
            sessions[0].messages[3].metadata.raw_output,
            Some(serde_json::Value::String("success".to_string()))
        );
    }

    #[test]
    fn imports_grok_acp_update_stream() {
        let temp = tempfile::tempdir().unwrap();
        let session_dir = temp.path().join("sessions").join("grok-session");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(
            session_dir.join("updates.jsonl"),
            concat!(
                r#"{"method":"session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Run tests"}}},"timestamp":1783584019}"#,
                "\n",
                r#"{"method":"session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hidden reminder"},"_meta":{"hideFromScrollback":true}}},"timestamp":1783584020}"#,
                "\n",
                r#"{"method":"session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"I should inspect first"}}},"timestamp":1783584021}"#,
                "\n",
                r#"{"method":"session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"run_terminal_command","rawInput":{"command":"pnpm test"}}},"timestamp":1783584022}"#,
                "\n",
                r#"{"method":"session/update","params":{"sessionId":"grok-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Tests passed."}}},"timestamp":1783584024}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Grok,
            path: temp.path().join("sessions"),
        })
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "grok-session");
        assert_eq!(sessions[0].messages.len(), 4);
        assert_eq!(sessions[0].messages[0].content, "Run tests");
        assert_eq!(sessions[0].messages[2].role, ImportedAgentMessageRole::Tool);
        assert_eq!(sessions[0].messages[3].content, "Tests passed.");
        assert_eq!(
            sessions[0].messages[1].metadata.kind.as_deref(),
            Some("reasoning")
        );
        assert_eq!(
            sessions[0].messages[2].metadata.tool_call_id.as_deref(),
            Some("call-1")
        );
        assert_eq!(
            sessions[0].messages[2].metadata.tool_name.as_deref(),
            Some("run_terminal_command")
        );
    }

    #[test]
    fn grok_summary_json_supplies_cwd_and_skips_subagents() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp
            .path()
            .join("sessions")
            .join("encoded-cwd")
            .join("parent-session");
        let child = temp
            .path()
            .join("sessions")
            .join("encoded-cwd")
            .join("child-session");
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(
            parent.join("updates.jsonl"),
            r#"{"method":"session/update","params":{"sessionId":"parent-session","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Parent prompt"}}},"timestamp":1783584019}"#,
        )
        .unwrap();
        std::fs::write(
            parent.join("summary.json"),
            r#"{"session_kind":"primary","generated_title":"Parent work","info":{"cwd":"/Users/mac/Projects/VibeX"}}"#,
        )
        .unwrap();
        std::fs::write(
            child.join("updates.jsonl"),
            r#"{"method":"session/update","params":{"sessionId":"child-session","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Child prompt"}}},"timestamp":1783584019}"#,
        )
        .unwrap();
        std::fs::write(
            child.join("summary.json"),
            r#"{"session_kind":"subagent","generated_title":"Child"}"#,
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Grok,
            path: temp.path().join("sessions"),
        })
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "parent-session");
        assert_eq!(sessions[0].title.as_deref(), Some("Parent work"));
        assert_eq!(
            sessions[0].workspace_path,
            Some(PathBuf::from("/Users/mac/Projects/VibeX"))
        );
    }

    #[test]
    fn grok_injects_ask_user_answers_from_chat_history() {
        let temp = tempfile::tempdir().unwrap();
        let session_dir = temp.path().join("sessions").join("encoded").join("ask-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(
            session_dir.join("updates.jsonl"),
            concat!(
                r#"{"method":"session/update","params":{"sessionId":"grok-ask","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Pick one"}}},"timestamp":1784334520}"#,
                "\n",
                r#"{"method":"session/update","params":{"sessionId":"grok-ask","update":{"sessionUpdate":"tool_call","toolCallId":"call-ask-0","title":"ask_user_question","rawInput":{"questions":[{"question":"How?"}]},"_meta":{"x.ai/tool":{"name":"ask_user_question","kind":"ask_user"}}}},"timestamp":1784334521}"#,
                "\n"
            ),
        )
        .unwrap();
        std::fs::write(
            session_dir.join("chat_history.jsonl"),
            concat!(
                r#"{"type":"assistant","content":"demo","tool_calls":[{"id":"call-ask-0","name":"ask_user_question","arguments":"{}"}]}"#,
                "\n",
                r#"{"type":"tool_result","tool_call_id":"call-ask-0","content":"User has answered your questions: \"How?\"=\"Live demo\". You can now continue."}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Grok,
            path: temp.path().join("sessions"),
        })
        .unwrap();
        assert_eq!(sessions.len(), 1);
        let result = sessions[0]
            .messages
            .iter()
            .find(|message| message.metadata.kind.as_deref() == Some("tool_result"))
            .expect("ask result");
        assert_eq!(result.metadata.tool_call_id.as_deref(), Some("call-ask-0"));
        assert!(result.content.contains("Live demo"));
        assert_eq!(
            result
                .metadata
                .raw_output
                .as_ref()
                .and_then(|value| value["declined"].as_bool()),
            Some(false)
        );
    }

    #[test]
    fn codex_ignores_duplicate_event_msg_and_prefers_session_index_title() {
        let temp = tempfile::tempdir().unwrap();
        let sessions_dir = temp
            .path()
            .join("sessions")
            .join("2026")
            .join("04")
            .join("02");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        std::fs::write(
            temp.path().join("session_index.jsonl"),
            r#"{"id":"codex-titled","thread_name":"Indexed Codex title"}"#,
        )
        .unwrap();
        std::fs::write(
            sessions_dir.join("rollout-codex-titled.jsonl"),
            concat!(
                r#"{"timestamp":"2026-04-02T08:00:00Z","type":"session_meta","payload":{"id":"codex-titled","cwd":"/repo"}}"#,
                "\n",
                r#"{"timestamp":"2026-04-02T08:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]}}"#,
                "\n",
                r#"{"timestamp":"2026-04-02T08:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"Hello"}}"#,
                "\n",
                r#"{"timestamp":"2026-04-02T08:00:02Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hi"}]}}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Codex,
            path: temp.path().join("sessions"),
        })
        .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title.as_deref(), Some("Indexed Codex title"));
        assert_eq!(sessions[0].messages.len(), 2);
        assert_eq!(sessions[0].messages[0].content, "Hello");
        assert_eq!(sessions[0].messages[1].content, "Hi");
    }

    #[test]
    fn claude_sidechain_records_are_not_imported_as_user_turns() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("claude-sidechain.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","sessionId":"claude-main","cwd":"/repo","message":{"role":"user","content":"Main prompt"}}"#,
                "\n",
                r#"{"type":"user","isSidechain":true,"sessionId":"claude-main","message":{"role":"user","content":"Sidechain prompt"}}"#,
                "\n",
                r#"{"type":"assistant","sessionId":"claude-main","message":{"role":"assistant","content":"Main reply"}}"#,
                "\n"
            ),
        )
        .unwrap();
        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::ClaudeCode,
            path,
        })
        .unwrap();
        assert_eq!(sessions[0].messages.len(), 2);
        assert_eq!(sessions[0].messages[0].content, "Main prompt");
        assert_eq!(sessions[0].messages[1].content, "Main reply");
    }

    #[test]
    fn openclaw_strips_sender_metadata_and_reads_working_directory() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("openclaw-meta.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Sender (untrusted metadata):\n```\nfrom: alice\n```\n[Working directory: /Users/mac/Projects/VibeX]\n[12:01]\nShip it"}]}}"#,
                "\n",
                r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Shipped"}]}}"#,
                "\n"
            ),
        )
        .unwrap();
        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Openclaw,
            path,
        })
        .unwrap();
        assert_eq!(sessions[0].messages[0].content, "Ship it");
        assert_eq!(
            sessions[0].workspace_path,
            Some(PathBuf::from("/Users/mac/Projects/VibeX"))
        );
    }

    #[test]
    fn pi_bash_execution_becomes_a_tool_pair() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("pi-bash.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"session","id":"pi-bash","cwd":"/repo"}"#,
                "\n",
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Run it"}]}}"#,
                "\n",
                r#"{"type":"bash_execution","id":"1","command":"ls","output":"src","exitCode":0}"#,
                "\n"
            ),
        )
        .unwrap();
        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Pi,
            path,
        })
        .unwrap();
        assert_eq!(sessions[0].messages.len(), 3);
        assert_eq!(
            sessions[0].messages[1].metadata.kind.as_deref(),
            Some("tool_call")
        );
        assert_eq!(
            sessions[0].messages[2].metadata.kind.as_deref(),
            Some("tool_result")
        );
        assert_eq!(sessions[0].messages[2].content, "src");
    }

    #[test]
    fn deepseek_reads_zstd_session_logs() {
        let temp = tempfile::tempdir().unwrap();
        let session_dir = temp.path().join("sessions").join("demo").join("ds-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        let raw = concat!(
            r#"{"role":"user","content":"Read the file"}"#,
            "\n",
            r#"{"role":"assistant","content":"Done"}"#,
            "\n"
        );
        let compressed = zstd::encode_all(raw.as_bytes(), 0).unwrap();
        std::fs::write(session_dir.join("session.jsonl.zstd"), compressed).unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::DeepseekHarness,
            path: temp.path().join("sessions"),
        })
        .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "ds-1");
        assert_eq!(sessions[0].messages.len(), 2);
        assert_eq!(sessions[0].messages[0].content, "Read the file");
    }

    #[test]
    fn deepseek_image_blocks_become_placeholders() {
        let temp = tempfile::tempdir().unwrap();
        let session_dir = temp.path().join("sessions").join("demo").join("ds-img");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(
            session_dir.join("session.jsonl"),
            concat!(
                r#"{"role":"user","content":[{"type":"text","text":"What is this?"},{"type":"image","attachment":{"name":"shot.png","mediaType":"image/png"}}]}"#,
                "\n",
                r#"{"role":"assistant","content":[{"type":"text","text":"A screenshot."}]}"#,
                "\n"
            ),
        )
        .unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::DeepseekHarness,
            path: temp.path().join("sessions"),
        })
        .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "ds-img");
        assert!(sessions[0].messages[0].content.contains("What is this?"));
        assert!(
            sessions[0].messages[0]
                .content
                .contains("[image: shot.png]")
        );
    }

    #[test]
    fn caps_huge_claude_tool_result_payloads() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("claude-huge.jsonl");
        let huge = "x".repeat(crate::conversation::MAX_TIMELINE_PREVIEW_BYTES + 4096);
        let line = format!(
            r#"{{"type":"user","sessionId":"claude-huge","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"tool-1","content":"{huge}"}}]}}}}"#
        );
        std::fs::write(&path, format!("{line}\n")).unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::ClaudeCode,
            path,
        })
        .unwrap();

        let output = match sessions[0].messages[0].metadata.raw_output.as_ref() {
            Some(serde_json::Value::String(text)) => text.clone(),
            other => other.map(ToString::to_string).unwrap_or_default(),
        };
        assert!(output.len() <= crate::conversation::MAX_TIMELINE_PREVIEW_BYTES + 4);
        assert!(output.ends_with('…'));
        assert!(
            sessions[0].messages[0].content.len()
                <= crate::conversation::MAX_TIMELINE_PREVIEW_BYTES + 4
        );
    }

    #[test]
    fn imports_opencode_sqlite_history() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("opencode.db");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER);\
                 CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);\
                 CREATE TABLE part (id TEXT, message_id TEXT, time_created INTEGER, data TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session VALUES (?1, ?2, ?3, ?4)",
                ("oc-1", "/workspace/open", "OpenCode session", 1_i64),
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4)",
                (
                    "message-1",
                    "oc-1",
                    1_782_276_649_227_i64,
                    r#"{"role":"user","time":{"created":1782276649227}}"#,
                ),
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4)",
                (
                    "part-1",
                    "message-1",
                    1_782_276_649_227_i64,
                    r#"{"type":"text","text":"Inspect this repository"}"#,
                ),
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4)",
                (
                    "part-2",
                    "message-1",
                    1_782_276_649_228_i64,
                    r#"{"type":"reasoning","text":"Inspect dependencies first"}"#,
                ),
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4)",
                (
                    "part-3",
                    "message-1",
                    1_782_276_649_229_i64,
                    r#"{"type":"tool","callID":"call-oc-1","tool":"read","state":{"status":"completed","input":{"path":"package.json"},"output":"ok"}}"#,
                ),
            )
            .unwrap();
        drop(connection);

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Opencode,
            path: database,
        })
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "oc-1");
        assert_eq!(sessions[0].messages[0].content, "Inspect this repository");
        assert_eq!(sessions[0].messages.len(), 3);
        assert_eq!(
            sessions[0].messages[1].metadata.kind.as_deref(),
            Some("reasoning")
        );
        assert_eq!(sessions[0].messages[2].role, ImportedAgentMessageRole::Tool);
        assert_eq!(
            sessions[0].messages[2].metadata.tool_call_id.as_deref(),
            Some("call-oc-1")
        );
        assert_eq!(
            sessions[0].messages[2].metadata.tool_name.as_deref(),
            Some("read")
        );
        assert_eq!(
            sessions[0].messages[2].metadata.raw_output.as_ref(),
            Some(&serde_json::json!("ok"))
        );
    }

    #[test]
    fn imports_hermes_sqlite_history() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("state.db");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE sessions (id TEXT, cwd TEXT, model_config TEXT, title TEXT, archived INTEGER, started_at REAL);\
                 CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, reasoning_content TEXT, reasoning TEXT, timestamp REAL, active INTEGER, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sessions VALUES (?1, ?2, ?3, ?4, 0, ?5)",
                (
                    "hermes-1",
                    "/workspace/hermes",
                    "{}",
                    "Hermes session",
                    1_783_584_019_f64,
                ),
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO messages VALUES (1, ?1, ?2, ?3, ?4, NULL, ?5, 1, ?6, NULL, NULL)",
                (
                    "hermes-1",
                    "assistant",
                    "Hermes response",
                    "Hermes reasoning",
                    1_783_584_024_f64,
                    r#"[{"id":"call-1","function":{"name":"read","arguments":"{\"path\":\"README.md\"}"}}]"#,
                ),
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO messages VALUES (2, ?1, 'tool', 'contents', NULL, NULL, ?2, 1, NULL, 'call-1', 'read')",
                ("hermes-1", 1_783_584_025_f64),
            )
            .unwrap();
        drop(connection);

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Hermes,
            path: database,
        })
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "hermes-1");
        assert_eq!(sessions[0].messages.len(), 4);
        assert_eq!(sessions[0].messages[0].content, "Hermes reasoning");
        assert_eq!(
            sessions[0].messages[0].metadata.kind.as_deref(),
            Some("reasoning")
        );
        assert_eq!(sessions[0].messages[1].content, "Hermes response");
        assert_eq!(
            sessions[0].messages[2].metadata.kind.as_deref(),
            Some("tool_call")
        );
        assert_eq!(sessions[0].messages[2].role, ImportedAgentMessageRole::Tool);
        assert_eq!(
            sessions[0].messages[2].metadata.tool_call_id.as_deref(),
            Some("call-1")
        );
        assert_eq!(
            sessions[0].messages[3].metadata.kind.as_deref(),
            Some("tool_result")
        );
    }

    fn write_cursor_proto_store(root: &Path, session_id: &str, subagent: bool) {
        use cursor::proto::{field_bytes, field_str, field_varint};

        let session_dir = root.join("chats").join("cwdhash").join(session_id);
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(
            session_dir.join("meta.json"),
            r#"{"title":"Cursor session","cwd":"/workspace/cursor"}"#,
        )
        .unwrap();

        let user = field_str(1, "Hello from Cursor");
        let thinking = field_bytes(3, &field_str(1, "Planning the reply"));
        let assistant = field_bytes(1, &field_str(1, "All set."));
        let shell_args = [field_str(1, "ls"), field_str(2, "/workspace/cursor")].concat();
        let shell_success = [field_str(5, "README.md"), field_varint(3, 0)].concat();
        let shell_result = field_bytes(1, &shell_success);
        let shell_call = [field_bytes(1, &shell_args), field_bytes(2, &shell_result)].concat();
        let tool_call = [field_bytes(1, &shell_call), field_str(57, "call-shell")].concat();
        let tool_step = field_bytes(2, &tool_call);
        let agent_turn = [
            field_bytes(1, &[0x03]),
            field_bytes(2, &[0x04]),
            field_bytes(2, &[0x05]),
            field_bytes(2, &[0x06]),
        ]
        .concat();
        let turn = field_bytes(1, &agent_turn);
        let timing = [field_varint(1, 1_200), field_varint(2, 1_700_000_123_000)].concat();
        let repo = [field_str(1, "/workspace/cursor"), field_str(2, "main")].concat();
        let state = [
            field_bytes(8, &[0x02]),
            field_bytes(14, &timing),
            field_bytes(21, &repo),
        ]
        .concat();

        let mut meta = serde_json::json!({
            "name": "Cursor metadata",
            "latestRootBlobId": "01",
            "createdAt": 1_700_000_123_000u64,
            "lastUsedModel": "gpt-5"
        });
        if subagent {
            meta["subagentInfo"] = serde_json::json!({ "parentChatId": "parent" });
        }

        let database = session_dir.join("store.db");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE meta (key TEXT, value TEXT);\
                 CREATE TABLE blobs (id TEXT, data BLOB);",
            )
            .unwrap();
        connection
            .execute("INSERT INTO meta VALUES ('0', ?1)", [meta.to_string()])
            .unwrap();
        for (id, data) in [
            ("01", state.as_slice()),
            ("02", turn.as_slice()),
            ("03", user.as_slice()),
            ("04", thinking.as_slice()),
            ("05", tool_step.as_slice()),
            ("06", assistant.as_slice()),
        ] {
            connection
                .execute(
                    "INSERT INTO blobs VALUES (?1, ?2)",
                    rusqlite::params![id, data],
                )
                .unwrap();
        }
    }

    #[test]
    fn imports_cursor_protobuf_dag_with_roles_tools_and_timestamps() {
        let temp = tempfile::tempdir().unwrap();
        write_cursor_proto_store(temp.path(), "cursor-session", false);

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Cursor,
            path: temp.path().to_path_buf(),
        })
        .unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "cursor-session");
        assert_eq!(sessions[0].title.as_deref(), Some("Cursor session"));
        assert_eq!(
            sessions[0].workspace_path.as_deref(),
            Some(Path::new("/workspace/cursor"))
        );
        assert_eq!(sessions[0].messages[0].role, ImportedAgentMessageRole::User);
        assert_eq!(sessions[0].messages[0].content, "Hello from Cursor");
        assert_eq!(
            sessions[0].messages[1].metadata.kind.as_deref(),
            Some("reasoning")
        );
        assert_eq!(sessions[0].messages[2].role, ImportedAgentMessageRole::Tool);
        assert_eq!(
            sessions[0].messages[2].metadata.kind.as_deref(),
            Some("tool_call")
        );
        assert_eq!(
            sessions[0].messages[2].metadata.tool_name.as_deref(),
            Some("shell")
        );
        assert_eq!(
            sessions[0].messages[3].metadata.kind.as_deref(),
            Some("tool_result")
        );
        assert_eq!(sessions[0].messages[3].content, "README.md");
        assert_eq!(
            sessions[0].messages[4].role,
            ImportedAgentMessageRole::Assistant
        );
        assert_eq!(sessions[0].messages[4].content, "All set.");
        assert_eq!(
            sessions[0].messages[4].metadata.model.as_deref(),
            Some("gpt-5")
        );
        assert!(sessions[0].messages[0].created_at.is_some());
    }

    #[test]
    fn cursor_subagent_and_empty_stores_are_not_listed() {
        let temp = tempfile::tempdir().unwrap();
        write_cursor_proto_store(temp.path(), "cursor-child", true);
        let empty_dir = temp.path().join("acp-sessions").join("cursor-empty");
        std::fs::create_dir_all(&empty_dir).unwrap();
        let database = empty_dir.join("store.db");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE meta (key TEXT, value TEXT);\
                 CREATE TABLE blobs (id TEXT, data BLOB);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO meta VALUES ('0', ?1)",
                [r#"{"name":"Empty","latestRootBlobId":"aa"}"#],
            )
            .unwrap();
        drop(connection);

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Cursor,
            path: temp.path().to_path_buf(),
        })
        .unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn scan_lists_cursor_sqlite_stores() {
        let temp = tempfile::tempdir().unwrap();
        write_cursor_proto_store(temp.path(), "cursor-scan", false);
        let entries = scan_configured_history(
            AgentKind::Cursor,
            &HashMap::from([(
                "CURSOR_CONFIG_DIR".to_string(),
                temp.path().to_string_lossy().into_owned(),
            )]),
        )
        .unwrap();
        let scanned = entries
            .iter()
            .find(|entry| entry.external_session_id == "cursor-scan")
            .expect("configured Cursor root is scanned");
        assert_eq!(scanned.title.as_deref(), Some("Cursor session"));
        assert!(scanned.updated_at.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn cursor_history_scan_does_not_follow_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let chats = temp.path().join("chats");
        std::fs::create_dir_all(&chats).unwrap();
        symlink(&chats, chats.join("loop")).unwrap();

        let sessions = import_history_source(&AgentHistorySource {
            agent_type: AgentKind::Cursor,
            path: chats,
        })
        .unwrap();

        assert!(sessions.is_empty());
    }
}
