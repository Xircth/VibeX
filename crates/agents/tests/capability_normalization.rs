use agent_client_protocol::schema::{
    ProtocolVersion,
    v1::{
        AgentAuthCapabilities, AgentCapabilities, ClientCapabilities, FileSystemCapabilities,
        LogoutCapabilities, McpCapabilities, PromptCapabilities,
        SessionAdditionalDirectoriesCapabilities, SessionCapabilities, SessionCloseCapabilities,
        SessionDeleteCapabilities, SessionListCapabilities, SessionResumeCapabilities,
    },
};
use agents::{AcpCapabilityNormalizer, AgentPromptCapabilities};

#[test]
fn absent_agent_capabilities_remain_unsupported() {
    let snapshot = AcpCapabilityNormalizer::normalize(
        ProtocolVersion::LATEST,
        &AgentCapabilities::default(),
        &serde_json::json!({}),
        &ClientCapabilities::default(),
    );

    assert_eq!(
        snapshot.prompt,
        AgentPromptCapabilities {
            text: true,
            image: false,
            audio: false,
            resource: false,
            resource_link: false,
        }
    );
    assert!(!snapshot.load_session);
    assert!(!snapshot.resume_session);
    assert!(!snapshot.close_session);
    assert!(!snapshot.fork_session);
    assert!(!snapshot.list_sessions);
    assert!(!snapshot.delete_session);
    assert!(!snapshot.additional_directories);
    assert!(!snapshot.terminal);
    assert!(!snapshot.filesystem_requests);
    assert!(!snapshot.mcp_http);
    assert!(!snapshot.mcp_sse);
    assert!(!snapshot.auth_logout);
    assert!(!snapshot.auth_status);
}

#[test]
fn negotiated_capabilities_are_normalized_without_agent_name_rules() {
    let capabilities = AgentCapabilities::new()
        .load_session(true)
        .prompt_capabilities(
            PromptCapabilities::new()
                .image(true)
                .audio(true)
                .embedded_context(true),
        )
        .mcp_capabilities(McpCapabilities::new().http(true).sse(true))
        .session_capabilities(
            SessionCapabilities::new()
                .list(SessionListCapabilities::new())
                .delete(SessionDeleteCapabilities::new())
                .additional_directories(SessionAdditionalDirectoriesCapabilities::new())
                .resume(SessionResumeCapabilities::new())
                .close(SessionCloseCapabilities::new()),
        )
        .auth(AgentAuthCapabilities::new().logout(LogoutCapabilities::new()));
    let raw = serde_json::json!({
        "auth": {"status": true},
        "_meta": {"vendor.example/capability": {"enabled": true}}
    });

    let client_capabilities = ClientCapabilities::new()
        .terminal(true)
        .fs(FileSystemCapabilities::new().read_text_file(true));
    let snapshot = AcpCapabilityNormalizer::normalize(
        ProtocolVersion::LATEST,
        &capabilities,
        &raw,
        &client_capabilities,
    );

    assert!(snapshot.prompt.image);
    assert!(snapshot.prompt.audio);
    assert!(snapshot.prompt.resource);
    assert!(snapshot.prompt.resource_link);
    assert!(snapshot.load_session);
    assert!(snapshot.resume_session);
    assert!(snapshot.close_session);
    assert!(snapshot.list_sessions);
    assert!(snapshot.delete_session);
    assert!(snapshot.additional_directories);
    assert!(snapshot.terminal);
    assert!(snapshot.filesystem_requests);
    assert!(snapshot.mcp_http);
    assert!(snapshot.mcp_sse);
    assert!(snapshot.auth_logout);
    assert!(snapshot.auth_status);
    assert_eq!(
        snapshot.raw_meta,
        Some(serde_json::json!({
            "vendor.example/capability": {"enabled": true}
        }))
    );
}
