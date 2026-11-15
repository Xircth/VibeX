use super::*;

pub(super) fn claude_code_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("claude_code").expect("bundled AgentId"),
        display_name: "Claude Code",
        description: "Anthropic Claude Code (official native engine)",
        icon: ProfileIcon {
            light: "/agents/claude-light.svg",
            dark: "/agents/claude-dark.svg",
        },
        registry_binding: None,
        topology: ProfileTopology::NativeEngine(crate::engine::NativeEngineKind::ClaudeNative),
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![npx(
            ProfileComponent::CombinedRuntime,
            "@anthropic-ai/claude-code",
            "2.1.325",
            "claude",
            ">=22",
            "sha512-OUxCb0sx734zJh9zGTP9oF01gZ44DCGFaw7hgD4byepjRRGyvHzgUOwC7dlCgVIljV6CiEVDjq+anY3GUvKFQw==",
        )],
        external_candidates: CLAUDE_CANDIDATES,
        dependencies: NODE_22_DEPENDENCIES,
        management_actions: CLAUDE_ACTIONS,
        runtime_executable_env: None,
        native_config: CLAUDE_CONFIG,
        settings_features: CLAUDE_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::ApiKeyThenAccount,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".claude",
            directory_override_env: Some("CLAUDE_CONFIG_DIR"),
            override_relative_directory: "",
            relative_file: ".credentials.json",
            kind: AccountEvidenceKind::NonEmptyStringAt(&["claudeAiOauth", "accessToken"]),
        }),
    }
}

pub(super) fn codex_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("codex").expect("bundled AgentId"),
        display_name: "Codex",
        description: "OpenAI Codex (official native app-server engine)",
        icon: ProfileIcon {
            light: "/agents/codex-light.svg",
            dark: "/agents/codex-dark.svg",
        },
        registry_binding: None,
        topology: ProfileTopology::NativeEngine(crate::engine::NativeEngineKind::CodexNative),
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![npx(
            ProfileComponent::CombinedRuntime,
            "@openai/codex",
            "0.169.0",
            "codex",
            ">=20",
            "sha512-KhzYlkKPxoNssR8CEm45IjqnFWn7UtlF4CiD3tOJPea51xBs7MaHy0UQG9GSbCqk6Lrjn5QdJDV0QD1/FgWlGw==",
        )],
        external_candidates: CODEX_CANDIDATES,
        dependencies: NODE_20_DEPENDENCIES,
        management_actions: CODEX_ACTIONS,
        runtime_executable_env: None,
        native_config: CODEX_CONFIG,
        settings_features: CODEX_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".codex",
            directory_override_env: Some("CODEX_HOME"),
            override_relative_directory: "",
            relative_file: "auth.json",
            kind: AccountEvidenceKind::NonEmptyStringAt(&["tokens", "access_token"]),
        }),
    }
}

