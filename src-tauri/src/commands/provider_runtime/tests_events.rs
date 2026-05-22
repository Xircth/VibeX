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
    assert!(opencode.iter().any(|command| command.name == "compact"));
    assert!(!opencode.iter().any(|command| command.name == "agents"));
    assert!(!opencode.iter().any(|command| command.name == "build"));
    assert!(!opencode.iter().any(|command| command.name == "plan"));
    assert!(!opencode.iter().any(|command| command.name == "status"));
    assert!(claude.iter().any(|command| command.name == "goal"));
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
fn codex_turn_start_active_turn_errors_are_retryable() {
    assert!(codex_turn_start_error_is_active_turn(
        "thread has an active turn"
    ));
    assert!(codex_turn_start_error_is_active_turn(
        "turn already running for this thread"
    ));
    assert!(codex_turn_start_error_is_active_turn(
        "conversation is currently running"
    ));
    assert!(!codex_turn_start_error_is_active_turn(
        "thread not found"
    ));
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
    let claude_result_event = json!({
        "type": "sdk_event",
        "text": "final Claude reply",
        "event": {
            "type": "result",
            "subtype": "success",
            "result": "final Claude reply"
        }
    });
    let claude_stream_delta = json!({
        "type": "sdk_event",
        "text": "live Claude chunk",
        "event": {
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": {
                    "type": "text_delta",
                    "text": "live Claude chunk"
                }
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
    let opencode_part_delta = json!({
        "type": "opencode_sdk_event",
        "event": {
            "type": "message.part.updated",
            "properties": {
                "delta": "streamed ",
                "part": {
                    "id": "part-1",
                    "messageID": "message-1",
                    "type": "text",
                    "text": "streamed text"
                }
            }
        }
    });
    let opencode_next_delta = json!({
        "type": "opencode_sdk_event",
        "event": {
            "type": "session.next.text.delta",
            "properties": {
                "sessionID": "session-1",
                "delta": "next stream"
            }
        }
    });
    let opencode_reasoning_delta = json!({
        "type": "opencode_sdk_event",
        "event": {
            "type": "message.part.delta",
            "properties": {
                "sessionID": "session-1",
                "messageID": "assistant-message-1",
                "partID": "reasoning-part-1",
                "partType": "reasoning",
                "field": "text",
                "delta": "The user is asking who I am."
            }
        }
    });
    let opencode_user_part = json!({
        "type": "opencode_sdk_event",
        "event": {
            "type": "message.part.updated",
            "properties": {
                "sessionID": "session-1",
                "part": {
                    "id": "user-part-1",
                    "messageID": "user-message-1",
                    "type": "text",
                    "text": "user prompt"
                }
            }
        }
    });
    let opencode_response = json!({
        "type": "opencode_sdk_response",
        "sessionID": "session-1",
        "response": {
            "info": {
                "role": "assistant"
            },
            "parts": [
                { "type": "step-start" },
                { "type": "text", "text": "final OpenCode reply" },
                { "type": "step-finish" }
            ]
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
    assert_eq!(
        extract_provider_text(&claude_result_event),
        Some("final Claude reply".to_string())
    );
    assert_eq!(
        extract_provider_stream_text(&claude_stream_delta),
        Some("live Claude chunk".to_string())
    );
    assert_eq!(
        extract_provider_text(&claude_stream_delta),
        Some("live Claude chunk".to_string())
    );
    assert!(provider_event_is_user_echo(&user_event));
    assert_eq!(
        extract_provider_text(&opencode_event),
        Some("opencode reply".to_string())
    );
    assert_eq!(
        extract_provider_stream_text(&opencode_part_delta),
        None
    );
    assert_eq!(extract_provider_text(&opencode_part_delta), None);
    assert_eq!(extract_provider_stream_text(&opencode_next_delta), None);
    assert_eq!(extract_provider_stream_text(&opencode_reasoning_delta), None);
    assert_eq!(extract_provider_text(&opencode_reasoning_delta), None);
    assert_eq!(extract_provider_text(&opencode_user_part), None);
    assert_eq!(
        extract_provider_text(&opencode_response),
        Some("final OpenCode reply".to_string())
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
    let codex_exec_stream_delta = json!({
        "method": "command/exec/outputDelta",
        "params": {
            "processId": "proc-1",
            "stream": "stdout",
            "deltaBase64": "bGluZSAxCg==",
            "capReached": false
        }
    });
    let codex_process_stream_delta = json!({
        "method": "process/outputDelta",
        "params": {
            "processHandle": "spawn-1",
            "stream": "stderr",
            "deltaBase64": "ZXJyCg==",
            "capReached": false
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
    let opencode_file_edited = json!({
        "type": "opencode_sdk_event",
        "event": {
            "type": "file.edited",
            "properties": {
                "file": "src/file-edited.ts"
            }
        }
    });
    let opencode_session_diff = json!({
        "type": "opencode_sdk_event",
        "event": {
            "type": "session.diff",
            "properties": {
                "sessionID": "session-1",
                "diff": [{
                    "file": "src/session-diff.ts",
                    "patch": "@@\n-old\n+new",
                    "additions": 1,
                    "deletions": 1,
                    "status": "modified"
                }]
            }
        }
    });
    let opencode_next_tool_called = json!({
        "type": "opencode_sdk_event",
        "event": {
            "type": "session.next.tool.called",
            "properties": {
                "sessionID": "session-1",
                "callID": "call-1",
                "tool": "bash",
                "input": {
                    "command": "pnpm test"
                },
                "provider": {
                    "executed": true
                }
            }
        }
    });
    let opencode_next_tool_success = json!({
        "type": "opencode_sdk_event",
        "event": {
            "type": "session.next.tool.success",
            "properties": {
                "sessionID": "session-1",
                "callID": "call-1",
                "tool": "bash",
                "input": {
                    "command": "pnpm test"
                },
                "content": [{
                    "type": "text",
                    "text": "ok"
                }],
                "provider": {
                    "executed": true
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

    let codex_exec_stream_updates = extract_provider_tool_updates(&codex_exec_stream_delta);
    assert_eq!(codex_exec_stream_updates.len(), 1);
    assert_eq!(codex_exec_stream_updates[0].id, "proc-1");
    assert_eq!(
        codex_exec_stream_updates[0].command_output.as_deref(),
        Some("line 1\n")
    );

    let codex_process_stream_updates = extract_provider_tool_updates(&codex_process_stream_delta);
    assert_eq!(codex_process_stream_updates.len(), 1);
    assert_eq!(codex_process_stream_updates[0].id, "spawn-1");
    assert_eq!(
        codex_process_stream_updates[0].command_output.as_deref(),
        Some("err\n")
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

    let opencode_file_edited_updates = extract_provider_tool_updates(&opencode_file_edited);
    assert_eq!(opencode_file_edited_updates.len(), 1);
    assert!(matches!(
        opencode_file_edited_updates[0].action_type,
        Some(ActionType::FileEdit { ref path, .. }) if path == "src/file-edited.ts"
    ));

    let opencode_diff_updates = extract_provider_tool_updates(&opencode_session_diff);
    assert_eq!(opencode_diff_updates.len(), 1);
    assert!(matches!(
        opencode_diff_updates[0].action_type,
        Some(ActionType::FileEdit { ref path, ref changes })
            if path == "src/session-diff.ts"
                && matches!(
                    changes.as_slice(),
                    [FileChange::Edit { unified_diff, has_line_numbers: true }]
                        if unified_diff.contains("+new")
                )
    ));

    let opencode_next_tool_calls = extract_provider_tool_updates(&opencode_next_tool_called);
    assert_eq!(opencode_next_tool_calls.len(), 1);
    assert_eq!(opencode_next_tool_calls[0].id, "call-1");
    match opencode_next_tool_calls[0].action_type.as_ref().unwrap() {
        ActionType::CommandRun { command, .. } => assert_eq!(command, "pnpm test"),
        other => panic!("expected command_run, got {other:?}"),
    }

    let opencode_next_tool_results = extract_provider_tool_updates(&opencode_next_tool_success);
    assert_eq!(opencode_next_tool_results.len(), 1);
    assert_eq!(
        opencode_next_tool_results[0].command_output.as_deref(),
        Some("ok")
    );
}

#[test]
fn native_provider_events_extract_agent_creation_tools_for_all_providers() {
    let claude_task = json!({
        "type": "sdk_event",
        "event": {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_task",
                    "name": "Task",
                    "input": {
                        "description": "Inspect Kanban button behavior",
                        "prompt": "Check the archive/delete buttons",
                        "subagent_type": "explorer"
                    }
                }]
            }
        }
    });
    let codex_spawn_agent = json!({
        "method": "item/started",
        "params": {
            "item": {
                "type": "toolCall",
                "id": "call_spawn",
                "name": "spawn_agent",
                "input": {
                    "message": "Implement the theme updates",
                    "agent_type": "executor"
                },
                "status": "inProgress"
            }
        }
    });
    let opencode_delegate = json!({
        "type": "opencode_sdk_event",
        "event": {
            "type": "session.next.tool.called",
            "properties": {
                "id": "call_delegate",
                "tool": "delegate",
                "input": {
                    "task": "Verify the final UI",
                    "role": "verifier"
                }
            }
        }
    });

    for (event, expected_id, expected_description, expected_agent) in [
        (&claude_task, "toolu_task", "Inspect Kanban button behavior", "explorer"),
        (&codex_spawn_agent, "call_spawn", "Implement the theme updates", "executor"),
        (&opencode_delegate, "call_delegate", "Verify the final UI", "verifier"),
    ] {
        let updates = extract_provider_tool_updates(event);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].id, expected_id);
        match updates[0].action_type.as_ref().unwrap() {
            ActionType::TaskCreate {
                description,
                subagent_type,
                ..
            } => {
                assert_eq!(description, expected_description);
                assert_eq!(subagent_type.as_deref(), Some(expected_agent));
            }
            other => panic!("expected task_create, got {other:?}"),
        }
    }
}

#[test]
fn native_provider_events_extract_codex_collab_agent_tools() {
    let collab_spawn = json!({
        "method": "item/started",
        "params": {
            "item": {
                "id": "spawn-1",
                "type": "collabToolCall",
                "title": "Collab: spawn_agent",
                "detail": "From thread-root -> agent-7",
                "status": "running",
                "output": "Audit current panel",
                "receiverThreadIds": ["agent-7"]
            }
        }
    });
    let collab_wait = json!({
        "method": "item/completed",
        "params": {
            "item": {
                "id": "wait-1",
                "type": "collabToolCall",
                "title": "Collab: wait_agent",
                "detail": "From thread-root -> agent-7",
                "status": "completed",
                "output": "Audit current panel\n\nagent-7: completed",
                "receiverThreadIds": ["agent-7"],
                "agentStatus": {
                    "agent-7": { "status": "completed" }
                }
            }
        }
    });

    let spawn_updates = extract_provider_tool_updates(&collab_spawn);
    assert_eq!(spawn_updates.len(), 1);
    assert_eq!(spawn_updates[0].id, "spawn-1");
    assert_eq!(spawn_updates[0].tool_name.as_deref(), Some("spawn_agent"));
    assert!(matches!(spawn_updates[0].status, ToolStatus::Created));
    match spawn_updates[0].action_type.as_ref().unwrap() {
        ActionType::TaskCreate {
            description,
            ..
        } => {
            assert_eq!(description, "Audit current panel");
            assert!(spawn_updates[0].result.is_some());
        }
        other => panic!("expected task_create, got {other:?}"),
    }

    let wait_updates = extract_provider_tool_updates(&collab_wait);
    assert_eq!(wait_updates.len(), 1);
    assert_eq!(wait_updates[0].id, "wait-1");
    assert_eq!(wait_updates[0].tool_name.as_deref(), Some("wait_agent"));
    assert!(matches!(wait_updates[0].status, ToolStatus::Success));
    match wait_updates[0].action_type.as_ref().unwrap() {
        ActionType::Tool {
            tool_name, ..
        } => {
            assert_eq!(tool_name, "wait_agent");
            assert!(wait_updates[0].result.is_some());
        }
        other => panic!("expected tool, got {other:?}"),
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
    let nested_turn_thread_notification = json!({
        "method": "turn/completed",
        "params": {
            "turn": {
                "id": "turn-789",
                "threadId": "thread-789",
                "status": "completed",
                "items": []
            }
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
        extract_thread_id(&nested_turn_thread_notification),
        Some("thread-789".to_string())
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
fn codex_context_compaction_item_completion_is_terminal() {
    let started = json!({
        "method": "item/started",
        "params": {
            "threadId": "thread-123",
            "turnId": "turn-compact",
            "item": {
                "id": "compact-1",
                "type": "contextCompaction",
                "status": "running"
            }
        }
    });
    let completed = json!({
        "method": "item/completed",
        "params": {
            "threadId": "thread-123",
            "turnId": "turn-compact",
            "item": {
                "id": "compact-1",
                "type": "contextCompaction",
                "status": "completed"
            }
        }
    });

    assert!(!is_codex_context_compaction_completed(&started));
    assert!(is_codex_context_compaction_completed(&completed));
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
    let compacted_event_with_usage = json!({
        "method": "thread/compacted",
        "params": {
            "threadId": "thread-123",
            "turnId": "turn-compact",
            "tokenUsage": {
                "total": {
                    "totalTokens": 600,
                    "inputTokens": 550,
                    "cachedInputTokens": 50,
                    "outputTokens": 0,
                    "reasoningOutputTokens": 0
                },
                "last": {
                    "totalTokens": 275,
                    "inputTokens": 250,
                    "cachedInputTokens": 25,
                    "outputTokens": 0,
                    "reasoningOutputTokens": 0
                },
                "modelContextWindow": null
            }
        }
    });
    let codex_event_without_context_window = json!({
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
                "modelContextWindow": null
            }
        }
    });
    let codex_event_without_last_usage = json!({
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
                "modelContextWindow": 128000
            }
        }
    });
    let codex_compaction_usage_with_zero_last = json!({
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": "thread-123",
            "turnId": "turn-compact",
            "tokenUsage": {
                "total": {
                    "totalTokens": 12200,
                    "inputTokens": 9000,
                    "cachedInputTokens": 3000,
                    "outputTokens": 200,
                    "reasoningOutputTokens": 0
                },
                "last": {
                    "totalTokens": 0,
                    "inputTokens": 0,
                    "cachedInputTokens": 0,
                    "outputTokens": 0,
                    "reasoningOutputTokens": 0
                },
                "modelContextWindow": 128000
            }
        }
    });
    let compacted_event_with_zero_last_usage = json!({
        "method": "thread/compacted",
        "params": {
            "threadId": "thread-123",
            "turnId": "turn-compact",
            "tokenUsage": {
                "total": {
                    "totalTokens": 12200,
                    "inputTokens": 9000,
                    "cachedInputTokens": 3000,
                    "outputTokens": 200,
                    "reasoningOutputTokens": 0
                },
                "last": {
                    "totalTokens": 0,
                    "inputTokens": 0,
                    "cachedInputTokens": 0,
                    "outputTokens": 0,
                    "reasoningOutputTokens": 0
                },
                "modelContextWindow": null
            }
        }
    });

    assert_eq!(
        extract_provider_token_usage_info(&codex_event)
            .map(|info| { (info.total_tokens, info.model_context_window) }),
        Some((250, 128000))
    );
    assert_eq!(
        extract_provider_token_usage_info_with_codex_context_window(&codex_event, Some(1_000_000))
            .map(|info| { (info.total_tokens, info.model_context_window) }),
        Some((250, 128000))
    );
    assert_eq!(
        extract_provider_token_usage_info_with_codex_context_window(
            &codex_event_without_context_window,
            Some(1_000_000)
        )
        .map(|info| { (info.total_tokens, info.model_context_window) }),
        Some((250, 1_000_000))
    );
    assert_eq!(
        extract_provider_token_usage_info(&codex_event_without_last_usage)
            .map(|info| { (info.total_tokens, info.model_context_window) }),
        Some((1000, 128000))
    );
    assert_eq!(
        extract_provider_token_usage_info(&codex_compaction_usage_with_zero_last)
            .map(|info| { (info.total_tokens, info.model_context_window) }),
        None
    );
    assert_eq!(
        extract_provider_token_usage_info(&claude_event)
            .map(|info| { (info.total_tokens, info.model_context_window) }),
        Some((1075, 200000))
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
        None
    );
    assert_eq!(
        extract_provider_token_usage_info_with_codex_context_window(
            &compacted_event_with_usage,
            Some(1_000_000)
        )
        .map(|info| { (info.total_tokens, info.model_context_window) }),
        None
    );
    assert_eq!(
        extract_provider_token_usage_info_with_codex_context_window(
            &compacted_event_with_zero_last_usage,
            Some(1_000_000)
        )
        .map(|info| { (info.total_tokens, info.model_context_window) }),
        None
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
fn native_provider_events_extract_codex_file_change_updates() {
    let patch_event = json!({
        "method": "item/fileChange/patchUpdated",
        "params": {
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "patch-1",
            "changes": [
                {
                    "path": "src/App.tsx",
                    "kind": { "type": "update", "move_path": null },
                    "diff": "@@\n-old\n+new"
                },
                {
                    "path": "src/old.ts",
                    "kind": { "type": "delete" },
                    "diff": "--- a/src/old.ts\n+++ /dev/null"
                }
            ]
        }
    });

    let updates = extract_provider_tool_updates(&patch_event);

    assert_eq!(updates.len(), 2);
    assert_eq!(updates[0].tool_name.as_deref(), Some("file_change"));
    assert!(matches!(
        updates[0].action_type,
        Some(ActionType::FileEdit { ref path, ref changes })
            if path == "src/App.tsx"
                && matches!(
                    changes.as_slice(),
                    [FileChange::Edit { unified_diff, has_line_numbers: true }]
                        if unified_diff == "@@\n-old\n+new"
                )
    ));
    assert!(matches!(
        updates[1].action_type,
        Some(ActionType::FileEdit { ref path, ref changes })
            if path == "src/old.ts" && matches!(changes.as_slice(), [FileChange::Delete])
    ));
}

#[test]
fn native_provider_events_extract_codex_file_change_snapshot_items() {
    let snapshot_item = json!({
        "type": "fileChange",
        "id": "patch-2",
        "status": "completed",
        "changes": [
            {
                "path": "src/new.ts",
                "kind": { "type": "add" },
                "diff": "--- /dev/null\n+++ b/src/new.ts\n+export {};"
            }
        ]
    });

    let updates = extract_provider_tool_updates(&snapshot_item);

    assert_eq!(updates.len(), 1);
    assert!(matches!(updates[0].status, ToolStatus::Success));
    assert!(matches!(
        updates[0].action_type,
        Some(ActionType::FileEdit { ref path, ref changes })
            if path == "src/new.ts"
                && matches!(
                    changes.as_slice(),
                    [FileChange::Edit { unified_diff, has_line_numbers: true }]
                        if unified_diff.contains("export {};")
                )
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

#[test]
fn native_provider_assistant_segments_restart_after_tool_updates() {
    let mut state = NativeConversationState::default();
    let first_delta = json!({
        "method": "item/agentMessage/delta",
        "params": {
            "itemId": "msg-1",
            "delta": "先检查项目。"
        }
    });
    let second_delta = json!({
        "method": "item/agentMessage/delta",
        "params": {
            "itemId": "msg-2",
            "delta": "检查完成。"
        }
    });

    let (first_index, first_is_new, first_content) =
        upsert_native_assistant_entry(&mut state, &first_delta, "先检查项目。", true);
    assert_eq!(first_index, 0);
    assert!(first_is_new);
    assert_eq!(first_content, "先检查项目。");

    close_native_assistant_segment(&mut state);
    let tool_index = state.next_entry_index;
    state.next_entry_index += 1;
    assert_eq!(tool_index, 1);

    let (second_index, second_is_new, second_content) =
        upsert_native_assistant_entry(&mut state, &second_delta, "检查完成。", true);
    assert_eq!(second_index, 2);
    assert!(second_is_new);
    assert_eq!(second_content, "检查完成。");

    assert_eq!(
        state
            .assistant_entries
            .get("assistant:msg-1")
            .map(|entry| entry.content.as_str()),
        Some("先检查项目。")
    );
}

#[test]
fn native_provider_turn_snapshot_does_not_recombine_streamed_segments() {
    let mut state = NativeConversationState::default();
    let first_delta = json!({
        "method": "item/agentMessage/delta",
        "params": {
            "itemId": "msg-1",
            "delta": "先检查项目。"
        }
    });
    let turn_completed = json!({
        "method": "turn/completed",
        "params": {
            "turn": {
                "id": "turn-1",
                "status": "completed",
                "items": [
                    {
                        "id": "msg-1",
                        "type": "agentMessage",
                        "text": "先检查项目。"
                    },
                    {
                        "id": "cmd-1",
                        "type": "commandExecution",
                        "command": "pnpm test",
                        "status": "completed"
                    },
                    {
                        "id": "msg-2",
                        "type": "agentMessage",
                        "text": "检查完成。"
                    }
                ]
            }
        }
    });

    upsert_native_assistant_entry(&mut state, &first_delta, "先检查项目。", true);

    assert!(should_skip_provider_text_snapshot(
        &state,
        &turn_completed,
        false
    ));
}
