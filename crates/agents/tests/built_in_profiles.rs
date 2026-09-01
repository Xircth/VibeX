use agents::{
    AgentId, BuiltInProfileCatalog, NativeConfigFieldKind, NativeConfigSurface, ProfileComponent,
    ProfileInstallSource, ProfileManagementActionKind, RegistryEntryIdentity,
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
fn hermes_profile_uses_the_official_desktop_brand_icon() {
    let catalog = BuiltInProfileCatalog::bundled();
    let hermes = catalog
        .profile(&AgentId::parse("hermes").unwrap())
        .expect("bundled Hermes profile");

    assert_eq!(hermes.icon.light, "/agents/hermes.png");
    assert_eq!(hermes.icon.dark, "/agents/hermes.png");
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
            "0.69.0",
            "claude-agent-acp",
            ">=22",
        ),
        (
            "codex",
            ProfileComponent::AcpAdapter,
            "@agentclientprotocol/codex-acp",
            "1.7.0",
            "codex-acp",
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
        (
            "deepseek_harness",
            ProfileComponent::CombinedRuntime,
            "deepseek-acp",
            "0.3.0",
            "deepseek-acp",
            ">=22",
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
            version: "1.18.23",
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
    let antigravity = profile("antigravity").install_sources.first().unwrap();
    assert!(matches!(
        antigravity,
        ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: "1.0.0",
            command: "agy_acp_server",
            ..
        }
    ));
    let ProfileInstallSource::Binary {
        artifacts,
        entry,
        args,
        ..
    } = antigravity
    else {
        panic!("antigravity must be a binary");
    };
    assert_eq!(artifacts.len(), 5);
    assert!(
        !artifacts
            .iter()
            .any(|artifact| artifact.platform == "darwin-x86_64")
    );
    let entry = entry
        .as_ref()
        .expect("antigravity keeps the extracted tree");
    assert_eq!(entry.unix, "agy_acp_server.par");
    assert!(
        profile("antigravity")
            .external_candidates
            .iter()
            .any(|candidate| candidate.executable == "agy_acp_server.par")
    );
    assert_eq!(entry.windows, "agy_acp_server.exe");
    assert_eq!(entry.unix_siblings, &["localharness_external"]);
    if cfg!(target_os = "linux") {
        assert_eq!(*args, ["--uid="]);
    } else {
        assert!(args.is_empty());
    }
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
            "antigravity",
            "openclaw",
            "opencode",
            "cline",
            "hermes",
            "codebuddy",
            "kimi_code",
            "pi",
            "grok",
            "cursor",
            "deepseek_harness",
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
            ("antigravity", None),
            ("openclaw", None),
            ("opencode", None),
            ("cline", None),
            ("hermes", None),
            ("codebuddy", None),
            ("kimi_code", None),
            ("pi", None),
            ("grok", None),
            ("cursor", None),
            ("deepseek_harness", None),
        ]
    );
}

#[test]
fn codeg_account_action_matrix_is_complete() {
    let catalog = BuiltInProfileCatalog::bundled();
    for (agent_id, expected) in [
        ("claude_code", &["login", "logout", "subscription"][..]),
        ("codex", &["login", "logout", "subscription"][..]),
        ("antigravity", &[][..]),
        ("openclaw", &["onboard"][..]),
        ("opencode", &["login", "logout"][..]),
        ("cline", &["login"][..]),
        ("hermes", &["setup", "model"][..]),
        ("codebuddy", &["login"][..]),
        ("kimi_code", &["login", "logout"][..]),
        ("pi", &["login"][..]),
        ("grok", &["login", "logout", "subscription"][..]),
        ("cursor", &["login", "logout", "subscription"][..]),
        ("deepseek_harness", &["setup"][..]),
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
                if let Some(digest) = artifact.sha256 {
                    assert_eq!(digest.len(), 64);
                    assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
                }
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
                "haiku_model",
                "sonnet_model",
                "opus_model",
                "claude_send_attribution_header",
                "claude_disable_nonessential_traffic",
            ][..],
        ),
        (
            "codex",
            &[
                "codex_approval_policy",
                "codex_responses_websockets",
                "codex_network_access",
                "codex_exclude_tmpdir",
                "codex_exclude_slash_tmp",
            ][..],
        ),
        (
            "antigravity",
            &[
                "antigravity_tool_permission",
                "antigravity_agent_mode",
                "antigravity_terminal_sandbox",
                "antigravity_telemetry",
                "antigravity_permissions",
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
        ("deepseek_harness", &["deepseek_harness_api_key"][..]),
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
        native_field(&catalog, "claude_code", "haiku_model").path,
        ["env", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]
    );
    assert_eq!(
        native_field(&catalog, "grok", "grok_permission").path,
        ["ui", "permission_mode"]
    );
    assert_eq!(
        native_field(&catalog, "cursor", "cursor_sandbox_mode").path,
        ["sandbox", "mode"]
    );
    assert_eq!(
        native_field(&catalog, "deepseek_harness", "deepseek_harness_api_key").path,
        ["DEEPSEEK_API_KEY"]
    );
}

