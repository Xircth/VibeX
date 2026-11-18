use super::*;

#[test]
fn cap_json_value_truncates_oversized_tool_payloads() {
    let huge = "x".repeat(MAX_TIMELINE_PREVIEW_BYTES + 64);
    let capped = cap_json_value(serde_json::json!({ "output": huge }));
    let serde_json::Value::String(text) = capped else {
        panic!("oversized JSON must collapse to a truncated string preview");
    };
    assert!(text.len() <= MAX_TIMELINE_PREVIEW_BYTES + 4);
    assert!(text.starts_with("…\n"));
}

#[test]
fn cap_preview_bytes_preserves_multibyte_tail_error_summary_and_strips_partial_ansi() {
    let head_padding = "编译输出日志行：正在构建模块……\n".repeat(600);
    assert!(head_padding.len() > MAX_TIMELINE_PREVIEW_BYTES);
    let error_tail = "\u{1b}[31merror[E0308]: 类型不匹配，最终编译失败摘要\u{1b}[0m\n";
    let trailing_broken_ansi = "\u{1b}[38;5;196";
    let input = format!("{head_padding}{error_tail}{trailing_broken_ansi}");

    let capped = cap_preview_bytes(input);
    assert!(capped.starts_with("…\n"));
    assert!(capped.len() <= MAX_TIMELINE_PREVIEW_BYTES + 4);
    assert!(
        capped.contains("error[E0308]: 类型不匹配，最终编译失败摘要"),
        "tail error summary must be preserved: {capped:?}"
    );
    assert!(
        !capped.ends_with("\u{1b}[38;5;196"),
        "partial trailing ANSI CSI must be stripped: {capped:?}"
    );
    assert!(capped.ends_with("\u{1b}[0m\n"));
    assert!(!capped.contains('\u{fffd}'));
}

#[test]
fn cap_timeline_preview_fields_keeps_small_tool_output() {
    let mut timeline = ConversationTimeline {
        conversation_id: Uuid::nil(),
        projection_version: 1,
        last_sequence: 1,
        rows: vec![TimelineRow {
            row_id: "row-1".into(),
            revision: 1,
            row: ConversationTimelineRow::MessageTurn {
                turn: MessageTurn {
                    id: "t1".into(),
                    role: TurnRole::Assistant,
                    blocks: vec![ContentBlock::ToolResult {
                        tool_use_id: Some("tool-1".into()),
                        output_preview: Some("all green".into()),
                        is_error: false,
                        agent_stats: None,
                    }],
                    timestamp: Utc::now(),
                    usage: None,
                    duration_ms: None,
                    model: None,
                    completed_at: None,
                    agent_message_id: None,
                },
                phase: "settled".into(),
                fork_point_status: None,
            },
        }],
        truncated_from_start: false,
        older_cursor: None,
    };
    cap_timeline_preview_fields(&mut timeline);
    match &timeline.rows[0].row {
        ConversationTimelineRow::MessageTurn { turn, .. } => match &turn.blocks[0] {
            ContentBlock::ToolResult { output_preview, .. } => {
                assert_eq!(output_preview.as_deref(), Some("all green"));
            }
            other => panic!("unexpected block: {other:?}"),
        },
        other => panic!("unexpected row: {other:?}"),
    }
}

fn window_message_row(blocks: Vec<ContentBlock>) -> TimelineRow {
    TimelineRow {
        row_id: "655f4f3e-082e-4ffb-bec2-ef716d25719f:assistant".into(),
        revision: 1,
        row: ConversationTimelineRow::MessageTurn {
            turn: MessageTurn {
                id: "655f4f3e-082e-4ffb-bec2-ef716d25719f:assistant".into(),
                role: TurnRole::Assistant,
                blocks,
                timestamp: Utc::now(),
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: None,
                agent_message_id: None,
            },
            phase: "settled".into(),
            fork_point_status: None,
        },
    }
}

