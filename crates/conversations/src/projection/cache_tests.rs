    use agents::conversation::{
        AcpCapabilitySnapshot, ContentBlock, ConversationError, ConversationEvent,
        ConversationInputBlock, ConversationRowOp, ConversationTerminalPatch,
        ConversationTimelineRow, ConversationToolCallPatch, ConversationUsage,
        SessionLoadFailureReason, SessionRecoveryStrategy, TimelineTextStream, TurnRole,
    };
    use db::models::conversation_turn::{ConversationTurnRecord, CreateConversationTurn};
    use uuid::Uuid;

    use super::{CachedRowProjector, IncrementalRowProjector, extend_coalesced_row_ops};
    use crate::projection::{
        AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID, ConversationProjector,
        rows::tests::{append_event, record_of, seed_turn, setup_pool},
    };
    #[test]
    fn unpersisted_delta_does_not_hide_the_next_database_event() {
        let conversation_id = Uuid::new_v4();
        let mut cached = CachedRowProjector::new(IncrementalRowProjector::at_sequence(4));
        cached
            .apply_unpersisted(&record_of(
                conversation_id,
                0,
                ConversationEvent::AssistantTextDelta {
                    text: "hi".into(),
                    message_id: None,
                },
            ))
            .expect("delta");
        assert_eq!(cached.db_cursor, 4);
        assert_eq!(cached.projector.last_sequence(), 5);
        assert!(cached.has_unpersisted());

        cached
            .apply_persisted(&record_of(
                conversation_id,
                5,
                ConversationEvent::TurnCompleted { stop_reason: None },
            ))
            .expect("completed");
        assert_eq!(cached.db_cursor, 5);
        assert_eq!(cached.projector.last_sequence(), 6);
        assert!(!cached.has_unpersisted());
    }

    #[test]
    fn intermediate_persisted_events_do_not_clear_has_unpersisted() {
        let conversation_id = Uuid::new_v4();
        let mut cached = CachedRowProjector::new(IncrementalRowProjector::at_sequence(4));
        cached
            .apply_unpersisted(&record_of(
                conversation_id,
                0,
                ConversationEvent::AssistantTextDelta {
                    text: "streaming".into(),
                    message_id: None,
                },
            ))
            .expect("delta");
        assert!(cached.has_unpersisted());

        cached
            .apply_persisted(&record_of(
                conversation_id,
                5,
                ConversationEvent::UsageUpdated {
                    usage: agents::conversation::ConversationUsage {
                        context_used: Some(128),
                        context_window_max: Some(4096),
                        ..Default::default()
                    },
                },
            ))
            .expect("usage update");
        assert_eq!(cached.db_cursor, 5);
        assert!(
            cached.has_unpersisted(),
            "mid-turn UsageUpdated must not clear has_unpersisted while streaming text is in memory"
        );

        cached
            .apply_persisted(&record_of(
                conversation_id,
                6,
                ConversationEvent::TurnCompleted { stop_reason: None },
            ))
            .expect("completed");
        assert!(!cached.has_unpersisted());
    }

    #[tokio::test]
    async fn cached_row_projector_recovers_after_truncate_to_turn_ordinal() {
        let pool = setup_pool().await;
        let (conversation_id, turn1_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn1_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "first".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        for idx in 2..=9 {
            append_event(
                &pool,
                conversation_id,
                Some(turn1_id),
                "acp",
                ConversationEvent::AssistantTextDelta {
                    text: format!("chunk-{idx} "),
                    message_id: None,
                },
                None,
            )
            .await;
        }
        let turn1_end = append_event(
            &pool,
            conversation_id,
            Some(turn1_id),
            "acp",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;
        assert_eq!(turn1_end.sequence, 10);

        let turn2 = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-2"),
                text_preview: Some("second"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn 2");
        assert_eq!(turn2.ordinal, 2);
        let turn2_id = turn2.id;
        append_event(
            &pool,
            conversation_id,
            Some(turn2_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "second".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        for idx in 12..=19 {
            append_event(
                &pool,
                conversation_id,
                Some(turn2_id),
                "acp",
                ConversationEvent::AssistantTextDelta {
                    text: format!("chunk-{idx} "),
                    message_id: None,
                },
                None,
            )
            .await;
        }
        let turn2_end = append_event(
            &pool,
            conversation_id,
            Some(turn2_id),
            "acp",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;
        assert_eq!(turn2_end.sequence, 20);

        let mut cached = CachedRowProjector::new(
            IncrementalRowProjector::load_through_latest(&pool, conversation_id)
                .await
                .expect("load projector at seq 20"),
        );
        assert_eq!(cached.db_cursor, 20);

        ConversationProjector::truncate_to_turn_ordinal(&pool, conversation_id, 2)
            .await
            .expect("truncate to ordinal 2");

        let turn2_retry = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-2-retry"),
                text_preview: Some("second retry"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn 2 retry");
        let turn2_retry_id = turn2_retry.id;
        let retry_event = append_event(
            &pool,
            conversation_id,
            Some(turn2_retry_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "second retry".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        assert_eq!(retry_event.sequence, 11);

        let ops = cached
            .apply_persisted(&retry_event)
            .expect("apply_persisted succeeds")
            .expect("must not drop sequence 11 after truncation rewind from 20 to 10");
        assert!(!ops.is_empty());
        assert_eq!(cached.db_cursor, 11);
    }

    #[tokio::test]
    async fn successful_load_clears_the_recoverable_load_failure_notice() {
        let pool = setup_pool().await;
        let (conversation_id, _) = seed_turn(&pool).await;

        let load_failure = append_event(
            &pool,
            conversation_id,
            None,
            "acp",
            ConversationEvent::AgentBindingLoadFailed {
                reason: SessionLoadFailureReason::Other {
                    message: "session/load failed: no rollout found".into(),
                },
            },
            None,
        )
        .await;

        let failed_timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project load failure");
        assert!(
            failed_timeline
                .rows
                .iter()
                .any(|row| matches!(row.row, ConversationTimelineRow::SessionNotice { .. }))
        );
        let mut realtime_projector =
            IncrementalRowProjector::load(&pool, conversation_id, load_failure.sequence)
                .await
                .expect("load realtime projector after failure");

        let binding_ready = append_event(
            &pool,
            conversation_id,
            None,
            "acp",
            ConversationEvent::AgentBindingReady {
                acp_session_id: "cold-start-session".into(),
                capabilities: AcpCapabilitySnapshot::default(),
            },
            None,
        )
        .await;
        let ready_ops = realtime_projector
            .apply(&binding_ready)
            .expect("project successful binding in realtime");
        assert!(ready_ops.iter().all(|op| !matches!(
            op,
            ConversationRowOp::Delete { row_id, .. }
                if row_id == AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
        )));

        let recovered = append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentBindingRecovered {
                strategy: SessionRecoveryStrategy::Loaded,
                continues_from: None,
            },
            None,
        )
        .await;
        let ops = realtime_projector
            .apply(&recovered)
            .expect("project successful load recovery");
        assert!(ops.iter().any(|op| matches!(
            op,
            ConversationRowOp::Delete { row_id, .. }
                if row_id == AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
        )));

        let recovered_timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project successful load");
        assert!(
            recovered_timeline
                .rows
                .iter()
                .all(|row| !matches!(row.row, ConversationTimelineRow::SessionNotice { .. }))
        );
    }

    #[tokio::test]
    async fn row_ops_text_deltas_append_and_terminal_upserts_full_row() {
        // 批次C: the realtime protocol. Streaming text → cheap AppendText (row_id +
        // stream + delta + revision), no full row. A non-text/terminal event →
        // Upsert(s) whose revision equals the producing event's sequence, carrying the
        // full folded row (text included) — the same fold as the initial load.
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("projector");

        let created = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "hi".into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        // Creating the turn upserts the user row at the creating sequence.
        let ops = projector.apply(&created).expect("ops");
        assert!(ops.iter().any(|op| matches!(
            op,
            ConversationRowOp::Upsert { row } if row.row_id == format!("{turn_id}:user")
                && row.revision == created.sequence
        )));

        let delta = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "hel".into(),
                message_id: None,
            },
            None,
        )
        .await;
        let ops = projector.apply(&delta).expect("ops");
        assert_eq!(ops.len(), 1, "a text delta emits exactly one AppendText");
        match &ops[0] {
            ConversationRowOp::AppendText {
                row_id,
                revision,
                stream,
                delta: chunk,
            } => {
                assert_eq!(row_id, &format!("{turn_id}:assistant"));
                assert_eq!(*revision, delta.sequence);
                assert!(matches!(stream, TimelineTextStream::Text));
                assert_eq!(chunk, "hel");
            }
            other => panic!("expected AppendText, got {other:?}"),
        }

        let failed = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnFailed {
                error: ConversationError {
                    message: "ACP connection closed".into(),
                    code: Some("connection_closed".into()),
                    raw: None,
                    kind: Default::default(),
                    plan_usage: None,
                },
            },
            None,
        )
        .await;
        let ops = projector.apply(&failed).expect("ops");
        // The terminal event upserts the full assistant row — folded text included —
        // at the terminal sequence, flushing the streamed deltas authoritatively.
        let assistant = ops.iter().find_map(|op| match op {
            ConversationRowOp::Upsert { row } if row.row_id == format!("{turn_id}:assistant") => {
                Some(row)
            }
            _ => None,
        });
        let assistant = assistant.expect("assistant row upserted on turn failure");
        assert_eq!(assistant.revision, failed.sequence);
        match &assistant.row {
            ConversationTimelineRow::MessageTurn { turn, phase, .. } => {
                assert_eq!(phase, "failed");
                assert!(
                    turn.blocks
                        .iter()
                        .any(|block| matches!(block, ContentBlock::Text { text } if text == "hel"))
                );
            }
            other => panic!("expected MessageTurn, got {other:?}"),
        }
    }

    /// Regression: each Turn's stream stays on its own assistant row. Deltas are
    /// attributed by the recorder from the authoritative active-turn pointer, so the
    /// fold must honour `turn_id` verbatim — re-pointing a settled Turn's late tail at
    /// whichever Turn is open produced the reported "用户 A - AI A - 用户 B - AI AB".
    #[tokio::test]
    async fn each_turns_stream_stays_on_its_own_assistant_row() {
        let pool = setup_pool().await;
        let (conversation_id, turn_a) = seed_turn(&pool).await;
        let turn_b = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-2"),
                text_preview: Some("B"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create second turn")
        .id;

        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("projector");

        let created_a = append_event(
            &pool,
            conversation_id,
            Some(turn_a),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "A".into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        projector.apply(&created_a).expect("fold A user");

        let delta_a = append_event(
            &pool,
            conversation_id,
            Some(turn_a),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "answer-A".into(),
                message_id: None,
            },
            None,
        )
        .await;
        projector.apply(&delta_a).expect("fold A assistant");

        let completed_a = append_event(
            &pool,
            conversation_id,
            Some(turn_a),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;
        projector.apply(&completed_a).expect("settle A");

        let created_b = append_event(
            &pool,
            conversation_id,
            Some(turn_b),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "B".into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        projector.apply(&created_b).expect("fold B user");

        let delta_b = append_event(
            &pool,
            conversation_id,
            Some(turn_b),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "answer-B".into(),
                message_id: None,
            },
            None,
        )
        .await;
        let ops = projector.apply(&delta_b).expect("fold B assistant");
        assert!(
            ops.iter().any(|op| matches!(
                op,
                ConversationRowOp::AppendText { row_id, delta, .. }
                    if row_id == &format!("{turn_b}:assistant") && delta == "answer-B"
            )),
            "B's delta must append to B: {ops:?}"
        );
        assert!(
            !ops.iter().any(|op| matches!(
                op,
                ConversationRowOp::AppendText { row_id, .. }
                    if row_id == &format!("{turn_a}:assistant")
            )),
            "B's stream must not grow A's assistant row: {ops:?}"
        );

        // A settled Turn's late-flushed tail belongs to that Turn, not to the Turn
        // that happens to be open.
        let late_tail_a = append_event(
            &pool,
            conversation_id,
            Some(turn_a),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "-tail".into(),
                message_id: None,
            },
            None,
        )
        .await;
        let ops = projector.apply(&late_tail_a).expect("fold A tail");
        assert!(
            ops.iter().any(|op| matches!(
                op,
                ConversationRowOp::AppendText { row_id, delta, .. }
                    if row_id == &format!("{turn_a}:assistant") && delta == "-tail"
            )),
            "A's late tail must stay on A: {ops:?}"
        );

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let assistant_texts: Vec<(String, String)> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    let text = turn
                        .blocks
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<String>();
                    Some((row.row_id.clone(), text))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            assistant_texts,
            vec![
                (format!("{turn_a}:assistant"), "answer-A-tail".into()),
                (format!("{turn_b}:assistant"), "answer-B".into()),
            ]
        );
    }

    #[tokio::test]
    async fn incremental_projector_skips_turn_reemission_on_non_turn_events_and_coalesces_batches()
    {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let user_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "investigate memory".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("load projector");
        let initial_ops = projector.apply(&user_rec).expect("apply user turn");
        assert_eq!(initial_ops.len(), 2);
        assert!(initial_ops.iter().any(|op| matches!(op, ConversationRowOp::Upsert { row } if row.row_id == "status:agent-request")));

        let diag_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::RawDiagnosticRecorded {
                label: "acp_frame".into(),
                payload: Some(serde_json::json!({"ok": true})),
            },
            None,
        )
        .await;
        let diag_ops = projector.apply(&diag_rec).expect("apply diagnostic");
        assert!(
            !diag_ops.iter().any(|op| matches!(
                op,
                ConversationRowOp::Upsert { row }
                    if matches!(row.row, ConversationTimelineRow::MessageTurn { .. })
            )),
            "diagnostic events must not re-emit MessageTurn rows"
        );

        let term_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::TerminalUpdated {
                terminal: ConversationTerminalPatch {
                    terminal_id: "term-1".into(),
                    command: Some("cargo".into()),
                    args: vec!["check".into()],
                    cwd: None,
                    status: "running".into(),
                    output_summary: Some("checking".into()),
                    output_truncated: false,
                    exit_status: None,
                },
            },
            None,
        )
        .await;
        let term_ops = projector.apply(&term_rec).expect("apply terminal");
        assert!(
            term_ops.iter().all(|op| !matches!(
                op,
                ConversationRowOp::Upsert { row }
                    if matches!(row.row, ConversationTimelineRow::MessageTurn { .. })
            )),
            "side-row events must only emit the side row, not re-emit MessageTurn rows"
        );

        let huge_meta = "x".repeat(64 * 1024);
        let tool1 = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "call-1".into(),
                    title: Some("Read".into()),
                    kind: Some("read".into()),
                    status: Some("running".into()),
                    raw_input: Some(serde_json::json!({"path": "main.rs"})),
                    raw_output: None,
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: Some(serde_json::json!({ "blob": huge_meta })),
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;
        let tool2 = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "call-1".into(),
                    title: None,
                    kind: None,
                    status: Some("completed".into()),
                    raw_input: None,
                    raw_output: Some(serde_json::Value::String("y".repeat(64 * 1024))),
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: None,
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;

        let mut coalesced = Vec::new();
        for rec in [&tool1, &tool2] {
            let ops = projector.apply(rec).expect("apply tool");
            // Only the assistant MessageTurn row should be emitted, never the user turn row.
            assert_eq!(ops.len(), 1);
            extend_coalesced_row_ops(&mut coalesced, ops);
        }
        assert_eq!(
            coalesced.len(),
            2,
            "the first tool creates the assistant row; the next tool patches that row"
        );
        match &coalesced[0] {
            ConversationRowOp::Upsert { row } => match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. } => {
                    assert_eq!(turn.role, TurnRole::Assistant);
                    let meta = turn.blocks.iter().find_map(|block| match block {
                        ContentBlock::ToolUse {
                            meta: Some(meta), ..
                        } => Some(meta),
                        _ => None,
                    });
                    let serialized = serde_json::to_string(meta.expect("capped meta")).unwrap();
                    assert!(
                        serialized.len() <= agents::conversation::MAX_TIMELINE_PREVIEW_BYTES + 32,
                        "tool metadata must be capped in live projection"
                    );
                }
                other => panic!("expected MessageTurn, got {other:?}"),
            },
            other => panic!("expected creation Upsert, got {other:?}"),
        }
        match &coalesced[1] {
            ConversationRowOp::PatchBlocks { blocks, .. } => {
                assert!(blocks.iter().all(|block| matches!(
                    block,
                    ContentBlock::ToolUse { .. } | ContentBlock::ToolResult { .. }
                )));
                let preview = blocks.iter().find_map(|block| match block {
                    ContentBlock::ToolResult {
                        output_preview: Some(preview),
                        ..
                    } => Some(preview),
                    _ => None,
                });
                let preview = preview.expect("patched output");
                assert!(
                    preview.len() <= agents::conversation::MAX_TIMELINE_PREVIEW_BYTES + 8,
                    "tool output_preview must be capped in live projection"
                );
            }
            other => panic!("expected PatchBlocks, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn tool_update_after_text_patches_only_the_changed_blocks() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let user_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "look".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("load projector");
        projector.apply(&user_rec).expect("apply user");
        let text_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "hello".into(),
                message_id: None,
            },
            None,
        )
        .await;
        let text_ops = projector.apply(&text_rec).expect("apply text");
        assert!(matches!(
            text_ops.as_slice(),
            [ConversationRowOp::AppendText { .. }]
        ));
        let tool_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "call-9".into(),
                    title: Some("Read".into()),
                    kind: Some("read".into()),
                    status: Some("completed".into()),
                    raw_input: None,
                    raw_output: Some(serde_json::json!("ok")),
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: None,
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;
        let tool_ops = projector.apply(&tool_rec).expect("apply tool");
        match tool_ops.as_slice() {
            [ConversationRowOp::PatchBlocks { blocks, .. }] => {
                assert!(blocks.iter().all(|block| matches!(
                    block,
                    ContentBlock::ToolUse { .. } | ContentBlock::ToolResult { .. }
                )));
                assert!(
                    !blocks
                        .iter()
                        .any(|block| matches!(block, ContentBlock::Text { .. }))
                );
            }
            other => panic!("expected a tool patch, got {other:?}"),
        }
        let usage_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: 3,
                    output_tokens: 4,
                    ..ConversationUsage::default()
                },
            },
            None,
        )
        .await;
        let usage_ops = projector.apply(&usage_rec).expect("apply usage");
        match usage_ops.as_slice() {
            [ConversationRowOp::PatchBlocks { blocks, usage, .. }] => {
                assert!(blocks.is_empty());
                assert_eq!(usage.as_ref().map(|usage| usage.input_tokens), Some(3));
                assert_eq!(usage.as_ref().map(|usage| usage.output_tokens), Some(4));
            }
            other => panic!("expected a usage patch, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn usage_before_the_first_block_is_still_pushed_live() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let user_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "hi".into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("load projector");
        projector.apply(&user_rec).expect("apply user");

        let usage_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: 20,
                    output_tokens: 4,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 70,
                    context_used: Some(18_658),
                    context_window_max: Some(200_000),
                    ..ConversationUsage::default()
                },
            },
            None,
        )
        .await;
        let usage_ops = projector.apply(&usage_rec).expect("apply usage");
        match usage_ops.as_slice() {
            [
                ConversationRowOp::PatchBlocks {
                    blocks,
                    usage,
                    phase,
                    ..
                },
            ] => {
                assert!(blocks.is_empty());
                assert_eq!(phase, "streaming");
                let usage = usage.as_ref().expect("usage");
                assert_eq!(usage.input_tokens, 20);
                assert_eq!(usage.cache_read_input_tokens, 70);
                assert_eq!(usage.context_used, Some(18_658));
            }
            other => panic!("expected a usage patch before any block, got {other:?}"),
        }

        let text_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "hello".into(),
                message_id: None,
            },
            None,
        )
        .await;
        let text_ops = projector.apply(&text_rec).expect("apply text");
        assert!(
            matches!(text_ops.as_slice(), [ConversationRowOp::AppendText { .. }]),
            "a later text delta must not repeat the usage patch, got {text_ops:?}"
        );
    }

    #[tokio::test]
    async fn projector_strips_internal_messages_across_streaming_deltas_and_emits_captured_messages()
     {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let user_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "hi".into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let mut rx = crate::subscribe_internal_messages();
        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("load projector");
        projector.apply(&user_rec).expect("apply user");

        let chunk1 = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "Hello user!\n<vibex-internal-meta channel=\"vibex.memory:extract:n77\">{\"key\":".into(),
                message_id: None,
            },
            None,
        )
        .await;
        projector.apply(&chunk1).expect("apply chunk1");
        assert_eq!(
            projector.fold.turns[&turn_id].assistant.blocks,
            vec![ContentBlock::Text {
                text: "Hello user!\n".into()
            }]
        );
        assert!(rx.try_recv().is_err());

        let chunk2 = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "\"val\"}</vibex-internal-meta>\n\nHow can I help?".into(),
                message_id: None,
            },
            None,
        )
        .await;
        projector.apply(&chunk2).expect("apply chunk2");
        assert_eq!(
            projector.fold.turns[&turn_id].assistant.blocks,
            vec![ContentBlock::Text {
                text: "Hello user!\n\nHow can I help?".into()
            }]
        );
        let captured = rx.try_recv().expect("captured internal message");
        assert_eq!(captured.plugin_id, "vibex.memory");
        assert_eq!(captured.channel, "vibex.memory:extract:n77");
        assert_eq!(captured.nonce, "n77");
        assert_eq!(captured.parsed_payload, serde_json::json!({"key": "val"}));
    }

    #[tokio::test]
    async fn projector_handles_multibyte_utf8_streaming_deltas_without_panicking() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let user_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "你好".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("load projector");
        projector.apply(&user_rec).expect("apply user");

        // Exact crash sequence: 27-byte Chinese + ASCII text delta ("这个报错是模型 ID ")
        let chunk = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "这个报错是模型 ID ".into(),
                message_id: None,
            },
            None,
        )
        .await;
        let ops = projector.apply(&chunk).expect("apply multibyte chunk");
        assert_eq!(
            ops,
            vec![ConversationRowOp::AppendText {
                row_id: format!("{turn_id}:assistant"),
                revision: chunk.sequence,
                stream: TimelineTextStream::Text,
                delta: "这个报错是模型 ID ".into(),
            }]
        );
        assert_eq!(
            projector.fold.turns[&turn_id].assistant.blocks,
            vec![ContentBlock::Text {
                text: "这个报错是模型 ID ".into()
            }]
        );
    }

    #[tokio::test]
    async fn connection_status_and_binding_ready_refresh_snapshot_and_clear_recovering_notice() {
        use agents::conversation::ConversationAgentConnectionStatus;

        let pool = setup_pool().await;
        let (conversation_id, _turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Connecting,
                message: None,
                bound: false,
            },
            None,
        )
        .await;

        let side_rows_connecting =
            ConversationProjector::persisted_side_rows(&pool, conversation_id)
                .await
                .expect("persisted side rows after connecting");
        assert!(
            side_rows_connecting
                .iter()
                .any(|row| row.row_id == "notice:agent-connection-recovering"),
            "connecting status should persist notice:agent-connection-recovering into snapshot"
        );

        append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Ready,
                message: None,
                bound: true,
            },
            None,
        )
        .await;

        let side_rows_ready = ConversationProjector::persisted_side_rows(&pool, conversation_id)
            .await
            .expect("persisted side rows after ready");
        assert!(
            !side_rows_ready
                .iter()
                .any(|row| row.row_id == "notice:agent-connection-recovering"),
            "ready status must immediately refresh snapshot and remove notice:agent-connection-recovering"
        );
    }

    #[tokio::test]
    async fn stale_snapshot_with_recovering_notice_self_heals_on_persisted_side_rows_and_project_open()
     {
        use agents::conversation::ConversationAgentConnectionStatus;

        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "hello".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let connecting_rec = append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Connecting,
                message: None,
                bound: false,
            },
            None,
        )
        .await;
        let fold_at_connecting = ConversationProjector::fold(&pool, conversation_id)
            .await
            .expect("fold at connecting");
        assert_eq!(fold_at_connecting.last_sequence, connecting_rec.sequence);

        append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Ready,
                message: None,
                bound: true,
            },
            None,
        )
        .await;

        // Simulate a historical stale snapshot frozen at the `Connecting` sequence.
        ConversationProjector::persist_fold_to_pool(&pool, conversation_id, &fold_at_connecting)
            .await
            .expect("overwrite with stale snapshot");

        let healed_side_rows = ConversationProjector::persisted_side_rows(&pool, conversation_id)
            .await
            .expect("self-healed persisted_side_rows");
        assert!(
            !healed_side_rows
                .iter()
                .any(|row| row.row_id == "notice:agent-connection-recovering"),
            "persisted_side_rows must detect stale snapshot and fold tail events to clear notice"
        );

        // Overwrite again to test try_materialized_open / project_open self-healing.
        ConversationProjector::persist_fold_to_pool(&pool, conversation_id, &fold_at_connecting)
            .await
            .expect("overwrite with stale snapshot again");

        let open_proj = ConversationProjector::project_open(&pool, conversation_id, 50)
            .await
            .expect("project_open self-heals stale snapshot");
        assert!(
            !open_proj
                .timeline
                .rows
                .iter()
                .any(|row| row.row_id == "notice:agent-connection-recovering"),
            "project_open must bypass stale snapshot and not return notice:agent-connection-recovering"
        );
    }
