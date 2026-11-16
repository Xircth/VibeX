use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use agents::{
    AgentAutoApproveMode, AgentContentBlock, AgentId, AgentRuntime, CancelAgentPromptInput,
    EnsureAgentSessionInput, NoopEventSink, SendAgentPromptInput, SessionLaunchLock,
    parsers::acp_native::project_turns,
};
use chrono::{TimeZone, Utc};

use super::*;

fn turn(role: TurnRole, text: &str, secs: i64) -> MessageTurn {
    MessageTurn {
        id: format!("t-{secs}"),
        role,
        blocks: vec![ContentBlock::Text {
            text: text.to_string(),
        }],
        timestamp: Utc.timestamp_opt(secs, 0).unwrap(),
        usage: None,
        duration_ms: None,
        model: None,
        completed_at: None,
        agent_message_id: None,
    }
}

fn row_phase(row: &TimelineRow) -> &str {
    match &row.row {
        ConversationTimelineRow::MessageTurn { phase, .. } => phase,
        other => panic!("expected a message turn, got {other:?}"),
    }
}

#[test]
fn open_assistant_tail_streams_with_the_user_before_it() {
    let user = turn(TurnRole::User, "second", 1_700_000_010);
    let mut assistant = turn(TurnRole::Assistant, "working", 1_700_000_011);
    assistant.completed_at = None;
    let rows = rows_from_turns(&[user.clone(), assistant]);
    assert_eq!(row_phase(&rows[0]), "streaming");
    assert_eq!(row_phase(&rows[1]), "streaming");

    let mut closed = turn(TurnRole::Assistant, "done", 1_700_000_012);
    closed.completed_at = Some(Utc.timestamp_opt(1_700_000_012, 0).unwrap());
    let settled = rows_from_turns(&[user.clone(), closed]);
    assert_eq!(row_phase(&settled[0]), "settled");
    assert_eq!(row_phase(&settled[1]), "settled");

    let lone = rows_from_turns(&[user]);
    assert_eq!(row_phase(&lone[0]), "settled");
}

#[test]
fn migrated_turns_round_trip_user_text() {
    let mut assistant = turn(TurnRole::Assistant, "hi there", 1_700_000_002);
    assistant.completed_at = Some(Utc.timestamp_opt(1_700_000_003, 0).unwrap());
    let turns = vec![turn(TurnRole::User, "hello", 1_700_000_001), assistant];
    let read = project_turns(&encode_turns(&turns));
    assert_eq!(read.len(), 2);
    match &read[0].blocks[0] {
        ContentBlock::Text { text } => assert_eq!(text, "hello"),
        other => panic!("{other:?}"),
    }
    match &read[1].blocks[0] {
        ContentBlock::Text { text } => assert_eq!(text, "hi there"),
        other => panic!("{other:?}"),
    }
    assert!(read[1].completed_at.is_some());
}

#[test]
fn encode_turns_round_trips_agent_message_id_and_assistant_images() {
    let mut user = turn(TurnRole::User, "check file", 1_700_000_001);
    user.blocks.push(ContentBlock::Resource {
        uri: "file:///workspace/README.md".into(),
        title: Some("README.md".into()),
    });
    let mut assistant = turn(TurnRole::Assistant, "here is the image", 1_700_000_002);
    assistant.agent_message_id = Some("msg_claude_42".into());
    assistant.blocks.push(ContentBlock::Image {
        data: "aGVsbG8=".into(),
        mime_type: "image/png".into(),
        uri: Some("file:///shot.png".into()),
        width: None,
        height: None,
    });
    assistant.completed_at = Some(Utc.timestamp_opt(1_700_000_003, 0).unwrap());

    let read = project_turns(&encode_turns(&[user, assistant]));
    assert_eq!(read.len(), 2);
    assert_eq!(read[0].blocks.len(), 2);
    assert_eq!(read[1].agent_message_id.as_deref(), Some("msg_claude_42"));
    assert!(
        read[1]
            .blocks
            .iter()
            .any(|block| matches!(block, ContentBlock::Image { .. }))
    );
}

