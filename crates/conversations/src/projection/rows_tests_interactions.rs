use super::*;
    #[tokio::test]
    async fn permission_responded_folds_status_onto_row() {
        // 批次B: a responded (or recovery-voided) permission must reload as 'responded',
        // matching the live store — not perpetually 'pending'.
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::PermissionRequested {
                request: ConversationPermissionRequest {
                    permission_id: "perm-1".into(),
                    request: AgentPermissionRequest {
                        id: AgentPermissionId::new(),
                        session_id: AgentSessionId::new(),
                        title: "Allow edit?".into(),
                        details: None,
                        options: vec![AgentPermissionOption {
                            id: "allow".into(),
                            label: "Allow".into(),
                            kind: AgentPermissionOptionKind::AllowOnce,
                            description: None,
                        }],
                    },
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
            ConversationEvent::PermissionResponded {
                permission_id: "perm-1".into(),
                response: ConversationPermissionResponse {
                    response: AgentPermissionResponse::Cancelled,
                    auto: true,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let status = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::PermissionRequest { request } => Some(request.status.clone()),
            _ => None,
        });
        assert_eq!(status.as_deref(), Some("responded"));
    }

    #[tokio::test]
    async fn auto_allowed_permissions_fold_into_a_count_notice() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::PermissionRequested {
                request: ConversationPermissionRequest {
                    permission_id: "perm-auto-1".into(),
                    request: AgentPermissionRequest {
                        id: AgentPermissionId::new(),
                        session_id: AgentSessionId::new(),
                        title: "Edit file".into(),
                        details: None,
                        options: vec![AgentPermissionOption {
                            id: "allow".into(),
                            label: "Allow".into(),
                            kind: AgentPermissionOptionKind::AllowOnce,
                            description: None,
                        }],
                    },
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
            ConversationEvent::PermissionResponded {
                permission_id: "perm-auto-1".into(),
                response: ConversationPermissionResponse {
                    response: AgentPermissionResponse::selected("allow"),
                    auto: true,
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
            ConversationEvent::PermissionResponded {
                permission_id: "perm-auto-2".into(),
                response: ConversationPermissionResponse {
                    response: AgentPermissionResponse::selected("allow"),
                    auto: true,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let permission_cards = timeline
            .rows
            .iter()
            .filter(|row| matches!(row.row, ConversationTimelineRow::PermissionRequest { .. }))
            .count();
        assert_eq!(permission_cards, 0);
        let notice = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::SessionNotice { notice }
                if notice.title == "已自动批准权限" =>
            {
                Some(notice)
            }
            _ => None,
        });
        let notice = notice.expect("auto-permission notice");
        assert_eq!(notice.severity, "info");
        assert_eq!(notice.message.as_deref(), Some("已自动批准 2 项权限请求"));
        assert_eq!(
            timeline
                .rows
                .iter()
                .find(|row| row.row_id == "notice:auto-permission-approved")
                .map(|row| row.row_id.as_str()),
            Some("notice:auto-permission-approved")
        );
    }

    #[tokio::test]
    async fn timeline_preserves_reported_tool_status_independently_of_output() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        for (call_id, reported_status, output, expected_status, expected_error) in [
            (
                "running",
                Some("in_progress"),
                Some("partial output"),
                "in_progress",
                false,
            ),
            ("success", Some("completed"), None, "completed", false),
            ("failure", Some("failed"), None, "failed", true),
            ("failure", None, Some("late error output"), "failed", true),
        ] {
            append_event(
                &pool,
                conversation_id,
                Some(turn_id),
                "acp",
                ConversationEvent::ToolCallUpsert {
                    tool_call: ConversationToolCallPatch {
                        tool_call_id: call_id.into(),
                        title: Some("Running view_file".into()),
                        kind: Some("read".into()),
                        status: reported_status.map(str::to_string),
                        raw_input: Some(serde_json::json!({"AbsolutePath": "/workspace/main.rs"})),
                        raw_output: output.map(|text| serde_json::Value::String(text.into())),
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

            let timeline = ConversationProjector::project(&pool, conversation_id)
                .await
                .expect("project tool status");
            let tools = ConversationToolCallRecord::list_for_turn(&pool, turn_id)
                .await
                .expect("stored tools");
            let stored = tools
                .iter()
                .find(|tool| tool.tool_call_id == call_id)
                .expect("stored tool");
            assert_eq!(
                stored.status,
                if expected_status == "in_progress" {
                    "running"
                } else {
                    expected_status
                }
            );
            let blocks: Vec<_> = timeline
                .rows
                .iter()
                .filter_map(|row| match &row.row {
                    ConversationTimelineRow::MessageTurn { turn, .. }
                        if turn.role == TurnRole::Assistant =>
                    {
                        Some(&turn.blocks)
                    }
                    _ => None,
                })
                .flatten()
                .collect();
            let statuses: Vec<_> = blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolUse {
                        tool_use_id: Some(id),
                        status,
                        ..
                    } if id == call_id => Some(status.as_deref()),
                    _ => None,
                })
                .collect();
            assert_eq!(
                statuses,
                vec![Some(expected_status)],
                "one card with the reported status"
            );
            let results: Vec<_> = blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolResult {
                        tool_use_id: Some(id),
                        is_error,
                        output_preview,
                        ..
                    } if id == call_id => Some((*is_error, output_preview.as_deref())),
                    _ => None,
                })
                .collect();
            assert_eq!(
                results.len(),
                1,
                "one result even for status-only completion"
            );
            assert_eq!(results[0].0, expected_error);
            if let Some(output) = output {
                assert!(results[0].1.expect("output preview").contains(output));
            }
        }
    }

    #[tokio::test]
    async fn antigravity_view_file_failures_settle_as_completed_reads() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let agent_id = AgentId::parse("antigravity").unwrap();
        ConversationAgentBindingRecord::create(
            &pool,
            Uuid::new_v4(),
            CreateConversationAgentBinding {
                conversation_id,
                agent_id: &agent_id,
                working_dir: "C:/workspace",
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
                status: db::models::conversation::BindingStatus::Ready,
            },
        )
        .await
        .expect("antigravity binding");

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "view-1".into(),
                    title: Some("Running view_file".into()),
                    kind: Some("read".into()),
                    status: Some("in_progress".into()),
                    raw_input: Some(serde_json::json!({"AbsolutePath": "C:/workspace/index.css"})),
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
                    tool_call_id: "view-1".into(),
                    title: Some("view-1".into()),
                    kind: None,
                    status: Some("failed".into()),
                    raw_input: None,
                    raw_output: Some(serde_json::Value::String(
                        "Encountered retryable error from model provider: Error 502".into(),
                    )),
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
                    tool_call_id: "run-1".into(),
                    title: Some("Running command".into()),
                    kind: Some("execute".into()),
                    status: Some("failed".into()),
                    raw_input: Some(serde_json::json!({"command":"npm test"})),
                    raw_output: Some(serde_json::Value::String(
                        "error executing cascade step: scratch missing".into(),
                    )),
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

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let blocks: Vec<_> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(&turn.blocks)
                }
                _ => None,
            })
            .flatten()
            .collect();
        let view_status = blocks.iter().find_map(|block| match block {
            ContentBlock::ToolUse {
                tool_use_id: Some(id),
                status,
                kind,
                ..
            } if id == "view-1" => Some((status.as_deref(), kind.as_deref())),
            _ => None,
        });
        assert_eq!(view_status, Some((Some("completed"), Some("read"))));
        let view_result = blocks.iter().find_map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id: Some(id),
                is_error,
                output_preview,
                ..
            } if id == "view-1" => Some((*is_error, output_preview.clone())),
            _ => None,
        });
        assert_eq!(view_result, Some((false, None)));
        let command_status = blocks.iter().find_map(|block| match block {
            ContentBlock::ToolUse {
                tool_use_id: Some(id),
                status,
                ..
            } if id == "run-1" => status.as_deref(),
            _ => None,
        });
        assert_eq!(command_status, Some("failed"));
    }

    #[tokio::test]
    async fn timeline_folds_tool_call_updates_into_one_block() {
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
                    title: Some("Run tests".into()),
                    kind: Some("execute".into()),
                    status: Some("running".into()),
                    raw_input: Some(serde_json::json!({"command": "cargo test"})),
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
        // A status/output update must fold into the existing card, not spawn a
        // second titleless block; the output attaches as an id-paired result.
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
                    raw_output: Some(serde_json::Value::String("all green".into())),
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

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let blocks: Vec<_> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(&turn.blocks)
                }
                _ => None,
            })
            .flatten()
            .collect();

        let tool_uses: Vec<_> = blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolUse {
                    tool_use_id,
                    tool_name,
                    kind,
                    input_preview,
                    started_at,
                    ended_at,
                    ..
                } => Some((
                    tool_use_id,
                    tool_name,
                    kind,
                    input_preview,
                    started_at,
                    ended_at,
                )),
                _ => None,
            })
            .collect();
        assert_eq!(tool_uses.len(), 1, "update must not spawn a second block");
        let (tool_use_id, tool_name, kind, input_preview, started_at, ended_at) = &tool_uses[0];
        assert_eq!(tool_use_id.as_deref(), Some("tool-1"));
        assert!(
            started_at.is_some(),
            "tool start comes from the upsert event"
        );
        assert!(ended_at.is_some(), "terminal status stamps the tool end");
        assert!(ended_at.unwrap() >= started_at.unwrap());
        assert_eq!(tool_name.as_str(), "Run tests");
        assert_eq!(kind.as_deref(), Some("execute"));
        assert!(
            input_preview
                .as_deref()
                .unwrap_or("")
                .contains("cargo test"),
            "real input fields must survive"
        );

        let results: Vec<_> = blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolResult {
                    tool_use_id,
                    output_preview,
                    is_error,
                    ..
                } => Some((tool_use_id, output_preview, is_error)),
                _ => None,
            })
            .collect();
        assert_eq!(results.len(), 1);
        let (result_id, output_preview, is_error) = &results[0];
        assert_eq!(result_id.as_deref(), Some("tool-1"));
        assert_eq!(output_preview.as_deref(), Some("all green"));
        assert!(!**is_error);
    }

    #[tokio::test]
    async fn conversation_tool_projection_replaces_metadata_on_update() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "spawn-1".into(),
                    title: Some("spawn_subagent".into()),
                    kind: Some("other".into()),
                    status: Some("running".into()),
                    raw_input: Some(serde_json::json!({
                        "subagent_type": "explore",
                        "description": "Audit stream"
                    })),
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
                    tool_call_id: "spawn-1".into(),
                    title: None,
                    kind: None,
                    status: None,
                    raw_input: None,
                    raw_output: None,
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: Some(serde_json::json!({
                        "subagent": {
                            "status": "running",
                            "progress": { "toolCallCount": 125, "contextUsagePct": 32 }
                        }
                    })),
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let meta = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.role == TurnRole::Assistant =>
            {
                turn.blocks.iter().find_map(|block| match block {
                    ContentBlock::ToolUse { meta, .. } => meta.clone(),
                    _ => None,
                })
            }
            _ => None,
        });
        assert_eq!(
            meta.and_then(|value| value["subagent"]["progress"]["toolCallCount"].as_u64()),
            Some(125)
        );
    }

    #[tokio::test]
    async fn timeline_preserves_images_viewed_by_a_tool_call() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "view-image-1".into(),
                    title: Some("View image".into()),
                    kind: Some("read".into()),
                    status: Some("completed".into()),
                    raw_input: Some(serde_json::json!({"path": "assets/logo.png"})),
                    raw_output: None,
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: None,
                    images: vec![agents::conversation::ImageData {
                        data: "AAAA".into(),
                        mime_type: "image/png".into(),
                        uri: Some("assets/logo.png".into()),
                        width: None,
                        height: None,
                    }],
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let images = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(&turn.blocks)
                }
                _ => None,
            })
            .flatten()
            .find_map(|block| match block {
                ContentBlock::ToolUse { images, .. } => Some(images),
                _ => None,
            })
            .expect("tool images");

        assert!(images[0].data.is_empty());
        assert_eq!(images[0].mime_type, "image/png");
        assert!(images[0].uri.as_deref().is_some_and(
            |uri| uri.starts_with("vibex-image:") && uri.len() == "vibex-image:".len() + 64
        ));
    }

    #[tokio::test]
    async fn conversation_timeline_projection_covers_interaction_side_rows() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::QuestionRequested {
                request: ConversationQuestionRequest {
                    question_id: "question-1".into(),
                    prompt: "Pick one".into(),
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
            ConversationEvent::FeedbackRequested {
                request: ConversationFeedbackRequest {
                    feedback_id: "feedback-1".into(),
                    prompt: "Was this useful?".into(),
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
            ConversationEvent::DelegationStarted {
                delegation: ConversationDelegation {
                    delegation_id: "delegation-1".into(),
                    parent_tool_call_id: "tool-1".into(),
                    child_conversation_id: Uuid::new_v4(),
                    agent_id: AgentId::parse("codex").unwrap(),
                    task_preview: "Review diff".into(),
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
            ConversationEvent::DelegationCompleted {
                delegation_id: "delegation-1".into(),
                result: ConversationDelegationResult::Ok {
                    text_preview: Some("done".into()),
                    duration_ms: Some(10),
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
            ConversationEvent::SessionConfigStale {
                stale: true,
                reason: Some("settings changed".into()),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::RawDiagnosticRecorded {
                label: "stream recovered".into(),
                payload: None,
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let kinds = timeline
            .rows
            .iter()
            .map(|row| match &row.row {
                ConversationTimelineRow::QuestionRequest { .. } => "question",
                ConversationTimelineRow::FeedbackRequest { .. } => "feedback",
                ConversationTimelineRow::Delegation { .. } => "delegation",
                ConversationTimelineRow::SessionNotice { .. } => "notice",
                _ => "other",
            })
            .collect::<Vec<_>>();

        assert!(kinds.contains(&"question"));
        assert!(kinds.contains(&"feedback"));
        // started + completed fold into a single delegation card that keeps the
        // start-event context and carries the completion result.
        assert_eq!(
            kinds.iter().filter(|kind| **kind == "delegation").count(),
            1
        );
        let delegation = timeline
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::Delegation { delegation } => Some(delegation),
                _ => None,
            })
            .expect("delegation row");
        assert_eq!(delegation.status, "completed");
        assert_eq!(delegation.task_preview.as_deref(), Some("Review diff"));
        assert!(delegation.child_conversation_id.is_some());
        assert!(matches!(
            delegation.result,
            Some(ConversationDelegationResult::Ok { .. })
        ));
        assert_eq!(kinds.iter().filter(|kind| **kind == "notice").count(), 2);
    }

    #[tokio::test]
    async fn delegation_events_rebuild_child_binding() {
        let (_dir, pool) = setup_temp_pool().await;
        let (parent_conversation_id, turn_id) = seed_turn(&pool).await;
        let child_conversation_id = Uuid::new_v4();
        let delegation_id = "delegation-call-1";
        create_delegated_conversation(
            &pool,
            CreateDelegatedConversation {
                id: child_conversation_id,
                parent_conversation_id,
                parent_tool_call_id: "tool-1".into(),
                delegation_id: delegation_id.into(),
                agent_id: AgentId::parse("codex").unwrap(),
                prompt: "Review the diff".into(),
                policy: serde_json::json!({"workspaceAccess": "write_serialized"}),
            },
        )
        .await
        .expect("persist delegated child");
        append_event(
            &pool,
            parent_conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationStarted {
                delegation: ConversationDelegation {
                    delegation_id: delegation_id.into(),
                    parent_tool_call_id: "tool-1".into(),
                    child_conversation_id,
                    agent_id: AgentId::parse("codex").unwrap(),
                    task_preview: "Review the diff".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            parent_conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationCompleted {
                delegation_id: delegation_id.into(),
                result: ConversationDelegationResult::Ok {
                    text_preview: Some("done".into()),
                    duration_ms: Some(10),
                },
            },
            None,
        )
        .await;

        let before = ConversationProjector::project(&pool, parent_conversation_id)
            .await
            .expect("project before rebuild");
        ConversationProjector::rebuild_projection(&pool, parent_conversation_id)
            .await
            .expect("rebuild projection");
        let after = ConversationProjector::project(&pool, parent_conversation_id)
            .await
            .expect("project after rebuild");
        assert_eq!(after, before);
        let delegation = after
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::Delegation { delegation } => Some(delegation),
                _ => None,
            })
            .expect("delegation row");
        assert_eq!(delegation.delegation_id, delegation_id);
        assert_eq!(
            delegation.child_conversation_id,
            Some(child_conversation_id)
        );
        assert_eq!(delegation.status, "completed");
        let child = Session::find_by_delegation_call_id(&pool, delegation_id)
            .await
            .expect("find child")
            .expect("child exists");
        assert_eq!(child.parent_session_id, Some(parent_conversation_id));
        assert_eq!(child.parent_tool_use_id.as_deref(), Some("tool-1"));
        let relation = ConversationRelationRecord::find(
            &pool,
            parent_conversation_id,
            child_conversation_id,
            "delegation",
        )
        .await
        .expect("find relation")
        .expect("relation exists");
        let metadata: serde_json::Value =
            serde_json::from_str(&relation.metadata_json).expect("relation metadata");
        assert_eq!(metadata["policy"]["workspaceAccess"], "write_serialized");
    }

    #[tokio::test]
    async fn canceled_delegation_remains_canceled_after_projection_rebuild() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let delegation_id = "delegation-canceled-1";
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationStarted {
                delegation: ConversationDelegation {
                    delegation_id: delegation_id.into(),
                    parent_tool_call_id: "tool-canceled-1".into(),
                    child_conversation_id: Uuid::new_v4(),
                    agent_id: AgentId::parse("codex").unwrap(),
                    task_preview: "Review cancellation behavior".into(),
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
            ConversationEvent::DelegationCompleted {
                delegation_id: delegation_id.into(),
                result: ConversationDelegationResult::Err {
                    error: ConversationError {
                        message: "canceled by request".into(),
                        code: Some("canceled".into()),
                        raw: None,
                        kind: Default::default(),
                        plan_usage: None,
                    },
                },
            },
            None,
        )
        .await;

        ConversationProjector::rebuild_projection(&pool, conversation_id)
            .await
            .expect("rebuild projection");
        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project rebuilt timeline");
        let delegation = timeline
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::Delegation { delegation } => Some(delegation),
                _ => None,
            })
            .expect("delegation row");

        assert_eq!(delegation.status, "canceled");
        assert!(delegation.child_conversation_id.is_some());
    }
