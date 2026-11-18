use super::*;

#[tokio::test]
async fn async_task_and_prompt_suggestion_ext_notifications_route_to_session_controls() {
    let session_id = AgentSessionId::new();
    let (event_tx, mut event_rx) = manager_event_channel();
    let runner = dummy_runner_for_agent("claude_code", event_tx.clone());
    let bridge = AcpClientBridge::new(
        AgentConnectionId::new(),
        AgentId::parse("claude_code").unwrap(),
        event_tx,
        Arc::new(RwLock::new(HashMap::from([(
            session_id,
            "acp-claude".into(),
        )]))),
        Arc::new(RwLock::new(HashMap::new())),
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(Mutex::new(AgentAutoApproveMode::default())),
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(Mutex::new(Instant::now())),
        Arc::new(Mutex::new(GrokSubagentTracker::default())),
        Arc::new(Mutex::new(GrokMcpTracker::default())),
        Arc::new(Mutex::new(None)),
        PathBuf::from("C:/workspace"),
        HashMap::new(),
        runner.clone(),
    );

    let spawned_raw = serde_json::value::to_raw_value(&serde_json::json!({
        "sessionId": "acp-claude",
        "update": {
            "sessionUpdate": "async_task_spawned",
            "taskId": "task-1",
            "name": "cargo test",
            "taskType": "shell",
            "state": "running",
            "canStop": true
        }
    }))
    .unwrap();
    bridge
        .handle_ext_notification(acp::schema::v1::ExtNotification::new(
            AIR_SESSION_UPDATE_METHOD,
            spawned_raw.into(),
        ))
        .await
        .unwrap();

    let task_event = event_rx.try_recv().expect("AsyncTasksUpdated");
    match task_event.event {
        AgentEvent::AsyncTasksUpdated { tasks } => {
            assert_eq!(tasks.len(), 1);
            assert_eq!(tasks[0].id, "task-1");
            assert_eq!(tasks[0].name.as_deref(), Some("cargo test"));
            assert!(tasks[0].can_stop);
        }
        other => panic!("expected AsyncTasksUpdated, got {other:?}"),
    }

    let suggestion_raw = serde_json::value::to_raw_value(&serde_json::json!({
        "sessionId": "acp-claude",
        "update": {
            "sessionUpdate": "prompt_suggestion_update",
            "_meta": {
                "promptSuggestions": {
                    "version": 1,
                    "suggestions": [{ "text": "Commit the changes" }]
                }
            }
        }
    }))
    .unwrap();
    bridge
        .handle_ext_notification(acp::schema::v1::ExtNotification::new(
            AIR_SESSION_UPDATE_METHOD,
            suggestion_raw.clone().into(),
        ))
        .await
        .unwrap();
    assert!(
        event_rx.try_recv().is_err(),
        "headless sessions without wants_prompt_suggestions must ignore suggestions"
    );

    runner
        .record_wants_prompt_suggestions(session_id, true)
        .await;
    bridge
        .handle_ext_notification(acp::schema::v1::ExtNotification::new(
            AIR_SESSION_UPDATE_METHOD,
            suggestion_raw.into(),
        ))
        .await
        .unwrap();

    let suggestion_event = event_rx.try_recv().expect("PromptSuggestionUpdated");
    match suggestion_event.event {
        AgentEvent::PromptSuggestionUpdated { suggestion } => {
            assert_eq!(suggestion.as_deref(), Some("Commit the changes"));
        }
        other => panic!("expected PromptSuggestionUpdated, got {other:?}"),
    }

    let controls = runner.session_controls_snapshot(session_id).await;
    assert_eq!(controls.async_tasks.len(), 1);
    assert_eq!(
        controls.prompt_suggestion.as_deref(),
        Some("Commit the changes")
    );
}

