use agents::{
    AgentConnectionId, AgentEvent, AgentEventEnvelope, AgentSessionId, AgentToolCall,
    AgentToolCallUpdate, AgentUsage,
    conversation::{ConversationEvent, ConversationFileLocation, ConversationToolCallPatch},
};
use chrono::Utc;
use tokio::time::{Duration, Instant};
use uuid::Uuid;

use super::{
    coalescer::{
        IDLE_FLUSH_CEILING, MAX_COALESCED_BYTES, MIN_BOUNDARY_FLUSH, StreamingThrottleCoalescer,
    },
    mapping::{
        MappedConversationEventRecord, binds_only_to_in_flight_turn,
        conversation_event_idempotency_key, conversation_event_kind, conversation_event_source,
        is_turn_scoped_content, map_agent_event, space_turn_conclusion_text,
    },
};

pub(super) fn envelope(event: AgentEvent) -> AgentEventEnvelope {
    AgentEventEnvelope {
        sequence: 1,
        workspace_id: Uuid::new_v4(),
        connection_id: AgentConnectionId::new(),
        session_id: Some(AgentSessionId::new()),
        event,
        created_at: Utc::now(),
    }
}

pub(super) fn mapped_record(
    sequence: i64,
    event: ConversationEvent,
) -> MappedConversationEventRecord {
    MappedConversationEventRecord {
        conversation_id: Uuid::nil(),
        turn_id: Some(Uuid::nil()),
        binding_id: None,
        connection_id: "connection".to_string(),
        prompt_id: None,
        source: "acp",
        event_kind: conversation_event_kind(&event),
        event,
        raw_json: None,
        idempotency_key: format!("agent:{sequence}:test"),
        first_agent_sequence: sequence,
        last_agent_sequence: sequence,
        complete_reply: false,
    }
}

pub(super) fn connection_ready_event() -> ConversationEvent {
    ConversationEvent::AgentConnectionStatusChanged {
        status: agents::conversation::ConversationAgentConnectionStatus::Ready,
        message: None,
        bound: false,
    }
}

#[test]
fn shared_recorder_coalesces_consecutive_text_without_dropping_boundaries() {
    let mut coalescer = StreamingThrottleCoalescer::new();
    let t0 = Instant::now();
    assert!(
        coalescer
            .push_at(
                mapped_record(
                    10,
                    ConversationEvent::AssistantTextDelta {
                        text: "hel".to_string(),
                        message_id: None,
                    },
                ),
                t0
            )
            .is_empty()
    );
    assert!(
        coalescer
            .push_at(
                mapped_record(
                    11,
                    ConversationEvent::AssistantTextDelta {
                        text: "lo".to_string(),
                        message_id: None,
                    },
                ),
                t0 + Duration::from_millis(10)
            )
            .is_empty()
    );

    let ready = coalescer.push_at(
        mapped_record(
            12,
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".to_string()),
            },
        ),
        t0 + Duration::from_millis(20),
    );
    assert_eq!(ready.len(), 2);
    assert_eq!(
        ready[0].idempotency_key,
        "agent:connection:10-11:assistant_text_delta"
    );
    assert!(
        ready[0]
            .raw_json
            .as_deref()
            .is_some_and(|raw| raw.contains("\"chunk_count\":2"))
    );
    assert!(matches!(
        &ready[0].event,
        ConversationEvent::AssistantTextDelta { text, .. } if text == "hello"
    ));
    assert!(matches!(
        ready[1].event,
        ConversationEvent::TurnCompleted { .. }
    ));
}

