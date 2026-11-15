use super::*;


#[test]
fn vendor_low_effort_is_merged_into_standard_reasoning_effort() {
    let meta = serde_json::json!({
        "x.ai/sessionConfig": {
            "options": [
                { "id": "grok-4.6", "category": "model", "label": "Grok 4.6", "selected": true },
                { "id": "xhigh", "category": "mode", "label": "Extra High Effort", "selected": false },
                { "id": "high", "category": "mode", "label": "High Effort", "selected": true },
                { "id": "medium", "category": "mode", "label": "Medium Effort", "selected": false },
                { "id": "low", "category": "mode", "label": "Low Effort", "selected": false }
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
    let effort = options
        .iter()
        .find(|option| option.id.0.as_ref() == "reasoning_effort")
        .expect("one thought_level option");
    let SessionConfigKind::Select(select) = &effort.kind else {
        panic!("effort option must be a select");
    };
    let SessionConfigSelectOptions::Ungrouped(choices) = &select.options else {
        panic!("effort options must be ungrouped");
    };
    let values: Vec<_> = choices
        .iter()
        .map(|choice| choice.value.0.to_string())
        .collect();
    assert!(
        values.contains(&"low".to_string()),
        "Grok Low Effort must remain selectable, got {values:?}"
    );
    assert!(values.contains(&"xhigh".to_string()));
    assert_eq!(
        find_config_override_selection(&options, "reasoning_effort", &serde_json::json!("low"))
            .map(|selection| selection.event_value),
        Some(serde_json::json!("low"))
    );
}

#[test]
fn vendor_fallback_keeps_standard_permission_modes_and_adds_effort() {
    let meta = serde_json::json!({
        "x.ai/sessionConfig": {
            "options": [
                { "id": "grok-4.6", "category": "model", "label": "Grok 4.6", "selected": true },
                { "id": "high", "category": "mode", "label": "High Effort", "selected": true }
            ]
        }
    });
    let standard_modes = Some(SessionModeState::new(
        "auto",
        vec![agent_client_protocol::schema::v1::SessionMode::new(
            "auto", "Auto",
        )],
    ));

    let (modes, config_options, vendor) =
        session_controls_with_vendor_fallback(standard_modes, None, meta.as_object());

    assert_eq!(vendor, Some(VendorConfigWire::XaiSessionConfig));
    assert!(modes.is_some_and(|state| state.current_mode_id.0.as_ref() == "auto"));
    let options = config_options.expect("vendor config");
    assert!(
        options
            .iter()
            .any(|option| option.id.0.as_ref() == "effort")
    );
}

#[test]
fn vendor_permission_options_become_session_modes() {
    let meta = serde_json::json!({
        "x.ai/sessionConfig": {
            "options": [
                { "id": "default", "category": "permission", "label": "Ask", "selected": true },
                { "id": "bypassPermissions", "category": "permission", "label": "Bypass" }
            ]
        }
    });
    let vendor = vendor_session_controls_from_meta(meta.as_object().unwrap())
        .expect("permission options parse");
    let modes = vendor.modes.expect("permission options become modes");
    assert_eq!(modes.current_mode_id.0.as_ref(), "default");
    assert_eq!(modes.available_modes.len(), 2);
    assert_eq!(modes.available_modes[1].id.0.as_ref(), "bypassPermissions");
}

#[test]
fn vendor_fallback_maps_only_when_no_standard_config_is_advertised() {
    let meta = serde_json::json!({
        "x.ai/sessionConfig": {
            "options": [
                { "id": "grok-4.6", "category": "model", "label": "Grok 4.6", "selected": true },
                { "id": "high", "category": "mode", "label": "High Effort", "selected": true }
            ]
        }
    });

    let (modes, config_options, vendor) =
        session_controls_with_vendor_fallback(None, None, meta.as_object());

    assert_eq!(vendor, Some(VendorConfigWire::XaiSessionConfig));
    assert!(modes.is_none());
    let options = config_options.expect("vendor config");
    assert!(options.iter().any(|option| option.id.0.as_ref() == "model"));
    assert!(
        options
            .iter()
            .any(|option| option.id.0.as_ref() == "effort")
    );
}

#[test]
fn grok_vendor_meta_without_config_returns_none() {
    assert!(vendor_session_controls_from_meta(&serde_json::Map::new()).is_none());
    let unrelated = serde_json::json!({ "other": "meta" });
    assert!(vendor_session_controls_from_meta(unrelated.as_object().unwrap()).is_none());
}

#[test]
fn matches_model_override_to_acp_model_category_choices() {
    let options = vec![
        AcpSessionConfigOption::select(
            "preferred-model",
            "Model",
            "claude-opus-4-8",
            vec![
                agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                    "claude-opus-4-8",
                    "Claude Opus 4.8",
                ),
                agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                    "claude-sonnet-4-5",
                    "Claude Sonnet 4.5",
                ),
            ],
        )
        .category(Some(SessionConfigOptionCategory::Model)),
    ];

    let selection =
        find_config_override_selection(&options, "model", &serde_json::json!("sonnet"))
            .expect("sonnet should match ACP model choices");

    assert_eq!(selection.config_id, "preferred-model");
    assert_eq!(
        selection.event_value,
        serde_json::json!("claude-sonnet-4-5")
    );
    assert!(!selection.already_selected);
}

#[test]
fn matches_permission_override_aliases_to_acp_choices() {
    let options = vec![AcpSessionConfigOption::select(
        "permission-mode",
        "Permissions",
        "ask",
        vec![
            agent_client_protocol::schema::v1::SessionConfigSelectOption::new("ask", "Ask"),
            agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                "auto",
                "Auto Approve",
            ),
        ],
    )];

    let selection =
        find_config_override_selection(&options, "permission_mode", &serde_json::json!("auto"))
            .expect("auto should match permission choices");

    assert_eq!(selection.config_id, "permission-mode");
    assert_eq!(selection.event_value, serde_json::json!("auto"));
    assert!(!selection.already_selected);
}

#[test]
fn exact_codex_full_access_mode_wins_over_agent_prefix() {
    let options = vec![
        AcpSessionConfigOption::select(
            "mode",
            "Mode",
            "agent",
            vec![
                agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                    "read-only",
                    "Read-only",
                ),
                agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                    "agent", "Agent",
                ),
                agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                    "agent-full-access",
                    "Agent (full access)",
                ),
            ],
        )
        .category(Some(SessionConfigOptionCategory::Mode)),
    ];

    let selection = find_config_override_selection(
        &options,
        "mode",
        &serde_json::json!("agent-full-access"),
    )
    .expect("Codex full access should match an advertised choice");

    assert_eq!(
        selection.event_value,
        serde_json::json!("agent-full-access")
    );
    assert!(!selection.already_selected);
}