#[tokio::test]
async fn in_memory_goal_control_orchestration_respects_claude_and_codex_rules() {
    let (event_tx, _event_rx) = manager_event_channel();
    let manager = AgentConnectionManager::new_with_driver(event_tx, false);

    // 1. Claude clear never interrupts the in-flight turn.
    let (claude_snap, claude_ready) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id: AgentConnectionId::new(),
            agent_id: AgentId::parse("claude_code").unwrap(),
            launch_lock: test_launch_lock(AgentId::parse("claude_code").unwrap()),
            workspace_id: uuid::Uuid::nil(),
            working_dir: PathBuf::from("C:/workspace"),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;
    claude_ready.await.unwrap().unwrap();
    let claude_session = AgentSessionId::new();
    manager
        .prepare_session(
            claude_snap.connection_id,
            claude_session,
            Default::default(),
        )
        .await
        .unwrap();
    let claude_receipt = manager
        .goal_control(claude_snap.connection_id, claude_session, "clear")
        .await
        .unwrap();
    assert!(!claude_receipt.should_interrupt_turn);

    // 2. Codex pause interrupts turn; clear when paused does NOT interrupt turn.
    let (codex_snap, codex_ready) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id: AgentConnectionId::new(),
            agent_id: AgentId::parse("codex").unwrap(),
            launch_lock: test_launch_lock(AgentId::parse("codex").unwrap()),
            workspace_id: uuid::Uuid::nil(),
            working_dir: PathBuf::from("C:/workspace"),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;
    codex_ready.await.unwrap().unwrap();
    let codex_session = AgentSessionId::new();
    manager
        .prepare_session(codex_snap.connection_id, codex_session, Default::default())
        .await
        .unwrap();

    let pause_receipt = manager
        .goal_control(codex_snap.connection_id, codex_session, "pause")
        .await
        .unwrap();
    assert!(pause_receipt.should_interrupt_turn);

    let clear_when_paused = manager
        .goal_control(codex_snap.connection_id, codex_session, "clear")
        .await
        .unwrap();
    assert!(
        !clear_when_paused.should_interrupt_turn,
        "clearing a non-active goal must not cancel a user-initiated turn"
    );
}

#[tokio::test]
async fn antigravity_synthetic_turn_error_and_cancel_chunks_are_not_emitted_as_assistant_prose() {
    let session_id = AgentSessionId::new();
    let (event_tx, mut event_rx) = manager_event_channel();
    let runner = dummy_runner_for_agent("antigravity", event_tx.clone());
    let probe = Arc::new(TurnOutputProbe::default());
    // Even if the agent already emitted thoughts or tool calls earlier in the turn,
    // a terminal AntigravityExecutionError chunk must still fail the turn.
    probe.note_rendered();
    *runner.active_turn_probe.lock().unwrap() = Some((session_id, Arc::clone(&probe)));

    let bridge = AcpClientBridge::new(
        AgentConnectionId::new(),
        AgentId::parse("antigravity").unwrap(),
        event_tx,
        Arc::new(RwLock::new(HashMap::from([(session_id, "acp-agy".into())]))),
        Arc::new(RwLock::new(HashMap::new())),
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(Mutex::new(AgentAutoApproveMode::default())),
        Arc::new(Mutex::new(HashMap::new())),
        Arc::new(Mutex::new(Instant::now())),
        Arc::new(Mutex::new(GrokSubagentTracker::default())),
        Arc::new(Mutex::new(GrokMcpTracker::default())),
        Arc::new(Mutex::new(None)),
        PathBuf::from("C:/workspace"),
        HashMap::new(),
        runner,
    );

    bridge
        .session_notification(SessionNotification::new(
            SessionId::new("acp-agy"),
            SessionUpdate::AgentMessageChunk(acp::schema::v1::ContentChunk::new(
                ContentBlock::from("The request was cancelled by the client."),
            )),
        ))
        .await
        .unwrap();
    assert!(
        event_rx.try_recv().is_err(),
        "synthetic cancellation chunk must not emit AgentEvent::MessageChunk"
    );

    let raw_502 = "Agent execution error: model unreachable: Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: 502 Bad Gateway";
    bridge
        .session_notification(SessionNotification::new(
            SessionId::new("acp-agy"),
            SessionUpdate::AgentMessageChunk(acp::schema::v1::ContentChunk::new(
                ContentBlock::from(raw_502),
            )),
        ))
        .await
        .unwrap();
    assert!(
        event_rx.try_recv().is_err(),
        "synthetic execution error chunk must not emit AgentEvent::MessageChunk"
    );

    let tail = StderrTail::new();
    let mark = tail.mark();
    let response = acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::EndTurn);
    let failure = turn_failure_error_event(&response, &probe, &tail, mark)
        .expect("EndTurn after Antigravity execution error chunk must produce AgentErrorEvent");
    assert_eq!(failure.code.as_deref(), Some("model_unreachable"));
    assert!(failure.message.contains("502 Bad Gateway"));
    assert!(failure.message.contains("cloudcode-pa.googleapis.com"));
}