#[test]
fn markdown_fence_suppresses_400ms_flush_until_closing_fence_or_800ms_ceiling() {
    let mut coalescer = StreamingThrottleCoalescer::new();
    let t0 = Instant::now();

    assert!(
        coalescer
            .push_at(
                mapped_record(
                    1,
                    ConversationEvent::AssistantTextDelta {
                        text: "```rust\nfn main() {\n\n".to_string(),
                        message_id: None,
                    },
                ),
                t0,
            )
            .is_empty()
    );
    assert!(coalescer.scan_state.is_in_fence(Uuid::nil()));

    // Even after 500ms (>= 400ms) and blank lines inside the code fence, it must NOT flush!
    assert!(
        coalescer
            .push_at(
                mapped_record(
                    2,
                    ConversationEvent::AssistantTextDelta {
                        text: "    println!(\"hi\");\n\n".to_string(),
                        message_id: None,
                    },
                ),
                t0 + MIN_BOUNDARY_FLUSH + Duration::from_millis(100),
            )
            .is_empty(),
        "blank lines inside an open CommonMark code fence must not trigger a 400ms boundary flush"
    );

    // Closing fence at 550ms transitions out of the fence AND hits a safe block boundary -> flush!
    let flushed = coalescer.push_at(
        mapped_record(
            3,
            ConversationEvent::AssistantTextDelta {
                text: "}\n```\n".to_string(),
                message_id: None,
            },
        ),
        t0 + MIN_BOUNDARY_FLUSH + Duration::from_millis(150),
    );
    assert!(!coalescer.scan_state.is_in_fence(Uuid::nil()));
    assert_eq!(flushed.len(), 1);
    assert!(matches!(
        &flushed[0].event,
        ConversationEvent::AssistantTextDelta { text, .. }
            if text == "```rust\nfn main() {\n\n    println!(\"hi\");\n\n}\n```\n"
    ));

    // Inline triple-backticks on a single line ("```inline```") must NOT open a fence.
    let t1 = t0 + Duration::from_secs(2);
    assert!(
        coalescer
            .push_at(
                mapped_record(
                    4,
                    ConversationEvent::AssistantTextDelta {
                        text: "Use ```inline``` span.\n".to_string(),
                        message_id: None,
                    },
                ),
                t1,
            )
            .is_empty()
    );
    assert!(
        !coalescer.scan_state.is_in_fence(Uuid::nil()),
        "single-line backtick span must not trap scanner in fence mode"
    );

    // Idle ceiling at 800ms flushes even mid-sentence without a blank line.
    let deadline = coalescer.next_idle_deadline().expect("idle deadline set");
    assert_eq!(deadline, t1 + IDLE_FLUSH_CEILING);
    let due = coalescer.flush_due(deadline);
    assert_eq!(due.len(), 1);
}

#[test]
fn sixty_four_kib_cap_and_non_delta_barriers_flush_in_strict_order() {
    let mut coalescer = StreamingThrottleCoalescer::new();
    let t0 = Instant::now();

    // 1. 64 KiB cap flushes immediately even at t0 (0ms elapsed).
    let big = "x".repeat(MAX_COALESCED_BYTES);
    let cap_flushed = coalescer.push_at(
        mapped_record(
            1,
            ConversationEvent::AssistantTextDelta {
                text: big.clone(),
                message_id: None,
            },
        ),
        t0,
    );
    assert_eq!(cap_flushed.len(), 1);

    // 2. Non-delta barrier (PlanUpdated) flushes buffered text + running tool BEFORE PlanUpdated.
    assert!(
        coalescer
            .push_at(
                mapped_record(
                    2,
                    ConversationEvent::AssistantTextDelta {
                        text: "Checking files...".to_string(),
                        message_id: None,
                    },
                ),
                t0,
            )
            .is_empty()
    );
    assert!(
        coalescer
            .push_at(
                mapped_record(
                    3,
                    ConversationEvent::ToolCallUpsert {
                        tool_call: ConversationToolCallPatch {
                            tool_call_id: "tool-a".to_string(),
                            title: Some("Read".to_string()),
                            kind: Some("read".to_string()),
                            status: Some("running".to_string()),
                            raw_input: None,
                            raw_output: None,
                            raw_output_append: None,
                            content: None,
                            locations: None,
                            metadata: None,
                            images: Vec::new(),
                        },
                    },
                ),
                t0 + Duration::from_millis(5),
            )
            .is_empty()
    );
    let barrier_out = coalescer.push_at(
        mapped_record(
            4,
            ConversationEvent::PlanUpdated {
                entries: Vec::new(),
            },
        ),
        t0 + Duration::from_millis(10),
    );
    assert_eq!(barrier_out.len(), 3);
    assert_eq!(barrier_out[0].event_kind, "assistant_text_delta");
    assert_eq!(barrier_out[1].event_kind, "tool_call_upsert");
    assert_eq!(barrier_out[2].event_kind, "plan_updated");
}

