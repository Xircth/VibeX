use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{AgentDistribution, AgentRegistryEntry, AgentType};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentPreflightCheckStatus {
    Pass,
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentPreflightFixAction {
    OpenUrl { label: String, url: String },
    InstallUv { label: String },
    Custom { action: String, label: String },
}

impl AgentPreflightFixAction {
    pub fn action_key(&self) -> String {
        match self {
            Self::OpenUrl { url, .. } => format!("open_url:{url}"),
            Self::InstallUv { .. } => "install_uv".to_string(),
            Self::Custom { action, .. } => action.clone(),
        }
    }

    pub fn label(&self) -> &str {
        match self {
            Self::OpenUrl { label, .. }
            | Self::InstallUv { label }
            | Self::Custom { label, .. } => label,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPreflightCheckItem {
    pub check_id: String,
    pub label: String,
    pub status: AgentPreflightCheckStatus,
    pub message: String,
    pub fixes: Vec<AgentPreflightFixAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPreflightReport {
    pub agent_type: AgentType,
    pub checks: Vec<AgentPreflightCheckItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPreflightProbe {
    pub entry: AgentRegistryEntry,
    pub platform: String,
    pub runtime_program: Option<String>,
    pub runtime_path: Option<String>,
    pub runtime_lookup_error: Option<String>,
    pub adapter_version: Option<String>,
    pub adapter_version_error: Option<String>,
    pub auth_found: bool,
    pub auth_hint: Option<String>,
    pub network_available: Option<bool>,
}

pub fn build_preflight_report(probe: AgentPreflightProbe) -> AgentPreflightReport {
    let mut checks = Vec::new();
    let platform_supported =
        distribution_supports_platform(&probe.entry.distribution, &probe.platform);
    let install_fixes = install_fixes(&probe.entry);

    checks.push(check(
        "platform",
        "Platform support",
        if platform_supported {
            AgentPreflightCheckStatus::Pass
        } else {
            AgentPreflightCheckStatus::Fail
        },
        if platform_supported {
            format!("{} supports {}.", probe.entry.name, probe.platform)
        } else {
            format!("{} has no build for {}.", probe.entry.name, probe.platform)
        },
        if platform_supported {
            Vec::new()
        } else {
            install_fixes.clone()
        },
    ));

    if let Some(prerequisite) =
        prerequisite_check(&probe.entry.distribution, probe.runtime_path.is_some())
    {
        checks.push(prerequisite);
    }

    checks.push(check(
        "runtime_launcher",
        "Runtime launcher",
        if probe.runtime_path.is_some() {
            AgentPreflightCheckStatus::Pass
        } else {
            AgentPreflightCheckStatus::Fail
        },
        match (
            &probe.runtime_program,
            &probe.runtime_path,
            &probe.runtime_lookup_error,
        ) {
            (Some(program), Some(path), _) => format!("Found `{program}` at {path}."),
            (Some(program), None, Some(error)) => {
                format!("`{program}` was not found in PATH: {error}.")
            }
            (Some(program), None, None) => format!("`{program}` was not found in PATH."),
            (None, _, Some(error)) => error.clone(),
            (None, _, None) => "No runtime command could be built for this agent.".to_string(),
        },
        if probe.runtime_path.is_some() {
            Vec::new()
        } else {
            install_fixes.clone()
        },
    ));

    checks.push(check(
        "adapter_version",
        "ACP adapter version",
        if probe.adapter_version.is_some() {
            AgentPreflightCheckStatus::Pass
        } else {
            AgentPreflightCheckStatus::Warn
        },
        if let Some(version) = probe.adapter_version {
            version
        } else if let Some(error) = probe.adapter_version_error {
            format!("Could not determine adapter version: {error}.")
        } else {
            "Could not determine adapter version.".to_string()
        },
        install_fixes.clone(),
    ));

    checks.push(check(
        "auth",
        "Authentication",
        if probe.auth_found {
            AgentPreflightCheckStatus::Pass
        } else {
            AgentPreflightCheckStatus::Warn
        },
        if probe.auth_found {
            probe
                .auth_hint
                .unwrap_or_else(|| "Authentication was detected.".to_string())
        } else {
            probe
                .auth_hint
                .unwrap_or_else(|| "Authentication was not detected.".to_string())
        },
        Vec::new(),
    ));

    checks.push(check(
        "network",
        "Network",
        match probe.network_available {
            Some(true) => AgentPreflightCheckStatus::Pass,
            Some(false) | None => AgentPreflightCheckStatus::Warn,
        },
        match probe.network_available {
            Some(true) => "Network connectivity check passed.".to_string(),
            Some(false) => "Network connectivity check failed or the host is offline.".to_string(),
            None => "Network connectivity was not checked.".to_string(),
        },
        Vec::new(),
    ));

    AgentPreflightReport {
        agent_type: probe.entry.agent_type,
        checks,
    }
}

fn prerequisite_check(
    distribution: &AgentDistribution,
    runtime_found: bool,
) -> Option<AgentPreflightCheckItem> {
    match distribution {
        AgentDistribution::Npx { node_required, .. } => Some(check(
            "node_prerequisite",
            "Node/npm prerequisite",
            if runtime_found {
                AgentPreflightCheckStatus::Pass
            } else {
                AgentPreflightCheckStatus::Fail
            },
            node_required
                .as_ref()
                .map(|version| format!("Requires Node.js >= {version} and npm/npx."))
                .unwrap_or_else(|| "Requires npm/npx.".to_string()),
            vec![AgentPreflightFixAction::Custom {
                action: "install_npm".to_string(),
                label: "Install with npm".to_string(),
            }],
        )),
        AgentDistribution::Uvx { uv_required, .. } => Some(check(
            "uv_prerequisite",
            "uv prerequisite",
            if runtime_found {
                AgentPreflightCheckStatus::Pass
            } else {
                AgentPreflightCheckStatus::Fail
            },
            uv_required
                .as_ref()
                .map(|version| format!("Requires uv >= {version}."))
                .unwrap_or_else(|| "Requires uv/uvx.".to_string()),
            vec![AgentPreflightFixAction::InstallUv {
                label: "Install uv".to_string(),
            }],
        )),
        AgentDistribution::Binary { .. } | AgentDistribution::System { .. } => None,
    }
}

fn distribution_supports_platform(distribution: &AgentDistribution, platform: &str) -> bool {
    match distribution {
        AgentDistribution::Binary { platforms, .. } => platforms
            .iter()
            .any(|candidate| candidate.platform == platform),
        AgentDistribution::Npx { .. }
        | AgentDistribution::Uvx { .. }
        | AgentDistribution::System { .. } => true,
    }
}

fn install_fixes(entry: &AgentRegistryEntry) -> Vec<AgentPreflightFixAction> {
    match &entry.distribution {
        AgentDistribution::Npx { package, .. } => vec![AgentPreflightFixAction::Custom {
            action: "install_npm".to_string(),
            label: format!("Install {package}"),
        }],
        AgentDistribution::Binary { platforms, .. } => platforms
            .first()
            .map(|platform| {
                vec![AgentPreflightFixAction::OpenUrl {
                    label: format!("Download {}", entry.name),
                    url: platform.url.clone(),
                }]
            })
            .unwrap_or_default(),
        AgentDistribution::Uvx { .. } => vec![AgentPreflightFixAction::InstallUv {
            label: "Install uv".to_string(),
        }],
        AgentDistribution::System { cmd, .. } => vec![AgentPreflightFixAction::Custom {
            action: "manual_install".to_string(),
            label: format!("Install {cmd}"),
        }],
    }
}

fn check(
    check_id: &str,
    label: &str,
    status: AgentPreflightCheckStatus,
    message: String,
    fixes: Vec<AgentPreflightFixAction>,
) -> AgentPreflightCheckItem {
    AgentPreflightCheckItem {
        check_id: check_id.to_string(),
        label: label.to_string(),
        status,
        message,
        fixes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentDistribution, PlatformBinary, registry_entry};

    #[test]
    fn preflight_marks_binary_platform_mismatch_as_failure() {
        let mut entry = registry_entry(AgentType::Codex);
        entry.distribution = AgentDistribution::Binary {
            version: "1.0.0".to_string(),
            cmd: "codex-acp".to_string(),
            args: Vec::new(),
            platforms: vec![PlatformBinary {
                platform: "linux-x86_64".to_string(),
                url: "https://example.test/codex.tar.gz".to_string(),
            }],
        };

        let report = build_preflight_report(AgentPreflightProbe {
            entry,
            platform: "windows-x86_64".to_string(),
            runtime_program: Some("codex-acp".to_string()),
            runtime_path: None,
            runtime_lookup_error: None,
            adapter_version: None,
            adapter_version_error: None,
            auth_found: false,
            auth_hint: None,
            network_available: Some(false),
        });

        let platform = report
            .checks
            .iter()
            .find(|check| check.check_id == "platform")
            .unwrap();
        assert_eq!(platform.status, AgentPreflightCheckStatus::Fail);
        assert!(!platform.fixes.is_empty());
    }

    #[test]
    fn preflight_reports_npx_prerequisite_and_auth_warning() {
        let report = build_preflight_report(AgentPreflightProbe {
            entry: registry_entry(AgentType::Gemini),
            platform: "windows-x86_64".to_string(),
            runtime_program: Some("npx.cmd".to_string()),
            runtime_path: Some("C:/node/npx.cmd".to_string()),
            runtime_lookup_error: None,
            adapter_version: Some("0.45.2".to_string()),
            adapter_version_error: None,
            auth_found: false,
            auth_hint: Some("No Gemini authentication file was found.".to_string()),
            network_available: Some(true),
        });

        let prerequisite = report
            .checks
            .iter()
            .find(|check| check.check_id == "node_prerequisite")
            .unwrap();
        assert_eq!(prerequisite.status, AgentPreflightCheckStatus::Pass);

        let auth = report
            .checks
            .iter()
            .find(|check| check.check_id == "auth")
            .unwrap();
        assert_eq!(auth.status, AgentPreflightCheckStatus::Warn);
        assert!(auth.message.contains("Gemini"));
    }

    #[test]
    fn preflight_keeps_offline_network_as_warning() {
        let report = build_preflight_report(AgentPreflightProbe {
            entry: registry_entry(AgentType::Opencode),
            platform: "windows-x86_64".to_string(),
            runtime_program: Some("opencode".to_string()),
            runtime_path: Some("C:/bin/opencode.exe".to_string()),
            runtime_lookup_error: None,
            adapter_version: Some("1.16.2".to_string()),
            adapter_version_error: None,
            auth_found: true,
            auth_hint: Some("OpenCode auth detected.".to_string()),
            network_available: Some(false),
        });

        let network = report
            .checks
            .iter()
            .find(|check| check.check_id == "network")
            .unwrap();
        assert_eq!(network.status, AgentPreflightCheckStatus::Warn);
    }
}