#[test]
fn codeg_directory_semantics_and_settings_capabilities_are_profile_declared() {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = |id: &str| catalog.profile(&AgentId::parse(id).unwrap()).unwrap();

    let antigravity = profile("antigravity");
    assert_eq!(
        antigravity.native_config[0].directory_override_env,
        Some("GEMINI_HOME")
    );
    assert_eq!(
        antigravity.native_config[0].override_relative_path,
        "antigravity-acp/settings.json"
    );
    assert_eq!(
        antigravity.native_config[1].override_relative_path,
        "antigravity-cli/settings.json"
    );
    assert_eq!(
        antigravity
            .account_evidence
            .as_ref()
            .unwrap()
            .override_relative_directory,
        "antigravity-acp"
    );
    assert!(
        antigravity
            .settings_features
            .contains(&AgentSettingsFeature::AuthenticationMode)
    );
    assert!(
        antigravity
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
        profile("cursor").account_evidence.is_none(),
        "Cursor account login is stored in the platform secret store, not a config file"
    );
    assert!(
        profile("opencode")
            .settings_features
            .contains(&AgentSettingsFeature::OpenCodeProviders)
    );
    assert!(
        profile("deepseek_harness")
            .settings_features
            .contains(&AgentSettingsFeature::AuthenticationMode)
    );
    assert!(
        profile("deepseek_harness")
            .settings_features
            .contains(&AgentSettingsFeature::DshPlugins)
    );
    assert!(
        profile("grok")
            .settings_features
            .contains(&AgentSettingsFeature::GrokPlugins)
    );

    for id in [
        "claude_code",
        "codex",
        "antigravity",
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
    for id in ["openclaw", "pi", "deepseek_harness"] {
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
        "antigravity",
        "openclaw",
        "opencode",
        "cline",
        "hermes",
        "codebuddy",
        "kimi_code",
        "pi",
        "grok",
        "cursor",
        "deepseek_harness",
    ] {
        assert!(
            profile(id)
                .settings_features
                .contains(&AgentSettingsFeature::NativeSkills),
            "{id} must declare native Skills support"
        );
    }
}

#[test]
fn native_config_surfaces_keep_runtime_fields_out_of_authentication() {
    let catalog = BuiltInProfileCatalog::bundled();
    let surface =
        |agent_id: &str, field_id: &str| native_field(&catalog, agent_id, field_id).surface;

    assert_eq!(
        surface("claude_code", "anthropic_base_url"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("claude_code", "anthropic_api_key"),
        NativeConfigSurface::Authentication
    );
    for field_id in ["haiku_model", "sonnet_model", "opus_model"] {
        assert_eq!(
            surface("claude_code", field_id),
            NativeConfigSurface::Authentication,
            "{field_id} belongs on the official API authentication surface"
        );
    }
    for field_id in [
        "effort_level",
        "permission_mode",
        "include_co_authored_by",
        "claude_send_attribution_header",
        "claude_disable_nonessential_traffic",
        "auto_updates_channel",
    ] {
        assert_eq!(
            surface("claude_code", field_id),
            NativeConfigSurface::Configuration,
            "{field_id} must stay in configuration management"
        );
    }

    assert_eq!(
        surface("codex", "openai_api_key"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("codex", "codex_openai_base_url"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("codex", "codex_model_provider"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("codex", "codex_reasoning_effort"),
        NativeConfigSurface::Configuration
    );
    assert_eq!(
        surface("codex", "codex_approval_policy"),
        NativeConfigSurface::Configuration
    );
    assert_eq!(
        surface("codex", "codex_responses_websockets"),
        NativeConfigSurface::Configuration
    );

    assert_eq!(
        surface("antigravity", "antigravity_api_key"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("antigravity", "antigravity_auth"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("antigravity", "antigravity_cloud_project"),
        NativeConfigSurface::Authentication
    );
    for field_id in [
        "antigravity_tool_permission",
        "antigravity_agent_mode",
        "antigravity_terminal_sandbox",
        "antigravity_telemetry",
        "antigravity_permissions",
    ] {
        assert_eq!(
            surface("antigravity", field_id),
            NativeConfigSurface::Configuration,
            "{field_id} must stay in configuration management"
        );
    }

    assert_eq!(
        surface("grok", "grok_base_url"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("grok", "grok_api_key"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("grok", "grok_effort"),
        NativeConfigSurface::Configuration
    );
    assert_eq!(
        surface("opencode", "opencode_anthropic_api_key"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("opencode", "opencode_share"),
        NativeConfigSurface::Configuration
    );
    assert_eq!(
        surface("grok", "grok_permission"),
        NativeConfigSurface::Configuration
    );
    assert_eq!(
        surface("cursor", "cursor_model"),
        NativeConfigSurface::Configuration
    );
    assert_eq!(
        surface("cursor", "cursor_force"),
        NativeConfigSurface::Configuration
    );
}

#[test]
fn official_account_evidence_requires_a_live_token_not_residue() {
    let catalog = BuiltInProfileCatalog::bundled();
    let evidence = |id: &str| {
        catalog
            .profile(&AgentId::parse(id).unwrap())
            .unwrap()
            .account_evidence
            .as_ref()
            .unwrap()
    };

    let claude = evidence("claude_code");
    assert!(claude.matches(&serde_json::json!({
        "claudeAiOauth": { "accessToken": "tok" }
    })));
    assert!(!claude.matches(&serde_json::json!({
        "claudeAiOauth": {}
    })));
    assert!(!claude.matches(&serde_json::json!({})));

    let codex = evidence("codex");
    assert!(codex.matches(&serde_json::json!({
        "tokens": { "access_token": "tok" }
    })));
    assert!(!codex.matches(&serde_json::json!({
        "tokens": { "refresh_token": "stale" }
    })));
    assert!(!codex.matches(&serde_json::json!({ "tokens": {} })));
}