#[test]
fn space_turn_conclusion_keeps_only_text_after_the_last_tool_use() {
    use agents::conversation::ContentBlock;
    let blocks = vec![
        ContentBlock::Text {
            text: "我先检查一下 auth.rs".to_string(),
        },
        ContentBlock::ToolUse {
            tool_use_id: Some("t1".to_string()),
            tool_name: "read".to_string(),
            status: None,
            kind: None,
            input_preview: None,
            meta: None,
            images: Vec::new(),
            started_at: None,
            ended_at: None,
        },
        ContentBlock::Text {
            text: "鉴权没有问题。".to_string(),
        },
    ];
    assert_eq!(
        space_turn_conclusion_text(&blocks, true, "unused"),
        "鉴权没有问题。"
    );
}

#[test]
fn space_turn_conclusion_joins_all_text_when_no_tool_ran() {
    use agents::conversation::ContentBlock;
    let blocks = vec![
        ContentBlock::Text {
            text: "hello".to_string(),
        },
        ContentBlock::Text {
            text: "world".to_string(),
        },
    ];
    assert_eq!(
        space_turn_conclusion_text(&blocks, false, ""),
        "hello\nworld"
    );
}

#[test]
fn space_turn_conclusion_uses_leftover_when_tool_ran_without_a_tool_block() {
    use agents::conversation::ContentBlock;
    let blocks = vec![
        ContentBlock::Text {
            text: "我先检查一下 auth.rs".to_string(),
        },
        ContentBlock::Text {
            text: "鉴权没有问题。".to_string(),
        },
    ];
    assert_eq!(
        space_turn_conclusion_text(&blocks, true, "鉴权没有问题。"),
        "鉴权没有问题。"
    );
}

