use api_types::{
    AgentAuthenticationStatus, AgentId, AgentLifecycleState, AgentManagementIdentity, AgentSource,
};

#[test]
fn agent_id_rejects_invalid_values_and_preserves_stable_ids() {
    for raw in [
        "claude_code",
        "codex",
        "opencode",
        "pi",
        "gemini",
        "cline",
        "my-registry-agent",
        "vendor.agent-v2",
        "openclaw",
        "hermes",
        "qa_mock",
    ] {
        let id = AgentId::parse(raw)
            .unwrap_or_else(|error| panic!("expected {raw:?} to be a valid AgentId: {error}"));

        assert_eq!(id.as_str(), raw);
        assert_eq!(id.to_string(), raw);
        assert_eq!(
            serde_json::from_str::<AgentId>(
                &serde_json::to_string(&id).expect("AgentId should serialize")
            )
            .expect("serialized AgentId should deserialize"),
            id
        );
    }

    for raw in [
        "",
        "ClaudeCode",
        "CLAUDE_CODE",
        "has space",
        "-leading",
        "trailing-",
        ".leading",
        "trailing.",
        "slash/agent",
        "agent@vendor",
        "中文",
    ] {
        assert!(
            AgentId::parse(raw).is_err(),
            "expected {raw:?} to be rejected"
        );
    }
}

#[test]
fn management_identity_serializes_open_id_and_orthogonal_states() {
    let identity = AgentManagementIdentity {
        agent_id: AgentId::parse("vendor.agent-v2").expect("valid Registry Agent id"),
        source: AgentSource::OfficialRegistry,
        lifecycle: AgentLifecycleState::NeedsRepair,
        authentication: AgentAuthenticationStatus::ApiKey,
        enabled: false,
    };

    assert_eq!(
        serde_json::to_value(identity).expect("management identity should serialize"),
        serde_json::json!({
            "agent_id": "vendor.agent-v2",
            "source": "official_registry",
            "lifecycle": "needs_repair",
            "authentication": "api_key",
            "enabled": false,
        })
    );
}
