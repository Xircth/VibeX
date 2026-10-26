//! Session-request `_meta` that must ride on every Claude session RPC
//! (`session/new`, `load`, `resume`, `fork`).
//!
//! claude-agent-acp 0.82+ treats an AIR client that does not subscribe to raw
//! SDK messages as missing tool `_meta`, subagent text, and permission
//! presentation.

use api_types::{AgentId, AgentKind};

use crate::fork::ForkPoint;

/// `_meta.claudeCode.emitRawSDKMessages: true` for Claude; `None` otherwise.
pub(crate) fn claude_raw_sdk_session_meta(
    agent_id: &AgentId,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    if AgentKind::from_lenient(agent_id.as_str()) != Some(AgentKind::ClaudeCode) {
        return None;
    }
    let mut claude_code = serde_json::Map::new();
    claude_code.insert(
        "emitRawSDKMessages".to_string(),
        serde_json::Value::Bool(true),
    );
    let mut meta = serde_json::Map::new();
    meta.insert(
        "claudeCode".to_string(),
        serde_json::Value::Object(claude_code),
    );
    Some(meta)
}

/// Merge Claude raw-SDK settings with an optional AIR fork point. Disjoint
/// keys: fork lives under `jetbrains`, session settings under `claudeCode`.
pub(crate) fn session_request_meta(
    agent_id: &AgentId,
    fork_point: Option<&ForkPoint>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let mut meta = fork_point
        .and_then(|point| point.to_meta().as_object().cloned())
        .unwrap_or_default();
    if let Some(session_meta) = claude_raw_sdk_session_meta(agent_id) {
        meta.extend(session_meta);
    }
    (!meta.is_empty()).then_some(meta)
}

#[cfg(test)]
mod tests {
    use api_types::AgentId;

    use super::*;

    #[test]
    fn claude_raw_sdk_meta_enabled_only_for_claude() {
        let claude = AgentId::parse("claude_code").unwrap();
        let meta = claude_raw_sdk_session_meta(&claude).expect("Claude must have raw SDK meta");
        assert_eq!(
            meta.get("claudeCode")
                .and_then(|v| v.get("emitRawSDKMessages"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            serde_json::Value::Object(meta),
            serde_json::json!({"claudeCode": {"emitRawSDKMessages": true}})
        );
        assert!(claude_raw_sdk_session_meta(&AgentId::parse("codex").unwrap()).is_none());
        assert!(claude_raw_sdk_session_meta(&AgentId::parse("grok").unwrap()).is_none());
    }

    #[test]
    fn a_claude_fork_point_rides_beside_the_session_settings() {
        let claude = AgentId::parse("claude_code").unwrap();
        let point = ForkPoint {
            message_id: "msg_01".into(),
            message_fingerprint: None,
            message_occurrence: None,
        };
        let meta = session_request_meta(&claude, Some(&point)).expect("merged meta");
        assert_eq!(
            serde_json::Value::Object(meta),
            serde_json::json!({
                "claudeCode": {"emitRawSDKMessages": true},
                "jetbrains": {"air": {"fork": {"version": 1, "messageId": "msg_01"}}},
            })
        );
    }

    #[test]
    fn a_codex_fork_keeps_only_the_air_fork_block() {
        let point = ForkPoint {
            message_id: "t1".into(),
            message_fingerprint: None,
            message_occurrence: None,
        };
        let meta =
            session_request_meta(&AgentId::parse("codex").unwrap(), Some(&point)).expect("fork");
        assert!(meta.get("claudeCode").is_none());
        assert_eq!(
            meta["jetbrains"]["air"]["fork"]["messageId"],
            serde_json::json!("t1")
        );
    }
}
