use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

use crate::registry::AgentType;

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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ImportedAgentSession {
    pub source_agent: AgentType,
    pub external_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<PathBuf>,
    pub messages: Vec<ImportedAgentMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_source_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentHistorySource {
    pub agent_type: AgentType,
    pub path: PathBuf,
}

#[derive(Debug, Error)]
pub enum AgentHistoryError {
    #[error("history source does not exist: {0}")]
    MissingSource(PathBuf),
    #[error("failed to read history source {path}: {error}")]
    Read {
        path: PathBuf,
        error: String,
    },
    #[error("failed to parse history source {path}: {error}")]
    Parse {
        path: PathBuf,
        error: String,
    },
}

pub fn default_history_sources(agent_type: AgentType) -> Vec<AgentHistorySource> {
    match agent_type {
        AgentType::ClaudeCode => env_or_home_sources(agent_type, "CLAUDE_CONFIG_DIR", ".claude")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("projects"),
                ..source
            })
            .collect(),
        AgentType::Codex => env_or_home_sources(agent_type, "CODEX_HOME", ".codex")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("sessions"),
                ..source
            })
            .collect(),
        AgentType::OpenCode => xdg_data_or_home_sources(agent_type, "opencode")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("opencode.db"),
                ..source
            })
            .collect(),
        AgentType::Gemini => env_or_home_sources(agent_type, "GEMINI_CLI_HOME", ".gemini"),
        AgentType::OpenClaw => home_source(agent_type, ".openclaw").map_or_else(Vec::new, |source| {
            vec![AgentHistorySource {
                path: source.path.join("agents"),
                ..source
            }]
        }),
        AgentType::Cline => env_or_home_sources(agent_type, "CLINE_DIR", ".cline")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("data").join("tasks"),
                ..source
            })
            .collect(),
        AgentType::Hermes => env_or_home_sources(agent_type, "HERMES_HOME", ".hermes")
            .into_iter()
            .map(|source| AgentHistorySource {
                path: source.path.join("state.db"),
                ..source
            })
            .collect(),
    }
}

pub fn import_history_source(
    source: &AgentHistorySource,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    if !source.path.exists() {
        return Err(AgentHistoryError::MissingSource(source.path.clone()));
    }

    let files = history_files(&source.path)?;
    let mut grouped: BTreeMap<(String, PathBuf), ImportedAgentSession> = BTreeMap::new();
    for file in files {
        let records = parse_history_file(source.agent_type, &file)?;
        for record in records {
            let key = (record.external_session_id.clone(), file.clone());
            grouped
                .entry(key)
                .and_modify(|session| session.messages.extend(record.messages.clone()))
                .or_insert(record);
        }
    }

    Ok(grouped.into_values().collect())
}

fn env_or_home_sources(agent_type: AgentType, env_var: &str, home_relative: &str) -> Vec<AgentHistorySource> {
    let mut sources = Vec::new();
    if let Ok(value) = std::env::var(env_var)
        && !value.trim().is_empty()
    {
        sources.push(AgentHistorySource {
            agent_type,
            path: PathBuf::from(value),
        });
    }
    if let Some(source) = home_source(agent_type, home_relative) {
        sources.push(source);
    }
    sources
}

fn xdg_data_or_home_sources(agent_type: AgentType, app_dir: &str) -> Vec<AgentHistorySource> {
    let mut sources = Vec::new();
    if let Ok(value) = std::env::var("XDG_DATA_HOME")
        && !value.trim().is_empty()
    {
        sources.push(AgentHistorySource {
            agent_type,
            path: PathBuf::from(value).join(app_dir),
        });
    }
    if let Some(data_dir) = dirs::data_dir() {
        sources.push(AgentHistorySource {
            agent_type,
            path: data_dir.join(app_dir),
        });
    }
    sources
}

fn home_source(agent_type: AgentType, home_relative: &str) -> Option<AgentHistorySource> {
    dirs::home_dir().map(|home| AgentHistorySource {
        agent_type,
        path: home.join(home_relative),
    })
}