#[test]
fn derived_session_modes_follow_a_mode_config_option_current_value() {
    let mut options = vec![
        AcpSessionConfigOption::select(
            "mode",
            "Mode",
            "agent",
            vec![
                agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                    "agent", "Agent",
                ),
                agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                    "agent-full-access",
                    "Agent (full access)",
                ),
            ],
        )
        .category(Some(SessionConfigOptionCategory::Mode)),
    ];
    let (modes, current) = session_modes_from_config_options(&options);
    assert_eq!(current.as_deref(), Some("agent"));
    assert!(modes.iter().any(|mode| mode.id == "agent-full-access"));

    apply_current_mode_to_config_options(&mut options, "agent-full-access");
    let (_, current) = session_modes_from_config_options(&options);
    assert_eq!(current.as_deref(), Some("agent-full-access"));
}

#[test]
fn codex_mode_override_uses_config_option_when_legacy_modes_are_suppressed() {
    let controls = SessionControlState {
        config_options: vec![
            AcpSessionConfigOption::select(
                "mode",
                "Mode",
                "agent",
                vec![
                    agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                        "agent", "Agent",
                    ),
                    agent_client_protocol::schema::v1::SessionConfigSelectOption::new(
                        "agent-full-access",
                        "Agent (full access)",
                    ),
                ],
            )
            .category(Some(SessionConfigOptionCategory::Mode)),
        ],
        vendor_config: None,
        mode_uses_set_mode: false,
        available_commands: None,
        ..Default::default()
    };

    let selection = find_config_override_selection(
        &controls.config_options,
        "mode",
        &serde_json::json!("agent-full-access"),
    )
    .expect("the unified mode intent must use the advertised config option");
    assert_eq!(selection.config_id, "mode");
    assert_eq!(
        selection.event_value,
        serde_json::json!("agent-full-access")
    );
}

#[test]
fn maps_and_matches_boolean_session_config_options() {
    let option = AcpSessionConfigOption::boolean("fast", "Fast mode", false);
    let mapped = agent_session_config_options_from_acp(vec![option.clone()]);

    assert_eq!(mapped[0].value, Some(serde_json::json!(false)));
    assert_eq!(
        mapped[0]
            .choices
            .iter()
            .map(|choice| choice.value.clone())
            .collect::<Vec<_>>(),
        vec![serde_json::json!(false), serde_json::json!(true)]
    );

    let selection = find_config_override_selection(&[option], "fast", &serde_json::json!(true))
        .expect("boolean config should accept a JSON boolean");
    assert_eq!(selection.event_value, serde_json::json!(true));
    assert!(!selection.already_selected);
    assert_eq!(selection.wire_value.as_bool(), Some(true));
}

