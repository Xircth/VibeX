use super::*;

#[test]
fn session_new_after_load_maps_fs_permission_denied_to_busy() {
    let error = acp::Error::new(-32603, "Permission denied.").data(serde_json::json!({
        "detail": "拒绝访问。 (os error 5)",
        "code": "FS_PERMISSION_DENIED"
    }));
    assert!(matches!(
        map_acp_session_error("ACP session/new after load failed", error),
        AgentError::SessionLoadFailed(SessionLoadFailureReason::SessionBusy)
    ));
    let superseded = acp::Error::new(-32602, r#"session load was superseded"#);
    assert!(matches!(
        map_acp_session_error("ACP session/new after load failed", superseded),
        AgentError::SessionLoadFailed(SessionLoadFailureReason::SessionBusy)
    ));
}

#[test]
fn acp_error_codes_map_to_stable_strings() {
    assert_eq!(
        acp_error_code_str(&acp::Error::auth_required()).as_deref(),
        Some("auth_required")
    );
    assert_eq!(
        acp_error_code_str(&acp::Error::resource_not_found(None)).as_deref(),
        Some("resource_not_found")
    );
    assert_eq!(
        acp_error_code_str(&acp::Error::method_not_found()).as_deref(),
        Some("method_not_found")
    );
}

#[test]
fn steering_wire_outcomes_map_without_silent_fallback() {
    assert_eq!(
        map_steer_response(AcpSteerResponse {
            outcome: "injected".to_string(),
            reason: None,
        })
        .expect("injected receipt")
        .outcome,
        AgentSteerOutcome::Injected
    );
    assert_eq!(
        map_steer_response(AcpSteerResponse {
            outcome: "promptRequired".to_string(),
            reason: Some("noRunningTurn".to_string()),
        })
        .expect("idle receipt")
        .outcome,
        AgentSteerOutcome::PromptRequired
    );
    assert!(
        map_steer_response(AcpSteerResponse {
            outcome: "futureOutcome".to_string(),
            reason: None,
        })
        .is_err()
    );
}

#[test]
fn kiro_models_and_reasoning_synthesize_session_controls() {
    let raw_reply = serde_json::json!({
        "sessionId": "kiro-sess-1",
        "modes": {
            "currentModeId": "kiro_default",
            "availableModes": [
                { "id": "kiro_default", "name": "Default", "description": "Standard Kiro agent" },
                { "id": "kiro_planner", "name": "Planner", "description": "Plan before coding" }
            ]
        },
        "models": {
            "currentModelId": "claude-sonnet-4.5",
            "availableModels": [
                { "modelId": "auto", "name": "Auto", "description": "Automatic model selection" },
                { "modelId": "claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "description": "Balanced" }
            ]
        }
    });
    let (response, raw_models) = deserialize_raw_session_response::<NewSessionResponse>(raw_reply)
        .expect("deserialize raw session/new reply");
    let (modes, config_options, vendor_config) = session_controls_with_models_and_vendor_fallback(
        response.modes,
        response.config_options,
        response.meta.as_ref(),
        raw_models.as_ref(),
        "kiro",
    );
    assert_eq!(vendor_config, Some(VendorConfigWire::KiroSessionConfig));
    let (mut unified, mode_uses_set_mode) = unify_session_config_options(
        modes,
        config_options.unwrap_or_default(),
        vendor_config.is_some(),
    );
    assert!(mode_uses_set_mode);
    assert_eq!(unified.len(), 2);
    assert_eq!(unified[0].id.0.as_ref(), "mode");
    assert_eq!(unified[1].id.0.as_ref(), "model");

    let reasoning = parse_kiro_reasoning(&serde_json::json!({
        "support": "toggleable",
        "thinkingEnabled": true,
        "effortLevels": ["low", "medium", "high", "max"],
        "effort": "high"
    }));
    place_kiro_reasoning_selectors(&mut unified, &reasoning);
    let mapped = agent_session_config_options_from_acp(unified);
    let keys: Vec<&str> = mapped.iter().map(|opt| opt.key.as_str()).collect();
    assert_eq!(keys, ["mode", "model", "thinking", "effort"]);
    assert_eq!(
        mapped[1].value,
        Some(serde_json::json!("claude-sonnet-4.5"))
    );
    assert_eq!(mapped[2].value, Some(serde_json::json!("on")));
    assert_eq!(mapped[3].value, Some(serde_json::json!("high")));

    let effort_req = KiroExecuteCommandRequest::effort(SessionId::new("kiro-sess-1"), "max");
    assert_eq!(
        serde_json::to_value(&effort_req).unwrap(),
        serde_json::json!({
            "sessionId": "kiro-sess-1",
            "command": {
                "command": "effort",
                "args": { "level": "max" }
            }
        })
    );
    let thinking_req = KiroExecuteCommandRequest::thinking(SessionId::new("kiro-sess-1"), false);
    assert_eq!(
        serde_json::to_value(&thinking_req).unwrap(),
        serde_json::json!({
            "sessionId": "kiro-sess-1",
            "command": {
                "command": "reasoning",
                "args": { "thinkingEnabled": false }
            }
        })
    );
}

/// Antigravity 1.4+ advertises family ids on the standard `model` selector
/// (`gemini-4-argon`) plus a `thinking_level` option, while the same reply
/// still lists concrete variants in top-level `models.availableModels`.
/// That list is Kiro's catalog only for Kiro; treating it as
/// `KiroSessionConfig` sends `session/set_model` with the family id, which
/// oauth-personal rejects as "not available for the current authentication
/// method".
fn antigravity_family_options() -> Vec<AcpSessionConfigOption> {
    vec![
        AcpSessionConfigOption::select(
            "model",
            "Model",
            "gemini-3.8-flash",
            vec![
                SessionConfigSelectOption::new("gemini-3.8-flash", "Gemini 3.8 Flash"),
                SessionConfigSelectOption::new("gemini-4-argon", "Gemini 4 Argon"),
            ],
        )
        .category(Some(SessionConfigOptionCategory::Model)),
        AcpSessionConfigOption::select(
            "thinking_level",
            "Thinking",
            "high",
            vec![
                SessionConfigSelectOption::new("low", "Low"),
                SessionConfigSelectOption::new("medium", "Medium"),
                SessionConfigSelectOption::new("high", "High"),
            ],
        )
        .category(Some(SessionConfigOptionCategory::ThoughtLevel)),
    ]
}

fn antigravity_variant_models() -> serde_json::Value {
    serde_json::json!({
        "currentModelId": "gemini-3.8-flash-high",
        "availableModels": [
            {"modelId": "gemini-3.8-flash-high", "name": "Gemini 3.8 Flash"},
            {"modelId": "gemini-3.8-flash-low"},
            {"modelId": "gemini-3.8-flash-medium"},
            {"modelId": "gemini-4-argon-high"},
            {"modelId": "gemini-4-argon-low"},
            {"modelId": "gemini-4-argon-medium"}
        ]
    })
}

#[test]
fn antigravity_available_models_do_not_switch_vendor_wire_to_kiro() {
    let (_, options, vendor_config) = session_controls_with_models_and_vendor_fallback(
        None,
        Some(antigravity_family_options()),
        None,
        Some(&antigravity_variant_models()),
        "antigravity",
    );
    assert_eq!(
        vendor_config, None,
        "Antigravity keeps session/set_config_option; availableModels is not a Kiro catalog"
    );
    let options = options.expect("standard config options");
    let selection = find_config_override_selection_for_agent(
        &options,
        Some(AgentKind::Antigravity),
        "model",
        &serde_json::json!("gemini-4-argon"),
        &[],
    )
    .expect("family id is a selector row");
    assert_eq!(selection.config_id, "model");
    assert_eq!(selection.event_value, serde_json::json!("gemini-4-argon"));
}

#[test]
fn only_antigravity_replays_a_model_its_flat_list_still_offers() {
    let options = antigravity_family_options();
    let (model, level) = (&options[0], &options[1]);
    let models = session_model_ids(Some(&antigravity_variant_models()));
    let saved = "gemini-4-argon-high";

    assert!(config_option_rejects_value(model, saved));
    assert!(session_model_list_offers(
        Some(AgentKind::Antigravity),
        model,
        saved,
        &models
    ));
    assert!(!session_model_list_offers(
        Some(AgentKind::Antigravity),
        model,
        "gemini-2.5-pro",
        &models
    ));
    assert!(!session_model_list_offers(
        Some(AgentKind::Antigravity),
        model,
        saved,
        &[]
    ));
    assert!(!session_model_list_offers(
        Some(AgentKind::Antigravity),
        level,
        saved,
        &models
    ));
    for agent in [
        Some(AgentKind::ClaudeCode),
        Some(AgentKind::Codex),
        Some(AgentKind::Opencode),
        Some(AgentKind::Grok),
        Some(AgentKind::Kiro),
        None,
    ] {
        assert!(
            !session_model_list_offers(agent, model, saved, &models),
            "{agent:?}"
        );
    }

    let selection = find_config_override_selection_for_agent(
        &options,
        Some(AgentKind::Antigravity),
        "model",
        &serde_json::json!(saved),
        &models,
    )
    .expect("variant id still offered in the flat list is sent as saved");
    assert_eq!(selection.event_value, serde_json::json!(saved));
}

#[test]
fn antigravity_saved_variant_id_is_replayed_from_the_flat_model_list() {
    let options = antigravity_family_options();
    let models = session_model_ids(Some(&antigravity_variant_models()));
    let overrides = vec![
        AgentSessionConfigOverride {
            key: "thinking_level".to_string(),
            value: "medium".to_string(),
        },
        AgentSessionConfigOverride {
            key: "model".to_string(),
            value: "gemini-4-argon-high".to_string(),
        },
    ];
    let (_, config_to_apply, _) = prepare_preferred_controls_for_replay(
        Some(AgentKind::Antigravity),
        None,
        &options,
        None,
        &overrides,
        &models,
    );
    assert_eq!(
        config_to_apply
            .iter()
            .map(|item| (item.key.as_str(), item.value.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("model", "gemini-4-argon-high"),
            ("thinking_level", "medium"),
        ]
    );
}

#[test]
fn kiro_available_commands_filters_tui_only_and_includes_prompts() {
    let params = serde_json::json!({
        "sessionId": "kiro-sess-1",
        "commands": [
            { "name": "/compact", "description": "Compact context", "meta": { "local": false } },
            { "name": "/quit", "description": "Exit TUI", "meta": { "local": true } },
            { "name": "/rewind", "description": "Rewind", "meta": { "local": false } },
            { "name": "/knowledge", "description": "Knowledge base", "meta": { "subcommands": ["add", "search"] } }
        ],
        "prompts": [
            { "name": "review-pr", "serverName": "skill:review", "arguments": [{ "name": "args", "required": false }] },
            { "name": "deploy", "serverName": "ops-mcp", "description": "Deploy service", "arguments": [{ "name": "env", "required": true }] },
            { "name": "$ignored", "serverName": "local" }
        ]
    });
    let commands = kiro_available_commands(&params);
    let names: Vec<&str> = commands.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["compact", "knowledge", "review-pr", "deploy"]);
    assert_eq!(
        commands[1].input_schema,
        Some(serde_json::json!({ "hint": "add | search" }))
    );
    assert_eq!(commands[2].description.as_deref(), Some("Skill"));
    assert_eq!(commands[2].input_schema, None);
    assert_eq!(commands[3].description.as_deref(), Some("Deploy service"));
    assert_eq!(
        commands[3].input_schema,
        Some(serde_json::json!({ "hint": "<env>" }))
    );
}

/// A rejected session override happens before `session/prompt`. The user
/// message is already accepted, and reopening the conversation reads the
/// transcript, so the prompt must be on disk even though the turn failed.
#[tokio::test]
async fn failed_session_override_keeps_the_user_prompt_in_the_transcript() {
    let prompt_text = "remember this prompt after the model override fails";
    let (event_tx, mut event_rx) = manager_event_channel();
    let runner = dummy_runner(event_tx);
    let session_id = AgentSessionId::new();
    let acp_session_id = format!("override-fail-{}", uuid::Uuid::new_v4().simple());
    runner.session_controls.write().await.insert(
        session_id,
        SessionControlState {
            config_options: vec![
                AcpSessionConfigOption::select(
                    "model",
                    "Model",
                    "gemini-3.8-flash-high",
                    vec![
                        SessionConfigSelectOption::new("gemini-3.8-flash-high", "Gemini 3.8 Flash"),
                        SessionConfigSelectOption::new("gemini-4-argon", "Gemini 4 Argon"),
                    ],
                )
                .category(Some(SessionConfigOptionCategory::Model)),
            ],
            ..Default::default()
        },
    );

    let temp_root = tempfile::tempdir().unwrap();
    let agent_dir = jsonl_agent_dir("antigravity");
    let bound_conn_id = runner.snapshot.connection_id;
    crate::transcript_target::bind(
        bound_conn_id,
        crate::transcript_target::TranscriptTarget {
            root: temp_root.path().to_path_buf(),
            directory: agent_dir.clone(),
            session_id: acp_session_id.clone(),
        },
    );

    let (client_write, agent_read) = tokio::io::duplex(64 * 1024);
    let (agent_write, client_read) = tokio::io::duplex(64 * 1024);
    let agent_transport = acp::ByteStreams::new(agent_write.compat_write(), agent_read.compat());
    tokio::spawn(async move {
        let _ = acp::Agent.builder().connect_to(agent_transport).await;
    });
    let client_transport = acp::ByteStreams::new(client_write.compat_write(), client_read.compat());
    let (_cmd_tx, mut cmd_rx) = mpsc::channel(1);
    let request = RunPromptRequest {
        acp_session_id: acp_session_id.clone(),
        session_id,
        prompt_id: AgentPromptId::new(),
        blocks: vec![AgentContentBlock::Text {
            text: prompt_text.to_string(),
        }],
        display_blocks: Some(vec![AgentContentBlock::Text {
            text: prompt_text.to_string(),
        }]),
        mode_override: None,
        config_overrides: vec![AgentSessionConfigOverride {
            key: "model".to_string(),
            value: "gemini-4-argon".to_string(),
        }],
    };
    let outcome = tokio::time::timeout(
        Duration::from_secs(5),
        acp::Client
            .builder()
            .name("Dimo")
            .connect_with(client_transport, async move |conn| {
                runner.run_prompt(&conn, request, &mut cmd_rx).await
            }),
    )
    .await
    .expect("session override failure hung")
    .expect("override rejection must settle the turn");
    assert_eq!(outcome, RunPromptOutcome::Settled);

    let mut saw_override_failure = false;
    while let Ok(event) = event_rx.try_recv() {
        if let AgentEvent::Error { error } = event.event
            && error.message.contains("ACP session overrides failed")
        {
            saw_override_failure = true;
        }
    }
    assert!(
        saw_override_failure,
        "the turn must fail at session overrides, before session/prompt"
    );

    let root = temp_root.path();
    let _ = crate::acp_transcript::flush_in(root, &agent_dir, &acp_session_id).await;
    let transcript = crate::acp_transcript::read_chain_in(root, &agent_dir, &acp_session_id);
    let turns = crate::parsers::acp_native::project_turns(&transcript.entries);
    let user_texts: Vec<String> = turns
        .iter()
        .filter(|turn| matches!(turn.role, crate::conversation::TurnRole::User))
        .flat_map(|turn| turn.blocks.iter())
        .filter_map(|block| match block {
            crate::conversation::ContentBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        user_texts,
        vec![prompt_text.to_string()],
        "explicitly bound transcript target records the sent message"
    );
    assert!(
        transcript.entries.iter().any(|entry| {
            entry.k == crate::acp_transcript::EntryKind::TurnEnd
                && entry.p.get("stopReason").and_then(|value| value.as_str()) == Some("error")
        }),
        "a failed override must close the transcript turn"
    );
    crate::transcript_target::release(bound_conn_id);
}

#[test]
fn silent_end_turn_without_output_emits_turn_failed_empty_with_redacted_stderr() {
    let tail = StderrTail::new();
    tail.push("startup banner");
    let mark = tail.mark();
    tail.push("FATAL: upstream 401 with Authorization: Bearer sk-secret-token-1234567890");

    let probe = TurnOutputProbe::default();
    let response = acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::EndTurn);

    let error = turn_failure_error_event(&response, &probe, &tail, mark)
        .expect("empty EndTurn must produce turn_failed_empty error");
    assert_eq!(error.code.as_deref(), Some("turn_failed_empty"));
    assert!(
        error.message.contains("<redacted>"),
        "stderr diagnostic must be redacted: {}",
        error.message
    );
    assert!(
        !error.message.contains("sk-secret-token"),
        "raw secret must never leak: {}",
        error.message
    );
    assert!(
        !error.message.contains("startup banner"),
        "stderr before turn mark must be excluded: {}",
        error.message
    );
    assert_eq!(
        finish_turn_reason(&response.stop_reason, probe.has_output(), false),
        "turn_failed_empty"
    );
}

#[test]
fn end_turn_with_visible_output_does_not_emit_turn_failure() {
    let tail = StderrTail::new();
    let mark = tail.mark();
    tail.push("harmless warning on stderr");

    let probe = TurnOutputProbe::default();
    probe.note_rendered();
    let response = acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::EndTurn);

    assert!(turn_failure_error_event(&response, &probe, &tail, mark).is_none());
    assert_eq!(
        finish_turn_reason(&response.stop_reason, probe.has_output(), false),
        "end_turn"
    );
}

#[test]
fn refusal_max_tokens_and_max_turn_requests_emit_structured_turn_failure_errors() {
    let tail = StderrTail::new();
    let mark = tail.mark();
    let probe = TurnOutputProbe::default();
    probe.note_rendered();

    let refusal = acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::Refusal);
    let refusal_err = turn_failure_error_event(&refusal, &probe, &tail, mark)
        .expect("StopReason::Refusal must emit error");
    assert_eq!(refusal_err.code.as_deref(), Some("turn_failed_refusal"));
    assert!(refusal_err.message.contains("StopReason::Refusal"));

    let max_tokens = acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::MaxTokens);
    let max_tokens_err = turn_failure_error_event(&max_tokens, &probe, &tail, mark)
        .expect("StopReason::MaxTokens must emit error");
    assert_eq!(
        max_tokens_err.code.as_deref(),
        Some("turn_failed_max_tokens")
    );
    assert!(max_tokens_err.message.contains("StopReason::MaxTokens"));

    let max_requests =
        acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::MaxTurnRequests);
    let max_requests_err = turn_failure_error_event(&max_requests, &probe, &tail, mark)
        .expect("StopReason::MaxTurnRequests must emit error");
    assert_eq!(
        max_requests_err.code.as_deref(),
        Some("turn_failed_max_turn_requests")
    );
    assert!(
        max_requests_err
            .message
            .contains("StopReason::MaxTurnRequests")
    );
}

