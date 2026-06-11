use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::distribution::{AgentDistribution, PlatformBinary, SystemCommand};
use crate::error::AgentError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentType {
    ClaudeCode,
    Codex,
    OpenCode,
    Gemini,
    OpenClaw,
    Cline,
    Hermes,
}

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
        AgentType::OpenCode,
        AgentType::Gemini,
        AgentType::OpenClaw,
        AgentType::Cline,
        AgentType::Hermes,
    ]
}

pub fn registry_id_for(agent_type: AgentType) -> &'static str {
    match agent_type {
        AgentType::ClaudeCode => "claude-acp",
        AgentType::Codex => "codex-acp",
        AgentType::OpenCode => "opencode",
        AgentType::Gemini => "gemini",
        AgentType::OpenClaw => "openclaw-acp",
        AgentType::Cline => "cline",
        AgentType::Hermes => "hermes",
    }
}

pub fn agent_type_from_registry_id(id: &str) -> Option<AgentType> {
    match id {
        "claude-acp" => Some(AgentType::ClaudeCode),
        "codex-acp" => Some(AgentType::Codex),
        "opencode" => Some(AgentType::OpenCode),
        "gemini" => Some(AgentType::Gemini),
        "openclaw-acp" => Some(AgentType::OpenClaw),
        "cline" => Some(AgentType::Cline),
        "hermes" => Some(AgentType::Hermes),
        _ => None,
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
            AgentDistribution::Binary {
                version: "0.16.0".to_string(),
                cmd: "codex-acp".to_string(),
                args: vec![],
                platforms: codex_platforms(),
            },
        ),
        AgentType::OpenCode => (
            "OpenCode",
            "OpenCode ACP server",
            AgentDistribution::Binary {
                version: "1.16.2".to_string(),
                cmd: "opencode".to_string(),
                args: vec!["acp".to_string()],
                platforms: opencode_platforms(),
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
        AgentType::OpenClaw => (
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

fn codex_platforms() -> Vec<PlatformBinary> {
    vec![
        platform("darwin-aarch64", "https://github.com/zed-industries/codex-acp/releases/download/v0.16.0/codex-acp-0.16.0-aarch64-apple-darwin.tar.gz"),
        platform("darwin-x86_64", "https://github.com/zed-industries/codex-acp/releases/download/v0.16.0/codex-acp-0.16.0-x86_64-apple-darwin.tar.gz"),
        platform("linux-aarch64", "https://github.com/zed-industries/codex-acp/releases/download/v0.16.0/codex-acp-0.16.0-aarch64-unknown-linux-gnu.tar.gz"),
        platform("linux-x86_64", "https://github.com/zed-industries/codex-acp/releases/download/v0.16.0/codex-acp-0.16.0-x86_64-unknown-linux-gnu.tar.gz"),
        platform("windows-aarch64", "https://github.com/zed-industries/codex-acp/releases/download/v0.16.0/codex-acp-0.16.0-aarch64-pc-windows-msvc.zip"),
        platform("windows-x86_64", "https://github.com/zed-industries/codex-acp/releases/download/v0.16.0/codex-acp-0.16.0-x86_64-pc-windows-msvc.zip"),
    ]
}

fn opencode_platforms() -> Vec<PlatformBinary> {
    vec![
        platform("darwin-aarch64", "https://github.com/sst/opencode/releases/download/v1.16.2/opencode-darwin-arm64.zip"),
        platform("darwin-x86_64", "https://github.com/sst/opencode/releases/download/v1.16.2/opencode-darwin-x64.zip"),
        platform("linux-aarch64", "https://github.com/sst/opencode/releases/download/v1.16.2/opencode-linux-arm64.zip"),
        platform("linux-x86_64", "https://github.com/sst/opencode/releases/download/v1.16.2/opencode-linux-x64.zip"),
        platform("windows-x86_64", "https://github.com/sst/opencode/releases/download/v1.16.2/opencode-windows-x64.zip"),
    ]
}

fn platform(platform: &str, url: &str) -> PlatformBinary {
    PlatformBinary {
        platform: platform.to_string(),
        url: url.to_string(),
    }
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
                AgentType::OpenCode,
                AgentType::Gemini,
                AgentType::OpenClaw,
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
            AgentDistribution::Binary { ref version, ref platforms, .. }
                if version == "0.16.0" && platforms.iter().any(|p| p.platform == "windows-x86_64")
        ));
    }
}
