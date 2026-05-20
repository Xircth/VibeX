#[test]
fn provider_command_catalogs_are_isolated() {
    let claude = provider_slash_commands(ProviderId::Claude);
    let codex = provider_slash_commands(ProviderId::Codex);
    let opencode = provider_slash_commands(ProviderId::Opencode);

    assert!(!claude.iter().any(|command| command.name == "permissions"));
    assert!(!claude.iter().any(|command| command.name == "mcp"));
    assert!(!claude.iter().any(|command| command.name == "config"));
    assert!(!claude.iter().any(|command| command.name == "model"));
    assert!(codex.iter().any(|command| command.name == "goal"));
    assert!(opencode.iter().any(|command| command.name == "agents"));
    assert!(!claude.iter().any(|command| command.name == "goal"));
    assert!(!codex.iter().any(|command| command.name == "mcp"));
    assert!(!codex.iter().any(|command| command.name == "model"));
    assert!(!codex.iter().any(|command| command.name == "permissions"));
    assert!(!opencode.iter().any(|command| command.name == "config"));
    assert!(!opencode.iter().any(|command| command.name == "mcp"));
    assert!(!opencode.iter().any(|command| command.name == "model"));
}

#[test]
fn provider_capabilities_keep_provider_specific_sources() {
    let claude = provider_capabilities(ProviderId::Claude);
    let codex = provider_capabilities(ProviderId::Codex);
    let opencode = provider_capabilities(ProviderId::Opencode);

    assert_eq!(claude.images.state, CapabilityState::Available);
    assert_eq!(claude.images.source, CapabilitySource::Sdk);
    assert_eq!(codex.collaboration_mode.state, CapabilityState::Available);
    assert_eq!(codex.collaboration_mode.source, CapabilitySource::AppServer);
    assert_eq!(opencode.mcp.state, CapabilityState::Available);
    assert_eq!(opencode.mcp.source, CapabilitySource::Sdk);
}

#[test]
fn provider_runtime_contract_documents_primary_and_fallback_paths() {
    let claude = provider_runtime_contract(ProviderId::Claude);
    let codex = provider_runtime_contract(ProviderId::Codex);
    let opencode = provider_runtime_contract(ProviderId::Opencode);

    assert_eq!(claude.primary_runtime, ProviderRuntimeKind::ClaudeAgentSdk);
    assert_eq!(claude.primary_source, CapabilitySource::Sdk);
    assert_eq!(claude.fallback_env, CLAUDE_ACP_FALLBACK_ENV);
    assert!(claude.fallback_enabled_by_default);
    assert!(claude.dependencies.iter().any(|dependency| {
        dependency.id == "claude_agent_sdk" && dependency.required && !dependency.user_visible
    }));
    assert!(claude.dependencies.iter().any(|dependency| {
        dependency.id == "claude_acp" && dependency.source == CapabilitySource::AcpFallback
    }));

    assert_eq!(codex.primary_runtime, ProviderRuntimeKind::CodexAppServer);
    assert_eq!(codex.primary_source, CapabilitySource::AppServer);
    assert_eq!(codex.fallback_env, CODEX_ACP_FALLBACK_ENV);
    assert!(codex.dependencies.iter().any(|dependency| {
        dependency.id == "codex_cli" && dependency.required && dependency.user_visible
    }));

    assert_eq!(opencode.primary_runtime, ProviderRuntimeKind::OpencodeSdk);
    assert_eq!(opencode.primary_source, CapabilitySource::Sdk);
    assert_eq!(opencode.fallback_env, OPENCODE_ACP_FALLBACK_ENV);
    assert!(opencode.dependencies.iter().any(|dependency| {
        dependency.id == "opencode_sdk" && dependency.required && !dependency.user_visible
    }));
    assert!(opencode.dependencies.iter().any(|dependency| {
        dependency.id == "opencode_cli" && dependency.required && dependency.user_visible
    }));

    for contract in [claude, codex, opencode] {
        assert_eq!(contract.global_fallback_env, ACP_FALLBACK_ENV);
        assert_eq!(contract.force_fallback_option, "force_acp_fallback");
        assert!(contract.command_visibility_policy.contains("visible VibeX"));
        assert!(contract.event_history_policy.contains("acp_fallback"));
    }
}