#[test]
fn shared_recorder_coalesces_consecutive_same_item_tool_call_upserts() {
    let mut coalescer = StreamingThrottleCoalescer::new();
    let t0 = Instant::now();
    let mut flushed = Vec::new();
    for idx in 0..10 {
        let emitted = coalescer.push_at(
            mapped_record(
                100 + idx,
                ConversationEvent::ToolCallUpsert {
                    tool_call: ConversationToolCallPatch {
                        tool_call_id: "tool-stream-1".to_string(),
                        title: (idx == 0).then(|| "Run cargo test".to_string()),
                        kind: (idx == 0).then(|| "execute".to_string()),
                        status: Some(if idx == 9 { "completed" } else { "running" }.to_string()),
                        raw_input: (idx == 0)
                            .then(|| serde_json::json!({ "command": "cargo test" })),
                        raw_output: Some(serde_json::json!(format!("output-step-{idx}"))),
                        raw_output_append: Some(format!("chunk-{idx};")),
                        content: Some(serde_json::json!({ "text": format!("output-step-{idx}") })),
                        locations: (idx == 0).then(|| {
                            vec![ConversationFileLocation {
                                path: "src/lib.rs".to_string(),
                                line: Some(42),
                                column: None,
                            }]
                        }),
                        metadata: (idx == 5).then(|| serde_json::json!({ "exitCode": 0 })),
                        images: Vec::new(),
                    },
                },
            ),
            t0 + Duration::from_millis((idx as u64) * 10),
        );
        if idx < 9 {
            assert!(
                emitted.is_empty(),
                "running tool_call_id upserts should stay buffered"
            );
        } else {
            flushed = emitted;
        }
    }

    assert_eq!(flushed.len(), 1);
    assert_eq!(
        flushed[0].idempotency_key,
        "agent:connection:100-109:tool_call_upsert"
    );
    assert!(
        flushed[0]
            .raw_json
            .as_deref()
            .is_some_and(|raw| raw.contains("\"chunk_count\":10"))
    );
    let ConversationEvent::ToolCallUpsert { tool_call } = &flushed[0].event else {
        panic!("expected coalesced ToolCallUpsert");
    };
    assert_eq!(tool_call.tool_call_id, "tool-stream-1");
    assert_eq!(tool_call.title.as_deref(), Some("Run cargo test"));
    assert_eq!(tool_call.kind.as_deref(), Some("execute"));
    assert_eq!(tool_call.status.as_deref(), Some("completed"));
    assert_eq!(
        tool_call.raw_input,
        Some(serde_json::json!({ "command": "cargo test" }))
    );
    assert_eq!(
        tool_call.raw_output,
        Some(serde_json::json!("output-step-9"))
    );
    assert_eq!(
        tool_call.raw_output_append.as_deref(),
        Some("chunk-0;chunk-1;chunk-2;chunk-3;chunk-4;chunk-5;chunk-6;chunk-7;chunk-8;chunk-9;")
    );
    assert_eq!(tool_call.locations.as_ref().map(Vec::len), Some(1));
    assert_eq!(
        tool_call.metadata,
        Some(serde_json::json!({ "exitCode": 0 }))
    );
}

