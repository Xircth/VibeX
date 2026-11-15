use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use agents::{
    AgentAutoApproveMode, AgentContentBlock, AgentEvent, AgentEventEnvelope, AgentId,
    AgentPermissionResponse, AgentPromptStatus, AgentRuntime, AgentSessionId, ContentBlock,
    EnsureAgentSessionInput, RespondAgentElicitationInput, RespondAgentPermissionInput,
    RuntimeEventSink, SendAgentPromptInput, SessionLaunchLock,
    elicitation::AgentElicitationResponse,
    engine::{
        ClaudeNativeDriver, CodexNativeDriver, CodexServerCacheKey, EngineAuth, EngineCheckpoint,
        EngineError, EngineEvent, EngineForkRequest, EnginePermissionDecision, EnginePromptRequest,
        EngineRuntimePreference, EngineStartSpec, EngineSteerReceipt, EngineSteerRequest,
        MAX_DIAGNOSTIC_PAYLOAD_BYTES, NativeEngineDriver, NativeEngineKind, PromptMode,
        check_launch_vs_served_model, prepare_instance_isolation_env,
        resolve_native_engine_kind_with_env,
    },
    stderr_tail::StderrTail,
};
use futures::StreamExt;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::mpsc,
};
use uuid::Uuid;

const CODEX_GOLDEN_JSONL: &str = include_str!("fixtures/codex_app_server_golden.jsonl");
const CLAUDE_GOLDEN_JSONL: &str = include_str!("fixtures/claude_sidecar_golden.jsonl");
const FULL_GATE_FIXTURE_PROMPT: &str = "__vibex_agent_full_gate_fixture__";

fn sample_spec(model: &str) -> EngineStartSpec {
    EngineStartSpec {
        workspace_id: Uuid::new_v4(),
        working_dir: std::env::temp_dir(),
        provider_instance_id: None,
        auth: EngineAuth::Ambient,
        model: Some(model.to_string()),
        config_overrides: Value::Null,
        env: HashMap::new(),
        ..Default::default()
    }
}

async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Value) {
    let encoded = format!("{frame}\n");
    writer.write_all(encoded.as_bytes()).await.unwrap();
    writer.flush().await.unwrap();
}

async fn write_rpc_ok<W: AsyncWrite + Unpin>(writer: &mut W, id: &Option<Value>, result: Value) {
    write_frame(
        writer,
        &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
    )
    .await;
}

#[derive(Clone)]
struct ChannelSink {
    tx: mpsc::UnboundedSender<AgentEventEnvelope>,
}

impl RuntimeEventSink for ChannelSink {
    fn emit(&self, envelope: AgentEventEnvelope) {
        let _ = self.tx.send(envelope);
    }
}

/// Non-fail-fast Golden JSONL wire fixture validator (`docs/specs/agent-driver-engine.md` §7).
///
/// Traverses **every** line of `content` without early exit and returns all structural,
/// JSON-RPC 2.0 frame-class, legacy-method, credential-redaction, and 64 KiB payload
/// violations in a single pass.
pub fn validate_golden_fixture_exhaustively(fixture_name: &str, content: &str) -> Vec<String> {
    const FORBIDDEN_SECRET_PATTERNS: &[&str] = &[
        "sk-ant-",
        "sk-proj-",
        "Bearer eyJ",
        "ANTHROPIC_API_KEY=sk-",
        "OPENAI_API_KEY=sk-",
        "ghp_",
        "xoxb-",
    ];
    const FORBIDDEN_METHODS: &[&str] = &["thread/revert", "approval/respond"];

    let mut violations = Vec::new();
    let mut prev_seq = 0u64;
    let mut non_empty_lines = 0usize;

    for (idx, raw_line) in content.lines().enumerate() {
        let line_no = idx + 1;
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        non_empty_lines += 1;

        if raw_line.len() > MAX_DIAGNOSTIC_PAYLOAD_BYTES {
            violations.push(format!(
                "{fixture_name}:{line_no}: payload size {} exceeds MAX_DIAGNOSTIC_PAYLOAD_BYTES ({MAX_DIAGNOSTIC_PAYLOAD_BYTES})",
                raw_line.len()
            ));
        }

        for pat in FORBIDDEN_SECRET_PATTERNS {
            if raw_line.contains(pat) {
                violations.push(format!(
                    "{fixture_name}:{line_no}: unredacted credential pattern `{pat}` present in fixture"
                ));
            }
        }

        let parsed: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(err) => {
                violations.push(format!("{fixture_name}:{line_no}: invalid JSON: {err}"));
                continue;
            }
        };

        let Some(obj) = parsed.as_object() else {
            violations.push(format!(
                "{fixture_name}:{line_no}: top-level record must be a JSON object"
            ));
            continue;
        };

        match obj.get("seq").and_then(Value::as_u64) {
            Some(seq) if seq > prev_seq => {
                prev_seq = seq;
            }
            Some(seq) => violations.push(format!(
                "{fixture_name}:{line_no}: `seq` ({seq}) must increase strictly above {prev_seq}"
            )),
            None => violations.push(format!(
                "{fixture_name}:{line_no}: missing positive integer `seq`"
            )),
        }

        let direction = obj.get("direction").and_then(Value::as_str).unwrap_or("");
        if !matches!(direction, "client_to_server" | "server_to_client") {
            violations.push(format!(
                "{fixture_name}:{line_no}: invalid `direction` `{direction}`"
            ));
        }

        let frame_class = obj.get("frame_class").and_then(Value::as_str).unwrap_or("");
        if !matches!(
            frame_class,
            "request" | "response" | "server_request" | "notification"
        ) {
            violations.push(format!(
                "{fixture_name}:{line_no}: invalid `frame_class` `{frame_class}`"
            ));
        }

        let Some(frame) = obj.get("frame").and_then(Value::as_object) else {
            violations.push(format!(
                "{fixture_name}:{line_no}: missing `frame` JSON object"
            ));
            continue;
        };

        if frame.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            violations.push(format!(
                "{fixture_name}:{line_no}: frame missing `\"jsonrpc\": \"2.0\"`"
            ));
        }

        let has_id = frame.get("id").is_some_and(|v| !v.is_null());
        let method = frame.get("method").and_then(Value::as_str);

        if let Some(m) = method
            && FORBIDDEN_METHODS.contains(&m)
        {
            violations.push(format!(
                "{fixture_name}:{line_no}: forbidden non-normative wire method `{m}`"
            ));
        }

        match (has_id, method) {
            (true, Some(_)) => {
                let expected_class = if direction == "server_to_client" {
                    "server_request"
                } else {
                    "request"
                };
                if frame_class != expected_class {
                    violations.push(format!(
                        "{fixture_name}:{line_no}: frame with both `id` and `method` on `{direction}` must have `frame_class` `{expected_class}`, got `{frame_class}`"
                    ));
                }
            }
            (true, None) => {
                if frame_class != "response" {
                    violations.push(format!(
                        "{fixture_name}:{line_no}: frame with `id` and no `method` must have `frame_class` `response`, got `{frame_class}`"
                    ));
                }
                let has_result = frame.contains_key("result");
                let has_error = frame.get("error").is_some_and(|v| !v.is_null());
                if has_result == has_error {
                    violations.push(format!(
                        "{fixture_name}:{line_no}: JSON-RPC response must contain exactly one of `result` or non-null `error`"
                    ));
                }
            }
            (false, Some(_)) => {
                if frame_class != "notification" {
                    violations.push(format!(
                        "{fixture_name}:{line_no}: frame without `id` and with `method` must have `frame_class` `notification`, got `{frame_class}`"
                    ));
                }
            }
            (false, None) => {
                violations.push(format!(
                    "{fixture_name}:{line_no}: frame has neither `id` nor `method`"
                ));
            }
        }
    }

    if non_empty_lines == 0 {
        violations.push(format!("{fixture_name}: fixture contains zero JSONL frames"));
    }

    violations
}

