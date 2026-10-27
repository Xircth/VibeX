//! Session-request `_meta` that must ride on every Claude session RPC
//! (`session/new`, `load`, `resume`, `fork`), plus AIR `promptSuggestions`
//! extraction.
//!
//! claude-agent-acp 0.82+ treats an AIR client that does not subscribe to raw
//! SDK messages as missing tool `_meta`, subagent text, and permission
//! presentation. claude-agent-acp 0.92.0+ also enables SDK promptSuggestions by
//! default for AIR clients: interactive Composer sessions pass
//! `wants_prompt_suggestions = true`, whereas one-shot / headless / automation
//! connections pass `false` so the adapter does not run a post-turn prediction
//! call. Every session RPC (`new`/`load`/`resume`/`fork`) on the same
//! connection must carry the identical `_meta.claudeCode` object so the adapter
//! never restarts the session due to option drift.

use api_types::{AgentId, AgentKind};
use serde_json::{Map, Value};

use crate::{
    air_contract::{legacy_or_air, speaks_air_contract},
    fork::ForkPoint,
};

/// `_meta.claudeCode` for Claude; `None` otherwise.
///
/// - Always sets `emitRawSDKMessages: true`.
/// - When `!wants_prompt_suggestions`, also sets `options.promptSuggestions: false`.
pub(crate) fn claude_raw_sdk_session_meta(
    agent_id: &AgentId,
    wants_prompt_suggestions: bool,
) -> Option<Map<String, Value>> {
    if AgentKind::from_lenient(agent_id.as_str()) != Some(AgentKind::ClaudeCode) {
        return None;
    }
    let mut claude_code = Map::new();
    claude_code.insert("emitRawSDKMessages".to_string(), Value::Bool(true));
    if !wants_prompt_suggestions {
        let mut options = Map::new();
        options.insert("promptSuggestions".to_string(), Value::Bool(false));
        claude_code.insert("options".to_string(), Value::Object(options));
    }
    let mut meta = Map::new();
    meta.insert("claudeCode".to_string(), Value::Object(claude_code));
    Some(meta)
}

/// Merge Claude raw-SDK settings with an optional AIR fork point. Disjoint
/// keys: fork lives under `jetbrains`, session settings under `claudeCode`.
pub(crate) fn session_request_meta(
    agent_id: &AgentId,
    fork_point: Option<&ForkPoint>,
    wants_prompt_suggestions: bool,
) -> Option<Map<String, Value>> {
    let mut meta = fork_point
        .and_then(|point| point.to_meta().as_object().cloned())
        .unwrap_or_default();
    if let Some(session_meta) = claude_raw_sdk_session_meta(agent_id, wants_prompt_suggestions) {
        meta.extend(session_meta);
    }
    (!meta.is_empty()).then_some(meta)
}

fn first_non_empty_suggestion(suggestions: &[Value]) -> Option<String> {
    suggestions.iter().find_map(|entry| {
        entry
            .get("text")
            .or_else(|| entry.get("prompt"))
            .and_then(Value::as_str)
            .or_else(|| entry.as_str())
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(ToOwned::to_owned)
    })
}

/// Extract a prompt suggestion update from `session_info_update._meta`:
/// - `None`: no `promptSuggestions` field present in `_meta` (leave state unchanged)
/// - `Some(Some(text))`: set current suggestion to `text`
/// - `Some(None)`: withdraw/clear current suggestion
pub(crate) fn prompt_suggestion_update(
    agent_kind: Option<AgentKind>,
    meta: Option<&Map<String, Value>>,
) -> Option<Option<String>> {
    if !agent_kind.is_none_or(speaks_air_contract) {
        return None;
    }
    let container = legacy_or_air(meta, "promptSuggestions")?;
    if container.is_null() {
        return Some(None);
    }
    let suggestions = container.get("suggestions")?.as_array()?;
    Some(first_non_empty_suggestion(suggestions))
}