#[test]
fn format_acp_prompt_error_classifies_session_not_found_as_agent_connection_lost() {
    let tail = StderrTail::new();
    let mark = tail.mark();
    for raw_msg in [
        "Session not found: 5b6593fa-0136-4a76-bfaa-92cb4412aa06",
        "Internal error: session not found",
        "The session has ended on the server",
    ] {
        let err = acp::Error::new(-32603, raw_msg);
        let event = format_acp_prompt_error(&err, &tail, mark);
        assert_eq!(
            event.code.as_deref(),
            Some("agent_connection_lost"),
            "expected agent_connection_lost for `{raw_msg}`"
        );
        assert!(event.message.contains(raw_msg));
    }

    let unrelated = acp::Error::new(-32603, "Internal error: tool execution failed");
    let unrelated_event = format_acp_prompt_error(&unrelated, &tail, mark);
    assert_eq!(unrelated_event.code.as_deref(), Some("internal_error"));
}

#[tokio::test]
async fn run_prompt_unbinds_session_and_closes_connection_on_agent_connection_lost_after_partial_output()
 {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let session_id = AgentSessionId::new();
    let prompt_id = AgentPromptId::new();
    let (event_tx, mut event_rx) = manager_event_channel();
    let runner = dummy_runner_for_agent("antigravity", event_tx.clone());
    runner
        .session_map
        .write()
        .await
        .insert(session_id, "acp-agy-live".to_string());
    runner
        .session_controls
        .write()
        .await
        .insert(session_id, SessionControlState::default());
    *runner.active_prompt.lock().await = Some((session_id, prompt_id));

    let (client_to_agent, agent_from_client) = tokio::io::duplex(64 * 1024);
    let (agent_to_client, client_from_agent) = tokio::io::duplex(64 * 1024);

    let agent_task = tokio::spawn(async move {
        let mut reader = BufReader::new(agent_from_client);
        let mut writer = agent_to_client;
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let req: serde_json::Value = serde_json::from_str(&line).unwrap();
        let req_id = req["id"].clone();

        // 1. Stream partial output first.
        let partial_chunk = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "acp-agy-live",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "Partial response before crash" }
                }
            }
        });
        writer
            .write_all(format!("{partial_chunk}\n").as_bytes())
            .await
            .unwrap();

        // 2. Stream Antigravity's synthetic connection-lost chunk.
        let err_chunk = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "acp-agy-live",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {
                        "type": "text",
                        "text": "Agent connection was lost and could not be re-established: 13 INTERNAL: Agent execution terminated due to error."
                    }
                }
            }
        });
        writer
            .write_all(format!("{err_chunk}\n").as_bytes())
            .await
            .unwrap();
        writer.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;

        // 3. Complete prompt with StopReason::EndTurn.
        let resp = serde_json::json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "stopReason": "end_turn"
            }
        });
        writer
            .write_all(format!("{resp}\n").as_bytes())
            .await
            .unwrap();
        writer.flush().await.unwrap();
    });

    let transport =
        acp::ByteStreams::new(client_to_agent.compat_write(), client_from_agent.compat());
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
    let runner_for_conn = runner.clone();
    let outcome = acp::Client
        .builder()
        .name("Dimo")
        .on_receive_notification(
            async move |notification: AgentNotification, _cx| {
                bridge.handle_agent_notification(notification).await
            },
            acp::on_receive_notification!(),
        )
        .connect_with(transport, |conn: ConnectionTo<Agent>| async move {
            let (_cmd_tx, mut cmd_rx) = mpsc::channel(4);
            let outcome = runner_for_conn
                .run_prompt(
                    &conn,
                    RunPromptRequest {
                        acp_session_id: "acp-agy-live".to_string(),
                        session_id,
                        prompt_id,
                        blocks: vec![AgentContentBlock::Text {
                            text: "hello".to_string(),
                        }],
                        display_blocks: None,
                        mode_override: None,
                        config_overrides: Vec::new(),
                    },
                    &mut cmd_rx,
                )
                .await
                .expect("run_prompt should succeed with Closed outcome");
            assert_eq!(outcome, RunPromptOutcome::Closed);
            Ok(())
        })
        .await;
    assert!(outcome.is_ok());
    agent_task.await.unwrap();

    assert!(
        !runner.session_map.read().await.contains_key(&session_id),
        "session_map must unbind session_id after agent_connection_lost"
    );
    assert!(
        !runner
            .session_controls
            .read()
            .await
            .contains_key(&session_id),
        "session_controls must remove session_id after agent_connection_lost"
    );
    assert!(
        runner.active_prompt.lock().await.is_none(),
        "active_prompt must be cleared"
    );

    let mut collected = Vec::new();
    while let Ok(ev) = event_rx.try_recv() {
        collected.push(ev.event);
    }
    let failed_status_pos = collected
        .iter()
        .position(|ev| {
            matches!(
                ev,
                AgentEvent::ConnectionStatusChanged { snapshot }
                    if snapshot.status == AgentConnectionStatus::Failed
            )
        })
        .expect("must emit ConnectionStatusChanged(Failed)");
    let error_pos = collected
        .iter()
        .position(|ev| {
            matches!(
                ev,
                AgentEvent::Error { error }
                    if error.code.as_deref() == Some("agent_connection_lost")
            )
        })
        .expect("must emit AgentEvent::Error(agent_connection_lost)");
    assert!(
        failed_status_pos < error_pos,
        "ConnectionStatusChanged(Failed) must be emitted before AgentEvent::Error"
    );
    assert!(
        !collected
            .iter()
            .any(|ev| matches!(ev, AgentEvent::PromptFinished { .. })),
        "PromptFinished must NOT be emitted when closing a lost connection"
    );
}

