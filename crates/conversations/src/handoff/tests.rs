use agents::conversation::{ConversationError, ConversationInputBlock};
use db::{DBService, models::conversation_event::AppendConversationEvent};

use super::*;
use crate::projection::ConversationEventAppender;

async fn append_turn(
    pool: &SqlitePool,
    conversation_id: Uuid,
    user_text: &str,
    assistant_text: &str,
    fail_msg: Option<&str>,
) -> Uuid {
    let turn_id = Uuid::new_v4();
    let user_ev = ConversationEvent::UserTurnCreated {
        blocks: vec![ConversationInputBlock::Text {
            text: user_text.to_string(),
        }],
        workflow_refs: Vec::new(),
    };
    ConversationEventAppender::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "user",
            event_kind: "user_turn_created",
            normalized_json: &serde_json::to_string(&user_ev).unwrap(),
            raw_json: None,
            idempotency_key: None,
        },
    )
    .await
    .expect("append user");

    let asst_ev = ConversationEvent::AssistantTextDelta {
        text: assistant_text.to_string(),
        message_id: None,
    };
    ConversationEventAppender::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "agent",
            event_kind: "assistant_text_delta",
            normalized_json: &serde_json::to_string(&asst_ev).unwrap(),
            raw_json: None,
            idempotency_key: None,
        },
    )
    .await
    .expect("append assistant");

    let term_ev = match fail_msg {
        Some(msg) => ConversationEvent::TurnFailed {
            error: ConversationError::new(msg, Some("rate_limited".into()), None),
        },
        None => ConversationEvent::TurnCompleted {
            stop_reason: Some("end_turn".into()),
        },
    };
    let kind = if fail_msg.is_some() {
        "turn_failed"
    } else {
        "turn_completed"
    };
    ConversationEventAppender::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "agent",
            event_kind: kind,
            normalized_json: &serde_json::to_string(&term_ev).unwrap(),
            raw_json: None,
            idempotency_key: None,
        },
    )
    .await
    .expect("append terminal");

    turn_id
}

#[tokio::test]
async fn deterministic_handoff_packs_recent_turns_and_error_first_and_reads_omitted() {
    let db = DBService::new_in_memory_for_tests()
        .await
        .expect("in-memory db");
    let pool = db.writer().as_pool();
    let conv_id = Uuid::new_v4();
    let ws_id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO sessions (id, workspace_id, name, status, executor, created_at, updated_at) \
         VALUES (?, ?, 'Handoff Test', 'todo', 'claude', datetime('now'), datetime('now'))",
    )
    .bind(conv_id)
    .bind(ws_id)
    .execute(pool)
    .await
    .expect("insert session");

    let mut turn_ids = Vec::new();
    for i in 1..=5 {
        let tid = append_turn(
            pool,
            conv_id,
            &format!("Old user prompt {i}: {}", "x".repeat(400)),
            &format!("Old assistant reply {i}: {}", "y".repeat(400)),
            None,
        )
        .await;
        turn_ids.push(tid);
    }
    let latest_tid = append_turn(
        pool,
        conv_id,
        "Deploy migration script",
        "Starting deployment...",
        Some("429 Too Many Requests from upstream provider"),
    )
    .await;

    let preview =
        DeterministicHandoffService::build_handoff_context(pool, conv_id, "codex", Some(350))
            .await
            .expect("build_handoff_context");

    assert_eq!(preview.source_engine, "claude");
    assert_eq!(preview.target_engine, "codex");
    assert!(preview.total_tokens <= 350);
    assert!(!preview.omitted_ids.is_empty());
    assert!(
        preview
            .packed_messages
            .iter()
            .any(|m| m.role == "error" && m.content.contains("429 Too Many Requests")),
        "unresolved latest error must be packed at highest priority"
    );
    assert!(
        preview
            .packed_messages
            .iter()
            .any(|m| m.id.starts_with(&latest_tid.to_string())),
        "latest turn must be packed before older turns"
    );
    assert!(
        preview
            .handoff_prompt_text
            .as_deref()
            .unwrap_or_default()
            .contains("thread_read_history")
    );

    let fetched = DeterministicHandoffService::read_history_items_by_ids(
        pool,
        conv_id,
        &preview.omitted_ids[..2],
    )
    .await
    .expect("read omitted items");
    assert_eq!(fetched.len(), 2);
    assert!(fetched[0].content.contains("Old "));
}

