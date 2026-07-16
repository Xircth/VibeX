use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

/// The stable agent identity. Re-exported from [`api_types::AgentKind`] — the single
/// system-wide identity enum (ADR-0002, 批次D2). Kept under the historical `AgentKind`
/// name during the staged migration; call sites move to `AgentKind` crate-by-crate.
pub use api_types::AgentKind;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    distribution::{AgentDistribution, CommandParts, SystemCommand},
    error::AgentError,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentRegistryEntry {
    pub agent_type: AgentKind,
    pub registry_id: String,
    pub name: String,
    pub description: String,
    pub distribution: AgentDistribution,
}

/// Local executables required for VibeX's ACP launch.  The adapter is only a
/// protocol bridge; the actual agent CLI must be explicitly selected so an
/// adapter's bundled dependency can never silently replace the user's CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalAgentRuntimeSpec {
    pub acp_program: &'static str,
    pub acp_args: &'static [&'static str],
    pub cli_program: &'static str,
    pub cli_path_env: Option<&'static str>,
    pub npm_package: Option<&'static str>,
    /// The oldest CLI version VibeX can safely launch. `None` means the
    /// registry does not currently impose a minimum version gate.
    pub cli_minimum_supported_version: Option<&'static str>,
}

/// Internal launch setting used by VibeX to pin an ACP spawn to the exact
/// executable it already resolved and verified from the user's PATH. It is
/// deliberately stripped before the child process starts.
pub const ACP_EXECUTABLE_OVERRIDE_ENV: &str = "VIBEX_AGENT_ACP_EXECUTABLE";

/// Return the ACP executable explicitly approved by VibeX's local-runtime
/// verification layer.
///
/// ACP adapters such as `codex-acp` and `claude-agent-acp` can carry their own
/// bundled CLI dependency. A bare adapter command is therefore *not* a safe
/// fallback: it can silently start a different Agent version than the local
/// CLI the user installed. Every Agent with a local runtime contract must
/// consequently receive an absolute ACP path, plus an absolute delegated CLI
/// path where its adapter supports that override. Only non-local/test agents
/// may use a distribution-provided command.
pub fn local_runtime_launch_acp_executable(
    agent_type: AgentKind,
    env: &HashMap<String, String>,
) -> Result<Option<PathBuf>, AgentError> {
    let Some(runtime) = local_agent_runtime_spec(agent_type) else {
        return Ok(None);
    };

    let acp_path = required_absolute_launch_path(
        agent_type,
        ACP_EXECUTABLE_OVERRIDE_ENV,
        "ACP executable",
        env,
    )?;
    if let Some(cli_path_env) = runtime.cli_path_env {
        let _ =
            required_absolute_launch_path(agent_type, cli_path_env, "Agent CLI executable", env)?;
    }

    Ok(Some(acp_path))
}

fn required_absolute_launch_path(
    agent_type: AgentKind,
    key: &str,
    component: &str,
    env: &HashMap<String, String>,
) -> Result<PathBuf, AgentError> {
    let value = env
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AgentError::Runtime(format!(
                "{agent_type} requires an explicitly verified local {component}; missing {key}. Refusing to fall back to an adapter-bundled runtime."
            ))
        })?;
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(AgentError::Runtime(format!(
            "{agent_type} requires {key} to be an absolute path to the verified local {component}. Refusing to fall back to an adapter-bundled runtime."
        )));
    }
    Ok(path.to_path_buf())
}

