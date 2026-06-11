#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
#[cfg(windows)]
use std::os::windows::process::ExitStatusExt;
use std::process::{ExitStatus, Output};

use db::models::execution_process::ExecutionProcessStatus;

use super::*;

#[cfg(unix)]
fn failed_exit_status() -> ExitStatus {
    ExitStatus::from_raw(1 << 8)
}

#[cfg(windows)]
fn failed_exit_status() -> ExitStatus {
    ExitStatus::from_raw(1)
}

fn command_output(stdout: &[u8], stderr: &[u8]) -> Output {
    Output {
        status: failed_exit_status(),
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
    }
}

#[test]
fn provider_sdk_metadata_failure_error_prefers_stderr() {
    let output = command_output(b"stdout detail\n", b" stderr detail \n");

    let error = provider_sdk_metadata_failure_error(ProviderId::Claude, &output);

    assert_eq!(
        error.to_string(),
        "Bad request: Claude Code native runtime failed: stderr detail"
    );
}

#[test]
fn provider_sdk_metadata_failure_error_uses_stdout_when_stderr_is_empty() {
    let output = command_output(b" stdout detail \n", b"\n");

    let error = provider_sdk_metadata_failure_error(ProviderId::Opencode, &output);

    assert_eq!(
        error.to_string(),
        "Bad request: OpenCode native runtime failed: stdout detail"
    );
}

#[test]
fn provider_sdk_metadata_failure_error_keeps_generic_fallback_without_output() {
    let output = command_output(b" \n", b"\t\n");

    let error = provider_sdk_metadata_failure_error(ProviderId::Claude, &output);

    assert_eq!(
        error.to_string(),
        "Bad request: Claude Code native runtime failed: SDK metadata discovery failed"
    );
}

#[test]
fn runtime_dependency_probe_distinguishes_missing_node_sdk_and_clis() {
    let (native, dependencies) = dependency_statuses_for_probe_output_for_test(
        ProviderId::Claude,
        "node",
        "claude-agent-sdk-provider:ok",
        Err("program not found: node".to_string()),
    );
    assert_eq!(native.state, CapabilityState::Unavailable);
    assert!(dependencies.iter().any(|dependency| {
        dependency.id == "node" && dependency.status.state == CapabilityState::Unavailable
    }));

    let (_, dependencies) = dependency_statuses_for_probe_output_for_test(
        ProviderId::Claude,
        "node",
        "claude-agent-sdk-provider:ok",
        Ok(command_output(
            b"",
            b"Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@anthropic-ai/claude-agent-sdk'",
        )),
    );
    assert!(dependencies.iter().any(|dependency| {
        dependency.id == "claude_agent_sdk"
            && dependency.status.state == CapabilityState::Unavailable
    }));

    let (_, dependencies) = dependency_statuses_for_probe_output_for_test(
        ProviderId::Codex,
        "codex",
        "Run the app server",
        Err("No such file or directory (os error 2)".to_string()),
    );
    assert!(dependencies.iter().any(|dependency| {
        dependency.id == "codex_cli" && dependency.status.state == CapabilityState::Unavailable
    }));

    let (_, dependencies) = dependency_statuses_for_probe_output_for_test(
        ProviderId::Opencode,
        "node",
        "opencode-sdk-provider:ok",
        Ok(command_output(
            b"",
            b"'opencode' is not recognized as an internal or external command",
        )),
    );
    assert!(dependencies.iter().any(|dependency| {
        dependency.id == "opencode_cli" && dependency.status.state == CapabilityState::Unavailable
    }));
}