#[test]
fn migrated_tool_turns_round_trip_through_acp_native() {
    let mut assistant = turn(TurnRole::Assistant, "running command", 1_700_000_002);
    assistant.blocks.push(ContentBlock::ToolUse {
        tool_use_id: Some("call-1".into()),
        tool_name: "Run bash".into(),
        input_preview: Some(r#"{"command":"cargo test"}"#.into()),
        kind: Some("bash".into()),
        status: Some("running".into()),
        meta: None,
        started_at: None,
        ended_at: None,
        images: Vec::new(),
    });
    assistant.blocks.push(ContentBlock::ToolResult {
        tool_use_id: Some("call-1".into()),
        output_preview: Some("ok".into()),
        is_error: false,
        agent_stats: None,
    });
    assistant.completed_at = Some(Utc.timestamp_opt(1_700_000_003, 0).unwrap());

    let turns = vec![turn(TurnRole::User, "go", 1_700_000_001), assistant];
    let read = project_turns(&encode_turns(&turns));
    assert_eq!(read.len(), 2);
    assert_eq!(read[1].blocks.len(), 3);
    match &read[1].blocks[1] {
        ContentBlock::ToolUse {
            tool_name,
            kind,
            status,
            input_preview,
            ..
        } => {
            assert_eq!(tool_name, "Run bash");
            assert_eq!(kind.as_deref(), Some("execute"));
            assert_eq!(status.as_deref(), Some("completed"));
            assert_eq!(
                input_preview.as_deref(),
                Some(r#"{"command":"cargo test"}"#)
            );
        }
        other => panic!("expected ToolUse, got {other:?}"),
    }
    match &read[1].blocks[2] {
        ContentBlock::ToolResult {
            output_preview,
            is_error,
            ..
        } => {
            assert_eq!(output_preview.as_deref(), Some("ok"));
            assert!(!is_error);
        }
        other => panic!("expected ToolResult, got {other:?}"),
    }
}

async fn wait_for_idle_session(runtime: &AgentRuntime, session_id: agents::AgentSessionId) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let snapshot = runtime.snapshot().await;
            let idle = snapshot
                .sessions
                .iter()
                .find(|candidate| candidate.id == session_id)
                .is_some_and(|session| session.active_prompt_id.is_none());
            if idle {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("session should settle to idle after cancel");
}

#[tokio::test]
async fn runtime_records_three_turns_with_display_blocks_and_reloads_cleanly() {
    isolate_test_transcripts();
    let runtime = AgentRuntime::new_with_driver(Arc::new(NoopEventSink), false);
    let conversation_id = Uuid::new_v4();
    let session_id = agents::AgentSessionId::from(conversation_id);
    let launch_lock = SessionLaunchLock {
        agent_id: AgentId::parse("codex").unwrap(),
        absolute_acp_program: PathBuf::from("/tmp/dimo-test-acp"),
        args: Vec::new(),
        env: BTreeMap::new(),
        runtime_version: "test-runtime".to_string(),
        acp_version: "test-acp".to_string(),
    };
    let prepared = runtime
        .prepare_session(EnsureAgentSessionInput {
            agent_id: AgentId::parse("codex").unwrap(),
            launch_lock,
            workspace_id: Uuid::new_v4(),
            working_dir: PathBuf::from("C:/work"),
            additional_directories: Vec::new(),
            session_id,
            acp_session_id: String::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: Default::default(),
            preferences: Default::default(),
        })
        .await
        .expect("prepare in-memory session");
    let connection_id = prepared.session.connection_id;
    let acp_sid = prepared.session.acp_session_id;
    let root = dimo_acp_transcripts_root();
    agents::transcript_target::bind(
        connection_id,
        agents::transcript_target::TranscriptTarget {
            root: root.clone(),
            directory: "codex".to_string(),
            session_id: acp_sid.clone(),
        },
    );
    let _ = acp_transcript::record_header_in(
        &root,
        "codex",
        &TranscriptHeader::new("codex", &acp_sid, "C:/work", acp_transcript::now_epoch_ms()),
    )
    .await;

    // Turn 1
    let p1 = runtime
        .send_prompt(SendAgentPromptInput {
            connection_id,
            session_id,
            blocks: vec![AgentContentBlock::Text {
                text: "AI 1".into(),
            }],
            mode_override: None,
            config_overrides: Vec::new(),
        })
        .await
        .expect("send turn 1");
    runtime
        .cancel_prompt(CancelAgentPromptInput {
            connection_id,
            session_id,
            prompt_id: p1.id,
        })
        .await
        .expect("settle turn 1");
    wait_for_idle_session(&runtime, session_id).await;

    // Turn 2: wire blocks include a smart reminder, display_blocks has only user display_text + image
    let p2 = runtime
        .send_prompt_with_display_blocks(
            SendAgentPromptInput {
                connection_id,
                session_id,
                blocks: vec![
                    AgentContentBlock::Text {
                        text: "AI 2\n\n<system-reminder>smart reminder</system-reminder>".into(),
                    },
                    AgentContentBlock::Image {
                        data: "aGVsbG8=".into(),
                        mime_type: "image/png".into(),
                        uri: Some("file:///screen.png".into()),
                    },
                ],
                mode_override: None,
                config_overrides: Vec::new(),
            },
            Some(vec![
                AgentContentBlock::Text {
                    text: "User 2".into(),
                },
                AgentContentBlock::Image {
                    data: "aGVsbG8=".into(),
                    mime_type: "image/png".into(),
                    uri: Some("file:///screen.png".into()),
                },
            ]),
        )
        .await
        .expect("send turn 2");
    runtime
        .cancel_prompt(CancelAgentPromptInput {
            connection_id,
            session_id,
            prompt_id: p2.id,
        })
        .await
        .expect("settle turn 2");
    wait_for_idle_session(&runtime, session_id).await;

    // Turn 3
    let p3 = runtime
        .send_prompt_with_display_blocks(
            SendAgentPromptInput {
                connection_id,
                session_id,
                blocks: vec![AgentContentBlock::Text {
                    text: "AI 3".into(),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            },
            Some(vec![AgentContentBlock::Text {
                text: "User 3".into(),
            }]),
        )
        .await
        .expect("send turn 3");

    // Mid-stream check before Turn 3 settles:
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let _ = acp_transcript::flush_in(&root, "codex", &acp_sid).await;
            let chain = acp_transcript::read_chain_in(&root, "codex", &acp_sid);
            let prompts = chain
                .entries
                .iter()
                .filter(|e| e.k == EntryKind::Prompt)
                .count();
            let updates = chain
                .entries
                .iter()
                .filter(|e| e.k == EntryKind::Update)
                .count();
            if prompts == 3 && updates >= 3 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("3 prompts and 3 updates recorded mid-stream");

    let mid_chain = acp_transcript::read_chain_in(&root, "codex", &acp_sid);
    let mid_turns = project_turns(&mid_chain.entries);
    assert_eq!(mid_turns.len(), 6);
    let mid_rows = rows_from_turns(&mid_turns);
    assert_eq!(row_phase(&mid_rows[4]), "streaming");
    assert_eq!(row_phase(&mid_rows[5]), "streaming");

    // Settle Turn 3
    runtime
        .cancel_prompt(CancelAgentPromptInput {
            connection_id,
            session_id,
            prompt_id: p3.id,
        })
        .await
        .expect("settle turn 3");
    wait_for_idle_session(&runtime, session_id).await;

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let _ = acp_transcript::flush_in(&root, "codex", &acp_sid).await;
            let chain = acp_transcript::read_chain_in(&root, "codex", &acp_sid);
            let turn_ends = chain
                .entries
                .iter()
                .filter(|e| e.k == EntryKind::TurnEnd)
                .count();
            if turn_ends == 3 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("3 turn_ends recorded");

    let settled_chain = acp_transcript::read_chain_in(&root, "codex", &acp_sid);
    let kinds: Vec<EntryKind> = settled_chain.entries.iter().map(|e| e.k).collect();
    assert_eq!(
        kinds,
        vec![
            EntryKind::Prompt,
            EntryKind::Update,
            EntryKind::TurnEnd,
            EntryKind::Prompt,
            EntryKind::Update,
            EntryKind::TurnEnd,
            EntryKind::Prompt,
            EntryKind::Update,
            EntryKind::TurnEnd,
        ]
    );

    let settled_turns = project_turns(&settled_chain.entries);
    assert_eq!(settled_turns.len(), 6);
    // Turn 2 user bubble must have "User 2" (display_text) + Image, NOT "<system-reminder>"
    match &settled_turns[2].blocks[0] {
        ContentBlock::Text { text } => {
            assert_eq!(text, "User 2");
            assert!(!text.contains("system-reminder"));
        }
        other => panic!("expected text block, got {other:?}"),
    }
    assert!(matches!(
        settled_turns[2].blocks[1],
        ContentBlock::Image { .. }
    ));
}

#[tokio::test]
async fn three_consecutive_wire_recorded_turns_preserve_order_display_text_and_tools() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path();
    let agent_dir = "codex";
    let session_id = "conv-three-turns";

    let header = TranscriptHeader::new(agent_dir, session_id, "/workspace", 1_700_000_000_000);
    let _ = acp_transcript::record_header_in(root, agent_dir, &header).await;

    // Turn 1: User 1 -> AI 1 -> TurnEnd 1
    let _ = acp_transcript::record_entry_in(
        root,
        agent_dir,
        session_id,
        EntryKind::Prompt,
        serde_json::json!([{ "type": "text", "text": "User 1" }]),
    )
    .await;
    drop(acp_transcript::record_entry_in(
        root,
        agent_dir,
        session_id,
        EntryKind::Update,
        serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "AI 1" }
        }),
    ));
    let _ = acp_transcript::record_entry_in(
        root,
        agent_dir,
        session_id,
        EntryKind::TurnEnd,
        serde_json::json!({ "stopReason": "end_turn", "durationMs": 120 }),
    )
    .await;

    // Turn 2: smart reminder separation — wire sent agent_text with reminder,
    // but display_blocks recorded user-visible display_text ("User 2") + image.
    let _ = acp_transcript::record_entry_in(
        root,
        agent_dir,
        session_id,
        EntryKind::Prompt,
        serde_json::json!([
            { "type": "text", "text": "User 2" },
            { "type": "image", "data": "aGVsbG8=", "mimeType": "image/png", "uri": "file:///screen.png" }
        ]),
    )
    .await;
    drop(acp_transcript::record_entry_in(
        root,
        agent_dir,
        session_id,
        EntryKind::Update,
        serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "AI 2" }
        }),
    ));
    let _ = acp_transcript::record_entry_in(
        root,
        agent_dir,
        session_id,
        EntryKind::TurnEnd,
        serde_json::json!({ "stopReason": "end_turn", "durationMs": 150 }),
    )
    .await;

    // Turn 3: User 3 -> AI 3 with ToolCall + ToolCallUpdate (check mid-stream first)
    let _ = acp_transcript::record_entry_in(
        root,
        agent_dir,
        session_id,
        EntryKind::Prompt,
        serde_json::json!([{ "type": "text", "text": "User 3" }]),
    )
    .await;
    drop(acp_transcript::record_entry_in(
        root,
        agent_dir,
        session_id,
        EntryKind::Update,
        serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "AI 3" }
        }),
    ));
    drop(acp_transcript::record_entry_in(
        root,
        agent_dir,
        session_id,
        EntryKind::Update,
        serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-42",
            "title": "Run cargo test",
            "kind": "execute",
            "status": "in_progress",
            "rawInput": { "command": "cargo test" }
        }),
    ));
    drop(acp_transcript::record_entry_in(
        root,
        agent_dir,
        session_id,
        EntryKind::Update,
        serde_json::json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-42",
            "status": "completed",
            "content": [
                {
                    "type": "content",
                    "content": { "type": "text", "text": "test result: ok." }
                }
            ]
        }),
    ));
    let _ = acp_transcript::flush_in(root, agent_dir, session_id).await;

    // Mid-stream check before Turn 3 TurnEnd:
    let mid_stream_chain = acp_transcript::read_chain_in(root, agent_dir, session_id);
    let mid_turns = project_turns(&mid_stream_chain.entries);
    let mid_rows = rows_from_turns(&mid_turns);
    let mid_labels: Vec<String> = mid_rows
        .iter()
        .map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. } => match &turn.blocks[0] {
                ContentBlock::Text { text } => text.clone(),
                other => panic!("expected text block, got {other:?}"),
            },
            other => panic!("expected message turn, got {other:?}"),
        })
        .collect();
    assert_eq!(
        mid_labels,
        vec!["User 1", "AI 1", "User 2", "AI 2", "User 3", "AI 3"]
    );
    assert_eq!(row_phase(&mid_rows[4]), "streaming");
    assert_eq!(row_phase(&mid_rows[5]), "streaming");

    // Settle Turn 3 with a single TurnEnd:
    let _ = acp_transcript::record_entry_in(
        root,
        agent_dir,
        session_id,
        EntryKind::TurnEnd,
        serde_json::json!({ "stopReason": "end_turn", "durationMs": 210 }),
    )
    .await;

    let settled_chain = acp_transcript::read_chain_in(root, agent_dir, session_id);
    let kinds: Vec<EntryKind> = settled_chain.entries.iter().map(|e| e.k).collect();
    assert_eq!(
        kinds,
        vec![
            EntryKind::Prompt,
            EntryKind::Update,
            EntryKind::TurnEnd,
            EntryKind::Prompt,
            EntryKind::Update,
            EntryKind::TurnEnd,
            EntryKind::Prompt,
            EntryKind::Update,
            EntryKind::Update,
            EntryKind::Update,
            EntryKind::TurnEnd,
        ]
    );
    assert_eq!(kinds.iter().filter(|&&k| k == EntryKind::Prompt).count(), 3);
    assert_eq!(
        kinds.iter().filter(|&&k| k == EntryKind::TurnEnd).count(),
        3
    );

    let settled_turns = project_turns(&settled_chain.entries);
    let settled_rows = rows_from_turns(&settled_turns);
    let settled_labels: Vec<String> = settled_rows
        .iter()
        .map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. } => match &turn.blocks[0] {
                ContentBlock::Text { text } => text.clone(),
                other => panic!("expected text block, got {other:?}"),
            },
            other => panic!("expected message turn, got {other:?}"),
        })
        .collect();
    assert_eq!(
        settled_labels,
        vec!["User 1", "AI 1", "User 2", "AI 2", "User 3", "AI 3"]
    );
    assert!(settled_rows.iter().all(|row| row_phase(row) == "settled"));

    // Verify Turn 2 user bubble has display_text ("User 2") + image, not the smart reminder:
    assert_eq!(settled_turns[2].blocks.len(), 2);
    match &settled_turns[2].blocks[0] {
        ContentBlock::Text { text } => {
            assert_eq!(text, "User 2");
            assert!(!text.contains("system-reminder"));
        }
        other => panic!("expected text block, got {other:?}"),
    }
    assert!(matches!(
        settled_turns[2].blocks[1],
        ContentBlock::Image { .. }
    ));

    // Verify Turn 3 tool call title, input, output, and status survived reload:
    assert_eq!(settled_turns[5].blocks.len(), 3);
    match &settled_turns[5].blocks[1] {
        ContentBlock::ToolUse {
            tool_use_id,
            tool_name,
            input_preview,
            kind,
            status,
            ..
        } => {
            assert_eq!(tool_use_id.as_deref(), Some("call-42"));
            assert_eq!(tool_name, "Run cargo test");
            assert_eq!(
                input_preview.as_deref(),
                Some(r#"{"command":"cargo test"}"#)
            );
            assert_eq!(kind.as_deref(), Some("execute"));
            assert_eq!(status.as_deref(), Some("completed"));
        }
        other => panic!("expected ToolUse, got {other:?}"),
    }
    match &settled_turns[5].blocks[2] {
        ContentBlock::ToolResult {
            tool_use_id,
            output_preview,
            is_error,
            ..
        } => {
            assert_eq!(tool_use_id.as_deref(), Some("call-42"));
            assert_eq!(output_preview.as_deref(), Some("test result: ok."));
            assert!(!is_error);
        }
        other => panic!("expected ToolResult, got {other:?}"),
    }
}