#[tokio::test]
async fn run_prompt_completes_cleanly_when_antigravity_emits_websocket_1000_ok_after_output() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let session_id = AgentSessionId::new();
    let prompt_id = AgentPromptId::new();
    let (event_tx, mut event_rx) = manager_event_channel();
    let runner = dummy_runner_for_agent("antigravity", event_tx.clone());
    runner
        .session_map
        .write()
        .await
        .insert(session_id, "acp-agy-1000".to_string());
    runner
        .session_controls
        .write()
        .await
        .insert(session_id, SessionControlState::default());
    *runner.active_prompt.lock().await = Some((session_id, prompt_id));

    let (client_to_agent, agent_from_client) = tokio::io::duplex(64 * 1024);
    let (agent_to_client, client_from_agent) = tokio::io::duplex(64 * 1024);

    let agent_task = tokio::spawn(async move {
        let mut reader = BufReader::new(agent_from_client);
        let mut writer = agent_to_client;
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let req: serde_json::Value = serde_json::from_str(&line).unwrap();
        let req_id = req["id"].clone();

        // 1. Stream visible output (e.g., background task launch notice).
        let partial_chunk = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "acp-agy-1000",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {
                        "type": "text",
                        "text": "task-20 has been launched in the background. I will wait for it to complete before proceeding."
                    }
                }
            }
        });
        writer
            .write_all(format!("{partial_chunk}\n").as_bytes())
            .await
            .unwrap();

        // 2. Stream Antigravity's WebSocket 1000 (OK) close chunk on turn suspension.
        let close_chunk = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "acp-agy-1000",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {
                        "type": "text",
                        "text": "Agent connection was lost and could not be re-established: Failed to rebuild agent: received 1000 (OK); then sent 1000 (OK)"
                    }
                }
            }
        });
        writer
            .write_all(format!("{close_chunk}\n").as_bytes())
            .await
            .unwrap();
        writer.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;

        // 3. Complete prompt with StopReason::EndTurn.
        let resp = serde_json::json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "stopReason": "end_turn"
            }
        });
        writer
            .write_all(format!("{resp}\n").as_bytes())
            .await
            .unwrap();
        writer.flush().await.unwrap();
    });

    let transport =
        acp::ByteStreams::new(client_to_agent.compat_write(), client_from_agent.compat());
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
    let runner_for_conn = runner.clone();
    let outcome = acp::Client
        .builder()
        .name("Dimo")
        .on_receive_notification(
            async move |notification: AgentNotification, _cx| {
                bridge.handle_agent_notification(notification).await
            },
            acp::on_receive_notification!(),
        )
        .connect_with(transport, |conn: ConnectionTo<Agent>| async move {
            let (_cmd_tx, mut cmd_rx) = mpsc::channel(4);
            let outcome = runner_for_conn
                .run_prompt(
                    &conn,
                    RunPromptRequest {
                        acp_session_id: "acp-agy-1000".to_string(),
                        session_id,
                        prompt_id,
                        blocks: vec![AgentContentBlock::Text {
                            text: "run tests".to_string(),
                        }],
                        display_blocks: None,
                        mode_override: None,
                        config_overrides: Vec::new(),
                    },
                    &mut cmd_rx,
                )
                .await
                .expect("run_prompt should settle cleanly");
            assert_eq!(outcome, RunPromptOutcome::Settled);
            Ok(())
        })
        .await;
    assert!(outcome.is_ok());
    agent_task.await.unwrap();

    let mut collected = Vec::new();
    while let Ok(ev) = event_rx.try_recv() {
        collected.push(ev.event);
    }
    assert!(
        !collected
            .iter()
            .any(|ev| matches!(ev, AgentEvent::Error { .. })),
        "graceful 1000 (OK) close after output must not emit AgentEvent::Error"
    );
    assert!(
        collected.iter().any(|ev| matches!(
            ev,
            AgentEvent::RawAcpDiagnostic { raw }
                if raw.get("type").and_then(|v| v.as_str()) == Some("graceful_adapter_turn_close")
        )),
        "must emit RawAcpDiagnostic(graceful_adapter_turn_close)"
    );
    assert!(
        collected
            .iter()
            .any(|ev| matches!(ev, AgentEvent::PromptFinished { .. })),
        "must emit PromptFinished so the turn completes normally"
    );
}

