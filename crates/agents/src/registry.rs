use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    distribution::{AgentDistribution, SystemCommand},
    error::AgentError,
};

/// The stable agent identity. Re-exported from [`api_types::AgentKind`] — the single
/// system-wide identity enum (ADR-0002, 批次D2). Kept under the historical `AgentType`
/// name during the staged migration; call sites move to `AgentKind` crate-by-crate.
pub use api_types::AgentKind as AgentType;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentRegistryEntry {
    pub agent_type: AgentType,
    pub registry_id: String,
    pub name: String,
    pub description: String,
    pub distribution: AgentDistribution,
}

pub fn all_agent_types() -> Vec<AgentType> {
    vec![
        AgentType::ClaudeCode,
        AgentType::Codex,
        AgentType::Opencode,
        AgentType::Gemini,
        AgentType::Openclaw,
        AgentType::Cline,
        AgentType::Hermes,
    ]
}

pub fn registry_id_for(agent_type: AgentType) -> &'static str {
    match agent_type {
        AgentType::ClaudeCode => "claude-acp",
        AgentType::Codex => "codex-acp",
        AgentType::Opencode => "opencode",
        AgentType::Gemini => "gemini",
        AgentType::Openclaw => "openclaw-acp",
        AgentType::Cline => "cline",
        AgentType::Hermes => "hermes",
        AgentType::QaMock => "qa-mock",
    }
}

pub fn agent_type_from_registry_id(id: &str) -> Option<AgentType> {
    match id {
        "claude-acp" => Some(AgentType::ClaudeCode),
        "codex-acp" => Some(AgentType::Codex),
        "opencode" => Some(AgentType::Opencode),
        "gemini" => Some(AgentType::Gemini),
        "openclaw-acp" => Some(AgentType::Openclaw),
        "cline" => Some(AgentType::Cline),
        "hermes" => Some(AgentType::Hermes),
        _ => None,
    }
}

pub fn agent_type_from_executor_key(key: &str) -> Option<AgentType> {
    match key {
        "CLAUDE_CODE" | "claude_code" | "ClaudeCode" => Some(AgentType::ClaudeCode),
        "CODEX" | "codex" | "Codex" => Some(AgentType::Codex),
        "OPENCODE" | "open_code" | "opencode" | "Opencode" => Some(AgentType::Opencode),
        "GEMINI" | "gemini" | "Gemini" => Some(AgentType::Gemini),
        "OPENCLAW" | "open_claw" | "openclaw" | "OpenClaw" => Some(AgentType::Openclaw),
        "CLINE" | "cline" | "Cline" => Some(AgentType::Cline),
        "HERMES" | "hermes" | "Hermes" => Some(AgentType::Hermes),
        _ => None,
    }
}

/// The canonical executor-key string for an agent type. Round-trips through
/// [`agent_type_from_executor_key`]; persisted in `sessions.agent_type` so the
/// runtime binding and explicit transcript importer use the same agent key.
pub fn executor_key_for(agent_type: AgentType) -> &'static str {
    match agent_type {
        AgentType::ClaudeCode => "claude_code",
        AgentType::Codex => "codex",
        AgentType::Opencode => "opencode",
        AgentType::Gemini => "gemini",
        AgentType::Openclaw => "openclaw",
        AgentType::Cline => "cline",
        AgentType::Hermes => "hermes",
        AgentType::QaMock => "qa_mock",
    }
}