#[test]
fn pending_session_id_is_used_before_session_map_binds() {
    let conversation = AgentSessionId::new();
    assert_eq!(
        resolve_agent_session_id(None, Some(conversation)),
        Some(conversation)
    );
    let mapped = AgentSessionId::new();
    assert_eq!(
        resolve_agent_session_id(Some(mapped), Some(conversation)),
        Some(mapped)
    );
    assert_eq!(resolve_agent_session_id(None, None), None);
}

#[test]
fn resume_does_not_reuse_a_mapped_acp_session_with_a_different_id() {
    assert_eq!(
        mapped_resume_action(Some("acp-a"), "acp-a"),
        MappedResume::Reuse("acp-a".into())
    );
    assert_eq!(
        mapped_resume_action(Some("acp-b"), "acp-a"),
        MappedResume::LoadRequested { unbind_stale: true }
    );
    assert_eq!(
        mapped_resume_action(None, "acp-a"),
        MappedResume::LoadRequested {
            unbind_stale: false
        }
    );
}

/// Regression: `session/load` replays the agent's stored transcript as ordinary
/// `session/update` notifications. Recording them duplicated every earlier AI
/// message into the next turn ("用户 A - AI A - 用户 B - AI AB").
#[test]
fn transcript_updates_are_gated_during_session_restore_but_controls_are_not() {
    use agent_client_protocol::schema::v1::{
        AvailableCommandsUpdate, ContentChunk, CurrentModeUpdate, SessionModeId,
    };

    let transcript = [
        SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from("hello"))),
        SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::from("thinking"))),
        SessionUpdate::UserMessageChunk(ContentChunk::new(ContentBlock::from("prompt"))),
    ];
    for update in transcript {
        assert!(
            is_session_transcript_update(&update),
            "{update:?} replays on session/load and must not be re-recorded"
        );
    }

    let controls = [
        SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new(SessionModeId::new("plan"))),
        SessionUpdate::AvailableCommandsUpdate(AvailableCommandsUpdate::new(Vec::new())),
    ];
    for update in controls {
        assert!(
            !is_session_transcript_update(&update),
            "{update:?} is session control state and must survive a restore"
        );
    }
}

#[test]
fn maps_acp_available_commands_to_agent_payload() {
    let commands = vec![
        AcpAvailableCommand::new("compact", "Compact context").input(
            agent_client_protocol::schema::v1::AvailableCommandInput::Unstructured(
                agent_client_protocol::schema::v1::UnstructuredCommandInput::new("focus"),
            ),
        ),
    ];

    let mapped = agent_available_commands_from_acp(commands);

    assert_eq!(mapped[0].name, "compact");
    assert_eq!(mapped[0].description.as_deref(), Some("Compact context"));
    assert!(mapped[0].input_schema.is_some());
}

#[test]
fn agent_env_merge_prioritizes_config_then_proxy_over_defaults() {
    let configured = HashMap::from([
        ("NPM_CONFIG_LOGLEVEL".to_string(), "silent".to_string()),
        ("CUSTOM_ENV".to_string(), "from-config".to_string()),
        ("HTTP_PROXY".to_string(), "http://config-proxy".to_string()),
    ]);
    let merged = merge_agent_env(
        &configured,
        [
            ("HTTP_PROXY".to_string(), "http://proxy-setting".to_string()),
            (
                "ALL_PROXY".to_string(),
                "socks5://proxy-setting".to_string(),
            ),
        ],
    );

    assert_eq!(
        merged.get("NODE_NO_WARNINGS").map(String::as_str),
        Some("1")
    );
    assert_eq!(
        merged.get("NPM_CONFIG_LOGLEVEL").map(String::as_str),
        Some("silent")
    );
    assert_eq!(
        merged.get("CUSTOM_ENV").map(String::as_str),
        Some("from-config")
    );
    assert_eq!(
        merged.get("HTTP_PROXY").map(String::as_str),
        Some("http://proxy-setting")
    );
    assert_eq!(
        merged.get("ALL_PROXY").map(String::as_str),
        Some("socks5://proxy-setting")
    );
}

#[test]
fn detected_system_proxy_fills_agent_proxy_env() {
    let env = proxy_env_from_detected(Some(&DetectedProxy {
        url: "http://127.0.0.1:7897".to_string(),
        source: ProxySource::System,
    }));
    assert_eq!(
        env.iter()
            .find(|(key, _)| key == "HTTPS_PROXY")
            .map(|(_, value)| value.as_str()),
        Some("http://127.0.0.1:7897")
    );
    assert_eq!(
        env.iter()
            .find(|(key, _)| key == "NO_PROXY")
            .map(|(_, value)| value.as_str()),
        Some("localhost,127.0.0.1,::1")
    );
    assert_eq!(
        env.iter()
            .find(|(key, _)| key == "no_proxy")
            .map(|(_, value)| value.as_str()),
        Some("localhost,127.0.0.1,::1")
    );
    assert!(proxy_url_env_present(&env));
}