#[test]
fn jetbrains_air_capabilities_and_session_failure_extraction_work() {
    let caps = build_client_capabilities(&AgentId::parse("claude_code").unwrap());
    let meta = caps.meta.expect("client capabilities must include _meta");
    assert_eq!(
        meta.get("jetbrains.air")
            .and_then(|v| v.get("sessionFailure")),
        Some(&serde_json::json!(true))
    );

    let rpc_err = acp::Error::internal_error().data(serde_json::json!({
        "_meta": {
            "jetbrains.air": {
                "sessionFailure": {
                    "type": "RateLimitExceeded",
                    "reason": "Quota exhausted for claude-sonnet",
                    "userMessage": "Rate limit reached; please wait 60 seconds."
                }
            }
        }
    }));
    let tail = StderrTail::new();
    let mark = tail.mark();
    let formatted = format_acp_prompt_error(&rpc_err, &tail, mark);
    assert!(
        formatted
            .message
            .contains("Rate limit reached; please wait 60 seconds."),
        "expected userMessage in formatted error: {}",
        formatted.message
    );
    assert!(
        formatted.message.contains("[RateLimitExceeded]"),
        "expected failure type in formatted error: {}",
        formatted.message
    );

    let mut response_meta = serde_json::Map::new();
    response_meta.insert(
        "jetbrains.air".to_string(),
        serde_json::json!({
            "sessionFailure": {
                "type": "AuthenticationFailed",
                "userMessage": "Session token expired, please re-authenticate."
            }
        }),
    );
    let response = acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::EndTurn)
        .meta(response_meta);
    let probe = TurnOutputProbe::default();
    let empty_err = turn_failure_error_event(&response, &probe, &tail, mark)
        .expect("empty EndTurn with sessionFailure must surface error");
    assert_eq!(empty_err.code.as_deref(), Some("turn_failed_empty"));
    assert!(
        empty_err
            .message
            .contains("Session token expired, please re-authenticate."),
        "expected sessionFailure userMessage in empty turn error: {}",
        empty_err.message
    );
}