pub fn registry_entry(agent_type: AgentType) -> AgentRegistryEntry {
    let (name, description, distribution) = match agent_type {
        AgentType::ClaudeCode => (
            "Claude Code",
            "ACP wrapper for Anthropic's Claude",
            AgentDistribution::Npx {
                version: "0.44.0".to_string(),
                package: "@agentclientprotocol/claude-agent-acp@0.44.0".to_string(),
                cmd: "claude-agent-acp".to_string(),
                args: vec![],
                node_required: None,
            },
        ),
        AgentType::Codex => (
            "Codex CLI",
            "ACP adapter for OpenAI's coding assistant",
            AgentDistribution::Npx {
                version: "1.0.2".to_string(),
                package: "@agentclientprotocol/codex-acp@1.0.2".to_string(),
                cmd: "codex-acp".to_string(),
                args: vec![],
                node_required: None,
            },
        ),
        AgentType::Opencode => (
            "OpenCode",
            "OpenCode ACP server",
            AgentDistribution::Npx {
                version: "1.17.11".to_string(),
                package: "opencode-ai@1.17.11".to_string(),
                cmd: "opencode".to_string(),
                args: vec!["acp".to_string()],
                node_required: None,
            },
        ),
        AgentType::Gemini => (
            "Gemini CLI",
            "Google's official CLI for Gemini",
            AgentDistribution::Npx {
                version: "0.45.2".to_string(),
                package: "@google/gemini-cli@0.45.2".to_string(),
                cmd: "gemini".to_string(),
                args: vec!["--acp".to_string(), "--skip-trust".to_string()],
                node_required: Some("20.0.0".to_string()),
            },
        ),
        AgentType::Openclaw => (
            "OpenClaw",
            "OpenClaw personal AI assistant",
            AgentDistribution::Npx {
                version: "2026.6.1".to_string(),
                package: "openclaw@2026.6.1".to_string(),
                cmd: "openclaw".to_string(),
                args: vec!["acp".to_string()],
                node_required: Some("22.19.0".to_string()),
            },
        ),
        AgentType::Cline => (
            "Cline",
            "Autonomous coding agent CLI",
            AgentDistribution::Npx {
                version: "3.0.9".to_string(),
                package: "cline@3.0.9".to_string(),
                cmd: "cline".to_string(),
                args: vec!["--acp".to_string()],
                node_required: None,
            },
        ),
        AgentType::Hermes => (
            "Hermes",
            "Hermes ACP and MCP agent",
            AgentDistribution::Uvx {
                version: "0.16.0".to_string(),
                package: "hermes-agent[acp,mcp]==0.16.0".to_string(),
                cmd: "hermes-acp".to_string(),
                args: vec![],
                uv_required: Some("0.5.0".to_string()),
                python_required: Some("3.13".to_string()),
                system_command: Some(SystemCommand {
                    cmd: "hermes".to_string(),
                    args: vec!["acp".to_string()],
                }),
            },
        ),
        // In-process mock agent for tests. Not a registry-listed agent (see
        // `all_agent_types`), but exhaustiveness requires an entry; give it a
        // minimal placeholder distribution that is never actually spawned.
        AgentType::QaMock => (
            "QA Mock",
            "In-process mock agent for tests",
            AgentDistribution::Npx {
                version: "0.0.0".to_string(),
                package: "qa-mock".to_string(),
                cmd: "qa-mock".to_string(),
                args: vec![],
                node_required: None,
            },
        ),
    };

    AgentRegistryEntry {
        agent_type,
        registry_id: registry_id_for(agent_type).to_string(),
        name: name.to_string(),
        description: description.to_string(),
        distribution,
    }
}

pub fn registry_entry_from_id(id: &str) -> Result<AgentRegistryEntry, AgentError> {
    let agent_type = agent_type_from_registry_id(id)
        .ok_or_else(|| AgentError::UnsupportedAgent(id.to_string()))?;
    Ok(registry_entry(agent_type))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_contains_all_target_agents() {
        assert_eq!(
            all_agent_types(),
            vec![
                AgentType::ClaudeCode,
                AgentType::Codex,
                AgentType::Opencode,
                AgentType::Gemini,
                AgentType::Openclaw,
                AgentType::Cline,
                AgentType::Hermes,
            ]
        );
    }

    #[test]
    fn registry_ids_round_trip() {
        for agent in all_agent_types() {
            let id = registry_id_for(agent);
            assert_eq!(agent_type_from_registry_id(id), Some(agent));
            assert_eq!(registry_entry(agent).registry_id, id);
        }
    }

    #[test]
    fn executor_keys_round_trip() {
        // The string `bind_external_id` persists in `sessions.agent_type` must
        // resolve back to the same agent so imported transcript metadata and
        // runtime bindings share the same key space.
        for agent in all_agent_types() {
            let key = executor_key_for(agent);
            assert_eq!(
                agent_type_from_executor_key(key),
                Some(agent),
                "executor key {key:?} must round-trip"
            );
        }
    }

    #[test]
    fn registry_pins_codeg_style_versions() {
        let gemini = registry_entry(AgentType::Gemini);
        assert!(matches!(
            gemini.distribution,
            AgentDistribution::Npx { ref version, ref package, .. }
                if version == "0.45.2" && package == "@google/gemini-cli@0.45.2"
        ));

        let codex = registry_entry(AgentType::Codex);
        assert!(matches!(
            codex.distribution,
            AgentDistribution::Npx { ref version, ref package, .. }
                if version == "1.0.2" && package == "@agentclientprotocol/codex-acp@1.0.2"
        ));

        let opencode = registry_entry(AgentType::Opencode);
        assert!(matches!(
            opencode.distribution,
            AgentDistribution::Npx { ref version, ref package, ref args, .. }
                if version == "1.17.11"
                    && package == "opencode-ai@1.17.11"
                    && args.as_slice() == ["acp"]
        ));
    }
}