#[test]
fn transcript_deltas_skip_the_event_log() {
    assert!(is_transcript_delta(
        &ConversationEvent::AssistantTextDelta {
            text: "a".into(),
            message_id: None,
        }
    ));
    assert!(is_transcript_delta(&ConversationEvent::PlanUpdated {
        entries: Vec::new(),
    }));
    assert!(!is_transcript_delta(&ConversationEvent::TurnCompleted {
        stop_reason: None
    }));
    assert!(!is_transcript_delta(&ConversationEvent::UserTurnQueued));
}

#[test]
fn tail_window_is_120_not_the_open_row_cap() {
    let mut turns = Vec::new();
    for index in 0..300 {
        let role = if index % 2 == 0 {
            TurnRole::User
        } else {
            TurnRole::Assistant
        };
        turns.push(turn(role, "x", 1_700_000_000 + index as i64));
    }
    let offset = turn_window::resolve_window_offset(&turns, TurnWindowReq::Tail(120));
    assert!(offset <= 300 - 120);
    assert!(matches!(turns[offset].role, TurnRole::User));
    assert!(300 - offset <= 120 + 1);
}

#[test]
fn slice_turns_by_user_count_preserves_steer_turns_within_kept_turns() {
    let mut u1 = turn(TurnRole::User, "u1", 1);
    u1.id = "acp-0".into();
    let mut a1 = turn(TurnRole::Assistant, "a1", 2);
    a1.id = "acp-1".into();
    let mut s1 = turn(TurnRole::User, "s1", 3);
    s1.id = "acp-2:steer:1".into();
    let mut a2 = turn(TurnRole::Assistant, "a2", 4);
    a2.id = "acp-3".into();
    let mut u2 = turn(TurnRole::User, "u2", 5);
    u2.id = "acp-4".into();
    let mut a3 = turn(TurnRole::Assistant, "a3", 6);
    a3.id = "acp-5".into();

    let kept = slice_turns_by_user_count(&[u1, a1, s1, a2, u2, a3], 1);
    assert_eq!(kept.len(), 4);
    assert_eq!(kept.last().unwrap().id, "acp-3");
}

