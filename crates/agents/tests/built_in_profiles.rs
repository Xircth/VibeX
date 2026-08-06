use agents::{
    AgentId, BuiltInProfileCatalog, NativeConfigFieldKind, ProfileComponent, ProfileInstallSource,
    ProfileManagementActionKind, RegistryEntryIdentity,
};
use api_types::AgentSettingsFeature;

fn native_field<'a>(
    catalog: &'a BuiltInProfileCatalog,
    agent_id: &str,
    field_id: &str,
) -> &'a agents::NativeConfigField {
    catalog
        .profile(&AgentId::parse(agent_id).unwrap())
        .unwrap()
        .native_config
        .iter()
        .flat_map(|binding| binding.fields)
        .find(|field| field.field_id == field_id)
        .unwrap_or_else(|| panic!("missing {agent_id}.{field_id}"))
}

#[test]
fn codeg_pinned_distribution_matrix_is_exact() {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = |id: &str| catalog.profile(&AgentId::parse(id).unwrap()).unwrap();

    for (id, component, package, version, command, node) in [
        (
            "claude_code",
            ProfileComponent::AcpAdapter,
            "@agentclientprotocol/claude-agent-acp",
            "0.64.1",
            "claude-agent-acp",
            ">=22",
        ),
        (
            "codex",
            ProfileComponent::AcpAdapter,
            "@agentclientprotocol/codex-acp",
            "1.1.9",
            "codex-acp",
            ">=20",
        ),
        (
            "gemini",
            ProfileComponent::CombinedRuntime,
            "@google/gemini-cli",
            "0.53.1",
            "gemini",
            ">=20",
        ),
        (
            "openclaw",
            ProfileComponent::CombinedRuntime,
            "openclaw",
            "2026.7.1",
            "openclaw",
            ">=22.22.3",
        ),
        (
            "cline",
            ProfileComponent::CombinedRuntime,
            "cline",
            "3.0.49",
            "cline",
            ">=22",
        ),
        (
            "codebuddy",
            ProfileComponent::CombinedRuntime,
            "@tencent-ai/codebuddy-code",
            "2.132.0",
            "codebuddy",
            ">=22",
        ),
        (
            "kimi_code",
            ProfileComponent::CombinedRuntime,
            "@moonshot-ai/kimi-code",
            "0.31.1",
            "kimi",
            ">=22.19",
        ),
        (
            "pi",
            ProfileComponent::AcpAdapter,
            "pi-acp",
            "0.0.33",
            "pi-acp",
            ">=22",
        ),
        (
            "grok",
            ProfileComponent::CombinedRuntime,
            "@xai-official/grok",
            "0.2.118",
            "grok",
            ">=20",
        ),
    ] {
        let source = profile(id)
            .install_sources
            .iter()
            .find(|source| {
                matches!(source, ProfileInstallSource::Npx { component: actual, .. } if *actual == component)
            })
            .unwrap_or_else(|| panic!("missing pinned npx source for {id}"));
        let ProfileInstallSource::Npx {
            package: actual_package,
            version: actual_version,
            command: actual_command,
            node_requirement,
            integrity,
            ..
        } = source
        else {
            unreachable!()
        };
        assert_eq!(*actual_package, package, "{id} package");
        assert_eq!(*actual_version, version, "{id} version");
        assert_eq!(*actual_command, command, "{id} command");
        assert_eq!(*node_requirement, node, "{id} Node requirement");
        assert!(!integrity.is_empty(), "{id} must pin npm integrity");
    }

    let opencode = profile("opencode").install_sources.first().unwrap();
    assert!(matches!(
        opencode,
        ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: "1.18.11",
            command: "opencode",
            ..
        }
    ));
    let cursor = profile("cursor").install_sources.first().unwrap();
    assert!(matches!(
        cursor,
        ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: "2026.07.23-e383d2b",
            command: "cursor-agent",
            ..
        }
    ));
    let hermes = profile("hermes").install_sources.first().unwrap();
    assert!(matches!(
        hermes,
        ProfileInstallSource::Uvx {
            component: ProfileComponent::CombinedRuntime,
            package: "hermes-agent[acp,mcp]==0.19.0",
            version: "0.19.0",
            command: "hermes-acp",
            uv_requirement: ">=0.5",
            python_requirement: ">=3.11,<3.14",
            ..
        }
    ));
}

