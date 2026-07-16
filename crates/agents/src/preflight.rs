use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    AgentDistribution, AgentKind, AgentRegistryEntry, local_agent_runtime_spec,
    local_detection::version_at_least,
};

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
    pub agent_type: AgentKind,
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
    /// The oldest ACP adapter version verified to work with this integration.
    /// Newer adapter releases remain valid, which avoids incorrectly asking a
    /// user to downgrade an already newer local bridge.
    pub adapter_minimum_version: Option<String>,
    /// The actual agent CLI that the ACP adapter launches (for example,
    /// `codex`), kept separate from the adapter package itself.
    pub cli_package: Option<String>,
    pub cli_path: Option<String>,
    pub cli_version: Option<String>,
    pub cli_latest_version: Option<String>,
    pub cli_version_error: Option<String>,
    /// Whether the package manager required by this adapter is available.
    /// This is intentionally independent from the ACP executable: a missing
    /// adapter does not imply a missing Node/uv installation.
    pub npm_available: Option<bool>,
    pub node_version: Option<String>,
    pub uv_available: Option<bool>,
    pub uv_version: Option<String>,
    pub auth_found: bool,
    pub auth_hint: Option<String>,
    pub network_available: Option<bool>,
}

pub fn build_preflight_report(probe: AgentPreflightProbe) -> AgentPreflightReport {
    let mut checks = Vec::new();
    let platform_supported =
        distribution_supports_platform(&probe.entry.distribution, &probe.platform);
    let install_fixes = install_fixes(&probe.entry);
    // A separate ACP adapter must never be offered as an install target until
    // its delegated local CLI is actually usable. Otherwise a user can end up
    // with an adapter's bundled CLI (or a dead bridge) before the Runtime that
    // VibeX is required to launch has been installed/updated.
    let cli_ready_for_separate_adapter = local_cli_ready_for_separate_adapter(&probe);
    let bridge_install_fixes = if cli_ready_for_separate_adapter {
        install_fixes.clone()
    } else {
        Vec::new()
    };

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

    if let Some(prerequisite) = prerequisite_check(
        &probe.entry.distribution,
        probe.npm_available,
        probe.node_version.as_deref(),
        probe.uv_available,
        probe.uv_version.as_deref(),
    ) {
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
            bridge_install_fixes.clone()
        },
    ));

    // Preserve this fact before consuming the optional version below.  A
    // successful adapter probe must not also advertise an install action:
    // that made "Auto fix" reinstall an already-working ACP adapter.
    let adapter_available = probe.adapter_version.is_some();
    let adapter_meets_minimum = adapter_available
        && probe
            .adapter_minimum_version
            .as_deref()
            .is_none_or(|minimum| {
                probe
                    .adapter_version
                    .as_deref()
                    .is_some_and(|actual| version_at_least(actual, minimum))
            });
    // A resolved ACP executable that cannot report a compatible version is an
    // update case, not a fresh-install case. This matters for shared
    // runtimes such as OpenCode, where the ACP command is part of the CLI.
    let adapter_fixes = if !cli_ready_for_separate_adapter {
        Vec::new()
    } else if probe.runtime_path.is_some() && !adapter_meets_minimum {
        upgrade_fixes(&probe.entry)
    } else {
        install_fixes.clone()
    };
    checks.push(check(
        "adapter_version",
        "ACP adapter version",
        if adapter_meets_minimum {
            AgentPreflightCheckStatus::Pass
        } else {
            AgentPreflightCheckStatus::Warn
        },
        if !cli_ready_for_separate_adapter {
            let runtime = local_agent_runtime_spec(probe.entry.agent_type)
                .expect("separate adapter gate requires a local runtime spec");
            format!(
                "A compatible local {} CLI is required before VibeX can install or update the {} ACP adapter.",
                runtime.cli_program, runtime.acp_program
            )
        } else if let Some(version) = probe.adapter_version {
            if let Some(minimum) = probe.adapter_minimum_version {
                if version_at_least(&version, &minimum) {
                    version
                } else {
                    format!("{version}; minimum supported ACP adapter version: {minimum}.")
                }
            } else {
                version
            }
        } else if let Some(error) = probe.adapter_version_error {
            format!("Could not determine adapter version: {error}.")
        } else {
            "Could not determine adapter version.".to_string()
        },
        if adapter_meets_minimum {
            Vec::new()
        } else {
            adapter_fixes
        },
    ));

    if let Some(package) = probe.cli_package {
        checks.push(cli_version_check(
            &package,
            probe.cli_path,
            probe.cli_version,
            probe.cli_latest_version,
            probe.cli_version_error,
            local_agent_runtime_spec(probe.entry.agent_type)
                .and_then(|runtime| runtime.cli_minimum_supported_version),
        ));
    }

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