#[tokio::test]
async fn handshake_capability_negotiation_engine_mode_and_multi_instance_isolation() {
    // 1. `VIBEX_ENGINE_MODE` grayscale routing (`native` vs `acp`).
    assert_eq!(
        resolve_native_engine_kind_with_env(
            "claude_code",
            EngineRuntimePreference::NativeFirst,
            None
        ),
        Some(NativeEngineKind::ClaudeNative)
    );
    assert_eq!(
        resolve_native_engine_kind_with_env("codex", EngineRuntimePreference::NativeFirst, None),
        Some(NativeEngineKind::CodexNative)
    );
    assert_eq!(
        resolve_native_engine_kind_with_env(
            "claude_code",
            EngineRuntimePreference::NativeFirst,
            Some("acp")
        ),
        None
    );
    assert_eq!(
        resolve_native_engine_kind_with_env(
            "codex",
            EngineRuntimePreference::AcpOnly,
            Some("native")
        ),
        Some(NativeEngineKind::CodexNative)
    );
    assert_eq!(
        resolve_native_engine_kind_with_env(
            "opencode",
            EngineRuntimePreference::NativeFirst,
            Some("native")
        ),
        None
    );

    // 2. Multi-instance cache key & per-instance isolated home/temp directories (`§5.1`).
    let ws = Uuid::new_v4();
    let mut spec_a = sample_spec("gpt-5-codex");
    spec_a.workspace_id = ws;
    spec_a.provider_instance_id = Some(format!("acct-alpha-{}", Uuid::new_v4()));
    spec_a.isolate_profile = true;
    spec_a.auth = EngineAuth::ApiKey {
        api_key: "sk-proj-alpha-secret-token".to_string(),
        base_url: Some("https://api.openai.com/v1".to_string()),
    };

    let mut spec_b = spec_a.clone();
    spec_b.provider_instance_id = Some(format!("acct-beta-{}", Uuid::new_v4()));
    spec_b.isolate_profile = true;
    spec_b.auth = EngineAuth::ApiKey {
        api_key: "sk-proj-beta-secret-token".to_string(),
        base_url: Some("https://proxy.example.com/v1".to_string()),
    };

    let fp_a = spec_a.auth_fingerprint();
    let fp_b = spec_b.auth_fingerprint();
    assert_eq!(fp_a.len(), 64);
    assert_ne!(fp_a, fp_b);
    assert!(!fp_a.contains("secret"));
    assert_ne!(
        CodexServerCacheKey::from_spec(&spec_a),
        CodexServerCacheKey::from_spec(&spec_b)
    );
    assert!(!spec_a.uses_custom_base_url(NativeEngineKind::CodexNative));
    assert!(spec_b.uses_custom_base_url(NativeEngineKind::CodexNative));

    let codex_iso = prepare_instance_isolation_env(&spec_a, NativeEngineKind::CodexNative)
        .expect("prepare codex isolation dirs");
    let codex_home = PathBuf::from(codex_iso.get("CODEX_HOME").expect("CODEX_HOME set"));
    assert!(codex_home.is_dir());
    let _ = std::fs::remove_dir_all(codex_home.parent().unwrap_or(&codex_home));

    let mut non_isolated = sample_spec("gpt-5.4");
    non_isolated.provider_instance_id = Some(format!("default-{}", Uuid::new_v4()));
    non_isolated.isolate_profile = false;
    let non_iso_codex =
        prepare_instance_isolation_env(&non_isolated, NativeEngineKind::CodexNative)
            .expect("non-isolated codex env");
    assert!(!non_iso_codex.contains_key("CODEX_HOME"));
    let non_iso_claude =
        prepare_instance_isolation_env(&non_isolated, NativeEngineKind::ClaudeNative)
            .expect("non-isolated claude env");
    assert!(!non_iso_claude.contains_key("CLAUDE_CONFIG_DIR"));
    if let Some(tmp) = non_iso_codex.get("TMP") {
        let tmp_path = PathBuf::from(tmp);
        let _ = std::fs::remove_dir_all(tmp_path.parent().unwrap_or(&tmp_path));
    }

    // 3. Codex & Claude duplex handshake negotiation.
    let (c_client, c_server) = tokio::io::duplex(64 * 1024);
    let (c_read, c_write) = tokio::io::split(c_client);
    let (s_read, mut s_write) = tokio::io::split(c_server);

    let codex_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(s_read).lines();
        let init_line = lines.next_line().await.unwrap().unwrap();
        let init_req: Value = serde_json::from_str(&init_line).unwrap();
        assert_eq!(init_req["method"], "initialize");
        assert_eq!(init_req["params"]["capabilities"]["experimentalApi"], true);
        write_rpc_ok(
            &mut s_write,
            &init_req.get("id").cloned(),
            json!({ "serverInfo": { "name": "codex-app-server" } }),
        )
        .await;
        let notif_line = lines.next_line().await.unwrap().unwrap();
        let notif: Value = serde_json::from_str(&notif_line).unwrap();
        assert_eq!(notif["method"], "initialized");
        assert!(notif.get("id").is_none());
    });

    let (codex_driver, codex_handle) =
        CodexNativeDriver::connect_duplex(spec_a, c_read, c_write, None)
            .await
            .expect("Codex connect_duplex succeeds");
    assert!(codex_handle.official_session);
    assert!(codex_driver.descriptor().supports_native_steer);
    assert!(!codex_driver.descriptor().supports_prompt_cache_ttl);
    codex_peer.await.unwrap();

    // Claude duplex handshake with third-party proxy (`official_session == false`).
    let mut proxy_claude_spec = sample_spec("claude-sonnet-4-5");
    proxy_claude_spec.auth = EngineAuth::ApiKey {
        api_key: "proxy-key".to_string(),
        base_url: Some("https://openrouter.example.com/anthropic".to_string()),
    };
    let (cl_client, cl_server) = tokio::io::duplex(64 * 1024);
    let (cl_read, cl_write) = tokio::io::split(cl_client);
    let (cls_read, mut cls_write) = tokio::io::split(cl_server);

    let claude_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(cls_read).lines();
        let init_line = lines.next_line().await.unwrap().unwrap();
        let init_req: Value = serde_json::from_str(&init_line).unwrap();
        assert_eq!(init_req["method"], "initialize");
        write_rpc_ok(
            &mut cls_write,
            &init_req.get("id").cloned(),
            json!({
                "protocolVersion": "1.0",
                "engineId": "claude-native",
                "officialAnthropicSession": false
            }),
        )
        .await;
    });

    let (claude_driver, claude_handle) =
        ClaudeNativeDriver::connect_duplex(proxy_claude_spec, cl_read, cl_write, None)
            .await
            .expect("Claude connect_duplex succeeds");
    assert!(!claude_handle.official_session);
    assert_eq!(claude_driver.cache_status(&claude_handle), None);
    claude_peer.await.unwrap();
}