#[tokio::test]
async fn omp_session_controls_advertise_yolo_mode_and_toggle_effective_auto_approve() {
    let session_id = AgentSessionId::new();
    let raw_modes = SessionModeState::new(
        "default",
        vec![
            acp::schema::v1::SessionMode::new("default", "Default"),
            acp::schema::v1::SessionMode::new("plan", "Plan"),
        ],
    );
    let raw_options = vec![
        AcpSessionConfigOption::select(
            "mode",
            "Mode",
            "default",
            SessionConfigSelectOptions::Ungrouped(vec![
                SessionConfigSelectOption::new("default", "Default"),
                SessionConfigSelectOption::new("plan", "Plan"),
            ]),
        )
        .category(SessionConfigOptionCategory::Mode),
    ];

    let (modes, config_options, _) = session_controls_with_models_and_vendor_fallback(
        Some(raw_modes),
        Some(raw_options),
        None,
        None,
        "omp",
    );
    let modes = modes.expect("modes");
    let mode_ids: Vec<_> = modes
        .available_modes
        .iter()
        .map(|m| m.id.0.as_ref())
        .collect();
    assert_eq!(mode_ids, ["default", "plan", "yolo"]);

    let options = config_options.expect("config_options");
    let (derived_modes, current_mode) = session_modes_from_config_options(&options);
    let derived_ids: Vec<_> = derived_modes.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(derived_ids, ["default", "plan", "yolo"]);
    assert_eq!(current_mode.as_deref(), Some("default"));

    let session_controls = RwLock::new(HashMap::from([(
        session_id,
        SessionControlState {
            modes: Some(modes),
            config_options: options,
            omp_yolo_mode: false,
            ..Default::default()
        },
    )]));

    assert_eq!(
        effective_auto_approve_mode(AgentAutoApproveMode::Off, &session_controls, session_id).await,
        AgentAutoApproveMode::Off
    );

    session_controls
        .write()
        .await
        .get_mut(&session_id)
        .unwrap()
        .omp_yolo_mode = true;
    assert_eq!(
        effective_auto_approve_mode(AgentAutoApproveMode::Off, &session_controls, session_id).await,
        AgentAutoApproveMode::Yolo
    );

    session_controls
        .write()
        .await
        .get_mut(&session_id)
        .unwrap()
        .omp_yolo_mode = false;
    assert_eq!(
        effective_auto_approve_mode(AgentAutoApproveMode::Off, &session_controls, session_id).await,
        AgentAutoApproveMode::Off
    );
}

