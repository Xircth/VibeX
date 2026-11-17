use agents::{AgentId, BuiltInProfileCatalog, NativeConfigFieldKind, NativeConfigSurface};
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
        native_field(&catalog, "grok", "grok_permission")
            .options
            .iter()
            .map(|(value, _)| *value)
            .collect::<Vec<_>>(),
        ["ask", "auto", "always-approve"]
    );
    assert_eq!(
        native_field(&catalog, "cursor", "cursor_sandbox_mode").path,
        ["sandbox", "mode"]
    );
    assert_eq!(
        native_field(&catalog, "deepseek_harness", "deepseek_harness_api_key").path,
        ["refs", "DEEPSEEK_API_KEY"]
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
    assert!(!codebuddy.authentication_required_by_default);
    assert!(codebuddy.account_evidence.is_none());
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
        profile("omp")
            .settings_features
            .contains(&AgentSettingsFeature::AuthenticationMode)
    );
    assert!(
        profile("omp")
            .settings_features
            .contains(&AgentSettingsFeature::ReusableModelProviders)
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
    assert!(
        profile("pi")
            .settings_features
            .contains(&AgentSettingsFeature::PiPlugins)
    );
    assert!(
        profile("pi")
            .settings_features
            .contains(&AgentSettingsFeature::ReusableModelProviders)
    );
    for id in [
        "claude_code",
        "codex",
        "antigravity",
        "gemini",
        "kimi_code",
        "pi",
        "grok",
        "hermes",
        "openclaw",
        "cline",
        "codebuddy",
        "qoder",
        "auggie",
        "trae",
        "command_code",
        "zcode",
        "omp",
    ] {
        assert!(
            catalog.supports_reusable_model_providers(&AgentId::parse(id).unwrap()),
            "{id} exposes reusable Model Providers and must be able to probe them"
        );
    }
    for id in ["cursor", "opencode", "deepseek_harness", "kiro"] {
        assert!(
            !catalog.supports_reusable_model_providers(&AgentId::parse(id).unwrap()),
            "{id} does not expose reusable Model Providers"
        );
    }

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
        "deepseek_harness",
        "qoder",
        "kiro",
        "auggie",
        "trae",
        "command_code",
        "zcode",
        "omp",
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
        "qoder",
        "kiro",
        "auggie",
        "trae",
        "command_code",
        "zcode",
        "omp",
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
fn codex_native_reasoning_effort_includes_max_and_ultra() {
    let catalog = BuiltInProfileCatalog::bundled();
    let values: Vec<_> = native_field(&catalog, "codex", "codex_reasoning_effort")
        .options
        .iter()
        .map(|(value, _)| *value)
        .collect();

    assert_eq!(
        values,
        ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
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

#[test]
fn omp_native_config_exposes_approval_mode_select_field() {
    let catalog = BuiltInProfileCatalog::bundled();
    let field = native_field(&catalog, "omp", "omp_approval_mode");
    assert_eq!(field.label, "工具审批模式");
    assert_eq!(field.path, &["tools", "approvalMode"]);
    assert_eq!(field.kind, NativeConfigFieldKind::Select);
    assert_eq!(field.surface, NativeConfigSurface::Configuration);
    let values: Vec<_> = field.options.iter().map(|(value, _)| *value).collect();
    assert_eq!(values, ["always-ask", "always-ask-cached", "write", "yolo"]);
}