#[test]
fn omit_null_error_data_and_fix_usage_update_nulls_clean_non_conformant_frames() {
    let error_frame = r#"{"jsonrpc":"2.0","id":0,"error":{"code":-32601,"message":"\"session/list\": Method not found","data":null}}"#;
    let cleaned_error = sanitize_incoming_jsonrpc_line(error_frame.to_string());
    let parsed_error: serde_json::Value = serde_json::from_str(&cleaned_error).unwrap();
    assert!(parsed_error["error"].get("data").is_none());
    assert_eq!(
        parsed_error["error"]["message"],
        "\"session/list\": Method not found"
    );

    let usage_frame = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"usage_update","size":null,"used":null,"cost":{"amount":0.01,"currency":null}}}}"#;
    let cleaned_usage = sanitize_incoming_jsonrpc_line(usage_frame.to_string());
    let parsed_usage: serde_json::Value = serde_json::from_str(&cleaned_usage).unwrap();
    assert_eq!(parsed_usage["params"]["update"]["size"], 0);
    assert_eq!(parsed_usage["params"]["update"]["used"], 0);
    assert!(parsed_usage["params"]["update"].get("cost").is_none());
}

#[test]
fn sanitize_drops_notifications_with_a_null_session_id() {
    let setup = r#"{"jsonrpc":"2.0","method":"_x.ai/session/setup","params":{"sessionId":null,"phase":"auth"}}"#;
    assert!(sanitize_incoming_jsonrpc_line(setup.to_string()).is_empty());

    let missing = r#"{"jsonrpc":"2.0","method":"_x.ai/models/update","params":{"models":[]}}"#;
    assert_eq!(sanitize_incoming_jsonrpc_line(missing.to_string()), missing);

    let named = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk"}}}"#;
    assert_eq!(sanitize_incoming_jsonrpc_line(named.to_string()), named);

    let request = r#"{"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{"sessionId":null}}"#;
    assert_eq!(sanitize_incoming_jsonrpc_line(request.to_string()), request);
}