#[test]
fn built_in_profiles_are_declarative_and_bind_explicitly() {
    let catalog = BuiltInProfileCatalog::bundled();
    let ids = catalog
        .profiles()
        .iter()
        .map(|profile| profile.agent_id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        [
            "claude_code",
            "codex",
            "gemini",
            "openclaw",
            "opencode",
            "cline",
            "hermes",
            "codebuddy",
            "kimi_code",
            "pi",
            "grok",
            "cursor",
        ]
    );

    for profile in catalog.profiles() {
        assert!(!profile.display_name.trim().is_empty());
        assert!(!profile.description.trim().is_empty());
        assert!(profile.icon.light.starts_with("/agents/"));
        assert!(profile.icon.dark.starts_with("/agents/"));
        assert!(!profile.supported_platforms.is_empty());
        assert!(!profile.install_sources.is_empty());
        assert!(!profile.external_candidates.is_empty());
        assert!(profile.registry_binding.is_some());
        assert!(!profile.dependencies.is_empty());
        assert!(profile.dependencies.iter().all(|dependency| {
            !dependency.id.is_empty()
                && !dependency.label.is_empty()
                && !dependency.executable.is_empty()
        }));
        assert!(profile.install_sources.iter().all(|source| match source {
            ProfileInstallSource::Npx { integrity, .. } => !integrity.trim().is_empty(),
            ProfileInstallSource::Uvx { package, .. } => package.contains("=="),
            ProfileInstallSource::Binary { artifacts, .. } => !artifacts.is_empty(),
        }));
    }

    for id in ["claude_code", "codex", "kimi_code", "grok", "cursor"] {
        let profile = catalog.profile(&AgentId::parse(id).unwrap()).unwrap();
        assert!(profile.management_actions.iter().any(|action| {
            action.kind == ProfileManagementActionKind::Login && action.program.is_some()
        }));
    }

    for id in ["claude_code", "codex"] {
        let profile = catalog.profile(&AgentId::parse(id).unwrap()).unwrap();
        assert!(profile.management_actions.iter().any(|action| {
            action.kind == ProfileManagementActionKind::Subscription && action.url.is_some()
        }));
    }

    let renamed = RegistryEntryIdentity {
        registry_id: "claude-acp".to_string(),
        display_name: "Renamed by upstream".to_string(),
    };
    assert_eq!(
        catalog.resolve_registry_entry(&renamed),
        Some(&AgentId::parse("claude_code").unwrap())
    );

    let similar_but_unbound = RegistryEntryIdentity {
        registry_id: "claude-acp-community".to_string(),
        display_name: "Claude Agent".to_string(),
    };
    assert_eq!(catalog.resolve_registry_entry(&similar_but_unbound), None);

    let runtime_bindings = catalog
        .profiles()
        .iter()
        .map(|profile| (profile.agent_id.as_str(), profile.runtime_executable_env))
        .collect::<Vec<_>>();
    assert_eq!(
        runtime_bindings,
        [
            ("claude_code", Some("CLAUDE_CODE_EXECUTABLE")),
            ("codex", Some("CODEX_PATH")),
            ("gemini", None),
            ("openclaw", None),
            ("opencode", None),
            ("cline", None),
            ("hermes", None),
            ("codebuddy", None),
            ("kimi_code", None),
            ("pi", None),
            ("grok", None),
            ("cursor", None),
        ]
    );
}

#[test]
fn codeg_account_action_matrix_is_complete() {
    let catalog = BuiltInProfileCatalog::bundled();
    for (agent_id, expected) in [
        ("claude_code", &["login", "logout", "subscription"][..]),
        ("codex", &["login", "logout", "subscription"][..]),
        ("gemini", &["login"][..]),
        ("openclaw", &["onboard"][..]),
        ("opencode", &["login", "logout"][..]),
        ("cline", &["login"][..]),
        ("hermes", &["setup", "model"][..]),
        ("codebuddy", &["login"][..]),
        ("kimi_code", &["login", "logout"][..]),
        ("pi", &["login"][..]),
        ("grok", &["login", "logout"][..]),
        ("cursor", &["login", "logout", "subscription"][..]),
    ] {
        let profile = catalog.profile(&AgentId::parse(agent_id).unwrap()).unwrap();
        assert_eq!(
            profile
                .management_actions
                .iter()
                .map(|action| action.id)
                .collect::<Vec<_>>(),
            expected,
            "{agent_id} account actions"
        );
        assert!(profile.management_actions.iter().all(|action| {
            (action.program.is_some() && action.url.is_none())
                || (action.program.is_none() && action.url.is_some())
        }));
    }
}

#[test]
fn every_built_in_binary_has_an_expected_sha256() {
    for profile in BuiltInProfileCatalog::bundled().profiles() {
        for source in &profile.install_sources {
            let ProfileInstallSource::Binary { artifacts, .. } = source else {
                continue;
            };
            for artifact in artifacts {
                let digest = artifact.sha256.unwrap_or_else(|| {
                    panic!(
                        "{}.{} must declare an expected SHA-256",
                        profile.agent_id, artifact.platform
                    )
                });
                assert_eq!(digest.len(), 64);
                assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
            }
        }
    }
}