pub(super) fn antigravity_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("antigravity").expect("bundled AgentId"),
        display_name: "Google Antigravity",
        description: "Google's AI coding agent (first-party ACP server)",
        icon: ProfileIcon {
            light: "/agents/antigravity.svg",
            dark: "/agents/antigravity.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "antigravity-acp",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: ANTIGRAVITY_PLATFORMS,
        install_sources: vec![ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: "1.4.1",
            command: "agy_acp_server",
            args: ANTIGRAVITY_LAUNCH_ARGS,
            artifacts: vec![
                tofu_binary_artifact(
                    "darwin-aarch64",
                    "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-arm64.zip",
                ),
                tofu_binary_artifact(
                    "darwin-x86_64",
                    "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-x86_64.zip",
                ),
                tofu_binary_artifact(
                    "linux-aarch64",
                    "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.1-linux-arm64.zip",
                ),
                tofu_binary_artifact(
                    "linux-x86_64",
                    "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.1-linux-x86_64.zip",
                ),
                tofu_binary_artifact(
                    "windows-aarch64",
                    "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.1-windows-arm64.zip",
                ),
                tofu_binary_artifact(
                    "windows-x86_64",
                    "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.1-windows-x86_64.zip",
                ),
            ],
            entry: Some(ProfileBinaryEntry {
                unix: "agy_acp_server.par",
                windows: "agy_acp_server.exe",
                unix_siblings: &["localharness_external"],
                windows_siblings: &["localharness_external.exe"],
            }),
        }],
        external_candidates: ANTIGRAVITY_CANDIDATES,
        dependencies: ARCHIVE_DEPENDENCIES,
        management_actions: ANTIGRAVITY_ACTIONS,
        runtime_executable_env: None,
        native_config: ANTIGRAVITY_CONFIG,
        settings_features: ANTIGRAVITY_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".gemini/antigravity-acp",
            directory_override_env: Some("GEMINI_HOME"),
            override_relative_directory: "antigravity-acp",
            relative_file: "acp_token.json",
            kind: AccountEvidenceKind::NonEmptyObject,
        }),
    }
}
pub(super) fn openclaw_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("openclaw").expect("bundled AgentId"),
        display_name: "OpenClaw",
        description: "OpenClaw Gateway agent with native ACP support",
        icon: ProfileIcon {
            light: "/agents/openclaw.svg",
            dark: "/agents/openclaw.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "openclaw-acp",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "openclaw",
            "2026.9.8",
            "openclaw",
            OPENCLAW_ACP_ARGS,
            ">=24.16.0",
            "sha512-G+JkNUhtpDE3cXR4AEi2NyyG9fqI/T2WUSl8ZnR8AATH8Dh1kC3qYFL7wwPoZtgHiP/cszA86PEiE0PDysxb9Q==",
        )],
        external_candidates: OPENCLAW_CANDIDATES,
        dependencies: NODE_24_16_DEPENDENCIES,
        management_actions: OPENCLAW_ACTIONS,
        runtime_executable_env: None,
        native_config: OPENCLAW_CONFIG,
        settings_features: &[
            AgentSettingsFeature::AuthenticationMode,
            AgentSettingsFeature::ReusableModelProviders,
            AgentSettingsFeature::NativeSkills,
        ],
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: false,
        account_evidence: None,
    }
}

pub(super) fn opencode_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("opencode").expect("bundled AgentId"),
        display_name: "OpenCode",
        description: "The OpenCode local Runtime with native ACP support",
        icon: ProfileIcon {
            light: "/agents/opencode-light.svg",
            dark: "/agents/opencode-dark.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "opencode",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: "1.19.3",
            command: "opencode",
            args: OPENCODE_ACP_ARGS,
            artifacts: vec![
                artifact(
                    "darwin-aarch64",
                    "opencode-darwin-arm64.zip",
                    "c2d0fecd27acf6e08be02c1f5d384614d07495587766bcc4a6bff3971749bb64",
                ),
                artifact(
                    "darwin-x86_64",
                    "opencode-darwin-x64.zip",
                    "4e29dbe2f61ace728370523c88027d0742b3a79edcdd2c70e404f616d4ef8f36",
                ),
                artifact(
                    "linux-aarch64",
                    "opencode-linux-arm64.tar.gz",
                    "7900818a6a98881edbbadab4b7525940eff3b9750040c200481f9f56cacee405",
                ),
                artifact(
                    "linux-x86_64",
                    "opencode-linux-x64.tar.gz",
                    "13a8fb2978302071b86f9d7e00da9c8895f9cd846978379c3bdc6a5333536c9b",
                ),
                artifact(
                    "windows-aarch64",
                    "opencode-windows-arm64.zip",
                    "c1b9daf18c97564b2d171703279621f7edc3613e70750d796ef78db87257ad89",
                ),
                artifact(
                    "windows-x86_64",
                    "opencode-windows-x64.zip",
                    "e4ce9117f55fc068414513789f8c7d1049f855d7518bb4e350b9170a3a20d8c3",
                ),
            ],
            entry: None,
        }],
        external_candidates: OPENCODE_CANDIDATES,
        dependencies: ARCHIVE_DEPENDENCIES,
        management_actions: OPENCODE_ACTIONS,
        runtime_executable_env: None,
        native_config: OPENCODE_CONFIG,
        settings_features: OPENCODE_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: false,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".local/share",
            directory_override_env: Some("XDG_DATA_HOME"),
            override_relative_directory: "",
            relative_file: "opencode/auth.json",
            kind: AccountEvidenceKind::ProviderEntryNotApiKey,
        }),
    }
}

