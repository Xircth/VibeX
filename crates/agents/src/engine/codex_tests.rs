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
                    reply(&mut w, &id, json!({ "turn": { "id": "codex-turn-real-7" } })).await;
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
    std::fs::write(codex_home.join("auth.json"), "{\"OPENAI_API_KEY\":\"sk-1\"}").expect("write auth");

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

    std::fs::write(codex_home.join("auth.json"), "{\"OPENAI_API_KEY\":\"sk-2\"}").expect("update auth");
    let key3 = CodexServerCacheKey::from_spec(&spec);
    assert_ne!(
        key2, key3,
        "editing CODEX_HOME/auth.json must change CodexServerCacheKey"
    );

    std::fs::write(codex_home.join("vibex-model-catalog.json"), "{\"models\":[]}").expect("write catalog");
    let key4 = CodexServerCacheKey::from_spec(&spec);
    assert_ne!(
        key3, key4,
        "editing vibex-model-catalog.json must change CodexServerCacheKey"
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