#[test]
fn shrink_timeline_row_for_window_keeps_assistant_text_and_shrinks_tool_preview() {
    let reply = "无限画布上按住 Ctrl 再滚动，回复仍然在。";
    let huge = "x".repeat(2_000_000);
    let mut row = window_message_row(vec![
        ContentBlock::ToolResult {
            tool_use_id: Some("tool-1".into()),
            output_preview: Some(huge),
            is_error: false,
            agent_stats: None,
        },
        ContentBlock::Text {
            text: reply.to_string(),
        },
    ]);
    let size = shrink_timeline_row_for_window(&mut row);
    assert!(size <= 256 * 1024, "shrunk row is {size} bytes");
    match &row.row {
        ConversationTimelineRow::MessageTurn { turn, .. } => {
            match &turn.blocks[0] {
                ContentBlock::ToolResult { output_preview, .. } => {
                    let preview = output_preview.as_deref().unwrap_or("");
                    assert!(preview.len() < 20_000, "preview is {} bytes", preview.len());
                    assert!(preview.starts_with("…\n"));
                }
                other => panic!("unexpected block: {other:?}"),
            }
            match &turn.blocks[1] {
                ContentBlock::Text { text } => assert_eq!(text, reply),
                other => panic!("unexpected block: {other:?}"),
            }
        }
        other => panic!("unexpected row: {other:?}"),
    }
}

#[test]
fn shrink_timeline_row_for_window_truncates_thinking_not_text() {
    let reply = "最终回复保持完整。";
    let thinking = format!("{}TAIL", "思考".repeat(200_000));
    let mut row = window_message_row(vec![
        ContentBlock::Thinking {
            text: thinking.clone(),
        },
        ContentBlock::Text {
            text: reply.to_string(),
        },
    ]);
    let size = shrink_timeline_row_for_window(&mut row);
    assert!(size <= 256 * 1024, "shrunk row is {size} bytes");
    match &row.row {
        ConversationTimelineRow::MessageTurn { turn, .. } => {
            match &turn.blocks[0] {
                ContentBlock::Thinking { text } => {
                    assert!(text.len() < thinking.len());
                    assert!(text.ends_with("TAIL"));
                    assert!(
                        text.len() <= 2 * 1024 + 4,
                        "thinking is {} bytes",
                        text.len()
                    );
                }
                other => panic!("unexpected block: {other:?}"),
            }
            match &turn.blocks[1] {
                ContentBlock::Text { text } => assert_eq!(text, reply),
                other => panic!("unexpected block: {other:?}"),
            }
        }
        other => panic!("unexpected row: {other:?}"),
    }
}

#[test]
fn capability_snapshot_defaults_are_degraded() {
    let snapshot = AcpCapabilitySnapshot::default();

    assert!(!snapshot.load_session);
    assert!(!snapshot.resume_session);
    assert!(!snapshot.close_session);
    assert!(!snapshot.terminal);
    assert!(!snapshot.mcp_stdio);
    assert!(!snapshot.prompt.text);
}