#[tokio::test]
async fn high_frequency_streaming_burst_delivers_all_2500_deltas_and_turn_completed_without_lag() {
    const BURST_COUNT: usize = 2_500;

    // --- Part A: CodexNativeDriver 2,500-delta burst ---
    let (client_io, server_io) = tokio::io::duplex(256 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut server_write) = tokio::io::split(server_io);

    let codex_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).unwrap();
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();
            match method {
                "initialize" => {
                    write_rpc_ok(
                        &mut server_write,
                        &id,
                        json!({ "serverInfo": { "name": "codex" } }),
                    )
                    .await;
                }
                "initialized" => {}
                "thread/start" => {
                    write_rpc_ok(
                        &mut server_write,
                        &id,
                        json!({ "thread": { "id": "thr-burst" } }),
                    )
                    .await;
                }
                "turn/start" => {
                    write_rpc_ok(
                        &mut server_write,
                        &id,
                        json!({ "turn": { "id": "turn-burst" } }),
                    )
                    .await;
                    for i in 0..BURST_COUNT {
                        let frame = json!({
                            "jsonrpc": "2.0",
                            "method": "item/agentMessage/delta",
                            "params": {
                                "threadId": "thr-burst",
                                "itemId": "msg-burst",
                                "delta": format!("chunk-{i:04};")
                            }
                        });
                        let encoded = format!("{frame}\n");
                        server_write.write_all(encoded.as_bytes()).await.unwrap();
                    }
                    write_frame(
                        &mut server_write,
                        &json!({
                            "jsonrpc": "2.0",
                            "method": "turn/completed",
                            "params": {
                                "threadId": "thr-burst",
                                "turn": {
                                    "id": "turn-burst",
                                    "status": "completed",
                                    "model": "gpt-5-codex"
                                }
                            }
                        }),
                    )
                    .await;
                    break;
                }
                _ => {}
            }
        }
    });

    let (codex_driver, codex_handle) = CodexNativeDriver::connect_duplex(
        sample_spec("gpt-5-codex"),
        client_read,
        client_write,
        None,
    )
    .await
    .unwrap();

    let mut codex_stream = codex_driver
        .send_prompt(
            &codex_handle,
            EnginePromptRequest {
                prompt_id: Uuid::new_v4(),
                blocks: vec![ContentBlock::Text {
                    text: "stream 2500 deltas".into(),
                }],
                session_id: None,
                mode: PromptMode::Normal,
                ..Default::default()
            },
        )
        .await
        .unwrap();

    // Intentionally pause consumer so the reader loop enqueues the full burst first;
    // a bounded broadcast channel (`512`) would lag and drop frames here.
    tokio::time::sleep(Duration::from_millis(40)).await;

    let mut received_codex_deltas = Vec::with_capacity(BURST_COUNT);
    let mut codex_completed_model = None;
    while let Some(event) = codex_stream.next().await {
        match event {
            EngineEvent::AssistantTextDelta { text, .. } => received_codex_deltas.push(text),
            EngineEvent::TurnCompleted { served_model, .. } => {
                codex_completed_model = served_model;
            }
            _ => {}
        }
    }
    codex_peer.await.unwrap();

    assert_eq!(received_codex_deltas.len(), BURST_COUNT);
    assert_eq!(received_codex_deltas[0], "chunk-0000;");
    assert_eq!(received_codex_deltas[BURST_COUNT - 1], "chunk-2499;");
    assert_eq!(codex_completed_model.as_deref(), Some("gpt-5-codex"));

    // --- Part B: ClaudeNativeDriver 2,500-delta burst ---
    let (cl_client, cl_server) = tokio::io::duplex(256 * 1024);
    let (cl_read, cl_write) = tokio::io::split(cl_client);
    let (cls_read, mut cls_write) = tokio::io::split(cl_server);

    let claude_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(cls_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).unwrap();
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();
            match method {
                "initialize" => {
                    write_rpc_ok(
                        &mut cls_write,
                        &id,
                        json!({
                            "protocolVersion": "1.0",
                            "engineId": "claude-native",
                            "officialAnthropicSession": true
                        }),
                    )
                    .await;
                }
                "prompt/send" => {
                    let pid = req["params"]["promptId"].as_str().unwrap().to_string();
                    write_rpc_ok(
                        &mut cls_write,
                        &id,
                        json!({
                            "accepted": true,
                            "promptId": pid,
                            "sessionId": "claude-burst-1"
                        }),
                    )
                    .await;
                    for i in 0..BURST_COUNT {
                        let frame = json!({
                            "jsonrpc": "2.0",
                            "method": "engine/event",
                            "params": {
                                "kind": "assistant_text_delta",
                                "promptId": pid,
                                "sessionId": "claude-burst-1",
                                "text": format!("claude-{i:04};")
                            }
                        });
                        let encoded = format!("{frame}\n");
                        cls_write.write_all(encoded.as_bytes()).await.unwrap();
                    }
                    write_frame(
                        &mut cls_write,
                        &json!({
                            "jsonrpc": "2.0",
                            "method": "engine/event",
                            "params": {
                                "kind": "turn_completed",
                                "promptId": pid,
                                "sessionId": "claude-burst-1",
                                "stopReason": "end_turn",
                                "served_model": "claude-opus-4-6"
                            }
                        }),
                    )
                    .await;
                    break;
                }
                _ => {}
            }
        }
    });

    let (claude_driver, claude_handle) =
        ClaudeNativeDriver::connect_duplex(sample_spec("opus"), cl_read, cl_write, None)
            .await
            .unwrap();

    let mut claude_stream = claude_driver
        .send_prompt(
            &claude_handle,
            EnginePromptRequest {
                prompt_id: Uuid::new_v4(),
                blocks: vec![ContentBlock::Text {
                    text: "stream claude burst".into(),
                }],
                session_id: None,
                mode: PromptMode::Normal,
                ..Default::default()
            },
        )
        .await
        .unwrap();

    tokio::time::sleep(Duration::from_millis(40)).await;

    let mut received_claude_deltas = Vec::with_capacity(BURST_COUNT);
    let mut claude_completed_model = None;
    while let Some(event) = claude_stream.next().await {
        match event {
            EngineEvent::AssistantTextDelta { text, .. } => received_claude_deltas.push(text),
            EngineEvent::TurnCompleted { served_model, .. } => {
                claude_completed_model = served_model;
            }
            _ => {}
        }
    }
    claude_peer.await.unwrap();

    assert_eq!(received_claude_deltas.len(), BURST_COUNT);
    assert_eq!(received_claude_deltas[0], "claude-0000;");
    assert_eq!(received_claude_deltas[BURST_COUNT - 1], "claude-2499;");
    assert_eq!(claude_completed_model.as_deref(), Some("claude-opus-4-6"));
}