#[test]
fn incomplete_tool_call_formatting_and_turn_failure_suppression_work() {
    let tail = StderrTail::new();
    let mark = tail.mark();
    let raw_msg = "Internal error: Claude ended the turn without returning results for tool calls: tooluse_mygBCfuc2U8iANHpNMfmRK, tooluse_uGitQMhAOQezabRxhXRUqs, tooluse_Um59yWcVD5YOaWgUGIbzkH, tooluse_qKfD5DJrnLyIHn0z2Ve5g7, tooluse_uBuqsoJLwmtTQYSL36fnOc";
    let rpc_err = acp::Error::new(-32603, raw_msg).data(serde_json::json!({
        "errorKind": "incomplete_tool_call"
    }));

    let formatted = format_acp_prompt_error(&rpc_err, &tail, mark);
    assert_eq!(formatted.code.as_deref(), Some("incomplete_tool_call"));
    assert!(
        !formatted.message.contains("errorKind"),
        "must not dump raw JSON errorKind into user-facing message: {}",
        formatted.message
    );
    assert!(
        formatted.message.contains("5 tool calls:"),
        "must summarize large tool call id lists concisely: {}",
        formatted.message
    );

    let mut response_meta = serde_json::Map::new();
    response_meta.insert(
        "jetbrains.air".to_string(),
        serde_json::json!({
            "sessionFailure": {
                "kind": "internal_error",
                "title": raw_msg,
                "message": raw_msg
            }
        }),
    );
    let response = acp::schema::v1::PromptResponse::new(acp::schema::v1::StopReason::EndTurn)
        .meta(response_meta);

    // When the turn already rendered output (e.g. tool calls closed by closeUnfinished),
    // incomplete_tool_call must not fail the whole turn.
    let rendered_probe = TurnOutputProbe::default();
    rendered_probe.note_rendered();
    assert!(
        turn_failure_error_event(&response, &rendered_probe, &tail, mark).is_none(),
        "incomplete_tool_call after rendered output must not emit a fatal TurnFailed error"
    );

    // When the turn had zero output at all, it still surfaces turn_failed_empty.
    let empty_probe = TurnOutputProbe::default();
    let empty_err = turn_failure_error_event(&response, &empty_probe, &tail, mark)
        .expect("empty turn with incomplete_tool_call must surface turn_failed_empty");
    assert_eq!(empty_err.code.as_deref(), Some("turn_failed_empty"));
    assert!(empty_err.message.contains("5 tool calls:"));
}