#[test]
fn bridge_runner_completion_events_map_exit_statuses() {
    let success = bridge_completion_status_for_test("native_test", Ok(ExitStatus::from_raw(0)));
    assert_eq!(success.1, ExecutionProcessStatus::Completed);
    assert_eq!(
        success.0.get("method").and_then(Value::as_str),
        Some("turn/completed")
    );

    let failure = bridge_completion_status_for_test("native_test", Ok(failed_exit_status()));
    assert_eq!(failure.1, ExecutionProcessStatus::Failed);
    assert_eq!(
        failure.0.get("method").and_then(Value::as_str),
        Some("turn/error")
    );
}

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
            { "name": "compact", "description": "Compact the current session" },
            { "name": "review", "description": "Review changes", "source": "skill" },
            { "name": "mcp", "description": "Show MCP server status" },
            { "name": "plan", "description": "Switch to plan mode" },
            { "name": "status", "description": "Show status" },
            { "description": "missing name" }
        ],
        "providers": [
            { "id": "opencode", "name": "OpenCode Zen", "source": "api" },
            { "id": "deepseek", "name": "DeepSeek", "source": "api" },
            { "id": "modelverse", "name": "modelverse", "source": "config" }
        ],
        "models": [
            { "id": "opencode/gpt-5.5", "providerID": "opencode", "providerSource": "api", "label": "OpenCode / GPT-5.5" },
            { "id": "deepseek/deepseek-v4-pro", "providerID": "deepseek", "providerSource": "api", "name": "DeepSeek V4 Pro" },
            { "id": "modelverse/deepseek-v4-pro", "providerID": "modelverse", "providerSource": "config", "name": "DeepSeek V4 Pro" },
            { "label": "missing id" }
        ]
    });

    let commands = opencode_sdk_metadata_commands(&metadata);
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0].provider, ProviderId::Opencode);
    assert_eq!(commands[0].name, "compact");
    assert_eq!(commands[0].kind, SlashCommandKind::Command);
    assert_eq!(commands[0].source, CapabilitySource::Sdk);
    assert_eq!(commands[1].name, "review");
    assert_eq!(commands[1].kind, SlashCommandKind::Skill);

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
fn fallback_policy_is_manual_by_default_and_auto_only_when_explicit() {
    let mut request = turn_request(ProviderId::Codex);
    assert_eq!(
        provider_fallback_policy(&request),
        ProviderFallbackPolicy::Manual
    );

    request
        .provider_options
        .insert("allow_acp_fallback".to_string(), json!(true));
    assert_eq!(
        provider_fallback_policy(&request),
        ProviderFallbackPolicy::Auto
    );

    request
        .provider_options
        .insert("allow_acp_fallback".to_string(), json!(false));
    assert_eq!(
        provider_fallback_policy(&request),
        ProviderFallbackPolicy::Disabled
    );

    request.provider_options.remove("allow_acp_fallback");
    request
        .provider_options
        .insert("fallback_policy".to_string(), json!("auto"));
    assert_eq!(
        provider_fallback_policy(&request),
        ProviderFallbackPolicy::Auto
    );

    request
        .provider_options
        .insert("fallback_policy".to_string(), json!("manual"));
    assert_eq!(
        provider_fallback_policy(&request),
        ProviderFallbackPolicy::Manual
    );

    request
        .provider_options
        .insert("fallback_policy".to_string(), json!("disabled"));
    assert_eq!(
        provider_fallback_policy(&request),
        ProviderFallbackPolicy::Disabled
    );
}