#[tokio::test]
async fn empty_and_error_turns_attach_redacted_stderr_tail_capped_at_64_kib() {
    // 1. Empty turn with stderr secrets -> TurnError with write-time redaction.
    let stderr_tail = Arc::new(StderrTail::new());
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut server_write) = tokio::io::split(server_io);

    let tail_for_peer = Arc::clone(&stderr_tail);
    let codex_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).unwrap();
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();
            match method {
                "initialize" => {
                    write_rpc_ok(&mut server_write, &id, json!({})).await;
                }
                "initialized" => {}
                "thread/start" => {
                    write_rpc_ok(
                        &mut server_write,
                        &id,
                        json!({ "thread": { "id": "thr-empty-err" } }),
                    )
                    .await;
                }
                "turn/start" => {
                    tail_for_peer.push(
                        "\u{1b}[31mFATAL auth failure: key=sk-ant-api03-SECRET1234567890abcdef \
                         Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secretpayload.sig\u{1b}[0m\n",
                    );
                    write_rpc_ok(
                        &mut server_write,
                        &id,
                        json!({ "turn": { "id": "turn-empty-1" } }),
                    )
                    .await;
                    // Complete turn with zero assistant text / tool output.
                    write_frame(
                        &mut server_write,
                        &json!({
                            "jsonrpc": "2.0",
                            "method": "turn/completed",
                            "params": {
                                "threadId": "thr-empty-err",
                                "turn": { "id": "turn-empty-1", "status": "completed" }
                            }
                        }),
                    )
                    .await;
                    break;
                }
                _ => {}
            }
        }
    });

    let (driver, handle) = CodexNativeDriver::connect_duplex(
        sample_spec("gpt-5-codex"),
        client_read,
        client_write,
        Some(Arc::clone(&stderr_tail)),
    )
    .await
    .unwrap();

    let events: Vec<EngineEvent> = driver
        .send_prompt(
            &handle,
            EnginePromptRequest {
                prompt_id: Uuid::new_v4(),
                blocks: vec![ContentBlock::Text {
                    text: "trigger empty turn".into(),
                }],
                session_id: None,
                mode: PromptMode::Normal,
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .collect()
        .await;
    codex_peer.await.unwrap();

    let turn_err_msg = events
        .iter()
        .find_map(|ev| match ev {
            EngineEvent::TurnError { message, .. } => Some(message.as_str()),
            _ => None,
        })
        .expect("zero-output turn with stderr must emit TurnError");
    assert!(turn_err_msg.contains("<redacted>"), "{turn_err_msg}");
    assert!(!turn_err_msg.contains("SECRET1234567890"));
    assert!(!turn_err_msg.contains("eyJhbGciOiJIUzI1NiJ9"));
    assert!(turn_err_msg.len() <= MAX_DIAGNOSTIC_PAYLOAD_BYTES);

    // 2. Oversized RPC error (`> 90 KiB`) + stderr secrets -> capped `<= 64 KiB` and redacted.
    let claude_tail = Arc::new(StderrTail::new());
    claude_tail.push("sidecar stderr token: Bearer eyJhbGciOiJIUzI1NiJ9.topsecret.payload\n");
    let (cl_client, cl_server) = tokio::io::duplex(256 * 1024);
    let (cl_read, cl_write) = tokio::io::split(cl_client);
    let (cls_read, mut cls_write) = tokio::io::split(cl_server);

    let claude_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(cls_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).unwrap();
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let id = req.get("id").cloned();
            match method {
                "initialize" => {
                    write_rpc_ok(
                        &mut cls_write,
                        &id,
                        json!({
                            "protocolVersion": "1.0",
                            "engineId": "claude-native",
                            "officialAnthropicSession": true
                        }),
                    )
                    .await;
                }
                "prompt/send" => {
                    let huge_noise = "X".repeat(90 * 1024);
                    let err_frame = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32001,
                            "message": format!(
                                "Upstream failed with apiKey=sk-ant-api03-SECRET1234567890abcdef {huge_noise}"
                            )
                        }
                    });
                    write_frame(&mut cls_write, &err_frame).await;
                    break;
                }
                _ => {}
            }
        }
    });

    let (cl_driver, cl_handle) = ClaudeNativeDriver::connect_duplex(
        sample_spec("claude-sonnet-4-5"),
        cl_read,
        cl_write,
        Some(claude_tail),
    )
    .await
    .unwrap();

    let err = match cl_driver
        .send_prompt(
            &cl_handle,
            EnginePromptRequest {
                prompt_id: Uuid::new_v4(),
                blocks: vec![ContentBlock::Text {
                    text: "oversized error".into(),
                }],
                session_id: None,
                mode: PromptMode::Normal,
                ..Default::default()
            },
        )
        .await
    {
        Ok(_) => panic!("RPC error object must fail send_prompt"),
        Err(err) => err,
    };
    claude_peer.await.unwrap();

    match err {
        EngineError::Rpc { code, message } => {
            assert_eq!(code, -32001);
            assert!(
                message.len() <= MAX_DIAGNOSTIC_PAYLOAD_BYTES,
                "len={}",
                message.len()
            );
            assert!(message.contains("<redacted>"));
            assert!(!message.contains("SECRET1234567890"));
            assert!(!message.contains("eyJhbGciOiJIUzI1NiJ9"));
        }
        other => panic!("expected EngineError::Rpc, got {other:?}"),
    }
}

