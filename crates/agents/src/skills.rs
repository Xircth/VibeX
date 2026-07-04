use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AgentKind;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentSkillsStrategy {
    Unsupported,
    Directory,
    AgentCommand,
    AcpExtension,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentSkillsSurface {
    pub agent_type: AgentKind,
    pub strategy: AgentSkillsStrategy,
    pub global_supported: bool,
    pub project_supported: bool,
}

pub fn skills_surface(agent_type: AgentKind) -> AgentSkillsSurface {
    match agent_type {
        AgentKind::ClaudeCode | AgentKind::Codex | AgentKind::Opencode => AgentSkillsSurface {
            agent_type,
            strategy: AgentSkillsStrategy::Directory,
            global_supported: true,
            project_supported: true,
        },
        AgentKind::Gemini
        | AgentKind::Openclaw
        | AgentKind::Cline
        | AgentKind::Hermes
        | AgentKind::QaMock => {
            AgentSkillsSurface {
                agent_type,
                strategy: AgentSkillsStrategy::AgentCommand,
                global_supported: true,
                project_supported: false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skills_surface_is_registry_wide() {
        let surfaces = crate::all_agent_types()
            .into_iter()
            .map(skills_surface)
            .collect::<Vec<_>>();

        assert_eq!(surfaces.len(), 7);
        assert!(surfaces.iter().any(|surface| {
            surface.agent_type == AgentKind::Codex
                && surface.strategy == AgentSkillsStrategy::Directory
        }));
    }
}
