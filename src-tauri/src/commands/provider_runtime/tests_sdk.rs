#[test]
fn claude_sdk_bridge_args_use_node_bridge_without_stream_json() {
    let input_path = PathBuf::from("C:\\tmp\\claude-sdk-input.json");
    let args = build_claude_sdk_bridge_args(&input_path);

    assert_eq!(args.len(), 2);
    assert!(args[0].ends_with("scripts\\claude-agent-sdk-provider.mjs"));
    assert_eq!(args[1], "C:\\tmp\\claude-sdk-input.json");
    assert!(!args.iter().any(|arg| arg.contains("stream-json")));

    let metadata_args = build_claude_sdk_metadata_args(&input_path);
    assert_eq!(metadata_args[1], "--metadata");
    assert_eq!(metadata_args[2], "C:\\tmp\\claude-sdk-input.json");
}

#[test]
fn claude_sdk_bridge_input_maps_options_and_images() {
    let temp_dir = std::env::temp_dir().join(format!("vibex-claude-image-{}", Uuid::new_v4()));
    let image_dir = temp_dir.join(".vibe-images");
    std::fs::create_dir_all(&image_dir).unwrap();
    std::fs::write(image_dir.join("shot.png"), [0x89, b'P', b'N', b'G']).unwrap();

    let mut request = turn_request(ProviderId::Claude);
    request.text = "describe image".to_string();
    request.model = Some("claude-sonnet-4-5-20250929".to_string());
    request.thread_id = Some("claude-session-id".to_string());
    request.session_id = Some(Uuid::new_v4().to_string());
    request.images = vec![".vibe-images/shot.png".to_string()];
    request
        .provider_options
        .insert("effort".to_string(), json!("high"));
    request
        .provider_options
        .insert("permission_mode".to_string(), json!("plan"));
    request.provider_options.insert(
        "env".to_string(),
        json!({
            "ANTHROPIC_BASE_URL": "https://example.test",
        }),
    );
    request
        .provider_options
        .insert("fork".to_string(), json!(true));

    let value = build_claude_sdk_bridge_input(&request, &temp_dir).unwrap();

    assert_eq!(
        value.get("text").and_then(Value::as_str),
        Some("describe image")
    );
    assert_eq!(
        value.get("threadId").and_then(Value::as_str),
        Some("claude-session-id")
    );
    assert_eq!(
        value.get("model").and_then(Value::as_str),
        Some("claude-sonnet-4-5-20250929")
    );
    assert_eq!(value.get("effort").and_then(Value::as_str), Some("high"));
    assert_eq!(
        value.get("permissionMode").and_then(Value::as_str),
        Some("plan")
    );
    assert_eq!(
        value
            .get("env")
            .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
            .and_then(Value::as_str),
        Some("https://example.test")
    );
    assert_eq!(
        value.get("forkSession").and_then(Value::as_bool),
        Some(true)
    );
    let images = value.get("images").and_then(Value::as_array).unwrap();
    assert_eq!(images.len(), 1);
    assert_eq!(
        images[0].get("mediaType").and_then(Value::as_str),
        Some("image/png")
    );
    assert!(
        images[0]
            .get("base64")
            .and_then(Value::as_str)
            .is_some_and(|data| !data.is_empty())
    );
    assert!(!value.to_string().contains("stream-json"));

    let _ = std::fs::remove_dir_all(temp_dir);
}

#[test]
fn claude_native_model_aliases_resolve_from_local_env() {
    let mut env = HashMap::new();
    env.insert(
        CLAUDE_PRIMARY_MODEL_ENV.to_string(),
        "deepseek-v4-pro".to_string(),
    );
    env.insert(
        CLAUDE_DEFAULT_HAIKU_ENV.to_string(),
        "deepseek-v4-flash".to_string(),
    );

    assert_eq!(
        resolve_claude_model_from_env("sonnet", &env).as_deref(),
        Some("deepseek-v4-pro")
    );
    assert_eq!(
        resolve_claude_model_from_env("haiku", &env).as_deref(),
        Some("deepseek-v4-flash")
    );
    assert_eq!(
        resolve_claude_model_from_env("claude-custom", &env).as_deref(),
        Some("claude-custom")
    );
}

