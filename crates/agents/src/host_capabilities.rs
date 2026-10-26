//! Per-agent `initialize` client capabilities. Form elicitation, AIR
//! `diffPatch`, and `terminal_output_delta` are agent-scoped the way Codeg
//! scopes them. Cursor `parameterizedModelPicker` is intentionally omitted.

use agent_client_protocol::schema::v1::{
    BooleanConfigOptionCapabilities, ClientCapabilities, ClientSessionCapabilities,
    ElicitationCapabilities, ElicitationFormCapabilities, SessionConfigOptionsCapabilities,
};
use api_types::{AgentId, AgentKind};

pub(crate) fn build_client_capabilities(agent_id: &AgentId) -> ClientCapabilities {
    let kind = AgentKind::from_lenient(agent_id.as_str());
    let mut client_capabilities = ClientCapabilities::new().terminal(true).session(
        ClientSessionCapabilities::new().config_options(
            SessionConfigOptionsCapabilities::new().boolean(BooleanConfigOptionCapabilities::new()),
        ),
    );
    if matches!(
        kind,
        Some(AgentKind::Codex | AgentKind::DeepseekHarness | AgentKind::Qoder)
    ) {
        client_capabilities = client_capabilities
            .elicitation(ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()));
    }

    let mut meta = serde_json::Map::new();
    if kind == Some(AgentKind::ClaudeCode) {
        meta.insert(
            "subagent-transcript".to_string(),
            serde_json::Value::Bool(true),
        );
    }
    if matches!(kind, Some(AgentKind::ClaudeCode | AgentKind::Codex)) {
        let capabilities: &[&str] = if kind == Some(AgentKind::Codex) {
            &[
                "sessionFailure",
                "asyncTasks",
                "recommendedValue",
                "diffPatch",
            ]
        } else {
            &["sessionFailure", "asyncTasks", "recommendedValue"]
        };
        let air_contract = serde_json::json!({
            "version": 1,
            "sessionFailure": true,
            "asyncTasks": true,
            "recommendedValue": true,
            "capabilities": capabilities,
        });
        meta.insert("jetbrains.air".to_string(), air_contract.clone());
        meta.insert(
            "jetbrains".to_string(),
            serde_json::json!({ "air": air_contract }),
        );
    }
    if kind == Some(AgentKind::Codex) {
        meta.insert(
            "terminal_output_delta".to_string(),
            serde_json::Value::Bool(true),
        );
    }
    if !meta.is_empty() {
        client_capabilities = client_capabilities.meta(meta);
    }
    client_capabilities
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps_of(id: &str) -> serde_json::Value {
        serde_json::to_value(build_client_capabilities(&AgentId::parse(id).unwrap()))
            .expect("caps serialize")
    }

    fn air_capabilities(id: &str) -> Vec<String> {
        caps_of(id)
            .get("_meta")
            .and_then(|m| m.get("jetbrains"))
            .and_then(|j| j.get("air"))
            .and_then(|a| a.get("capabilities"))
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn form_elicitation_is_advertised_only_to_codex_deepseek_and_qoder() {
        for id in ["codex", "deepseek_harness", "qoder"] {
            let caps = caps_of(id);
            assert!(
                caps.get("elicitation").is_some(),
                "{id} must advertise form elicitation"
            );
        }
        for id in ["claude_code", "grok", "pi", "cline", "cursor"] {
            let caps = caps_of(id);
            let elicitation = caps.get("elicitation");
            let form = elicitation.and_then(|e| e.get("form"));
            assert!(
                form.is_none()
                    || form == Some(&serde_json::json!({}))
                    || form
                        .and_then(|f| f.as_object())
                        .is_some_and(|o| o.is_empty()
                            || o.values().all(|v| v == &serde_json::Value::Bool(false))),
                "{id} must not advertise form elicitation: {elicitation:?}"
            );
        }
    }

    #[test]
    fn air_diff_patch_is_codex_only() {
        assert_eq!(
            air_capabilities("codex"),
            vec![
                "sessionFailure",
                "asyncTasks",
                "recommendedValue",
                "diffPatch"
            ]
        );
        assert_eq!(
            air_capabilities("claude_code"),
            vec!["sessionFailure", "asyncTasks", "recommendedValue"]
        );
        assert!(air_capabilities("grok").is_empty());
        assert!(
            caps_of("claude_code")
                .pointer("/_meta/jetbrains/air/capabilities")
                .and_then(|v| v.as_array())
                .is_some_and(|c| c.iter().all(|v| v.as_str() != Some("diffPatch")))
        );
    }

    #[test]
    fn terminal_output_delta_is_advertised_to_codex_only() {
        assert_eq!(
            caps_of("codex")
                .pointer("/_meta/terminal_output_delta")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        for id in ["claude_code", "pi", "grok", "cursor"] {
            assert!(
                caps_of(id)
                    .pointer("/_meta/terminal_output_delta")
                    .is_none(),
                "{id}"
            );
        }
    }

    #[test]
    fn cursor_does_not_get_parameterized_model_picker() {
        assert!(
            caps_of("cursor")
                .pointer("/_meta/parameterizedModelPicker")
                .is_none()
        );
    }

    #[test]
    fn claude_opts_into_subagent_transcript() {
        assert_eq!(
            caps_of("claude_code")
                .pointer("/_meta/subagent-transcript")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(
            caps_of("codex")
                .pointer("/_meta/subagent-transcript")
                .is_none()
        );
    }
}