#[tokio::test]
async fn run_prompt_settles_cleanly_on_incomplete_tool_call_error_after_output() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let session_id = AgentSessionId::new();
    let prompt_id = AgentPromptId::new();
    let (event_tx, mut event_rx) = manager_event_channel();
    let runner = dummy_runner_for_agent("claude_code", event_tx.clone());
    runner
        .session_map
        .write()
        .await
        .insert(session_id, "acp-claude-live".to_string());
    runner
        .session_controls
        .write()
        .await
        .insert(session_id, SessionControlState::default());
    *runner.active_prompt.lock().await = Some((session_id, prompt_id));

    let (client_to_agent, agent_from_client) = tokio::io::duplex(64 * 1024);
    let (agent_to_client, client_from_agent) = tokio::io::duplex(64 * 1024);

    let agent_task = tokio::spawn(async move {
        let mut reader = BufReader::new(agent_from_client);
        let mut writer = agent_to_client;
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let req: serde_json::Value = serde_json::from_str(&line).unwrap();
        let req_id = req["id"].clone();

        // 1. Stream a tool_call and its closeUnfinished(failed) update, plus assistant text.
        let tool_call = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "acp-claude-live",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tooluse_mygBCfuc2U8iANHpNMfmRK",
                    "title": "Read file",
                    "kind": "read",
                    "status": "in_progress"
                }
            }
        });
        writer
            .write_all(format!("{tool_call}\n").as_bytes())
            .await
            .unwrap();

        let tool_update = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "acp-claude-live",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tooluse_mygBCfuc2U8iANHpNMfmRK",
                    "status": "failed",
                    "content": [{
                        "type": "content",
                        "content": {
                            "type": "text",
                            "text": "Claude ended the turn without returning a result for this tool."
                        }
                    }]
                }
            }
        });
        writer
            .write_all(format!("{tool_update}\n").as_bytes())
            .await
            .unwrap();
        writer.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;

        // 2. Return -32603 incomplete_tool_call error from claude-agent-acp.
        let err_resp = serde_json::json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {
                "code": -32603,
                "message": "Internal error: Claude ended the turn without returning results for tool calls: tooluse_mygBCfuc2U8iANHpNMfmRK",
                "data": {
                    "errorKind": "incomplete_tool_call"
                }
            }
        });
        writer
            .write_all(format!("{err_resp}\n").as_bytes())
            .await
            .unwrap();
        writer.flush().await.unwrap();
    });

    let transport =
        acp::ByteStreams::new(client_to_agent.compat_write(), client_from_agent.compat());
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
    let runner_for_conn = runner.clone();
    let outcome = acp::Client
        .builder()
        .name("Dimo")
        .on_receive_notification(
            async move |notification: AgentNotification, _cx| {
                bridge.handle_agent_notification(notification).await
            },
            acp::on_receive_notification!(),
        )
        .connect_with(transport, |conn: ConnectionTo<Agent>| async move {
            let (_cmd_tx, mut cmd_rx) = mpsc::channel(4);
            let outcome = runner_for_conn
                .run_prompt(
                    &conn,
                    RunPromptRequest {
                        acp_session_id: "acp-claude-live".to_string(),
                        session_id,
                        prompt_id,
                        blocks: vec![AgentContentBlock::Text {
                            text: "check files".to_string(),
                        }],
                        display_blocks: None,
                        mode_override: None,
                        config_overrides: Vec::new(),
                    },
                    &mut cmd_rx,
                )
                .await
                .expect("run_prompt should settle cleanly");
            assert_eq!(outcome, RunPromptOutcome::Settled);
            Ok(())
        })
        .await;
    assert!(outcome.is_ok());
    agent_task.await.unwrap();

    let mut collected = Vec::new();
    while let Ok(ev) = event_rx.try_recv() {
        collected.push(ev.event);
    }
    assert!(
        !collected
            .iter()
            .any(|ev| matches!(ev, AgentEvent::Error { .. })),
        "must NOT emit AgentEvent::Error when incomplete_tool_call occurs after output; got {collected:?}"
    );
    assert!(
        collected
            .iter()
            .any(|ev| matches!(ev, AgentEvent::RawAcpDiagnostic { .. })),
        "must record RawAcpDiagnostic for observability"
    );
    assert!(
        collected
            .iter()
            .any(|ev| matches!(ev, AgentEvent::PromptFinished { .. })),
        "must emit PromptFinished so the turn settles cleanly"
    );
}

