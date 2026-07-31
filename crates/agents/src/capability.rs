use agent_client_protocol::schema::{
    ProtocolVersion,
    v1::{AgentCapabilities, ClientCapabilities},
};

use crate::{AcpAuthStatusAdapter, AcpCapabilitySnapshot, AgentPromptCapabilities};

const MAX_CAPABILITY_META_BYTES: usize = 16 * 1024;

/// Converts an ACP initialization handshake into VibeX's stable capability
/// vocabulary without consulting registry metadata or agent identities.
pub struct AcpCapabilityNormalizer;

impl AcpCapabilityNormalizer {
    pub fn normalize(
        protocol_version: ProtocolVersion,
        capabilities: &AgentCapabilities,
        raw_capabilities: &serde_json::Value,
        client_capabilities: &ClientCapabilities,
    ) -> AcpCapabilitySnapshot {
        let session = &capabilities.session_capabilities;
        let prompt = &capabilities.prompt_capabilities;
        let mcp = &capabilities.mcp_capabilities;
        let raw_meta = raw_capabilities
            .get("_meta")
            .filter(|value| {
                serde_json::to_vec(value)
                    .is_ok_and(|encoded| encoded.len() <= MAX_CAPABILITY_META_BYTES)
            })
            .cloned();

        AcpCapabilitySnapshot {
            protocol_version: serde_json::to_value(protocol_version)
                .ok()
                .and_then(|value| value.as_str().map(ToOwned::to_owned)),
            prompt: AgentPromptCapabilities {
                // Text prompts are required by the ACP baseline.
                text: true,
                image: prompt.image,
                audio: prompt.audio,
                resource: prompt.embedded_context,
                resource_link: prompt.embedded_context,
            },
            load_session: capabilities.load_session,
            resume_session: session.resume.is_some(),
            close_session: session.close.is_some(),
            fork_session: session.fork.is_some(),
            list_sessions: session.list.is_some(),
            delete_session: session.delete.is_some(),
            // Client-side support is derived from the exact advertisement
            // sent in this handshake, not an optimistic product default.
            terminal: client_capabilities.terminal,
            additional_directories: session.additional_directories.is_some(),
            filesystem_requests: client_capabilities.fs.read_text_file
                || client_capabilities.fs.write_text_file,
            mcp_http: mcp.http,
            mcp_sse: mcp.sse,
            auth_logout: capabilities.auth.logout.is_some(),
            auth_status: AcpAuthStatusAdapter::is_advertised(raw_capabilities),
            authentication: None,
            raw_meta,
            modes: Vec::new(),
            current_mode: None,
            config_options: Vec::new(),
            available_commands: Vec::new(),
        }
    }
}
