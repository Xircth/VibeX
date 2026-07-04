use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AgentKind;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentMcpStrategy {
    Unsupported,
    FileJson,
    FileToml,
    AgentCommand,
    AcpExtension,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentMcpSurface {
    pub agent_type: AgentKind,
    pub strategy: AgentMcpStrategy,
    pub user_visible: bool,
}

pub fn mcp_surface(agent_type: AgentKind) -> AgentMcpSurface {
    let strategy = match agent_type {
        AgentKind::ClaudeCode | AgentKind::Opencode => AgentMcpStrategy::FileJson,
        AgentKind::Codex => AgentMcpStrategy::FileToml,
        AgentKind::Gemini
        | AgentKind::Openclaw
        | AgentKind::Cline
        | AgentKind::Hermes
        | AgentKind::QaMock => AgentMcpStrategy::AgentCommand,
    };

    AgentMcpSurface {
        agent_type,
        strategy,
        user_visible: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_agent_has_explicit_mcp_strategy() {
        for agent in crate::all_agent_types() {
            let surface = mcp_surface(agent);
            assert_ne!(surface.strategy, AgentMcpStrategy::Unsupported);
        }
    }
}
