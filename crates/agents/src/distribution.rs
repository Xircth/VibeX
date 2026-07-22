use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::AgentError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlatformBinary {
    pub platform: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentDistribution {
    Npx {
        // Oldest package version verified as compatible with VibeX. The user's
        // installed version may be newer and is never pinned here.
        minimum_supported_version: String,
        // Unversioned npm package name. Installers choose the release channel.
        package: String,
        cmd: String,
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        node_required: Option<String>,
    },
    Binary {
        version: String,
        cmd: String,
        args: Vec<String>,
        platforms: Vec<PlatformBinary>,
    },
    Uvx {
        version: String,
        package: String,
        cmd: String,
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        uv_required: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        python_required: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        system_command: Option<SystemCommand>,
    },
    System {
        cmd: String,
        args: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemCommand {
    pub cmd: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandBuildInput {
    pub platform: String,
    pub binary_dir: Option<String>,
    pub prefer_system_uvx_command: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CommandParts {
    pub program: String,
    pub args: Vec<String>,
}

pub type DistributionError = AgentError;

pub fn current_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        other => other,
    };
    let arch = std::env::consts::ARCH;
    format!("{os}-{arch}")
}

impl AgentDistribution {
    pub fn command_parts(&self, input: &CommandBuildInput) -> Result<CommandParts, AgentError> {
        match self {
            Self::Npx {
                package, cmd, args, ..
            } => {
                let mut out = vec!["-y".to_string(), package.clone()];
                if !cmd.trim().is_empty() {
                    out.push(cmd.clone());
                }
                out.extend(args.clone());
                Ok(CommandParts {
                    program: "npx".to_string(),
                    args: out,
                })
            }
            Self::Binary {
                cmd,
                args,
                platforms,
                ..
            } => {
                platforms
                    .iter()
                    .find(|candidate| candidate.platform == input.platform)
                    .ok_or_else(|| AgentError::UnsupportedPlatform {
                        agent: cmd.clone(),
                        platform: input.platform.clone(),
                    })?;
                let program = input
                    .binary_dir
                    .as_ref()
                    .map(|dir| format!("{dir}/{cmd}"))
                    .unwrap_or_else(|| cmd.clone());
                Ok(CommandParts {
                    program,
                    args: args.clone(),
                })
            }
            Self::Uvx {
                package: _package,
                cmd,
                args,
                system_command,
                ..
            } if input.prefer_system_uvx_command && system_command.is_some() => {
                let system = system_command.as_ref().expect("checked is_some");
                let mut out = system.args.clone();
                out.extend(args.clone());
                Ok(CommandParts {
                    program: system.cmd.clone(),
                    args: out,
                })
            }
            Self::Uvx {
                package, cmd, args, ..
            } => {
                let mut out = vec!["--from".to_string(), package.clone(), cmd.clone()];
                out.extend(args.clone());
                Ok(CommandParts {
                    program: "uvx".to_string(),
                    args: out,
                })
            }
            Self::System { cmd, args } => Ok(CommandParts {
                program: cmd.clone(),
                args: args.clone(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> CommandBuildInput {
        CommandBuildInput {
            platform: "windows-x86_64".to_string(),
            binary_dir: Some("C:/cache/bin".to_string()),
            prefer_system_uvx_command: false,
        }
    }

    #[test]
    fn npx_distribution_builds_package_command() {
        let dist = AgentDistribution::Npx {
            minimum_supported_version: "1.0.0".to_string(),
            package: "pkg".to_string(),
            cmd: "agent".to_string(),
            args: vec!["--acp".to_string()],
            node_required: Some("20.0.0".to_string()),
        };

        let parts = dist.command_parts(&input()).unwrap();
        assert_eq!(parts.program, "npx");
        assert_eq!(parts.args, ["-y", "pkg", "agent", "--acp"]);
    }

    #[test]
    fn binary_distribution_requires_matching_platform() {
        let dist = AgentDistribution::Binary {
            version: "0.1.0".to_string(),
            cmd: "codex-acp".to_string(),
            args: vec![],
            platforms: vec![PlatformBinary {
                platform: "linux-x86_64".to_string(),
                url: "https://example.test/linux.tar.gz".to_string(),
            }],
        };

        assert!(matches!(
            dist.command_parts(&input()),
            Err(AgentError::UnsupportedPlatform { .. })
        ));
    }

    #[test]
    fn binary_distribution_builds_installed_binary_command() {
        let dist = AgentDistribution::Binary {
            version: "1.16.2".to_string(),
            cmd: "opencode".to_string(),
            args: vec!["acp".to_string()],
            platforms: vec![PlatformBinary {
                platform: "windows-x86_64".to_string(),
                url: "https://example.test/opencode.zip".to_string(),
            }],
        };

        let parts = dist.command_parts(&input()).unwrap();
        assert_eq!(parts.program, "C:/cache/bin/opencode");
        assert_eq!(parts.args, ["acp"]);
    }

    #[test]
    fn uvx_distribution_can_use_system_alternative() {
        let dist = AgentDistribution::Uvx {
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
        };
        let input = CommandBuildInput {
            prefer_system_uvx_command: true,
            ..input()
        };

        let parts = dist.command_parts(&input).unwrap();
        assert_eq!(parts.program, "hermes");
        assert_eq!(parts.args, ["acp"]);
    }
}