#[test]
fn sanitize_drops_pure_nul_terminal_output_deltas() {
    let nuls = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_1","_meta":{"terminal_output_delta":{"terminal_id":"term-1","data":"\u0000\u0000\u0000"}}}}}"#;
    assert!(sanitize_incoming_jsonrpc_line(nuls.to_string()).is_empty());

    let mixed = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_1","_meta":{"terminal_output_delta":{"terminal_id":"term-1","data":"ok\u0000"}}}}}"#;
    assert_eq!(sanitize_incoming_jsonrpc_line(mixed.to_string()), mixed);

    let with_status = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_1","status":"completed","_meta":{"terminal_output_delta":{"terminal_id":"term-1","data":"\u0000"}}}}}"#;
    assert_eq!(
        sanitize_incoming_jsonrpc_line(with_status.to_string()),
        with_status
    );

    let empty = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_1","_meta":{"terminal_output_delta":{"terminal_id":"term-1","data":""}}}}}"#;
    assert_eq!(sanitize_incoming_jsonrpc_line(empty.to_string()), empty);
}

#[test]
fn leading_edge_throttle_suppresses_bursts_and_reports_count_after_window() {
    let window = Duration::from_secs(10);
    let throttle = LeadingEdgeThrottle::new(window);
    let window_ns = window.as_nanos() as u64;

    assert_eq!(throttle.check_at(0), Some(0));
    for ms in 1..=25 {
        assert_eq!(throttle.check_at(ms * 100_000_000), None);
    }
    assert_eq!(throttle.check_at(window_ns + 1_000_000), Some(25));
    assert_eq!(throttle.flush(), 0);
}