#[test]
fn shared_mapping_preserves_tool_metadata() {
    let metadata = serde_json::json!({ "file_path": "src/main.rs" });
    let image = agents::conversation::ImageData {
        data: "AAAA".to_string(),
        mime_type: "image/png".to_string(),
        uri: Some("assets/logo.png".to_string()),
        width: None,
        height: None,
    };
    let envelope = envelope(AgentEvent::ToolCall {
        tool_call: AgentToolCall {
            status: Some("completed".to_string()),
            content: Some(r#"{"ok":true}"#.to_string()),
            id: "tool-1".to_string(),
            title: "Edit file".to_string(),
            kind: Some("edit".to_string()),
            input_preview: None,
            meta: Some(metadata.clone()),
            images: vec![image.clone()],
        },
    });

    let mapped = map_agent_event(&envelope, Some(Uuid::new_v4()));
    assert!(matches!(
        mapped,
        Some(ConversationEvent::ToolCallUpsert { tool_call })
            if tool_call.metadata == Some(metadata) && tool_call.images == vec![image]
                && tool_call.status.as_deref() == Some("completed")
                && tool_call.raw_output == Some(serde_json::json!({ "ok": true }))
    ));
}

#[test]
fn tool_call_update_can_rewrite_the_title() {
    let envelope = envelope(AgentEvent::ToolCallUpdate {
        update: AgentToolCallUpdate {
            id: "tool-1".to_string(),
            title: Some("vibex-delegation-mcp__delegate_to_agent".to_string()),
            status: Some("running".to_string()),
            content: None,
            input_preview: Some(r#"{"agent_type":"codex","task":"hi"}"#.to_string()),
            meta: None,
            images: Vec::new(),
        },
    });

    let mapped = map_agent_event(&envelope, Some(Uuid::new_v4()));
    assert!(matches!(
        mapped,
        Some(ConversationEvent::ToolCallUpsert { tool_call })
            if tool_call.title.as_deref()
                == Some("vibex-delegation-mcp__delegate_to_agent")
    ));
}

#[test]
fn shared_mapping_preserves_usage_cost() {
    let envelope = envelope(AgentEvent::Usage {
        usage: AgentUsage {
            used: 120,
            limit: Some(200_000),
            cost_amount: Some(0.42),
            cost_currency: Some("USD".to_string()),
            ..AgentUsage::default()
        },
    });

    let mapped = map_agent_event(&envelope, Some(Uuid::new_v4()));
    assert!(matches!(
        mapped,
        Some(ConversationEvent::UsageUpdated { usage })
            if usage.cost_amount == Some(0.42)
                && usage.cost_currency.as_deref() == Some("USD")
                && usage.context_used == Some(120)
                && usage.input_tokens == 0
                && usage.model.is_none()
    ));
}

#[test]
fn shared_mapping_preserves_usage_model_and_token_breakdown() {
    let envelope = envelope(AgentEvent::Usage {
        usage: AgentUsage {
            used: 18_658,
            limit: Some(500_000),
            input_tokens: Some(29_214),
            output_tokens: Some(1_652),
            cache_read_tokens: Some(56_960),
            model: Some("grok-4.6".into()),
            ..AgentUsage::default()
        },
    });

    let mapped = map_agent_event(&envelope, Some(Uuid::new_v4()));
    assert!(matches!(
        mapped,
        Some(ConversationEvent::UsageUpdated { usage })
            if usage.model.as_deref() == Some("grok-4.6")
                && usage.input_tokens == 29_214
                && usage.output_tokens == 1_652
                && usage.cache_read_input_tokens == 56_960
                && usage.context_used == Some(18_658)
    ));
}

#[test]
fn plan_updates_keep_status_and_priority() {
    let envelope = envelope(AgentEvent::Plan {
        plan: agents::AgentPlan {
            entries: vec![agents::AgentPlanEntry {
                content: "Write tests".into(),
                status: "in_progress".into(),
                priority: Some("high".into()),
            }],
        },
    });
    let mapped = map_agent_event(&envelope, Some(Uuid::new_v4()));
    assert!(matches!(
        mapped,
        Some(ConversationEvent::PlanUpdated { entries })
            if entries.len() == 1
                && entries[0].content == "Write tests"
                && entries[0].status == "in_progress"
                && entries[0].priority.as_deref() == Some("high")
    ));
}

#[test]
fn session_info_updates_are_classified_as_acp_events() {
    assert_eq!(
        conversation_event_source(&AgentEvent::SessionInfoUpdated {
            patch: serde_json::json!({ "title": "Thread title" }),
        }),
        "acp"
    );
}

#[test]
fn grok_announcements_are_persisted_as_typed_events() {
    let envelope = envelope(AgentEvent::AnnouncementsUpdated {
        generation: 3,
        notices: vec![agents::conversation::ConversationSessionNotice {
            title: "Grok CLI".into(),
            message: Some("A new version is available.".into()),
            severity: "info".into(),
            announcement_id: Some("cli-update".into()),
            action: Some(
                agents::conversation::ConversationNoticeAction::UpdateAgent {
                    agent_id: agents::AgentId::parse("grok").expect("grok"),
                    fallback_url: None,
                },
            ),
            ..Default::default()
        }],
    });
    assert_eq!(conversation_event_source(&envelope.event), "acp");
    assert!(matches!(
        map_agent_event(&envelope, Some(Uuid::new_v4())),
        Some(ConversationEvent::AnnouncementsUpdated { generation, notices })
            if generation == 3 && notices.len() == 1 && notices[0].title == "Grok CLI"
    ));
}

#[test]
fn agent_session_notices_are_persisted_as_diagnostics() {
    let envelope = envelope(AgentEvent::RawAcpDiagnostic {
        raw: serde_json::json!({
            "kind": agents::AGENT_SESSION_NOTICE_KIND,
            "title": "Skill descriptions were shortened to fit the skills context budget.",
            "message": "Disable unused skills or plugins to leave more room for the rest.",
            "severity": "warning",
        }),
    });

    assert_eq!(conversation_event_source(&envelope.event), "acp");
    assert!(matches!(
        map_agent_event(&envelope, Some(Uuid::new_v4())),
        Some(ConversationEvent::RawDiagnosticRecorded { label, payload })
            if label == agents::AGENT_SESSION_NOTICE_KIND
                && payload
                    .as_ref()
                    .and_then(agents::session_notice_from_diagnostic)
                    .is_some_and(|notice| notice.severity == "warning")
    ));
}

#[test]
fn unknown_acp_diagnostics_are_persisted() {
    let envelope = envelope(AgentEvent::RawAcpDiagnostic {
        raw: serde_json::json!({
            "kind": "session_config_override_skipped",
            "reason": "config_choice_not_found",
            "requested": "model=missing",
        }),
    });

    assert_eq!(conversation_event_source(&envelope.event), "acp");
    assert!(matches!(
        map_agent_event(&envelope, Some(Uuid::new_v4())),
        Some(ConversationEvent::RawDiagnosticRecorded { label, payload })
            if label == "session_config_override_skipped"
                && payload.as_ref().and_then(|value| value["requested"].as_str())
                    == Some("model=missing")
    ));
}

#[test]
fn cancelled_prompt_finish_is_turn_cancelled_not_completed() {
    for reason in ["cancelled", "Cancelled", "canceled"] {
        let envelope = envelope(AgentEvent::PromptFinished {
            finished: agents::AgentPromptFinished {
                prompt_id: agents::AgentPromptId(Uuid::new_v4()),
                stop_reason: Some(reason.to_string()),
                usage: None,
            },
        });
        let mapped = map_agent_event(&envelope, Some(Uuid::new_v4()));
        assert!(
            matches!(
                mapped,
                Some(ConversationEvent::TurnCancelled { reason: Some(value) })
                    if value == reason
            ),
            "stop reason {reason} must settle as cancelled"
        );
    }
}

#[test]
fn non_text_message_chunks_are_persisted_as_content_blocks() {
    let image = envelope(AgentEvent::MessageChunk {
        content: agents::AgentContentBlock::Image {
            data: "AAAA".into(),
            mime_type: "image/png".into(),
            uri: Some("https://example.com/a.png".into()),
        },
    });
    assert!(matches!(
        map_agent_event(&image, Some(Uuid::new_v4())),
        Some(ConversationEvent::AssistantContentAppended {
            block: agents::conversation::ContentBlock::Image { mime_type, .. },
            ..
        }) if mime_type == "image/png"
    ));

    let resource = envelope(AgentEvent::MessageChunk {
        content: agents::AgentContentBlock::Resource {
            uri: "file:///tmp/note.md".into(),
            title: Some("note".into()),
        },
    });
    assert!(matches!(
        map_agent_event(&resource, Some(Uuid::new_v4())),
        Some(ConversationEvent::AssistantContentAppended {
            block: agents::conversation::ContentBlock::Resource { uri, .. },
            ..
        }) if uri == "file:///tmp/note.md"
    ));
}

#[test]
fn auth_required_errors_block_the_turn_instead_of_failing_it() {
    let envelope = envelope(AgentEvent::Error {
        error: agents::AgentErrorEvent {
            message: "please log in".into(),
            code: Some("auth_required".into()),
            raw: None,
        },
    });
    assert!(matches!(
        map_agent_event(&envelope, Some(Uuid::new_v4())),
        Some(ConversationEvent::TurnBlocked {
            reason: agents::conversation::TurnBlockedReason::Authentication { message }
        }) if message == "please log in"
    ));
}

#[test]
fn idle_timeout_errors_fail_the_turn_with_the_idle_timeout_code() {
    let envelope = envelope(AgentEvent::Error {
        error: agents::AgentErrorEvent {
            message: "Agent stopped responding (idle timeout after 120s).".into(),
            code: Some("idle_timeout".into()),
            raw: None,
        },
    });
    assert!(matches!(
        map_agent_event(&envelope, Some(Uuid::new_v4())),
        Some(ConversationEvent::TurnFailed {
            error: agents::conversation::ConversationError { code: Some(code), .. }
        }) if code == "idle_timeout"
    ));
}

#[test]
fn connection_closed_errors_fail_the_turn_with_the_connection_closed_code() {
    let envelope = envelope(AgentEvent::Error {
        error: agents::events::AgentErrorEvent {
            message: "Agent connection closed before the turn completed.".into(),
            code: Some("connection_closed".into()),
            raw: None,
        },
    });
    assert!(matches!(
        map_agent_event(&envelope, Some(Uuid::new_v4())),
        Some(ConversationEvent::TurnFailed {
            error: agents::conversation::ConversationError { code: Some(code), .. }
        }) if code == "connection_closed"
    ));
}

#[test]
fn completed_prompt_finish_stays_turn_completed() {
    let envelope = envelope(AgentEvent::PromptFinished {
        finished: agents::AgentPromptFinished {
            prompt_id: agents::AgentPromptId(Uuid::new_v4()),
            stop_reason: Some("EndTurn".to_string()),
            usage: None,
        },
    });
    assert!(matches!(
        map_agent_event(&envelope, Some(Uuid::new_v4())),
        Some(ConversationEvent::TurnCompleted { stop_reason })
            if stop_reason.as_deref() == Some("EndTurn")
    ));
}

#[test]
fn session_bind_ready_persists_the_real_send_gate_fact() {
    let envelope = envelope(AgentEvent::SessionBindReady {
        acp_session_id: "acp-live-session-9".into(),
    });
    assert!(matches!(
        map_agent_event(&envelope, None),
        Some(ConversationEvent::AgentConnectionStatusChanged { bound: true, .. })
    ));
}

#[test]
fn connection_status_with_a_session_maps_to_conversation_status() {
    let snapshot = agents::state::AgentConnectionSnapshot {
        id: AgentConnectionId::new(),
        agent_id: agents::AgentId::parse("codex").expect("agent"),
        workspace_id: Uuid::new_v4(),
        status: agents::state::AgentConnectionStatus::Recovering,
        working_dir: "/tmp".into(),
        status_message: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    };
    assert!(matches!(
        map_agent_event(
            &envelope(AgentEvent::ConnectionStatusChanged { snapshot }),
            None
        ),
        Some(ConversationEvent::AgentConnectionStatusChanged {
            status: agents::conversation::ConversationAgentConnectionStatus::Recovering,
            ..
        })
    ));
}

#[test]
fn restarting_runtime_sequence_cannot_deduplicate_a_new_connections_status() {
    let conversation = Uuid::new_v4();
    let event = connection_ready_event();
    let a = conversation_event_idempotency_key(conversation, AgentConnectionId::new(), 1, &event);
    let b = conversation_event_idempotency_key(conversation, AgentConnectionId::new(), 1, &event);
    assert_ne!(a, b);
    let mut a = mapped_record(
        1,
        ConversationEvent::AssistantTextDelta {
            text: "a".into(),
            message_id: None,
        },
    );
    let mut b = a.clone();
    a.connection_id = "old-host".into();
    b.connection_id = "new-host".into();
    let mut coalescer = StreamingThrottleCoalescer::new();
    coalescer.push(a);
    coalescer.push(b);
    let flushed = coalescer.flush_all();
    assert_eq!(flushed.len(), 2);
    assert_ne!(flushed[0].idempotency_key, flushed[1].idempotency_key);
}

#[test]
fn an_untethered_error_is_recorded_as_a_binding_failure_rather_than_dropped() {
    let error = AgentEvent::Error {
        error: agents::events::AgentErrorEvent {
            message: "agent exited before session/new".to_string(),
            code: None,
            raw: None,
        },
    };

    assert!(binds_only_to_in_flight_turn(&error));
    assert!(!is_turn_scoped_content(&error));
    assert!(matches!(
        map_agent_event(&envelope(error), None),
        Some(ConversationEvent::AgentBindingRecoveryFailed { .. })
    ));
}
