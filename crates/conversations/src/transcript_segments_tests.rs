use agents::{
    AgentConnectionId, AgentId,
    acp_transcript::{self, EntryKind},
    conversation::{ContentBlock, MessageTurn},
};
use db::models::{
    conversation::{
        ConversationAgentBindingRecord as Binding, ConversationRecord, CreateConversationRecord,
    },
    conversation_transcript::ConversationTranscriptSegment as Segment,
};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use uuid::Uuid;

async fn pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .in_memory(true)
                .foreign_keys(false),
        )
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    pool
}

async fn conversation(pool: &SqlitePool) -> Uuid {
    let id = Uuid::new_v4();
    ConversationRecord::create(
        pool,
        id,
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
    .unwrap();
    id
}

#[tokio::test]
async fn paged_history_reads_unicode_without_truncation_and_rejects_rewritten_cursors() {
    let pool = pool().await;
    let id = conversation(&pool).await;
    let root = agents::acp_transcript::vibex_acp_transcripts_root();
    let turns: Vec<MessageTurn> = serde_json::from_value(serde_json::json!([
        {"id":"long","role":"user","blocks":[{"type":"text","text":"甲🙂乙丙丁"}],"timestamp":"2026-11-13T00:00:00Z"},
        {"id":"answer","role":"assistant","blocks":[{"type":"text","text":"回答"},{"type":"thinking","text":"private"}],"timestamp":"2026-11-13T00:00:00Z"}
    ])).unwrap();
    super::replace_snapshot_in(&pool, &root, id, "codex", &turns)
        .await
        .unwrap();
    let first = crate::session_info::read_history_page(
        &pool,
        id,
        &delegation_proto::SessionHistoryRequest {
            max_chars: Some(2),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(first.items[0].text, "甲🙂");
    assert_eq!(first.items[0].next_text_offset, Some(2));
    let request = delegation_proto::SessionHistoryRequest {
        item_id: Some(first.items[0].id.clone()),
        text_offset: Some(2),
        max_chars: Some(3),
        history_revision: Some(first.history_revision),
        ..Default::default()
    };
    let rest = crate::session_info::read_history_page(&pool, id, &request)
        .await
        .unwrap();
    assert_eq!(rest.items[0].text, "乙丙丁");
    assert_eq!(rest.items[0].next_text_offset, None);
    let next = crate::session_info::read_history_page(
        &pool,
        id,
        &delegation_proto::SessionHistoryRequest {
            after_item_id: Some(first.items[0].id.clone()),
            max_chars: Some(100),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(next.items.len(), 1);
    assert_eq!(next.items[0].text, "回答");
    super::replace_snapshot_in(&pool, &root, id, "codex", &turns[..1])
        .await
        .unwrap();
    assert!(
        crate::session_info::read_history_page(&pool, id, &request)
            .await
            .is_err()
    );
}

fn text(turns: &[MessageTurn]) -> Vec<String> {
    turns
        .iter()
        .flat_map(|turn| &turn.blocks)
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

async fn append(connection: AgentConnectionId, question: &str) {
    agents::transcript_target::record_entry(
        connection,
        "codex",
        "unused-native",
        EntryKind::Prompt,
        serde_json::json!([{"type":"text","text":question}]),
    )
    .await
    .unwrap();
    agents::transcript_target::record_entry(
        connection,
        "codex",
        "unused-native",
        EntryKind::TurnEnd,
        serde_json::json!({"stopReason":"end_turn"}),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn fork_is_independent_and_truncate_then_append_keeps_only_the_selected_prefix() {
    let pool = pool().await;
    let parent = conversation(&pool).await;
    let child = conversation(&pool).await;
    // This public read also initializes the suite's isolated transcript root.
    crate::jsonl_history::load_all_turns(&pool, parent)
        .await
        .unwrap();
    let root = acp_transcript::vibex_acp_transcripts_root();
    let agent = AgentId::parse("codex").unwrap();
    let connection = AgentConnectionId::new();
    let binding = Binding::link_native_session(
        &pool,
        parent,
        &agent,
        "/work",
        "before",
        &connection.to_string(),
    )
    .await
    .unwrap();
    crate::jsonl_history::prepare_binding_transcript(&pool, parent, &binding, connection)
        .await
        .unwrap();
    append(connection, "first").await;
    append(connection, "second").await;
    assert_eq!(
        crate::jsonl_history::copy_transcript_snapshot(&pool, parent, child, None)
            .await
            .unwrap(),
        2
    );
    let child_before = crate::jsonl_history::load_all_turns(&pool, child)
        .await
        .unwrap()
        .unwrap();
    let parent_segments = Segment::list(&pool, parent).await.unwrap();
    let child_segments = Segment::list(&pool, child).await.unwrap();
    assert_ne!(parent_segments[0].id, child_segments[0].id);

    crate::jsonl_history::truncate_transcript_to_user_ordinal(&pool, parent, 1)
        .await
        .unwrap();
    assert!(agents::transcript_target::is_retired(connection));
    Binding::invalidate_active(&pool, parent, "rebind")
        .await
        .unwrap();
    let next_connection = AgentConnectionId::new();
    let next = Binding::link_native_session(
        &pool,
        parent,
        &agent,
        "/work",
        "after",
        &next_connection.to_string(),
    )
    .await
    .unwrap();
    assert_ne!(binding.id, next.id);
    crate::jsonl_history::prepare_binding_transcript(&pool, parent, &next, next_connection)
        .await
        .unwrap();
    append(next_connection, "replacement").await;
    let parent_after = crate::jsonl_history::load_all_turns(&pool, parent)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(text(&parent_after), ["first", "replacement"]);
    let child_after = crate::jsonl_history::load_all_turns(&pool, child)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(text(&child_after), ["first", "second"]);
    assert_eq!(
        child_before.iter().map(|t| &t.id).collect::<Vec<_>>(),
        child_after.iter().map(|t| &t.id).collect::<Vec<_>>()
    );

    let missing = super::target(&root, child, child_segments[0].id);
    std::fs::remove_file(
        acp_transcript::transcript_path_in(&missing.root, &missing.directory, &missing.session_id)
            .unwrap(),
    )
    .unwrap();
    assert!(
        crate::jsonl_history::load_all_turns(&pool, child)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn torn_utf8_tail_keeps_completed_history_and_reopen_repairs_before_append() {
    use std::io::Write;
    let pool = pool().await;
    let id = conversation(&pool).await;
    let root = tempfile::tempdir().unwrap();
    let agent = AgentId::parse("codex").unwrap();
    let binding = Uuid::new_v4();
    let destination = super::open_in(&pool, root.path(), id, binding, &agent, "")
        .await
        .unwrap();
    let connection = AgentConnectionId::new();
    agents::transcript_target::bind(connection, destination.clone());
    append(connection, "completed").await;
    let path = acp_transcript::transcript_path_in(
        &destination.root,
        &destination.directory,
        &destination.session_id,
    )
    .unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(&[b'{', b'"', 0xe4, 0xb8])
        .unwrap();
    let history = super::read_in(&pool, root.path(), id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(text(&history), ["completed"]);
    super::open_in(&pool, root.path(), id, binding, &agent, "")
        .await
        .unwrap();
    append(connection, "after repair").await;
    super::seal_in(&pool, root.path(), id).await.unwrap();
    assert_eq!(
        text(
            &super::read_in(&pool, root.path(), id)
                .await
                .unwrap()
                .unwrap()
        ),
        ["completed", "after repair"]
    );
}

#[tokio::test]
async fn manifest_bundle_roundtrip_keeps_assistant_content_and_independent_files() {
    let pool = pool().await;
    let id = conversation(&pool).await;
    crate::jsonl_history::load_all_turns(&pool, id)
        .await
        .unwrap();
    let root = acp_transcript::vibex_acp_transcripts_root();
    let agent = AgentId::parse("codex").unwrap();
    let destination = super::open_in(&pool, &root, id, Uuid::new_v4(), &agent, "")
        .await
        .unwrap();
    let connection = AgentConnectionId::new();
    agents::transcript_target::bind(connection, destination.clone());
    append(connection, "question").await;
    // The bundle must also include content with no historical SQLite content rows.
    agents::transcript_target::record_entry(connection, "codex", "unused-native", EntryKind::Update,
        serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"manifest answer"}}),
    ).await.unwrap();
    let exported = crate::export_conversation_bundle(&pool, id, None, "test")
        .await
        .unwrap();
    assert!(exported.bundle.transcript_turns.is_some());
    let imported = crate::import_conversation_bundle(&pool, exported.bundle, Uuid::new_v4())
        .await
        .unwrap();
    let history = crate::jsonl_history::load_all_turns(&pool, imported.conversation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(text(&history), ["question", "manifest answer"]);
    let original = Segment::list(&pool, id).await.unwrap();
    let copied = Segment::list(&pool, imported.conversation_id)
        .await
        .unwrap();
    assert_ne!(original[0].id, copied[0].id);
}

#[tokio::test]
async fn legacy_checkpoint_refuses_conflicting_or_unreadable_sources() {
    let pool = pool().await;
    let id = conversation(&pool).await;
    crate::jsonl_history::load_all_turns(&pool, id)
        .await
        .unwrap();
    let root = acp_transcript::vibex_acp_transcripts_root();
    let agent = AgentId::parse("codex").unwrap();
    let native = format!("legacy-{}", id.simple());
    Binding::link_native_session(&pool, id, &agent, "/work", &native, "legacy-connection")
        .await
        .unwrap();
    for (sid, question) in [
        (id.simple().to_string(), "canonical question"),
        (native.clone(), "conflicting question"),
    ] {
        let header = acp_transcript::TranscriptHeader::new("codex", &sid, "", 0);
        acp_transcript::record_header_in(&root, "codex", &header)
            .await
            .unwrap();
        acp_transcript::record_entry_in(
            &root,
            "codex",
            &sid,
            EntryKind::Prompt,
            serde_json::json!([{"type":"text","text":question}]),
        )
        .await
        .unwrap();
    }
    let error = crate::jsonl_history::preserve_transcript_before_detach(&pool, id)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("conflicting legacy histories"));
    assert!(Segment::list(&pool, id).await.unwrap().is_empty());
    let native_path = acp_transcript::transcript_path_in(&root, "codex", &native).unwrap();
    std::fs::write(&native_path, "broken").unwrap();
    assert!(
        crate::jsonl_history::preserve_transcript_before_detach(&pool, id)
            .await
            .is_err()
    );
    assert!(Segment::list(&pool, id).await.unwrap().is_empty());
    assert!(native_path.exists());
}

#[tokio::test]
async fn legacy_checkpoint_rejects_a_mismatched_header_identity() {
    let pool = pool().await;
    let id = conversation(&pool).await;
    crate::jsonl_history::load_all_turns(&pool, id)
        .await
        .unwrap();
    let root = acp_transcript::vibex_acp_transcripts_root();
    let agent = AgentId::parse("codex").unwrap();
    let native = format!("legacy-header-{}", id.simple());
    Binding::link_native_session(&pool, id, &agent, "/work", &native, "legacy-connection")
        .await
        .unwrap();
    let file = acp_transcript::transcript_path_in(&root, "codex", &native).unwrap();
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let header = acp_transcript::TranscriptHeader::new("codex", "another-session", "", 0);
    let content = format!(
        "{}\n{}\n",
        serde_json::to_string(&header).unwrap(),
        serde_json::json!({"t": 1, "k": "prompt", "p": [{"type": "text", "text": "keep original"}]})
    );
    std::fs::write(&file, &content).unwrap();
    assert!(
        crate::jsonl_history::preserve_transcript_before_detach(&pool, id)
            .await
            .is_err()
    );
    assert!(Segment::list(&pool, id).await.unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(file).unwrap(), content);
}

#[tokio::test]
async fn legacy_checkpoint_requires_explicit_ancestors() {
    let pool = pool().await;
    let id = conversation(&pool).await;
    crate::jsonl_history::load_all_turns(&pool, id)
        .await
        .unwrap();
    let root = acp_transcript::vibex_acp_transcripts_root();
    let agent = AgentId::parse("codex").unwrap();
    let native = format!("legacy-missing-{}", id.simple());
    Binding::link_native_session(&pool, id, &agent, "/work", &native, "legacy-connection")
        .await
        .unwrap();
    let header = acp_transcript::TranscriptHeader::new("codex", &native, "", 0)
        .continuing("missing-required-ancestor");
    acp_transcript::record_header_in(&root, "codex", &header)
        .await
        .unwrap();
    assert!(
        crate::jsonl_history::preserve_transcript_before_detach(&pool, id)
            .await
            .is_err()
    );
    assert!(Segment::list(&pool, id).await.unwrap().is_empty());
}

#[tokio::test]
async fn legacy_continuation_is_imported_once_in_chronological_order() {
    let pool = pool().await;
    let id = conversation(&pool).await;
    crate::jsonl_history::load_all_turns(&pool, id)
        .await
        .unwrap();
    let root = acp_transcript::vibex_acp_transcripts_root();
    let agent = AgentId::parse("codex").unwrap();
    let first = format!("legacy-first-{}", id.simple());
    let last = format!("legacy-last-{}", id.simple());
    Binding::link_native_session(&pool, id, &agent, "/work", &last, "legacy-connection")
        .await
        .unwrap();
    for (sid, parent, question) in [
        (&first, None, "first"),
        (&last, Some(first.as_str()), "last"),
    ] {
        let mut header = acp_transcript::TranscriptHeader::new("codex", sid, "", 0);
        header.continues_from = parent.map(str::to_string);
        acp_transcript::record_header_in(&root, "codex", &header)
            .await
            .unwrap();
        acp_transcript::record_entry_in(
            &root,
            "codex",
            sid,
            EntryKind::Prompt,
            serde_json::json!([{"type":"text","text":question}]),
        )
        .await
        .unwrap();
        acp_transcript::record_entry_in(
            &root,
            "codex",
            sid,
            EntryKind::TurnEnd,
            serde_json::json!({"stopReason":"end_turn"}),
        )
        .await
        .unwrap();
    }
    crate::jsonl_history::preserve_transcript_before_detach(&pool, id)
        .await
        .unwrap();
    crate::jsonl_history::preserve_transcript_before_detach(&pool, id)
        .await
        .unwrap();
    let history = crate::jsonl_history::load_all_turns(&pool, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(text(&history), ["first", "last"]);
    assert_eq!(Segment::list(&pool, id).await.unwrap().len(), 1);
}

#[tokio::test]
async fn snapshots_preserve_protocol_image_generation_and_tool_metadata_losslessly() {
    let pool = pool().await;
    let id = conversation(&pool).await;
    let root = tempfile::tempdir().unwrap();
    let turn: MessageTurn = serde_json::from_value(serde_json::json!({
        "id": "source-message", "role": "assistant", "timestamp": "2026-11-13T00:00:00Z",
        "completed_at": "2026-11-13T00:00:01Z", "duration_ms": 1000,
        "model": "test-model", "agent_message_id": "native-message",
        "blocks": [
            {"type":"protocol","content":{"type":"audio","data":"audio-base64","mimeType":"audio/wav"}},
            {"type":"image_generation","revised_prompt":"image request","image":null},
            {"type":"tool_use","tool_use_id":"tool-1","tool_name":"read","meta":{"delegation":{"source":"agent"}},"status":"completed"},
            {"type":"tool_result","tool_use_id":"tool-1","output_preview":"result","is_error":false}
        ]
    })).unwrap();
    super::import_snapshot_in(&pool, root.path(), id, "codex", std::slice::from_ref(&turn))
        .await
        .unwrap();
    let mut restored = super::read_in(&pool, root.path(), id)
        .await
        .unwrap()
        .unwrap()
        .remove(0);
    assert_ne!(restored.id, turn.id);
    restored.id = turn.id.clone();
    assert_eq!(restored, turn);
}