pub(super) fn cline_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("cline").expect("bundled AgentId"),
        display_name: "Cline",
        description: "Cline's official CLI agent with native ACP support",
        icon: ProfileIcon {
            light: "/agents/cline.svg",
            dark: "/agents/cline.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "cline",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "cline",
            "3.0.73",
            "cline",
            CLINE_ACP_ARGS,
            ">=22",
            "sha512-4lx7qC8X2neX7k3RIshwkFw0zuzSFQ7Tua+8v/6MgLDcAI/hjUWiR7GVUmbyFtH1oOazaoAD/xR1GQeX1f2NNQ==",
        )],
        external_candidates: CLINE_CANDIDATES,
        dependencies: NODE_22_DEPENDENCIES,
        management_actions: CLINE_ACTIONS,
        runtime_executable_env: None,
        native_config: CLINE_CONFIG,
        settings_features: &[
            AgentSettingsFeature::AuthenticationMode,
            AgentSettingsFeature::ReusableModelProviders,
            AgentSettingsFeature::NativeMcp,
            AgentSettingsFeature::NativeSkills,
        ],
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".cline/data",
            directory_override_env: Some("CLINE_DIR"),
            override_relative_directory: "",
            relative_file: "secrets.json",
            kind: AccountEvidenceKind::NonEmptyObject,
        }),
    }
}

pub(super) fn hermes_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("hermes").expect("bundled AgentId"),
        display_name: "Hermes Agent",
        description: "Nous Research Hermes self-improving agent via ACP",
        icon: ProfileIcon {
            light: "/agents/hermes.png",
            dark: "/agents/hermes.png",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "hermes",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "hermes-agent",
            "0.22.2",
            "hermes",
            HERMES_ACP_ARGS,
            ">=20",
            "sha512-kIOJcnV6pKkNXgszXIJbXtc46sx/Lp1k2VJ2hV8CYF7KsGGwcHnBjkALYFHj/cfXbFZ6uo/mYy12D6BMjrMCdw==",
        )],
        external_candidates: HERMES_CANDIDATES,
        dependencies: NODE_20_DEPENDENCIES,
        management_actions: HERMES_ACTIONS,
        runtime_executable_env: None,
        native_config: HERMES_CONFIG,
        settings_features: &[
            AgentSettingsFeature::AuthenticationMode,
            AgentSettingsFeature::ReusableModelProviders,
            AgentSettingsFeature::NativeMcp,
            AgentSettingsFeature::NativeSkills,
        ],
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: true,
        account_evidence: None,
    }
}

pub(super) fn codebuddy_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("codebuddy").expect("bundled AgentId"),
        display_name: "CodeBuddy",
        description: "Tencent Cloud CodeBuddy official coding assistant via ACP",
        icon: ProfileIcon {
            light: "/agents/codebuddy.svg",
            dark: "/agents/codebuddy.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "codebuddy-code",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "@tencent-ai/codebuddy-code",
            "2.168.2",
            "codebuddy",
            CODEBUDDY_ACP_ARGS,
            ">=22",
            "sha512-3E4/YB1S5+wQabbXCR2DBb5GDs3fo6XxVf+sA05Kj7gXGCTzcaaJ10MBNbb9A69uVx/S2PAOunVS10QBjG+Wow==",
        )],
        external_candidates: CODEBUDDY_CANDIDATES,
        dependencies: NODE_22_DEPENDENCIES,
        management_actions: CODEBUDDY_ACTIONS,
        runtime_executable_env: None,
        native_config: CODEBUDDY_CONFIG,
        settings_features: &[
            AgentSettingsFeature::AuthenticationMode,
            AgentSettingsFeature::ReusableModelProviders,
            AgentSettingsFeature::NativeMcp,
            AgentSettingsFeature::NativeSkills,
        ],
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: false,
        account_evidence: None,
    }
}

pub(super) fn kimi_code_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("kimi_code").expect("bundled AgentId"),
        display_name: "Kimi Code",
        description: "Moonshot AI's official CLI coding assistant via ACP",
        icon: ProfileIcon {
            light: "/agents/kimi.svg",
            dark: "/agents/kimi.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "kimi-code",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "@moonshot-ai/kimi-code",
            "2.2.0",
            "kimi",
            KIMI_ACP_ARGS,
            ">=22.19",
            "sha512-I1w2l6JGYEUSwA1DTvYrw/kDJYjJQKHFON+RON61epDeTITvwpXoDn4Kgl4atA82RfwcsMp3KG6k8Yaoj6LT0A==",
        )],
        external_candidates: KIMI_CANDIDATES,
        dependencies: NODE_22_19_DEPENDENCIES,
        management_actions: KIMI_ACTIONS,
        runtime_executable_env: None,
        native_config: KIMI_CONFIG,
        settings_features: KIMI_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".kimi-code",
            directory_override_env: Some("KIMI_CODE_HOME"),
            override_relative_directory: "",
            relative_file: "credentials/kimi-code.json",
            kind: AccountEvidenceKind::NonEmptyObject,
        }),
    }
}