#[test]
fn claude_sdk_metadata_maps_command_and_model_catalogs() {
    let metadata = json!({
        "commands": [
            { "name": "review", "description": "Review changes" },
            { "name": "mcp", "description": "Manage MCP servers" },
            { "name": "permissions", "description": "Manage permissions" },
            { "description": "missing name" }
        ],
        "models": [
            { "value": "sonnet[1m]", "displayName": "Sonnet (1M context)" },
            { "value": "deepseek-v4-pro", "description": "Custom model" },
            { "displayName": "missing value" }
        ]
    });

    let commands = claude_sdk_metadata_commands(&metadata);
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0].provider, ProviderId::Claude);
    assert_eq!(commands[0].name, "review");
    assert_eq!(commands[0].source, CapabilitySource::Sdk);

    let models = claude_sdk_metadata_models(&metadata);
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "sonnet[1m]");
    assert_eq!(models[0].label, "Sonnet (1M context)");
    assert_eq!(models[0].source, CapabilitySource::Sdk);
    assert_eq!(models[1].id, "deepseek-v4-pro");
    assert_eq!(models[1].label, "Custom model");
}

#[test]
fn opencode_sdk_bridge_input_maps_profile_session_and_file_inputs() {
    let input_path = PathBuf::from("C:\\tmp\\opencode-sdk-input.json");
    let args = build_opencode_sdk_bridge_args(&input_path);

    assert_eq!(args.len(), 2);
    assert!(args[0].ends_with("scripts\\opencode-sdk-provider.mjs"));
    assert_eq!(args[1], "C:\\tmp\\opencode-sdk-input.json");
    assert!(!args.iter().any(|arg| arg.contains("--format")));

    let metadata_args = build_opencode_sdk_metadata_args(&input_path);
    assert_eq!(metadata_args[1], "--metadata");
    assert_eq!(metadata_args[2], "C:\\tmp\\opencode-sdk-input.json");

    let mut request = turn_request(ProviderId::Opencode);
    let workspace_dir = PathBuf::from("C:\\workspace");
    request.model = Some("openai/gpt-5.4".to_string());
    request.thread_id = Some("opencode-session-id".to_string());
    request.session_id = Some(Uuid::new_v4().to_string());
    request.images = vec![".vibe-images\\shot.png".to_string()];
    request
        .provider_options
        .insert("agent".to_string(), json!("build"));
    request
        .provider_options
        .insert("variant".to_string(), json!("high"));
    request
        .provider_options
        .insert("fork".to_string(), json!(true));
    request
        .provider_options
        .insert("auto_approve".to_string(), json!(true));
    request
        .provider_options
        .insert("auto_compact".to_string(), json!(false));
    request.provider_options.insert(
        "env".to_string(),
        json!({
            "OPENCODE_CONFIG_CONTENT": "{\"theme\":\"dark\"}",
        }),
    );

    let value = build_opencode_sdk_bridge_input(&request, &workspace_dir).unwrap();

    assert_eq!(
        value.get("model").and_then(Value::as_str),
        Some("openai/gpt-5.4")
    );
    assert_eq!(
        value.get("threadId").and_then(Value::as_str),
        Some("opencode-session-id")
    );
    assert_eq!(value.get("agent").and_then(Value::as_str), Some("build"));
    assert_eq!(value.get("variant").and_then(Value::as_str), Some("high"));
    assert_eq!(
        value.get("forkSession").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        value.get("autoApprove").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        value.get("autoCompact").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        value
            .get("env")
            .and_then(|env| env.get("OPENCODE_CONFIG_CONTENT"))
            .and_then(Value::as_str),
        Some("{\"theme\":\"dark\"}")
    );
    let images = value.get("images").and_then(Value::as_array).unwrap();
    assert_eq!(images.len(), 1);
    assert_eq!(
        images[0].get("mime").and_then(Value::as_str),
        Some("image/png")
    );
    assert!(
        images[0]
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(|path| path.ends_with(".vibe-images\\shot.png"))
    );
    assert!(!value.to_string().contains("--format"));
}

#[test]
fn opencode_sdk_metadata_maps_command_and_model_catalogs() {
    let metadata = json!({
        "commands": [
            { "name": "review", "description": "Review changes" },
            { "name": "mcp", "description": "Show MCP server status" },
            { "description": "missing name" }
        ],
        "models": [
            { "id": "opencode/gpt-5.5", "label": "OpenCode / GPT-5.5" },
            { "id": "modelverse/deepseek-v4-pro", "name": "DeepSeek V4 Pro" },
            { "label": "missing id" }
        ]
    });

    let commands = opencode_sdk_metadata_commands(&metadata);
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0].provider, ProviderId::Opencode);
    assert_eq!(commands[0].name, "review");
    assert_eq!(commands[0].source, CapabilitySource::Sdk);

    let models = opencode_sdk_metadata_models(&metadata);
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "opencode/gpt-5.5");
    assert_eq!(models[0].label, "OpenCode / GPT-5.5");
    assert_eq!(models[0].source, CapabilitySource::Sdk);
    assert_eq!(models[1].id, "modelverse/deepseek-v4-pro");
    assert_eq!(models[1].label, "DeepSeek V4 Pro");
}