#[test]
fn session_provider_matching_rejects_cross_provider_history() {
    assert!(session_executor_matches_provider(
        Some("CODEX"),
        ProviderId::Codex
    ));
    assert!(session_executor_matches_provider(None, ProviderId::Claude));
    assert!(!session_executor_matches_provider(
        Some("CLAUDE_CODE"),
        ProviderId::Codex
    ));
    assert!(!session_executor_matches_provider(
        Some("OPENCODE"),
        ProviderId::Claude
    ));
}

#[test]
fn native_provider_events_extract_display_text_without_user_echoes() {
    let claude_event = json!({
        "type": "sdk_event",
        "text": "assistant reply",
        "event": {
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "assistant reply" }]
            }
        }
    });
    let user_event = json!({
        "type": "sdk_event",
        "text": "user prompt",
        "event": {
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "user prompt" }]
            }
        }
    });
    let opencode_event = json!({
        "type": "opencode_sdk_event",
        "event": {
            "message": {
                "role": "assistant",
                "parts": [{ "type": "text", "text": "opencode reply" }]
            }
        }
    });
    let stderr_event = json!({
        "type": "stderr",
        "message": "provider failed"
    });
    let tool_output_event = json!({
        "type": "sdk_event",
        "text": "Set-PSReadLineOption : The predictive suggestion feature cannot be enabled",
        "event": {
            "type": "tool_result",
            "content": [{
                "type": "text",
                "text": "Set-PSReadLineOption : The predictive suggestion feature cannot be enabled"
            }]
        }
    });
    let codex_tool_output_event = json!({
        "method": "item/command/output",
        "params": {
            "output": "npm warn Unknown env config"
        }
    });

    assert_eq!(
        extract_provider_text(&claude_event),
        Some("assistant reply".to_string())
    );
    assert!(provider_event_is_user_echo(&user_event));
    assert_eq!(
        extract_provider_text(&opencode_event),
        Some("opencode reply".to_string())
    );
    assert_eq!(
        extract_provider_error(&stderr_event),
        Some("provider failed".to_string())
    );
    assert_eq!(extract_provider_text(&tool_output_event), None);
    assert_eq!(extract_provider_text(&codex_tool_output_event), None);
}

