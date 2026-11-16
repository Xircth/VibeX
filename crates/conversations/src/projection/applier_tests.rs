    use agents::{
        AcpCapabilitySnapshot, AgentId, AgentPermissionId, AgentPermissionOption,
        AgentPermissionOptionKind, AgentPermissionRequest, AgentPermissionResponse,
        AgentSessionConfigOption, AgentSessionId,
        conversation::{
            AgentPromptCapabilities, ConversationEvent, ConversationFileChange,
            ConversationFileChangeSummary, ConversationInputBlock, ConversationPermissionRequest,
            ConversationPermissionResponse, ConversationTerminalPatch, ConversationToolCallPatch,
            ConversationUsage,
        },
    };
    use db::models::{
        conversation::{
            ConversationAgentBindingRecord, CreateConversationAgentBinding, DbConversationSummary,
        },
        conversation_event::{AppendConversationEvent, ConversationEventRecord},
        conversation_turn::ConversationTurnRecord,
        session::Session,
    };
    use uuid::Uuid;

    use super::{ConversationEventAppender, ConversationStateApplier};
    use crate::projection::{
        CONVERSATION_PROJECTION_VERSION,
        rows::tests::{append_event, seed_turn, setup_pool},
    };
    #[tokio::test]
    async fn negotiated_handshake_snapshot_updates_binding_columns() {
        let pool = setup_pool().await;
        let (conversation_id, _) = seed_turn(&pool).await;
        let agent_id = AgentId::parse("codex").unwrap();
        ConversationAgentBindingRecord::create(
            &pool,
            Uuid::new_v4(),
            CreateConversationAgentBinding {
                conversation_id,
                agent_id: &agent_id,
                working_dir: "/tmp/work",
                acp_session_id: None,
                continuation_key: None,
                acp_protocol_version: None,
                runtime_version: None,
                acp_version: None,
                load_supported: false,
                resume_supported: false,
                close_supported: false,
                terminal_supported: false,
                additional_directories_supported: false,
                prompt_capabilities_json:
                    r#"{"text":true,"image":false,"audio":false,"resource":false,"resource_link":true}"#,
                session_capabilities_json: "{}",
                client_capabilities_json: "{}",
                mcp_servers_json: "[]",
                modes_json: "[]",
                config_options_json: "[]",
                current_mode: None,
                config_selection_json: "{}",
                status: db::models::conversation::BindingStatus::Connecting,
            },
        )
        .await
        .expect("create conservative binding");

        let capabilities = AcpCapabilitySnapshot {
            load_session: false,
            resume_session: true,
            close_session: false,
            terminal: true,
            additional_directories: true,
            mcp_stdio: true,
            prompt: AgentPromptCapabilities {
                text: true,
                image: false,
                resource_link: true,
                ..Default::default()
            },
            ..Default::default()
        };

        append_event(
            &pool,
            conversation_id,
            None,
            "acp",
            ConversationEvent::AgentBindingReady {
                acp_session_id: "acp-session-1".into(),
                capabilities,
            },
            None,
        )
        .await;

        let binding =
            ConversationAgentBindingRecord::latest_for_conversation(&pool, conversation_id)
                .await
                .expect("latest binding")
                .expect("binding exists");
        assert!(!binding.load_supported);
        assert!(binding.resume_supported);
        assert!(!binding.close_supported);
        assert!(binding.terminal_supported);
        assert!(binding.additional_directories_supported);
        let prompt: serde_json::Value =
            serde_json::from_str(&binding.prompt_capabilities_json).expect("prompt json");
        assert_eq!(prompt["text"], true);
        assert_eq!(prompt["image"], false);
        assert_eq!(prompt["resource_link"], true);
        let session: AcpCapabilitySnapshot =
            serde_json::from_str(&binding.session_capabilities_json).expect("session json");
        assert!(session.mcp_stdio);
        assert!(!session.load_session);
        assert!(session.resume_session);
    }

    #[tokio::test]
    async fn usage_and_config_events_cache_session_model() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::SessionConfigOptionsUpdated {
                options: vec![AgentSessionConfigOption {
                    key: "model".into(),
                    label: "Model".into(),
                    description: None,
                    category: Some("model".into()),
                    value: Some(serde_json::json!("grok-4.6")),
                    choices: Vec::new(),
                    dependency: None,
                }],
            },
            None,
        )
        .await;

        let session = DbConversationSummary::find_by_id(&pool, conversation_id)
            .await
            .expect("load")
            .expect("session");
        assert_eq!(session.model.as_deref(), Some("grok-4.6"));

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: 29_214,
                    output_tokens: 1_652,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 56_960,
                    context_used: Some(18_658),
                    context_window_max: Some(500_000),
                    cost_amount: None,
                    cost_currency: None,
                    model: Some("grok-4.6".into()),
                },
            },
            None,
        )
        .await;

        let snapshot = db::models::conversation_usage::ConversationUsageSnapshotRecord::find(
            &pool,
            conversation_id,
        )
        .await
        .expect("snapshot")
        .expect("exists");
        assert_eq!(snapshot.model.as_deref(), Some("grok-4.6"));
        assert_eq!(snapshot.protocol_total_tokens, Some(87_826));
    }

    #[tokio::test]
    async fn conversation_state_applier_skips_unknown_event() {
        // An event this build can't parse (e.g. written by a newer version) must not
        // fail the projection — `apply_record` skips it, applying no side-effects.
        let pool = setup_pool().await;
        let mut conn = pool.acquire().await.expect("acquire connection");
        ConversationStateApplier::apply_record(
            &mut conn,
            &ConversationEventRecord {
                id: Uuid::new_v4(),
                conversation_id: Uuid::new_v4(),
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                sequence: 1,
                source: "test".to_string(),
                event_kind: "bogus_kind".to_string(),
                event_version: 999,
                normalized_json: r#"{"kind":"bogus_kind","payload":"unparseable"}"#.to_string(),
                raw_json: None,
                idempotency_key: None,
                created_at: chrono::Utc::now(),
            },
        )
        .await
        .expect("unknown event should be skipped, not fail");
    }

    #[tokio::test]
    async fn completed_unviewed_turn_moves_session_to_in_review() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;

        let session = Session::find_by_id(&pool, conversation_id)
            .await
            .expect("load session")
            .expect("session");
        assert_eq!(session.status, db::models::session::SessionStatus::InReview);
    }

    #[tokio::test]
    async fn viewing_a_completed_turn_moves_session_to_done() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;
        crate::workbench_status::mark_latest_turn_viewed(&pool, conversation_id)
            .await
            .expect("mark viewed");

        let session = Session::find_by_id(&pool, conversation_id)
            .await
            .expect("load session")
            .expect("session");
        assert_eq!(session.status, db::models::session::SessionStatus::Done);
    }

    #[tokio::test]
    async fn viewing_an_in_flight_turn_stays_in_review_when_the_turn_completes() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        crate::workbench_status::mark_latest_turn_viewed(&pool, conversation_id)
            .await
            .expect("view while the turn is still in flight");
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;

        let session = Session::find_by_id(&pool, conversation_id)
            .await
            .expect("load session")
            .expect("session");
        assert_eq!(session.status, db::models::session::SessionStatus::InReview);
        let viewed: Option<Uuid> =
            sqlx::query_scalar("SELECT last_viewed_turn_id FROM sessions WHERE id = ?")
                .bind(conversation_id)
                .fetch_one(&pool)
                .await
                .expect("view cursor");
        assert_ne!(viewed, Some(turn_id));
    }

    #[tokio::test]
    async fn in_flight_view_cursor_is_cleared_when_the_turn_completes() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        sqlx::query(
            "UPDATE sessions SET status = 'inprogress', last_viewed_turn_id = ? WHERE id = ?",
        )
        .bind(turn_id)
        .bind(conversation_id)
        .execute(&pool)
        .await
        .expect("record an in-flight view");
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;

        let session = Session::find_by_id(&pool, conversation_id)
            .await
            .expect("load session")
            .expect("session");
        assert_eq!(session.status, db::models::session::SessionStatus::InReview);
    }

    #[tokio::test]
    async fn manual_done_during_an_in_flight_turn_stays_done_after_completion() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        crate::workbench_status::apply_manual_status(
            &pool,
            conversation_id,
            db::models::session::SessionStatus::Done,
        )
        .await
        .expect("drag to done");
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;

        let session = Session::find_by_id(&pool, conversation_id)
            .await
            .expect("load session")
            .expect("session");
        assert_eq!(session.status, db::models::session::SessionStatus::Done);
    }

    #[tokio::test]
    async fn cancelled_turn_moves_session_to_done() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCancelled { reason: None },
            None,
        )
        .await;

        let session = Session::find_by_id(&pool, conversation_id)
            .await
            .expect("load session")
            .expect("session");
        assert_eq!(session.status, db::models::session::SessionStatus::Done);
    }

    #[tokio::test]
    async fn conversation_event_appender_dedupes_and_applies_turn_state() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        let first = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnStarted,
            Some("start"),
        )
        .await;
        let duplicate = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnStarted,
            Some("start"),
        )
        .await;
        assert_eq!(duplicate.id, first.id);

        let turn = ConversationTurnRecord::find_by_ordinal(&pool, conversation_id, 1)
            .await
            .expect("find turn")
            .expect("turn");
        assert_eq!(turn.status, "running");
    }

    #[tokio::test]
    async fn conversation_turn_state_is_event_driven() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnBlocked {
                reason: agents::conversation::TurnBlockedReason::Other {
                    message: "waiting".into(),
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

        let turn = ConversationTurnRecord::find_by_ordinal(&pool, conversation_id, 1)
            .await
            .expect("find turn")
            .expect("turn");
        assert_eq!(turn.status, "completed");
        assert_eq!(turn.stop_reason.as_deref(), Some("end_turn"));
    }

    #[tokio::test]
    async fn conversation_tool_projection_updates_by_tool_call_id() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

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
                    status: Some("running".into()),
                    raw_input: Some(serde_json::json!({"path":"src/main.rs"})),
                    raw_output: None,
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
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "tool-1".into(),
                    title: None,
                    kind: None,
                    status: Some("completed".into()),
                    raw_input: None,
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

        let tools = db::models::conversation_tool::ConversationToolCallRecord::list_for_turn(
            &pool, turn_id,
        )
        .await
        .expect("tools");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].status, "completed");
        assert!(tools[0].raw_input_json.is_some());
        assert!(tools[0].raw_output_json.is_some());
    }

    #[tokio::test]
    async fn conversation_side_effect_projection_updates_state_tables() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        let request = AgentPermissionRequest {
            id: AgentPermissionId::new(),
            session_id: AgentSessionId::new(),
            title: "Run command".into(),
            details: None,
            options: vec![AgentPermissionOption {
                id: "allow".into(),
                label: "Allow".into(),
                kind: AgentPermissionOptionKind::AllowOnce,
                description: None,
            }],
            revision: 1,
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
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::PermissionResponded {
                permission_id: "permission-1".into(),
                response: ConversationPermissionResponse {
                    response: AgentPermissionResponse::selected("allow"),
                    auto: false,
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
            ConversationEvent::TerminalUpdated {
                terminal: ConversationTerminalPatch {
                    terminal_id: "terminal-1".into(),
                    command: Some("cargo".into()),
                    args: vec!["test".into()],
                    cwd: None,
                    status: "exited".into(),
                    output_summary: Some("ok".into()),
                    output_truncated: false,
                    exit_status: Some(serde_json::json!({"code":0})),
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
            ConversationEvent::FileChangeSummaryUpdated {
                summary: ConversationFileChangeSummary {
                    source: "checkpoint_diff".into(),
                    files: vec![ConversationFileChange {
                        path: "src/main.rs".into(),
                        change_kind: "modified".into(),
                        additions: Some(1),
                        deletions: Some(0),
                        old_path: None,
                    }],
                    summary: Some("changed".into()),
                },
            },
            None,
        )
        .await;

        assert_eq!(
            db::models::conversation_side_effects::ConversationPermissionRecord::list_for_turn(
                &pool, turn_id
            )
            .await
            .expect("permissions")[0]
                .status,
            "responded"
        );
        assert_eq!(
            db::models::conversation_side_effects::ConversationTerminalRecord::list_for_turn(
                &pool, turn_id
            )
            .await
            .expect("terminals")
            .len(),
            1
        );
        assert_eq!(
            db::models::conversation_side_effects::ConversationFileChangeRecord::list_for_turn(
                &pool, turn_id
            )
            .await
            .expect("files")
            .len(),
            1
        );
    }

    #[tokio::test]
    async fn conversation_checkpoint_file_changes_are_projected_from_event() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::FileChangeSummaryUpdated {
                summary: ConversationFileChangeSummary {
                    source: "checkpoint_diff".into(),
                    files: vec![ConversationFileChange {
                        path: "src/lib.rs".into(),
                        change_kind: "modified".into(),
                        additions: Some(10),
                        deletions: Some(2),
                        old_path: None,
                    }],
                    summary: Some("checkpoint diff".into()),
                },
            },
            None,
        )
        .await;

        let files =
            db::models::conversation_side_effects::ConversationFileChangeRecord::list_for_turn(
                &pool, turn_id,
            )
            .await
            .expect("files");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].source, "checkpoint_diff");
        assert_eq!(files[0].path, "src/lib.rs");
    }

    #[tokio::test]
    async fn append_rolls_back_event_when_apply_fails() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        // A well-formed event whose *side-effect* insert fails: the terminal status is
        // not in the `conversation_terminals` CHECK allowlist, so `apply_record` errors
        // mid-transaction. The single append transaction must roll back — no orphaned
        // event row. (Unparseable events are now tolerated, so a real DB failure is the
        // right way to exercise the atomicity guarantee.)
        let event = ConversationEvent::TerminalUpdated {
            terminal: ConversationTerminalPatch {
                terminal_id: "term-1".into(),
                command: None,
                args: Vec::new(),
                cwd: None,
                status: "not_a_valid_status".into(),
                output_summary: None,
                output_truncated: false,
                exit_status: None,
            },
        };
        let normalized_json = serde_json::to_string(&event).expect("event json");
        let result = ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "runtime",
                event_kind: "terminal_updated",
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await;
        assert!(
            result.is_err(),
            "append must fail when projection apply fails"
        );

        let events = ConversationEventRecord::events_since(&pool, conversation_id, 0, i64::MAX)
            .await
            .expect("events");
        assert!(
            events.is_empty(),
            "failed append must not leave an orphaned event row"
        );
    }

    #[tokio::test]
    async fn snapshot_and_rows_are_materialized_incrementally_on_every_append() {
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
                text: "ok".into(),
                message_id: None,
            },
            None,
        )
        .await;
        let mid_snapshot =
            db::models::conversation_snapshot::ConversationProjectionSnapshotRecord::find(
                &pool,
                conversation_id,
            )
            .await
            .expect("find mid-turn snapshot")
            .expect("snapshot materialized incrementally before turn settles");
        assert_eq!(mid_snapshot.last_sequence, 2);
        // 1 user row + 1 assistant row + 1 active `status:agent-request` notice = 3 rows
        assert_eq!(mid_snapshot.total_rows, 3);
        let mid_rows =
            db::models::conversation_timeline_row::ConversationTimelineRowRecord::list_range(
                &pool,
                conversation_id,
                0,
                10,
            )
            .await
            .expect("list mid-turn materialized rows");
        let user_row_id = format!("{turn_id}:user");
        let assistant_row_id = format!("{turn_id}:assistant");
        let mid_user_row = mid_rows
            .iter()
            .find(|r| r.row_id == user_row_id)
            .expect("mid-turn user row present");
        assert_eq!(
            mid_user_row.revision, 1,
            "user row revision must remain 1 across streaming assistant deltas"
        );

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
        let snapshot =
            db::models::conversation_snapshot::ConversationProjectionSnapshotRecord::find(
                &pool,
                conversation_id,
            )
            .await
            .expect("find snapshot")
            .expect("snapshot exists after settle");
        assert_eq!(snapshot.last_sequence, 3);
        // `TurnCompleted` transitions `status:agent-request` to `Completed` (1 global side row)
        // alongside `{turn_id}:user` and `{turn_id}:assistant` = 3 active rows.
        assert_eq!(snapshot.total_rows, 3);
        assert_eq!(
            snapshot.projection_version,
            CONVERSATION_PROJECTION_VERSION as i64
        );

        let rows = db::models::conversation_timeline_row::ConversationTimelineRowRecord::list_range(
            &pool,
            conversation_id,
            0,
            10,
        )
        .await
        .expect("list materialized rows");
        assert_eq!(rows.len(), 3);
        let user_row = rows
            .iter()
            .find(|r| r.row_id == user_row_id)
            .expect("user row present");
        let assistant_row = rows
            .iter()
            .find(|r| r.row_id == assistant_row_id)
            .expect("assistant row present");
        assert_eq!(
            user_row.revision, 3,
            "TurnCompleted transitions user row phase from streaming to settled and bumps its revision"
        );
        assert_eq!(assistant_row.revision, 3);
    }

    #[tokio::test]
    async fn append_batch_isolates_savepoint_item_failure_and_commits_siblings() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        let ev0 = ConversationEvent::UserTurnCreated {
            blocks: vec![ConversationInputBlock::Text {
                text: "batch hello".into(),
            }],
            workflow_refs: Vec::new(),
        };
        // Reordering a nonexistent ConversationInput fails inside `ConversationStateApplier`
        // AFTER `insert_conversation_event`, exercising full SAVEPOINT rollback of item 1.
        let ev1_bad = ConversationEvent::ConversationInput {
            event: agents::ConversationInputEvent::Reordered {
                input_id: Uuid::new_v4(),
                revision: 2,
                sort_key: 100,
            },
        };
        let ev2 = ConversationEvent::AssistantTextDelta {
            text: "batch world".into(),
            message_id: None,
        };

        let batch = vec![
            super::BatchConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "user".into(),
                event_kind: "user_turn_created".into(),
                normalized_json: serde_json::to_string(&ev0).unwrap(),
                raw_json: None,
                idempotency_key: None,
                checkpoint_update: None,
            },
            super::BatchConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "user".into(),
                event_kind: "conversation_input".into(),
                normalized_json: serde_json::to_string(&ev1_bad).unwrap(),
                raw_json: None,
                idempotency_key: None,
                checkpoint_update: None,
            },
            super::BatchConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "acp".into(),
                event_kind: "assistant_text_delta".into(),
                normalized_json: serde_json::to_string(&ev2).unwrap(),
                raw_json: None,
                idempotency_key: None,
                checkpoint_update: None,
            },
        ];

        let outcome = ConversationEventAppender::append_batch(&pool, &batch)
            .await
            .expect("append_batch outer transaction commits");
        assert_eq!(outcome.committed.len(), 2);
        assert_eq!(outcome.committed[0].index, 0);
        assert_eq!(outcome.committed[1].index, 2);
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].0, 1);

        let open = crate::ConversationProjector::project_open(&pool, conversation_id, 16)
            .await
            .expect("project_open");
        assert_eq!(open.timeline.rows.len(), 3);
        let full = crate::ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project full");
        assert_eq!(open.timeline.rows, full.rows);
    }

    #[tokio::test]
    async fn incremental_projection_matches_full_fold_and_emits_tombstones_on_truncate() {
        let pool = setup_pool().await;
        let (conversation_id, turn1_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn1_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "first prompt".into(),
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
                text: "first reply".into(),
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

        let turn2 = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            db::models::conversation_turn::CreateConversationTurn {
                conversation_id,
                prompt_id: Some("p2"),
                text_preview: Some("second prompt"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn 2");
        append_event(
            &pool,
            conversation_id,
            Some(turn2.id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "second prompt".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let pre_truncate_end = append_event(
            &pool,
            conversation_id,
            Some(turn2.id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "second reply".into(),
                message_id: None,
            },
            None,
        )
        .await;
        assert_eq!(pre_truncate_end.sequence, 5);

        let open_before = crate::ConversationProjector::project_open(&pool, conversation_id, 50)
            .await
            .expect("open before");
        let full_before = crate::ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("full before");
        assert_eq!(open_before.timeline.rows, full_before.rows);

        crate::ConversationProjector::truncate_to_turn_ordinal(&pool, conversation_id, 2)
            .await
            .expect("truncate turn 2");

        let delta =
            db::models::conversation_timeline_row::ConversationTimelineRowRecord::rows_since_executor(
                &pool,
                conversation_id,
                5,
            )
            .await
            .expect("rows_since after truncate");
        assert_eq!(delta.tombstones.len(), 2);
        assert!(delta.tombstones.iter().all(|t| t.deleted_sequence > 5));

        let turn2_retry = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            db::models::conversation_turn::CreateConversationTurn {
                conversation_id,
                prompt_id: Some("p2-retry"),
                text_preview: Some("retry"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn 2 retry");
        let retry_ev = append_event(
            &pool,
            conversation_id,
            Some(turn2_retry.id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "retry prompt".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        assert!(
            retry_ev.sequence > delta.tombstones[0].deleted_sequence,
            "post-truncate sequence must never regress"
        );
    }