/// Combined CLI/ACP agents (for example OpenCode) are installed through their
/// CLI action. For separate adapters such as Codex/Claude, only expose bridge
/// actions after the local CLI exists and meets its declared compatibility
/// floor.
fn local_cli_ready_for_separate_adapter(probe: &AgentPreflightProbe) -> bool {
    let Some(runtime) = local_agent_runtime_spec(probe.entry.agent_type) else {
        return true;
    };
    if runtime.cli_program == runtime.acp_program {
        return true;
    }
    let Some(_) = probe.cli_path.as_deref() else {
        return false;
    };
    runtime.cli_minimum_supported_version.is_none_or(|minimum| {
        probe
            .cli_version
            .as_deref()
            .is_some_and(|version| version_at_least(version, minimum))
    })
}

fn cli_version_check(
    package: &str,
    path: Option<String>,
    installed: Option<String>,
    latest: Option<String>,
    error: Option<String>,
    minimum_supported: Option<&str>,
) -> AgentPreflightCheckItem {
    let install_fix = AgentPreflightFixAction::Custom {
        action: "install_cli".to_string(),
        label: "Install CLI".to_string(),
    };
    let update_fix = AgentPreflightFixAction::Custom {
        action: "upgrade_cli".to_string(),
        label: "Update CLI".to_string(),
    };
    match (installed, latest) {
        (_, _) if path.is_none() => check(
            "cli_version",
            "Agent CLI runtime",
            AgentPreflightCheckStatus::Fail,
            error.unwrap_or_else(|| format!("{package} CLI was not found on PATH.")),
            vec![install_fix],
        ),
        (Some(installed), _) if minimum_supported.is_some_and(|minimum| {
            !version_at_least(&installed, minimum)
        }) => {
            let minimum = minimum_supported.expect("minimum was checked above");
            check(
                "cli_version",
                "Agent CLI runtime",
                AgentPreflightCheckStatus::Fail,
                format!(
                    "Using local runtime {} ({installed}); minimum supported version: {minimum}. Update {package}.",
                    path.unwrap_or_else(|| package.to_string())
                ),
                vec![update_fix],
            )
        }
        (Some(installed), Some(latest)) => {
            let up_to_date = version_at_least(&installed, &latest);
            check(
                "cli_version",
                "Agent CLI runtime",
                if up_to_date {
                    AgentPreflightCheckStatus::Pass
                } else {
                    AgentPreflightCheckStatus::Warn
                },
                if up_to_date {
                    format!("Using local runtime {} ({installed}); latest: {latest}.", path.unwrap_or(package.to_string()))
                } else {
                    format!("Using local runtime {} ({installed}); latest: {latest}. Update {package}.", path.unwrap_or(package.to_string()))
                },
                if up_to_date { Vec::new() } else { vec![update_fix] },
            )
        }
        (Some(installed), None) => check(
            "cli_version",
            "Agent CLI runtime",
            AgentPreflightCheckStatus::Warn,
            error.unwrap_or_else(|| {
                format!("Using local runtime {} ({installed}); latest {package} version could not be checked.", path.unwrap_or(package.to_string()))
            }),
            Vec::new(),
        ),
        (None, _) => {
            let minimum_message = minimum_supported
                .map(|minimum| format!(" Required minimum version: {minimum}."))
                .unwrap_or_default();
            check(
                "cli_version",
                "Agent CLI runtime",
                if minimum_supported.is_some() {
                    AgentPreflightCheckStatus::Fail
                } else {
                    AgentPreflightCheckStatus::Warn
                },
                error.unwrap_or_else(|| {
                    format!(
                        "Found local runtime {}; its version could not be determined.{minimum_message}",
                        path.unwrap_or_else(|| package.to_string())
                    )
                }),
                vec![update_fix],
            )
        }
    }
}

