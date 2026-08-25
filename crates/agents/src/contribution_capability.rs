//! Static Agent contribution capabilities. Path projection still uses
//! `agent_primary_skill_dir` / `skill_dirs`; this table only answers the four
//! booleans that replace `skill_capable_agent_ids`.

use crate::AgentKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentContributionCapability {
    pub agent_id: String,
    pub skills_project: bool,
    pub mcp_session_new: bool,
    pub mcp_native_file: bool,
    pub hooks_project: bool,
}

pub fn builtin_contribution_capabilities() -> Vec<AgentContributionCapability> {
    [
        AgentKind::ClaudeCode,
        AgentKind::Codex,
        AgentKind::Antigravity,
        AgentKind::Openclaw,
        AgentKind::Opencode,
        AgentKind::Cline,
        AgentKind::Hermes,
        AgentKind::Codebuddy,
        AgentKind::KimiCode,
        AgentKind::Pi,
        AgentKind::Grok,
        AgentKind::Cursor,
        AgentKind::DeepseekHarness,
    ]
    .into_iter()
    .map(|agent| {
        let surface = crate::skills::skills_surface(agent);
        AgentContributionCapability {
            agent_id: agent.as_str().to_owned(),
            skills_project: surface.global_supported,
            mcp_session_new: surface.global_supported,
            mcp_native_file: surface.global_supported,
            hooks_project: matches!(
                agent,
                AgentKind::ClaudeCode | AgentKind::Codex | AgentKind::Cursor
            ),
        }
    })
    .collect()
}

pub fn skill_projectable_agent_ids() -> Vec<String> {
    builtin_contribution_capabilities()
        .into_iter()
        .filter(|capability| capability.skills_project)
        .map(|capability| capability.agent_id)
        .collect()
}