#[test]
fn native_provider_events_extract_tool_updates_as_structured_entries() {
    let claude_tool_use = json!({
        "type": "sdk_event",
        "event": {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Bash",
                    "input": { "command": "pnpm test" }
                }]
            }
        }
    });
    let claude_tool_result = json!({
        "type": "sdk_event",
        "event": {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "ok"
                }]
            }
        }
    });
    let codex_command_output = json!({
        "method": "item/command/output",
        "params": {
            "itemId": "cmd-1",
            "command": "pnpm run check",
            "output": "done"
        }
    });
    let codex_command_started = json!({
        "method": "item/started",
        "params": {
            "threadId": "thread-1",
            "turnId": "turn-1",
            "item": {
                "type": "commandExecution",
                "id": "cmd-2",
                "command": "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command Get-Location",
                "cwd": "C:\\Users\\Administrator\\Documents\\Projects\\self\\VibeX",
                "status": "inProgress",
                "aggregatedOutput": null
            }
        }
    });
    let codex_command_delta = json!({
        "method": "item/commandExecution/outputDelta",
        "params": {
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "cmd-2",
            "delta": "C:\\Users\\Administrator\\Documents\\Projects\\self\\VibeX"
        }
    });
    let codex_command_completed = json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread-1",
            "turnId": "turn-1",
            "item": {
                "type": "commandExecution",
                "id": "cmd-2",
                "command": "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command Get-Location",
                "status": "completed",
                "aggregatedOutput": "C:\\Users\\Administrator\\Documents\\Projects\\self\\VibeX"
            }
        }
    });
    let opencode_file_edit = json!({
        "type": "opencode_sdk_event",
        "event": {
            "type": "part.updated",
            "properties": {
                "part": {
                    "type": "tool",
                    "id": "part-1",
                    "tool": "write_file",
                    "state": {
                        "status": "completed",
                        "input": {
                            "path": "src/app.ts",
                            "content": "export {};"
                        }
                    }
                }
            }
        }
    });

    let claude_calls = extract_provider_tool_updates(&claude_tool_use);
    assert_eq!(claude_calls.len(), 1);
    assert_eq!(claude_calls[0].id, "toolu_1");
    assert_eq!(claude_calls[0].tool_name.as_deref(), Some("Bash"));
    match claude_calls[0].action_type.as_ref().unwrap() {
        ActionType::CommandRun { command, .. } => assert_eq!(command, "pnpm test"),
        other => panic!("expected command_run, got {other:?}"),
    }

    let claude_results = extract_provider_tool_updates(&claude_tool_result);
    assert_eq!(claude_results.len(), 1);
    assert_eq!(claude_results[0].id, "toolu_1");
    assert!(matches!(claude_results[0].status, ToolStatus::Success));
    assert_eq!(claude_results[0].command_output.as_deref(), Some("ok"));

    let codex_updates = extract_provider_tool_updates(&codex_command_output);
    assert_eq!(codex_updates.len(), 1);
    match codex_updates[0].action_type.as_ref().unwrap() {
        ActionType::CommandRun {
            command, result, ..
        } => {
            assert_eq!(command, "pnpm run check");
            assert_eq!(
                result.as_ref().and_then(|r| r.output.as_deref()),
                Some("done")
            );
        }
        other => panic!("expected command_run, got {other:?}"),
    }

    let codex_started_updates = extract_provider_tool_updates(&codex_command_started);
    assert_eq!(codex_started_updates.len(), 1);
    assert_eq!(codex_started_updates[0].id, "cmd-2");
    assert!(matches!(
        codex_started_updates[0].status,
        ToolStatus::Created
    ));
    match codex_started_updates[0].action_type.as_ref().unwrap() {
        ActionType::CommandRun { command, .. } => {
            assert!(command.contains("Get-Location"));
        }
        other => panic!("expected command_run, got {other:?}"),
    }

    let codex_delta_updates = extract_provider_tool_updates(&codex_command_delta);
    assert_eq!(codex_delta_updates.len(), 1);
    assert_eq!(codex_delta_updates[0].id, "cmd-2");
    assert_eq!(
        codex_delta_updates[0].command_output.as_deref(),
        Some("C:\\Users\\Administrator\\Documents\\Projects\\self\\VibeX")
    );

    let codex_completed_updates = extract_provider_tool_updates(&codex_command_completed);
    assert_eq!(codex_completed_updates.len(), 1);
    assert!(matches!(
        codex_completed_updates[0].status,
        ToolStatus::Success
    ));
    assert_eq!(
        codex_completed_updates[0].command_output.as_deref(),
        Some("C:\\Users\\Administrator\\Documents\\Projects\\self\\VibeX")
    );

    let opencode_updates = extract_provider_tool_updates(&opencode_file_edit);
    assert_eq!(opencode_updates.len(), 1);
    match opencode_updates[0].action_type.as_ref().unwrap() {
        ActionType::FileEdit { path, changes } => {
            assert_eq!(path, "src/app.ts");
            assert_eq!(changes.len(), 1);
        }
        other => panic!("expected file_edit, got {other:?}"),
    }
}