/// Extract a prompt suggestion update from a `prompt_suggestion_update`
/// `sessionUpdate` frame.
pub(crate) fn prompt_suggestion_from_session_update(
    agent_kind: Option<AgentKind>,
    update: &Value,
) -> Option<Option<String>> {
    if !agent_kind.is_none_or(speaks_air_contract) {
        return None;
    }
    let obj = update.as_object()?;
    if obj.get("sessionUpdate").and_then(Value::as_str) != Some("prompt_suggestion_update") {
        return None;
    }
    if let Some(from_meta) =
        prompt_suggestion_update(agent_kind, obj.get("_meta").and_then(Value::as_object))
    {
        return Some(from_meta);
    }
    if let Some(suggestions) = obj.get("suggestions").and_then(Value::as_array) {
        return Some(first_non_empty_suggestion(suggestions));
    }
    let single = obj
        .get("suggestion")
        .or_else(|| obj.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned);
    Some(single)
}

#[cfg(test)]
mod tests {
    use api_types::AgentId;
    use serde_json::json;

    use super::*;

    #[test]
    fn claude_raw_sdk_meta_respects_wants_prompt_suggestions() {
        let claude = AgentId::parse("claude_code").unwrap();
        let interactive =
            claude_raw_sdk_session_meta(&claude, true).expect("Claude interactive meta");
        assert_eq!(
            Value::Object(interactive),
            json!({
                "claudeCode": {
                    "emitRawSDKMessages": true
                }
            })
        );

        let headless = claude_raw_sdk_session_meta(&claude, false).expect("Claude headless meta");
        assert_eq!(
            Value::Object(headless),
            json!({
                "claudeCode": {
                    "emitRawSDKMessages": true,
                    "options": {
                        "promptSuggestions": false
                    }
                }
            })
        );
        assert!(claude_raw_sdk_session_meta(&AgentId::parse("codex").unwrap(), true).is_none());
        assert!(claude_raw_sdk_session_meta(&AgentId::parse("grok").unwrap(), false).is_none());
    }

    #[test]
    fn a_claude_fork_point_rides_beside_the_session_settings() {
        let claude = AgentId::parse("claude_code").unwrap();
        let point = ForkPoint {
            message_id: "msg_01".into(),
            message_fingerprint: None,
            message_occurrence: None,
        };
        let meta = session_request_meta(&claude, Some(&point), true).expect("merged meta");
        assert_eq!(
            Value::Object(meta),
            json!({
                "claudeCode": {
                    "emitRawSDKMessages": true
                },
                "jetbrains": {"air": {"fork": {"version": 1, "messageId": "msg_01"}}},
            })
        );

        let headless_meta =
            session_request_meta(&claude, Some(&point), false).expect("merged headless meta");
        assert_eq!(
            Value::Object(headless_meta),
            json!({
                "claudeCode": {
                    "emitRawSDKMessages": true,
                    "options": {
                        "promptSuggestions": false
                    }
                },
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
        let meta = session_request_meta(&AgentId::parse("codex").unwrap(), Some(&point), true)
            .expect("fork");
        assert!(meta.get("claudeCode").is_none());
        assert_eq!(meta["jetbrains"]["air"]["fork"]["messageId"], json!("t1"));
    }

    #[test]
    fn extracts_and_withdraws_prompt_suggestions_from_meta_and_session_update() {
        let meta = json!({
            "jetbrains": {
                "air": {
                    "promptSuggestions": {
                        "version": 1,
                        "suggestions": [
                            { "text": "  Run cargo test  " },
                            { "text": "Commit changes" }
                        ]
                    }
                }
            }
        });
        assert_eq!(
            prompt_suggestion_update(Some(AgentKind::ClaudeCode), meta.as_object()),
            Some(Some("Run cargo test".to_string()))
        );

        let withdrawn = json!({
            "promptSuggestions": {
                "suggestions": []
            }
        });
        assert_eq!(
            prompt_suggestion_update(Some(AgentKind::ClaudeCode), withdrawn.as_object()),
            Some(None)
        );

        let direct_frame = json!({
            "sessionUpdate": "prompt_suggestion_update",
            "suggestions": [{ "text": "Explain the failing test" }]
        });
        assert_eq!(
            prompt_suggestion_from_session_update(Some(AgentKind::ClaudeCode), &direct_frame),
            Some(Some("Explain the failing test".to_string()))
        );
    }
}
