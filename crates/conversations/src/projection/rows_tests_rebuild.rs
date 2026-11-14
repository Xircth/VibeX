use super::*;
    #[tokio::test]
    async fn permission_view_carries_real_acp_detail_and_options() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        let request = AgentPermissionRequest {
            id: AgentPermissionId::new(),
            session_id: AgentSessionId::new(),
            title: "Edit README.md".into(),
            details: Some(serde_json::json!({
                "fields": { "kind": "edit", "content": [
                    { "type": "diff", "path": "README.md", "oldText": "a", "newText": "b" }
                ] }
            })),
            options: vec![
                AgentPermissionOption {
                    id: "allow".into(),
                    label: "Allow".into(),
                    kind: AgentPermissionOptionKind::AllowOnce,
                    description: None,
                },
                AgentPermissionOption {
                    id: "deny".into(),
                    label: "Deny".into(),
                    kind: AgentPermissionOptionKind::RejectOnce,
                    description: None,
                },
            ],
        };
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::PermissionRequested {
                request: ConversationPermissionRequest {
                    permission_id: "permission-1".into(),
                    request,
                },
            },
            None,
        )
        .await;

        // Reloading through the projection must preserve the full tool detail and
        // the selectable options — the card relies on these to show the real diff
        // and offer the real Allow/Reject answers after a refresh.
        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let permission = timeline
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::PermissionRequest { request } => Some(request),
                _ => None,
            })
            .expect("permission row");

        assert_eq!(permission.permission_id, "permission-1");
        assert_eq!(permission.status, "pending");
        assert_eq!(permission.options.len(), 2);
        assert_eq!(permission.options[0].id, "allow");
        let detail = permission.details.as_ref().expect("details preserved");
        assert_eq!(detail["fields"]["kind"], "edit");
        assert_eq!(detail["fields"]["content"][0]["path"], "README.md");
    }

    #[tokio::test]
    async fn delegated_child_assistant_deltas_without_a_turn_still_render() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: Some("introduce yourself"),
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create child conversation");

        append_event(
            &pool,
            conversation_id,
            None,
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "你好，我是 Codex".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("EndTurn".into()),
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project orphan assistant stream");
        let assistant = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.role == TurnRole::Assistant =>
            {
                Some(turn)
            }
            _ => None,
        });
        let assistant = assistant.expect("assistant message");
        assert!(
            assistant.blocks.iter().any(
                |block| matches!(block, ContentBlock::Text { text } if text.contains("Codex"))
            )
        );
        let user = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. } if turn.role == TurnRole::User => {
                Some(turn)
            }
            _ => None,
        });
        let user = user.expect("session prompt becomes the user message");
        assert!(user.blocks.iter().any(
            |block| matches!(block, ContentBlock::Text { text } if text == "introduce yourself")
        ));
    }

    #[tokio::test]
    async fn delegated_child_identity_is_linked_before_the_first_turn() {
        let pool = setup_pool().await;
        let (parent_conversation_id, _) = seed_turn(&pool).await;
        let child_conversation_id = Uuid::new_v4();
        create_delegated_conversation(
            &pool,
            CreateDelegatedConversation {
                id: child_conversation_id,
                parent_conversation_id,
                parent_tool_call_id: "tool-1".into(),
                delegation_id: "delegation-call-1".into(),
                agent_id: AgentId::parse("codex").unwrap(),
                prompt: "Review the diff".into(),
                policy: serde_json::json!({"workspaceAccess": "write_serialized"}),
            },
        )
        .await
        .expect("persist delegated child");

        let child = Session::find_by_id(&pool, child_conversation_id)
            .await
            .expect("load child")
            .expect("child row");
        assert_eq!(child.parent_session_id, Some(parent_conversation_id));
        assert_eq!(child.initial_prompt.as_deref(), Some("Review the diff"));
        let active_turn_id: Option<Uuid> =
            sqlx::query_scalar("SELECT active_turn_id FROM sessions WHERE id = ?")
                .bind(child_conversation_id)
                .fetch_one(&pool)
                .await
                .expect("load active turn");
        assert!(
            active_turn_id.is_none(),
            "identity must not pre-commit an in-flight Turn"
        );
        let timeline = ConversationProjector::project(&pool, child_conversation_id)
            .await
            .expect("project child");
        let user = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. } if turn.role == TurnRole::User => {
                Some(turn)
            }
            _ => None,
        });
        let user = user.expect("initial prompt is visible before the first turn");
        assert!(user.blocks.iter().any(
            |block| matches!(block, ContentBlock::Text { text } if text == "Review the diff")
        ));
    }

    #[tokio::test]
    async fn conversation_timeline_projection_folds_messages_and_errors() {
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
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "he".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "llo".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: 1,
                    output_tokens: 2,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    context_used: Some(120),
                    context_window_max: Some(200_000),
                    cost_amount: None,
                    cost_currency: None,
                    model: None,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnFailed {
                error: ConversationError {
                    message: "late visible error".into(),
                    code: None,
                    raw: None,
                    kind: Default::default(),
                    plan_usage: None,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project timeline");
        assert_eq!(timeline.last_sequence, 6);
        assert!(timeline.rows.len() >= 3);
        assert!(matches!(
            timeline.rows[0].row,
            ConversationTimelineRow::MessageTurn { .. }
        ));
        assert!(
            timeline
                .rows
                .iter()
                .any(|row| matches!(row.row, ConversationTimelineRow::TurnError { .. }))
        );
    }

    #[tokio::test]
    async fn rebuild_projection_matches_incremental_and_repopulates_tables() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
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
        append_event(
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
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "tool-1".into(),
                    title: Some("Edit".into()),
                    kind: Some("edit".into()),
                    status: Some("completed".into()),
                    raw_input: Some(serde_json::json!({"path":"a.rs"})),
                    raw_output: Some(serde_json::json!({"ok":true})),
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
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            },
            None,
        )
        .await;

        // The snapshot path (materialized on the TurnCompleted settle) must equal a
        // pure full fold of the same events.
        let incremental = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project via snapshot");
        let all_events = ConversationEventRecord::events_since(&pool, conversation_id, 0, i64::MAX)
            .await
            .expect("events");
        let pure = ConversationProjector::project_records(conversation_id, &all_events)
            .expect("pure fold");
        assert_eq!(incremental, pure, "snapshot+tail must equal pure fold");

        let tools_before =
            db::models::conversation_tool::ConversationToolCallRecord::list_for_conversation(
                &pool,
                conversation_id,
            )
            .await
            .expect("tools")
            .len();
        assert_eq!(tools_before, 1);

        // Authoritative rebuild from the event log must reproduce both the timeline
        // and the derived projection tables (without duplicating rows).
        ConversationProjector::rebuild_projection(&pool, conversation_id)
            .await
            .expect("rebuild");
        let rebuilt = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project after rebuild");
        assert_eq!(rebuilt, pure, "rebuilt projection must equal pure fold");

        let tools_after =
            db::models::conversation_tool::ConversationToolCallRecord::list_for_conversation(
                &pool,
                conversation_id,
            )
            .await
            .expect("tools")
            .len();
        assert_eq!(
            tools_after, 1,
            "rebuild must repopulate (not duplicate) derived tables"
        );
    }

    #[tokio::test]
    async fn question_and_feedback_responses_fold_onto_rows() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::QuestionRequested {
                request: ConversationQuestionRequest {
                    question_id: "q1".into(),
                    prompt: "Pick".into(),
                    options: vec!["A".into(), "B".into()],
                    asked_at: None,
                    schema: None,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::QuestionResponded {
                question_id: "q1".into(),
                response: ConversationQuestionResponse {
                    answer: "A".into(),
                    content: None,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::FeedbackRequested {
                request: ConversationFeedbackRequest {
                    feedback_id: "f1".into(),
                    prompt: "Rate".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::FeedbackSubmitted {
                feedback_id: "f1".into(),
                response: ConversationFeedbackResponse {
                    rating: "up".into(),
                    comment: None,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let question_answered = timeline.rows.iter().any(|row| {
            matches!(
                &row.row,
                ConversationTimelineRow::QuestionRequest { response: Some(answer), .. }
                    if answer.answer == "A"
            )
        });
        assert!(
            question_answered,
            "answered question must carry its response after the fold"
        );
        let feedback_answered = timeline.rows.iter().any(|row| {
            matches!(
                &row.row,
                ConversationTimelineRow::FeedbackRequest { response: Some(resp), .. }
                    if resp.rating == "up"
            )
        });
        assert!(
            feedback_answered,
            "submitted feedback must carry its response after the fold"
        );
    }

    #[tokio::test]
    async fn truncate_to_turn_ordinal_drops_target_turn_and_tail() {
        let pool = setup_pool().await;
        let (conversation_id, turn1_id) = seed_turn(&pool).await; // ordinal 1

        // Turn 1 (ordinal 1): user → assistant → completed (sequences 1,2,3).
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
        append_event(
            &pool,
            conversation_id,
            Some(turn1_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "one".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn1_id),
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            },
            None,
        )
        .await;

        // Turn 2 (ordinal 2): user → assistant (sequences 4,5).
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
        append_event(
            &pool,
            conversation_id,
            Some(turn2.id),
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
        append_event(
            &pool,
            conversation_id,
            Some(turn2.id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "two".into(),
                message_id: None,
            },
            None,
        )
        .await;

        let before = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project before");
        assert_eq!(before.last_sequence, 5);

        // Reset to here: drop turn 2 (ordinal 2) and everything after.
        ConversationProjector::truncate_to_turn_ordinal(&pool, conversation_id, 2)
            .await
            .expect("truncate");

        let remaining = ConversationTurnRecord::list_for_conversation(&pool, conversation_id)
            .await
            .expect("list turns");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].ordinal, 1);

        let event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(&pool)
        .await
        .expect("count events");
        assert_eq!(event_count, 3, "only turn 1's three events survive");

        let after = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project after");
        assert_eq!(after.last_sequence, 3);
    }

    #[tokio::test]
    async fn truncate_to_turn_does_not_requeue_the_truncated_turn_input() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");

        let (kept_input_id, _) = seed_durable_input_turn(&pool, conversation_id, "first").await;
        let (resent_input_id, _) = seed_durable_input_turn(&pool, conversation_id, "hello").await;
        let queued_follow_up = Uuid::new_v4();
        append_event(
            &pool,
            conversation_id,
            None,
            "user",
            ConversationEvent::ConversationInput {
                event: ConversationInputEvent::Submitted {
                    input_id: queued_follow_up,
                    operation_id: Uuid::new_v4(),
                    revision: 1,
                    sort_key: ConversationInputRecord::next_sort_key(&pool, conversation_id)
                        .await
                        .expect("sort key"),
                    payload_digest: format!("digest-{queued_follow_up}"),
                    payload: test_input_payload("follow-up"),
                    principal: serde_json::json!({ "kind": "test" }),
                },
            },
            None,
        )
        .await;

        ConversationProjector::truncate_to_turn_ordinal(&pool, conversation_id, 2)
            .await
            .expect("truncate");

        let remaining = ConversationInputRecord::list_for_conversation(&pool, conversation_id)
            .await
            .expect("list inputs");
        assert_eq!(
            remaining.iter().map(|input| input.id).collect::<Vec<_>>(),
            vec![kept_input_id],
            "reset-to-here must drop the truncated turn input and later queued follow-ups, or resend submits a duplicate"
        );
        assert_eq!(remaining[0].status, "dispatched");
        assert!(
            ConversationInputRecord::find_by_id(&pool, resent_input_id)
                .await
                .expect("lookup resent input")
                .is_none()
        );
        assert!(
            ConversationInputRecord::find_by_id(&pool, queued_follow_up)
                .await
                .expect("lookup follow-up")
                .is_none()
        );
    }

    #[tokio::test]
    async fn usage_occupancy_and_plan_status_replace_the_turn_block() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "do work".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::PlanUpdated {
                entries: vec![ConversationPlanEntry {
                    id: "plan-0".into(),
                    content: "Write tests".into(),
                    status: "pending".into(),
                    priority: Some("high".into()),
                }],
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::PlanUpdated {
                entries: vec![ConversationPlanEntry {
                    id: "plan-0".into(),
                    content: "Write tests".into(),
                    status: "completed".into(),
                    priority: Some("high".into()),
                }],
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    context_used: Some(12_000),
                    context_window_max: Some(200_000),
                    cost_amount: None,
                    cost_currency: None,
                    model: None,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let assistant = timeline
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(turn)
                }
                _ => None,
            })
            .expect("assistant turn");

        let plan_blocks = assistant
            .blocks
            .iter()
            .filter(|block| matches!(block, ContentBlock::Plan { .. }))
            .count();
        assert_eq!(plan_blocks, 1, "plan updates replace the existing block");
        match assistant.blocks.iter().find_map(|block| match block {
            ContentBlock::Plan { entries } => Some(entries.as_slice()),
            _ => None,
        }) {
            Some([entry]) => {
                assert_eq!(entry.content, "Write tests");
                assert_eq!(entry.status, "completed");
                assert_eq!(entry.priority.as_deref(), Some("high"));
            }
            other => panic!("expected one completed plan entry, got {other:?}"),
        }

        let usage = assistant.usage.as_ref().expect("usage");
        assert_eq!(usage.context_used, Some(12_000));
        assert_eq!(usage.context_window_max, Some(200_000));
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
    }

    #[tokio::test]
    async fn turn_less_late_updates_attach_to_the_latest_turn() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "late".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            None,
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "visible".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            None,
            "acp",
            ConversationEvent::AssistantContentAppended {
                block: ContentBlock::Resource {
                    uri: "file:///tmp/a.md".into(),
                    title: Some("a.md".into()),
                },
                message_id: None,
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let assistant = timeline
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(turn)
                }
                _ => None,
            })
            .expect("assistant row");
        assert!(
            assistant
                .blocks
                .iter()
                .any(|block| matches!(block, ContentBlock::Text { text } if text == "visible"))
        );
        assert!(assistant.blocks.iter().any(|block| matches!(
            block,
            ContentBlock::Resource { uri, .. } if uri == "file:///tmp/a.md"
        )));
    }

    #[tokio::test]
    async fn agent_binding_recovery_failed_notice_is_cleared_by_subsequent_recovery() {
        let pool = setup_pool().await;
        let (conversation_id, _turn_id) = seed_turn(&pool).await;
        append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentBindingRecoveryFailed {
                reason: "Failed to load session, starting new: Path not found.".into(),
            },
            None,
        )
        .await;
        let failed_timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline with failure");
        assert!(failed_timeline.rows.iter().any(|row| {
            matches!(
                &row.row,
                ConversationTimelineRow::SessionNotice { notice }
                    if notice.title == "Agent session recovery failed"
            )
        }));

        append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentBindingRecovered {
                strategy: agents::SessionRecoveryStrategy::CreatedNewSession,
                continues_from: Some("old-sid".into()),
            },
            None,
        )
        .await;
        let recovered_timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline after recovery");
        assert!(
            !recovered_timeline.rows.iter().any(|row| {
                matches!(
                    &row.row,
                    ConversationTimelineRow::SessionNotice { notice }
                        if notice.title == "Agent session recovery failed"
                )
            }),
            "AgentBindingRecovered must clear the AgentBindingRecoveryFailed error banner"
        );
    }