#[test]
fn session_stats_of_includes_context_window_occupancy_and_percent() {
    let mut u1 = turn(TurnRole::User, "u1", 1);
    u1.id = "acp-0".into();
    let mut a1 = turn(TurnRole::Assistant, "a1", 2);
    a1.id = "acp-1".into();
    a1.duration_ms = Some(1500);
    a1.usage = Some(TurnUsage {
        input_tokens: 4_000,
        output_tokens: 1_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        context_used: Some(25_000),
        context_window_max: Some(200_000),
        cost_amount: None,
        cost_currency: None,
    });

    let stats = session_stats_of(&[u1, a1]).expect("session stats present");
    assert_eq!(stats.total_tokens, Some(5_000));
    assert_eq!(stats.total_duration_ms, 1500);
    assert_eq!(stats.context_window_used_tokens, Some(25_000));
    assert_eq!(stats.context_window_max_tokens, Some(200_000));
    assert_eq!(stats.context_window_usage_percent, Some(12.5));
}

#[test]
fn timeline_from_window_appends_persisted_side_rows_and_fork_status() {
    let conv_id = Uuid::new_v4();
    let mut u1 = turn(TurnRole::User, "u1", 1);
    u1.id = "acp-0".into();
    let mut a1 = turn(TurnRole::Assistant, "a1", 2);
    a1.id = "acp-1".into();
    let error_row = TimelineRow {
        row_id: format!("err:{}:7|user=acp-0|assistant=acp-1", Uuid::new_v4()),
        revision: 7,
        row: ConversationTimelineRow::TurnError {
            error: agents::conversation::ConversationErrorView {
                turn_id: Some(Uuid::new_v4()),
                error: agents::conversation::ConversationError {
                    message: "Rate limit exceeded".to_string(),
                    code: Some("rate_limit".to_string()),
                    raw: None,
                    kind: Default::default(),
                    plan_usage: None,
                },
            },
        },
    };
    let turns = vec![u1, a1];
    let meta = turn_window::window_meta(&turns, 0);
    let mut fork_point_statuses = HashMap::new();
    fork_point_statuses.insert("acp-1".to_string(), agents::ForkPointStatus::Tail);
    let history = WindowedHistory {
        turns,
        side_rows: vec![error_row.clone()],
        fork_point_statuses,
        offset: 0,
        total: 2,
        meta,
        session_stats: None,
        last_sequence: 7,
    };
    let timeline = timeline_from_window(conv_id, &history);
    assert_eq!(timeline.rows.len(), 3);
    assert_eq!(timeline.rows[0].row_id, "acp-0");
    assert_eq!(timeline.rows[1].row_id, "acp-1");
    match &timeline.rows[1].row {
        ConversationTimelineRow::MessageTurn {
            fork_point_status, ..
        } => assert_eq!(*fork_point_status, Some(agents::ForkPointStatus::Tail)),
        other => panic!("expected message turn, got {other:?}"),
    }
    assert_eq!(timeline.rows[2].row_id, error_row.row_id);
    assert!(matches!(
        timeline.rows[2].row,
        ConversationTimelineRow::TurnError { .. }
    ));
}