#[tokio::test]
async fn bidirectional_server_request_approval_and_expected_revision_stale_rejection() {
    // --- Part A: Bidirectional JSON-RPC 2.0 `ServerRequest` (`id` + `method`) on Codex ---
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut server_write) = tokio::io::split(server_io);

    let observed_client_frames: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let frames_clone = Arc::clone(&observed_client_frames);

    let codex_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let msg: Value = serde_json::from_str(&line).unwrap();
            frames_clone.lock().unwrap().push(msg.clone());

            let method = msg.get("method").and_then(Value::as_str);
            let id = msg.get("id").cloned();

            if let Some(m) = method {
                assert_ne!(
                    m, "approval/respond",
                    "client must never call legacy approval/respond"
                );
                match m {
                    "initialize" => {
                        write_rpc_ok(&mut server_write, &id, json!({})).await;
                    }
                    "initialized" => {}
                    "thread/start" => {
                        write_rpc_ok(
                            &mut server_write,
                            &id,
                            json!({ "thread": { "id": "thr-bidi" } }),
                        )
                        .await;
                    }
                    "turn/start" => {
                        write_rpc_ok(
                            &mut server_write,
                            &id,
                            json!({ "turn": { "id": "turn-bidi" } }),
                        )
                        .await;
                        // Emit ServerRequest (`id` AND `method` both present) for command approval.
                        write_frame(
                            &mut server_write,
                            &json!({
                                "jsonrpc": "2.0",
                                "id": "srv-req-cmd-1",
                                "method": "item/commandExecution/requestApproval",
                                "params": {
                                    "threadId": "thr-bidi",
                                    "turnId": "turn-bidi",
                                    "approvalId": "perm-cmd-1",
                                    "command": ["git", "status"]
                                }
                            }),
                        )
                        .await;
                    }
                    _ => {}
                }
            } else if id == Some(json!("srv-req-cmd-1")) {
                // Client replied with a real JSON-RPC 2.0 response! Now test requestUserInput.
                assert_eq!(msg["result"]["decision"], "accept");
                write_frame(
                    &mut server_write,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": 202,
                        "method": "item/tool/requestUserInput",
                        "params": {
                            "threadId": "thr-bidi",
                            "turnId": "turn-bidi",
                            "requestId": "perm-input-202",
                            "questions": [{
                                "id": "env_target",
                                "options": [{ "label": "staging" }, { "label": "prod" }]
                            }]
                        }
                    }),
                )
                .await;
            } else if id == Some(json!(202)) {
                assert_eq!(msg["result"]["answers"]["env_target"]["answers"], json!(["staging"]));
                write_frame(
                    &mut server_write,
                    &json!({
                        "jsonrpc": "2.0",
                        "method": "item/agentMessage/delta",
                        "params": { "threadId": "thr-bidi", "delta": "Approved and answered." }
                    }),
                )
                .await;
                write_frame(
                    &mut server_write,
                    &json!({
                        "jsonrpc": "2.0",
                        "method": "turn/completed",
                        "params": {
                            "threadId": "thr-bidi",
                            "turn": { "id": "turn-bidi", "status": "completed" }
                        }
                    }),
                )
                .await;
                break;
            }
        }
    });

    let (driver, handle) = CodexNativeDriver::connect_duplex(
        sample_spec("gpt-5-codex"),
        client_read,
        client_write,
        None,
    )
    .await
    .unwrap();

    let mut stream = driver
        .send_prompt(
            &handle,
            EnginePromptRequest {
                prompt_id: Uuid::new_v4(),
                blocks: vec![ContentBlock::Text {
                    text: "run interactive command".into(),
                }],
                session_id: None,
                mode: PromptMode::Normal,
                ..Default::default()
            },
        )
        .await
        .unwrap();

    let mut completed = false;
    while let Some(ev) = stream.next().await {
        match ev {
            EngineEvent::PermissionRequested {
                permission_id,
                options,
                ..
            } => {
                assert!(!options.is_empty());
                driver
                    .respond_permission(
                        &handle,
                        EnginePermissionDecision {
                            permission_id,
                            approved: true,
                            option_id: Some("accept".to_string()),
                            updated_input: None,
                            message: None,
                            interrupt: false,
                        },
                    )
                    .await
                    .unwrap();
            }
            EngineEvent::QuestionRequested {
                request_id,
                questions,
                ..
            } => {
                assert_eq!(questions.as_array().unwrap().len(), 1);
                driver
                    .respond_question(
                        &handle,
                        &request_id,
                        json!({ "env_target": "staging" }),
                        false,
                    )
                    .await
                    .unwrap();
            }
            EngineEvent::TurnCompleted { .. } => {
                completed = true;
            }
            _ => {}
        }
    }
    assert!(completed);
    codex_peer.await.unwrap();

    // --- Part B: Control-Plane `expected_revision` Stale Rejection vs Matching Acceptance ---
    let (tx, mut rx) = mpsc::unbounded_channel();
    let runtime = AgentRuntime::new_with_driver(Arc::new(ChannelSink { tx }), false);
    let agent_id = AgentId::parse("claude_code").unwrap();

    let prepared = runtime
        .prepare_session(EnsureAgentSessionInput {
            agent_id: agent_id.clone(),
            launch_lock: SessionLaunchLock {
                agent_id: agent_id.clone(),
                absolute_acp_program: PathBuf::from("/tmp/vibex-fixture-acp"),
                args: Vec::new(),
                env: BTreeMap::new(),
                runtime_version: "fixture".into(),
                acp_version: "fixture".into(),
            },
            workspace_id: Uuid::new_v4(),
            working_dir: std::env::temp_dir(),
            additional_directories: Vec::new(),
            session_id: AgentSessionId::new(),
            acp_session_id: String::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
            preferences: Default::default(),
        })
        .await
        .unwrap();
    let session = prepared.session;

    let prompt = runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: session.connection_id,
            session_id: session.id.clone(),
            blocks: vec![AgentContentBlock::Text {
                text: FULL_GATE_FIXTURE_PROMPT.to_string(),
            }],
            mode_override: None,
            config_overrides: Vec::new(),
        })
        .await
        .unwrap();
    assert!(matches!(prompt.status, AgentPromptStatus::Running));

    let permission_req = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(env) = rx.recv().await {
            if env.connection_id == session.connection_id
                && let AgentEvent::PermissionRequested { request } = env.event
            {
                return request;
            }
        }
        panic!("permission request channel closed");
    })
    .await
    .expect("timed out waiting for PermissionRequested");
    assert!(permission_req.revision >= 1);

    // 1) Stale `expected_revision` must be rejected without resolving or removing `pending`.
    let stale_rev = permission_req.revision + 99;
    runtime
        .respond_permission(RespondAgentPermissionInput {
            connection_id: session.connection_id,
            permission_id: permission_req.id.clone(),
            response: AgentPermissionResponse::selected_with_revision("allow-once", stale_rev),
        })
        .await
        .unwrap();

    let stale_diag = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(env) = rx.recv().await {
            if env.connection_id == session.connection_id
                && let AgentEvent::RawAcpDiagnostic { raw } = env.event
                && raw.get("kind").and_then(Value::as_str)
                    == Some("stale_permission_revision_rejected")
            {
                return raw;
            }
        }
        panic!("channel closed waiting for stale_permission_revision_rejected");
    })
    .await
    .expect("expected stale_permission_revision_rejected diagnostic");
    assert_eq!(stale_diag["expected_revision"], stale_rev);
    assert_eq!(stale_diag["actual_revision"], permission_req.revision);

    // 2) Matching `expected_revision` resolves the still-pending approval and finishes the turn!
    runtime
        .respond_permission(RespondAgentPermissionInput {
            connection_id: session.connection_id,
            permission_id: permission_req.id,
            response: AgentPermissionResponse::selected_with_revision(
                "allow-once",
                permission_req.revision,
            ),
        })
        .await
        .unwrap();

    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(env) = rx.recv().await {
            if env.connection_id == session.connection_id
                && let AgentEvent::PromptFinished { finished } = env.event
                && finished.prompt_id == prompt.id
            {
                assert_eq!(finished.stop_reason.as_deref(), Some("end_turn"));
                return;
            }
        }
        panic!("channel closed waiting for PromptFinished");
    })
    .await
    .expect("matching revision must allow turn to finish");
}