#[test]
fn disconnect_join_timeout_allows_transcript_flush_before_abort() {
    assert!(DISCONNECT_JOIN_TIMEOUT >= Duration::from_secs(8));
}

#[tokio::test]
async fn session_load_replay_suppresses_ext_notifications_and_historical_usage() {
    let session_id = AgentSessionId::new();
    let (event_tx, mut event_rx) = manager_event_channel();
    let bridge = AcpClientBridge::new(
        AgentConnectionId::new(),
        AgentId::parse("grok").unwrap(),
        event_tx,
        Arc::new(RwLock::new(HashMap::new())),
        Arc::new(RwLock::new(HashMap::new())),
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(Mutex::new(AgentAutoApproveMode::default())),
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(Mutex::new(Instant::now())),
        Arc::new(Mutex::new(GrokSubagentTracker::default())),
        Arc::new(Mutex::new(GrokMcpTracker::default())),
        Arc::new(Mutex::new(Some(session_id))),
        PathBuf::from("C:/workspace"),
        HashMap::new(),
        dummy_runner(manager_event_channel().0),
    );

    let ext = agent_client_protocol::schema::v1::ExtNotification::new(
        "x.ai/subagent_spawned",
        serde_json::value::to_raw_value(&serde_json::json!({
            "sessionId": "acp-replay-1",
            "subagentId": "sub-1",
            "toolCallId": "call-1",
            "agentType": "research",
            "task": "scan repo"
        }))
        .unwrap()
        .into(),
    );
    bridge.handle_ext_notification(ext).await.unwrap();

    let usage_notification: SessionNotification = serde_json::from_value(serde_json::json!({
        "sessionId": "acp-replay-1",
        "update": {
            "sessionUpdate": "usage_update",
            "used": 1200,
            "size": 128000
        }
    }))
    .unwrap();
    bridge
        .session_notification(usage_notification)
        .await
        .unwrap();

    let info_notification: SessionNotification = serde_json::from_value(serde_json::json!({
        "sessionId": "acp-replay-1",
        "update": {
            "sessionUpdate": "session_info_update",
            "title": "Historical title"
        }
    }))
    .unwrap();
    bridge
        .session_notification(info_notification)
        .await
        .unwrap();

    let thought_with_meta: SessionNotification = serde_json::from_value(serde_json::json!({
        "sessionId": "acp-replay-1",
        "_meta": {
            "totalTokens": 4096
        },
        "update": {
            "sessionUpdate": "agent_thought_chunk",
            "content": {
                "type": "text",
                "text": "replayed thought"
            }
        }
    }))
    .unwrap();
    bridge
        .session_notification(thought_with_meta)
        .await
        .unwrap();

    assert!(
        event_rx.try_recv().is_err(),
        "session/load replay notifications while unbound must not emit live events"
    );
}