async fn setup_test_pool() -> SqlitePool {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

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

#[tokio::test]
async fn inflight_first_turn_load_does_not_duplicate_user_prompt_when_acp_session_binds() {
    isolate_test_transcripts();
    let pool = setup_test_pool().await;
    let conversation_id = Uuid::new_v4();
    let turn_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let agent_id = AgentId::parse("codex").expect("agent id");

    ConversationRecord::create(
        &pool,
        conversation_id,
        db::models::conversation::CreateConversationRecord {
            workspace_id,
            task_id: None,
            title: Some("First Turn Test"),
            initial_prompt: Some("Hello first turn"),
            status: None,
            executor: Some("agent"),
        },
    )
    .await
    .expect("create conversation");
    db::models::session::Session::update_agent_metadata(
        &pool,
        conversation_id,
        None,
        Some(&agent_id),
    )
    .await
    .expect("set agent id");
    ConversationTurnRecord::create_pending(
        &pool,
        turn_id,
        db::models::conversation_turn::CreateConversationTurn {
            conversation_id,
            prompt_id: None,
            text_preview: Some("Hello first turn"),
            input_blocks_json: "[]",
        },
    )
    .await
    .expect("create turn");
    ConversationRecord::update_active_turn(&pool, conversation_id, Some(turn_id))
        .await
        .expect("set active turn");

    let created_json = serde_json::to_string(&ConversationEvent::UserTurnCreated {
        blocks: vec![agents::conversation::ConversationInputBlock::Text {
            text: "Hello first turn".to_string(),
        }],
        workflow_refs: Vec::new(),
    })
    .expect("serialize UserTurnCreated");
    crate::ConversationEventAppender::append(
        &pool,
        db::models::conversation_event::AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "user",
            event_kind: "user_turn_created",
            normalized_json: &created_json,
            raw_json: None,
            idempotency_key: None,
        },
    )
    .await
    .expect("append UserTurnCreated");

    // 1. Call load_turns while the first turn is in-flight and ACP session is not bound yet.
    let summary_inflight = DbConversationSummary::find_by_id(&pool, conversation_id)
        .await
        .expect("query summary")
        .expect("summary exists");
    let inflight_turns = load_turns(&pool, &summary_inflight)
        .await
        .expect("load inflight turns");
    assert_eq!(inflight_turns.len(), 1);

    let root = dimo_acp_transcripts_root();
    let simple_sid = conversation_id.simple().to_string();
    assert!(
        !acp_transcript::has_entries_in(&root, "codex", &simple_sid),
        "in-flight first turn must not write a premature migrated transcript under conversation_id.simple()"
    );

    // 2. Now ACP binds external_session_id and writes header + prompt + assistant update + turn_end.
    let external_sid = format!("acp-ext-{}", Uuid::new_v4().simple());
    db::models::session::Session::update_agent_metadata(
        &pool,
        conversation_id,
        Some(&external_sid),
        Some(&agent_id),
    )
    .await
    .expect("bind external session id");

    let mut header =
        TranscriptHeader::new("codex", &external_sid, "/workspace", 1_700_000_000_000);
    if acp_transcript::has_entries_in(&root, "codex", &simple_sid) {
        header.continues_from = Some(simple_sid.clone());
    }
    let _ = acp_transcript::record_header_in(&root, "codex", &header).await;
    let _ = acp_transcript::record_entry_in(
        &root,
        "codex",
        &external_sid,
        EntryKind::Prompt,
        serde_json::json!([{ "type": "text", "text": "Hello first turn" }]),
    )
    .await;
    drop(acp_transcript::record_entry_in(
        &root,
        "codex",
        &external_sid,
        EntryKind::Update,
        serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "Assistant reply" }
        }),
    ));
    let _ = acp_transcript::record_entry_in(
        &root,
        "codex",
        &external_sid,
        EntryKind::TurnEnd,
        serde_json::json!({ "stopReason": "end_turn", "durationMs": 100 }),
    )
    .await;

    let summary_bound = DbConversationSummary::find_by_id(&pool, conversation_id)
        .await
        .expect("query bound summary")
        .expect("summary exists");
    let final_turns = load_turns(&pool, &summary_bound)
        .await
        .expect("load final turns");
    let user_turns: Vec<&MessageTurn> = final_turns
        .iter()
        .filter(|t| matches!(t.role, TurnRole::User))
        .collect();
    assert_eq!(
        user_turns.len(),
        1,
        "first user turn must appear exactly once, not duplicated across simple_sid and external_sid"
    );
    assert_eq!(final_turns.len(), 2);
}

