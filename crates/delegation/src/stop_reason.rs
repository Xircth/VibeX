//! Map an ACP turn's stop reason onto a [`DelegationOutcome`].
//!
//! VibeX surfaces a turn's stop reason as `Option<String>`: for a real turn it
//! is the `Debug` form of `agent_client_protocol::StopReason` (PascalCase, e.g.
//! `"EndTurn"`, `"MaxTokens"`), and a few code paths hardcode snake forms
//! (`"end_turn"`, `"cancelled"`). We normalize case + separators so both forms
//! map identically, and fall back to [`DelegationError::ChildUnknown`] for
//! anything unrecognized rather than guessing.

use std::collections::HashMap;

use agents::{AgentConnectionStatus, AgentContentBlock, AgentEvent, AgentEventEnvelope, AgentId};
use uuid::Uuid;

use crate::{
    assistant_reply::AssistantReplyAccumulator,
    types::{DelegationError, DelegationOutcome, DelegationSuccess},
};

/// Active child entry tracked by the runtime delegation resolver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolverEntry {
    pub call_id: String,
    pub agent_type: AgentId,
    pub connection_id: String,
}

/// Process a single [`AgentEventEnvelope`] against the active delegation child
/// map and reply accumulators, returning any terminal `(call_id, outcome)`
/// pairs that should be reported to [` crate::DelegationBroker::complete_call`].
pub fn process_resolver_event(
    envelope: &AgentEventEnvelope,
    map: &mut HashMap<Uuid, ResolverEntry>,
    replies: &mut HashMap<Uuid, AssistantReplyAccumulator>,
) -> Vec<(String, DelegationOutcome)> {
    match &envelope.event {
        AgentEvent::ConnectionStatusChanged { snapshot }
            if matches!(
                snapshot.status,
                AgentConnectionStatus::Disconnected | AgentConnectionStatus::Failed
            ) =>
        {
            let target_conn = snapshot.id.to_string();
            let message = snapshot
                .status_message
                .clone()
                .filter(|msg| !msg.trim().is_empty())
                .unwrap_or_else(|| format!("child connection {:?}", snapshot.status));
            drain_by_connection(map, replies, &target_conn, &message)
        }
        AgentEvent::Error { error } => {
            if let Some(session_id) = envelope.session_id.map(|id| id.0) {
                if let Some(entry) = map.remove(&session_id) {
                    replies.remove(&session_id);
                    return vec![(
                        entry.call_id,
                        DelegationOutcome::from_err(
                            DelegationError::SubagentRuntimeError(error.message.clone()),
                            Some(session_id),
                        ),
                    )];
                }
                Vec::new()
            } else {
                let target_conn = envelope.connection_id.to_string();
                drain_by_connection(map, replies, &target_conn, &error.message)
            }
        }
        AgentEvent::SessionLoadFailed { reason } => {
            let Some(session_id) = envelope.session_id.map(|id| id.0) else {
                return Vec::new();
            };
            if let Some(entry) = map.remove(&session_id) {
                replies.remove(&session_id);
                return vec![(
                    entry.call_id,
                    DelegationOutcome::from_err(
                        DelegationError::SubagentRuntimeError(format!(
                            "child session load failed: {reason:?}"
                        )),
                        Some(session_id),
                    ),
                )];
            }
            Vec::new()
        }
        AgentEvent::MessageChunk {
            content: AgentContentBlock::Text { text },
        } => {
            if let Some(session_id) = envelope.session_id.map(|id| id.0)
                && map.contains_key(&session_id)
            {
                replies.entry(session_id).or_default().push_text(text);
            }
            Vec::new()
        }
        AgentEvent::ToolCall { .. } => {
            if let Some(session_id) = envelope.session_id.map(|id| id.0)
                && map.contains_key(&session_id)
                && let Some(reply) = replies.get_mut(&session_id)
            {
                reply.start_tool();
            }
            Vec::new()
        }
        AgentEvent::PromptFinished { finished } => {
            let Some(session_id) = envelope.session_id.map(|id| id.0) else {
                return Vec::new();
            };
            if let Some(entry) = map.remove(&session_id) {
                let body = replies.remove(&session_id).unwrap_or_default().finish();
                let outcome = outcome_from_turn(
                    finished.stop_reason.as_deref(),
                    body,
                    session_id,
                    entry.agent_type,
                    1,
                    0,
                );
                return vec![(entry.call_id, outcome)];
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn drain_by_connection(
    map: &mut HashMap<Uuid, ResolverEntry>,
    replies: &mut HashMap<Uuid, AssistantReplyAccumulator>,
    connection_id: &str,
    message: &str,
) -> Vec<(String, DelegationOutcome)> {
    let matched_sessions: Vec<Uuid> = map
        .iter()
        .filter_map(|(session_id, entry)| {
            (entry.connection_id == connection_id).then_some(*session_id)
        })
        .collect();
    let mut completed = Vec::with_capacity(matched_sessions.len());
    for session_id in matched_sessions {
        if let Some(entry) = map.remove(&session_id) {
            replies.remove(&session_id);
            completed.push((
                entry.call_id,
                DelegationOutcome::from_err(
                    DelegationError::SubagentRuntimeError(message.to_string()),
                    Some(session_id),
                ),
            ));
        }
    }
    completed
}

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
    child_agent_type: AgentId,
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
        assert_eq!(
            classify_stop_reason(Some("MaxTokens")),
            StopClass::MaxTokens
        );
        assert_eq!(
            classify_stop_reason(Some("max_turn_requests")),
            StopClass::MaxTurnRequests
        );
        assert_eq!(classify_stop_reason(Some("Refusal")), StopClass::Refusal);
        assert_eq!(
            classify_stop_reason(Some("Cancelled")),
            StopClass::Cancelled
        );
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
            AgentId::parse("codex").unwrap(),
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
            AgentId::parse("codex").unwrap(),
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
        for (reason, expected) in [
            ("MaxTokens", "child_max_tokens"),
            ("Refusal", "child_refusal"),
        ] {
            let outcome = outcome_from_turn(
                Some(reason),
                "x".to_string(),
                Uuid::nil(),
                AgentId::parse("codex").unwrap(),
                1,
                1,
            );
            match outcome {
                DelegationOutcome::Err { code, .. } => assert_eq!(code, expected),
                DelegationOutcome::Ok(_) => panic!("expected error for {reason}"),
            }
        }
    }

    #[test]
    fn resolver_completes_child_on_session_error_and_connection_disconnect() {
        use agents::{
            AgentConnectionSnapshot,
            events::AgentErrorEvent,
            ids::{AgentConnectionId, AgentSessionId},
        };
        use chrono::Utc;

        let mut map = HashMap::new();
        let mut replies = HashMap::new();
        let conn_1 = AgentConnectionId::new();
        let sess_1 = Uuid::new_v4();
        let conn_2 = AgentConnectionId::new();
        let sess_2 = Uuid::new_v4();
        let agent_type = AgentId::parse("codex").unwrap();

        map.insert(
            sess_1,
            ResolverEntry {
                call_id: "call-1".to_string(),
                agent_type: agent_type.clone(),
                connection_id: conn_1.to_string(),
            },
        );
        map.insert(
            sess_2,
            ResolverEntry {
                call_id: "call-2".to_string(),
                agent_type: agent_type.clone(),
                connection_id: conn_2.to_string(),
            },
        );

        let err_env = AgentEventEnvelope {
            sequence: 1,
            workspace_id: Uuid::new_v4(),
            connection_id: conn_1,
            session_id: Some(AgentSessionId::from(sess_1)),
            event: AgentEvent::Error {
                error: AgentErrorEvent {
                    message: "ACP child crashed".to_string(),
                    code: Some("internal_error".to_string()),
                    raw: None,
                },
            },
            created_at: Utc::now(),
        };
        let resolved_1 = process_resolver_event(&err_env, &mut map, &mut replies);
        assert_eq!(resolved_1.len(), 1);
        assert_eq!(resolved_1[0].0, "call-1");
        match &resolved_1[0].1 {
            DelegationOutcome::Err {
                code,
                message,
                child_session_id,
            } => {
                assert_eq!(code, "subagent_error");
                assert!(message.contains("ACP child crashed"));
                assert_eq!(*child_session_id, Some(sess_1));
            }
            DelegationOutcome::Ok(_) => panic!("expected error outcome"),
        }
        assert!(!map.contains_key(&sess_1));

        let disc_env = AgentEventEnvelope {
            sequence: 2,
            workspace_id: Uuid::new_v4(),
            connection_id: conn_2,
            session_id: None,
            event: AgentEvent::ConnectionStatusChanged {
                snapshot: AgentConnectionSnapshot {
                    id: conn_2,
                    agent_id: agent_type,
                    workspace_id: Uuid::new_v4(),
                    status: AgentConnectionStatus::Disconnected,
                    working_dir: "/tmp".to_string(),
                    status_message: Some("process exited".to_string()),
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                },
            },
            created_at: Utc::now(),
        };
        let resolved_2 = process_resolver_event(&disc_env, &mut map, &mut replies);
        assert_eq!(resolved_2.len(), 1);
        assert_eq!(resolved_2[0].0, "call-2");
        match &resolved_2[0].1 {
            DelegationOutcome::Err {
                code,
                message,
                child_session_id,
            } => {
                assert_eq!(code, "subagent_error");
                assert!(message.contains("process exited"));
                assert_eq!(*child_session_id, Some(sess_2));
            }
            DelegationOutcome::Ok(_) => panic!("expected error outcome"),
        }
        assert!(map.is_empty());
    }
}
