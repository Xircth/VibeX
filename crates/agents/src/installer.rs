use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AgentDistribution, AgentKind, AgentRegistryEntry};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentInstallStatus {
    Ready,
    MissingPrerequisite,
    MissingAgent,
    UnsupportedPlatform,
    AuthMissing,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentPreflightSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPreflightIssue {
    pub code: String,
    pub severity: AgentPreflightSeverity,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPreflight {
    pub agent_type: AgentKind,
    pub status: AgentInstallStatus,
    pub issues: Vec<AgentPreflightIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentInstallPlan {
    pub agent_type: AgentKind,
    pub distribution: AgentDistribution,
    pub required_tools: Vec<String>,
    pub user_visible_summary: String,
}

impl AgentInstallPlan {
    pub fn from_registry_entry(entry: &AgentRegistryEntry) -> Self {
        let required_tools = match &entry.distribution {
            AgentDistribution::Npx { node_required, .. } => node_required
                .as_ref()
                .map(|version| vec![format!("node>={version}")])
                .unwrap_or_else(|| vec!["node".to_string()]),
            AgentDistribution::Binary { .. } => Vec::new(),
            AgentDistribution::Uvx {
                uv_required,
                python_required,
                ..
            } => {
                let mut tools = vec!["uvx".to_string()];
                if let Some(version) = uv_required {
                    tools.push(format!("uv>={version}"));
                }
                if let Some(version) = python_required {
                    tools.push(format!("python>={version}"));
                }
                tools
            }
            AgentDistribution::System { cmd, .. } => vec![cmd.clone()],
        };

        Self {
            agent_type: entry.agent_type,
            distribution: entry.distribution.clone(),
            required_tools,
            user_visible_summary: format!("Install or verify {}", entry.name),
        }
    }
}

pub fn preflight_from_detected_state(
    agent_type: AgentKind,
    prerequisite_ok: bool,
    agent_found: bool,
    auth_found: bool,
    platform_supported: bool,
) -> AgentPreflight {
    let mut issues = Vec::new();
    let status = if !platform_supported {
        issues.push(issue(
            "unsupported_platform",
            AgentPreflightSeverity::Error,
            "This agent distribution does not support the current platform.",
        ));
        AgentInstallStatus::UnsupportedPlatform
    } else if !prerequisite_ok {
        issues.push(issue(
            "missing_prerequisite",
            AgentPreflightSeverity::Error,
            "A required runtime or package manager is missing.",
        ));
        AgentInstallStatus::MissingPrerequisite
    } else if !agent_found {
        issues.push(issue(
            "missing_agent",
            AgentPreflightSeverity::Error,
            "The agent executable or adapter is not installed.",
        ));
        AgentInstallStatus::MissingAgent
    } else if !auth_found {
        issues.push(issue(
            "auth_missing",
            AgentPreflightSeverity::Warning,
            "The agent is installed but authentication was not detected.",
        ));
        AgentInstallStatus::AuthMissing
    } else {
        AgentInstallStatus::Ready
    };

    AgentPreflight {
        agent_type,
        status,
        issues,
    }
}

fn issue(code: &str, severity: AgentPreflightSeverity, message: &str) -> AgentPreflightIssue {
    AgentPreflightIssue {
        code: code.to_string(),
        severity,
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentKind, registry_entry};

    #[test]
    fn install_plan_reports_npx_prerequisites() {
        let entry = registry_entry(AgentKind::Gemini);
        let plan = AgentInstallPlan::from_registry_entry(&entry);
        assert_eq!(plan.required_tools, vec!["node>=20.0.0"]);
    }

    #[test]
    fn preflight_distinguishes_auth_missing_from_missing_agent() {
        let preflight = preflight_from_detected_state(AgentKind::Codex, true, true, false, true);
        assert_eq!(preflight.status, AgentInstallStatus::AuthMissing);
        assert_eq!(preflight.issues[0].code, "auth_missing");

        let missing = preflight_from_detected_state(AgentKind::Codex, true, false, false, true);
        assert_eq!(missing.status, AgentInstallStatus::MissingAgent);
    }
}