pub(super) fn artifact(
    platform: &'static str,
    filename: &'static str,
    sha256: &'static str,
) -> ProfileBinaryArtifact {
    ProfileBinaryArtifact {
        platform,
        archive_url: match filename {
            "opencode-darwin-arm64.zip" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.19.3/opencode-darwin-arm64.zip"
            }
            "opencode-darwin-x64.zip" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.19.3/opencode-darwin-x64.zip"
            }
            "opencode-linux-arm64.tar.gz" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.19.3/opencode-linux-arm64.tar.gz"
            }
            "opencode-linux-x64.tar.gz" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.19.3/opencode-linux-x64.tar.gz"
            }
            "opencode-windows-arm64.zip" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.19.3/opencode-windows-arm64.zip"
            }
            "opencode-windows-x64.zip" => {
                "https://github.com/anomalyco/opencode/releases/download/v1.19.3/opencode-windows-x64.zip"
            }
            _ => unreachable!("bundled OpenCode artifact"),
        },
        sha256: Some(sha256),
    }
}

pub(super) fn pi_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("pi").expect("bundled AgentId"),
        display_name: "Pi",
        description: "Pi coding agent through the pi ACP adapter",
        icon: ProfileIcon {
            light: "/agents/pi.svg",
            dark: "/agents/pi.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "pi-acp",
        }),
        topology: ProfileTopology::AdapterBacked,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![
            npx(
                ProfileComponent::AgentRuntime,
                "@earendil-works/pi-coding-agent",
                "0.83.0",
                "pi",
                ">=22",
                "sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw==",
            ),
            npx(
                ProfileComponent::AcpAdapter,
                "pi-acp",
                "0.0.34",
                "pi-acp",
                ">=22",
                "sha512-MrCp37UbpUzkTkzTIMJQf1RYrT+kr4fgGDGFoLmBN26UupuCZp0XxVIY+7XYsMo3yDnzDeZUJ0jPyM3Si6Bkkg==",
            ),
        ],
        external_candidates: PI_CANDIDATES,
        dependencies: NODE_22_DEPENDENCIES,
        management_actions: PI_ACTIONS,
        runtime_executable_env: None,
        native_config: PI_CONFIG,
        settings_features: PI_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".pi/agent",
            directory_override_env: Some("PI_CODING_AGENT_DIR"),
            override_relative_directory: "",
            relative_file: "auth.json",
            kind: AccountEvidenceKind::ProviderEntryNotApiKey,
        }),
    }
}

pub(super) fn grok_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("grok").expect("bundled AgentId"),
        display_name: "Grok",
        description: "xAI's official coding agent via grok agent stdio",
        icon: ProfileIcon {
            light: "/agents/grok.svg",
            dark: "/agents/grok.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "grok-build",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "@xai-official/grok",
            "1.0.62",
            "grok",
            GROK_ACP_ARGS,
            ">=20",
            "sha512-MYDKmYYv4CiYdvgWe575fIko5s1KnvShvHXbobkEusR7rVG0B61t6fOgTFZ8BoIloqkfrC0EBQDB9F0r3P7L6w==",
        )],
        external_candidates: GROK_CANDIDATES,
        dependencies: NODE_20_DEPENDENCIES,
        management_actions: GROK_ACTIONS,
        runtime_executable_env: None,
        native_config: GROK_CONFIG,
        settings_features: AUTH_MODE_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".grok",
            directory_override_env: Some("GROK_HOME"),
            override_relative_directory: "",
            relative_file: "auth.json",
            kind: AccountEvidenceKind::NonEmptyObject,
        }),
    }
}