#[tokio::test]
async fn wait_for_question_registers_pending_elicitation_before_emitting_event() {
    let session_id = AgentSessionId::new();
    let (event_tx, mut event_rx) = manager_event_channel();
    let runner = dummy_runner(event_tx.clone());
    let bridge = AcpClientBridge::new(
        runner.snapshot.connection_id,
        runner.snapshot.agent_id.clone(),
        event_tx,
        Arc::clone(&runner.session_map),
        Arc::clone(&runner.session_controls),
        Arc::clone(&runner.pending_permissions),
        Arc::clone(&runner.pending_elicitations),
        Arc::clone(&runner.auto_approve_mode),
        Arc::clone(&runner.stream_dedup),
        Arc::clone(&runner.last_activity),
        Arc::clone(&runner.grok_subagent),
        Arc::clone(&runner.grok_mcp),
        Arc::clone(&runner.pending_session_id),
        runner.snapshot.working_dir.clone(),
        runner.snapshot.env.clone(),
        runner.clone(),
    );

    let wait_task = tokio::spawn(async move {
        bridge
            .wait_for_question(
                session_id,
                "Pick one".to_string(),
                serde_json::json!({"type": "object"}),
            )
            .await
    });

    let requested = event_rx
        .recv()
        .await
        .expect("ElicitationRequested event must arrive");
    let elicitation_id = match requested.event {
        AgentEvent::ElicitationRequested { request } => request.id.to_string(),
        other => panic!("expected ElicitationRequested, got {other:?}"),
    };

    assert!(
        runner
            .pending_elicitations
            .lock()
            .await
            .contains_key(&elicitation_id),
        "pending_elicitations must already contain the entry when ElicitationRequested is received"
    );

    runner
        .respond_pending_elicitation(
            &elicitation_id,
            AgentElicitationResponse::Accept {
                content: serde_json::json!({"choice": "A"}),
            },
        )
        .await;

    let response = wait_task.await.unwrap();
    assert_eq!(
        response,
        AgentElicitationResponse::Accept {
            content: serde_json::json!({"choice": "A"}),
        }
    );
}

fn claude_model_selector(opus_row: &str) -> AcpSessionConfigOption {
    let rows: Vec<serde_json::Value> = [
        opus_row,
        "claude-fable-5-1[1m]",
        "sonnet",
        "sonnet[1m]",
        "haiku",
    ]
    .iter()
    .map(|value| serde_json::json!({"value": value, "name": value}))
    .collect();
    serde_json::from_value(serde_json::json!({
        "type": "select",
        "id": "model",
        "name": "Model",
        "category": "model",
        "currentValue": opus_row,
        "options": rows,
    }))
    .expect("parses")
}

fn gateway_model_selector_2_1_287() -> AcpSessionConfigOption {
    serde_json::from_value(serde_json::json!({
        "id": "model",
        "name": "Model",
        "description": "AI model to use",
        "category": "model",
        "type": "select",
        "currentValue": "opus",
        "_meta": {"jetbrains": {"air": {"version": 1, "recommendedValue": "opus"}}},
        "options": [
            {"value": "opus", "name": "Opus 5.5", "description": "Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok"},
            {"value": "fable", "name": "Fable 5.1", "description": "Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok"},
            {"value": "sonnet", "name": "Sonnet 5.5", "description": "Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok"},
            {"value": "haiku", "name": "Haiku 4.5", "description": "Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok"},
        ],
    }))
    .expect("parses")
}

fn claude_modes(bypass: bool) -> SessionModeState {
    let mut modes = vec![
        serde_json::json!({"id": "default", "name": "Manual"}),
        serde_json::json!({"id": "acceptEdits", "name": "Accept edits"}),
        serde_json::json!({"id": "plan", "name": "Plan"}),
        serde_json::json!({"id": "auto", "name": "Auto"}),
    ];
    if bypass {
        modes.push(serde_json::json!({"id": "bypassPermissions", "name": "Bypass permissions"}));
    }
    serde_json::from_value(serde_json::json!({
        "currentModeId": "default",
        "availableModes": modes,
    }))
    .expect("parses")
}

#[test]
fn config_option_rejects_value_only_for_non_empty_selects() {
    let model = claude_model_selector("opus[1m]");
    assert!(config_option_rejects_value(&model, "default"));
    assert!(!config_option_rejects_value(&model, "opus[1m]"));

    let empty: AcpSessionConfigOption = serde_json::from_value(serde_json::json!({
        "id": "model",
        "name": "Model",
        "type": "select",
        "currentValue": "",
        "options": [],
    }))
    .expect("parses");
    assert!(!config_option_rejects_value(&empty, "opus[1m]"));

    let toggle: AcpSessionConfigOption = serde_json::from_value(serde_json::json!({
        "id": "auto_approve",
        "name": "Auto-approve tools",
        "type": "boolean",
        "currentValue": false,
    }))
    .expect("parses");
    assert!(!config_option_rejects_value(&toggle, "true"));
}