#[test]
fn built_in_profiles_keep_codeg_advanced_configuration_contract() {
    let catalog = BuiltInProfileCatalog::bundled();

    for (agent_id, field_ids) in [
        (
            "claude_code",
            &[
                "reasoning_model",
                "custom_model_option",
                "claude_send_attribution_header",
                "claude_disable_nonessential_traffic",
            ][..],
        ),
        (
            "codex",
            &[
                "codex_skills",
                "codex_writable_roots",
                "codex_network_access",
                "codex_exclude_tmpdir",
                "codex_exclude_slash_tmp",
            ][..],
        ),
        (
            "kimi_code",
            &[
                "kimi_provider_env",
                "kimi_support_efforts",
                "kimi_default_effort",
            ][..],
        ),
        ("pi", &["pi_custom_providers"][..]),
        (
            "grok",
            &[
                "grok_custom_model_id",
                "grok_api_backend",
                "grok_context_window",
                "grok_auto_compact_threshold",
            ][..],
        ),
        (
            "cursor",
            &["cursor_model", "cursor_force", "cursor_sandbox_mode"][..],
        ),
    ] {
        for field_id in field_ids {
            native_field(&catalog, agent_id, field_id);
        }
    }

    let hermes_provider = native_field(&catalog, "hermes", "hermes_provider");
    assert_eq!(hermes_provider.kind, NativeConfigFieldKind::Select);
    assert_eq!(hermes_provider.options.len(), 37);
    for provider in [
        "openrouter",
        "anthropic",
        "kimi-coding-cn",
        "openai-codex",
        "google-gemini-cli",
        "bedrock",
    ] {
        assert!(
            hermes_provider
                .options
                .iter()
                .any(|(value, _)| *value == provider),
            "missing Hermes provider {provider}"
        );
    }

    assert_eq!(
        native_field(&catalog, "claude_code", "model").path,
        ["env", "ANTHROPIC_MODEL"]
    );
    assert_eq!(
        native_field(&catalog, "grok", "grok_permission").path,
        ["ui", "permission_mode"]
    );
    assert_eq!(
        native_field(&catalog, "cursor", "cursor_sandbox_mode").path,
        ["sandbox", "mode"]
    );
}

#[test]
fn codeg_directory_semantics_and_settings_capabilities_are_profile_declared() {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = |id: &str| catalog.profile(&AgentId::parse(id).unwrap()).unwrap();

    let gemini = profile("gemini");
    assert_eq!(
        gemini.native_config[0].directory_override_env,
        Some("GEMINI_CLI_HOME")
    );
    assert_eq!(
        gemini.native_config[0].override_relative_path,
        ".gemini/settings.json"
    );
    assert_eq!(
        gemini
            .account_evidence
            .as_ref()
            .unwrap()
            .override_relative_directory,
        ".gemini"
    );
    assert!(
        gemini
            .settings_features
            .contains(&AgentSettingsFeature::ReusableModelProviders)
    );

    let cline = profile("cline");
    assert!(
        cline
            .native_config
            .iter()
            .all(|binding| binding.directory_override_env == Some("CLINE_DIR"))
    );
    assert_eq!(
        cline
            .account_evidence
            .as_ref()
            .unwrap()
            .directory_override_env,
        Some("CLINE_DIR")
    );

    let codebuddy = profile("codebuddy");
    assert_eq!(
        codebuddy.native_config[0].directory_override_env,
        Some("CODEBUDDY_CONFIG_DIR")
    );
    assert!(
        profile("opencode")
            .settings_features
            .contains(&AgentSettingsFeature::OpenCodeProviders)
    );

    for id in [
        "claude_code",
        "codex",
        "gemini",
        "opencode",
        "cline",
        "hermes",
        "codebuddy",
        "kimi_code",
        "grok",
        "cursor",
    ] {
        assert!(
            profile(id)
                .settings_features
                .contains(&AgentSettingsFeature::NativeMcp),
            "{id} must declare native MCP support"
        );
    }
    for id in ["openclaw", "pi"] {
        assert!(
            !profile(id)
                .settings_features
                .contains(&AgentSettingsFeature::NativeMcp),
            "{id} must not be offered as a native MCP target"
        );
    }
    for id in [
        "claude_code",
        "codex",
        "gemini",
        "openclaw",
        "opencode",
        "cline",
        "hermes",
        "codebuddy",
        "kimi_code",
        "pi",
        "grok",
        "cursor",
    ] {
        assert!(
            profile(id)
                .settings_features
                .contains(&AgentSettingsFeature::NativeSkills),
            "{id} must declare native Skills support"
        );
    }
}