pub(super) fn cursor_profile() -> BuiltInProfile {
    const VERSION: &str = "2026.10.16-e3cb207";
    BuiltInProfile {
        agent_id: AgentId::parse("cursor").expect("bundled AgentId"),
        display_name: "Cursor",
        description: "Cursor's coding agent via cursor-agent acp",
        icon: ProfileIcon {
            light: "/agents/cursor-light.svg",
            dark: "/agents/cursor-dark.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "cursor",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: VERSION,
            command: "cursor-agent",
            args: CURSOR_ACP_ARGS,
            artifacts: vec![
                binary_artifact(
                    "darwin-aarch64",
                    "https://downloads.cursor.com/lab/2026.10.16-e3cb207/darwin/arm64/agent-cli-package.tar.gz",
                    "5f04d196a84ddb5c20a4a466bdd74e3695bfb447e3c4a1e6071364b2b9497dd0",
                ),
                binary_artifact(
                    "darwin-x86_64",
                    "https://downloads.cursor.com/lab/2026.10.16-e3cb207/darwin/x64/agent-cli-package.tar.gz",
                    "93372e384e9397b54b1e4fdb1812662f68e7b61c0c60cb3f2f4b788c9e0779c4",
                ),
                binary_artifact(
                    "linux-aarch64",
                    "https://downloads.cursor.com/lab/2026.10.16-e3cb207/linux/arm64/agent-cli-package.tar.gz",
                    "4cf077f150eb8d1e270bf1dea69700184c39a4847fe192d523f5bb34d4b62597",
                ),
                binary_artifact(
                    "linux-x86_64",
                    "https://downloads.cursor.com/lab/2026.10.16-e3cb207/linux/x64/agent-cli-package.tar.gz",
                    "3aa3f48cd7a3909a98c9b3f2a4085f0c021088bf826690b22c61f424c843e552",
                ),
                binary_artifact(
                    "windows-aarch64",
                    "https://downloads.cursor.com/lab/2026.10.16-e3cb207/windows/arm64/agent-cli-package.zip",
                    "2cc883fbd67b18f55cd9f65455a472f62abe577da6fbebbd33b0130d0d79d9d0",
                ),
                binary_artifact(
                    "windows-x86_64",
                    "https://downloads.cursor.com/lab/2026.10.16-e3cb207/windows/x64/agent-cli-package.zip",
                    "8ec735f06234310c062c07d68d2940a249356aff49a40fb158b27af210310848",
                ),
            ],
            entry: Some(ProfileBinaryEntry {
                unix: "dist-package/cursor-agent",
                windows: "dist-package/cursor-agent.cmd",
                unix_siblings: &[],
                windows_siblings: &[],
            }),
        }],
        external_candidates: CURSOR_CANDIDATES,
        dependencies: ARCHIVE_DEPENDENCIES,
        management_actions: CURSOR_ACTIONS,
        runtime_executable_env: None,
        native_config: CURSOR_CONFIG,
        settings_features: CURSOR_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: None,
    }
}

pub(super) fn deepseek_harness_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("deepseek_harness").expect("bundled AgentId"),
        display_name: "DeepSeek Harness",
        description: "DeepSeek Harness through the community deepseek-acp adapter",
        icon: ProfileIcon {
            light: "/agents/deepseek-harness-light.svg",
            dark: "/agents/deepseek-harness-dark.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "deepseek-acp",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        // 0.9.0 matches Codeg: stdio ACP, no args. Keep `version` and
        // `package` in lockstep with the reviewed Codeg pin.
        install_sources: vec![native_npx(
            "deepseek-acp",
            "0.9.0",
            "deepseek-acp",
            &[],
            ">=22",
            "sha512-OG6Ia7GkdjP7UCnFPT8yooZncMo/c2fjpR7BlzuBp7EPF8b+Kohzkhj5U4kJN0vIS9txf50jb3R8CHZcmIZSgg==",
        )],
        external_candidates: DEEPSEEK_HARNESS_CANDIDATES,
        dependencies: NODE_22_DEPENDENCIES,
        management_actions: DEEPSEEK_HARNESS_ACTIONS,
        runtime_executable_env: None,
        native_config: DEEPSEEK_HARNESS_CONFIG,
        settings_features: DEEPSEEK_HARNESS_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::SingleSource,
        authentication_required_by_default: true,
        account_evidence: None,
    }
}

pub(super) fn community_managed_profiles() -> Vec<BuiltInProfile> {
    vec![mimo_code_profile()]
}

pub(super) fn mimo_code_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("mimo_code").expect("bundled AgentId"),
        display_name: "MiMo Code",
        description: "Xiaomi MiMo Code through native ACP",
        icon: ProfileIcon {
            light: "/agents/mimo-code-light.svg",
            dark: "/agents/mimo-code-dark.svg",
        },
        registry_binding: None,
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "@mimo-ai/cli",
            "0.1.14",
            "mimo",
            MIMO_ACP_ARGS,
            ">=20",
            "sha512-L9OQjAeIuWNu9MRKGmaj+aARzY2ShbfugO3ivo0rb9r8OmvolaI0W/iTTbtTwBbBHwqyHuffdplyhFlDouWVug==",
        )],
        external_candidates: MIMO_CANDIDATES,
        dependencies: NODE_20_DEPENDENCIES,
        management_actions: MIMO_ACTIONS,
        runtime_executable_env: None,
        native_config: MIMO_CONFIG,
        settings_features: MIMO_CODE_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".local/share/mimocode",
            directory_override_env: Some("MIMOCODE_HOME"),
            override_relative_directory: "data",
            relative_file: "auth.json",
            kind: AccountEvidenceKind::ProviderEntryNotApiKey,
        }),
    }
}