#[test]
fn codex_app_server_events_extract_current_protocol_ids_and_text() {
    let turn_start_response = json!({
        "id": 12,
        "result": {
            "turn": {
                "id": "turn-123",
                "status": "running",
                "items": []
            }
        }
    });
    let turn_completed_notification = json!({
        "method": "turn/completed",
        "params": {
            "threadId": "thread-123",
            "turn": {
                "id": "turn-123",
                "status": "completed",
                "items": [
                    {
                        "id": "item-123",
                        "type": "agentMessage",
                        "text": "done"
                    }
                ]
            }
        }
    });
    let completed_turn_start_response = json!({
        "id": 13,
        "result": {
            "turn": {
                "id": "turn-456",
                "status": "completed",
                "items": [
                    {
                        "type": "agentMessage",
                        "content": [{ "type": "text", "text": "final" }]
                    }
                ]
            }
        }
    });
    let agent_delta_notification = json!({
        "method": "item/agentMessage/delta",
        "params": {
            "threadId": "thread-123",
            "turnId": "turn-123",
            "itemId": "item-123",
            "delta": "hello"
        }
    });

    assert_eq!(
        extract_turn_id(&turn_start_response),
        Some("turn-123".to_string())
    );
    assert_eq!(
        extract_turn_id(&turn_completed_notification),
        Some("turn-123".to_string())
    );
    assert_eq!(
        extract_thread_id(&turn_completed_notification),
        Some("thread-123".to_string())
    );
    assert_eq!(
        extract_provider_text(&turn_completed_notification),
        Some("done".to_string())
    );
    assert_eq!(
        extract_provider_text(&completed_turn_start_response),
        Some("final".to_string())
    );
    assert_eq!(
        codex_turn_status(&completed_turn_start_response),
        Some("completed")
    );
    assert!(codex_turn_status_is_terminal("completed"));
    assert_eq!(
        extract_provider_text(&agent_delta_notification),
        Some("hello".to_string())
    );
    assert_eq!(
        extract_provider_stream_text(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "delta": " **GPT"
            }
        })),
        Some(" **GPT".to_string())
    );
    assert_eq!(
        extract_provider_stream_text(&json!({
            "type": "text_delta",
            "text": " 5.5"
        })),
        Some(" 5.5".to_string())
    );
}

#[test]
fn native_provider_requests_reuse_persisted_threads_when_frontend_omits_thread_id() {
    let mut request = turn_request(ProviderId::Codex);
    request.thread_id = None;

    let resolved =
        provider_request_with_resolved_thread_id(request, Some("persisted-thread".to_string()));
    assert_eq!(resolved.thread_id.as_deref(), Some("persisted-thread"));

    let mut explicit = turn_request(ProviderId::Codex);
    explicit.thread_id = Some("explicit-thread".to_string());
    let explicit =
        provider_request_with_resolved_thread_id(explicit, Some("persisted-thread".to_string()));
    assert_eq!(explicit.thread_id.as_deref(), Some("explicit-thread"));
}

#[test]
fn sdk_bridge_inputs_receive_resolved_thread_ids() {
    let mut claude_request = turn_request(ProviderId::Claude);
    claude_request = provider_request_with_resolved_thread_id(
        claude_request,
        Some("claude-persisted-thread".to_string()),
    );
    let claude_input =
        build_claude_sdk_bridge_input(&claude_request, &PathBuf::from("C:\\workspace")).unwrap();
    assert_eq!(
        claude_input.get("threadId").and_then(Value::as_str),
        Some("claude-persisted-thread")
    );

    let mut opencode_request = turn_request(ProviderId::Opencode);
    opencode_request = provider_request_with_resolved_thread_id(
        opencode_request,
        Some("opencode-persisted-thread".to_string()),
    );
    let opencode_input =
        build_opencode_sdk_bridge_input(&opencode_request, &PathBuf::from("C:\\workspace"))
            .unwrap();
    assert_eq!(
        opencode_input.get("threadId").and_then(Value::as_str),
        Some("opencode-persisted-thread")
    );
}