#[test]
fn retired_context_lane_and_respelled_fable_picks_heal_only_when_exact_is_gone() {
    let renamed = claude_model_selector("opus");
    assert_eq!(
        heal_retired_context_lane_pick(&renamed, "opus[1m]").as_deref(),
        Some("opus")
    );
    assert_eq!(
        heal_retired_context_lane_pick(&renamed, "opus[1M]").as_deref(),
        Some("opus")
    );
    // When both `sonnet` and `sonnet[1m]` are offered, `sonnet[1m]` is NOT healed away.
    assert_eq!(heal_retired_context_lane_pick(&renamed, "sonnet[1m]"), None);
    // Plain pick is never promoted to `[1m]`.
    assert_eq!(
        heal_retired_context_lane_pick(&claude_model_selector("opus[1m]"), "opus"),
        None
    );

    let gateway = gateway_model_selector_2_1_287();
    assert_eq!(
        heal_retired_model_pick(&gateway, "claude-fable-5-1").as_deref(),
        Some("fable")
    );
    assert_eq!(
        heal_retired_model_pick(&gateway, "claude-fable-5-1[1m]").as_deref(),
        Some("fable")
    );
    assert_eq!(
        heal_retired_model_pick(&gateway, "opus[1m]").as_deref(),
        Some("opus")
    );
    // Once the catalog version moves on (e.g. saved 5.0 against 5.1 row), it must NOT heal.
    assert_eq!(heal_retired_model_pick(&gateway, "claude-fable-5-0"), None);
    assert!(
        find_config_override_selection_for_agent(
            std::slice::from_ref(&gateway),
            Some(AgentKind::ClaudeCode),
            "model",
            &serde_json::json!("claude-fable-5-0"),
            &[],
        )
        .is_none(),
        "retired Fable version must be dropped rather than fuzzy-matched onto Fable 5.1"
    );
}

#[test]
fn withdrawn_bypass_mode_and_retired_picks_are_skipped_during_replay() {
    assert!(session_modes_reject_id(
        &claude_modes(false),
        "bypassPermissions"
    ));
    assert!(!session_modes_reject_id(
        &claude_modes(true),
        "bypassPermissions"
    ));
    let empty_modes: SessionModeState = serde_json::from_value(serde_json::json!({
        "currentModeId": "",
        "availableModes": [],
    }))
    .expect("parses");
    assert!(!session_modes_reject_id(&empty_modes, "bypassPermissions"));

    let gateway = gateway_model_selector_2_1_287();
    let effort: AcpSessionConfigOption = serde_json::from_value(serde_json::json!({
        "id": "effort",
        "name": "Effort",
        "category": "thought_level",
        "type": "select",
        "currentValue": "medium",
        "options": [
            {"value": "low", "name": "Low"},
            {"value": "medium", "name": "Medium"},
            {"value": "high", "name": "High"},
        ],
    }))
    .expect("parses");
    let options = vec![gateway, effort];
    let overrides = vec![
        AgentSessionConfigOverride {
            key: "effort".to_string(),
            value: "high".to_string(),
        },
        AgentSessionConfigOverride {
            key: "model".to_string(),
            value: "claude-fable-5-1[1m]".to_string(),
        },
    ];

    let (mode_to_apply, config_to_apply, preferred_map) = prepare_preferred_controls_for_replay(
        Some(AgentKind::ClaudeCode),
        Some(&claude_modes(false)),
        &options,
        Some("bypassPermissions"),
        &overrides,
        &[],
    );
    assert_eq!(
        mode_to_apply, None,
        "withdrawn bypassPermissions must be dropped"
    );
    assert_eq!(
        config_to_apply,
        vec![
            AgentSessionConfigOverride {
                key: "model".to_string(),
                value: "fable".to_string(),
            },
            AgentSessionConfigOverride {
                key: "effort".to_string(),
                value: "high".to_string(),
            },
        ],
        "model must be healed and ordered before dependent options"
    );
    assert_eq!(
        preferred_map.get("model").map(String::as_str),
        Some("fable")
    );
    assert!(!preferred_map.contains_key("mode"));
}

pub(super) fn dummy_runner_for_agent(
    agent_id: &str,
    event_tx: ManagerEventSender,
) -> AgentConnectionRunner {
    AgentConnectionRunner::new(
        ManagedAgentConnectionSnapshot {
            connection_id: AgentConnectionId::new(),
            agent_id: AgentId::parse(agent_id).unwrap(),
            launch_lock: crate::SessionLaunchLock {
                agent_id: AgentId::parse(agent_id).unwrap(),
                absolute_acp_program: PathBuf::from("/managed/acp"),
                args: vec!["serve".into()],
                env: BTreeMap::new(),
                runtime_version: "2.0.0".into(),
                acp_version: "1.1.0".into(),
            },
            workspace_id: uuid::Uuid::nil(),
            working_dir: PathBuf::from("C:/workspace"),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::default(),
            env: HashMap::new(),
        },
        event_tx,
        None,
    )
}