#[tokio::test]
async fn confirm_engine_handoff_syncs_session_bot_persona_and_preserves_source_binding() {
    use agents::AgentId;
    use db::models::conversation::DbConversationSummary;

    let db = DBService::new_in_memory_for_tests()
        .await
        .expect("in-memory db");
    let pool = db.writer().as_pool();

    let workspace_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let claude = AgentId::parse("claude_code").expect("claude");
    sqlx::query(
        "INSERT INTO sessions (id, workspace_id, name, status, executor, agent_id, agent_type, model, external_session_id, created_at, updated_at) \
         VALUES (?, ?, 'Bot Conv', 'todo', 'CLAUDE_CODE', 'claude_code', 'claude_code', 'claude-opus-4-6', 'ext-claude-1', datetime('now'), datetime('now'))",
    )
    .bind(conversation_id)
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("session");

    let binding = ConversationAgentBindingRecord::link_native_session(
        pool,
        conversation_id,
        &claude,
        "/tmp",
        "acp-claude-1",
        "conn-claude-1",
    )
    .await
    .expect("binding");
    sqlx::query(
        "UPDATE sessions SET model = 'claude-opus-4-6', external_session_id = 'ext-claude-1' WHERE id = ?",
    )
    .bind(conversation_id)
    .execute(pool)
    .await
    .expect("seed model");

    sqlx::query(
        "INSERT INTO collaboration_members (id, name, agent, model, mode_id, config_values, persona_prompt, created_at)
         VALUES ('mem-bot-1', '小A', 'claude_code', 'claude-opus-4-6', 'plan', '{\"model\":\"claude-opus-4-6\"}', '你是小A', '2026-01-01T00:00:00Z')",
    )
    .execute(pool)
    .await
    .expect("member");
    sqlx::query(
        "INSERT INTO collaboration_threads (id, kind, title, workspace_id, created_at)
         VALUES ('direct:mem-bot-1', 'direct', '小A', ?, '2026-01-01T00:00:00Z')",
    )
    .bind(workspace_id.to_string())
    .execute(pool)
    .await
    .expect("thread");
    sqlx::query(
        "INSERT INTO collaboration_thread_members (thread_id, member_id, conversation_id, status, joined_at)
         VALUES ('direct:mem-bot-1', 'mem-bot-1', ?, 'active', '2026-01-01T00:00:00Z')",
    )
    .bind(conversation_id.to_string())
    .execute(pool)
    .await
    .expect("thread member");
    sqlx::query(
        "INSERT INTO conversation_personas (conversation_id, role_id, name, agent_id, persona_prompt, snapshotted_at)
         VALUES (?, NULL, '小A', 'claude_code', '你是小A', '2026-01-01T00:00:00Z')",
    )
    .bind(conversation_id.to_string())
    .execute(pool)
    .await
    .expect("persona");

    let seeded_turn = db::models::conversation_turn::ConversationTurnRecord::create_pending(
        pool,
        Uuid::new_v4(),
        db::models::conversation_turn::CreateConversationTurn {
            conversation_id,
            prompt_id: Some("prompt-1"),
            text_preview: Some("hi"),
            input_blocks_json: "[]",
        },
    )
    .await
    .expect("seed turn");
    let seeded_turn_id = seeded_turn.id;

    let codex = AgentId::parse("codex").expect("codex");
    let confirmation = DeterministicHandoffService::confirm_engine_handoff(
        pool,
        conversation_id,
        &codex,
        None,
    )
    .await
    .expect("confirm handoff");
    assert_eq!(confirmation.workspace_id, workspace_id);
    assert!(confirmation.agent_switched);
    assert!(!confirmation.instance_switched);
    assert_eq!(
        confirmation.previous_model.as_deref(),
        Some("claude-opus-4-6")
    );
    let (after_turn_id, origin_agent) = confirmation
        .handoff_boundary
        .as_ref()
        .expect("handoff boundary recorded when conversation has turns");
    assert_eq!(*after_turn_id, seeded_turn_id);
    assert_eq!(origin_agent.as_str(), "claude_code");
    assert_eq!(confirmation.space_changed_events.len(), 1);
    assert_eq!(
        confirmation.space_changed_events[0].space_id,
        "direct:mem-bot-1"
    );

    let summary = DbConversationSummary::find_by_id(pool, conversation_id)
        .await
        .expect("summary query")
        .expect("summary exists");
    assert_eq!(summary.agent_id, Some(codex));
    assert_eq!(summary.model, None);
    assert_eq!(summary.external_session_id, None);

    let session_after = Session::find_by_id(pool, conversation_id)
        .await
        .expect("session query")
        .expect("session exists");
    assert_eq!(session_after.executor.as_deref(), Some("codex"));

    let active_binding =
        ConversationAgentBindingRecord::active_for_conversation(pool, conversation_id)
            .await
            .expect("active binding query")
            .expect("active binding preserved");
    assert_eq!(active_binding.id, binding.id);

    let persona = crate::collaboration::conversation_persona(pool, conversation_id)
        .await
        .expect("persona query")
        .expect("persona exists");
    assert_eq!(persona.agent_name, "codex");

    let (member_agent, member_model, member_mode, member_cfg): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT agent, model, mode_id, config_values FROM collaboration_members WHERE id = 'mem-bot-1'",
    )
    .fetch_one(pool)
    .await
    .expect("member row");
    assert_eq!(member_agent.as_deref(), Some("codex"));
    assert_eq!(member_model, None);
    assert_eq!(member_mode, None);
    assert_eq!(member_cfg.as_deref(), Some("{}"));
}