#[test]
fn ensure_no_proxy_loopback_preserves_custom_hosts_and_adds_loopback() {
    let mut env = vec![
        (
            "HTTPS_PROXY".to_string(),
            "http://127.0.0.1:7897".to_string(),
        ),
        ("NO_PROXY".to_string(), "corp.internal,10.0.0.1".to_string()),
    ];
    ensure_no_proxy_loopback(&mut env);
    assert_eq!(
        env.iter()
            .find(|(key, _)| key == "NO_PROXY")
            .map(|(_, value)| value.as_str()),
        Some("corp.internal,10.0.0.1,localhost,127.0.0.1,::1")
    );
    assert_eq!(
        env.iter()
            .find(|(key, _)| key == "no_proxy")
            .map(|(_, value)| value.as_str()),
        Some("corp.internal,10.0.0.1,localhost,127.0.0.1,::1")
    );
}

#[test]
fn pac_detection_does_not_fill_agent_proxy_env() {
    let env = proxy_env_from_detected(Some(&DetectedProxy {
        url: "http://wpad.example/proxy.pac".to_string(),
        source: ProxySource::Pac,
    }));
    assert!(env.is_empty());
}

#[tokio::test]
async fn sweep_idle_skips_connecting_connections() {
    let (event_tx, _event_rx) = manager_event_channel();
    let manager = AgentConnectionManager::new_with_driver(event_tx, false);
    let (snapshot, ready_rx) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id: AgentConnectionId::new(),
            agent_id: AgentId::parse("codex").unwrap(),
            launch_lock: test_launch_lock(AgentId::parse("codex").unwrap()),
            workspace_id: uuid::Uuid::new_v4(),
            working_dir: std::env::temp_dir(),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;
    ready_rx.await.unwrap().unwrap();

    manager
        .set_connection_status(snapshot.connection_id, AgentConnectionStatus::Connecting)
        .await;
    assert_eq!(manager.sweep_idle(Duration::from_secs(0)).await, 0);

    manager
        .set_connection_status(snapshot.connection_id, AgentConnectionStatus::Ready)
        .await;
    assert_eq!(manager.sweep_idle(Duration::from_secs(0)).await, 1);
}

async fn ready_connection(manager: &AgentConnectionManager) -> AgentConnectionId {
    let (snapshot, ready_rx) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id: AgentConnectionId::new(),
            agent_id: AgentId::parse("codex").unwrap(),
            launch_lock: test_launch_lock(AgentId::parse("codex").unwrap()),
            workspace_id: uuid::Uuid::new_v4(),
            working_dir: std::env::temp_dir(),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;
    ready_rx.await.unwrap().unwrap();
    manager
        .set_connection_status(snapshot.connection_id, AgentConnectionStatus::Ready)
        .await;
    snapshot.connection_id
}

#[tokio::test]
async fn sweep_idle_keeps_hot_group_sessions_past_default_timeout() {
    let (event_tx, _event_rx) = manager_event_channel();
    let manager = AgentConnectionManager::new_with_driver(event_tx, false);
    let hot_connection = ready_connection(&manager).await;
    let cold_connection = ready_connection(&manager).await;
    let dm_connection = ready_connection(&manager).await;
    let hot_session = AgentSessionId::new();
    let cold_session = AgentSessionId::new();
    let dm_session = AgentSessionId::new();
    manager
        .bind_known_acp_session(hot_connection, hot_session, "acp-hot".into())
        .await;
    manager
        .bind_known_acp_session(cold_connection, cold_session, "acp-cold".into())
        .await;
    manager
        .bind_known_acp_session(dm_connection, dm_session, "acp-dm".into())
        .await;
    let idle = Duration::from_secs(180);
    manager
        .set_last_activity_elapsed(hot_connection, Duration::from_secs(200))
        .await;
    manager
        .set_last_activity_elapsed(cold_connection, Duration::from_secs(200))
        .await;
    manager
        .set_last_activity_elapsed(dm_connection, Duration::from_secs(200))
        .await;

    let mut hot = HashSet::new();
    hot.insert(hot_session);
    assert_eq!(
        manager
            .sweep_idle_with_extended(idle, Some((hot.clone(), Duration::from_secs(20 * 60))),)
            .await,
        2,
        "cold group and DM use the ordinary 180s timeout"
    );
    assert_eq!(
        manager
            .sweep_idle_with_extended(idle, Some((hot, Duration::from_secs(20 * 60))))
            .await,
        0,
        "hot group member stays until the extended timeout"
    );
    assert_eq!(
        manager.sweep_idle(idle).await,
        1,
        "once the group is cold the next sweep uses the ordinary rule"
    );
}