fn prerequisite_check(
    distribution: &AgentDistribution,
    npm_available: Option<bool>,
    node_version: Option<&str>,
    uv_available: Option<bool>,
    uv_version: Option<&str>,
) -> Option<AgentPreflightCheckItem> {
    match distribution {
        AgentDistribution::Npx { node_required, .. } => Some(check(
            "node_prerequisite",
            "Node/npm prerequisite",
            versioned_prerequisite_status(npm_available, node_version, node_required.as_deref()),
            npm_prerequisite_message(npm_available, node_version, node_required.as_deref()),
            if versioned_prerequisite_status(npm_available, node_version, node_required.as_deref())
                == AgentPreflightCheckStatus::Fail
            {
                vec![AgentPreflightFixAction::OpenUrl {
                    label: "Install Node.js".to_string(),
                    url: "https://nodejs.org/en/download".to_string(),
                }]
            } else {
                Vec::new()
            },
        )),
        AgentDistribution::Uvx { uv_required, .. } => Some(check(
            "uv_prerequisite",
            "uv prerequisite",
            versioned_prerequisite_status(uv_available, uv_version, uv_required.as_deref()),
            uv_prerequisite_message(uv_available, uv_version, uv_required.as_deref()),
            if versioned_prerequisite_status(uv_available, uv_version, uv_required.as_deref())
                == AgentPreflightCheckStatus::Fail
            {
                vec![AgentPreflightFixAction::InstallUv {
                    label: "Install uv".to_string(),
                }]
            } else {
                Vec::new()
            },
        )),
        AgentDistribution::Binary { .. } | AgentDistribution::System { .. } => None,
    }
}

fn versioned_prerequisite_status(
    available: Option<bool>,
    installed_version: Option<&str>,
    required_version: Option<&str>,
) -> AgentPreflightCheckStatus {
    match available {
        Some(false) => AgentPreflightCheckStatus::Fail,
        None => AgentPreflightCheckStatus::Warn,
        Some(true) => match installed_version {
            // Resolving an npm shim is not sufficient: local ACP/CLI launch
            // commands need a working `node` executable on PATH as well.
            None => AgentPreflightCheckStatus::Fail,
            Some(installed) => match required_version {
                Some(required) if !version_at_least(installed, required) => {
                    AgentPreflightCheckStatus::Fail
                }
                _ => AgentPreflightCheckStatus::Pass,
            },
        },
    }
}

fn npm_prerequisite_message(
    npm_available: Option<bool>,
    node_version: Option<&str>,
    required_version: Option<&str>,
) -> String {
    let requirement = required_version
        .map(|version| format!("Requires Node.js >= {version} and npm/npx."))
        .unwrap_or_else(|| "Requires npm/npx.".to_string());
    match (npm_available, node_version) {
        (Some(false), _) => format!("{requirement} npm/npx was not found on PATH."),
        (Some(true), Some(version)) => format!("{requirement} Found Node.js {version}."),
        (Some(true), None) => format!("{requirement} Node.js version could not be determined."),
        (None, _) => format!("{requirement} Availability was not checked."),
    }
}