#[tokio::test]
async fn confirm_engine_handoff_treats_same_agent_instance_switch_as_full_handoff() {
    use agents::AgentId;
    use db::models::{
        conversation::DbConversationSummary,
        provider_instance::{CreateProviderInstanceInput, ProviderInstanceRecord},
    };

    let db = DBService::new_in_memory_for_tests()
        .await
        .expect("in-memory db");
    let pool = db.writer().as_pool();

    ProviderInstanceRecord::create(
        pool,
        CreateProviderInstanceInput {
            id: None,
            agent_id: "codex",
            instance_id: "work-codex",
            display_name: "Work Codex",
            auth_mode: r#"{"mode":"OfficialOAuth"}"#,
            is_default: true,
        },
    )
    .await
    .expect("create custom codex instance");

    let workspace_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let codex = AgentId::parse("codex").expect("codex");
    sqlx::query(
        "INSERT INTO sessions (id, workspace_id, name, status, executor, agent_id, agent_type, provider_instance_id, model, external_session_id, created_at, updated_at) \
         VALUES (?, ?, 'Codex Conv', 'todo', 'codex', 'codex', 'codex', 'local', 'gpt-5', 'ext-codex-local', datetime('now'), datetime('now'))",
    )
    .bind(conversation_id)
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("session");

    let binding = ConversationAgentBindingRecord::link_native_session(
        pool,
        conversation_id,
        &codex,
        "/tmp",
        "acp-codex-local",
        "conn-codex-local",
    )
    .await
    .expect("binding");
    sqlx::query(
        "UPDATE sessions SET model = 'gpt-5', external_session_id = 'ext-codex-local' WHERE id = ?",
    )
    .bind(conversation_id)
    .execute(pool)
    .await
    .expect("seed model");

    let seeded_turn = db::models::conversation_turn::ConversationTurnRecord::create_pending(
        pool,
        Uuid::new_v4(),
        db::models::conversation_turn::CreateConversationTurn {
            conversation_id,
            prompt_id: Some("prompt-1"),
            text_preview: Some("hi"),
            input_blocks_json: "[]",
        },
    )
    .await
    .expect("seed turn");

    let confirmation = DeterministicHandoffService::confirm_engine_handoff(
        pool,
        conversation_id,
        &codex,
        Some("work-codex"),
    )
    .await
    .expect("confirm same-agent instance switch");
    assert!(!confirmation.agent_switched);
    assert!(confirmation.instance_switched);
    assert_eq!(confirmation.from_instance_id, None);
    assert_eq!(confirmation.to_instance_id.as_deref(), Some("work-codex"));
    assert_eq!(
        confirmation.handoff_boundary,
        Some((seeded_turn.id, codex.clone()))
    );

    let session_after = Session::find_by_id(pool, conversation_id)
        .await
        .expect("session")
        .expect("exists");
    assert_eq!(
        session_after.provider_instance_id.as_deref(),
        Some("work-codex")
    );
    assert_eq!(session_after.external_session_id, None);

    let summary = DbConversationSummary::find_by_id(pool, conversation_id)
        .await
        .expect("summary")
        .expect("exists");
    assert_eq!(summary.model, None);
    assert_eq!(summary.external_session_id, None);

    let active_binding =
        ConversationAgentBindingRecord::active_for_conversation(pool, conversation_id)
            .await
            .expect("active binding")
            .expect("preserved");
    assert_eq!(active_binding.id, binding.id);

    // Switching back explicitly to `"local"` must store `"local"` rather than falling back to default `work-codex`.
    let back_to_local = DeterministicHandoffService::confirm_engine_handoff(
        pool,
        conversation_id,
        &codex,
        Some("local"),
    )
    .await
    .expect("switch back to local");
    assert!(back_to_local.instance_switched);
    assert_eq!(back_to_local.from_instance_id.as_deref(), Some("work-codex"));
    assert_eq!(back_to_local.to_instance_id, None);

    let session_local = Session::find_by_id(pool, conversation_id)
        .await
        .expect("session")
        .expect("exists");
    assert_eq!(session_local.provider_instance_id.as_deref(), Some("local"));
}