pub fn local_agent_runtime_spec(agent_type: AgentKind) -> Option<LocalAgentRuntimeSpec> {
    let spec = match agent_type {
        AgentKind::Codex => LocalAgentRuntimeSpec {
            acp_program: "codex-acp",
            acp_args: &[],
            cli_program: "codex",
            cli_path_env: Some("CODEX_PATH"),
            npm_package: Some("@openai/codex"),
            cli_minimum_supported_version: Some("0.130.0"),
        },
        AgentKind::ClaudeCode => LocalAgentRuntimeSpec {
            acp_program: "claude-agent-acp",
            acp_args: &[],
            cli_program: "claude",
            cli_path_env: Some("CLAUDE_CODE_EXECUTABLE"),
            npm_package: Some("@anthropic-ai/claude-code"),
            cli_minimum_supported_version: Some("2.1.143"),
        },
        AgentKind::Opencode => LocalAgentRuntimeSpec {
            acp_program: "opencode",
            acp_args: &["acp"],
            cli_program: "opencode",
            cli_path_env: None,
            npm_package: Some("opencode-ai"),
            // OpenCode's ACP server is embedded in the CLI, so its CLI floor
            // must match the ACP compatibility floor below. A split floor
            // would incorrectly label a single old binary as a healthy CLI
            // plus a separately-updatable ACP bridge.
            cli_minimum_supported_version: Some("1.18.2"),
        },
        AgentKind::Gemini => LocalAgentRuntimeSpec {
            acp_program: "gemini",
            acp_args: &["--acp", "--skip-trust"],
            cli_program: "gemini",
            cli_path_env: None,
            npm_package: Some("@google/gemini-cli"),
            cli_minimum_supported_version: None,
        },
        AgentKind::Openclaw => LocalAgentRuntimeSpec {
            acp_program: "openclaw",
            acp_args: &["acp"],
            cli_program: "openclaw",
            cli_path_env: None,
            npm_package: Some("openclaw"),
            cli_minimum_supported_version: None,
        },
        AgentKind::Cline => LocalAgentRuntimeSpec {
            acp_program: "cline",
            acp_args: &["--acp"],
            cli_program: "cline",
            cli_path_env: None,
            npm_package: Some("cline"),
            cli_minimum_supported_version: None,
        },
        AgentKind::Hermes => LocalAgentRuntimeSpec {
            acp_program: "hermes",
            acp_args: &["acp"],
            cli_program: "hermes",
            cli_path_env: None,
            npm_package: None,
            cli_minimum_supported_version: None,
        },
        AgentKind::QaMock => return None,
    };
    Some(spec)
}

pub fn local_acp_command_parts(agent_type: AgentKind) -> Option<CommandParts> {
    let spec = local_agent_runtime_spec(agent_type)?;
    Some(CommandParts {
        program: spec.acp_program.to_string(),
        args: spec.acp_args.iter().map(ToString::to_string).collect(),
    })
}

/// The oldest ACP bridge build verified against this agent integration.
///
/// This is intentionally derived from the registry distribution rather than
/// duplicated in local-runtime launch code: an adapter's registry version is
/// the compatibility floor, while installation may safely request `@latest`.
pub fn minimum_supported_acp_version(agent_type: AgentKind) -> Option<String> {
    match registry_entry(agent_type).distribution {
        AgentDistribution::Npx { version, .. }
        | AgentDistribution::Binary { version, .. }
        | AgentDistribution::Uvx { version, .. } => Some(version),
        AgentDistribution::System { .. } => None,
    }
}

pub fn all_agent_types() -> Vec<AgentKind> {
    vec![
        AgentKind::ClaudeCode,
        AgentKind::Codex,
        AgentKind::Opencode,
        AgentKind::Gemini,
        AgentKind::Openclaw,
        AgentKind::Cline,
        AgentKind::Hermes,
    ]
}

pub fn registry_id_for(agent_type: AgentKind) -> &'static str {
    match agent_type {
        AgentKind::ClaudeCode => "claude-acp",
        AgentKind::Codex => "codex-acp",
        AgentKind::Opencode => "opencode",
        AgentKind::Gemini => "gemini",
        AgentKind::Openclaw => "openclaw-acp",
        AgentKind::Cline => "cline",
        AgentKind::Hermes => "hermes",
        AgentKind::QaMock => "qa-mock",
    }
}

pub fn agent_type_from_registry_id(id: &str) -> Option<AgentKind> {
    match id {
        "claude-acp" => Some(AgentKind::ClaudeCode),
        "codex-acp" => Some(AgentKind::Codex),
        "opencode" => Some(AgentKind::Opencode),
        "gemini" => Some(AgentKind::Gemini),
        "openclaw-acp" => Some(AgentKind::Openclaw),
        "cline" => Some(AgentKind::Cline),
        "hermes" => Some(AgentKind::Hermes),
        _ => None,
    }
}

