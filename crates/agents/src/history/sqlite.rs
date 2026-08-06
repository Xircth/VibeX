use std::path::{Path, PathBuf};

use api_types::AgentKind;
use chrono::{TimeZone, Utc};
use rusqlite::{Connection, OpenFlags, OptionalExtension};

use super::{
    AgentHistoryError, ImportedAgentMessage, ImportedAgentMessageMetadata,
    ImportedAgentMessageRole, ImportedAgentSession,
};

pub(super) fn import_agent_database(
    agent_type: AgentKind,
    path: &Path,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    match agent_type {
        AgentKind::Opencode => import_opencode(path),
        AgentKind::Hermes => import_hermes(path),
        _ => Ok(Vec::new()),
    }
}

fn open_read_only(path: &Path) -> Result<Connection, AgentHistoryError> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| parse_error(path, error))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|error| parse_error(path, error))?;
    Ok(connection)
}

fn import_opencode(path: &Path) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let connection = open_read_only(path)?;
    let mut session_statement = connection
        .prepare("SELECT id, directory, title FROM session ORDER BY time_created ASC")
        .map_err(|error| parse_error(path, error))?;
    let sessions = session_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| parse_error(path, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| parse_error(path, error))?;
    let mut imported = Vec::new();
    for (session_id, directory, title) in sessions {
        let mut message_statement = connection
            .prepare(
                "SELECT id, time_created, data FROM message \
                 WHERE session_id = ? ORDER BY time_created ASC, id ASC",
            )
            .map_err(|error| parse_error(path, error))?;
        let rows = message_statement
            .query_map([&session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| parse_error(path, error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| parse_error(path, error))?;
        let mut messages = Vec::new();
        for (message_id, row_time, data) in rows {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&data) else {
                continue;
            };
            let role = role(value.get("role").and_then(serde_json::Value::as_str));
            let mut part_statement = connection
                .prepare(
                    "SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC",
                )
                .map_err(|error| parse_error(path, error))?;
            let created_ms = value
                .pointer("/time/created")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(row_time);
            let created_at = Utc.timestamp_millis_opt(created_ms).single();
            let parts = part_statement
                .query_map([&message_id], |row| row.get::<_, String>(0))
                .map_err(|error| parse_error(path, error))?
                .filter_map(Result::ok)
                .filter_map(|part| serde_json::from_str::<serde_json::Value>(&part).ok())
                .filter_map(|part| opencode_part_message(&part, &role, created_at))
                .collect::<Vec<_>>();
            if parts.is_empty() {
                continue;
            }
            messages.extend(parts);
        }
        if !messages.is_empty() {
            imported.push(ImportedAgentSession {
                source_agent: AgentKind::Opencode,
                external_session_id: session_id,
                title,
                workspace_path: directory.map(PathBuf::from),
                messages,
                raw_source_path: Some(path.to_path_buf()),
            });
        }
    }
    Ok(imported)
}

fn opencode_part_message(
    part: &serde_json::Value,
    message_role: &ImportedAgentMessageRole,
    created_at: Option<chrono::DateTime<Utc>>,
) -> Option<ImportedAgentMessage> {
    let mut metadata = ImportedAgentMessageMetadata::default();
    let (role, content) = match part.get("type").and_then(serde_json::Value::as_str) {
        Some("text") => (
            message_role.clone(),
            part.get("text")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())?
                .to_string(),
        ),
        Some("reasoning") => {
            metadata.kind = Some("reasoning".to_string());
            (
                ImportedAgentMessageRole::Assistant,
                part.get("text")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())?
                    .to_string(),
            )
        }
        Some("tool") => {
            let tool = part
                .get("tool")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown");
            let raw_input = part.pointer("/state/input").cloned();
            let raw_output = part.pointer("/state/output").cloned();
            let status = part
                .pointer("/state/status")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            metadata.kind = Some(
                if raw_output.is_some() || status.as_deref() == Some("completed") {
                    "tool_result"
                } else {
                    "tool_call"
                }
                .to_string(),
            );
            metadata.tool_call_id = part
                .get("callID")
                .or_else(|| part.get("callId"))
                .or_else(|| part.get("id"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            metadata.tool_name = Some(tool.to_string());
            metadata.tool_status = status;
            metadata.raw_input = raw_input.clone();
            metadata.raw_output = raw_output.clone();
            (
                ImportedAgentMessageRole::Tool,
                format!(
                    "[tool: {tool}]{}{}",
                    raw_input
                        .as_ref()
                        .and_then(json_preview)
                        .map(|value| format!("\ninput: {value}"))
                        .unwrap_or_default(),
                    raw_output
                        .as_ref()
                        .and_then(json_preview)
                        .map(|value| format!("\noutput: {value}"))
                        .unwrap_or_default()
                ),
            )
        }
        Some("file") => (
            message_role.clone(),
            format!(
                "@{}",
                part.get("filename")
                    .or_else(|| part.get("url"))
                    .and_then(serde_json::Value::as_str)?
            ),
        ),
        _ => return None,
    };
    Some(ImportedAgentMessage {
        role,
        content,
        created_at,
        metadata,
    })
}