#[test]
fn native_provider_events_extract_token_usage_info() {
    let codex_event = json!({
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": "thread-123",
            "turnId": "turn-123",
            "tokenUsage": {
                "total": {
                    "totalTokens": 1200,
                    "inputTokens": 900,
                    "cachedInputTokens": 100,
                    "outputTokens": 200,
                    "reasoningOutputTokens": 0
                },
                "last": {
                    "totalTokens": 300,
                    "inputTokens": 200,
                    "cachedInputTokens": 50,
                    "outputTokens": 50,
                    "reasoningOutputTokens": 0
                },
                "modelContextWindow": 128000
            }
        }
    });
    let claude_event = json!({
        "type": "sdk_event",
        "event": {
            "type": "result",
            "subtype": "success",
            "usage": {
                "input_tokens": 1000,
                "output_tokens": 200,
                "cache_creation_input_tokens": 50,
                "cache_read_input_tokens": 25
            },
            "modelUsage": {
                "claude-sonnet": {
                    "contextWindow": 200000
                }
            }
        }
    });
    let opencode_event = json!({
        "type": "opencode_sdk_response",
        "response": {
            "type": "assistant",
            "tokens": {
                "input": 700,
                "output": 100,
                "reasoning": 25,
                "cache": {
                    "read": 10,
                    "write": 5
                }
            },
            "modelContextWindow": 128000
        }
    });
    let claude_context_usage_event = json!({
        "type": "sdk_context_usage",
        "session_id": "claude-session-id",
        "contextUsage": {
            "totalTokens": 4321,
            "maxTokens": 200000,
            "rawMaxTokens": 200000,
            "percentage": 2.1605,
            "model": "claude-sonnet"
        }
    });
    let compacted_event = json!({
        "method": "thread/compacted",
        "params": {
            "threadId": "thread-123",
            "turnId": "turn-compact"
        }
    });

    assert_eq!(
        extract_provider_token_usage_info(&codex_event)
            .map(|info| { (info.total_tokens, info.model_context_window) }),
        Some((1200, 128000))
    );
    assert_eq!(
        extract_provider_token_usage_info_with_codex_context_window(&codex_event, Some(1_000_000))
            .map(|info| { (info.total_tokens, info.model_context_window) }),
        Some((1200, 1_000_000))
    );
    assert_eq!(
        extract_provider_token_usage_info(&claude_event)
            .map(|info| { (info.total_tokens, info.model_context_window) }),
        Some((1275, 200000))
    );
    assert_eq!(
        extract_provider_token_usage_info(&opencode_event)
            .map(|info| { (info.total_tokens, info.model_context_window) }),
        Some((840, 128000))
    );
    assert_eq!(
        extract_provider_token_usage_info(&claude_context_usage_event)
            .map(|info| { (info.total_tokens, info.model_context_window) }),
        Some((4321, 200000))
    );
    assert_eq!(
        extract_provider_token_usage_info_with_codex_context_window(
            &compacted_event,
            Some(1_000_000)
        )
        .map(|info| { (info.total_tokens, info.model_context_window) }),
        Some((0, 1_000_000))
    );
}

#[test]
fn codex_context_compact_prompt_detection_accepts_command_only() {
    assert!(is_context_compact_prompt("/compact"));
    assert!(is_context_compact_prompt(
        "  /compact keep repository state  "
    ));
    assert!(is_context_compact_prompt("/compact\tkeep repository state"));
    assert!(is_context_compact_prompt("/COMPACT"));
    assert!(!is_context_compact_prompt("/compactness"));
    assert!(!is_context_compact_prompt("/src/main.rs"));
    assert!(!is_context_compact_prompt("你是谁"));
    assert!(!is_context_compact_prompt(
        "分析当前项目并提出改进建议，包括代码质量、架构设计、性能优化、可维护性等方面。"
    ));
}

#[test]
fn native_provider_stream_deltas_preserve_markdown_boundaries() {
    let mut content = String::new();
    append_provider_assistant_text(&mut content, "我是基于 **GPT", true);
    append_provider_assistant_text(&mut content, "-5** 的 Codex", true);
    append_provider_assistant_text(&mut content, " 编码代理。", true);

    assert_eq!(content, "我是基于 **GPT-5** 的 Codex 编码代理。");

    append_provider_assistant_text(&mut content, "完整块消息", false);
    assert_eq!(
        content,
        "我是基于 **GPT-5** 的 Codex 编码代理。\n完整块消息"
    );
}

#[test]
fn native_provider_completion_text_does_not_duplicate_streamed_content() {
    let mut content = String::new();
    append_provider_assistant_text(&mut content, "我是 Codex，", true);
    append_provider_assistant_text(&mut content, "你的编程助手。", true);
    append_provider_assistant_text(&mut content, "我是 Codex，你的编程助手。", false);

    assert_eq!(content, "我是 Codex，你的编程助手。");

    append_provider_assistant_text(
        &mut content,
        "我是 Codex，你的编程助手。\n我可以直接在这个项目里读代码、改代码、跑命令、查问题并完成开发任务。",
        false,
    );

    assert_eq!(
        content,
        "我是 Codex，你的编程助手。\n我可以直接在这个项目里读代码、改代码、跑命令、查问题并完成开发任务。"
    );
}

