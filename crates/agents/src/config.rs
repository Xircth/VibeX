use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AgentType;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PathTemplate {
    pub env_var: Option<String>,
    pub unix: String,
    pub windows: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentConfigStrategy {
    Unsupported,
    FileJson,
    FileToml,
    Directory,
    AgentCommand,
    AcpExtension,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentConfigSurface {
    pub agent_type: AgentType,
    pub auth_paths: Vec<PathTemplate>,
    pub config_paths: Vec<PathTemplate>,
    pub strategy: AgentConfigStrategy,
}

pub fn config_surface(agent_type: AgentType) -> AgentConfigSurface {
    match agent_type {
        AgentType::ClaudeCode => AgentConfigSurface {
            agent_type,
            auth_paths: vec![path_template(
                Some("CLAUDE_CONFIG_DIR"),
                "~/.claude/projects",
                "%USERPROFILE%\\.claude\\projects",
            )],
            config_paths: vec![path_template(
                None,
                "~/.claude.json",
                "%USERPROFILE%\\.claude.json",
            )],
            strategy: AgentConfigStrategy::FileJson,
        },
        AgentType::Codex => AgentConfigSurface {
            agent_type,
            auth_paths: vec![path_template(
                Some("CODEX_HOME"),
                "~/.codex/auth.json",
                "%USERPROFILE%\\.codex\\auth.json",
            )],
            config_paths: vec![path_template(
                Some("CODEX_HOME"),
                "~/.codex/config.toml",
                "%USERPROFILE%\\.codex\\config.toml",
            )],
            strategy: AgentConfigStrategy::FileToml,
        },
        AgentType::Opencode => AgentConfigSurface {
            agent_type,
            auth_paths: vec![path_template(
                Some("XDG_CONFIG_HOME"),
                "~/.config/opencode/opencode.json",
                "%USERPROFILE%\\.config\\opencode\\opencode.json",
            )],
            config_paths: vec![path_template(
                Some("XDG_CONFIG_HOME"),
                "~/.config/opencode/opencode.json",
                "%USERPROFILE%\\.config\\opencode\\opencode.json",
            )],
            strategy: AgentConfigStrategy::FileJson,
        },
        AgentType::Gemini => AgentConfigSurface {
            agent_type,
            auth_paths: vec![path_template(
                Some("GEMINI_CLI_HOME"),
                "~/.gemini",
                "%USERPROFILE%\\.gemini",
            )],
            config_paths: vec![path_template(
                Some("GEMINI_CLI_HOME"),
                "~/.gemini",
                "%USERPROFILE%\\.gemini",
            )],
            strategy: AgentConfigStrategy::Directory,
        },
        AgentType::Openclaw | AgentType::Cline | AgentType::Hermes | AgentType::QaMock => {
            AgentConfigSurface {
                agent_type,
                auth_paths: Vec::new(),
                config_paths: Vec::new(),
                strategy: AgentConfigStrategy::AgentCommand,
            }
        }
    }
}

fn path_template(env_var: Option<&str>, unix: &str, windows: &str) -> PathTemplate {
    PathTemplate {
        env_var: env_var.map(str::to_string),
        unix: unix.to_string(),
        windows: windows.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_config_surface_uses_codex_home() {
        let surface = config_surface(AgentType::Codex);
        assert_eq!(surface.strategy, AgentConfigStrategy::FileToml);
        assert_eq!(surface.auth_paths[0].env_var.as_deref(), Some("CODEX_HOME"));
    }
}