fn uv_prerequisite_message(
    uv_available: Option<bool>,
    uv_version: Option<&str>,
    required_version: Option<&str>,
) -> String {
    let requirement = required_version
        .map(|version| format!("Requires uv >= {version}."))
        .unwrap_or_else(|| "Requires uv/uvx.".to_string());
    match (uv_available, uv_version) {
        (Some(false), _) => format!("{requirement} uv was not found on PATH."),
        (Some(true), Some(version)) => format!("{requirement} Found uv {version}."),
        (Some(true), None) => format!("{requirement} uv version could not be determined."),
        (None, _) => format!("{requirement} Availability was not checked."),
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
    // OpenCode/Gemini/etc. expose ACP through their CLI itself.  Installing
    // their registry package is therefore a CLI install, not an independent
    // ACP install.  Keeping this distinction prevents Auto fix from applying
    // a separate ACP package after it has just installed the current CLI.
    if let Some(runtime) = local_agent_runtime_spec(entry.agent_type)
        && runtime.cli_program == runtime.acp_program
        && let Some(package) = runtime.npm_package
    {
        return vec![AgentPreflightFixAction::Custom {
            action: "install_cli".to_string(),
            label: format!("Install {package} CLI"),
        }];
    }

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

fn upgrade_fixes(entry: &AgentRegistryEntry) -> Vec<AgentPreflightFixAction> {
    if let Some(runtime) = local_agent_runtime_spec(entry.agent_type)
        && runtime.cli_program == runtime.acp_program
        && let Some(package) = runtime.npm_package
    {
        return vec![AgentPreflightFixAction::Custom {
            action: "upgrade_cli".to_string(),
            label: format!("Update {package} CLI"),
        }];
    }

    match &entry.distribution {
        AgentDistribution::Npx { package, .. } => vec![AgentPreflightFixAction::Custom {
            action: "upgrade_npm".to_string(),
            label: format!("Update {package}"),
        }],
        AgentDistribution::Binary { .. } | AgentDistribution::Uvx { .. } => install_fixes(entry),
        AgentDistribution::System { .. } => Vec::new(),
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
        let mut entry = registry_entry(AgentKind::Codex);
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
            adapter_minimum_version: None,
            cli_package: None,
            cli_path: None,
            cli_version: None,
            cli_latest_version: None,
            cli_version_error: None,
            npm_available: Some(true),
            node_version: Some("22.0.0".to_string()),
            uv_available: None,
            uv_version: None,
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
            entry: registry_entry(AgentKind::Gemini),
            platform: "windows-x86_64".to_string(),
            runtime_program: Some("npx.cmd".to_string()),
            runtime_path: Some("C:/node/npx.cmd".to_string()),
            runtime_lookup_error: None,
            adapter_version: Some("0.45.2".to_string()),
            adapter_version_error: None,
            adapter_minimum_version: None,
            cli_package: None,
            cli_path: None,
            cli_version: None,
            cli_latest_version: None,
            cli_version_error: None,
            npm_available: Some(true),
            node_version: Some("22.0.0".to_string()),
            uv_available: None,
            uv_version: None,
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
            entry: registry_entry(AgentKind::Opencode),
            platform: "windows-x86_64".to_string(),
            runtime_program: Some("opencode".to_string()),
            runtime_path: Some("C:/bin/opencode.exe".to_string()),
            runtime_lookup_error: None,
            adapter_version: Some("1.16.2".to_string()),
            adapter_version_error: None,
            adapter_minimum_version: None,
            cli_package: None,
            cli_path: None,
            cli_version: None,
            cli_latest_version: None,
            cli_version_error: None,
            npm_available: Some(true),
            node_version: Some("22.0.0".to_string()),
            uv_available: None,
            uv_version: None,
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

    #[test]
    fn preflight_offers_cli_update_only_when_installed_version_is_behind() {
        let report = build_preflight_report(AgentPreflightProbe {
            entry: registry_entry(AgentKind::Codex),
            platform: "darwin-aarch64".to_string(),
            runtime_program: Some("codex-acp".to_string()),
            runtime_path: Some("/usr/local/bin/codex-acp".to_string()),
            runtime_lookup_error: None,
            adapter_version: Some("1.1.2".to_string()),
            adapter_version_error: None,
            adapter_minimum_version: None,
            cli_package: Some("@openai/codex".to_string()),
            cli_path: Some("/Users/test/.local/bin/codex".to_string()),
            cli_version: Some("0.139.0".to_string()),
            cli_latest_version: Some("0.140.0".to_string()),
            cli_version_error: None,
            npm_available: Some(true),
            node_version: Some("22.0.0".to_string()),
            uv_available: None,
            uv_version: None,
            auth_found: true,
            auth_hint: None,
            network_available: Some(true),
        });
        let cli = report
            .checks
            .iter()
            .find(|check| check.check_id == "cli_version")
            .expect("CLI version check");
        assert_eq!(cli.status, AgentPreflightCheckStatus::Warn);
        assert_eq!(cli.fixes[0].action_key(), "upgrade_cli");
    }

    #[test]
    fn preflight_fails_a_cli_below_its_local_runtime_floor() {
        let report = build_preflight_report(AgentPreflightProbe {
            entry: registry_entry(AgentKind::Codex),
            platform: "darwin-aarch64".to_string(),
            runtime_program: Some("codex-acp".to_string()),
            runtime_path: Some("/usr/local/bin/codex-acp".to_string()),
            runtime_lookup_error: None,
            adapter_version: Some("1.1.2".to_string()),
            adapter_version_error: None,
            adapter_minimum_version: Some("1.1.2".to_string()),
            cli_package: Some("@openai/codex".to_string()),
            cli_path: Some("/Users/test/.local/bin/codex".to_string()),
            cli_version: Some("0.129.0".to_string()),
            cli_latest_version: None,
            cli_version_error: None,
            npm_available: Some(true),
            node_version: Some("22.0.0".to_string()),
            uv_available: None,
            uv_version: None,
            auth_found: true,
            auth_hint: None,
            network_available: Some(true),
        });
        let cli = report
            .checks
            .iter()
            .find(|check| check.check_id == "cli_version")
            .expect("CLI version check");
        assert_eq!(cli.status, AgentPreflightCheckStatus::Fail);
        assert!(cli.message.contains("minimum supported version: 0.130.0"));
        assert_eq!(cli.fixes[0].action_key(), "upgrade_cli");
    }

    #[test]
    fn preflight_offers_cli_install_when_local_cli_is_missing() {
        let report = build_preflight_report(AgentPreflightProbe {
            entry: registry_entry(AgentKind::Codex),
            platform: "darwin-aarch64".to_string(),
            runtime_program: Some("codex-acp".to_string()),
            runtime_path: Some("/usr/local/bin/codex-acp".to_string()),
            runtime_lookup_error: None,
            adapter_version: Some("1.1.2".to_string()),
            adapter_version_error: None,
            adapter_minimum_version: None,
            cli_package: Some("@openai/codex".to_string()),
            cli_path: None,
            cli_version: None,
            cli_latest_version: Some("0.140.0".to_string()),
            cli_version_error: None,
            npm_available: Some(true),
            node_version: Some("22.0.0".to_string()),
            uv_available: None,
            uv_version: None,
            auth_found: false,
            auth_hint: None,
            network_available: Some(true),
        });

        let cli = report
            .checks
            .iter()
            .find(|check| check.check_id == "cli_version")
            .expect("CLI version check");
        assert_eq!(cli.status, AgentPreflightCheckStatus::Fail);
        assert_eq!(cli.fixes[0].action_key(), "install_cli");

        let adapter = report
            .checks
            .iter()
            .find(|check| check.check_id == "adapter_version")
            .expect("adapter version check");
        assert!(adapter.fixes.is_empty());
    }

    #[test]
    fn separate_acp_is_not_actionable_until_the_local_cli_is_ready() {
        let report = build_preflight_report(AgentPreflightProbe {
            entry: registry_entry(AgentKind::Codex),
            platform: "darwin-aarch64".to_string(),
            runtime_program: Some("codex-acp".to_string()),
            runtime_path: None,
            runtime_lookup_error: None,
            adapter_version: None,
            adapter_version_error: None,
            adapter_minimum_version: Some("1.1.2".to_string()),
            cli_package: Some("@openai/codex".to_string()),
            cli_path: None,
            cli_version: None,
            cli_latest_version: Some("0.140.0".to_string()),
            cli_version_error: None,
            npm_available: Some(true),
            node_version: Some("22.0.0".to_string()),
            uv_available: None,
            uv_version: None,
            auth_found: false,
            auth_hint: None,
            network_available: Some(true),
        });

        let runtime = report
            .checks
            .iter()
            .find(|check| check.check_id == "runtime_launcher")
            .expect("runtime check");
        let adapter = report
            .checks
            .iter()
            .find(|check| check.check_id == "adapter_version")
            .expect("adapter check");
        let cli = report
            .checks
            .iter()
            .find(|check| check.check_id == "cli_version")
            .expect("CLI check");

        assert!(runtime.fixes.is_empty());
        assert!(adapter.fixes.is_empty());
        assert_eq!(cli.fixes[0].action_key(), "install_cli");
        assert!(adapter.message.contains("compatible local codex CLI"));
    }

    #[test]
    fn preflight_requires_a_verified_version_for_a_floored_local_cli() {
        let report = build_preflight_report(AgentPreflightProbe {
            entry: registry_entry(AgentKind::Codex),
            platform: "darwin-aarch64".to_string(),
            runtime_program: Some("codex-acp".to_string()),
            runtime_path: Some("/usr/local/bin/codex-acp".to_string()),
            runtime_lookup_error: None,
            adapter_version: Some("1.1.2".to_string()),
            adapter_version_error: None,
            adapter_minimum_version: Some("1.1.2".to_string()),
            cli_package: Some("@openai/codex".to_string()),
            cli_path: Some("/usr/local/bin/codex".to_string()),
            cli_version: None,
            cli_latest_version: Some("0.140.0".to_string()),
            cli_version_error: None,
            npm_available: Some(true),
            node_version: Some("22.0.0".to_string()),
            uv_available: None,
            uv_version: None,
            auth_found: true,
            auth_hint: None,
            network_available: Some(true),
        });

        let cli = report
            .checks
            .iter()
            .find(|check| check.check_id == "cli_version")
            .expect("CLI version check");
        assert_eq!(cli.status, AgentPreflightCheckStatus::Fail);
        assert!(cli.message.contains("/usr/local/bin/codex"));
        assert_eq!(cli.fixes[0].action_key(), "upgrade_cli");
    }

    #[test]
    fn preflight_treats_combined_opencode_runtime_as_a_cli_install() {
        let report = build_preflight_report(AgentPreflightProbe {
            entry: registry_entry(AgentKind::Opencode),
            platform: "darwin-aarch64".to_string(),
            runtime_program: Some("opencode".to_string()),
            runtime_path: None,
            runtime_lookup_error: None,
            adapter_version: None,
            adapter_version_error: None,
            adapter_minimum_version: None,
            cli_package: Some("opencode-ai".to_string()),
            cli_path: None,
            cli_version: None,
            cli_latest_version: None,
            cli_version_error: None,
            npm_available: Some(true),
            node_version: Some("22.0.0".to_string()),
            uv_available: None,
            uv_version: None,
            auth_found: false,
            auth_hint: None,
            network_available: Some(false),
        });

        let runtime = report
            .checks
            .iter()
            .find(|check| check.check_id == "runtime_launcher")
            .expect("runtime check");
        assert_eq!(runtime.status, AgentPreflightCheckStatus::Fail);
        assert_eq!(runtime.fixes[0].action_key(), "install_cli");
        assert!(
            report
                .checks
                .iter()
                .flat_map(|check| &check.fixes)
                .all(|fix| fix.action_key() != "install_npm")
        );
    }

    #[test]
    fn preflight_rejects_an_npm_runtime_with_an_old_node_version() {
        let report = build_preflight_report(AgentPreflightProbe {
            entry: registry_entry(AgentKind::Gemini),
            platform: "darwin-aarch64".to_string(),
            runtime_program: Some("gemini".to_string()),
            runtime_path: Some("/usr/local/bin/gemini".to_string()),
            runtime_lookup_error: None,
            adapter_version: Some("0.45.2".to_string()),
            adapter_version_error: None,
            adapter_minimum_version: None,
            cli_package: Some("@google/gemini-cli".to_string()),
            cli_path: Some("/usr/local/bin/gemini".to_string()),
            cli_version: Some("0.45.2".to_string()),
            cli_latest_version: None,
            cli_version_error: None,
            npm_available: Some(true),
            node_version: Some("v18.20.0".to_string()),
            uv_available: None,
            uv_version: None,
            auth_found: false,
            auth_hint: None,
            network_available: Some(true),
        });

        let prerequisite = report
            .checks
            .iter()
            .find(|check| check.check_id == "node_prerequisite")
            .expect("Node prerequisite");
        assert_eq!(prerequisite.status, AgentPreflightCheckStatus::Fail);
        assert!(prerequisite.message.contains("v18.20.0"));
        assert_eq!(
            prerequisite.fixes[0].action_key(),
            "open_url:https://nodejs.org/en/download"
        );
    }

    #[test]
    fn preflight_requires_a_working_node_binary_even_when_npm_resolves() {
        let report = build_preflight_report(AgentPreflightProbe {
            entry: registry_entry(AgentKind::Codex),
            platform: "darwin-aarch64".to_string(),
            runtime_program: Some("codex-acp".to_string()),
            runtime_path: Some("/usr/local/bin/codex-acp".to_string()),
            runtime_lookup_error: None,
            adapter_version: Some("1.1.2".to_string()),
            adapter_version_error: None,
            adapter_minimum_version: Some("1.1.2".to_string()),
            cli_package: None,
            cli_path: None,
            cli_version: None,
            cli_latest_version: None,
            cli_version_error: None,
            npm_available: Some(true),
            node_version: None,
            uv_available: None,
            uv_version: None,
            auth_found: true,
            auth_hint: None,
            network_available: Some(true),
        });

        let prerequisite = report
            .checks
            .iter()
            .find(|check| check.check_id == "node_prerequisite")
            .expect("Node prerequisite");
        assert_eq!(prerequisite.status, AgentPreflightCheckStatus::Fail);
        assert_eq!(
            prerequisite.fixes[0].action_key(),
            "open_url:https://nodejs.org/en/download"
        );
    }

    #[test]
    fn preflight_offers_an_acp_update_when_adapter_is_below_the_supported_minimum() {
        let report = build_preflight_report(AgentPreflightProbe {
            entry: registry_entry(AgentKind::Codex),
            platform: "darwin-aarch64".to_string(),
            runtime_program: Some("codex-acp".to_string()),
            runtime_path: Some("/usr/local/bin/codex-acp".to_string()),
            runtime_lookup_error: None,
            adapter_version: Some("1.0.2".to_string()),
            adapter_version_error: None,
            adapter_minimum_version: Some("1.1.2".to_string()),
            cli_package: Some("@openai/codex".to_string()),
            cli_path: Some("/usr/local/bin/codex".to_string()),
            cli_version: Some("0.139.0".to_string()),
            cli_latest_version: None,
            cli_version_error: None,
            npm_available: Some(true),
            node_version: Some("22.0.0".to_string()),
            uv_available: None,
            uv_version: None,
            auth_found: true,
            auth_hint: None,
            network_available: Some(true),
        });

        let adapter = report
            .checks
            .iter()
            .find(|check| check.check_id == "adapter_version")
            .expect("adapter version check");
        assert_eq!(adapter.status, AgentPreflightCheckStatus::Warn);
        assert_eq!(adapter.fixes[0].action_key(), "upgrade_npm");
        assert!(
            adapter
                .message
                .contains("minimum supported ACP adapter version: 1.1.2")
        );
    }

    #[test]
    fn preflight_accepts_an_acp_adapter_newer_than_the_supported_minimum() {
        let report = build_preflight_report(AgentPreflightProbe {
            entry: registry_entry(AgentKind::Codex),
            platform: "darwin-aarch64".to_string(),
            runtime_program: Some("codex-acp".to_string()),
            runtime_path: Some("/usr/local/bin/codex-acp".to_string()),
            runtime_lookup_error: None,
            adapter_version: Some("1.1.4".to_string()),
            adapter_version_error: None,
            adapter_minimum_version: Some("1.1.2".to_string()),
            cli_package: None,
            cli_path: None,
            cli_version: None,
            cli_latest_version: None,
            cli_version_error: None,
            npm_available: Some(true),
            node_version: Some("22.0.0".to_string()),
            uv_available: None,
            uv_version: None,
            auth_found: true,
            auth_hint: None,
            network_available: Some(true),
        });

        let adapter = report
            .checks
            .iter()
            .find(|check| check.check_id == "adapter_version")
            .expect("adapter version check");
        assert_eq!(adapter.status, AgentPreflightCheckStatus::Pass);
        assert!(adapter.fixes.is_empty());
    }
}