#[test]
fn handshake_timeout_uses_default_for_missing_or_invalid_env() {
    assert_eq!(
        handshake_timeout_from_env_value(None),
        Duration::from_secs(DEFAULT_HANDSHAKE_TIMEOUT_SECS)
    );
    assert_eq!(
        handshake_timeout_from_env_value(Some("0")),
        Duration::from_secs(DEFAULT_HANDSHAKE_TIMEOUT_SECS)
    );
    assert_eq!(
        handshake_timeout_from_env_value(Some("not-a-number")),
        Duration::from_secs(DEFAULT_HANDSHAKE_TIMEOUT_SECS)
    );
}

#[test]
fn handshake_timeout_accepts_positive_env_value() {
    assert_eq!(
        handshake_timeout_from_env_value(Some("7")),
        Duration::from_secs(7)
    );
}

#[test]
fn prompt_idle_timeout_is_disabled_when_unset_zero_or_invalid() {
    assert_eq!(prompt_idle_timeout_from_env_value(None), None);
    assert_eq!(prompt_idle_timeout_from_env_value(Some("0")), None);
    assert_eq!(prompt_idle_timeout_from_env_value(Some("nope")), None);
    assert_eq!(prompt_idle_timeout_from_env_value(Some("  ")), None);
}

#[test]
fn prompt_idle_timeout_defaults_when_env_is_unset_and_can_be_disabled() {
    assert_eq!(
        prompt_idle_timeout_from_env(None),
        Some(Duration::from_secs(DEFAULT_PROMPT_IDLE_TIMEOUT_SECS))
    );
    assert_eq!(
        prompt_idle_timeout_from_env(Some("")),
        Some(Duration::from_secs(DEFAULT_PROMPT_IDLE_TIMEOUT_SECS))
    );
    assert_eq!(prompt_idle_timeout_from_env(Some("0")), None);
    assert_eq!(
        prompt_idle_timeout_from_env(Some("30")),
        Some(Duration::from_secs(30))
    );
}

#[test]
fn prompt_idle_timeout_accepts_positive_env_value() {
    assert_eq!(
        prompt_idle_timeout_from_env_value(Some("120")),
        Some(Duration::from_secs(120))
    );
}

#[test]
fn prompt_idle_watchdog_skips_permission_elicitation_and_live_terminals() {
    assert!(!prompt_idle_watchdog_blocked(false, false, false));
    assert!(prompt_idle_watchdog_blocked(true, false, false));
    assert!(prompt_idle_watchdog_blocked(false, true, false));
    assert!(prompt_idle_watchdog_blocked(false, false, true));
}

#[test]
fn wait_for_terminal_exit_must_run_off_the_dispatch_loop() {
    let wait = AgentRequest::WaitForTerminalExitRequest(
        agent_client_protocol::schema::v1::WaitForTerminalExitRequest::new(
            SessionId::new("session-1"),
            TerminalId::new("term-1"),
        ),
    );
    assert!(acp_request_must_run_off_dispatch_loop(&wait));
    assert!(!acp_request_must_run_off_dispatch_loop(
        &AgentRequest::KillTerminalRequest(KillTerminalRequest::new(
            SessionId::new("session-1"),
            TerminalId::new("term-1"),
        ))
    ));
}

#[test]
fn question_requests_must_run_off_the_dispatch_loop() {
    let grok_ask = AgentRequest::ExtMethodRequest(ExtRequest::new(
        "_x.ai/ask_user_question",
        serde_json::value::to_raw_value(&serde_json::json!({
            "sessionId": "session-1",
            "questions": [{ "question": "Pick one", "options": [] }]
        }))
        .expect("raw params")
        .into(),
    ));
    assert!(
        acp_request_must_run_off_dispatch_loop(&grok_ask),
        "Grok ask_user_question waits for the user; answering it inline freezes session/update so the agent times out and treats the question as cancelled"
    );

    let elicitation: CreateElicitationRequest = serde_json::from_value(serde_json::json!({
        "mode": "form",
        "message": "Pick one",
        "sessionId": "session-1",
        "requestedSchema": { "type": "object", "properties": {} }
    }))
    .expect("elicitation/create");
    assert!(
        acp_request_must_run_off_dispatch_loop(&AgentRequest::CreateElicitationRequest(
            elicitation
        )),
        "elicitation/create waits for the user the same way as vendor question ext-methods"
    );

    assert!(!acp_request_must_run_off_dispatch_loop(
        &AgentRequest::KillTerminalRequest(KillTerminalRequest::new(
            SessionId::new("session-1"),
            TerminalId::new("term-1"),
        ))
    ));
}