#[tokio::test]
async fn steer_fork_fail_closed_official_thread_rollback_and_model_consistency() {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (client_read, client_write) = tokio::io::split(client_io);
    let (server_read, mut server_write) = tokio::io::split(server_io);

    let wire_methods: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let wire_methods_clone = Arc::clone(&wire_methods);

    let codex_peer = tokio::spawn(async move {
        let mut lines = BufReader::new(server_read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let req: Value = serde_json::from_str(&line).unwrap();
            let method = req
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let id = req.get("id").cloned();
            wire_methods_clone.lock().unwrap().push(method.clone());

            match method.as_str() {
                "initialize" => write_rpc_ok(&mut server_write, &id, json!({})).await,
                "initialized" => {}
                "turn/steer" => {
                    write_rpc_ok(&mut server_write, &id, json!({ "turnId": "turn-7" })).await;
                }
                "thread/fork" => {
                    assert_eq!(req["params"]["beforeTurnId"], "turn-7");
                    write_rpc_ok(
                        &mut server_write,
                        &id,
                        json!({ "thread": { "id": "thr-fork-9" } }),
                    )
                    .await;
                }
                "thread/rollback" => {
                    assert_eq!(req["params"]["beforeTurnId"], "turn-7");
                    write_rpc_ok(&mut server_write, &id, json!({ "rolledBack": true })).await;
                    break;
                }
                other => panic!("unexpected Codex RPC method `{other}`"),
            }
        }
    });

    let (codex_driver, codex_handle) = CodexNativeDriver::connect_duplex(
        sample_spec("gpt-5-codex"),
        client_read,
        client_write,
        None,
    )
    .await
    .unwrap();
    codex_handle.set_external_session_id(Some("thr-main-1".to_string()));

    // Fail-closed validation on empty/whitespace anchor (`§3.3`) BEFORE sending any RPC!
    let empty_fork_err = codex_driver
        .fork_session(
            &codex_handle,
            EngineForkRequest {
                source_session_id: None,
                new_session_id: None,
                checkpoint_point: Some("   ".to_string()),
            },
        )
        .await
        .expect_err("whitespace fork checkpoint_point must fail closed");
    assert!(matches!(empty_fork_err, EngineError::InvalidRequest(_)));

    let empty_revert_err = codex_driver
        .revert_to(
            &codex_handle,
            EngineCheckpoint {
                turn_ordinal: 1,
                git_ref: None,
                commit_oid: None,
                external_session_point: Some("".to_string()),
                session_id: None,
            },
        )
        .await
        .expect_err("empty revert external_session_point must fail closed");
    assert!(matches!(empty_revert_err, EngineError::InvalidRequest(_)));

    // Valid steer, fork, and official `thread/rollback`.
    let steer_receipt = codex_driver
        .steer(
            &codex_handle,
            EngineSteerRequest {
                steering_id: Uuid::new_v4(),
                expected_prompt_id: None,
                session_id: None,
                blocks: vec![ContentBlock::Text {
                    text: "Focus on rollback contract".into(),
                }],
            },
        )
        .await
        .unwrap();
    assert!(matches!(steer_receipt, EngineSteerReceipt::Accepted { .. }));

    let fork_receipt = codex_driver
        .fork_session(
            &codex_handle,
            EngineForkRequest {
                source_session_id: None,
                new_session_id: None,
                checkpoint_point: Some("turn-7".to_string()),
            },
        )
        .await
        .unwrap();
    assert_eq!(fork_receipt.forked_session_id, "thr-fork-9");

    codex_driver
        .revert_to(
            &codex_handle,
            EngineCheckpoint {
                turn_ordinal: 7,
                git_ref: None,
                commit_oid: None,
                external_session_point: Some("turn-7".to_string()),
                session_id: None,
            },
        )
        .await
        .unwrap();
    codex_peer.await.unwrap();

    let recorded_methods = wire_methods.lock().unwrap().clone();
    assert!(recorded_methods.iter().any(|m| m == "thread/rollback"));
    assert!(!recorded_methods.iter().any(|m| m == "thread/revert"));

    // Launch vs Served model consistency (`§4.3`).
    assert!(check_launch_vs_served_model(Some("opus"), Some("claude-opus-4-6"), false).is_none());
    assert!(
        check_launch_vs_served_model(
            Some("claude-sonnet-4-5"),
            Some("claude-sonnet-4-5-20250929"),
            false
        )
        .is_none()
    );
    let mismatch = check_launch_vs_served_model(
        Some("claude-opus-4-6"),
        Some("claude-3-5-haiku-20241022"),
        true,
    )
    .expect("silent proxy downgrade must produce ModelConsistencyMismatch");
    assert_eq!(mismatch.requested_model, "claude-opus-4-6");
    assert_eq!(mismatch.served_model, "claude-3-5-haiku-20241022");
    assert!(mismatch.custom_base_url);
}