pub fn registry_entry(agent_type: AgentKind) -> AgentRegistryEntry {
    let (name, description, distribution) = match agent_type {
        AgentKind::ClaudeCode => (
            "Claude Code",
            "ACP wrapper for Anthropic's Claude",
            AgentDistribution::Npx {
                version: "0.59.0".to_string(),
                package: "@agentclientprotocol/claude-agent-acp@0.59.0".to_string(),
                cmd: "claude-agent-acp".to_string(),
                args: vec![],
                node_required: None,
            },
        ),
        AgentKind::Codex => (
            "Codex CLI",
            "ACP adapter for OpenAI's coding assistant",
            AgentDistribution::Npx {
                version: "1.1.4".to_string(),
                package: "@agentclientprotocol/codex-acp@1.1.4".to_string(),
                cmd: "codex-acp".to_string(),
                args: vec![],
                node_required: None,
            },
        ),
        AgentKind::Opencode => (
            "OpenCode",
            "OpenCode ACP server",
            AgentDistribution::Npx {
                // OpenCode 1.18.2 exposes the ACP model/effort dependency
                // controls VibeX consumes. Keep this as the tested
                // compatibility floor (not an installer pin): installs still
                // request `@latest` through the Settings flow.
                version: "1.18.2".to_string(),
                package: "opencode-ai@1.18.2".to_string(),
                cmd: "opencode".to_string(),
                args: vec!["acp".to_string()],
                node_required: None,
            },
        ),
        AgentKind::Gemini => (
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
        AgentKind::Openclaw => (
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
        AgentKind::Cline => (
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
        AgentKind::Hermes => (
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
        AgentKind::QaMock => (
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
                AgentKind::ClaudeCode,
                AgentKind::Codex,
                AgentKind::Opencode,
                AgentKind::Gemini,
                AgentKind::Openclaw,
                AgentKind::Cline,
                AgentKind::Hermes,
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
    fn local_acp_commands_never_use_npx_and_codex_injects_a_cli_path() {
        let codex = local_agent_runtime_spec(AgentKind::Codex).expect("Codex runtime");
        assert_eq!(codex.acp_program, "codex-acp");
        assert_eq!(codex.cli_program, "codex");
        assert_eq!(codex.cli_path_env, Some("CODEX_PATH"));
        assert_eq!(codex.cli_minimum_supported_version, Some("0.130.0"));

        let opencode = local_acp_command_parts(AgentKind::Opencode).expect("OpenCode command");
        assert_eq!(opencode.program, "opencode");
        assert_eq!(opencode.args, ["acp"]);
    }

    fn absolute_test_path(name: &str) -> String {
        std::env::temp_dir()
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn local_runtime_launch_fails_closed_without_verified_overrides() {
        let empty = HashMap::new();
        let codex_error = local_runtime_launch_acp_executable(AgentKind::Codex, &empty)
            .expect_err("Codex must not launch a bare adapter");
        assert!(
            codex_error
                .to_string()
                .contains(ACP_EXECUTABLE_OVERRIDE_ENV)
        );

        let mut codex_missing_cli = HashMap::new();
        codex_missing_cli.insert(
            ACP_EXECUTABLE_OVERRIDE_ENV.to_string(),
            absolute_test_path("codex-acp"),
        );
        let codex_error = local_runtime_launch_acp_executable(AgentKind::Codex, &codex_missing_cli)
            .expect_err("Codex must pass its explicitly verified CLI path");
        assert!(codex_error.to_string().contains("CODEX_PATH"));

        let mut claude_missing_cli = HashMap::new();
        claude_missing_cli.insert(
            ACP_EXECUTABLE_OVERRIDE_ENV.to_string(),
            absolute_test_path("claude-agent-acp"),
        );
        let claude_error =
            local_runtime_launch_acp_executable(AgentKind::ClaudeCode, &claude_missing_cli)
                .expect_err("Claude must pass its explicitly verified CLI path");
        assert!(claude_error.to_string().contains("CLAUDE_CODE_EXECUTABLE"));

        let mut opencode_relative = HashMap::new();
        opencode_relative.insert(
            ACP_EXECUTABLE_OVERRIDE_ENV.to_string(),
            "relative/opencode".to_string(),
        );
        let opencode_error =
            local_runtime_launch_acp_executable(AgentKind::Opencode, &opencode_relative)
                .expect_err("OpenCode must pass an absolute verified executable");
        assert!(opencode_error.to_string().contains("absolute path"));
    }

    #[test]
    fn local_runtime_launch_accepts_complete_absolute_overrides() {
        let mut codex = HashMap::new();
        let codex_acp = absolute_test_path("codex-acp");
        codex.insert(ACP_EXECUTABLE_OVERRIDE_ENV.to_string(), codex_acp.clone());
        codex.insert("CODEX_PATH".to_string(), absolute_test_path("codex"));
        assert_eq!(
            local_runtime_launch_acp_executable(AgentKind::Codex, &codex)
                .expect("Codex overrides should be accepted"),
            Some(PathBuf::from(codex_acp))
        );

        let mut claude = HashMap::new();
        let claude_acp = absolute_test_path("claude-agent-acp");
        claude.insert(ACP_EXECUTABLE_OVERRIDE_ENV.to_string(), claude_acp.clone());
        claude.insert(
            "CLAUDE_CODE_EXECUTABLE".to_string(),
            absolute_test_path("claude"),
        );
        assert_eq!(
            local_runtime_launch_acp_executable(AgentKind::ClaudeCode, &claude)
                .expect("Claude overrides should be accepted"),
            Some(PathBuf::from(claude_acp))
        );

        let mut opencode = HashMap::new();
        let opencode_acp = absolute_test_path("opencode");
        opencode.insert(
            ACP_EXECUTABLE_OVERRIDE_ENV.to_string(),
            opencode_acp.clone(),
        );
        assert_eq!(
            local_runtime_launch_acp_executable(AgentKind::Opencode, &opencode)
                .expect("OpenCode's embedded ACP should use its absolute executable"),
            Some(PathBuf::from(opencode_acp))
        );
    }

    #[test]
    fn acp_compatibility_floor_is_derived_from_the_registry_distribution() {
        assert_eq!(
            minimum_supported_acp_version(AgentKind::Codex).as_deref(),
            Some("1.1.4")
        );
        assert_eq!(
            minimum_supported_acp_version(AgentKind::ClaudeCode).as_deref(),
            Some("0.59.0")
        );
    }

    #[test]
    fn versioned_npm_registry_specs_match_their_compatibility_floor() {
        for agent_type in all_agent_types() {
            let entry = registry_entry(agent_type);
            if let AgentDistribution::Npx {
                version, package, ..
            } = entry.distribution
            {
                assert!(
                    package.ends_with(&format!("@{version}")),
                    "{agent_type} package {package} must carry the same version as its registry floor {version}"
                );
            }
        }
    }

    #[test]
    fn executor_keys_round_trip() {
        // The string `bind_external_id` persists in `sessions.agent_type` must
        // resolve back to the same agent so imported transcript metadata and
        // runtime bindings share the same key space.
        for agent in all_agent_types() {
            let key = agent.as_str();
            assert_eq!(
                AgentKind::from_lenient(key),
                Some(agent),
                "executor key {key:?} must round-trip"
            );
        }
    }

    #[test]
    fn registry_pins_codeg_style_versions() {
        let gemini = registry_entry(AgentKind::Gemini);
        assert!(matches!(
            gemini.distribution,
            AgentDistribution::Npx { ref version, ref package, .. }
                if version == "0.45.2" && package == "@google/gemini-cli@0.45.2"
        ));

        let codex = registry_entry(AgentKind::Codex);
        assert!(matches!(
            codex.distribution,
            AgentDistribution::Npx { ref version, ref package, .. }
                if version == "1.1.4" && package == "@agentclientprotocol/codex-acp@1.1.4"
        ));

        let opencode = registry_entry(AgentKind::Opencode);
        assert!(matches!(
            opencode.distribution,
            AgentDistribution::Npx { ref version, ref package, ref args, .. }
                if version == "1.18.2"
                    && package == "opencode-ai@1.18.2"
                    && args.as_slice() == ["acp"]
        ));
    }
}