#[test]
fn proxy_env_keys_include_no_proxy_both_cases() {
    // NO_PROXY/no_proxy must be forwarded to the agent child so proxy bypass
    // rules (e.g. for internal hosts) reach Codex on a proxied/China network.
    assert!(PROXY_ENV_KEYS.contains(&"NO_PROXY"));
    assert!(PROXY_ENV_KEYS.contains(&"no_proxy"));
    assert!(PROXY_ENV_KEYS.contains(&"HTTPS_PROXY"));
    assert!(PROXY_ENV_KEYS.contains(&"https_proxy"));
}

#[test]
fn stderr_tail_redacts_and_summarizes_recent_lines() {
    let tail = StderrTail::new();

    tail.push("first line");
    tail.push("api_key=sk-live-abcdefghijklmnop");

    assert_eq!(
        tail.summary().as_deref(),
        Some("first line\napi_key=<redacted>")
    );
}

#[test]
fn handshake_timeout_error_includes_recent_stderr_when_present() {
    let message =
        format_handshake_timeout_error(Duration::from_secs(3), Some("last line".to_string()));

    assert!(message.contains("3s"));
    assert!(message.contains("last line"));
}

#[test]
fn session_prep_timeout_uses_default_for_missing_or_invalid_env() {
    assert_eq!(
        session_prep_timeout_from_env_value(None),
        Duration::from_secs(DEFAULT_SESSION_PREP_TIMEOUT_SECS)
    );
    assert_eq!(
        session_prep_timeout_from_env_value(Some("0")),
        Duration::from_secs(DEFAULT_SESSION_PREP_TIMEOUT_SECS)
    );
    assert_eq!(
        session_prep_timeout_from_env_value(Some("not-a-number")),
        Duration::from_secs(DEFAULT_SESSION_PREP_TIMEOUT_SECS)
    );
}

#[test]
fn session_prep_timeout_accepts_positive_env_value() {
    assert_eq!(
        session_prep_timeout_from_env_value(Some("12")),
        Duration::from_secs(12)
    );
}

#[tokio::test]
async fn session_prep_times_out_when_the_agent_never_replies() {
    let (_tx, rx) = tokio::sync::oneshot::channel::<AgentResult<()>>();
    let error = await_command_result(
        rx,
        Duration::from_millis(20),
        "agent connection closed before ACP session preparation completed",
        format_session_prep_timeout_error(Duration::from_secs(20)),
    )
    .await
    .expect_err("hanging session/new must surface a timeout");
    let message = error.to_string();
    assert!(message.contains("session preparation timed out"));
    assert!(message.contains("20s"));
}

#[tokio::test]
async fn process_death_wins_over_simultaneous_acp_success() {
    let stop = wait_for_acp_or_process_death(
        async { Ok::<(), ()>(()) },
        std::future::pending(),
        async {},
    )
    .await;
    // Stdout EOF no longer outranks a live protocol loop: a pipe stall
    // must not kill a Prompting connection. The quiet-Ok-while-in-flight
    // case is still a connection_closed via resolve_acp_process_stop.
    assert!(matches!(stop, AcpProcessStop::Connection(Ok(()))));
}

#[tokio::test]
async fn acp_completion_wins_when_the_process_is_still_alive() {
    let stop = wait_for_acp_or_process_death(
        async { Ok::<(), ()>(()) },
        std::future::pending(),
        std::future::pending(),
    )
    .await;
    assert!(matches!(stop, AcpProcessStop::Connection(Ok(()))));
}

#[tokio::test]
async fn stdout_eof_fails_a_pending_acp_connection() {
    let stop = tokio::time::timeout(
        Duration::from_secs(2),
        wait_for_acp_or_process_death(
            std::future::pending::<Result<(), ()>>(),
            std::future::pending(),
            async {},
        ),
    )
    .await
    .expect("stdout-EOF grace should settle");
    assert!(matches!(stop, AcpProcessStop::StdoutClosed));
}

#[tokio::test]
async fn stdout_eof_does_not_kill_a_live_protocol_loop() {
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let acp = async {
        release_rx.await.ok();
        Ok::<(), ()>(())
    };
    let wait = wait_for_acp_or_process_death(acp, std::future::pending(), async {});
    tokio::pin!(wait);
    tokio::select! {
        stop = &mut wait => {
            panic!("stdout EOF must wait for the protocol loop, got {stop:?}");
        }
        _ = tokio::time::sleep(Duration::from_millis(50)) => {}
    }
    let _ = release_tx.send(());
    let stop = wait.await;
    assert!(matches!(stop, AcpProcessStop::Connection(Ok(()))));
}