pub(super) fn qoder_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("qoder").expect("bundled AgentId"),
        display_name: "Qoder",
        description: "Qoder CLI's coding agent over native ACP",
        icon: ProfileIcon {
            light: "/agents/qoder.svg",
            dark: "/agents/qoder.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "qoder",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "@qoder-ai/qodercli",
            "1.1.73",
            "qodercli",
            QODER_ACP_ARGS,
            ">=20",
            "sha512-OdmmSppZUAZWL5ZEEORV5BNplXgAaa5cFMXnmNPStvIlknJ1fiyykgY6AjsP1t7OgWuVlh76vDK8lpbPNRlmBQ==",
        )],
        external_candidates: QODER_CANDIDATES,
        dependencies: NODE_20_DEPENDENCIES,
        management_actions: QODER_ACTIONS,
        runtime_executable_env: None,
        native_config: QODER_CONFIG,
        settings_features: QODER_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: Some(AccountEvidence {
            home_relative_directory: ".qoder",
            directory_override_env: Some("QODER_CONFIG_DIR"),
            override_relative_directory: "",
            relative_file: "settings.json",
            kind: AccountEvidenceKind::NonEmptyStringAt(&["security", "auth", "selectedType"]),
        }),
    }
}

pub(super) fn kiro_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("kiro").expect("bundled AgentId"),
        display_name: "Kiro CLI",
        description: "Kiro CLI's coding agent over native ACP",
        icon: ProfileIcon {
            light: "/agents/kiro.svg",
            dark: "/agents/kiro.svg",
        },
        registry_binding: None,
        topology: ProfileTopology::NativeAcp,
        supported_platforms: KIRO_PLATFORMS,
        install_sources: vec![ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: "2.32.0",
            command: "kiro-cli",
            args: KIRO_ACP_ARGS,
            artifacts: vec![
                binary_artifact(
                    "linux-x86_64",
                    "https://prod.download.cli.kiro.dev/stable/2.33.1/kirocli-x86_64-linux.zip",
                    "1ea738240f50734581edb1326ea7db24ceb66ad22df39cd01b7669243e2fe828",
                ),
                binary_artifact(
                    "linux-aarch64",
                    "https://prod.download.cli.kiro.dev/stable/2.33.1/kirocli-aarch64-linux.zip",
                    "8ce43b948650b497020bd1ca1b936db705796a9504d1056111ff577272a6206f",
                ),
                tofu_binary_artifact("windows-x86_64", "https://cli.kiro.dev/install.ps1"),
                tofu_binary_artifact("darwin-aarch64", "https://cli.kiro.dev/install"),
                tofu_binary_artifact("darwin-x86_64", "https://cli.kiro.dev/install"),
            ],
            entry: None,
        }],
        external_candidates: KIRO_CANDIDATES,
        dependencies: ARCHIVE_DEPENDENCIES,
        management_actions: KIRO_ACTIONS,
        runtime_executable_env: None,
        native_config: &[],
        settings_features: SUBSCRIPTION_AUTH_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: None,
    }
}

pub(super) fn auggie_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("auggie").expect("bundled AgentId"),
        display_name: "Auggie",
        description: "Augment CLI's coding agent over native ACP",
        icon: ProfileIcon {
            light: "/agents/auggie.svg",
            dark: "/agents/auggie.svg",
        },
        registry_binding: Some(ProfileRegistryBinding {
            registry_id: "auggie",
        }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "@augmentcode/auggie",
            "0.36.0",
            "auggie",
            AUGGIE_ACP_ARGS,
            ">=22",
            "sha512-jb4kq97pGzG0i5UyISc//LjTVlFzIywwD+VfPemiSIl58KjLfxry3KDgxWYnr1vmV8yUkySVzjLnj4ewUEbT/Q==",
        )],
        external_candidates: AUGGIE_CANDIDATES,
        dependencies: NODE_22_DEPENDENCIES,
        management_actions: AUGGIE_ACTIONS,
        runtime_executable_env: None,
        native_config: &[],
        settings_features: PROVIDER_AUTH_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: None,
    }
}

