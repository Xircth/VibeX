//! Map an ACP turn's stop reason onto a [`DelegationOutcome`].
//!
//! VibeX surfaces a turn's stop reason as `Option<String>`: for a real turn it
//! is the `Debug` form of `agent_client_protocol::StopReason` (PascalCase, e.g.
//! `"EndTurn"`, `"MaxTokens"`), and a few code paths hardcode snake forms
//! (`"end_turn"`, `"cancelled"`). We normalize case + separators so both forms
//! map identically, and fall back to [`DelegationError::ChildUnknown`] for
//! anything unrecognized rather than guessing.

use agents::registry::AgentType;
use uuid::Uuid;

use crate::types::{DelegationError, DelegationOutcome, DelegationSuccess};

/// Normalized classification of an ACP stop reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopClass {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
    Unknown(String),
}

/// Lowercase and strip `_`/whitespace so `"EndTurn"`, `"end_turn"` and
/// `"end turn"` all collapse to `endturn`.
fn normalize(raw: &str) -> String {
    raw.chars()
        .filter(|c| *c != '_' && !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Classify a stop reason. `None` is treated as a clean `EndTurn` (the
/// empty-output guard in [`outcome_from_turn`] then decides success vs empty).
pub fn classify_stop_reason(stop_reason: Option<&str>) -> StopClass {
    let raw = match stop_reason {
        Some(value) => value,
        None => return StopClass::EndTurn,
    };
    match normalize(raw).as_str() {
        "endturn" => StopClass::EndTurn,
        "maxtokens" => StopClass::MaxTokens,
        "maxturnrequests" => StopClass::MaxTurnRequests,
        "refusal" => StopClass::Refusal,
        "cancelled" | "canceled" => StopClass::Cancelled,
        _ => StopClass::Unknown(raw.to_string()),
    }
}

/// Build the broker outcome for a child turn that has finished.
pub fn outcome_from_turn(
    stop_reason: Option<&str>,
    text: String,
    child_session_id: Uuid,
    child_agent_type: AgentType,
    turn_count: u32,
    duration_ms: u64,
) -> DelegationOutcome {
    let child = Some(child_session_id);
    match classify_stop_reason(stop_reason) {
        StopClass::EndTurn => {
            if text.trim().is_empty() {
                DelegationOutcome::from_err(DelegationError::ChildEmpty, child)
            } else {
                DelegationOutcome::Ok(DelegationSuccess {
                    text,
                    child_session_id,
                    child_agent_type,
                    turn_count,
                    duration_ms,
                    token_usage: None,
                })
            }
        }
        StopClass::MaxTokens => DelegationOutcome::from_err(DelegationError::ChildMaxTokens, child),
        StopClass::MaxTurnRequests => {
            DelegationOutcome::from_err(DelegationError::ChildMaxTurnRequests, child)
        }
        StopClass::Refusal => DelegationOutcome::from_err(DelegationError::ChildRefusal, child),
        StopClass::Cancelled => DelegationOutcome::from_err(
            DelegationError::Canceled {
                reason: "child turn cancelled".to_string(),
            },
            child,
        ),
        StopClass::Unknown(raw) => {
            DelegationOutcome::from_err(DelegationError::ChildUnknown(raw), child)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_debug_pascal_and_snake_forms_alike() {
        assert_eq!(classify_stop_reason(Some("EndTurn")), StopClass::EndTurn);
        assert_eq!(classify_stop_reason(Some("end_turn")), StopClass::EndTurn);
        assert_eq!(classify_stop_reason(Some("MaxTokens")), StopClass::MaxTokens);
        assert_eq!(
            classify_stop_reason(Some("max_turn_requests")),
            StopClass::MaxTurnRequests
        );
        assert_eq!(classify_stop_reason(Some("Refusal")), StopClass::Refusal);
        assert_eq!(classify_stop_reason(Some("Cancelled")), StopClass::Cancelled);
        assert_eq!(classify_stop_reason(Some("canceled")), StopClass::Cancelled);
        assert_eq!(classify_stop_reason(None), StopClass::EndTurn);
    }

    #[test]
    fn unknown_reason_is_preserved_verbatim() {
        assert_eq!(
            classify_stop_reason(Some("WeirdReason")),
            StopClass::Unknown("WeirdReason".to_string())
        );
    }

    #[test]
    fn end_turn_with_text_is_success() {
        let outcome = outcome_from_turn(
            Some("EndTurn"),
            "done".to_string(),
            Uuid::nil(),
            AgentType::Codex,
            1,
            10,
        );
        assert!(matches!(outcome, DelegationOutcome::Ok(_)));
    }

    #[test]
    fn end_turn_without_text_is_child_empty() {
        let outcome = outcome_from_turn(
            Some("EndTurn"),
            "   ".to_string(),
            Uuid::nil(),
            AgentType::Codex,
            1,
            10,
        );
        match outcome {
            DelegationOutcome::Err { code, .. } => assert_eq!(code, "child_empty"),
            DelegationOutcome::Ok(_) => panic!("expected empty error"),
        }
    }

    #[test]
    fn max_tokens_and_refusal_map_to_their_codes() {
        for (reason, expected) in [("MaxTokens", "child_max_tokens"), ("Refusal", "child_refusal")]
        {
            let outcome =
                outcome_from_turn(Some(reason), "x".to_string(), Uuid::nil(), AgentType::Codex, 1, 1);
            match outcome {
                DelegationOutcome::Err { code, .. } => assert_eq!(code, expected),
                DelegationOutcome::Ok(_) => panic!("expected error for {reason}"),
            }
        }
    }
}
