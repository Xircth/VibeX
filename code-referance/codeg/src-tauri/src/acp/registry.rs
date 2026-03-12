use crate::models::agent::AgentType;

#[derive(Debug, Clone)]
pub enum AgentDistribution {
    Npx {
        version: &'static str,
        package: &'static str,
        args: &'static [&'static str],
        env: &'static [(&'static str, &'static str)],
        /// Minimum Node.js version required, e.g. "22.12.0". None means no specific requirement.
        node_required: Option<&'static str>,
    },
    Uvx {
        version: &'static str,
        package: &'static str,
        args: &'static [&'static str],
        env: &'static [(&'static str, &'static str)],
    },
    Binary {
        version: &'static str,
        cmd: &'static str,
        args: &'static [&'static str],
        env: &'static [(&'static str, &'static str)],
        platforms: &'static [PlatformBinary],
    },
}

#[derive(Debug, Clone)]
pub struct PlatformBinary {
    pub platform: &'static str,
    pub url: &'static str,
}

#[derive(Debug, Clone)]
pub struct AcpAgentMeta {
    pub agent_type: AgentType,
    pub name: &'static str,
    pub description: &'static str,
    pub distribution: AgentDistribution,
}

impl AcpAgentMeta {
    pub fn registry_version(&self) -> Option<&'static str> {
        match &self.distribution {
            AgentDistribution::Npx { version, .. }
            | AgentDistribution::Uvx { version, .. }
            | AgentDistribution::Binary { version, .. } => Some(*version),
        }
    }
}

pub fn current_platform() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-aarch64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x86_64"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "windows-aarch64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x86_64"
    }
}

pub fn all_acp_agents() -> Vec<AgentType> {
    vec![
        AgentType::Auggie,
        AgentType::Autohand,
        AgentType::ClaudeCode,
        AgentType::Cline,
        AgentType::CodebuddyCode,
        AgentType::Codex,
        AgentType::CorustAgent,
        AgentType::FactoryDroid,
        AgentType::Gemini,
        AgentType::GithubCopilot,
        AgentType::Goose,
        AgentType::Junie,
        AgentType::Kimi,
        AgentType::MinionCode,
        AgentType::MistralVibe,
        AgentType::OpenClaw,
        AgentType::OpenCode,
        AgentType::Qoder,
        AgentType::QwenCode,
        AgentType::Stakpak,
    ]
}

pub fn registry_id_for(agent_type: AgentType) -> &'static str {
    match agent_type {
        AgentType::Auggie => "auggie",
        AgentType::Autohand => "autohand",
        AgentType::ClaudeCode => "claude-acp",
        AgentType::Cline => "cline",
        AgentType::CodebuddyCode => "codebuddy-code",
        AgentType::Codex => "codex-acp",
        AgentType::CorustAgent => "corust-agent",
        AgentType::FactoryDroid => "factory-droid",
        AgentType::Gemini => "gemini",
        AgentType::GithubCopilot => "github-copilot-cli",
        AgentType::Goose => "goose",
        AgentType::Junie => "junie",
        AgentType::Kimi => "kimi",
        AgentType::MinionCode => "minion-code",
        AgentType::MistralVibe => "mistral-vibe",
        AgentType::OpenClaw => "openclaw-acp",
        AgentType::OpenCode => "opencode",
        AgentType::Qoder => "qoder",
        AgentType::QwenCode => "qwen-code",
        AgentType::Stakpak => "stakpak",
    }
}