#[test]
fn force_acp_fallback_is_provider_scoped_option() {
    let mut request = turn_request(ProviderId::Codex);
    assert!(!should_force_acp_fallback(&request));
    request
        .provider_options
        .insert("force_acp_fallback".to_string(), json!(true));
    assert!(should_force_acp_fallback(&request));
}

#[test]
fn rejects_cross_provider_profile_ids() {
    let mut request = turn_request(ProviderId::Claude);
    request.executor_profile_id = Some(ExecutorProfileId::new(BaseCodingAgent::Codex));

    assert!(validate_provider_executor_profile(&request).is_err());
}

#[test]
fn codex_runtime_options_use_profile_model_and_full_access() {
    let mut request = turn_request(ProviderId::Codex);
    request.executor_profile_id = Some(ExecutorProfileId::with_variant(
        BaseCodingAgent::Codex,
        "GPT_5_5".to_string(),
    ));

    let options = resolve_codex_runtime_options(&request, Path::new("C:\\workspace"));

    assert_eq!(options.model.as_deref(), Some("gpt-5.5"));
    assert_eq!(options.approval_policy, "never");
    assert_eq!(options.sandbox_mode, "danger-full-access");
    assert_eq!(
        options.sandbox_policy.get("type").and_then(Value::as_str),
        Some("dangerFullAccess")
    );
}

#[test]
fn codex_input_items_include_empty_text_elements_for_unicode_prompt() {
    let mut request = turn_request(ProviderId::Codex);
    request.text = "你是谁".to_string();

    let input = codex_input_items(&request);

    assert_eq!(input.len(), 1);
    assert_eq!(input[0].get("type").and_then(Value::as_str), Some("text"));
    assert_eq!(
        input[0].get("text").and_then(Value::as_str),
        Some(request.text.as_str())
    );
    assert!(
        input[0]
            .get("text_elements")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
    );
}

#[test]
fn codex_app_server_args_preserve_user_hooks_for_embedded_runtime() {
    let mut request = turn_request(ProviderId::Codex);
    request
        .provider_options
        .insert("listen".to_string(), json!("stdio://"));

    let args = codex_app_server_command_args(&request);

    assert_eq!(args[0], "app-server");
    assert!(!args.iter().any(|arg| arg == "features.hooks=false"));
    assert!(!args.iter().any(|arg| arg == "features.codex_hooks=false"));
    assert!(
        args.windows(2)
            .any(|window| window[0] == "--listen" && window[1] == "stdio://")
    );
}

#[test]
fn codex_runtime_options_keep_thread_start_sandbox_mode_protocol_shape() {
    let mut request = turn_request(ProviderId::Codex);
    request
        .provider_options
        .insert("sandbox".to_string(), json!("workspace-write"));
    request.provider_options.insert(
        "sandbox_policy".to_string(),
        json!({
            "type": "workspaceWrite",
            "writableRoots": ["C:\\workspace"],
            "networkAccess": true,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false,
        }),
    );

    let options = resolve_codex_runtime_options(&request, Path::new("C:\\workspace"));

    assert_eq!(options.sandbox_mode, "workspace-write");
    assert_eq!(
        options.sandbox_policy.get("type").and_then(Value::as_str),
        Some("workspaceWrite")
    );
}

#[test]
fn codex_runtime_options_prefer_profile_model_override() {
    let mut request = turn_request(ProviderId::Codex);
    let mut profile =
        ExecutorProfileId::with_variant(BaseCodingAgent::Codex, "GPT_5_5".to_string());
    profile.model = Some("gpt-5.4".to_string());
    request.executor_profile_id = Some(profile);

    let options = resolve_codex_runtime_options(&request, Path::new("C:\\workspace"));

    assert_eq!(options.model.as_deref(), Some("gpt-5.4"));
}

#[test]
fn parses_acp_fallback_env_values() {
    for value in ["1", "true", "TRUE", "yes", "on", "enabled"] {
        assert_eq!(parse_acp_fallback_enabled_value(value), Some(true));
    }
    for value in ["0", "false", "FALSE", "no", "off", "disabled"] {
        assert_eq!(parse_acp_fallback_enabled_value(value), Some(false));
    }
    assert_eq!(parse_acp_fallback_enabled_value("unexpected"), None);
}