#[test]
fn acp_success_while_a_turn_is_in_flight_is_connection_closed() {
    let error =
        resolve_acp_process_stop(AcpProcessStop::Connection(Ok::<(), &str>(())), true, None)
            .expect_err("an in-flight turn must not survive a quiet ACP shutdown");
    assert!(error.is_connection_death());
    let event = turn_error_event_from_connection_failure(&error);
    assert_eq!(event.message, CONNECTION_CLOSED_TURN_MESSAGE);
    assert_eq!(event.code.as_deref(), Some("connection_closed"));
}

#[test]
fn acp_success_without_a_turn_is_ok() {
    resolve_acp_process_stop(AcpProcessStop::Connection(Ok::<(), &str>(())), false, None)
        .expect("a clean shutdown with no turn must stay success");
}

#[test]
fn connection_closed_without_a_prompt_is_not_an_in_flight_turn_failure() {
    assert!(
        !agent_error_is_in_flight_turn_failure("connection_closed", None, None),
        "warmup or idle ACP death must not log as a failed turn"
    );
    assert!(agent_error_is_in_flight_turn_failure(
        "connection_closed",
        Some(AgentSessionId::new()),
        Some(AgentPromptId::new()),
    ));
    assert!(!agent_error_is_in_flight_turn_failure(
        "agent_not_installed",
        Some(AgentSessionId::new()),
        Some(AgentPromptId::new()),
    ));
}

#[test]
fn process_death_turn_error_uses_connection_closed_code() {
    let error = connection_closed_error(
        "ACP agent process exited (exit status: 1)",
        Some("fatal".into()),
    );
    let event = turn_error_event_from_connection_failure(&error);
    assert_eq!(event.message, CONNECTION_CLOSED_TURN_MESSAGE);
    assert_eq!(event.code.as_deref(), Some("connection_closed"));
    assert_eq!(
        event.raw.as_ref().and_then(|raw| raw.get("detail")),
        Some(&serde_json::json!(
            "agent connection closed: ACP agent process exited (exit status: 1). Recent stderr: fatal"
        ))
    );
}

#[test]
fn acp_transport_failure_during_a_turn_is_connection_closed() {
    let error = AgentError::Runtime("ACP connection failed: broken pipe".into());
    let event = turn_error_event_from_connection_failure(&error);
    assert_eq!(event.message, CONNECTION_CLOSED_TURN_MESSAGE);
    assert_eq!(event.code.as_deref(), Some("connection_closed"));
}

#[test]
fn handshake_timeout_stays_an_internal_turn_error() {
    let error =
        AgentError::Runtime(format_handshake_timeout_error(Duration::from_secs(5), None));
    let event = turn_error_event_from_connection_failure(&error);
    assert!(event.message.contains("ACP handshake timed out"));
    assert_eq!(event.code.as_deref(), Some("internal_error"));
}

#[test]
fn session_load_errors_classify_by_real_acp_code() {
    // ResourceNotFound (-32002) → expired session.
    assert!(matches!(
        classify_session_load_error(&acp::Error::resource_not_found(None)),
        SessionLoadFailureReason::ResourceNotFound
    ));
    // AuthRequired (-32000) → re-auth.
    assert!(matches!(
        classify_session_load_error(&acp::Error::auth_required()),
        SessionLoadFailureReason::AuthenticationRequired { .. }
    ));
    // Anything else → Other, with the message preserved.
    assert!(matches!(
        classify_session_load_error(&acp::Error::invalid_params()),
        SessionLoadFailureReason::Other { .. }
    ));
    // Auth is code-only: message text must not classify as auth.
    assert!(
        classify_session_load_failure_fragments("Authentication required", "sid").is_none()
    );
}

#[test]
fn session_load_failure_fragments_lock_codeg_arms() {
    assert!(matches!(
        classify_session_load_failure_fragments(
            "session abc is archived. Run `codex unarchive abc`",
            "abc"
        ),
        Some(SessionLoadFailureReason::SessionArchived { recovery_command })
            if recovery_command.as_deref() == Some("codex unarchive abc")
    ));
    assert!(matches!(
        classify_session_load_failure_fragments(
            "thread xyz already has an active writer",
            "xyz"
        ),
        Some(SessionLoadFailureReason::SessionBusy)
    ));
    assert!(matches!(
        classify_session_load_failure_fragments(
            "Claude Code process exited with code 1",
            "sid"
        ),
        Some(SessionLoadFailureReason::SessionUnavailable)
    ));
    assert!(matches!(
        classify_session_load_failure_fragments("session has ended", "sid"),
        Some(SessionLoadFailureReason::SessionUnavailable)
    ));
    assert!(matches!(
        classify_session_load_failure_fragments("Session not found", "sid"),
        Some(SessionLoadFailureReason::SessionUnavailable)
    ));
    assert!(
        classify_session_load_failure_fragments("Authentication required", "sid").is_none()
    );
    assert!(classify_session_load_failure_fragments("Method not found", "sid").is_none());
    assert!(matches!(
        classify_session_load_failure_fragments(
            r#"Invalid params: "session load was superseded""#,
            "sid"
        ),
        Some(SessionLoadFailureReason::SessionBusy)
    ));
    assert!(matches!(
        classify_session_load_failure_fragments(
            r#"Permission denied.: { "detail": "拒绝访问。 (os error 5)", "code": "FS_PERMISSION_DENIED" }"#,
            "sid"
        ),
        Some(SessionLoadFailureReason::SessionBusy)
    ));
}

