//! ACP `session/fork` cut-point naming (JetBrains AIR `_meta`).
//!
//! Agents that implement historical fork read
//! `_meta.jetbrains.air.fork = { version, messageId, messageFingerprint?,
//! messageOccurrence? }`. An agent that does not understand the block forks at
//! the tail, so this crate only attaches the block when the turn can be named.

use sha2::{Digest, Sha256};

use crate::{
    AgentKind,
    conversation::{ContentBlock, MessageTurn, TurnRole},
};

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
        AgentKind::ClaudeCode => turn.agent_message_id.clone().map(|message_id| ForkPoint {
            message_id,
            message_fingerprint: None,
            message_occurrence: None,
        }),
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
    fn claude_names_message_id_only() {
        let turns = vec![assistant("t1:assistant", "hello", Some("msg_claude"))];
        let point = resolve_fork_point(&turns, "t1:assistant", AgentKind::ClaudeCode).unwrap();
        assert_eq!(point.message_id, "msg_claude");
        assert!(point.message_fingerprint.is_none());
    }

    #[test]
    fn claude_unnamed_is_none() {
        let turns = vec![assistant("t1:assistant", "hello", None)];
        assert!(resolve_fork_point(&turns, "t1:assistant", AgentKind::ClaudeCode).is_none());
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
    fn steered_turn_names_the_last_assistant_bubble() {
        let turns = vec![
            assistant("t1:assistant", "first", Some("msg_first")),
            assistant("t1:assistant:2", "second", Some("msg_second")),
        ];
        let point = resolve_fork_point_for_turn(&turns, "t1", AgentKind::ClaudeCode).unwrap();
        assert_eq!(point.message_id, "msg_second");
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