#[test]
fn conversation_event_round_trips_coverage_cases() {
    let events = vec![
        ConversationEvent::UserTurnCreated {
            blocks: vec![ConversationInputBlock::Text {
                text: "create slides".to_string(),
            }],
            workflow_refs: vec![ConversationWorkflowRef {
                plugin_id: "dimo.office".to_string(),
                workflow_id: "create-presentation".to_string(),
            }],
        },
        ConversationEvent::QuestionRequested {
            request: ConversationQuestionRequest {
                question_id: "q1".to_string(),
                prompt: "Continue?".to_string(),
                options: vec!["yes".to_string(), "no".to_string()],
                asked_at: None,
                schema: None,
            },
        },
        ConversationEvent::FeedbackRequested {
            request: ConversationFeedbackRequest {
                feedback_id: "f1".to_string(),
                prompt: "Rate this".to_string(),
            },
        },
        ConversationEvent::DelegationStarted {
            delegation: ConversationDelegation {
                delegation_id: "d1".to_string(),
                parent_tool_call_id: "tool1".to_string(),
                child_conversation_id: Uuid::new_v4(),
                agent_id: AgentId::parse("codex").unwrap(),
                task_preview: "child work".to_string(),
            },
        },
        ConversationEvent::SessionConfigStale {
            stale: true,
            reason: Some("config changed".to_string()),
        },
        ConversationEvent::PromptCapabilitiesUpdated {
            capabilities: AgentPromptCapabilities {
                text: true,
                image: true,
                audio: false,
                resource: false,
                resource_link: false,
            },
        },
        ConversationEvent::AgentBindingLoadFailed {
            reason: SessionLoadFailureReason::ResourceNotFound,
        },
        ConversationEvent::ConversationSteering {
            event: ConversationSteeringEvent::Accepted {
                steering_id: Uuid::nil(),
                expected_turn_id: Uuid::nil(),
                delivery_mode: Some(ConversationSteeringDeliveryMode::InterruptRestart),
                restarted_turn_id: Some(Uuid::nil()),
            },
        },
    ];

    for event in events {
        let value = serde_json::to_value(&event).expect("serialize event");
        assert!(value["kind"].as_str().is_some());
        let roundtrip: ConversationEvent =
            serde_json::from_value(value).expect("deserialize event");
        assert_eq!(roundtrip, event);
    }
}

#[test]
fn legacy_steering_accepted_without_delivery_mode_remains_deserializable() {
    let event: ConversationSteeringEvent = serde_json::from_value(serde_json::json!({
        "kind": "accepted",
        "steering_id": Uuid::nil(),
        "expected_turn_id": Uuid::nil()
    }))
    .expect("legacy steering accepted event remains readable");

    assert_eq!(
        event,
        ConversationSteeringEvent::Accepted {
            steering_id: Uuid::nil(),
            expected_turn_id: Uuid::nil(),
            delivery_mode: None,
            restarted_turn_id: None,
        }
    );
}

#[test]
fn legacy_delegation_agent_type_remains_deserializable() {
    let event: ConversationEvent = serde_json::from_value(serde_json::json!({
        "kind": "delegation_started",
        "delegation": {
            "delegation_id": "delegation-1",
            "parent_tool_call_id": "tool-1",
            "child_conversation_id": Uuid::nil(),
            "agent_type": "codex",
            "task_preview": "review the change"
        }
    }))
    .expect("legacy delegation event should remain readable");

    assert!(matches!(
        event,
        ConversationEvent::DelegationStarted {
            delegation: ConversationDelegation { agent_id, .. }
        } if agent_id.as_str() == "codex"
    ));
}

#[test]
fn legacy_user_turn_without_plugin_actions_remains_deserializable() {
    let event: ConversationEvent = serde_json::from_value(serde_json::json!({
        "kind": "user_turn_created",
        "blocks": [{ "kind": "text", "text": "hello" }]
    }))
    .expect("legacy user turn should remain readable");

    assert!(matches!(
        event,
        ConversationEvent::UserTurnCreated { workflow_refs, .. }
            if workflow_refs.is_empty()
    ));
}