#[test]
fn recovers_load_failure_locally_is_custom_and_never_busy() {
    let custom = AgentId::parse("my-custom-agent").unwrap();
    let codex = AgentId::parse("codex").unwrap();
    assert!(recovers_load_failure_locally(
        &custom,
        Some(&SessionLoadFailureReason::ResourceNotFound)
    ));
    assert!(!recovers_load_failure_locally(
        &codex,
        Some(&SessionLoadFailureReason::ResourceNotFound)
    ));
    assert!(!recovers_load_failure_locally(
        &custom,
        Some(&SessionLoadFailureReason::SessionBusy)
    ));
    assert!(!recovers_load_failure_locally(&custom, None));
}

#[test]
fn session_load_failure_decision_table_matches_d3() {
    let custom = AgentId::parse("my-custom-agent").unwrap();
    let codex = AgentId::parse("codex").unwrap();
    let auth = SessionLoadFailureReason::AuthenticationRequired {
        message: "login".into(),
    };
    assert_eq!(
        decide_session_load_failure(&codex, &auth, None, true, false),
        SessionLoadFailureAction::StopForAuth {
            message: "login".into()
        }
    );
    assert_eq!(
        decide_session_load_failure(
            &codex,
            &SessionLoadFailureReason::ResourceNotFound,
            Some(&SessionLoadFailureReason::ResourceNotFound),
            true,
            false
        ),
        SessionLoadFailureAction::Banner(SessionLoadFailureReason::ResourceNotFound)
    );
    assert_eq!(
        decide_session_load_failure(
            &custom,
            &SessionLoadFailureReason::Other {
                message: "gone".into()
            },
            Some(&SessionLoadFailureReason::ResourceNotFound),
            true,
            false
        ),
        SessionLoadFailureAction::SilentNew
    );
    assert_eq!(
        decide_session_load_failure(
            &custom,
            &SessionLoadFailureReason::Other {
                message: "busy".into()
            },
            Some(&SessionLoadFailureReason::SessionBusy),
            true,
            false
        ),
        SessionLoadFailureAction::Banner(SessionLoadFailureReason::SessionBusy)
    );
    assert_eq!(
        decide_session_load_failure(
            &codex,
            &SessionLoadFailureReason::Other {
                message: "nope".into()
            },
            None,
            true,
            false
        ),
        SessionLoadFailureAction::ToastThenNew
    );
    assert_eq!(
        decide_session_load_failure(
            &codex,
            &SessionLoadFailureReason::Other {
                message: "Method not found".into()
            },
            None,
            true,
            true
        ),
        SessionLoadFailureAction::SilentNew
    );
    assert_eq!(
        decide_session_load_failure(
            &codex,
            &SessionLoadFailureReason::Other {
                message: "no load".into()
            },
            None,
            false,
            false
        ),
        SessionLoadFailureAction::SilentNew
    );
    let grok = AgentId::parse("grok").unwrap();
    let superseded = r#"Invalid params: "session load was superseded""#;
    let classified_busy = classify_session_load_failure_fragments(superseded, "sid");
    assert_eq!(
        decide_session_load_failure(
            &grok,
            &SessionLoadFailureReason::Other {
                message: superseded.into()
            },
            classified_busy.as_ref(),
            true,
            false
        ),
        SessionLoadFailureAction::Banner(SessionLoadFailureReason::SessionBusy)
    );
    let permission_denied = r#"Permission denied.: { "detail": "拒绝访问。 (os error 5)", "code": "FS_PERMISSION_DENIED" }"#;
    let classified_permission =
        classify_session_load_failure_fragments(permission_denied, "sid");
    assert_eq!(
        decide_session_load_failure(
            &grok,
            &SessionLoadFailureReason::Other {
                message: permission_denied.into()
            },
            classified_permission.as_ref(),
            true,
            false
        ),
        SessionLoadFailureAction::Banner(SessionLoadFailureReason::SessionBusy)
    );
    // Restoring a known sid maps SilentNew/ToastThenNew to a load-failed
    // banner. session/new is only for conversations that never had a thread.
}
