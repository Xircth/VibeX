//! ACP `session/fork` cut-point naming (JetBrains AIR `_meta`).
//!
//! Agents that implement historical fork read
//! `_meta.jetbrains.air.fork = { version, messageId, messageFingerprint?,
//! messageOccurrence? }`. An agent that does not understand the block forks at
//! the tail, so this crate only attaches the block when the turn can be named.
//!
//! deepseek-acp 0.8.0 accepts both halves: `messageId` is the session log's
//! `message.id` (or the VibeX turn id when the log named nothing), and the
//! fingerprint hashes assistant text once per message and once per turn. This
//! crate sends both so the id path short-circuits the ambiguous fingerprint
//! case.

use sha2::{Digest, Sha256};

use crate::{
    AgentKind,
    conversation::{ContentBlock, MessageTurn, TurnRole},
};

/// Whether an assistant bubble can be a `session/fork` cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ForkPointStatus {
    Named,
    Unnamed,
    Tail,
    Unsupported,
}

/// Classify `turn_id` (an assistant message-row id) for this agent.
pub fn classify_fork_point(
    turns: &[MessageTurn],
    turn_id: &str,
    agent_kind: AgentKind,
    fork_session: bool,
    is_thread_tail: bool,
) -> ForkPointStatus {
    if !fork_session {
        return ForkPointStatus::Unsupported;
    }
    if is_thread_tail {
        return ForkPointStatus::Tail;
    }
    if resolve_fork_point(turns, turn_id, agent_kind).is_some() {
        ForkPointStatus::Named
    } else {
        ForkPointStatus::Unnamed
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkPoint {
    pub message_id: String,
    pub message_fingerprint: Option<String>,
    pub message_occurrence: Option<u32>,
}

impl ForkPoint {
    pub fn to_meta(&self) -> serde_json::Value {
        let mut fork = serde_json::Map::new();
        fork.insert("version".into(), serde_json::json!(1));
        fork.insert("messageId".into(), serde_json::json!(self.message_id));
        if let Some(fp) = &self.message_fingerprint {
            fork.insert("messageFingerprint".into(), serde_json::json!(fp));
        }
        if let Some(n) = self.message_occurrence {
            fork.insert("messageOccurrence".into(), serde_json::json!(n));
        }
        serde_json::json!({ "jetbrains": { "air": { "fork": fork } } })
    }
}

pub fn fingerprint_agent_message(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

fn turn_text(turn: &MessageTurn) -> String {
    turn.blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn fingerprint_occurrence(turns: &[MessageTurn], idx: usize, fingerprint: &str) -> usize {
    turns[..idx]
        .iter()
        .filter(|turn| {
            matches!(turn.role, TurnRole::Assistant)
                && fingerprint_agent_message(&turn_text(turn)) == fingerprint
        })
        .count()
        + 1
}

fn is_assistant_row_for_turn(turn: &MessageTurn, vibex_turn_id: &str) -> bool {
    if !matches!(turn.role, TurnRole::Assistant) {
        return false;
    }
    let exact = format!("{vibex_turn_id}:assistant");
    turn.id == exact || turn.id.starts_with(&format!("{vibex_turn_id}:assistant:"))
}

/// Last assistant bubble of a VibeX Turn, including post-steering segments
/// (`{turn}:assistant:N`).
fn last_assistant_for_turn<'a>(
    turns: &'a [MessageTurn],
    vibex_turn_id: &str,
) -> Option<&'a MessageTurn> {
    turns
        .iter()
        .rfind(|turn| is_assistant_row_for_turn(turn, vibex_turn_id))
}

/// Name the last assistant bubble of `vibex_turn_id`, or `None` when the
/// adapter cannot honour that historical cut.
pub fn resolve_fork_point_for_turn(
    turns: &[MessageTurn],
    vibex_turn_id: &str,
    agent_kind: AgentKind,
) -> Option<ForkPoint> {
    let cut = last_assistant_for_turn(turns, vibex_turn_id)?;
    resolve_fork_point(turns, &cut.id, agent_kind)
}

/// Name `turn_id` for this agent, or `None` when the adapter cannot honour a
/// historical cut (caller must not send `session/fork` for a non-tail cut).
pub fn resolve_fork_point(
    turns: &[MessageTurn],
    turn_id: &str,
    agent_kind: AgentKind,
) -> Option<ForkPoint> {
    let idx = turns
        .iter()
        .position(|turn| turn.id == turn_id && matches!(turn.role, TurnRole::Assistant))?;
    let turn = &turns[idx];

    match agent_kind {
        // claude-agent-acp ≥ 0.75.1 resolves abandoned branches via fingerprint
        // after the live id map and the active parentUuid chain miss. An empty
        // synthesized turn must not send fingerprint("") — that matches every
        // text-free grouping. No agent_message_id means this bubble cannot be
        // named (VibeX will not silently tail-fork a historical cut).
        AgentKind::ClaudeCode => {
            let message_id = turn.agent_message_id.clone()?;
            let text = turn_text(turn);
            let fingerprint = (!text.trim().is_empty()).then(|| fingerprint_agent_message(&text));
            let occurrence = fingerprint
                .as_ref()
                .map(|fp| fingerprint_occurrence(turns, idx, fp));
            Some(ForkPoint {
                message_id,
                message_fingerprint: fingerprint,
                message_occurrence: occurrence.and_then(|n| u32::try_from(n).ok()),
            })
        }
        AgentKind::Codex => {
            let text = turn_text(turn);
            if text.trim().is_empty() {
                return None;
            }
            let fingerprint = fingerprint_agent_message(&text);
            let occurrence = fingerprint_occurrence(turns, idx, &fingerprint);
            Some(ForkPoint {
                message_id: turn_id.to_string(),
                message_fingerprint: Some(fingerprint),
                message_occurrence: u32::try_from(occurrence).ok(),
            })
        }
        AgentKind::DeepseekHarness => {
            let text = turn_text(turn);
            let fingerprint = (!text.trim().is_empty()).then(|| fingerprint_agent_message(&text));
            if turn.agent_message_id.is_none() && fingerprint.is_none() {
                return None;
            }
            let occurrence = fingerprint
                .as_ref()
                .map(|fp| fingerprint_occurrence(turns, idx, fp));
            Some(ForkPoint {
                message_id: turn
                    .agent_message_id
                    .clone()
                    .unwrap_or_else(|| turn_id.to_string()),
                message_fingerprint: fingerprint,
                message_occurrence: occurrence.and_then(|n| u32::try_from(n).ok()),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    fn assistant(id: &str, text: &str, agent_message_id: Option<&str>) -> MessageTurn {
        MessageTurn {
            id: id.into(),
            role: TurnRole::Assistant,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            timestamp: Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: agent_message_id.map(str::to_string),
        }
    }

    #[test]
    fn meta_matches_air_block() {
        let meta = ForkPoint {
            message_id: "msg_01".into(),
            message_fingerprint: Some("sha256:ab".into()),
            message_occurrence: Some(2),
        }
        .to_meta();
        assert_eq!(
            meta["jetbrains"]["air"]["fork"]["version"],
            serde_json::json!(1)
        );
        assert_eq!(
            meta["jetbrains"]["air"]["fork"]["messageId"],
            serde_json::json!("msg_01")
        );
        assert_eq!(
            meta["jetbrains"]["air"]["fork"]["messageFingerprint"],
            serde_json::json!("sha256:ab")
        );
        assert_eq!(
            meta["jetbrains"]["air"]["fork"]["messageOccurrence"],
            serde_json::json!(2)
        );
    }

    #[test]
    fn claude_sends_id_and_fingerprint_together() {
        let turns = vec![assistant("t1:assistant", "hello", Some("msg_claude"))];
        let point = resolve_fork_point(&turns, "t1:assistant", AgentKind::ClaudeCode).unwrap();
        assert_eq!(point.message_id, "msg_claude");
        assert_eq!(
            point.message_fingerprint.as_deref(),
            Some(fingerprint_agent_message("hello").as_str())
        );
        assert_eq!(point.message_occurrence, Some(1));
    }

    #[test]
    fn claude_named_textless_turn_is_id_only() {
        let mut turn = assistant("t1:assistant", "", Some("msg_01"));
        turn.blocks = Vec::new();
        let point = resolve_fork_point(&[turn], "t1:assistant", AgentKind::ClaudeCode).unwrap();
        assert_eq!(point.message_id, "msg_01");
        assert!(point.message_fingerprint.is_none());
        assert!(point.message_occurrence.is_none());
    }

    #[test]
    fn claude_unnamed_is_none() {
        let turns = vec![assistant("t1:assistant", "hello", None)];
        assert!(resolve_fork_point(&turns, "t1:assistant", AgentKind::ClaudeCode).is_none());
    }

    #[test]
    fn claude_declines_a_synthesized_turn_with_neither_id_nor_text() {
        let mut turn = assistant("t1:assistant", "", None);
        turn.blocks = vec![ContentBlock::ToolUse {
            tool_use_id: Some("tl-tool-0".into()),
            tool_name: "Bash".into(),
            kind: None,
            input_preview: None,
            meta: None,
            images: Vec::new(),
        }];
        assert!(resolve_fork_point(&[turn], "t1:assistant", AgentKind::ClaudeCode).is_none());
    }

    #[test]
    fn claude_counts_repeated_answers() {
        let turns = vec![
            assistant("a:assistant", "same", Some("msg_a")),
            assistant("b:assistant", "same", Some("msg_b")),
        ];
        assert_eq!(
            resolve_fork_point(&turns, "a:assistant", AgentKind::ClaudeCode)
                .unwrap()
                .message_occurrence,
            Some(1)
        );
        assert_eq!(
            resolve_fork_point(&turns, "b:assistant", AgentKind::ClaudeCode)
                .unwrap()
                .message_occurrence,
            Some(2)
        );
    }

    #[test]
    fn codex_uses_fingerprint_occurrence() {
        let turns = vec![
            assistant("a:assistant", "same", None),
            assistant("b:assistant", "same", None),
        ];
        let point = resolve_fork_point(&turns, "b:assistant", AgentKind::Codex).unwrap();
        assert_eq!(point.message_id, "b:assistant");
        assert_eq!(point.message_occurrence, Some(2));
        assert!(
            point
                .message_fingerprint
                .as_deref()
                .is_some_and(|fp| fp.starts_with("sha256:"))
        );
    }

    #[test]
    fn other_agents_cannot_name_a_historical_point() {
        let turns = vec![assistant("t1:assistant", "hello", Some("id"))];
        assert!(resolve_fork_point(&turns, "t1:assistant", AgentKind::KimiCode).is_none());
        assert!(resolve_fork_point(&turns, "t1:assistant", AgentKind::Qoder).is_none());
        assert!(resolve_fork_point(&turns, "t1:assistant", AgentKind::Grok).is_none());
    }

    #[test]
    fn deepseek_sends_log_id_and_fingerprint() {
        let turns = vec![assistant("t1:assistant", "hello", Some("uuid-a2"))];
        let point = resolve_fork_point(&turns, "t1:assistant", AgentKind::DeepseekHarness).unwrap();
        assert_eq!(point.message_id, "uuid-a2");
        assert!(
            point
                .message_fingerprint
                .as_deref()
                .is_some_and(|fp| fp.starts_with("sha256:"))
        );
        assert_eq!(point.message_occurrence, Some(1));
    }

    #[test]
    fn deepseek_unnamed_text_forks_by_fingerprint() {
        let turns = vec![assistant("t1:assistant", "hello", None)];
        let point = resolve_fork_point(&turns, "t1:assistant", AgentKind::DeepseekHarness).unwrap();
        assert_eq!(point.message_id, "t1:assistant");
        assert!(point.message_fingerprint.is_some());
    }

    #[test]
    fn deepseek_textless_named_turn_forks_by_id() {
        let turns = vec![assistant("t1:assistant", "  ", Some("uuid-a1"))];
        let point = resolve_fork_point(&turns, "t1:assistant", AgentKind::DeepseekHarness).unwrap();
        assert_eq!(point.message_id, "uuid-a1");
        assert!(point.message_fingerprint.is_none());
    }

    #[test]
    fn deepseek_textless_unnamed_turn_is_not_a_fork_point() {
        let turns = vec![assistant("t1:assistant", "", None)];
        assert!(resolve_fork_point(&turns, "t1:assistant", AgentKind::DeepseekHarness).is_none());
    }

    #[test]
    fn deepseek_repeated_text_uses_occurrence() {
        let turns = vec![
            assistant("a:assistant", "same", None),
            assistant("b:assistant", "same", None),
            assistant("c:assistant", "same", None),
        ];
        let point = resolve_fork_point(&turns, "c:assistant", AgentKind::DeepseekHarness).unwrap();
        assert_eq!(point.message_occurrence, Some(3));
    }

    #[test]
    fn steered_turn_names_the_last_assistant_bubble() {
        let turns = vec![
            assistant("t1:assistant", "first", Some("msg_first")),
            assistant("t1:assistant:2", "second", Some("msg_second")),
        ];
        let point = resolve_fork_point_for_turn(&turns, "t1", AgentKind::ClaudeCode).unwrap();
        assert_eq!(point.message_id, "msg_second");
    }

    #[test]
    fn classify_tail_even_without_a_name() {
        let turns = vec![assistant("t1:assistant", "hello", None)];
        assert_eq!(
            classify_fork_point(&turns, "t1:assistant", AgentKind::ClaudeCode, true, true),
            ForkPointStatus::Tail
        );
        assert_eq!(
            classify_fork_point(&turns, "t1:assistant", AgentKind::ClaudeCode, true, false),
            ForkPointStatus::Unnamed
        );
        assert_eq!(
            classify_fork_point(&turns, "t1:assistant", AgentKind::ClaudeCode, false, true),
            ForkPointStatus::Unsupported
        );
    }

    #[test]
    fn steered_turn_without_last_message_id_is_unnamed_for_claude() {
        let turns = vec![
            assistant("t1:assistant", "first", Some("msg_first")),
            assistant("t1:assistant:2", "second", None),
        ];
        assert!(resolve_fork_point_for_turn(&turns, "t1", AgentKind::ClaudeCode).is_none());
    }
}