#[test]
fn golden_jsonl_fixtures_pass_and_exhaustive_validator_reports_all_defects_without_fail_fast() {
    let codex_violations =
        validate_golden_fixture_exhaustively("codex_app_server_golden.jsonl", CODEX_GOLDEN_JSONL);
    assert!(
        codex_violations.is_empty(),
        "codex golden fixture had violations: {codex_violations:#?}"
    );

    let claude_violations =
        validate_golden_fixture_exhaustively("claude_sidecar_golden.jsonl", CLAUDE_GOLDEN_JSONL);
    assert!(
        claude_violations.is_empty(),
        "claude golden fixture had violations: {claude_violations:#?}"
    );

    // Construct a multi-violation synthetic fixture across 5 lines to prove non-fail-fast
    // exhaustive error collection (`N` defects reported in 1 pass, never stopping at line 1).
    let oversized_blob = "Z".repeat(MAX_DIAGNOSTIC_PAYLOAD_BYTES + 512);
    let synthetic_bad_jsonl = [
        // Line 1: unredacted Anthropic key + missing `"jsonrpc": "2.0"`
        r#"{"seq":1,"direction":"client_to_server","frame_class":"request","frame":{"id":1,"method":"initialize","params":{"apiKey":"sk-ant-api03-LEAKED123456"}}}"#.to_string(),
        // Line 2: malformed JSON
        r#"{"seq":2,"direction":"server_to_client","broken_json""#.to_string(),
        // Line 3: forbidden legacy `"thread/revert"` + wrong `frame_class` (`notification` despite `id`)
        r#"{"seq":3,"direction":"client_to_server","frame_class":"notification","frame":{"jsonrpc":"2.0","id":2,"method":"thread/revert","params":{}}}"#.to_string(),
        // Line 4: forbidden `"approval/respond"` + unredacted `Bearer eyJ`
        r#"{"seq":4,"direction":"client_to_server","frame_class":"request","frame":{"jsonrpc":"2.0","id":3,"method":"approval/respond","params":{"hdr":"Bearer eyJhbGciOiJIUzI1NiJ9.leaked"}}}"#.to_string(),
        // Line 5: oversized > 64 KiB payload
        format!(
            r#"{{"seq":5,"direction":"server_to_client","frame_class":"notification","frame":{{"jsonrpc":"2.0","method":"engine/event","params":{{"blob":"{oversized_blob}"}}}}}}"#
        ),
    ]
    .join("\n");

    let defects = validate_golden_fixture_exhaustively("synthetic_bad.jsonl", &synthetic_bad_jsonl);
    assert!(
        defects.len() >= 7,
        "expected all defects across all 5 lines in one pass, got {}: {defects:#?}",
        defects.len()
    );
    assert!(defects.iter().any(|d| d.contains("synthetic_bad.jsonl:1:") && d.contains("sk-ant-")));
    assert!(defects.iter().any(|d| d.contains("synthetic_bad.jsonl:1:") && d.contains("jsonrpc")));
    assert!(defects.iter().any(|d| d.contains("synthetic_bad.jsonl:2:") && d.contains("invalid JSON")));
    assert!(defects.iter().any(|d| d.contains("synthetic_bad.jsonl:3:") && d.contains("thread/revert")));
    assert!(defects.iter().any(|d| d.contains("synthetic_bad.jsonl:4:") && d.contains("approval/respond")));
    assert!(defects.iter().any(|d| d.contains("synthetic_bad.jsonl:4:") && d.contains("Bearer eyJ")));
    assert!(defects.iter().any(|d| d.contains("synthetic_bad.jsonl:5:") && d.contains("MAX_DIAGNOSTIC_PAYLOAD_BYTES")));
}

