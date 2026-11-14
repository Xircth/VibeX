    use std::str::FromStr;

    use agents::{
        AgentId, AgentPermissionId, AgentPermissionOption, AgentPermissionOptionKind,
        AgentPermissionRequest, AgentPermissionResponse, AgentSessionId,
        conversation::{
            ContentBlock, ConversationArtifactReference, ConversationDelegation,
            ConversationDelegationResult, ConversationError, ConversationEvent,
            ConversationFeedbackRequest, ConversationFeedbackResponse, ConversationInputBlock,
            ConversationInputEvent, ConversationInputPayload, ConversationPermissionRequest,
            ConversationPermissionResponse, ConversationPlanEntry, ConversationQuestionRequest,
            ConversationQuestionResponse, ConversationTimelineRow, ConversationToolCallPatch,
            ConversationUsage, TurnRole,
        },
    };
    use db::models::{
        conversation::{
            ConversationAgentBindingRecord, ConversationRecord, CreateConversationAgentBinding,
            CreateConversationRecord,
        },
        conversation_event::{
            AppendConversationEvent, CURRENT_EVENT_VERSION, ConversationEventRecord,
        },
        conversation_input::ConversationInputRecord,
        conversation_relation::ConversationRelationRecord,
        conversation_snapshot::ConversationProjectionSnapshotRecord,
        conversation_tool::ConversationToolCallRecord,
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
        session::Session,
    };
    use sqlx::{
        SqlitePool,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };
    use uuid::Uuid;

    use super::{ConversationSessionNotice, side_row};
    use crate::{
        CreateDelegatedConversation, create_delegated_conversation,
        projection::{
            CONVERSATION_PROJECTION_VERSION, ConversationEventAppender, ConversationProjector,
            ProjectionFold, ProjectionSnapshotState,
        },
    };
    pub(in crate::projection) fn record_of(
        conversation_id: Uuid,
        sequence: i64,
        event: ConversationEvent,
    ) -> ConversationEventRecord {
        ConversationEventRecord {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: None,
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            sequence,
            source: "acp".into(),
            event_kind: "test".into(),
            event_version: CURRENT_EVENT_VERSION,
            normalized_json: serde_json::to_string(&event).expect("event json"),
            raw_json: None,
            idempotency_key: None,
            created_at: chrono::Utc::now(),
        }
    }

    pub(in crate::projection) async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    pub(in crate::projection) async fn setup_temp_pool() -> (tempfile::TempDir, SqlitePool) {
        let dir = tempfile::tempdir().expect("temp db dir");
        let options = SqliteConnectOptions::new()
            .filename(dir.path().join("conversations.sqlite"))
            .create_if_missing(true)
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect temp db");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        (dir, pool)
    }

    pub(in crate::projection) async fn seed_turn(pool: &SqlitePool) -> (Uuid, Uuid) {
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");
        let turn = ConversationTurnRecord::create_pending(
            pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-1"),
                text_preview: Some("hello"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");
        (conversation_id, turn.id)
    }

    pub(in crate::projection) fn diagnostic_record(
        conversation_id: Uuid,
        sequence: i64,
        event: &ConversationEvent,
    ) -> ConversationEventRecord {
        ConversationEventRecord {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: None,
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            sequence,
            source: "acp".into(),
            event_kind: "raw_diagnostic_recorded".into(),
            event_version: CURRENT_EVENT_VERSION,
            normalized_json: serde_json::to_string(event).expect("diagnostic json"),
            raw_json: None,
            idempotency_key: None,
            created_at: chrono::Utc::now(),
        }
    }

    pub(in crate::projection) async fn append_event(
        pool: &SqlitePool,
        conversation_id: Uuid,
        turn_id: Option<Uuid>,
        source: &'static str,
        event: ConversationEvent,
        idempotency_key: Option<&'static str>,
    ) -> ConversationEventRecord {
        let value = serde_json::to_value(&event).expect("event value");
        let event_kind = value["kind"].as_str().expect("event kind").to_string();
        let normalized_json = serde_json::to_string(&event).expect("event json");
        ConversationEventAppender::append(
            pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source,
                event_kind: &event_kind,
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key,
            },
        )
        .await
        .expect("append event")
    }

    pub(in crate::projection) fn test_input_payload(text: &str) -> ConversationInputPayload {
        ConversationInputPayload {
            continuation_policy: None,
            expected_binding_revision: None,
            agent_id: AgentId::parse("codex").expect("agent id"),
            workspace_id: Uuid::new_v4(),
            executor_profile_id: None,
            text: text.to_string(),
            display_text: None,
            images: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            workflow_refs: Vec::new(),
            file_refs: Vec::new(),
            internal_prompt_contributions: Vec::new(),
            collaboration_origin: None,
        }
    }

    pub(in crate::projection) async fn seed_durable_input_turn(
        pool: &SqlitePool,
        conversation_id: Uuid,
        text: &str,
    ) -> (Uuid, Uuid) {
        let input_id = Uuid::new_v4();
        let claim_token = Uuid::new_v4();
        let payload = test_input_payload(text);
        append_event(
            pool,
            conversation_id,
            None,
            "user",
            ConversationEvent::ConversationInput {
                event: ConversationInputEvent::Submitted {
                    input_id,
                    operation_id: Uuid::new_v4(),
                    revision: 1,
                    sort_key: ConversationInputRecord::next_sort_key(pool, conversation_id)
                        .await
                        .expect("sort key"),
                    payload_digest: format!("digest-{input_id}"),
                    payload,
                    principal: serde_json::json!({ "kind": "test" }),
                },
            },
            None,
        )
        .await;
        append_event(
            pool,
            conversation_id,
            None,
            "system",
            ConversationEvent::ConversationInput {
                event: ConversationInputEvent::Claimed {
                    input_id,
                    claim_token,
                    claim_deadline: chrono::Utc::now() + chrono::Duration::seconds(30),
                },
            },
            None,
        )
        .await;
        let turn = ConversationTurnRecord::create_pending(
            pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt"),
                text_preview: Some(text),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");
        append_event(
            pool,
            conversation_id,
            Some(turn.id),
            "system",
            ConversationEvent::ConversationInput {
                event: ConversationInputEvent::Dispatched {
                    input_id,
                    claim_token,
                    turn_id: turn.id,
                },
            },
            None,
        )
        .await;
        append_event(
            pool,
            conversation_id,
            Some(turn.id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: text.into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        (input_id, turn.id)
    }

    #[tokio::test]
    async fn artifact_revision_event_projects_reference_without_file_bytes() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let artifact_id = Uuid::new_v4();

        let record = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::ArtifactRevisionRecorded {
                artifact: ConversationArtifactReference {
                    artifact_id,
                    workspace_id: Some(Uuid::new_v4()),
                    relative_path: "reports/quarter.xlsx".into(),
                    media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        .into(),
                    content_hash: "a".repeat(64),
                    revision: 1,
                    plugin_id: "builtin.office".into(),
                    plugin_version: "2.0.0".into(),
                    provider_id: "officecli".into(),
                    tool_lock_id: "officecli:test:1.0.140".into(),
                },
            },
            Some("artifact-revision-1"),
        )
        .await;

        assert_eq!(record.event_kind, "artifact_revision_recorded");
        assert!(record.normalized_json.contains(&artifact_id.to_string()));
        assert!(!record.normalized_json.contains("\"bytes\""));
        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project artifact event");
        assert_eq!(timeline.last_sequence, record.sequence);
        let artifact_row = timeline
            .rows
            .iter()
            .find(|row| {
                matches!(
                    &row.row,
                    ConversationTimelineRow::ArtifactRevision { artifact }
                        if artifact.artifact_id == artifact_id
                )
            })
            .expect("artifact revision row");
        assert_eq!(artifact_row.row_id, format!("artifact:{artifact_id}:1"));

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::ArtifactRevisionRecorded {
                artifact: ConversationArtifactReference {
                    artifact_id,
                    workspace_id: Some(Uuid::new_v4()),
                    relative_path: "reports/quarter.xlsx".into(),
                    media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        .into(),
                    content_hash: "b".repeat(64),
                    revision: 2,
                    plugin_id: "builtin.office".into(),
                    plugin_version: "2.0.0".into(),
                    provider_id: "officecli".into(),
                    tool_lock_id: "officecli:test:1.0.140".into(),
                },
            },
            Some("artifact-revision-2"),
        )
        .await;
        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project both artifact revisions");
        assert_eq!(
            timeline
                .rows
                .iter()
                .filter(|row| matches!(
                    &row.row,
                    ConversationTimelineRow::ArtifactRevision { artifact }
                        if artifact.artifact_id == artifact_id
                ))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn artifact_projection_rebuilds_a_v3_snapshot_that_skipped_artifacts() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let artifact_id = Uuid::new_v4();
        let record = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::ArtifactRevisionRecorded {
                artifact: ConversationArtifactReference {
                    artifact_id,
                    workspace_id: Some(Uuid::new_v4()),
                    relative_path: "reports/history.pptx".into(),
                    media_type:
                        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                            .into(),
                    content_hash: "b".repeat(64),
                    revision: 1,
                    plugin_id: "builtin.office".into(),
                    plugin_version: "2.0.0".into(),
                    provider_id: "officecli".into(),
                    tool_lock_id: "officecli:test:1.0.140".into(),
                },
            },
            Some("artifact-v3-snapshot"),
        )
        .await;

        let skipped_artifact_snapshot = serde_json::to_string(&ProjectionSnapshotState {
            turns: Vec::new(),
            side_rows: Vec::new(),
            last_sequence: record.sequence,
            auto_permission_approvals: 0,
        })
        .expect("serialize v3 snapshot");
        ConversationProjectionSnapshotRecord::upsert(
            &pool,
            conversation_id,
            3,
            record.sequence,
            &skipped_artifact_snapshot,
            0,
            None,
        )
        .await
        .expect("seed stale v3 snapshot");

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("rebuild artifact projection");
        assert!(
            timeline.rows.iter().any(|row| {
                matches!(
                    &row.row,
                    ConversationTimelineRow::ArtifactRevision { artifact }
                        if artifact.artifact_id == artifact_id
                )
            }),
            "a predecessor v3 snapshot that skipped Artifact events must be rebuilt"
        );
    }

    #[tokio::test]
    async fn unknown_event_renders_placeholder_row_and_timeline_still_loads() {
        // Acceptance for 批次A: a forward-incompatible event surrounded by normal
        // events must not break timeline loading — it shows as a single placeholder
        // row while every other event folds as usual.
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnStarted,
            None,
        )
        .await;

        // A bogus event whose payload no known variant can parse, inserted through the
        // real append path (idempotency/sequence/side-effects all exercised).
        ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source: "acp",
                event_kind: "bogus_kind",
                normalized_json: r#"{"kind":"bogus_kind","from_the_future":true}"#,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append bogus event");

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

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline still loads despite the unknown event");

        let placeholders: Vec<_> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::SessionNotice { notice }
                    if notice.title == "部分会话记录无法显示" =>
                {
                    Some(notice)
                }
                _ => None,
            })
            .collect();
        assert_eq!(placeholders.len(), 1, "exactly one placeholder row");
        assert_eq!(
            placeholders[0].message.as_deref(),
            Some("VibeX 无法读取其中一条历史记录，其余会话内容不受影响。")
        );

        // The normal assistant text still folded through, proving the unknown event
        // did not abort the rest of the timeline.
        let has_assistant_text = timeline.rows.iter().any(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. } => turn
                .blocks
                .iter()
                .any(|block| matches!(block, ContentBlock::Text { text } if text == "hello")),
            _ => false,
        });
        assert!(has_assistant_text, "surrounding events still fold");
    }

    #[tokio::test]
    async fn stale_snapshot_version_replays_events_instead_of_cached_notices() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source: "acp",
                event_kind: "agent_binding_started",
                normalized_json: r#"{
                    "kind":"agent_binding_started",
                    "agent_type":"codex",
                    "working_dir":"/tmp/project"
                }"#,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append legacy event");

        let mut stale_fold = ProjectionFold {
            last_sequence: 1,
            ..ProjectionFold::default()
        };
        stale_fold.side_rows.push(side_row(
            1,
            ConversationTimelineRow::SessionNotice {
                notice: ConversationSessionNotice {
                    title: "cached stale notice".into(),
                    message: None,
                    severity: "warning".into(),
                    ..Default::default()
                },
            },
        ));
        let fold_json = serde_json::to_string(&stale_fold.to_snapshot_state())
            .expect("serialize stale snapshot");
        ConversationProjectionSnapshotRecord::upsert(
            &pool,
            conversation_id,
            i64::from(CONVERSATION_PROJECTION_VERSION) - 1,
            1,
            &fold_json,
            0,
            None,
        )
        .await
        .expect("persist stale snapshot");

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("stale snapshot should be rebuilt");
        assert!(
            timeline
                .rows
                .iter()
                .all(|row| !matches!(row.row, ConversationTimelineRow::SessionNotice { .. }))
        );
    }

    #[tokio::test]
    async fn legacy_capability_snapshot_does_not_render_unknown_event_notice() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source: "acp",
                event_kind: "agent_binding_ready",
                normalized_json: r#"{
                    "kind":"agent_binding_ready",
                    "acp_session_id":"legacy-session",
                    "capabilities":{
                        "prompt":{"text":true,"image":true,"resource":false},
                        "load_session":true,
                        "resume_session":false,
                        "close_session":true,
                        "terminal":true,
                        "additional_directories":false,
                        "filesystem_requests":false,
                        "mcp_servers":false,
                        "permission_requests":false,
                        "modes":[],
                        "config_options":[],
                        "available_commands":[]
                    }
                }"#,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append legacy capability snapshot");

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project legacy capability snapshot");

        assert!(
            timeline
                .rows
                .iter()
                .all(|row| !matches!(row.row, ConversationTimelineRow::SessionNotice { .. })),
            "same-version legacy capabilities should remain readable"
        );
    }

    #[tokio::test]
    async fn legacy_agent_binding_field_does_not_render_unknown_event_notice() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source: "acp",
                event_kind: "agent_binding_started",
                normalized_json: r#"{
                    "kind":"agent_binding_started",
                    "agent_type":"codex",
                    "working_dir":"/tmp/project"
                }"#,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append legacy agent binding");

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project legacy agent binding");

        assert!(
            timeline
                .rows
                .iter()
                .all(|row| !matches!(row.row, ConversationTimelineRow::SessionNotice { .. })),
            "renamed same-version fields should remain readable"
        );
    }

    #[tokio::test]
    async fn accepted_steering_splits_the_assistant_bubble() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let steering_id = Uuid::new_v4();
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "write it".into(),
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
            "runtime",
            ConversationEvent::AssistantTextDelta {
                text: "first half".into(),
                message_id: Some("msg_1".into()),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::ConversationSteering {
                event: agents::conversation::ConversationSteeringEvent::Requested {
                    steering_id,
                    operation_id: Uuid::new_v4(),
                    expected_turn_id: turn_id,
                    payload_digest: "d".into(),
                    blocks: vec![ConversationInputBlock::Text {
                        text: "stop".into(),
                    }],
                    principal: serde_json::json!({}),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::ConversationSteering {
                event: agents::conversation::ConversationSteeringEvent::Accepted {
                    steering_id,
                    expected_turn_id: turn_id,
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
            ConversationEvent::AssistantTextDelta {
                text: "second half".into(),
                message_id: None,
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project steered turn");
        let texts: Vec<(TurnRole, String)> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. } => {
                    let text = turn.blocks.iter().find_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.clone()),
                        _ => None,
                    })?;
                    Some((turn.role, text))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            vec![
                (TurnRole::User, "write it".into()),
                (TurnRole::Assistant, "first half".into()),
                (TurnRole::User, "stop".into()),
                (TurnRole::Assistant, "second half".into()),
            ]
        );
        let assistant_ids: Vec<String> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(turn.id.clone())
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            assistant_ids,
            vec![
                format!("{turn_id}:assistant"),
                format!("{turn_id}:assistant:2"),
            ]
        );
        let first_agent_id = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.id == format!("{turn_id}:assistant") =>
            {
                turn.agent_message_id.clone()
            }
            _ => None,
        });
        assert_eq!(first_agent_id.as_deref(), Some("msg_1"));
    }

    #[tokio::test]
    async fn submitted_feedback_splits_the_assistant_bubble_like_steering() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let note_id = Uuid::new_v4();
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "write it".into(),
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
            "runtime",
            ConversationEvent::AssistantTextDelta {
                text: "first half".into(),
                message_id: Some("msg_1".into()),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserSubmittedFeedback {
                note_id,
                operation_id: Uuid::new_v4(),
                text: "stop".into(),
                turn_id: Some(turn_id),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::AssistantTextDelta {
                text: "second half".into(),
                message_id: None,
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project feedback turn");
        let texts: Vec<(TurnRole, String)> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. } => {
                    let text = turn.blocks.iter().find_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.clone()),
                        _ => None,
                    })?;
                    Some((turn.role, text))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            vec![
                (TurnRole::User, "write it".into()),
                (TurnRole::Assistant, "first half".into()),
                (TurnRole::User, "stop".into()),
                (TurnRole::Assistant, "second half".into()),
            ]
        );
        let assistant_ids: Vec<String> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(turn.id.clone())
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            assistant_ids,
            vec![
                format!("{turn_id}:assistant"),
                format!("{turn_id}:assistant:2"),
            ]
        );
        let first_agent_id = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.id == format!("{turn_id}:assistant") =>
            {
                turn.agent_message_id.clone()
            }
            _ => None,
        });
        assert_eq!(first_agent_id.as_deref(), Some("msg_1"));
    }

    #[tokio::test]
    async fn turn_interrupted_marks_status_and_phase() {
        // 批次B / ADR-0001: a TurnInterrupted event is the fourth terminal state. It
        // must drive the durable turn status to 'interrupted' (side-effect table) and
        // the projected turn phase to 'interrupted' (so the timeline renders the
        // 因重启中断 treatment).
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
            "user",
            ConversationEvent::UserTurnStarted,
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnInterrupted {
                reason: Some("host restarted".into()),
            },
            None,
        )
        .await;

        let turn = ConversationTurnRecord::find_by_id(&pool, turn_id)
            .await
            .expect("find turn")
            .expect("turn");
        assert_eq!(turn.status, "interrupted");

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let user_phase = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, phase, .. }
                if turn.role == TurnRole::User =>
            {
                Some(phase.clone())
            }
            _ => None,
        });
        assert_eq!(user_phase.as_deref(), Some("interrupted"));
    }

    #[tokio::test]
    async fn failed_and_cancelled_turns_keep_distinct_projected_phases() {
        for (terminal_event, expected_phase) in [
            (
                ConversationEvent::TurnFailed {
                    error: ConversationError {
                        message: "agent failed".into(),
                        code: Some("fixture_failure".into()),
                        raw: None,
                        kind: Default::default(),
                        plan_usage: None,
                    },
                },
                "failed",
            ),
            (
                ConversationEvent::TurnCancelled {
                    reason: Some("user stopped the turn".into()),
                },
                "cancelled",
            ),
        ] {
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
                "runtime",
                ConversationEvent::AssistantTextDelta {
                    text: "working".into(),
                    message_id: None,
                },
                None,
            )
            .await;
            append_event(
                &pool,
                conversation_id,
                Some(turn_id),
                "runtime",
                terminal_event,
                None,
            )
            .await;

            let timeline = ConversationProjector::project(&pool, conversation_id)
                .await
                .expect("timeline");
            let user_phase = timeline.rows.iter().find_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, phase, .. }
                    if turn.role == TurnRole::User =>
                {
                    Some(phase.as_str())
                }
                _ => None,
            });
            assert_eq!(user_phase, Some(expected_phase));
            let assistant_metrics = timeline.rows.iter().find_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some((turn.duration_ms, turn.completed_at))
                }
                _ => None,
            });
            assert!(
                matches!(assistant_metrics, Some((Some(_), Some(_)))),
                "assistant metrics: {assistant_metrics:?}"
            );
        }
    }

    #[tokio::test]
    async fn turn_failure_does_not_keep_error_text_as_an_assistant_message() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let error_text =
            "Failed to authenticate. API Error: 401 Model deepseek-v4.1-flash is not supported";
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "你是谁".into(),
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
            "runtime",
            ConversationEvent::AssistantTextDelta {
                text: error_text.into(),
                message_id: None,
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
                    message: format!("Internal error: {error_text}"),
                    code: Some("internal_error".into()),
                    raw: Some(serde_json::json!({
                        "errorKind": "authentication_failed"
                    })),
                    kind: Default::default(),
                    plan_usage: None,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let assistant_text = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.role == TurnRole::Assistant =>
            {
                Some(
                    turn.blocks
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join(""),
                )
            }
            _ => None,
        });
        assert_eq!(assistant_text.as_deref(), None);
        assert!(
            timeline
                .rows
                .iter()
                .any(|row| matches!(row.row, ConversationTimelineRow::TurnError { .. }))
        );
    }

    #[tokio::test]
    async fn rows_since_returns_only_changed_rows() {
        // 批次C gap backfill: rows_since returns rows whose revision advanced past the
        // cursor, so the frontend upserts only what changed.
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
        let cutoff = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "a".into(),
                message_id: None,
            },
            None,
        )
        .await;
        // A later terminal event bumps the turn's rows past `cutoff`.
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;

        let (rows, last_sequence) =
            ConversationProjector::rows_since(&pool, conversation_id, cutoff.sequence)
                .await
                .expect("rows since");
        assert!(last_sequence > cutoff.sequence);
        assert!(
            rows.iter().all(|row| row.revision > cutoff.sequence),
            "only rows changed after the cursor are returned"
        );
        assert!(
            rows.iter()
                .any(|row| row.row_id == format!("{turn_id}:assistant")),
            "the assistant row (bumped by turn completion) is included"
        );
    }

    #[tokio::test]
    async fn project_open_keeps_the_tail_without_shipping_the_full_row_vec() {
        let pool = setup_pool().await;
        let (conversation_id, _) = seed_turn(&pool).await;
        for index in 0..12 {
            let turn = ConversationTurnRecord::create_pending(
                &pool,
                Uuid::new_v4(),
                CreateConversationTurn {
                    conversation_id,
                    prompt_id: Some("prompt-1"),
                    text_preview: Some("hello"),
                    input_blocks_json: "[]",
                },
            )
            .await
            .expect("create turn");
            append_event(
                &pool,
                conversation_id,
                Some(turn.id),
                "user",
                ConversationEvent::UserTurnCreated {
                    blocks: vec![ConversationInputBlock::Text {
                        text: format!("turn {index}"),
                    }],
                    workflow_refs: Vec::new(),
                },
                None,
            )
            .await;
        }
        let full = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("full project");
        let open = ConversationProjector::project_open(&pool, conversation_id, 5)
            .await
            .expect("open project");
        assert!(full.rows.len() > 5);
        assert_eq!(open.timeline.rows.len(), 5);
        assert!(open.timeline.truncated_from_start);
        assert_eq!(
            open.timeline.older_cursor,
            Some((full.rows.len() - 5).to_string())
        );
        assert_eq!(
            open.timeline.rows.last().map(|row| row.row_id.as_str()),
            full.rows.last().map(|row| row.row_id.as_str())
        );
        let window = ConversationProjector::project_row_window(&pool, conversation_id, 2, 3)
            .await
            .expect("window");
        assert_eq!(window.total_rows, full.rows.len());
        assert_eq!(window.rows.len(), 3);
        assert_eq!(window.rows[0].row_id, full.rows[2].row_id);
    }

    #[tokio::test]
    async fn project_open_and_row_window_read_materialized_rows_without_fold_json() {
        let pool = setup_pool().await;
        let (conversation_id, _) = seed_turn(&pool).await;
        for index in 0..12 {
            let turn = ConversationTurnRecord::create_pending(
                &pool,
                Uuid::new_v4(),
                CreateConversationTurn {
                    conversation_id,
                    prompt_id: Some("prompt-1"),
                    text_preview: Some("hello"),
                    input_blocks_json: "[]",
                },
            )
            .await
            .expect("create turn");
            append_event(
                &pool,
                conversation_id,
                Some(turn.id),
                "user",
                ConversationEvent::UserTurnCreated {
                    blocks: vec![ConversationInputBlock::Text {
                        text: format!("turn {index}"),
                    }],
                    workflow_refs: Vec::new(),
                },
                None,
            )
            .await;
            append_event(
                &pool,
                conversation_id,
                Some(turn.id),
                "runtime",
                ConversationEvent::TurnCompleted { stop_reason: None },
                None,
            )
            .await;
        }

        let full = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("full project");
        let snapshot = ConversationProjectionSnapshotRecord::find(&pool, conversation_id)
            .await
            .expect("load snapshot")
            .expect("snapshot after settle");
        assert!(
            snapshot.total_rows > 5,
            "settle must persist open-window metadata"
        );
        let blank = serde_json::to_string(&ProjectionSnapshotState {
            last_sequence: snapshot.last_sequence,
            ..ProjectionSnapshotState::default()
        })
        .expect("blank fold");
        sqlx::query(
            "UPDATE conversation_projection_snapshots SET fold_json = ? WHERE conversation_id = ?",
        )
        .bind(&blank)
        .bind(conversation_id)
        .execute(&pool)
        .await
        .expect("wipe fold json");

        let open = ConversationProjector::project_open(&pool, conversation_id, 5)
            .await
            .expect("open from row table");
        assert_eq!(open.timeline.rows.len(), 5);
        assert!(open.timeline.truncated_from_start);
        assert_eq!(
            open.timeline.rows.last().map(|row| row.row_id.as_str()),
            full.rows.last().map(|row| row.row_id.as_str())
        );
        let window = ConversationProjector::project_row_window(&pool, conversation_id, 2, 3)
            .await
            .expect("window from row table");
        assert_eq!(window.total_rows, full.rows.len());
        assert_eq!(window.rows.len(), 3);
        assert_eq!(window.rows[0].row_id, full.rows[2].row_id);
        let (changed, last_sequence) = ConversationProjector::rows_since(&pool, conversation_id, 0)
            .await
            .expect("rows since from row table");
        assert_eq!(last_sequence, snapshot.last_sequence);
        assert_eq!(changed.len(), full.rows.len());
    }

#[path = "rows_tests_interactions.rs"]
mod interactions;

#[path = "rows_tests_rebuild.rs"]
mod rebuild;
