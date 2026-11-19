use super::*;

pub(super) fn dummy_runner(event_tx: ManagerEventSender) -> AgentConnectionRunner {
    AgentConnectionRunner::new(
        ManagedAgentConnectionSnapshot {
            connection_id: AgentConnectionId::new(),
            agent_id: AgentId::parse("antigravity").unwrap(),
            launch_lock: crate::SessionLaunchLock {
                agent_id: AgentId::parse("antigravity").unwrap(),
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
fn grok_catalog_refresh_keeps_this_session_current_model() {
    let mut options = vec![
        AcpSessionConfigOption::select(
            "model",
            "Model",
            "grok-4.7",
            vec![
                SessionConfigSelectOption::new("grok-4.6", "Grok 4.6"),
                SessionConfigSelectOption::new("grok-4.7", "Grok 4.7"),
            ],
        )
        .category(Some(SessionConfigOptionCategory::Model)),
    ];
    let catalog = parse_grok_model_catalog(&serde_json::json!({
        "currentModelId": "grok-4.6",
        "availableModels": [
            {"modelId": "grok-4.6", "name": "Grok 4.6"},
            {"modelId": "grok-4.7", "name": "Grok 4.7"},
            {"modelId": "grok-4.5", "name": "Grok 4.5"}
        ]
    }))
    .expect("catalog");
    assert!(apply_grok_catalog_to_stored_options(&mut options, &catalog));
    let SessionConfigKind::Select(select) = &options[0].kind else {
        panic!("model stays a select");
    };
    assert_eq!(select.current_value.0.as_ref(), "grok-4.7");
    assert_eq!(
        select_option_rows(&select.options),
        vec![
            ("grok-4.6".into(), "Grok 4.6".into()),
            ("grok-4.7".into(), "Grok 4.7".into()),
            ("grok-4.5".into(), "Grok 4.5".into()),
        ]
    );
    assert!(!apply_grok_catalog_to_stored_options(
        &mut options,
        &catalog
    ));
}

#[tokio::test]
async fn acp_tool_call_notifications_preserve_reported_status_and_output() {
    let session_id = AgentSessionId::new();
    let (event_tx, mut event_rx) = manager_event_channel();
    let bridge = AcpClientBridge::new(
        AgentConnectionId::new(),
        AgentId::parse("antigravity").unwrap(),
        event_tx,
        Arc::new(RwLock::new(HashMap::from([(
            session_id,
            "acp-test".into(),
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
        dummy_runner(manager_event_channel().0),
    );
    for status in ["in_progress", "completed", "failed"] {
        let notification: SessionNotification = serde_json::from_value(serde_json::json!({
            "sessionId": "acp-test",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "view-1",
                "title": "Running view_file",
                "kind": "read",
                "status": status,
                "rawInput": {"AbsolutePath": "C:/workspace/src/read.ts"},
                "rawOutput": "inspected content"
            }
        }))
        .unwrap();
        bridge.session_notification(notification).await.unwrap();
        let event = event_rx.try_recv().unwrap();
        let AgentEvent::ToolCall { tool_call } = event.event else {
            panic!("Expected a tool call");
        };
        let call = serde_json::to_value(tool_call).unwrap();
        assert_eq!(call["status"], status);
        assert_eq!(call["content"], "\"inspected content\"");
    }
}

#[test]
fn structured_acp_diff_becomes_a_file_edit_input_preview() {
    let diff = acp::schema::v1::Diff::new("src/App.tsx", "new line")
        .old_text(Some("old line".to_string()));
    let preview =
        acp_tool_input_preview(None, &[ToolCallContent::Diff(diff)], &[]).expect("diff preview");
    let value: serde_json::Value = serde_json::from_str(&preview).unwrap();

    assert_eq!(value["file_path"], "src/App.tsx");
    assert_eq!(value["oldText"], "old line");
    assert_eq!(value["newText"], "new line");
}

#[test]
fn structured_acp_location_becomes_a_file_read_input_preview() {
    let location = ToolCallLocation::new("src/lib.rs").line(Some(42));
    let preview = acp_tool_input_preview(None, &[], &[location]).expect("location preview");
    let value: serde_json::Value = serde_json::from_str(&preview).unwrap();

    assert_eq!(value["path"], "src/lib.rs");
    assert_eq!(value["line"], 42);
}

#[test]
fn acp_tool_image_content_becomes_a_semantic_agent_image() {
    let content = vec![ToolCallContent::Content(acp::schema::v1::Content::new(
        ContentBlock::Image(
            ImageContent::new("AAAA", "image/png").uri(Some("asset.png".to_string())),
        ),
    ))];

    let images = acp_tool_images(&content);

    assert_eq!(images.len(), 1);
    assert_eq!(images[0].data, "AAAA");
    assert_eq!(images[0].mime_type, "image/png");
    assert_eq!(images[0].uri.as_deref(), Some("asset.png"));
    assert_eq!(acp_tool_content_preview(&content), None);
}

pub(super) fn test_launch_lock(agent_id: AgentId) -> SessionLaunchLock {
    SessionLaunchLock {
        agent_id,
        absolute_acp_program: PathBuf::from("/tmp/dimo-test-acp"),
        args: Vec::new(),
        env: std::collections::BTreeMap::new(),
        runtime_version: "test-runtime".to_string(),
        acp_version: "test-acp".to_string(),
    }
}

#[test]
fn wire_mcp_offer_follows_negotiated_capabilities_not_agent_id() {
    let mut snapshot = AcpCapabilitySnapshot::default();
    assert_eq!(
        wire_mcp_offer(&snapshot),
        WireMcpOffer {
            stdio: false,
            http: false,
            sse: false,
        }
    );

    snapshot.mcp_stdio = true;
    snapshot.mcp_http = true;
    assert_eq!(
        wire_mcp_offer(&snapshot),
        WireMcpOffer {
            stdio: true,
            http: true,
            sse: false,
        }
    );
    assert!(snapshot.accepts_session_mcp_servers());
}

#[test]
fn v1_session_modes_become_mode_category_config_options() {
    let modes = SessionModeState::new(
        "ask",
        vec![
            agent_client_protocol::schema::v1::SessionMode::new("ask", "Ask"),
            agent_client_protocol::schema::v1::SessionMode::new("act", "Act"),
        ],
    );

    let (options, mode_uses_set_mode) =
        unify_session_config_options(Some(modes), Vec::new(), false);

    assert!(mode_uses_set_mode);
    assert_eq!(options.len(), 1);
    assert_eq!(options[0].id.0.as_ref(), "mode");
    assert_eq!(
        options[0].category.as_ref(),
        Some(&SessionConfigOptionCategory::Mode)
    );
    let (derived, current) = session_modes_from_config_options(&options);
    assert_eq!(current.as_deref(), Some("ask"));
    assert_eq!(
        derived
            .iter()
            .map(|mode| mode.id.as_str())
            .collect::<Vec<_>>(),
        vec!["ask", "act"]
    );
}

#[test]
fn native_mode_config_option_is_not_replaced_by_legacy_modes() {
    let modes = SessionModeState::new(
        "ask",
        vec![agent_client_protocol::schema::v1::SessionMode::new(
            "ask", "Ask",
        )],
    );
    let existing = vec![
        AcpSessionConfigOption::select(
            "mode",
            "Mode",
            "agent",
            vec![
                agent_client_protocol::schema::v1::SessionConfigSelectOption::new("agent", "Agent"),
            ],
        )
        .category(SessionConfigOptionCategory::Mode),
    ];

    let (options, mode_uses_set_mode) = unify_session_config_options(Some(modes), existing, false);
    assert!(!mode_uses_set_mode);
    assert_eq!(options[0].id.0.as_ref(), "mode");
    if let SessionConfigKind::Select(select) = &options[0].kind {
        assert_eq!(select.current_value.0.as_ref(), "agent");
    } else {
        panic!("expected select option");
    }
}

#[test]
fn audio_resource_and_resource_link_content_round_trip_without_flattening() {
    let fixtures = [
        serde_json::json!({
            "type": "audio",
            "data": "AAEC",
            "mimeType": "audio/wav",
            "_meta": {"trace": "audio"}
        }),
        serde_json::json!({
            "type": "resource",
            "resource": {
                "uri": "file:///notes.txt",
                "mimeType": "text/plain",
                "text": "hello"
            },
            "_meta": {"trace": "resource"}
        }),
        serde_json::json!({
            "type": "resource_link",
            "name": "notes",
            "uri": "file:///notes.txt",
            "title": "Notes",
            "description": "Project notes",
            "mimeType": "text/plain",
            "size": 5,
            "_meta": {"trace": "link"}
        }),
    ];

    for fixture in fixtures {
        let acp: ContentBlock = serde_json::from_value(fixture.clone()).unwrap();
        let normalized = acp_content_to_agent(acp);
        let round_tripped = agent_block_to_acp(normalized);
        assert_eq!(serde_json::to_value(round_tripped).unwrap(), fixture);
    }
}

#[test]
fn first_class_resource_blocks_are_sent_as_resource_links() {
    let encoded = serde_json::to_value(agent_block_to_acp(AgentContentBlock::Resource {
        uri: "file:///notes.md".to_string(),
        title: Some("notes.md".to_string()),
    }))
    .unwrap();
    assert_eq!(encoded["type"], "resource_link");
    assert_eq!(encoded["uri"], "file:///notes.md");
    assert_eq!(encoded["name"], "notes.md");
    assert_eq!(encoded["title"], "notes.md");
}

#[test]
fn oversized_content_meta_is_dropped_but_payload_is_preserved() {
    let acp: ContentBlock = serde_json::from_value(serde_json::json!({
        "type": "audio",
        "data": "AAEC",
        "mimeType": "audio/wav",
        "_meta": {"large": "x".repeat(17 * 1024)}
    }))
    .unwrap();

    let normalized = acp_content_to_agent(acp);
    let encoded = serde_json::to_value(agent_block_to_acp(normalized)).unwrap();

    assert_eq!(encoded["data"], "AAEC");
    assert!(encoded.get("_meta").is_none());
}

#[test]
fn usage_keeps_cumulative_cost_and_currency() {
    let usage = agent_usage_from_acp(
        agent_client_protocol::schema::v1::UsageUpdate::new(53_000, 200_000)
            .cost(agent_client_protocol::schema::v1::Cost::new(0.045, "USD")),
    );

    assert_eq!(usage.used, 53_000);
    assert_eq!(usage.limit, Some(200_000));
    assert_eq!(usage.cost_amount, Some(0.045));
    assert_eq!(usage.cost_currency.as_deref(), Some("USD"));
}

#[test]
fn session_info_update_preserves_partial_fields_and_bounded_meta() {
    let update: agent_client_protocol::schema::v1::SessionInfoUpdate =
        serde_json::from_value(serde_json::json!({
            "title": "Renamed",
            "_meta": {"source": "fixture"}
        }))
        .unwrap();
    assert_eq!(
        session_info_patch_from_acp(update),
        serde_json::json!({
            "title": "Renamed",
            "_meta": {"source": "fixture"}
        })
    );
}

#[test]
fn session_establishment_meta_exposes_generated_titles() {
    let grok = serde_json::json!({
        "generated_title": "Fix usage",
        "availableModels": []
    });
    assert_eq!(
        acp_meta_session_title(grok.as_object()).as_deref(),
        Some("Fix usage")
    );
    let claude = serde_json::json!({ "sessionTitle": "Review the diff" });
    assert_eq!(
        acp_meta_session_title(claude.as_object()).as_deref(),
        Some("Review the diff")
    );
    let windows_only = serde_json::json!({ "availableModels": [] });
    assert_eq!(acp_meta_session_title(windows_only.as_object()), None);
    let codex = serde_json::json!({ "title": "Tighten session naming" });
    assert_eq!(
        acp_meta_session_title(codex.as_object()).as_deref(),
        Some("Tighten session naming")
    );
    let claude_custom = serde_json::json!({ "customTitle": "Notes probe" });
    assert_eq!(
        acp_meta_session_title(claude_custom.as_object()).as_deref(),
        Some("Notes probe")
    );
}

#[test]
fn model_selection_precedes_dependent_session_options_for_every_agent() {
    let options = vec![
        AcpSessionConfigOption::select(
            "runtime-model",
            "Runtime model",
            "registry/example",
            vec![SessionConfigSelectOption::new(
                "registry/example",
                "Registry Example",
            )],
        )
        .category(Some(SessionConfigOptionCategory::Model)),
    ];
    let overrides = vec![
        AgentSessionConfigOverride {
            key: "effort".to_string(),
            value: "high".to_string(),
        },
        AgentSessionConfigOverride {
            key: "permission".to_string(),
            value: "ask".to_string(),
        },
        AgentSessionConfigOverride {
            key: "model".to_string(),
            value: "opencode/example".to_string(),
        },
    ];

    let ordered = ordered_session_config_overrides(&options, overrides);
    assert_eq!(
        ordered
            .iter()
            .map(|override_item| override_item.key.as_str())
            .collect::<Vec<_>>(),
        ["model", "effort", "permission"]
    );
}

#[test]
fn overrides_without_a_model_keep_their_caller_order() {
    let overrides = vec![
        AgentSessionConfigOverride {
            key: "effort".to_string(),
            value: "high".to_string(),
        },
        AgentSessionConfigOverride {
            key: "permission".to_string(),
            value: "ask".to_string(),
        },
    ];

    let ordered = ordered_session_config_overrides(&[], overrides);
    assert_eq!(
        ordered
            .iter()
            .map(|override_item| override_item.key.as_str())
            .collect::<Vec<_>>(),
        ["effort", "permission"]
    );
}

#[test]
fn dedup_stream_text_drops_trailing_full_snapshot() {
    let mut state = StreamDedupState::default();
    // Streaming deltas are emitted verbatim.
    assert!(dedup_stream_text(&mut state, StreamKind::Message, "Here "));
    assert!(dedup_stream_text(
        &mut state,
        StreamKind::Message,
        "is the repo"
    ));
    // codex-acp replays the full message as one final chunk → dropped.
    assert!(!dedup_stream_text(
        &mut state,
        StreamKind::Message,
        "Here is the repo"
    ));
    // A genuinely new message after the snapshot streams normally again.
    assert!(dedup_stream_text(
        &mut state,
        StreamKind::Message,
        "Next answer"
    ));
}

#[test]
fn dedup_stream_text_keeps_distinct_runs_separate() {
    let mut state = StreamDedupState::default();
    assert!(dedup_stream_text(&mut state, StreamKind::Thought, "think "));
    assert!(dedup_stream_text(&mut state, StreamKind::Thought, "hard"));
    // Thought snapshot dropped.
    assert!(!dedup_stream_text(
        &mut state,
        StreamKind::Thought,
        "think hard"
    ));
    // Switching streams starts a fresh accumulator, so identical text on the
    // message channel is NOT mistaken for the thought's duplicate.
    assert!(dedup_stream_text(
        &mut state,
        StreamKind::Message,
        "think hard"
    ));
    // Genuine repetition within a streaming run (each delta != full run so
    // far) is preserved — only an exact full-run snapshot is dropped.
    assert!(dedup_stream_text(&mut state, StreamKind::Message, " think"));
}

#[test]
fn dedup_stream_text_preserves_repeated_single_chunk_content() {
    let mut state = StreamDedupState::default();

    assert!(dedup_stream_text(&mut state, StreamKind::Message, "字"));
    assert!(dedup_stream_text(&mut state, StreamKind::Message, "字"));

    let mut newlines = StreamDedupState::default();
    assert!(dedup_stream_text(&mut newlines, StreamKind::Message, "\n"));
    assert!(dedup_stream_text(&mut newlines, StreamKind::Message, "\n"));
}

#[tokio::test]
async fn live_manager_refuses_non_absolute_installation_locks() {
    for agent_id in ["codex", "claude_code", "opencode"] {
        let agent_id = AgentId::parse(agent_id).unwrap();
        let mut launch_lock = test_launch_lock(agent_id.clone());
        launch_lock.absolute_acp_program = PathBuf::from("relative-acp");
        let (event_tx, _event_rx) = manager_event_channel();
        let manager = AgentConnectionManager::new_with_driver(event_tx, true);
        let (_snapshot, ready_rx) = manager
            .register_connection(AgentConnectionLaunch {
                connection_id: AgentConnectionId::new(),
                agent_id: agent_id.clone(),
                launch_lock,
                workspace_id: uuid::Uuid::new_v4(),
                working_dir: std::env::temp_dir(),
                additional_directories: Vec::new(),
                auto_approve_mode: AgentAutoApproveMode::Off,
                env: HashMap::new(),
            })
            .await;
        let result = tokio::time::timeout(Duration::from_secs(1), ready_rx)
            .await
            .expect("runtime guard should fail before a process can start")
            .expect("driver should report its startup error");
        let error = result.expect_err("local runtime override must be required");
        assert!(
            error.to_string().contains("absolute ACP program"),
            "{agent_id} unexpectedly accepted a relative ACP path: {error}"
        );
    }
}

#[tokio::test]
async fn live_manager_refuses_a_missing_working_directory() {
    let program = std::env::current_exe().expect("test binary path");
    let mut launch_lock = test_launch_lock(AgentId::parse("grok").unwrap());
    launch_lock.absolute_acp_program = program;
    let (event_tx, _event_rx) = manager_event_channel();
    let manager = AgentConnectionManager::new_with_driver(event_tx, true);
    let (_snapshot, ready_rx) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id: AgentConnectionId::new(),
            agent_id: AgentId::parse("grok").unwrap(),
            launch_lock,
            workspace_id: uuid::Uuid::new_v4(),
            working_dir: PathBuf::from("Dimo"),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;
    let result = tokio::time::timeout(Duration::from_secs(1), ready_rx)
        .await
        .expect("runtime guard should fail before a process can start")
        .expect("driver should report its startup error");
    let error = result.expect_err("a relative missing cwd must not spawn");
    let message = error.to_string();
    assert!(
        message.contains("workspace working directory is missing"),
        "{message}"
    );
    assert!(message.contains("Dimo"), "{message}");
    assert!(!message.contains("No such file or directory"), "{message}");
}

#[tokio::test]
async fn manager_registers_and_removes_connection() {
    let (event_tx, _event_rx) = manager_event_channel();
    let manager = AgentConnectionManager::new_with_driver(event_tx, false);
    let connection_id = AgentConnectionId::new();

    manager
        .register_connection(AgentConnectionLaunch {
            connection_id,
            agent_id: AgentId::parse("codex").unwrap(),
            launch_lock: test_launch_lock(AgentId::parse("codex").unwrap()),
            workspace_id: uuid::Uuid::new_v4(),
            working_dir: PathBuf::from("C:/work"),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;

    assert_eq!(manager.list_connections().await.len(), 1);
    manager.disconnect(connection_id).await.unwrap();
    assert!(manager.list_connections().await.is_empty());
}

#[tokio::test]
async fn manager_rejects_unknown_prompt_connection() {
    let (event_tx, _event_rx) = manager_event_channel();
    let err = AgentConnectionManager::new_with_driver(event_tx, false)
        .send_prompt(
            AgentConnectionId::new(),
            AgentSessionId::new(),
            AgentPromptId::new(),
            vec![AgentContentBlock::Text {
                text: "hello".to_string(),
            }],
            None,
            Vec::new(),
        )
        .await
        .unwrap_err();

    assert!(matches!(err, AgentError::ConnectionNotFound(_)));
}

#[tokio::test]
async fn no_response_regressions_command_channel_close_returns_runtime_error() {
    let (event_tx, _event_rx) = manager_event_channel();
    let manager = AgentConnectionManager::new_with_driver(event_tx, false);
    let connection_id = AgentConnectionId::new();
    let (_snapshot, ready_rx) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id,
            agent_id: AgentId::parse("codex").unwrap(),
            launch_lock: test_launch_lock(AgentId::parse("codex").unwrap()),
            workspace_id: uuid::Uuid::new_v4(),
            working_dir: PathBuf::from("C:/work"),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;
    ready_rx.await.unwrap().unwrap();
    let session_id = AgentSessionId::new();
    manager
        .bind_known_acp_session(connection_id, session_id, "acp-session".into())
        .await;
    let (closed_tx, closed_rx) = mpsc::channel(1);
    drop(closed_rx);
    manager
        .connections
        .lock()
        .await
        .get_mut(&connection_id)
        .unwrap()
        .cmd_tx = closed_tx;

    let err = manager
        .send_prompt(
            connection_id,
            session_id,
            AgentPromptId::new(),
            vec![AgentContentBlock::Text {
                text: "hello".to_string(),
            }],
            None,
            Vec::new(),
        )
        .await
        .unwrap_err();

    assert!(
        err.to_string()
            .contains("agent connection command channel closed")
    );
}

#[tokio::test]
async fn manager_in_memory_resumes_session_with_external_id() {
    let (event_tx, _event_rx) = manager_event_channel();
    let manager = AgentConnectionManager::new_with_driver(event_tx, false);
    let connection_id = AgentConnectionId::new();
    let session_id = AgentSessionId::new();

    manager
        .register_connection(AgentConnectionLaunch {
            connection_id,
            agent_id: AgentId::parse("codex").unwrap(),
            launch_lock: test_launch_lock(AgentId::parse("codex").unwrap()),
            workspace_id: uuid::Uuid::new_v4(),
            working_dir: PathBuf::from("C:/work"),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;

    let (acp_session_id, controls, _strategy) = manager
        .resume_session(
            connection_id,
            session_id,
            "external-session",
            Default::default(),
        )
        .await
        .unwrap();

    assert_eq!(acp_session_id, "external-session");
    assert_eq!(controls, AgentSessionControlsSnapshot::default());
}

#[test]
fn maps_acp_session_modes_to_agent_payload() {
    let state = SessionModeState::new(
        "ask",
        vec![
            agent_client_protocol::schema::v1::SessionMode::new("ask", "Ask")
                .description(Some("Confirm before editing".to_string())),
            agent_client_protocol::schema::v1::SessionMode::new("act", "Act"),
        ],
    );

    let (modes, current) = agent_session_modes_from_acp(state);

    assert_eq!(current.as_deref(), Some("ask"));
    assert_eq!(modes.len(), 2);
    assert_eq!(modes[0].id, "ask");
    assert_eq!(modes[0].label, "Ask");
    assert_eq!(
        modes[0].description.as_deref(),
        Some("Confirm before editing")
    );
}

#[tokio::test]
async fn session_auto_mode_does_not_upgrade_permission_interception() {
    let session_id = AgentSessionId::new();
    let controls = RwLock::new(HashMap::from([(
        session_id,
        SessionControlState {
            config_options: Vec::new(),
            vendor_config: None,
            mode_uses_set_mode: false,
            available_commands: None,
            ..Default::default()
        },
    )]));

    // Claude Code's Auto mode delegates each request to its own model
    // classifier. It must not become Dimo's blanket auto-approval mode.
    assert_eq!(
        effective_auto_approve_mode(AgentAutoApproveMode::Off, &controls, session_id).await,
        AgentAutoApproveMode::Off
    );
    // An explicit agent-level setting always wins over the session mode.
    assert_eq!(
        effective_auto_approve_mode(AgentAutoApproveMode::Yolo, &controls, session_id).await,
        AgentAutoApproveMode::Yolo
    );
    // Sessions without a tracked auto mode keep interception on.
    assert_eq!(
        effective_auto_approve_mode(AgentAutoApproveMode::Off, &controls, AgentSessionId::new())
            .await,
        AgentAutoApproveMode::Off
    );
}

#[tokio::test]
async fn manager_event_channel_does_not_drop_a_burst_of_terminal_events() {
    let (event_tx, mut event_rx) = manager_event_channel();
    let manager = AgentConnectionManager::new_with_driver(event_tx.clone(), false);
    let _ = manager;
    let connection_id = AgentConnectionId::new();
    let prompt_id = AgentPromptId::new();
    for index in 0..64 {
        send_manager_event(
            &event_tx,
            AgentConnectionManagerEvent {
                connection_id,
                session_id: None,
                prompt_id: None,
                event: AgentEvent::Error {
                    error: AgentErrorEvent {
                        message: format!("fill-{index}"),
                        code: None,
                        raw: None,
                    },
                },
            },
        );
    }
    send_manager_event(
        &event_tx,
        AgentConnectionManagerEvent {
            connection_id,
            session_id: None,
            prompt_id: Some(prompt_id),
            event: AgentEvent::PromptFinished {
                finished: AgentPromptFinished {
                    prompt_id,
                    stop_reason: Some("end_turn".into()),
                    usage: None,
                },
            },
        },
    );
    for _ in 0..64 {
        event_rx.recv().await.expect("burst event");
    }
    let terminal = event_rx
        .recv()
        .await
        .expect("PromptFinished must not be dropped");
    assert!(matches!(
        terminal.event,
        AgentEvent::PromptFinished { finished } if finished.prompt_id == prompt_id
    ));
}

#[tokio::test]
async fn manager_event_channel_sheds_high_volume_deltas_and_keeps_prompt_finished() {
    let (event_tx, mut event_rx) = manager_event_channel();
    let connection_id = AgentConnectionId::new();
    let prompt_id = AgentPromptId::new();
    for index in 0..(MANAGER_EVENT_SOFT_CAP + 500) {
        send_manager_event(
            &event_tx,
            AgentConnectionManagerEvent {
                connection_id,
                session_id: None,
                prompt_id: Some(prompt_id),
                event: AgentEvent::MessageChunk {
                    content: AgentContentBlock::Text {
                        text: format!("delta-{index}"),
                    },
                },
            },
        );
    }
    send_manager_event(
        &event_tx,
        AgentConnectionManagerEvent {
            connection_id,
            session_id: None,
            prompt_id: Some(prompt_id),
            event: AgentEvent::PromptFinished {
                finished: AgentPromptFinished {
                    prompt_id,
                    stop_reason: Some("end_turn".into()),
                    usage: None,
                },
            },
        },
    );

    let mut chunks = 0usize;
    let mut finished = false;
    while let Ok(event) = event_rx.try_recv() {
        match event.event {
            AgentEvent::MessageChunk { .. } => chunks += 1,
            AgentEvent::PromptFinished { finished: prompt } if prompt.prompt_id == prompt_id => {
                finished = true;
                break;
            }
            other => panic!("unexpected manager event: {other:?}"),
        }
    }
    assert!(finished, "PromptFinished must survive a delta flood");
    assert_eq!(chunks, MANAGER_EVENT_SOFT_CAP);
}

#[test]
fn maps_acp_session_config_options_to_agent_payload() {
    let options = vec![
        AcpSessionConfigOption::select(
            "model",
            "Model",
            "gpt-5",
            vec![
                agent_client_protocol::schema::v1::SessionConfigSelectOption::new("gpt-5", "GPT-5")
                    .description(Some("Balanced".to_string())),
                agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                    "gpt-5-codex",
                    "GPT-5 Codex",
                ),
            ],
        )
        .description(Some("Choose a model".to_string())),
        AcpSessionConfigOption::select(
            "reasoning",
            "Reasoning",
            "high",
            vec![
                agent_client_protocol::schema::v1::SessionConfigSelectGroup::new(
                    "effort",
                    "Effort",
                    vec![
                        agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                            "high", "High",
                        ),
                    ],
                ),
            ],
        ),
    ];

    let mapped = agent_session_config_options_from_acp(options);

    assert_eq!(mapped[0].key, "model");
    assert_eq!(mapped[0].label, "Model");
    assert_eq!(mapped[0].description.as_deref(), Some("Choose a model"));
    assert_eq!(
        mapped[0].value.as_ref(),
        Some(&serde_json::Value::String("gpt-5".to_string()))
    );
    assert_eq!(mapped[0].choices.len(), 2);
    assert_eq!(mapped[0].choices[0].label, "GPT-5");
    assert_eq!(
        mapped[0].choices[0].description.as_deref(),
        Some("Balanced")
    );
    assert_eq!(mapped[1].choices[0].value, serde_json::json!("high"));
}

#[test]
fn grok_set_model_wire_uses_camel_case_session_id() {
    // Grok's ACP 0.10 decoder deserializes `session/set_model` as
    // `{sessionId, modelId}`. Snake_case params fail with
    // `Invalid params: missing field sessionId` and take the prompt
    // path down with "ACP connection failed".
    let request = SetSessionModelRequest::new(
        SessionId::new("0193c0de-5e55-7e55-9e55-000000000001"),
        "grok-4.20".to_string(),
    );
    let value = serde_json::to_value(&request).expect("serialize set_model");
    assert_eq!(
        value,
        serde_json::json!({
            "sessionId": "0193c0de-5e55-7e55-9e55-000000000001",
            "modelId": "grok-4.20",
        })
    );
    assert!(value.get("session_id").is_none());
    assert!(value.get("model_id").is_none());
}

#[test]
fn acp_fork_wire_uses_camel_case_session_id() {
    let request = AcpForkSessionRequest {
        session_id: "sess-1".to_string(),
        cwd: PathBuf::from("/workspace"),
        meta: None,
    };
    let value = serde_json::to_value(&request).expect("serialize fork");
    assert_eq!(value["sessionId"], "sess-1");
    assert_eq!(value["cwd"], "/workspace");
    assert!(value.get("session_id").is_none());
}

#[test]
fn acp_steer_wire_uses_camel_case_session_id() {
    let request = AcpSteerRequest {
        session_id: "sess-1".to_string(),
        prompt: Vec::new(),
        meta: serde_json::json!({ "steering": { "idleBehavior": "promptRequired" } }),
    };
    let value = serde_json::to_value(&request).expect("serialize steer");
    assert_eq!(value["sessionId"], "sess-1");
    assert_eq!(value["_meta"]["steering"]["idleBehavior"], "promptRequired");
    assert!(value.get("session_id").is_none());
    assert!(value.get("meta").is_none());
}

#[test]
fn grok_vendor_meta_session_config_becomes_standard_controls() {
    // Grok 1.0.5 advertises session config via `_meta["x.ai/sessionConfig"]`
    // instead of the standard `modes`/`configOptions` fields (verified
    // against `grok agent stdio` 2026-08). Without this adapter the
    // create-session summary stays empty.
    let meta = serde_json::json!({
        "x.ai/sessionConfig": {
            "options": [
                { "id": "grok-4.6", "category": "model", "label": "Grok 4.6", "selected": true },
                { "id": "grok-4.5", "category": "model", "label": "Grok 4.5", "selected": false },
                { "id": "xhigh", "category": "mode", "label": "Extra High Effort", "description": "Highest effort", "selected": false },
                { "id": "high", "category": "mode", "label": "High Effort", "description": "Higher implementation quality", "selected": true },
                { "id": "medium", "category": "mode", "label": "Medium Effort", "selected": false },
                { "id": "low", "category": "mode", "label": "Low Effort", "description": "Quick, fast implementations", "selected": false }
            ]
        }
    });

    let vendor = vendor_session_controls_from_meta(meta.as_object().unwrap())
        .expect("vendor session config parses");

    assert!(vendor.modes.is_none(), "effort is not a permission mode");
    assert_eq!(vendor.config_options.len(), 2);
    let model = &vendor.config_options[0];
    assert_eq!(model.id.0.as_ref(), "model");
    assert_eq!(model.name, "Model");
    assert_eq!(
        model.category.as_ref(),
        Some(&SessionConfigOptionCategory::Model)
    );
    let SessionConfigKind::Select(select) = &model.kind else {
        panic!("model option must be a select");
    };
    assert_eq!(select.current_value.0.as_ref(), "grok-4.6");
    assert_eq!(
        current_grok_model_id(&vendor.config_options).as_deref(),
        Some("grok-4.6")
    );
    let SessionConfigSelectOptions::Ungrouped(model_choices) = &select.options else {
        panic!("model options must be ungrouped");
    };
    assert_eq!(model_choices.len(), 2);
    assert_eq!(model_choices[0].value.0.as_ref(), "grok-4.6");
    assert_eq!(model_choices[0].name, "Grok 4.6");
    assert_eq!(model_choices[1].value.0.as_ref(), "grok-4.5");
    assert!(
        model_choices
            .iter()
            .all(|choice| choice.value.0.as_ref() != "low"),
        "Low Effort must not leak into the Model selector"
    );

    let effort = &vendor.config_options[1];
    assert_eq!(effort.id.0.as_ref(), "effort");
    assert_eq!(
        effort.category.as_ref(),
        Some(&SessionConfigOptionCategory::ThoughtLevel)
    );
    let SessionConfigKind::Select(select) = &effort.kind else {
        panic!("effort option must be a select");
    };
    assert_eq!(select.current_value.0.as_ref(), "high");
    let SessionConfigSelectOptions::Ungrouped(effort_choices) = &select.options else {
        panic!("effort options must be ungrouped");
    };
    assert_eq!(effort_choices.len(), 4);
    assert_eq!(effort_choices[0].value.0.as_ref(), "xhigh");
    assert_eq!(
        effort_choices[0].description.as_deref(),
        Some("Highest effort")
    );
    assert_eq!(effort_choices[3].value.0.as_ref(), "low");
    assert_eq!(effort_choices[3].name, "Low Effort");
}

#[test]
fn vendor_option_fields_are_classified_independently() {
    assert_eq!(
        classify_vendor_session_option(Some("model"), "grok-4.6", "Grok 4.6"),
        VendorSessionOptionKind::Model
    );
    assert_eq!(
        classify_vendor_session_option(Some("mode"), "high", "High Effort"),
        VendorSessionOptionKind::Effort
    );
    assert_eq!(
        classify_vendor_session_option(Some("mode"), "low", "Low Effort"),
        VendorSessionOptionKind::Effort
    );
    assert_eq!(
        classify_vendor_session_option(Some("mode"), "ls", "List"),
        VendorSessionOptionKind::Effort
    );
    assert_eq!(
        classify_vendor_session_option(None, "max", "Max"),
        VendorSessionOptionKind::Effort
    );
    assert_eq!(
        classify_vendor_session_option(None, "ultra", "Ultra"),
        VendorSessionOptionKind::Effort
    );
    assert_eq!(
        classify_vendor_session_option(Some("permission"), "default", "Ask"),
        VendorSessionOptionKind::Permission
    );
}

#[test]
fn vendor_fallback_keeps_standard_model_and_adds_effort() {
    let meta = serde_json::json!({
        "x.ai/sessionConfig": {
            "options": [
                { "id": "grok-4.6", "category": "model", "label": "Grok 4.6", "selected": true },
                { "id": "high", "category": "mode", "label": "High Effort", "selected": true }
            ]
        }
    });
    let standard_options = Some(vec![AcpSessionConfigOption::select(
        "model",
        "Model",
        "sonnet",
        vec![agent_client_protocol::schema::v1::SessionConfigSelectOption::new("sonnet", "Sonnet")],
    )]);

    let (_, config_options, vendor) =
        session_controls_with_vendor_fallback(None, standard_options, meta.as_object());

    assert_eq!(vendor, Some(VendorConfigWire::XaiSessionConfig));
    let options = config_options.expect("merged config");
    assert_eq!(options[0].id.0.as_ref(), "model");
    assert_eq!(options.len(), 2);
    assert_eq!(options[1].id.0.as_ref(), "effort");
    assert_eq!(
        options[1].category.as_ref(),
        Some(&SessionConfigOptionCategory::ThoughtLevel)
    );
}

#[test]
fn vendor_fallback_does_not_duplicate_standard_thought_level() {
    let meta = serde_json::json!({
        "x.ai/sessionConfig": {
            "options": [
                { "id": "grok-4.6", "category": "model", "label": "Grok 4.6", "selected": true },
                { "id": "high", "category": "mode", "label": "High Effort", "selected": true }
            ]
        }
    });
    let standard_options = Some(vec![
        AcpSessionConfigOption::select(
            "model",
            "Model",
            "grok-4.6",
            vec![SessionConfigSelectOption::new("grok-4.6", "Grok 4.6")],
        )
        .category(Some(SessionConfigOptionCategory::Model)),
        AcpSessionConfigOption::select(
            "reasoning_effort",
            "Reasoning Effort",
            "high",
            vec![
                SessionConfigSelectOption::new("high", "High"),
                SessionConfigSelectOption::new("medium", "Medium"),
            ],
        )
        .category(Some(SessionConfigOptionCategory::ThoughtLevel)),
    ]);

    let (_, config_options, _) =
        session_controls_with_vendor_fallback(None, standard_options, meta.as_object());

    let options = config_options.expect("merged config");
    let thought_levels: Vec<_> = options
        .iter()
        .filter(|option| {
            option.category.as_ref() == Some(&SessionConfigOptionCategory::ThoughtLevel)
                || option.id.0.as_ref() == "effort"
                || option.id.0.as_ref() == "reasoning_effort"
        })
        .map(|option| option.id.0.to_string())
        .collect();
    assert_eq!(
        thought_levels,
        vec!["reasoning_effort"],
        "vendor 推理强度 must not sit beside the standard Reasoning Effort option"
    );
    assert_eq!(options.len(), 2);
}

#[tokio::test]
async fn native_stream_assistant_message_dedup_and_tool_boundary_handling() {
    use crate::{
        engine::{ClaudeNativeDriver, EngineEvent, EngineHandle, NativeEngineDriver},
        manager::runner::native_events::NativeTurnState,
    };

    let collect_emitted_text = |rx: &mut ManagerEventReceiver| -> Vec<String> {
        let mut chunks = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let AgentEvent::MessageChunk {
                content: AgentContentBlock::Text { text },
            } = ev.event
            {
                chunks.push(text);
            }
        }
        chunks
    };

    let driver: Arc<dyn NativeEngineDriver> = Arc::new(ClaudeNativeDriver::new());
    let handle = EngineHandle::for_engine(
        uuid::Uuid::new_v4(),
        "claude-native",
        uuid::Uuid::nil(),
        PathBuf::from("C:/workspace"),
        true,
        None,
    );
    let session_id = AgentSessionId::new();
    let prompt_id = AgentPromptId::new();

    // 1. Matching message_id suppresses AssistantMessage replay.
    {
        let (tx, mut rx) = manager_event_channel();
        let runner = dummy_runner(tx);
        let mut char_acc = 0usize;
        let mut state = NativeTurnState::default();
        for ev in [
            EngineEvent::AssistantTextDelta {
                prompt_id: Some(prompt_id.0.to_string()),
                session_id: None,
                message_id: Some("msg_1".into()),
                text: "Hello ".into(),
            },
            EngineEvent::AssistantTextDelta {
                prompt_id: Some(prompt_id.0.to_string()),
                session_id: None,
                message_id: Some("msg_1".into()),
                text: "world!".into(),
            },
            EngineEvent::AssistantMessage {
                prompt_id: Some(prompt_id.0.to_string()),
                session_id: None,
                message_id: Some("msg_1".into()),
                text: "Hello world!".into(),
            },
        ] {
            runner
                .handle_native_stream_event(
                    &driver,
                    &handle,
                    false,
                    None,
                    session_id,
                    prompt_id,
                    ev,
                    &mut char_acc,
                    &mut state,
                )
                .await;
        }
        assert_eq!(collect_emitted_text(&mut rx).concat(), "Hello world!");
    }

    // 2. Mismatched message_ids (proxy rewrite) still suppress exact replay and emit only unstreamed suffix.
    {
        let (tx, mut rx) = manager_event_channel();
        let runner = dummy_runner(tx);
        let mut char_acc = 0usize;
        let mut state = NativeTurnState::default();
        for ev in [
            EngineEvent::AssistantTextDelta {
                prompt_id: Some(prompt_id.0.to_string()),
                session_id: None,
                message_id: Some("proxy-delta-id".into()),
                text: "Part A ".into(),
            },
            EngineEvent::AssistantMessage {
                prompt_id: Some(prompt_id.0.to_string()),
                session_id: None,
                message_id: Some("proxy-asst-uuid".into()),
                text: "Part A ".into(),
            },
            EngineEvent::AssistantMessage {
                prompt_id: Some(prompt_id.0.to_string()),
                session_id: None,
                message_id: Some("proxy-asst-uuid-2".into()),
                text: "Part A Part B".into(),
            },
        ] {
            runner
                .handle_native_stream_event(
                    &driver,
                    &handle,
                    true,
                    None,
                    session_id,
                    prompt_id,
                    ev,
                    &mut char_acc,
                    &mut state,
                )
                .await;
        }
        assert_eq!(
            collect_emitted_text(&mut rx),
            vec!["Part A ".to_string(), "Part B".to_string()]
        );
    }

    // 3. Tool call / result boundary resets buffer so post-tool text emits once cleanly.
    {
        let (tx, mut rx) = manager_event_channel();
        let runner = dummy_runner(tx);
        let mut char_acc = 0usize;
        let mut state = NativeTurnState::default();
        for ev in [
            EngineEvent::AssistantTextDelta {
                prompt_id: Some(prompt_id.0.to_string()),
                session_id: None,
                message_id: Some("m-pre".into()),
                text: "Checking file...".into(),
            },
            EngineEvent::AssistantMessage {
                prompt_id: Some(prompt_id.0.to_string()),
                session_id: None,
                message_id: Some("m-pre".into()),
                text: "Checking file...".into(),
            },
            EngineEvent::ToolCall {
                prompt_id: Some(prompt_id.0.to_string()),
                session_id: None,
                parent_tool_use_id: None,
                tool_use_id: Some("tu-1".into()),
                tool_name: "Read".into(),
                input: serde_json::json!({ "file_path": "x.rs" }),
            },
            EngineEvent::ToolResult {
                prompt_id: Some(prompt_id.0.to_string()),
                session_id: None,
                parent_tool_use_id: None,
                tool_use_id: Some("tu-1".into()),
                is_error: false,
                content: serde_json::json!("ok"),
            },
            EngineEvent::AssistantTextDelta {
                prompt_id: Some(prompt_id.0.to_string()),
                session_id: None,
                message_id: Some("m-post".into()),
                text: "All done.".into(),
            },
            EngineEvent::AssistantMessage {
                prompt_id: Some(prompt_id.0.to_string()),
                session_id: None,
                message_id: Some("m-post".into()),
                text: "All done.".into(),
            },
        ] {
            runner
                .handle_native_stream_event(
                    &driver,
                    &handle,
                    false,
                    None,
                    session_id,
                    prompt_id,
                    ev,
                    &mut char_acc,
                    &mut state,
                )
                .await;
        }
        assert_eq!(
            collect_emitted_text(&mut rx),
            vec!["Checking file...".to_string(), "All done.".to_string()]
        );
    }
}

#[tokio::test]
async fn native_tool_results_preserve_structured_metadata_and_permission_correlation() {
    use crate::{
        engine::{CodexNativeDriver, EngineEvent, EngineHandle, NativeEngineDriver},
        manager::runner::native_events::NativeTurnState,
    };

    let driver: Arc<dyn NativeEngineDriver> = Arc::new(CodexNativeDriver::new());
    let handle = EngineHandle::for_engine(
        uuid::Uuid::new_v4(),
        "codex-native",
        uuid::Uuid::nil(),
        PathBuf::from("C:/workspace"),
        true,
        None,
    );
    let session_id = AgentSessionId::new();
    let prompt_id = AgentPromptId::new();
    let (tx, mut rx) = manager_event_channel();
    let runner = dummy_runner(tx);
    let mut char_acc = 0usize;
    let mut state = NativeTurnState::default();

    for ev in [
        // 1. Non-zero exit code preserves exitCode + aggregatedOutput JSON envelope
        EngineEvent::ToolCall {
            prompt_id: Some(prompt_id.0.to_string()),
            session_id: None,
            parent_tool_use_id: None,
            tool_use_id: Some("cmd-exit-23".into()),
            tool_name: "commandExecution".into(),
            input: serde_json::json!({ "command": "exit 23" }),
        },
        EngineEvent::ToolResult {
            prompt_id: Some(prompt_id.0.to_string()),
            session_id: None,
            parent_tool_use_id: None,
            tool_use_id: Some("cmd-exit-23".into()),
            is_error: true,
            content: serde_json::json!({
                "type": "commandExecution",
                "status": "failed",
                "exitCode": 23,
                "aggregatedOutput": "boom\n"
            }),
        },
        // 2. Timed out command emits status="timed_out" and injects buffered output when empty
        EngineEvent::ToolCall {
            prompt_id: Some(prompt_id.0.to_string()),
            session_id: None,
            parent_tool_use_id: None,
            tool_use_id: Some("cmd-timeout".into()),
            tool_name: "commandExecution".into(),
            input: serde_json::json!({ "command": "sleep 60" }),
        },
        EngineEvent::TerminalOutputDelta {
            prompt_id: Some(prompt_id.0.to_string()),
            session_id: None,
            call_id: Some("cmd-timeout".into()),
            delta: "partial out\n".into(),
        },
        EngineEvent::ToolResult {
            prompt_id: Some(prompt_id.0.to_string()),
            session_id: None,
            parent_tool_use_id: None,
            tool_use_id: Some("cmd-timeout".into()),
            is_error: true,
            content: serde_json::json!({
                "type": "commandExecution",
                "status": "timedOut",
                "timedOut": true,
                "aggregatedOutput": ""
            }),
        },
        // 3. Declined command emits status="denied"
        EngineEvent::ToolCall {
            prompt_id: Some(prompt_id.0.to_string()),
            session_id: None,
            parent_tool_use_id: None,
            tool_use_id: Some("cmd-declined".into()),
            tool_name: "commandExecution".into(),
            input: serde_json::json!({ "command": "rm -rf /" }),
        },
        EngineEvent::ToolResult {
            prompt_id: Some(prompt_id.0.to_string()),
            session_id: None,
            parent_tool_use_id: None,
            tool_use_id: Some("cmd-declined".into()),
            is_error: true,
            content: serde_json::json!({
                "type": "commandExecution",
                "status": "declined",
                "aggregatedOutput": ""
            }),
        },
        // 4. Permission request correlates itemId into details.toolCallId rather than permissionId
        EngineEvent::PermissionRequested {
            permission_id: "perm-approval-99".into(),
            prompt_id: Some(prompt_id.0.to_string()),
            session_id: None,
            tool_name: "commandExecution".into(),
            input: serde_json::json!({
                "approvalId": "perm-approval-99",
                "itemId": "cmd-item-99",
                "command": ["rm", "x"]
            }),
            decision_reason: Some("Confirm delete".into()),
            options: Vec::new(),
        },
    ] {
        runner
            .handle_native_stream_event(
                &driver,
                &handle,
                false,
                None,
                session_id,
                prompt_id,
                ev,
                &mut char_acc,
                &mut state,
            )
            .await;
    }

    let mut updates = std::collections::HashMap::new();
    let mut perm_tool_call_id = None;
    while let Ok(ev) = rx.try_recv() {
        match ev.event {
            AgentEvent::ToolCallUpdate { update } if update.status.is_some() => {
                updates.insert(update.id.clone(), (update.status, update.content));
            }
            AgentEvent::PermissionRequested { request } => {
                perm_tool_call_id = request.details.and_then(|d| {
                    d.get("toolCallId")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                });
            }
            _ => {}
        }
    }

    let (status_23, content_23) = updates.get("cmd-exit-23").expect("cmd-exit-23 update");
    assert_eq!(status_23.as_deref(), Some("failed"));
    let json_23: serde_json::Value =
        serde_json::from_str(content_23.as_deref().expect("content")).expect("json");
    assert_eq!(json_23["exitCode"], 23);
    assert_eq!(json_23["aggregatedOutput"], "boom\n");

    let (status_to, content_to) = updates.get("cmd-timeout").expect("cmd-timeout update");
    assert_eq!(status_to.as_deref(), Some("timed_out"));
    let json_to: serde_json::Value =
        serde_json::from_str(content_to.as_deref().expect("content")).expect("json");
    assert_eq!(json_to["timedOut"], true);
    assert_eq!(json_to["aggregatedOutput"], "partial out\n");

    let (status_dec, _) = updates.get("cmd-declined").expect("cmd-declined update");
    assert_eq!(status_dec.as_deref(), Some("denied"));
    assert_eq!(perm_tool_call_id.as_deref(), Some("cmd-item-99"));
}
