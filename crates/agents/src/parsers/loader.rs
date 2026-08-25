//! Locate an agent's session file by `external_session_id` and parse it for
//! explicit import. Product conversation history is persisted in VibeX
//! `conversation_events`; this loader must not be used as an on-demand history
//! source. VibeX-authored.

use std::path::{Path, PathBuf};

use api_types::AgentKind;
use serde_json::Value;
use thiserror::Error;

use super::{
    ConversationParser, ParseContext, ParseError, claude::ClaudeParser, cline::ClineParser,
    codex::CodexParser, openclaw::OpenClawParser,
};
use crate::{conversation::ConversationDetail, history::default_history_sources};

#[derive(Debug, Error)]
pub enum LoaderError {
    #[error("failed to read session file {path}: {error}")]
    Read { path: PathBuf, error: String },
    #[error(transparent)]
    Parse(#[from] ParseError),
}

/// The parser for an agent, or `None` if no parser is implemented yet.
pub fn parser_for(agent_type: AgentKind) -> Option<Box<dyn ConversationParser>> {
    match agent_type {
        AgentKind::ClaudeCode => Some(Box::new(ClaudeParser)),
        AgentKind::Codex => Some(Box::new(CodexParser)),
        AgentKind::Antigravity => None,
        AgentKind::Cline => Some(Box::new(ClineParser)),
        AgentKind::Openclaw => Some(Box::new(OpenClawParser)),
        // OpenCode / Hermes store history in SQLite DBs (opencode.db / state.db),
        // which don't fit the text `parse(&str)` interface — a DB reader path is
        // needed for those and is out of scope here.
        _ => None,
    }
}

/// Resolve the on-disk session file for an agent session, searching the agent's
/// default history roots.
pub fn locate_session_file(agent_type: AgentKind, external_session_id: &str) -> Option<PathBuf> {
    let roots: Vec<PathBuf> = default_history_sources(agent_type)
        .into_iter()
        .map(|source| source.path)
        .collect();
    locate_in_roots(agent_type, external_session_id, &roots)
}

/// Testable core of [`locate_session_file`]: scan the given roots.
pub fn locate_in_roots(
    agent_type: AgentKind,
    external_session_id: &str,
    roots: &[PathBuf],
) -> Option<PathBuf> {
    for root in roots {
        if let Some(found) = scan_dir(agent_type, external_session_id, root) {
            return Some(found);
        }
    }
    None
}

fn scan_dir(agent_type: AgentKind, id: &str, dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = scan_dir(agent_type, id, &path) {
                return Some(found);
            }
        } else if is_jsonl(&path) && file_matches(agent_type, id, &path) {
            return Some(path);
        }
    }
    None
}

fn is_jsonl(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("jsonl") | Some("json")
    )
}

fn file_matches(agent_type: AgentKind, id: &str, path: &Path) -> bool {
    match agent_type {
        // Claude names each session file by its session id.
        AgentKind::ClaudeCode => path.file_stem().and_then(|stem| stem.to_str()) == Some(id),
        // Codex names files `rollout-<ts>-<uuid>.jsonl`; the canonical id is in
        // the leading `session_meta` record.
        AgentKind::Codex => codex_session_id(path).as_deref() == Some(id),
        _ => false,
    }
}

fn codex_session_id(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let first = raw.lines().find(|line| !line.trim().is_empty())?;
    let value: Value = serde_json::from_str(first.trim()).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    value
        .get("payload")
        .and_then(|payload| payload.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Locate and parse the transcript for an explicit import operation. Returns
/// `Ok(None)` when no parser is available or the file cannot be found.
pub fn load_import_conversation_detail(
    agent_type: AgentKind,
    external_session_id: &str,
    workspace_path: Option<String>,
) -> Result<Option<ConversationDetail>, LoaderError> {
    let Some(parser) = parser_for(agent_type) else {
        return Ok(None);
    };
    let Some(path) = locate_session_file(agent_type, external_session_id) else {
        return Ok(None);
    };
    load_from_path(
        parser.as_ref(),
        agent_type,
        external_session_id,
        workspace_path,
        &path,
    )
    .map(Some)
}

/// Re-parse a known session file path (testable; bypasses location).
pub fn load_from_path(
    parser: &dyn ConversationParser,
    agent_type: AgentKind,
    external_session_id: &str,
    workspace_path: Option<String>,
    path: &Path,
) -> Result<ConversationDetail, LoaderError> {
    let raw = std::fs::read_to_string(path).map_err(|error| LoaderError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    let ctx = ParseContext {
        external_session_id: external_session_id.to_string(),
        agent_type,
        workspace_path,
    };
    Ok(parser.parse(&raw, &ctx)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vibex-loader-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parser_dispatch_covers_implemented_agents() {
        assert!(parser_for(AgentKind::ClaudeCode).is_some());
        assert!(parser_for(AgentKind::Codex).is_some());
        assert!(parser_for(AgentKind::Antigravity).is_none());
        assert!(parser_for(AgentKind::Cline).is_some());
        assert!(parser_for(AgentKind::Openclaw).is_some());
        // OpenCode / Hermes use SQLite DBs, not the text parser interface.
        assert!(parser_for(AgentKind::Opencode).is_none());
        assert!(parser_for(AgentKind::Hermes).is_none());
    }

    #[test]
    fn locates_claude_session_by_filename() {
        let root = temp_dir("claude");
        let nested = root.join("encoded-cwd");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("claude-xyz.jsonl");
        std::fs::write(
            &file,
            r#"{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-06-14T00:00:00Z"}"#,
        )
        .unwrap();

        let found = locate_in_roots(
            AgentKind::ClaudeCode,
            "claude-xyz",
            std::slice::from_ref(&root),
        );
        assert_eq!(found.as_deref(), Some(file.as_path()));
        assert!(
            locate_in_roots(
                AgentKind::ClaudeCode,
                "missing",
                std::slice::from_ref(&root),
            )
            .is_none()
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn locates_codex_session_by_meta_id_and_loads_detail() {
        let root = temp_dir("codex");
        let file = root.join("rollout-2026-05-14T00-00-00-uuid.jsonl");
        std::fs::write(
            &file,
            concat!(
                r#"{"timestamp":"2026-06-14T00:00:00Z","type":"session_meta","payload":{"id":"codex-abc","cwd":"C:/repo"}}"#,
                "\n",
                r#"{"timestamp":"2026-06-14T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"go"}]}}"#,
                "\n",
                r#"{"timestamp":"2026-06-14T00:00:02Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}"#,
            ),
        )
        .unwrap();

        let found = locate_in_roots(AgentKind::Codex, "codex-abc", std::slice::from_ref(&root));
        assert_eq!(found.as_deref(), Some(file.as_path()));

        let parser = parser_for(AgentKind::Codex).unwrap();
        let detail = load_from_path(
            parser.as_ref(),
            AgentKind::Codex,
            "codex-abc",
            Some("C:/repo".to_string()),
            &file,
        )
        .unwrap();
        assert_eq!(detail.summary.id, "codex-abc");
        assert_eq!(detail.turns.len(), 2);

        std::fs::remove_dir_all(&root).unwrap();
    }
}
