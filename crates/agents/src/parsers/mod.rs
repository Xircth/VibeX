//! Agent session-file parsers.
//!
//! In the codeg-aligned storage model the DB stores only conversation metadata;
//! the transcript is re-parsed from each agent CLI's own session file, keyed by
//! `external_session_id` + `agent_type`. Each parser turns a raw session file
//! into the shared [`crate::conversation`] vocabulary (`MessageTurn` /
//! `ContentBlock`), so live and historical transcripts render uniformly.
//!
//! VibeX-authored. The on-disk session formats are the agents' own.

pub mod claude;
pub mod codex;
pub mod loader;

use chrono::{DateTime, Utc};
use serde_json::Value;
use thiserror::Error;

use crate::conversation::{
    ContentBlock, ConversationDetail, ConversationSummary, MessageTurn, PlanEntry, SessionStats,
    TurnRole, TurnUsage,
};
use crate::registry::AgentType;

/// True for plan/todo tools whose input should render as a [`ContentBlock::Plan`]
/// checklist rather than a generic tool card (mirrors codeg's `isPlanLikeToolName`).
pub fn is_plan_tool(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "todowrite" || lower == "todo_write" || lower.contains("plan")
}

/// Extract checklist entries from a plan/todo tool's input, looking under the
/// common array keys (`todos` / `entries` / `plan` / `steps`).
pub fn plan_entries_from_input(input: Option<&Value>) -> Option<Vec<PlanEntry>> {
    let input = input?;
    let array = ["todos", "entries", "plan", "steps"]
        .into_iter()
        .find_map(|key| input.get(key).and_then(Value::as_array))?;
    let entries: Vec<PlanEntry> = array.iter().filter_map(plan_entry_from_value).collect();
    (!entries.is_empty()).then_some(entries)
}

fn plan_entry_from_value(value: &Value) -> Option<PlanEntry> {
    let content = ["content", "step", "title", "name", "description"]
        .into_iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))?
        .to_string();
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .map(normalize_plan_status)
        .unwrap_or_else(|| "pending".to_string());
    let priority = value
        .get("priority")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(PlanEntry {
        content,
        status,
        priority,
    })
}

fn normalize_plan_status(status: &str) -> String {
    match status.to_ascii_lowercase().as_str() {
        "completed" | "complete" | "done" => "completed",
        "in_progress" | "in-progress" | "running" | "active" => "in_progress",
        _ => "pending",
    }
    .to_string()
}

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("malformed session file: {0}")]
    Malformed(String),
}

/// Context a parser needs to stamp the parsed conversation.
#[derive(Debug, Clone)]
pub struct ParseContext {
    pub external_session_id: String,
    pub agent_type: AgentType,
    pub workspace_path: Option<String>,
}

/// A parser for one agent's session-file format.
pub trait ConversationParser {
    /// Parse a raw session file into a conversation transcript.
    fn parse(&self, raw: &str, ctx: &ParseContext) -> Result<ConversationDetail, ParseError>;
}

/// A pre-grouping record produced while scanning a session file: one role-tagged
/// emission with its content blocks. [`group_into_turns`] folds consecutive
/// records into role-homogeneous [`MessageTurn`]s.
#[derive(Debug, Clone)]
pub struct ParsedRecord {
    pub role: TurnRole,
    pub blocks: Vec<ContentBlock>,
    pub timestamp: DateTime<Utc>,
    pub usage: Option<TurnUsage>,
    pub model: Option<String>,
}

fn is_tool_result_only(blocks: &[ContentBlock]) -> bool {
    !blocks.is_empty()
        && blocks
            .iter()
            .all(|block| matches!(block, ContentBlock::ToolResult { .. }))
}

fn sum_usage(a: Option<TurnUsage>, b: Option<TurnUsage>) -> Option<TurnUsage> {
    match (a, b) {
        (None, None) => None,
        (Some(u), None) | (None, Some(u)) => Some(u),
        (Some(x), Some(y)) => Some(TurnUsage {
            input_tokens: x.input_tokens + y.input_tokens,
            output_tokens: x.output_tokens + y.output_tokens,
            cache_creation_input_tokens: x.cache_creation_input_tokens
                + y.cache_creation_input_tokens,
            cache_read_input_tokens: x.cache_read_input_tokens + y.cache_read_input_tokens,
        }),
    }
}

