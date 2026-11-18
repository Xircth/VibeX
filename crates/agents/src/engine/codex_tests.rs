use futures::StreamExt;
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::*;

fn test_start_spec() -> EngineStartSpec {
    EngineStartSpec {
        workspace_id: Uuid::new_v4(),
        working_dir: PathBuf::from("."),
        model: Some("gpt-5-codex".to_string()),
        ..Default::default()
    }
}

async fn reply<W: AsyncWrite + Unpin>(w: &mut W, id: &Option<Value>, res: Value) {
    let line = format!("{}\n", json!({ "jsonrpc": "2.0", "id": id, "result": res }));
    w.write_all(line.as_bytes()).await.unwrap();
}

async fn notif<W: AsyncWrite + Unpin>(w: &mut W, method: &str, params: Value) {
    let line = format!(
        "{}\n",
        json!({ "jsonrpc": "2.0", "method": method, "params": params })
    );
    w.write_all(line.as_bytes()).await.unwrap();
}

#[tokio::test]
async fn codex_native_driver_streams_deltas_resumes_steers_with_real_turn_id_and_rolls_back() {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut w) = tokio::io::split(server_io);

    let spec = test_start_spec();
    let app = CodexAppServer::connect_over_io(spec.workspace_id, client_read, client_write, None);

    let mock_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).expect("valid jsonrpc");
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();

            match method {
                "initialize" => {
                    assert_eq!(req["params"]["capabilities"]["experimentalApi"], true);
                    reply(&mut w, &id, json!({ "serverInfo": { "name": "codex" } })).await;
                }
                "initialized" => {}
                "thread/start" => {
                    reply(&mut w, &id, json!({ "thread": { "id": "thr-1" } })).await;
                }
                "thread/resume" => {
                    assert_eq!(req["params"]["threadId"], "thr-resumed-99");
                    reply(
                        &mut w,
                        &id,
                        json!({ "thread": { "id": "thr-resumed-99", "model": "gpt-5.4" } }),
                    )
                    .await;
                }
                "turn/start" => {
                    let tid = req["params"]["threadId"]
                        .as_str()
                        .unwrap_or("thr-1")
                        .to_string();
                    reply(
                        &mut w,
                        &id,
                        json!({ "turn": { "id": "codex-turn-real-7" } }),
                    )
                    .await;
                    let thr = json!({ "threadId": tid });
                    let msg = json!({ "threadId": tid, "itemId": "msg-1", "delta": "Hello Codex" });
                    let cmd =
                        json!({ "threadId": tid, "itemId": "cmd-1", "delta": "cargo test ok\n" });
                    let rl = json!({
                        "rateLimits": {
                            "planType": "pro",
                            "primary": { "usedPercent": 42.0, "resetsAt": 1_800_000_000.0 },
                            "credits": { "balance": "19.5" }
                        }
                    });
                    let done = json!({
                        "threadId": tid,
                        "turn": { "id": "codex-turn-real-7", "status": "completed", "model": "gpt-5-codex" }
                    });
                    notif(&mut w, "thread/compaction/started", thr.clone()).await;
                    notif(&mut w, "thread/compaction/completed", thr).await;
                    notif(&mut w, "item/agentMessage/delta", msg).await;
                    notif(&mut w, "item/commandExecution/outputDelta", cmd).await;
                    notif(&mut w, "account/rateLimits/updated", rl).await;
                    notif(&mut w, "turn/completed", done).await;
                }
                "turn/steer" => {
                    assert_eq!(req["params"]["expectedTurnId"], "codex-turn-real-7");
                    reply(&mut w, &id, json!({ "turnId": "codex-turn-real-7" })).await;
                }
                "thread/turns/list" => {
                    let res = json!({
                        "turns": [{ "id": "turn-8", "status": "completed" }],
                        "nextBeforeTurnId": "turn-7",
                        "hasMore": true
                    });
                    reply(&mut w, &id, res).await;
                }
                "thread/fork" => reply(&mut w, &id, json!({ "threadId": "thr-forked" })).await,
                "thread/rollback" => {
                    assert_eq!(req["params"]["beforeTurnId"], "turn-2");
                    reply(&mut w, &id, json!({ "rolledBack": true })).await;
                    break;
                }
                _ => {}
            }
        }
    });

    app.handshake().await.expect("handshake succeeds");
    let driver = CodexNativeDriver::new();
    let handle = driver.bind_existing_server(spec.clone(), Arc::clone(&app), None);

    let prompt_uuid = Uuid::new_v4();
    let blocks = vec![ContentBlock::Text {
        text: "Run tests".into(),
    }];
    let req = EnginePromptRequest {
        prompt_id: prompt_uuid,
        blocks: blocks.clone(),
        session_id: Some("prepared-123".into()),
        mode: PromptMode::Normal,
        ..Default::default()
    };
    let events: Vec<EngineEvent> = driver
        .send_prompt(&handle, req)
        .await
        .unwrap()
        .collect()
        .await;
    assert!(events.iter().any(|e| matches!(
        e,
        EngineEvent::SessionInitialized { session_id: Some(sid), .. } if sid == "thr-1"
    )));
    assert!(events.iter().any(
        |e| matches!(e, EngineEvent::AssistantTextDelta { text, .. } if text == "Hello Codex")
    ));

    let steer = EngineSteerRequest {
        steering_id: Uuid::new_v4(),
        expected_prompt_id: Some(prompt_uuid),
        session_id: None,
        blocks: blocks.clone(),
    };
    let receipt = driver.steer(&handle, steer).await.unwrap();
    assert!(matches!(receipt, EngineSteerReceipt::Accepted { .. }));

    let resumed_handle =
        driver.bind_existing_server(spec, Arc::clone(&app), Some("thr-resumed-99".into()));
    let resume_events: Vec<EngineEvent> = driver
        .send_prompt(
            &resumed_handle,
            EnginePromptRequest {
                prompt_id: Uuid::new_v4(),
                blocks,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .collect()
        .await;
    assert!(resume_events.iter().any(|e| matches!(
        e,
        EngineEvent::SessionInitialized { session_id: Some(sid), .. } if sid == "thr-resumed-99"
    )));

    let page = driver
        .list_thread_turns(&handle, true, Some("turn-9"), Some(20))
        .await
        .unwrap();
    assert_eq!(page.turns.len(), 1);

    let forked = driver
        .fork_session(
            &handle,
            EngineForkRequest {
                checkpoint_point: Some("turn-2".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(forked.forked_session_id, "thr-forked");

    driver
        .revert_to(
            &handle,
            EngineCheckpoint {
                turn_ordinal: 2,
                external_session_point: Some("turn-2".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    mock_peer.await.expect("mock peer finished cleanly");
}

#[test]
fn serialize_codex_input_items_encodes_base64_image_url_and_local_image_path() {
    let items = serialize_codex_input_items(
        &[
            ContentBlock::Image {
                data: "aGVsbG8=".into(),
                mime_type: "image/png".into(),
                uri: None,
                width: None,
                height: None,
            },
            ContentBlock::Image {
                data: String::new(),
                mime_type: "image/jpeg".into(),
                uri: Some("file:///C:/tmp/screen.jpg".into()),
                width: None,
                height: None,
            },
        ],
        PromptMode::Normal,
    );
    assert_eq!(
        items[0],
        json!({ "type": "image", "url": "data:image/png;base64,aGVsbG8=" })
    );
    assert_eq!(items[1]["type"], "localImage");
    assert!(
        items[1]["path"]
            .as_str()
            .unwrap()
            .replace('\\', "/")
            .ends_with("C:/tmp/screen.jpg")
    );
}

#[test]
fn parse_codex_models_response_preserves_is_default_and_skips_hidden_non_default() {
    let payload = json!({
        "data": [
            {
                "id": "gpt-5.4",
                "displayName": "GPT-5.4",
                "description": "Default model",
                "isDefault": true,
                "hidden": false
            },
            {
                "id": "gpt-hidden-beta",
                "displayName": "Hidden Beta",
                "isDefault": false,
                "hidden": true
            },
            {
                "id": "gpt-hidden-default",
                "displayName": "Hidden Default",
                "isDefault": true,
                "hidden": true
            }
        ]
    });
    let models = crate::engine::codex_protocol::parse_codex_models_response(&payload);
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "gpt-5.4");
    assert!(models[0].is_default);
    assert_eq!(models[1].id, "gpt-hidden-default");
    assert!(models[1].is_default);
}

#[tokio::test]
async fn codex_server_cache_key_tracks_codex_home_config_and_invalidate_clears_cache() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let codex_home = tmp.path().join(".codex");
    std::fs::create_dir_all(&codex_home).expect("mkdir");
    std::fs::write(codex_home.join("config.toml"), "model = \"gpt-5.3\"\n").expect("write config");
    std::fs::write(
        codex_home.join("auth.json"),
        "{\"OPENAI_API_KEY\":\"sk-1\"}",
    )
    .expect("write auth");

    let mut spec = test_start_spec();
    spec.env.insert(
        "CODEX_HOME".to_string(),
        codex_home.to_string_lossy().to_string(),
    );

    let key1 = CodexServerCacheKey::from_spec(&spec);
    std::fs::write(codex_home.join("config.toml"), "model = \"gpt-5.4\"\n").expect("update config");
    let key2 = CodexServerCacheKey::from_spec(&spec);
    assert_ne!(
        key1, key2,
        "editing CODEX_HOME/config.toml must change CodexServerCacheKey"
    );

    std::fs::write(
        codex_home.join("auth.json"),
        "{\"OPENAI_API_KEY\":\"sk-2\"}",
    )
    .expect("update auth");
    let key3 = CodexServerCacheKey::from_spec(&spec);
    assert_ne!(
        key2, key3,
        "editing CODEX_HOME/auth.json must change CodexServerCacheKey"
    );

    std::fs::write(
        codex_home.join("dimo-model-catalog.json"),
        "{\"models\":[]}",
    )
    .expect("write catalog");
    let key4 = CodexServerCacheKey::from_spec(&spec);
    assert_ne!(
        key3, key4,
        "editing dimo-model-catalog.json must change CodexServerCacheKey"
    );

    invalidate_codex_servers().await;
}

#[test]
fn codex_driver_accepts_model_id_filters_foreign_models_unless_custom_base_url() {
    let driver = CodexNativeDriver::new();
    let official = HashMap::new();
    assert!(driver.accepts_model_id("gpt-5.4", &official));
    assert!(driver.accepts_model_id("o4-mini", &official));
    assert!(!driver.accepts_model_id("claude-opus-4-6", &official));
    assert!(!driver.accepts_model_id("gemini-2.5-pro", &official));
    assert!(!driver.accepts_model_id("sonnet", &official));
    assert!(!driver.accepts_model_id("opus", &official));

    let mut custom = HashMap::new();
    custom.insert(
        "OPENAI_BASE_URL".to_string(),
        "https://proxy.example.com/v1".to_string(),
    );
    assert!(driver.accepts_model_id("claude-opus-4-6", &custom));
}

#[test]
fn codex_error_with_will_retry_emits_non_terminal_hook_event_and_fatal_emits_turn_error() {
    let rl = Arc::new(RwLock::new(None));
    let comp = Arc::new(RwLock::new(HashMap::new()));

    let retry_top = normalize_codex_notification(
        "error",
        &json!({
            "threadId": "thr-1",
            "turnId": "turn-1",
            "willRetry": true,
            "error": { "message": "429 rate limited, retrying in 2s" }
        }),
        &rl,
        &comp,
    );
    assert_eq!(retry_top.len(), 1);
    assert!(matches!(
        &retry_top[0],
        EngineEvent::HookEvent { hook_name, session_id: Some(sid), .. }
            if hook_name == "codex/retry" && sid == "thr-1"
    ));

    let retry_nested = normalize_codex_notification(
        "error",
        &json!({
            "threadId": "thr-1",
            "error": { "message": "transient overload", "willRetry": true }
        }),
        &rl,
        &comp,
    );
    assert!(matches!(&retry_nested[0], EngineEvent::HookEvent { .. }));

    let fatal = normalize_codex_notification(
        "error",
        &json!({
            "threadId": "thr-1",
            "willRetry": false,
            "error": { "message": "401 Unauthorized: invalid_api_key" }
        }),
        &rl,
        &comp,
    );
    assert!(matches!(
        &fatal[0],
        EngineEvent::TurnError { message, .. } if message.contains("invalid_api_key")
    ));
}

#[test]
fn codex_turn_completed_maps_failed_interrupted_and_completed_statuses() {
    let rl = Arc::new(RwLock::new(None));
    let comp = Arc::new(RwLock::new(HashMap::new()));

    let failed = normalize_codex_notification(
        "turn/completed",
        &json!({
            "threadId": "thr-1",
            "turn": {
                "id": "turn-fail",
                "status": "failed",
                "error": { "message": "Model context length exceeded" }
            }
        }),
        &rl,
        &comp,
    );
    assert!(matches!(
        failed.last(),
        Some(EngineEvent::TurnError { message, .. })
            if message == "Model context length exceeded"
    ));

    let interrupted = normalize_codex_notification(
        "turn/completed",
        &json!({
            "threadId": "thr-1",
            "turn": { "id": "turn-int", "status": "interrupted" }
        }),
        &rl,
        &comp,
    );
    assert!(matches!(
        interrupted.last(),
        Some(EngineEvent::TurnInterrupted { reason, .. }) if reason == "interrupted"
    ));

    let completed = normalize_codex_notification(
        "turn/completed",
        &json!({
            "threadId": "thr-1",
            "turn": { "id": "turn-ok", "status": "completed", "model": "gpt-5.4" }
        }),
        &rl,
        &comp,
    );
    assert!(matches!(
        completed.last(),
        Some(EngineEvent::TurnCompleted {
            stop_reason: Some(sr),
            served_model: Some(m),
            ..
        }) if sr == "end_turn" && m == "gpt-5.4"
    ));
}

#[test]
fn codex_token_usage_subtracts_cached_input_and_separates_total_spend_from_last_window() {
    let rl = Arc::new(RwLock::new(None));
    let comp = Arc::new(RwLock::new(HashMap::new()));

    let events = normalize_codex_notification(
        "thread/tokenUsage/updated",
        &json!({
            "threadId": "thr-1",
            "turnId": "turn-1",
            "tokenUsage": {
                "total": {
                    "inputTokens": 120_000,
                    "cachedInputTokens": 100_000,
                    "outputTokens": 5_000,
                    "totalTokens": 125_000
                },
                "last": {
                    "inputTokens": 45_000,
                    "cachedInputTokens": 40_000,
                    "outputTokens": 1_200,
                    "totalTokens": 46_200
                },
                "modelContextWindow": 272_000
            }
        }),
        &rl,
        &comp,
    );
    assert_eq!(events.len(), 1);
    match &events[0] {
        EngineEvent::UsageUpdated {
            input_tokens,
            cache_read_tokens,
            output_tokens,
            context_used,
            context_window,
            is_turn_summary,
            ..
        } => {
            assert_eq!(*input_tokens, Some(20_000));
            assert_eq!(*cache_read_tokens, Some(100_000));
            assert_eq!(*output_tokens, Some(5_000));
            assert_eq!(*context_used, Some(46_200));
            assert_eq!(*context_window, Some(272_000));
            assert!(!is_turn_summary);
        }
        other => panic!("expected UsageUpdated, got {other:?}"),
    }
}

#[tokio::test]
async fn mcp_tool_approval_elicitation_is_answered_with_action() {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut server_write) = tokio::io::split(server_io);
    let app = CodexAppServer::connect_over_io(Uuid::new_v4(), client_read, client_write, None);
    let mut events = app.subscribe_events();

    let observed = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        let line = lines.next_line().await.unwrap().expect("client reply");
        serde_json::from_str::<Value>(&line).unwrap()
    });

    let request = json!({
        "jsonrpc": "2.0",
        "id": "elic-1",
        "method": "mcpServer/elicitation/request",
        "params": {
            "threadId": "thr-elic",
            "turnId": "turn-elic",
            "serverName": "dimo",
            "mode": "form",
            "message": "Allow the dimo MCP server to run tool \"manage_group\"?",
            "_meta": {
                "codex_approval_kind": "mcp_tool_call",
                "tool_name": "manage_group",
                "persist": "session"
            },
            "requestedSchema": { "type": "object", "properties": {} }
        }
    });
    server_write
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    server_write.flush().await.unwrap();

    let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
        .await
        .expect("elicitation event")
        .expect("event channel");
    let EngineEvent::PermissionRequested {
        permission_id,
        tool_name,
        options,
        ..
    } = event
    else {
        panic!("expected PermissionRequested, got {event:?}");
    };
    assert_eq!(tool_name, "dimo/manage_group");
    assert!(options.iter().any(|option| option.id == "acceptForSession"));

    app.respond_server_request(&EnginePermissionDecision {
        permission_id,
        approved: true,
        option_id: Some("acceptForSession".to_string()),
        updated_input: None,
        message: None,
        interrupt: false,
    })
    .await
    .unwrap();

    let reply = tokio::time::timeout(std::time::Duration::from_secs(2), observed)
        .await
        .expect("client reply")
        .expect("reader");
    assert_eq!(reply["id"], "elic-1");
    assert!(reply.get("error").is_none());
    assert_eq!(
        reply["result"],
        json!({
            "action": "accept",
            "content": {},
            "_meta": { "persist": "session" }
        })
    );
}