fn import_hermes(path: &Path) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let connection = open_read_only(path)?;
    let mut statement = connection
        .prepare(
            "SELECT id, COALESCE(NULLIF(cwd, ''), \
             CASE WHEN json_valid(model_config) THEN json_extract(model_config, '$.cwd') END), title \
             FROM sessions WHERE COALESCE(archived, 0) = 0 ORDER BY started_at ASC",
        )
        .map_err(|error| parse_error(path, error))?;
    let sessions = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| parse_error(path, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| parse_error(path, error))?;
    let mut imported = Vec::new();
    for (session_id, cwd, title) in sessions {
        let mut message_statement = connection
            .prepare(
                "SELECT role, content, reasoning_content, reasoning, timestamp, \
                        tool_calls, tool_call_id, tool_name \
                 FROM messages WHERE session_id = ? AND active = 1 ORDER BY id ASC",
            )
            .map_err(|error| parse_error(path, error))?;
        let rows = message_statement
            .query_map([&session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<f64>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            })
            .map_err(|error| parse_error(path, error))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        let mut messages = Vec::new();
        for (
            role_value,
            content,
            reasoning_content,
            reasoning,
            timestamp,
            tool_calls,
            tool_call_id,
            tool_name,
        ) in rows
        {
            if role_value == "system" {
                continue;
            }
            let created_at = timestamp.and_then(|seconds| {
                let whole = seconds.trunc() as i64;
                let nanos = (seconds.fract().abs() * 1_000_000_000.0) as u32;
                Utc.timestamp_opt(whole, nanos).single()
            });
            let reasoning = reasoning_content.or(reasoning).unwrap_or_default();
            if !reasoning.trim().is_empty() {
                messages.push(ImportedAgentMessage {
                    role: ImportedAgentMessageRole::Assistant,
                    content: reasoning.trim().to_string(),
                    created_at,
                    metadata: ImportedAgentMessageMetadata {
                        kind: Some("reasoning".to_string()),
                        ..Default::default()
                    },
                });
            }
            let content = decode_hermes_content(content.as_deref());
            if !content.trim().is_empty()
                || (role_value == "tool" && (tool_call_id.is_some() || tool_name.is_some()))
            {
                messages.push(ImportedAgentMessage {
                    role: role(Some(&role_value)),
                    content,
                    created_at,
                    metadata: if role_value == "tool" {
                        ImportedAgentMessageMetadata {
                            kind: Some("tool_result".to_string()),
                            tool_call_id,
                            tool_name,
                            ..Default::default()
                        }
                    } else {
                        Default::default()
                    },
                });
            }
            if role_value == "assistant" {
                for (tool_call_id, tool_name, raw_input) in
                    parse_hermes_tool_calls(tool_calls.as_deref())
                {
                    messages.push(ImportedAgentMessage {
                        role: ImportedAgentMessageRole::Tool,
                        content: format!("[tool: {tool_name}]"),
                        created_at,
                        metadata: ImportedAgentMessageMetadata {
                            kind: Some("tool_call".to_string()),
                            tool_call_id,
                            tool_name: Some(tool_name),
                            raw_input,
                            ..Default::default()
                        },
                    });
                }
            }
        }
        if !messages.is_empty() {
            imported.push(ImportedAgentSession {
                source_agent: AgentKind::Hermes,
                external_session_id: session_id,
                title,
                workspace_path: cwd.map(PathBuf::from),
                messages,
                raw_source_path: Some(path.to_path_buf()),
            });
        }
    }
    Ok(imported)
}