#[test]
fn sanitize_incoming_jsonrpc_line_rewrites_air_async_task_and_prompt_suggestion_updates() {
    let spawned = sanitize_incoming_jsonrpc_line(
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"async_task_spawned","taskId":"bg-1","name":"npm test","taskType":"shell","state":"running","canStop":true}}}"#.to_string(),
    );
    let parsed: serde_json::Value = serde_json::from_str(&spawned).unwrap();
    assert_eq!(parsed["method"], AIR_SESSION_UPDATE_METHOD);
    assert_eq!(
        parsed["params"]["update"]["sessionUpdate"],
        "async_task_spawned"
    );

    let suggestion = sanitize_incoming_jsonrpc_line(
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"prompt_suggestion_update","_meta":{"promptSuggestions":{"version":1,"suggestions":[{"text":"Run tests"}]}}}}}"#.to_string(),
    );
    let parsed: serde_json::Value = serde_json::from_str(&suggestion).unwrap();
    assert_eq!(parsed["method"], AIR_SESSION_UPDATE_METHOD);

    let workflow = sanitize_incoming_jsonrpc_line(
        r#"{"jsonrpc":"2.0","method":"session/workflow_updated","params":{"sessionId":"s1","workflowId":"wf-1","name":"Deploy","status":"running"}}"#.to_string(),
    );
    let parsed: serde_json::Value = serde_json::from_str(&workflow).unwrap();
    assert_eq!(parsed["method"], GROK_WORKFLOW_UPDATED_METHOD);
}

#[tokio::test]
async fn session_info_goal_synthesizes_timeline_markers_and_normalizes_status() {
    let session_id = AgentSessionId::new();
    let (event_tx, mut event_rx) = manager_event_channel();
    let runner = dummy_runner_for_agent("codex", event_tx);
    *runner.goal_advertised_control.write().await = Some((
        Some(crate::codex_goal::NEUTRAL_GOAL_CONTROL_METHOD.to_string()),
        vec![
            "pause".to_string(),
            "resume".to_string(),
            "clear".to_string(),
            "set".to_string(),
        ],
    ));
    runner.handshake_completed.store(true, Ordering::SeqCst);
    runner.neutral_goal_channel.store(true, Ordering::SeqCst);

    // Legacy _meta.codex.goal is ignored when neutral_goal_channel is true.
    let legacy_meta = serde_json::json!({
        "codex": {
            "goal": {
                "objective": "Ignored legacy goal",
                "status": "active"
            }
        }
    });
    assert!(crate::codex_goal::session_info_goal_value(legacy_meta.as_object(), true).is_none());

    // Neutral active goal synthesizes create_goal (codex-goal-1) + GoalUpdated.
    runner
        .apply_session_info_goal(
            Some(session_id),
            &serde_json::json!({
                "objective": "Ship Goal Bar",
                "status": "active",
                "tokensUsed": 1200
            }),
            true,
        )
        .await;

    let first = event_rx.try_recv().expect("GoalUpdated");
    match first.event {
        AgentEvent::GoalUpdated { goal, goal_actions } => {
            assert_eq!(
                goal.as_ref().and_then(|g| g["objective"].as_str()),
                Some("Ship Goal Bar")
            );
            assert_eq!(
                goal_actions,
                Some(vec![
                    "pause".to_string(),
                    "resume".to_string(),
                    "clear".to_string(),
                    "set".to_string(),
                ])
            );
        }
        other => panic!("expected GoalUpdated, got {other:?}"),
    }

    let second = event_rx.try_recv().expect("ToolCall create_goal");
    match second.event {
        AgentEvent::ToolCall { tool_call } => {
            assert_eq!(tool_call.id, "codex-goal-1");
            assert_eq!(tool_call.title, "create_goal");
            assert_eq!(tool_call.status.as_deref(), Some("completed"));
        }
        other => panic!("expected ToolCall, got {other:?}"),
    }

    // Transition to budgetLimited normalizes to budget_limited and synthesizes update_goal.
    runner
        .apply_session_info_goal(
            Some(session_id),
            &serde_json::json!({
                "objective": "Ship Goal Bar",
                "status": "budgetLimited",
                "tokensUsed": 5000
            }),
            true,
        )
        .await;

    let updated = event_rx.try_recv().expect("GoalUpdated");
    match updated.event {
        AgentEvent::GoalUpdated { goal, .. } => {
            assert_eq!(
                goal.as_ref().and_then(|g| g["status"].as_str()),
                Some("budget_limited")
            );
        }
        other => panic!("expected GoalUpdated, got {other:?}"),
    }

    let marker = event_rx.try_recv().expect("ToolCall update_goal");
    match marker.event {
        AgentEvent::ToolCall { tool_call } => {
            assert_eq!(tool_call.id, "codex-goal-2");
            assert_eq!(tool_call.title, "update_goal");
            assert_eq!(tool_call.status.as_deref(), Some("completed"));
        }
        other => panic!("expected ToolCall, got {other:?}"),
    }

    // Starting the same objective again gets a new occurrence id (codex-goal-3).
    runner
        .apply_session_info_goal(
            Some(session_id),
            &serde_json::json!({
                "objective": "Ship Goal Bar",
                "status": "active"
            }),
            true,
        )
        .await;
    let _ = event_rx.try_recv().expect("GoalUpdated");
    let second_run = event_rx.try_recv().expect("ToolCall create_goal #2");
    match second_run.event {
        AgentEvent::ToolCall { tool_call } => {
            assert_eq!(tool_call.id, "codex-goal-3");
            assert_eq!(tool_call.title, "create_goal");
        }
        other => panic!("expected ToolCall, got {other:?}"),
    }
}