#[tokio::test]
async fn fts_reindex_on_legacy_backfill_indexes_external_session_id_jsonl_assistant_reply() {
    isolate_test_transcripts();
    let pool = setup_test_pool().await;
    let conversation_id = Uuid::new_v4();
    let turn_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let agent_id = AgentId::parse("codex").expect("agent id");
    let external_sid = format!("acp-fts-{}", Uuid::new_v4().simple());

    ConversationRecord::create(
        &pool,
        conversation_id,
        db::models::conversation::CreateConversationRecord {
            workspace_id,
            task_id: None,
            title: Some("FTS External Session Test"),
            initial_prompt: Some("Find secret keyword"),
            status: None,
            executor: Some("agent"),
        },
    )
    .await
    .expect("create conversation");
    db::models::session::Session::update_agent_metadata(
        &pool,
        conversation_id,
        Some(&external_sid),
        Some(&agent_id),
    )
    .await
    .expect("bind external session id");
    ConversationTurnRecord::create_pending(
        &pool,
        turn_id,
        db::models::conversation_turn::CreateConversationTurn {
            conversation_id,
            prompt_id: None,
            text_preview: Some("Find secret keyword"),
            input_blocks_json: "[]",
        },
    )
    .await
    .expect("create turn");
    sqlx::query("UPDATE sessions SET legacy_jsonl_migrated = 0 WHERE id = ?")
        .bind(conversation_id)
        .execute(&pool)
        .await
        .expect("mark session unmigrated");

    let root = dimo_acp_transcripts_root();
    let header = TranscriptHeader::new("codex", &external_sid, "/workspace", 1_700_000_000_000);
    let _ = acp_transcript::record_header_in(&root, "codex", &header).await;
    let _ = acp_transcript::record_entry_in(
        &root,
        "codex",
        &external_sid,
        EntryKind::Prompt,
        serde_json::json!([{ "type": "text", "text": "Find secret keyword" }]),
    )
    .await;
    drop(acp_transcript::record_entry_in(
        &root,
        "codex",
        &external_sid,
        EntryKind::Update,
        serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "The magic token is XylophoneQuantum42." }
        }),
    ));
    let _ = acp_transcript::record_entry_in(
        &root,
        "codex",
        &external_sid,
        EntryKind::TurnEnd,
        serde_json::json!({ "stopReason": "end_turn", "durationMs": 80 }),
    )
    .await;

    let migrated = crate::ensure_legacy_jsonl_migrated_on_pool(&pool, conversation_id)
        .await
        .expect("backfill legacy jsonl");
    assert!(migrated);

    let indexed_body: String = sqlx::query_scalar(
        "SELECT COALESCE(group_concat(text, ' '), '') FROM conversation_fts WHERE conversation_id = ?1",
    )
    .bind(conversation_id.to_string())
    .fetch_one(&pool)
    .await
    .expect("fetch row-level FTS text");
    assert!(
        indexed_body.contains("XylophoneQuantum42"),
        "row-level FTS after legacy backfill must include assistant reply from <external_session_id>.jsonl, got: {indexed_body}"
    );
}