#[test]
fn build_native_engine_launch_env_omits_windows_batch_shims_for_claude_native() {
    let dir = tempfile::tempdir().expect("tempdir");
    let npm_dir = dir.path().join("npm");
    let bin_dir = dir.path().join("bin");
    std::fs::create_dir_all(&npm_dir).unwrap();
    std::fs::create_dir_all(&bin_dir).unwrap();

    let cmd_shim = npm_dir.join("claude.cmd");
    std::fs::write(&cmd_shim, b"@echo off\r\n").unwrap();

    let make_runner = |program: PathBuf| {
        let (event_tx, _event_rx) = manager_event_channel();
        AgentConnectionRunner::new(
            ManagedAgentConnectionSnapshot {
                connection_id: AgentConnectionId::new(),
                agent_id: AgentId::parse("claude_code").unwrap(),
                launch_lock: crate::SessionLaunchLock {
                    agent_id: AgentId::parse("claude_code").unwrap(),
                    absolute_acp_program: program,
                    args: Vec::new(),
                    env: BTreeMap::new(),
                    runtime_version: String::new(),
                    acp_version: String::new(),
                },
                workspace_id: uuid::Uuid::nil(),
                working_dir: dir.path().to_path_buf(),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::default(),
                env: HashMap::new(),
            },
            event_tx,
            None,
        )
    };

    // 1. Standalone `claude.cmd` without sibling `.exe` must NOT populate `CLAUDE_CODE_EXECUTABLE`
    //    (Node's `child_process.spawn` rejects `.cmd` without `shell: true` with `spawn EINVAL`).
    let (env_from_cmd, _) = make_runner(cmd_shim.clone())
        .build_native_engine_launch_env(&crate::engine::ClaudeNativeDriver::new())
        .expect("launch env");
    assert_ne!(
        env_from_cmd
            .get("CLAUDE_CODE_EXECUTABLE")
            .map(String::as_str),
        Some(cmd_shim.to_string_lossy().as_ref()),
        "Windows .cmd batch shim must never be injected into CLAUDE_CODE_EXECUTABLE"
    );

    // 2. When a sibling `claude.exe` exists next to `claude.cmd`, prefer the `.exe` directly.
    let sibling_exe = npm_dir.join("claude.exe");
    std::fs::write(&sibling_exe, b"MZ").unwrap();
    let (env_with_sibling, _) = make_runner(cmd_shim)
        .build_native_engine_launch_env(&crate::engine::ClaudeNativeDriver::new())
        .expect("launch env");
    if std::env::var_os("CLAUDE_CODE_EXECUTABLE").is_none()
        && std::env::var_os("DIMO_CLAUDE_PATH").is_none()
    {
        assert_eq!(
            env_with_sibling
                .get("CLAUDE_CODE_EXECUTABLE")
                .map(PathBuf::from),
            Some(workspace_utils::process::prefer_direct_spawn_executable(
                &sibling_exe
            ))
        );
    }

    // 3. Direct native binary (`claude.exe` / `claude`) still populates `CLAUDE_CODE_EXECUTABLE`.
    let standalone_bin = bin_dir.join(if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    });
    std::fs::write(&standalone_bin, b"MZ").unwrap();
    let (env_from_bin, _) = make_runner(standalone_bin.clone())
        .build_native_engine_launch_env(&crate::engine::ClaudeNativeDriver::new())
        .expect("launch env");
    if std::env::var_os("CLAUDE_CODE_EXECUTABLE").is_none()
        && std::env::var_os("DIMO_CLAUDE_PATH").is_none()
    {
        assert_eq!(
            env_from_bin
                .get("CLAUDE_CODE_EXECUTABLE")
                .map(PathBuf::from),
            Some(workspace_utils::process::prefer_direct_spawn_executable(
                &standalone_bin
            ))
        );
    }
}