#[test]
fn native_provider_error_event_documents_manual_fallback_policy() {
    let request = turn_request(ProviderId::Claude);
    let workspace_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let error = app_error_from_native(ProviderId::Claude, "node is missing");

    let event = native_provider_error_event(
        &request,
        workspace_id,
        session_id,
        &error,
        ProviderFallbackPolicy::Manual.as_str(),
    );

    assert_eq!(event.provider, ProviderId::Claude);
    assert_eq!(event.workspace_id, workspace_id.to_string());
    assert_eq!(
        event.event.get("type").and_then(Value::as_str),
        Some("native_runtime_error")
    );
    assert_eq!(
        event.event.get("method").and_then(Value::as_str),
        Some("turn/error")
    );
    assert_eq!(
        event.event.get("runtime_source").and_then(Value::as_str),
        Some("native")
    );
    assert_eq!(
        event.event.get("fallback_policy").and_then(Value::as_str),
        Some("manual")
    );
    assert!(
        event
            .event
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|message| message.contains("node is missing"))
    );
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
fn codex_input_items_include_official_skill_and_mention_hints() {
    let mut request = turn_request(ProviderId::Codex);
    request.provider_options.insert(
        "skills".to_string(),
        json!([
            {
                "name": "skill-creator",
                "path": "C:\\Users\\me\\.codex\\skills\\skill-creator\\SKILL.md"
            }
        ]),
    );
    request.provider_options.insert(
        "apps".to_string(),
        json!([
            {
                "name": "Demo App",
                "id": "demo-app"
            }
        ]),
    );

    let input = codex_input_items(&request);

    assert_eq!(input[1].get("type").and_then(Value::as_str), Some("skill"));
    assert_eq!(
        input[1].get("name").and_then(Value::as_str),
        Some("skill-creator")
    );
    assert_eq!(
        input[2].get("type").and_then(Value::as_str),
        Some("mention")
    );
    assert_eq!(
        input[2].get("path").and_then(Value::as_str),
        Some("app://demo-app")
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
fn native_provider_commit_reminder_prompt_is_appended_as_tail_instruction() {
    let prompt = native_commit_reminder_prompt_text(
        "Implement the feature",
        "Review git diff and commit if needed.",
    );

    assert!(prompt.starts_with("Implement the feature\n\n"));
    assert!(prompt.contains("<native-provider-commit-reminder-hook>"));
    assert!(prompt.contains("check the repository status before your final response"));
    assert!(prompt.contains("Review git diff and commit if needed."));
}

#[test]
fn native_provider_commit_reminder_requires_dirty_worktree() {
    assert!(!native_commit_reminder_status_has_changes(0, 0));
    assert!(native_commit_reminder_status_has_changes(1, 0));
    assert!(native_commit_reminder_status_has_changes(0, 1));
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
fn codex_runtime_options_prefer_profile_reasoning_override() {
    let mut request = turn_request(ProviderId::Codex);
    let mut profile =
        ExecutorProfileId::with_variant(BaseCodingAgent::Codex, "GPT_5_5".to_string());
    profile.reasoning_effort = Some("low".to_string());
    request.executor_profile_id = Some(profile);

    let options = resolve_codex_runtime_options(&request, Path::new("C:\\workspace"));

    assert_eq!(options.effort.as_deref(), Some("low"));
}

#[test]
fn codex_json_rpc_error_responses_are_failures() {
    let response = json!({
        "id": 1,
        "error": {
            "code": -32000,
            "message": "active turn already running"
        }
    });

    let error = codex_response_success("turn/start", &response).unwrap_err();

    assert!(error.contains("turn/start failed"));
    assert!(error.contains("active turn already running"));
}

#[test]
fn codex_model_list_response_is_parsed_from_app_server_shapes() {
    let response = json!({
        "id": 1,
        "result": {
            "data": [
                { "id": "gpt-5.5", "displayName": "GPT-5.5" },
                { "model": "gpt-5.4" },
                "gpt-5.5"
            ]
        }
    });

    let models = codex_models_from_response(&response);

    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "gpt-5.5");
    assert_eq!(models[0].label, "GPT-5.5");
    assert_eq!(models[1].id, "gpt-5.4");
}

#[test]
fn codex_capabilities_do_not_overstate_request_ui_support() {
    let capabilities = provider_capabilities(ProviderId::Codex);

    assert_eq!(capabilities.approvals.state, CapabilityState::Partial);
    assert_eq!(
        capabilities.user_input_requests.state,
        CapabilityState::Partial
    );
}

#[test]
fn codex_runtime_options_pass_base_instructions_to_turn_start() {
    let mut request = turn_request(ProviderId::Codex);
    request.provider_options.insert(
        "baseInstructions".to_string(),
        json!("Follow the repository instructions."),
    );
    request.provider_options.insert(
        "developer_instructions".to_string(),
        json!("Keep the patch focused."),
    );

    let options = resolve_codex_runtime_options(&request, Path::new("C:\\workspace"));

    assert_eq!(
        options.base_instructions.as_deref(),
        Some("Follow the repository instructions.\n\nKeep the patch focused.")
    );
}

#[test]
fn codex_steer_is_limited_to_normal_follow_up_text() {
    let mut request = turn_request(ProviderId::Codex);
    request.text = "continue with this extra constraint".to_string();
    request
        .provider_options
        .insert("turnId".to_string(), json!("turn-123"));

    assert!(codex_steer_is_allowed(&request));
    assert_eq!(codex_request_turn_id(&request).as_deref(), Some("turn-123"));

    request.text = "/compact".to_string();
    assert!(!codex_steer_is_allowed(&request));
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