pub fn from_registry_id(id: &str) -> Option<AgentType> {
    match id {
        "auggie" => Some(AgentType::Auggie),
        "autohand" => Some(AgentType::Autohand),
        "claude-acp" => Some(AgentType::ClaudeCode),
        "cline" => Some(AgentType::Cline),
        "codebuddy-code" => Some(AgentType::CodebuddyCode),
        "codex-acp" => Some(AgentType::Codex),
        "corust-agent" => Some(AgentType::CorustAgent),
        "factory-droid" => Some(AgentType::FactoryDroid),
        "gemini" => Some(AgentType::Gemini),
        "github-copilot-cli" | "github-copilot" => Some(AgentType::GithubCopilot),
        "goose" => Some(AgentType::Goose),
        "junie" | "junie-acp" => Some(AgentType::Junie),
        "kimi" => Some(AgentType::Kimi),
        "minion-code" => Some(AgentType::MinionCode),
        "mistral-vibe" => Some(AgentType::MistralVibe),
        "openclaw-acp" => Some(AgentType::OpenClaw),
        "opencode" => Some(AgentType::OpenCode),
        "qoder" => Some(AgentType::Qoder),
        "qwen-code" => Some(AgentType::QwenCode),
        "stakpak" => Some(AgentType::Stakpak),
        _ => None,
    }
}