#[test]
fn turn_error_kind_uses_protocol_and_structured_data_never_message_text() {
    use super::{ConversationTurnErrorKind, classify_turn_error};

    assert_eq!(
        classify_turn_error(Some("invalid_params"), None),
        ConversationTurnErrorKind::Rejected
    );
    assert_eq!(
        classify_turn_error(Some("internal_error"), None),
        ConversationTurnErrorKind::ServiceError
    );
    assert_eq!(
        classify_turn_error(Some("connection_closed"), None),
        ConversationTurnErrorKind::ConnectionClosed
    );
    assert_eq!(
        classify_turn_error(
            Some("rpc_-32004"),
            Some(&serde_json::json!({ "http_status": 429 }))
        ),
        ConversationTurnErrorKind::RateLimited
    );
    assert_eq!(
        classify_turn_error(
            Some("rpc_-32004"),
            Some(&serde_json::json!({ "http_status": 503 }))
        ),
        ConversationTurnErrorKind::ServiceError
    );
    assert_eq!(
        classify_turn_error(
            Some("internal_error"),
            Some(&serde_json::json!({ "errorKind": "authentication_failed" }))
        ),
        ConversationTurnErrorKind::AuthRequired
    );
    assert_eq!(
        classify_turn_error(
            Some("internal_error"),
            Some(&serde_json::json!({ "http_status": 401 }))
        ),
        ConversationTurnErrorKind::AuthRequired
    );
    assert_eq!(
        classify_turn_error(
            Some("rpc_-32004"),
            Some(&serde_json::json!({
                "message": "rate limit exceeded"
            }))
        ),
        ConversationTurnErrorKind::Unknown
    );
    let error = ConversationError::new("rate limit exceeded", Some("rpc_-32004".into()), None);
    assert_eq!(error.kind, ConversationTurnErrorKind::Unknown);
    assert_eq!(error.code.as_deref(), Some("rpc_-32004"));
}

#[test]
fn legacy_action_id_deserializes_as_workflow_ref() {
    let payload: ConversationInputPayload = serde_json::from_value(serde_json::json!({
        "agentId": "codex",
        "workspaceId": Uuid::nil(),
        "text": "hello",
        "pluginActions": [{
            "pluginId": "dimo.office",
            "actionId": "create-presentation"
        }]
    }))
    .expect("legacy pluginActions/actionId remain readable");

    assert_eq!(payload.workflow_refs.len(), 1);
    assert_eq!(payload.workflow_refs[0].plugin_id, "dimo.office");
    assert_eq!(payload.workflow_refs[0].workflow_id, "create-presentation");
}

#[test]
fn formats_internal_prompt_contributions_and_enforces_16kib_limit() {
    let blocks = vec![
        InternalPromptBlock {
            plugin_id: "b.plugin".to_string(),
            label: Some("Memory".to_string()),
            content: "Remember user prefers Rust.".to_string(),
            priority: Some(20),
        },
        InternalPromptBlock {
            plugin_id: "a.plugin".to_string(),
            label: None,
            content: "Emit <!--dimo-internal:a.plugin:summary {\"ok\":true}-->".to_string(),
            priority: Some(10),
        },
    ];

    let formatted = format_internal_prompt_contributions(&blocks)
        .expect("within 16 KiB limit")
        .expect("non-empty formatted output");
    assert!(formatted.starts_with("<dimo-plugin-context>\n"));
    assert!(formatted.ends_with("\n</dimo-plugin-context>"));
    let pos_a = formatted.find("plugin=\"a.plugin\"").unwrap();
    let pos_b = formatted.find("plugin=\"b.plugin\"").unwrap();
    assert!(pos_a < pos_b, "higher priority (lower number) comes first");

    let oversized = vec![InternalPromptBlock {
        plugin_id: "oversized".to_string(),
        label: None,
        content: "x".repeat(MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES + 1),
        priority: None,
    }];
    let err = format_internal_prompt_contributions(&oversized)
        .expect_err("16 KiB + 1 byte must be rejected");
    assert_eq!(err, MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES + 1);
}