pub(super) fn trae_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("trae").expect("bundled AgentId"),
        display_name: "TRAE CLI",
        description: "TRAE CLI's coding agent over native ACP",
        icon: ProfileIcon {
            light: "/agents/trae.svg",
            dark: "/agents/trae.svg",
        },
        registry_binding: None,
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: "0.209.1",
            command: "traex",
            args: TRAE_ACP_ARGS,
            artifacts: vec![
                binary_artifact(
                    "darwin-x86_64",
                    "https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/releases/0.209.1/traex-macos-x86_64.gz",
                    "67f3d5e21ee2eaf2b4349423d2a1b44e70ef174546ad8b1f5cf83c264f9cfb6b",
                ),
                binary_artifact(
                    "darwin-aarch64",
                    "https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/releases/0.209.1/traex-macos-aarch64.gz",
                    "16f35e5bf7c5f8aa53783e40eef99c96dd9208227084c2fabd0029cb97b4d813",
                ),
                binary_artifact(
                    "linux-x86_64",
                    "https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/releases/0.209.1/traex-linux-x86_64.gz",
                    "643cf93b876e89ea5c72c87d3448b26690c6b71e45b3a7756b914d2ca53c1405",
                ),
                binary_artifact(
                    "linux-aarch64",
                    "https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/releases/0.209.1/traex-linux-aarch64.gz",
                    "63205dfddf6ae479d0148f7caa10e2487231c442da2d1db44e5388f08923d00b",
                ),
                binary_artifact(
                    "windows-x86_64",
                    "https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/releases/0.209.1/traex-windows-x86_64.exe.gz",
                    "b794b482ef9212c72ab985575b869c08d26d0f54a761d7ac45d83ea8aa7bfac4",
                ),
                binary_artifact(
                    "windows-aarch64",
                    "https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/releases/0.209.1/traex-windows-aarch64.exe.gz",
                    "30b0c71e41f75bc2d130537053a589f6d3422ff2085f80c8f9c8c1d20c72f477",
                ),
            ],
            entry: None,
        }],
        external_candidates: TRAE_CANDIDATES,
        dependencies: ARCHIVE_DEPENDENCIES,
        management_actions: TRAE_ACTIONS,
        runtime_executable_env: None,
        native_config: &[],
        settings_features: PROVIDER_AUTH_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: None,
    }
}

pub(super) fn command_code_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("command_code").expect("bundled AgentId"),
        display_name: "Command Code",
        description: "Command Code CLI's coding agent over native ACP",
        icon: ProfileIcon {
            light: "/agents/command-code.svg",
            dark: "/agents/command-code.svg",
        },
        registry_binding: None,
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "command-code",
            "1.84.0",
            "command-code",
            COMMAND_CODE_ACP_ARGS,
            ">=22",
            "sha512-LiBTBYI7mF0RmdkYlqm+2yEsfoMWPDckBpCZzF22rxNuVOlKATiZ7UwOh+G9cyDgOzNL+s0Fg31yb1TP55szyA==",
        )],
        external_candidates: COMMAND_CODE_CANDIDATES,
        dependencies: NODE_22_DEPENDENCIES,
        management_actions: COMMAND_CODE_ACTIONS,
        runtime_executable_env: None,
        native_config: &[],
        settings_features: COMMAND_CODE_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: None,
    }
}

pub(super) fn zcode_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("zcode").expect("bundled AgentId"),
        display_name: "ZCode",
        description: "ZCode's coding agent through the pinned ACP bridge",
        icon: ProfileIcon {
            light: "/agents/zcode.svg",
            dark: "/agents/zcode.svg",
        },
        registry_binding: None,
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "zcode-acp-server",
            "0.72.0",
            "zcode-acp-server",
            ZCODE_ACP_ARGS,
            ">=22",
            "sha512-zQzsh/c35NNqLr3iyGwM+UBOyx+93sZ4R3GUFB4ZWjU35r1ThBkDh2Gp/s0d6RpeBI9bysk/bLZlI5DDealBOw==",
        )],
        external_candidates: ZCODE_CANDIDATES,
        dependencies: NODE_22_DEPENDENCIES,
        management_actions: ZCODE_ACTIONS,
        runtime_executable_env: None,
        native_config: &[],
        settings_features: ZCODE_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: None,
    }
}