/// Fold ordered parsed records into role-homogeneous turns.
///
/// Consecutive records of the same role merge into one turn. A `user` record
/// that carries only `tool_result` blocks is attached to the current assistant
/// turn instead of starting a new user turn (agents persist tool results under a
/// user-role message, but they belong to the assistant's round).
pub fn group_into_turns(records: Vec<ParsedRecord>) -> Vec<MessageTurn> {
    let mut turns: Vec<MessageTurn> = Vec::new();

    for (index, record) in records.into_iter().enumerate() {
        let attaches_to_assistant = record.role == TurnRole::User
            && is_tool_result_only(&record.blocks)
            && matches!(
                turns.last(),
                Some(turn) if turn.role == TurnRole::Assistant
            );

        let same_role = matches!(turns.last(), Some(turn) if turn.role == record.role);

        if attaches_to_assistant || same_role {
            let turn = turns.last_mut().expect("checked above");
            turn.blocks.extend(record.blocks);
            turn.usage = sum_usage(turn.usage, record.usage);
            if turn.model.is_none() {
                turn.model = record.model;
            }
            turn.completed_at = Some(record.timestamp);
            continue;
        }

        turns.push(MessageTurn {
            id: format!("turn-{index}"),
            role: record.role,
            blocks: record.blocks,
            timestamp: record.timestamp,
            usage: record.usage,
            duration_ms: None,
            model: record.model,
            completed_at: Some(record.timestamp),
        });
    }

    turns
}

/// Roll per-turn usage and span into [`SessionStats`].
pub fn session_stats(turns: &[MessageTurn]) -> Option<SessionStats> {
    if turns.is_empty() {
        return None;
    }

    let total_usage = turns
        .iter()
        .filter_map(|turn| turn.usage)
        .fold(None, |acc, usage| sum_usage(acc, Some(usage)));
    let total_tokens = total_usage.map(|usage| {
        usage.input_tokens
            + usage.output_tokens
            + usage.cache_creation_input_tokens
            + usage.cache_read_input_tokens
    });

    let started = turns.first().map(|turn| turn.timestamp);
    let ended = turns
        .iter()
        .filter_map(|turn| turn.completed_at)
        .max()
        .or_else(|| turns.last().map(|turn| turn.timestamp));
    let total_duration_ms = match (started, ended) {
        (Some(start), Some(end)) => (end - start).num_milliseconds().max(0) as u64,
        _ => 0,
    };

    Some(SessionStats {
        total_usage,
        total_tokens,
        total_duration_ms,
        ..SessionStats::default()
    })
}

/// Assemble a [`ConversationDetail`] from grouped turns + context.
pub fn build_detail(turns: Vec<MessageTurn>, ctx: &ParseContext) -> ConversationDetail {
    let started_at = turns
        .first()
        .map(|turn| turn.timestamp)
        .unwrap_or_else(Utc::now);
    let ended_at = turns.iter().filter_map(|turn| turn.completed_at).max();
    let model = turns.iter().rev().find_map(|turn| turn.model.clone());
    let stats = session_stats(&turns);

    ConversationDetail {
        summary: ConversationSummary {
            id: ctx.external_session_id.clone(),
            agent_type: ctx.agent_type,
            folder_path: ctx.workspace_path.clone(),
            folder_name: None,
            title: None,
            started_at,
            ended_at,
            message_count: turns.len() as u32,
            model,
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        },
        turns,
        session_stats: stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(secs, 0).unwrap()
    }

    fn rec(role: TurnRole, blocks: Vec<ContentBlock>, secs: i64) -> ParsedRecord {
        ParsedRecord {
            role,
            blocks,
            timestamp: ts(secs),
            usage: None,
            model: None,
        }
    }

    #[test]
    fn merges_consecutive_same_role_records() {
        let turns = group_into_turns(vec![
            rec(TurnRole::User, vec![ContentBlock::Text { text: "hi".into() }], 1),
            rec(
                TurnRole::Assistant,
                vec![ContentBlock::Text { text: "a".into() }],
                2,
            ),
            rec(
                TurnRole::Assistant,
                vec![ContentBlock::ToolUse {
                    tool_use_id: Some("t1".into()),
                    tool_name: "read".into(),
                    input_preview: None,
                    meta: None,
                }],
                3,
            ),
        ]);

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, TurnRole::User);
        assert_eq!(turns[1].role, TurnRole::Assistant);
        assert_eq!(turns[1].blocks.len(), 2);
    }

    #[test]
    fn attaches_tool_result_user_records_to_assistant_turn() {
        let turns = group_into_turns(vec![
            rec(
                TurnRole::Assistant,
                vec![ContentBlock::ToolUse {
                    tool_use_id: Some("t1".into()),
                    tool_name: "read".into(),
                    input_preview: None,
                    meta: None,
                }],
                1,
            ),
            rec(
                TurnRole::User,
                vec![ContentBlock::ToolResult {
                    tool_use_id: Some("t1".into()),
                    output_preview: Some("ok".into()),
                    is_error: false,
                    agent_stats: None,
                }],
                2,
            ),
            rec(
                TurnRole::User,
                vec![ContentBlock::Text {
                    text: "next".into(),
                }],
                3,
            ),
        ]);

        // tool_result attaches to the assistant turn; the real user message starts a new turn.
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, TurnRole::Assistant);
        assert_eq!(turns[0].blocks.len(), 2);
        assert_eq!(turns[1].role, TurnRole::User);
    }
}