fn history_files(path: &Path) -> Result<Vec<PathBuf>, AgentHistoryError> {
    if path.is_file() {
        return Ok(is_text_history_file(path)
            .then(|| path.to_path_buf())
            .into_iter()
            .collect());
    }

    let mut files = Vec::new();
    collect_history_files(path, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_history_files(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), AgentHistoryError> {
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
        if path.is_dir() {
            collect_history_files(&path, files)?;
        } else if is_text_history_file(&path) {
            files.push(path);
        }
    }

    Ok(())
}

fn is_text_history_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("json") | Some("jsonl")
    )
}

fn parse_history_file(
    agent_type: AgentType,
    path: &Path,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let raw = std::fs::read_to_string(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
        parse_jsonl_history(agent_type, path, &raw)
    } else {
        parse_json_history(agent_type, path, &raw)
    }
}

fn parse_jsonl_history(
    agent_type: AgentType,
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
    agent_type: AgentType,
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
    agent_type: AgentType,
    path: &Path,
    value: &serde_json::Value,
) -> Option<ImportedAgentSession> {
    let content = content_from_value(value)?;
    let external_session_id = string_at_any(value, &["sessionId", "session_id", "conversation_id", "id"])
        .unwrap_or_else(|| path.file_stem().and_then(|stem| stem.to_str()).unwrap_or("unknown").to_string());
    let title = string_at_any(value, &["title", "summary"]);
    let workspace_path = string_at_any(value, &["cwd", "workspace", "workspace_path"])
        .map(PathBuf::from);
    let role = role_from_value(value);
    let created_at = string_at_any(value, &["timestamp", "created_at", "createdAt"])
        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
        .map(|value| value.with_timezone(&Utc));

    Some(ImportedAgentSession {
        source_agent: agent_type,
        external_session_id,
        title,
        workspace_path,
        messages: vec![ImportedAgentMessage {
            role,
            content,
            created_at,
        }],
        raw_source_path: Some(path.to_path_buf()),
    })
}

fn role_from_value(value: &serde_json::Value) -> ImportedAgentMessageRole {
    let role = string_at_any(value, &["role", "type"])
        .or_else(|| value.get("message").and_then(|message| string_at_any(message, &["role", "type"])))
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
        .or_else(|| value.get("message").and_then(|message| string_at_any(message, &["content", "text"])))
        .or_else(|| value.get("item").and_then(|item| string_at_any(item, &["content", "text"])))
        .or_else(|| content_from_blocks(value.get("content")?))
}

fn content_from_blocks(value: &serde_json::Value) -> Option<String> {
    let parts = value
        .as_array()?
        .iter()
        .filter_map(|item| string_at_any(item, &["text", "content"]))
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn string_at_any(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|value| match value {
            serde_json::Value::String(value) => Some(value.clone()),
            serde_json::Value::Array(_) => content_from_blocks(value),
            serde_json::Value::Object(_) => None,
            serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures")
            .join("history")
            .join(name)
    }

    #[test]
    fn default_sources_cover_every_registry_agent() {
        for agent_type in crate::registry::all_agent_types() {
            assert!(
                !default_history_sources(agent_type).is_empty(),
                "missing history source for {agent_type:?}"
            );
        }
    }

    #[test]
    fn imports_claude_jsonl_fixture() {
        let source = AgentHistorySource {
            agent_type: AgentType::ClaudeCode,
            path: fixture_path("claude-projects"),
        };

        let sessions = import_history_source(&source).unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "claude-session-1");
        assert_eq!(sessions[0].workspace_path, Some(PathBuf::from("C:/repo")));
        assert_eq!(sessions[0].messages.len(), 2);
        assert_eq!(sessions[0].messages[0].role, ImportedAgentMessageRole::User);
        assert_eq!(sessions[0].messages[1].role, ImportedAgentMessageRole::Assistant);
    }

    #[test]
    fn imports_codex_json_fixture() {
        let source = AgentHistorySource {
            agent_type: AgentType::Codex,
            path: fixture_path("codex-sessions"),
        };

        let sessions = import_history_source(&source).unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].external_session_id, "codex-session-1");
        assert_eq!(sessions[0].messages[0].content, "Inspect the repo");
    }

    #[test]
    fn rejects_corrupt_jsonl_fixture() {
        let source = AgentHistorySource {
            agent_type: AgentType::Gemini,
            path: fixture_path("corrupt-jsonl"),
        };

        let error = import_history_source(&source).unwrap_err();

        assert!(matches!(error, AgentHistoryError::Parse { .. }));
    }
}