#[test]
fn extracts_and_strips_internal_messages_across_streaming_chunks() {
    let conv_id = Uuid::new_v4();
    let turn_id = Uuid::new_v4();
    let full = "Hello user! <!--dimo-internal:token-guard:summary:n1 {\"risk\":\"low\"}-->World!\n```dimo-internal:audit:report\n{\"score\":99}\n```\n<dimo-internal-meta channel=\"telemetry\" nonce=\"n2\">{\"ok\":true}</dimo-internal-meta>Done.";

    // Simulate arbitrary chunking across every character boundary and verify monotonic visible_text.
    let mut prev_visible = String::new();
    for split in 1..full.len() {
        if !full.is_char_boundary(split) {
            continue;
        }
        let partial = &full[..split];
        let res = extract_and_strip_internal_messages(partial, Some(conv_id), Some(turn_id), true);
        assert!(
            res.visible_text.starts_with(&prev_visible),
            "visible_text must be monotonically append-only during streaming: prev={prev_visible:?}, next={:?} at split={split}",
            res.visible_text
        );
        assert!(
            !res.visible_text.contains("dimo-internal"),
            "internal marker leaked into visible_text: {:?} ",
            res.visible_text
        );
        prev_visible = res.visible_text;
    }

    let final_res = extract_and_strip_internal_messages(full, Some(conv_id), Some(turn_id), false);
    assert_eq!(final_res.visible_text, "Hello user! World!\n\nDone.");
    assert_eq!(final_res.captured.len(), 3);
    assert_eq!(final_res.captured[0].plugin_id, "token-guard");
    assert_eq!(final_res.captured[0].channel, "summary");
    assert_eq!(final_res.captured[0].nonce, "n1");
    assert_eq!(
        final_res.captured[0].parsed_payload,
        serde_json::json!({"risk": "low"})
    );
    assert_eq!(final_res.captured[1].plugin_id, "audit");
    assert_eq!(final_res.captured[1].channel, "audit:report");
    assert_eq!(final_res.captured[1].nonce, "report");
    assert_eq!(
        final_res.captured[1].parsed_payload,
        serde_json::json!({"score": 99})
    );
    assert_eq!(final_res.captured[2].channel, "telemetry");
    assert_eq!(final_res.captured[2].nonce, "n2");
    assert_eq!(
        final_res.captured[2].parsed_payload,
        serde_json::json!({"ok": true})
    );
}

#[test]
fn extracts_and_strips_internal_messages_handles_multibyte_utf8_streaming_chunks() {
    let conv_id = Uuid::new_v4();
    let turn_id = Uuid::new_v4();

    // Exact crash reproduction: 27-byte string where `27 - 22 = 5` falls inside '个' (bytes 3..6).
    let exact_crash_chunk = "这个报错是模型 ID ";
    let crash_res =
        extract_and_strip_internal_messages(exact_crash_chunk, Some(conv_id), Some(turn_id), true);
    assert_eq!(crash_res.visible_text, exact_crash_chunk);
    assert!(!crash_res.has_pending_tail);
    assert!(crash_res.captured.is_empty());

    // Stream across every valid UTF-8 boundary of a multi-byte string containing internal markers.
    let full = "这个报错是模型 ID 配置有误导致的。<!--dimo-internal:token-guard:summary:n1 {\"状态\":\"正常\"}-->请检查配置：\n```dimo-internal:audit:report\n{\"得分\":100}\n```\n<dimo-internal-meta channel=\"telemetry\" nonce=\"n2\">{\"完成\":true}</dimo-internal-meta>修复完成！";
    let mut prev_visible = String::new();
    for split in 1..=full.len() {
        if !full.is_char_boundary(split) {
            continue;
        }
        let partial = &full[..split];
        let res = extract_and_strip_internal_messages(partial, Some(conv_id), Some(turn_id), true);
        assert!(
            res.visible_text.starts_with(&prev_visible),
            "visible_text must be monotonically append-only during UTF-8 streaming: prev={prev_visible:?}, next={:?} at split={split}",
            res.visible_text
        );
        assert!(
            !res.visible_text.contains("dimo-internal"),
            "internal marker leaked into visible_text: {:?}",
            res.visible_text
        );
        prev_visible = res.visible_text;
    }

    let final_res = extract_and_strip_internal_messages(full, Some(conv_id), Some(turn_id), false);
    assert_eq!(
        final_res.visible_text,
        "这个报错是模型 ID 配置有误导致的。请检查配置：\n\n修复完成！"
    );
    assert_eq!(final_res.captured.len(), 3);
}