pub fn get_agent_meta(agent_type: AgentType) -> AcpAgentMeta {
    debug_assert_eq!(
        from_registry_id(registry_id_for(agent_type)),
        Some(agent_type)
    );
    match agent_type {
        AgentType::Auggie => AcpAgentMeta {
            agent_type,
            name: "Auggie CLI",
            description: "Augment Code's powerful software agent, backed by industry-leading context engine",
            distribution: AgentDistribution::Npx {
                version: "0.18.1",
                package: "@augmentcode/auggie@0.18.1",
                args: &["--acp"],
                env: &[("AUGMENT_DISABLE_AUTO_UPDATE", "1")],
                node_required: None,
            },
        },
        AgentType::Autohand => AcpAgentMeta {
            agent_type,
            name: "Autohand Code",
            description: "Autohand Code - AI coding agent powered by Autohand AI",
            distribution: AgentDistribution::Npx {
                version: "0.2.1",
                package: "@autohandai/autohand-acp@0.2.1",
                args: &[],
                env: &[],
                node_required: None,
            },
        },
        AgentType::ClaudeCode => AcpAgentMeta {
            agent_type,
            name: "Claude Code",
            description: "ACP wrapper for Anthropic's Claude",
            distribution: AgentDistribution::Npx {
                version: "0.21.0",
                package: "@zed-industries/claude-agent-acp@0.21.0",
                args: &[],
                env: &[],
                node_required: None,
            },
        },
        AgentType::Cline => AcpAgentMeta {
            agent_type,
            name: "Cline",
            description: "Autonomous coding agent CLI - capable of creating/editing files, running commands, using the browser, and more",
            distribution: AgentDistribution::Npx {
                version: "2.6.1",
                package: "cline@2.6.1",
                args: &["--acp"],
                env: &[],
                node_required: None,
            },
        },
        AgentType::CodebuddyCode => AcpAgentMeta {
            agent_type,
            name: "Codebuddy Code",
            description: "Tencent Cloud's official intelligent coding tool",
            distribution: AgentDistribution::Npx {
                version: "2.55.1",
                package: "@tencent-ai/codebuddy-code@2.55.1",
                args: &["--acp"],
                env: &[],
                node_required: None,
            },
        },
        AgentType::Codex => AcpAgentMeta {
            agent_type,
            name: "Codex CLI",
            description: "ACP adapter for OpenAI's coding assistant",
            distribution: AgentDistribution::Binary {
                version: "0.9.5",
                cmd: "codex-acp",
                args: &[],
                env: &[],
                platforms: &[
                    PlatformBinary {
                        platform: "darwin-aarch64",
                        url: "https://github.com/zed-industries/codex-acp/releases/download/v0.9.5/codex-acp-0.9.5-aarch64-apple-darwin.tar.gz",
                    },
                    PlatformBinary {
                        platform: "darwin-x86_64",
                        url: "https://github.com/zed-industries/codex-acp/releases/download/v0.9.5/codex-acp-0.9.5-x86_64-apple-darwin.tar.gz",
                    },
                    PlatformBinary {
                        platform: "linux-aarch64",
                        url: "https://github.com/zed-industries/codex-acp/releases/download/v0.9.5/codex-acp-0.9.5-aarch64-unknown-linux-gnu.tar.gz",
                    },
                    PlatformBinary {
                        platform: "linux-x86_64",
                        url: "https://github.com/zed-industries/codex-acp/releases/download/v0.9.5/codex-acp-0.9.5-x86_64-unknown-linux-gnu.tar.gz",
                    },
                    PlatformBinary {
                        platform: "windows-aarch64",
                        url: "https://github.com/zed-industries/codex-acp/releases/download/v0.9.5/codex-acp-0.9.5-aarch64-pc-windows-msvc.zip",
                    },
                    PlatformBinary {
                        platform: "windows-x86_64",
                        url: "https://github.com/zed-industries/codex-acp/releases/download/v0.9.5/codex-acp-0.9.5-x86_64-pc-windows-msvc.zip",
                    },
                ],
            },
        },
        AgentType::CorustAgent => AcpAgentMeta {
            agent_type,
            name: "Corust Agent",
            description: "Co-building with a seasoned Rust partner.",
            distribution: AgentDistribution::Binary {
                version: "0.3.7",
                cmd: "corust-agent-acp",
                args: &[],
                env: &[],
                platforms: &[
                    PlatformBinary {
                        platform: "darwin-aarch64",
                        url: "https://github.com/Corust-ai/corust-agent-release/releases/download/v0.3.7/agent-darwin-arm64.tar.gz",
                    },
                    PlatformBinary {
                        platform: "linux-x86_64",
                        url: "https://github.com/Corust-ai/corust-agent-release/releases/download/v0.3.7/agent-linux-x64.tar.gz",
                    },
                    PlatformBinary {
                        platform: "windows-x86_64",
                        url: "https://github.com/Corust-ai/corust-agent-release/releases/download/v0.3.7/agent-windows-x64.zip",
                    },
                ],
            },
        },
        AgentType::FactoryDroid => AcpAgentMeta {
            agent_type,
            name: "Factory Droid",
            description: "Factory Droid - AI coding agent powered by Factory AI",
            distribution: AgentDistribution::Npx {
                version: "0.70.0",
                package: "droid@0.70.0",
                args: &["exec", "--output-format", "acp"],
                env: &[("DROID_DISABLE_AUTO_UPDATE", "true"), ("FACTORY_DROID_AUTO_UPDATE_ENABLED", "false")],
                node_required: None,
            },
        },
        AgentType::Gemini => AcpAgentMeta {
            agent_type,
            name: "Gemini CLI",
            description: "Google's official CLI for Gemini",
            distribution: AgentDistribution::Npx {
                version: "0.33.0",
                package: "@google/gemini-cli@0.33.0",
                args: &["--experimental-acp"],
                env: &[],
                node_required: None,
            },
        },
        AgentType::GithubCopilot => AcpAgentMeta {
            agent_type,
            name: "GitHub Copilot",
            description: "GitHub's AI pair programmer",
            distribution: AgentDistribution::Npx {
                version: "1.0.2",
                package: "@github/copilot@1.0.2",
                args: &["--acp"],
                env: &[],
                node_required: None,
            },
        },
        AgentType::Goose => AcpAgentMeta {
            agent_type,
            name: "goose",
            description: "A local, extensible, open source AI agent that automates engineering tasks",
            distribution: AgentDistribution::Binary {
                version: "1.27.2",
                cmd: "goose",
                args: &["acp"],
                env: &[],
                platforms: &[
                    PlatformBinary {
                        platform: "darwin-aarch64",
                        url: "https://github.com/block/goose/releases/download/v1.27.2/goose-aarch64-apple-darwin.tar.bz2",
                    },
                    PlatformBinary {
                        platform: "darwin-x86_64",
                        url: "https://github.com/block/goose/releases/download/v1.27.2/goose-x86_64-apple-darwin.tar.bz2",
                    },
                    PlatformBinary {
                        platform: "linux-aarch64",
                        url: "https://github.com/block/goose/releases/download/v1.27.2/goose-aarch64-unknown-linux-gnu.tar.bz2",
                    },
                    PlatformBinary {
                        platform: "linux-x86_64",
                        url: "https://github.com/block/goose/releases/download/v1.27.2/goose-x86_64-unknown-linux-gnu.tar.bz2",
                    },
                    PlatformBinary {
                        platform: "windows-x86_64",
                        url: "https://github.com/block/goose/releases/download/v1.27.2/goose-x86_64-pc-windows-msvc.zip",
                    },
                ],
            },
        },
        AgentType::Junie => AcpAgentMeta {
            agent_type,
            name: "Junie",
            description: "AI Coding Agent by JetBrains",
            distribution: AgentDistribution::Npx {
                version: "888.173.0",
                package: "@jetbrains/junie@888.173.0",
                args: &["--acp=true"],
                env: &[],
                node_required: None,
            },
        },
        AgentType::Kimi => AcpAgentMeta {
            agent_type,
            name: "Kimi CLI",
            description: "Moonshot AI's coding assistant",
            distribution: AgentDistribution::Binary {
                version: "1.17.0",
                cmd: "kimi",
                args: &["acp"],
                env: &[],
                platforms: &[
                    PlatformBinary {
                        platform: "darwin-aarch64",
                        url: "https://github.com/MoonshotAI/kimi-cli/releases/download/1.17.0/kimi-1.17.0-aarch64-apple-darwin.tar.gz",
                    },
                    PlatformBinary {
                        platform: "linux-aarch64",
                        url: "https://github.com/MoonshotAI/kimi-cli/releases/download/1.17.0/kimi-1.17.0-aarch64-unknown-linux-gnu.tar.gz",
                    },
                    PlatformBinary {
                        platform: "linux-x86_64",
                        url: "https://github.com/MoonshotAI/kimi-cli/releases/download/1.17.0/kimi-1.17.0-x86_64-unknown-linux-gnu.tar.gz",
                    },
                    PlatformBinary {
                        platform: "windows-x86_64",
                        url: "https://github.com/MoonshotAI/kimi-cli/releases/download/1.17.0/kimi-1.17.0-x86_64-pc-windows-msvc.zip",
                    },
                ],
            },
        },
        AgentType::MinionCode => AcpAgentMeta {
            agent_type,
            name: "Minion Code",
            description: "An enhanced AI code assistant built on the Minion framework with rich development tools",
            distribution: AgentDistribution::Uvx {
                version: "0.1.39",
                package: "minion-code@0.1.39",
                args: &["acp"],
                env: &[],
            },
        },
        AgentType::MistralVibe => AcpAgentMeta {
            agent_type,
            name: "Mistral Vibe",
            description: "Mistral's open-source coding assistant",
            distribution: AgentDistribution::Binary {
                version: "2.3.0",
                cmd: "vibe-acp",
                args: &[],
                env: &[],
                platforms: &[
                    PlatformBinary {
                        platform: "darwin-aarch64",
                        url: "https://github.com/mistralai/mistral-vibe/releases/download/v2.3.0/vibe-acp-darwin-aarch64-2.3.0.zip",
                    },
                    PlatformBinary {
                        platform: "darwin-x86_64",
                        url: "https://github.com/mistralai/mistral-vibe/releases/download/v2.3.0/vibe-acp-darwin-x86_64-2.3.0.zip",
                    },
                    PlatformBinary {
                        platform: "linux-aarch64",
                        url: "https://github.com/mistralai/mistral-vibe/releases/download/v2.3.0/vibe-acp-linux-aarch64-2.3.0.zip",
                    },
                    PlatformBinary {
                        platform: "linux-x86_64",
                        url: "https://github.com/mistralai/mistral-vibe/releases/download/v2.3.0/vibe-acp-linux-x86_64-2.3.0.zip",
                    },
                    PlatformBinary {
                        platform: "windows-aarch64",
                        url: "https://github.com/mistralai/mistral-vibe/releases/download/v2.3.0/vibe-acp-windows-aarch64-2.3.0.zip",
                    },
                    PlatformBinary {
                        platform: "windows-x86_64",
                        url: "https://github.com/mistralai/mistral-vibe/releases/download/v2.3.0/vibe-acp-windows-x86_64-2.3.0.zip",
                    },
                ],
            },
        },
        AgentType::OpenClaw => AcpAgentMeta {
            agent_type,
            name: "OpenClaw",
            description: "Open-source personal AI assistant with ACP bridge",
            distribution: AgentDistribution::Npx {
                version: "2026.2.26",
                package: "openclaw@2026.2.26",
                args: &["acp"],
                env: &[],
                node_required: Some("22.12.0"),
            },
        },
        AgentType::OpenCode => AcpAgentMeta {
            agent_type,
            name: "OpenCode",
            description: "The open source coding agent",
            distribution: AgentDistribution::Binary {
                version: "1.2.24",
                cmd: "opencode",
                args: &["acp"],
                env: &[],
                platforms: &[
                    PlatformBinary {
                        platform: "darwin-aarch64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v1.2.24/opencode-darwin-arm64.zip",
                    },
                    PlatformBinary {
                        platform: "darwin-x86_64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v1.2.24/opencode-darwin-x64.zip",
                    },
                    PlatformBinary {
                        platform: "linux-aarch64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v1.2.24/opencode-linux-arm64.tar.gz",
                    },
                    PlatformBinary {
                        platform: "linux-x86_64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v1.2.24/opencode-linux-x64.tar.gz",
                    },
                    PlatformBinary {
                        platform: "windows-x86_64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v1.2.24/opencode-windows-x64.zip",
                    },
                ],
            },
        },
        AgentType::Qoder => AcpAgentMeta {
            agent_type,
            name: "Qoder CLI",
            description: "AI coding assistant with agentic capabilities",
            distribution: AgentDistribution::Npx {
                version: "0.1.29",
                package: "@qoder-ai/qodercli@0.1.29",
                args: &["--acp"],
                env: &[],
                node_required: None,
            },
        },
        AgentType::QwenCode => AcpAgentMeta {
            agent_type,
            name: "Qwen Code",
            description: "Alibaba's Qwen coding assistant",
            distribution: AgentDistribution::Npx {
                version: "0.11.1",
                package: "@qwen-code/qwen-code@0.11.1",
                args: &["--acp", "--experimental-skills"],
                env: &[],
                node_required: None,
            },
        },
        AgentType::Stakpak => AcpAgentMeta {
            agent_type,
            name: "Stakpak",
            description: "Open-source DevOps agent in Rust with enterprise-grade security",
            distribution: AgentDistribution::Binary {
                version: "0.3.66",
                cmd: "stakpak",
                args: &["acp"],
                env: &[],
                platforms: &[
                    PlatformBinary {
                        platform: "darwin-aarch64",
                        url: "https://github.com/stakpak/agent/releases/download/v0.3.66/stakpak-darwin-aarch64.tar.gz",
                    },
                    PlatformBinary {
                        platform: "darwin-x86_64",
                        url: "https://github.com/stakpak/agent/releases/download/v0.3.66/stakpak-darwin-x86_64.tar.gz",
                    },
                    PlatformBinary {
                        platform: "linux-aarch64",
                        url: "https://github.com/stakpak/agent/releases/download/v0.3.66/stakpak-linux-aarch64.tar.gz",
                    },
                    PlatformBinary {
                        platform: "linux-x86_64",
                        url: "https://github.com/stakpak/agent/releases/download/v0.3.66/stakpak-linux-x86_64.tar.gz",
                    },
                    PlatformBinary {
                        platform: "windows-x86_64",
                        url: "https://github.com/stakpak/agent/releases/download/v0.3.66/stakpak-windows-x86_64.zip",
                    },
                ],
            },
        },
    }
}