pub(super) const OMP_ACTIONS: &[ProfileManagementAction] = &[terminal_action(
    "login",
    "登录 OMP",
    "在终端里为 OMP 登录模型供应商",
    ProfileManagementActionKind::Login,
    &[program("omp", &["login"])],
)];

pub(super) const OMP_APPROVAL_MODE_OPTIONS: &[(&str, &str)] = &[
    ("always-ask", "每次询问"),
    ("always-ask-cached", "询问并记忆文件/目录"),
    ("write", "自动允许读写（命令询问）"),
    ("yolo", "自动允许全部（YOLO）"),
];

/// Credentials live in `agent.db` and `models.yml`, not `auth.json`. ACP
/// sessions do not discover disk MCP, so assignments saved to
/// `~/.omp/agent/mcp.json` are injected on `session/new`.
pub(super) const OMP_CONFIG: &[NativeConfigBinding] = &[NativeConfigBinding {
    binding_id: "config",
    home_relative_path: ".omp/agent/config.yml",
    directory_override_env: Some("PI_CODING_AGENT_DIR"),
    override_relative_path: "config.yml",
    format: NativeConfigFormat::Yaml,
    fields: &[
        select_field(
            "omp_approval_mode",
            "工具审批模式",
            "控制读写与命令执行工具的默认审批策略",
            &["tools", "approvalMode"],
            OMP_APPROVAL_MODE_OPTIONS,
        ),
        text_field(
            "omp_default_model",
            "默认模型",
            "新会话使用的模型",
            &["modelRoles", "default"],
        ),
        select_field(
            "omp_theme_dark",
            "深色主题",
            "深色模式下使用的主题",
            &["theme", "dark"],
            PI_THEME_OPTIONS,
        ),
        boolean_field(
            "omp_compaction_enabled",
            "自动压缩上下文",
            "上下文接近上限时压缩历史",
            &["compaction", "enabled"],
        ),
        number_field(
            "omp_compaction_reserve_tokens",
            "压缩预留 Token",
            "为模型回复预留的 Token 数",
            &["compaction", "reserveTokens"],
        ),
    ],
}];

pub(super) const OMP_SETTINGS: &[AgentSettingsFeature] = &[
    AgentSettingsFeature::AuthenticationMode,
    AgentSettingsFeature::ReusableModelProviders,
    AgentSettingsFeature::NativeMcp,
    AgentSettingsFeature::NativeSkills,
];

pub(super) fn omp_profile() -> BuiltInProfile {
    BuiltInProfile {
        agent_id: AgentId::parse("omp").expect("bundled AgentId"),
        display_name: "OMP",
        description: "oh-my-pi coding agent over its native ACP server",
        icon: ProfileIcon {
            light: "/agents/omp-light.svg",
            dark: "/agents/omp-dark.svg",
        },
        // Not an official ACP Registry id. Present so a later registry entry
        // with this id binds to this profile instead of creating a second agent.
        registry_binding: Some(ProfileRegistryBinding { registry_id: "omp" }),
        topology: ProfileTopology::NativeAcp,
        supported_platforms: DESKTOP_PLATFORMS,
        install_sources: vec![native_npx(
            "@oh-my-pi/pi-coding-agent",
            "18.8.0",
            "omp",
            OMP_ACP_ARGS,
            ">=20",
            "sha512-i0m5z+sljos+Fb7GwKhtXimAbvZ3EOiulyN9RiDeVy0yl1UtNlErgp2O376EurT263rD7C/CAbVOp9EyK7saOQ==",
        )],
        external_candidates: OMP_CANDIDATES,
        dependencies: OMP_DEPENDENCIES,
        management_actions: OMP_ACTIONS,
        runtime_executable_env: None,
        native_config: OMP_CONFIG,
        settings_features: OMP_SETTINGS,
        authentication_precedence: AuthenticationPrecedence::AccountThenApiKey,
        authentication_required_by_default: true,
        account_evidence: None,
    }
}

pub(super) const fn binary_artifact(
    platform: &'static str,
    archive_url: &'static str,
    sha256: &'static str,
) -> ProfileBinaryArtifact {
    ProfileBinaryArtifact {
        platform,
        archive_url,
        sha256: Some(sha256),
    }
}

pub(super) const fn tofu_binary_artifact(
    platform: &'static str,
    archive_url: &'static str,
) -> ProfileBinaryArtifact {
    ProfileBinaryArtifact {
        platform,
        archive_url,
        sha256: None,
    }
}