#[tokio::test]
async fn preflight_engine_handoff_aborts_before_mutation_when_workspace_root_missing() {
    use agents::AgentId;
    use db::models::conversation::DbConversationSummary;

    let db = DBService::new_in_memory_for_tests()
        .await
        .expect("in-memory db");
    let pool = db.writer().as_pool();

    let project_id = Uuid::new_v4();
    let task_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let missing_dir = std::env::temp_dir().join(format!("dimo-missing-ws-{}", Uuid::new_v4()));

    sqlx::query("INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, 'P', '/tmp/p', datetime('now'), datetime('now'))")
        .bind(project_id)
        .execute(pool)
        .await
        .expect("project");
    sqlx::query("INSERT INTO tasks (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, 'T', 'todo', datetime('now'), datetime('now'))")
        .bind(task_id)
        .bind(project_id)
        .execute(pool)
        .await
        .expect("task");
    sqlx::query(
        "INSERT INTO workspaces (id, project_id, task_id, container_ref, branch, use_worktree, archived, pinned, created_at, updated_at) \
         VALUES (?, ?, ?, ?, 'main', 0, 0, 0, datetime('now'), datetime('now'))",
    )
    .bind(workspace_id)
    .bind(project_id)
    .bind(task_id)
    .bind(missing_dir.to_string_lossy().to_string())
    .execute(pool)
    .await
    .expect("workspace");

    sqlx::query(
        "INSERT INTO sessions (id, workspace_id, name, status, executor, agent_id, agent_type, model, external_session_id, created_at, updated_at) \
         VALUES (?, ?, 'Preflight Conv', 'todo', 'claude_code', 'claude_code', 'claude_code', 'claude-opus-4-6', 'ext-orig-1', datetime('now'), datetime('now'))",
    )
    .bind(conversation_id)
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("session");

    let codex = AgentId::parse("codex").expect("codex");
    let err =
        DeterministicHandoffService::confirm_engine_handoff(pool, conversation_id, &codex, None)
            .await
            .expect_err("missing workspace root must fail preflight");
    assert!(matches!(err, HandoffError::WorkspaceRootMissing(_)));

    let summary = DbConversationSummary::find_by_id(pool, conversation_id)
        .await
        .expect("summary query")
        .expect("summary exists");
    assert_eq!(summary.agent_id, Some(AgentId::parse("claude_code").unwrap()));
    assert_eq!(summary.model.as_deref(), Some("claude-opus-4-6"));
    assert_eq!(summary.external_session_id.as_deref(), Some("ext-orig-1"));
}

#[tokio::test]
async fn read_history_items_by_ids_reconstructs_truncated_turn_from_targeted_events() {
    let db = DBService::new_in_memory_for_tests()
        .await
        .expect("in-memory db");
    let pool = db.writer().as_pool();
    let conv_id = Uuid::new_v4();
    let ws_id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO sessions (id, workspace_id, name, status, executor, created_at, updated_at) \
         VALUES (?, ?, 'Handoff Large Test', 'todo', 'claude', datetime('now'), datetime('now'))",
    )
    .bind(conv_id)
    .bind(ws_id)
    .execute(pool)
    .await
    .expect("insert session");

    let huge_tail = "UNIQUE_UNTRUNCATED_END_MARKER_987654321";
    let huge_reply = format!("{} {huge_tail}", "Large paragraph content. ".repeat(1500));
    let large_tid = append_turn(pool, conv_id, "Explain architecture", &huge_reply, None).await;
    let _small_tid = append_turn(pool, conv_id, "Follow up", "Short confirmation.", None).await;

    let assistant_row_id = format!("{large_tid}:assistant");
    let items = DeterministicHandoffService::read_history_items_by_ids(
        pool,
        conv_id,
        std::slice::from_ref(&assistant_row_id),
    )
    .await
    .expect("read_history_items_by_ids");

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, assistant_row_id);
    assert!(
        items[0].content.contains(huge_tail),
        "targeted lookup must reconstruct full untruncated text via events_for_turn"
    );
}