#[tokio::test]
async fn native_runner_e2e_routing_session_linking_controls_elicitation_deny_and_rollback() {
    let temp_dir = std::env::temp_dir().join(format!("vibex-native-e2e-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).unwrap();
    let mock_js = temp_dir.join("mock-codex.mjs");
    std::fs::write(&mock_js, r#"import readline from 'node:readline';
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'codex' } } });
  else if (msg.method === 'account/rateLimits/read') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  else if (msg.method === 'model/list') send({ jsonrpc: '2.0', id: msg.id, result: { data: [{ id: 'gpt-5.4', displayName: 'GPT-5.4' }] } });
  else if (msg.method === 'thread/start') send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr-native-e2e', model: 'gpt-5.4' } } });
  else if (msg.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-e2e-1' } } });
    send({ jsonrpc: '2.0', method: 'turn/plan/updated', params: { threadId: 'thr-native-e2e', plan: [{ step: 'Verify native runner', status: 'in_progress' }] } });
    send({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'thr-native-e2e', item: { id: 'cmd-1', type: 'commandExecution', command: ['echo', 'hi'] } } });
    send({ jsonrpc: '2.0', method: 'item/commandExecution/outputDelta', params: { threadId: 'thr-native-e2e', itemId: 'cmd-1', delta: 'line-1\n' } });
    send({ jsonrpc: '2.0', method: 'item/commandExecution/outputDelta', params: { threadId: 'thr-native-e2e', itemId: 'cmd-1', delta: 'line-2\n' } });
    send({ jsonrpc: '2.0', id: 'perm-req-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thr-native-e2e', turnId: 'turn-e2e-1', approvalId: 'perm-e2e-1', command: ['rm', '-rf', 'tmp'] } });
  } else if (msg.id === 'perm-req-1' && !msg.method) {
    if (msg.result?.decision !== 'decline') process.exit(2);
    send({ jsonrpc: '2.0', id: 'ask-req-1', method: 'item/tool/requestUserInput', params: { threadId: 'thr-native-e2e', turnId: 'turn-e2e-1', requestId: 'q-e2e-1', questions: [{ id: 'target_env', question: 'Target env?', options: [{ label: 'staging' }, { label: 'prod' }] }] } });
  } else if (msg.id === 'ask-req-1' && !msg.method) {
    const ans = msg.result?.answers?.target_env?.answers?.[0] ?? '';
    send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thr-native-e2e', itemId: 'm-1', delta: `Deployed to ${ans}` } });
    send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'thr-native-e2e', tokenUsage: { total: { inputTokens: 120, outputTokens: 45, cachedInputTokens: 20 }, modelContextWindow: 200000 } } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thr-native-e2e', turn: { id: 'turn-e2e-1', status: 'completed', model: 'gpt-5.4' } } });
  } else if (msg.method === 'thread/rollback') send({ jsonrpc: '2.0', id: msg.id, result: { rolledBack: true } });
});
"#).unwrap();

    #[cfg(windows)]
    let wrapper_path = { let p = temp_dir.join("codex.cmd"); std::fs::write(&p, format!("@node \"{}\" %*\r\n", mock_js.display())).unwrap(); p };
    #[cfg(not(windows))]
    let wrapper_path = { use std::os::unix::fs::PermissionsExt; let p = temp_dir.join("codex"); std::fs::write(&p, format!("#!/bin/sh\nexec node \"{}\" \"$@\"\n", mock_js.display())).unwrap(); std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap(); p };

    let (tx, mut rx) = mpsc::unbounded_channel();
    let runtime = AgentRuntime::new(Arc::new(ChannelSink { tx }));
    let codex_id = AgentId::parse("codex").unwrap();
    let make_input = |program: PathBuf, bin_override: &std::path::Path| {
        let env = HashMap::from([("VIBEX_CODEX_PATH".into(), bin_override.display().to_string())]);
        EnsureAgentSessionInput {
            agent_id: codex_id.clone(),
            launch_lock: SessionLaunchLock { agent_id: codex_id.clone(), absolute_acp_program: program, args: Vec::new(), env: BTreeMap::new(), runtime_version: "test".into(), acp_version: "test".into() },
            workspace_id: Uuid::new_v4(), working_dir: temp_dir.clone(), additional_directories: Vec::new(),
            session_id: AgentSessionId::new(), acp_session_id: String::new(), auto_approve_mode: AgentAutoApproveMode::Off,
            env, preferences: Default::default(),
        }
    };

    let missing_bin = temp_dir.join("missing-codex");
    assert!(runtime.prepare_session(make_input(missing_bin.clone(), &missing_bin)).await.is_err());

    let prepared = runtime.prepare_session(make_input(temp_dir.join("legacy-codex-acp"), &wrapper_path)).await.unwrap();
    assert!(prepared.session.acp_session_id.starts_with("prepared-"));
    assert_eq!(runtime.bound_acp_session_id(prepared.session.id).await, None);
    assert!(runtime.has_bound_acp_session(prepared.session.id).await);
    assert!(prepared.controls.modes.iter().any(|m| m.id == "plan"));
    assert!(prepared.controls.config_options.iter().any(|o| o.key == "effort"));
    assert!(!prepared.controls.available_commands.as_deref().unwrap_or_default().is_empty());

    let mode_controls = runtime.set_session_mode(prepared.session.id, "default").await.unwrap();
    assert_eq!(mode_controls.current_mode.as_deref(), Some("default"));
    let cfg_controls = runtime.set_session_config_option(prepared.session.id, "effort", json!("high")).await.unwrap();
    assert!(cfg_controls.config_options.iter().any(|o| o.key == "effort" && o.value == Some(json!("high"))));

    let prompt = runtime.send_prompt(SendAgentPromptInput {
        connection_id: prepared.session.connection_id, session_id: prepared.session.id,
        blocks: vec![AgentContentBlock::Text { text: "deploy".into() }], mode_override: None, config_overrides: Vec::new(),
    }).await.unwrap();

    let (mut saw_linked, mut saw_plan, mut saw_cum_term, mut saw_usage, mut saw_text) =
        (false, false, false, false, String::new());
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(env) = rx.recv().await {
            if env.connection_id != prepared.session.connection_id {
                continue;
            }
            match env.event {
                AgentEvent::SessionLinked { acp_session_id, .. } => {
                    assert_eq!(acp_session_id, "thr-native-e2e");
                    saw_linked = true;
                }
                AgentEvent::Plan { plan } => {
                    assert_eq!(plan.entries.len(), 1);
                    saw_plan = true;
                }
                AgentEvent::ToolCallUpdate { update }
                    if update.content.as_deref() == Some("line-1\nline-2\n") =>
                {
                    saw_cum_term = true;
                }
                AgentEvent::PermissionRequested { request } => {
                    assert!(request.details.as_ref().unwrap().to_string().contains("command"));
                    let reject_id = request
                        .options
                        .iter()
                        .find(|o| matches!(o.kind, agents::AgentPermissionOptionKind::RejectOnce))
                        .unwrap()
                        .id
                        .clone();
                    runtime
                        .respond_permission(RespondAgentPermissionInput {
                            connection_id: prepared.session.connection_id,
                            permission_id: request.id,
                            response: AgentPermissionResponse::selected_with_revision(reject_id, request.revision),
                        })
                        .await
                        .unwrap();
                }
                AgentEvent::ElicitationRequested { request } => {
                    assert!(request.requested_schema.get("x-vibex-questions").is_some());
                    runtime
                        .respond_elicitation(RespondAgentElicitationInput {
                            connection_id: prepared.session.connection_id,
                            elicitation_id: request.id,
                            response: AgentElicitationResponse::Accept { content: json!({ "target_env": "staging" }) },
                        })
                        .await
                        .unwrap();
                }
                AgentEvent::Usage { usage } => {
                    assert_eq!(usage.input_tokens, Some(120));
                    saw_usage = true;
                }
                AgentEvent::MessageChunk { content: AgentContentBlock::Text { text } } => {
                    saw_text.push_str(&text);
                }
                AgentEvent::PromptFinished { finished } if finished.prompt_id == prompt.id => {
                    assert!(finished.usage.is_some());
                    break;
                }
                _ => {}
            }
        }
    })
    .await
    .expect("native e2e turn must complete within 10s");

    assert!(saw_linked && saw_plan && saw_cum_term && saw_usage);
    assert_eq!(saw_text, "Deployed to staging");
    assert_eq!(runtime.bound_acp_session_id(prepared.session.id).await.as_deref(), Some("thr-native-e2e"));

    runtime
        .rollback_turns(prepared.session.id, 1, Some("turn-e2e-1".into()), None, None)
        .await
        .expect("rollback_turns over native Codex engine succeeds");
    let _ = runtime.disconnect(prepared.session.connection_id).await;
    let _ = std::fs::remove_dir_all(&temp_dir);
}