fn parse_hermes_tool_calls(
    raw: Option<&str>,
) -> Vec<(Option<String>, String, Option<serde_json::Value>)> {
    let Some(calls) = raw
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|value| value.as_array().cloned())
    else {
        return Vec::new();
    };
    calls
        .into_iter()
        .map(|call| {
            let id = call
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let function = call.get("function");
            let name = function
                .and_then(|value| value.get("name"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let input = function
                .and_then(|value| value.get("arguments"))
                .and_then(|value| match value {
                    serde_json::Value::String(raw) => serde_json::from_str(raw).ok(),
                    value => Some(value.clone()),
                });
            (id, name, input)
        })
        .collect()
}

fn decode_hermes_content(content: Option<&str>) -> String {
    let content = content.unwrap_or_default();
    let Some(json) = content.strip_prefix("\0json:") else {
        return content.to_string();
    };
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|part| {
            part.get("text")
                .or_else(|| part.get("content"))
                .and_then(serde_json::Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn import_cursor_stores(
    root: &Path,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let mut stores = Vec::new();
    collect_store_databases(root, &mut stores)?;
    let mut sessions = Vec::new();
    for store in stores {
        let Some(session_dir) = store.parent() else {
            continue;
        };
        let session_id = session_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown")
            .to_string();
        let sidecar = read_json(session_dir.join("meta.json"));
        let connection = open_read_only(&store)?;
        let metadata = connection
            .query_row("SELECT value FROM meta WHERE key = '0'", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(|error| parse_error(&store, error))?
            .and_then(|raw| cursor_metadata(&raw));
        if metadata
            .as_ref()
            .and_then(|value| value.get("subagentInfo"))
            .is_some_and(|value| !value.is_null())
        {
            continue;
        }
        let title = sidecar
            .as_ref()
            .and_then(|value| value.get("title"))
            .and_then(serde_json::Value::as_str)
            .or_else(|| {
                metadata
                    .as_ref()
                    .and_then(|value| value.get("name"))
                    .and_then(serde_json::Value::as_str)
            })
            .map(str::to_string);
        let workspace_path = sidecar
            .as_ref()
            .and_then(|value| value.get("cwd"))
            .and_then(serde_json::Value::as_str)
            .map(PathBuf::from);
        let messages = cursor_text_messages(&connection);
        sessions.push(ImportedAgentSession {
            source_agent: AgentKind::Cursor,
            external_session_id: session_id,
            title,
            workspace_path,
            messages,
            raw_source_path: Some(store),
        });
    }
    Ok(sessions)
}

fn collect_store_databases(
    path: &Path,
    stores: &mut Vec<PathBuf>,
) -> Result<(), AgentHistoryError> {
    collect_store_databases_inner(path, stores, &mut std::collections::HashSet::new())
}

fn collect_store_databases_inner(
    path: &Path,
    stores: &mut Vec<PathBuf>,
    visited: &mut std::collections::HashSet<PathBuf>,
) -> Result<(), AgentHistoryError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_file() {
        if path.file_name().and_then(|name| name.to_str()) == Some("store.db") {
            stores.push(path.to_path_buf());
        }
        return Ok(());
    }
    let canonical = std::fs::canonicalize(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    if !visited.insert(canonical) {
        return Ok(());
    }
    for entry in std::fs::read_dir(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })? {
        let entry = entry.map_err(|error| AgentHistoryError::Read {
            path: path.to_path_buf(),
            error: error.to_string(),
        })?;
        let candidate = entry.path();
        let candidate_metadata =
            std::fs::symlink_metadata(&candidate).map_err(|error| AgentHistoryError::Read {
                path: candidate.clone(),
                error: error.to_string(),
            })?;
        if candidate_metadata.file_type().is_symlink() {
            continue;
        }
        if candidate_metadata.is_dir() {
            collect_store_databases_inner(&candidate, stores, visited)?;
        } else if candidate.file_name().and_then(|name| name.to_str()) == Some("store.db") {
            stores.push(candidate);
        }
    }
    Ok(())
}

fn cursor_text_messages(connection: &Connection) -> Vec<ImportedAgentMessage> {
    let Ok(mut statement) = connection.prepare("SELECT data FROM blobs") else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([], |row| row.get::<_, Vec<u8>>(0)) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    rows.filter_map(Result::ok)
        .flat_map(|data| printable_runs(&data))
        .filter(|text| text.len() >= 12 && text.contains(char::is_whitespace))
        .filter(|text| seen.insert(text.clone()))
        .take(64)
        .map(|content| ImportedAgentMessage {
            role: ImportedAgentMessageRole::Unknown,
            content,
            created_at: None,
            metadata: Default::default(),
        })
        .collect()
}

fn printable_runs(bytes: &[u8]) -> Vec<String> {
    let mut runs = Vec::new();
    let mut current = Vec::new();
    for byte in bytes {
        if byte.is_ascii_graphic() || matches!(byte, b' ' | b'\n' | b'\t') {
            current.push(*byte);
        } else if !current.is_empty()
            && let Ok(text) = String::from_utf8(std::mem::take(&mut current))
        {
            let text = text.trim();
            if !text.is_empty() {
                runs.push(text.to_string());
            }
        }
    }
    if let Ok(text) = String::from_utf8(current) {
        let text = text.trim();
        if !text.is_empty() {
            runs.push(text.to_string());
        }
    }
    runs
}

fn cursor_metadata(raw: &str) -> Option<serde_json::Value> {
    if raw.trim_start().starts_with('{') {
        return serde_json::from_str(raw).ok();
    }
    let bytes = (0..raw.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(raw.get(index..index + 2)?, 16).ok())
        .collect::<Option<Vec<_>>>()?;
    serde_json::from_slice(&bytes).ok()
}

fn read_json(path: PathBuf) -> Option<serde_json::Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn role(value: Option<&str>) -> ImportedAgentMessageRole {
    match value {
        Some("user" | "human") => ImportedAgentMessageRole::User,
        Some("assistant" | "agent") => ImportedAgentMessageRole::Assistant,
        Some("system") => ImportedAgentMessageRole::System,
        Some("tool" | "tool_result" | "tool_use") => ImportedAgentMessageRole::Tool,
        _ => ImportedAgentMessageRole::Unknown,
    }
}

fn json_preview(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| serde_json::to_string(value).ok())
}

fn parse_error(path: &Path, error: impl std::fmt::Display) -> AgentHistoryError {
    AgentHistoryError::Parse {
        path: path.to_path_buf(),
        error: error.to_string(),
    }
}
