use agents::conversation::{
    ContentBlock, ConversationEvent, ConversationInputBlock, ConversationRowOp,
    ConversationTimelineRow, TimelineRow,
};
use db::models::{
    conversation_snapshot::ConversationProjectionSnapshotRecord,
    conversation_timeline_row::ConversationTimelineRowRecord,
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
};
use uuid::Uuid;

use super::{
    ConversationProjector, IncrementalRowProjector, MAX_WINDOW_BYTES, ProjectionSnapshotState,
    fetch_hydrated_turns_for_projector,
    rows::tests::{append_event, seed_turn, setup_pool},
};

async fn append_simple_turn(
    pool: &sqlx::SqlitePool,
    conversation_id: Uuid,
    ordinal_hint: usize,
    user_text: &str,
    assistant_text: &str,
) -> (Uuid, i64) {
    let turn = ConversationTurnRecord::create_pending(
        pool,
        Uuid::new_v4(),
        CreateConversationTurn {
            conversation_id,
            prompt_id: Some(&format!("prompt-{ordinal_hint}")),
            text_preview: Some(user_text),
            input_blocks_json: "[]",
        },
    )
    .await
    .expect("create pending turn");

    append_event(
        pool,
        conversation_id,
        Some(turn.id),
        "user",
        ConversationEvent::UserTurnCreated {
            blocks: vec![ConversationInputBlock::Text {
                text: user_text.to_string(),
            }],
            workflow_refs: Vec::new(),
        },
        None,
    )
    .await;

    append_event(
        pool,
        conversation_id,
        Some(turn.id),
        "acp",
        ConversationEvent::AssistantTextDelta {
            text: assistant_text.to_string(),
            message_id: None,
        },
        None,
    )
    .await;

    let done = append_event(
        pool,
        conversation_id,
        Some(turn.id),
        "acp",
        ConversationEvent::TurnCompleted {
            stop_reason: Some("end_turn".into()),
        },
        None,
    )
    .await;

    (turn.id, done.sequence)
}

#[tokio::test]
async fn incremental_projector_hydrates_only_latest_turn_and_reloads_older_turn_on_demand() {
    let pool = setup_pool().await;
    let (conversation_id, turn1_id) = seed_turn(&pool).await;

    append_event(
        &pool,
        conversation_id,
        Some(turn1_id),
        "user",
        ConversationEvent::UserTurnCreated {
            blocks: vec![ConversationInputBlock::Text {
                text: "turn-1 prompt".into(),
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
            text: "turn-1 original answer".into(),
            message_id: None,
        },
        None,
    )
    .await;
    append_event(
        &pool,
        conversation_id,
        Some(turn1_id),
        "acp",
        ConversationEvent::TurnCompleted { stop_reason: None },
        None,
    )
    .await;

    let mut last_seq = 0;
    for i in 2..=10 {
        let (_tid, seq) = append_simple_turn(
            &pool,
            conversation_id,
            i,
            &format!("prompt-{i}"),
            &format!("answer-{i}"),
        )
        .await;
        last_seq = seq;
    }

    let snapshot = ConversationProjectionSnapshotRecord::find(&pool, conversation_id)
        .await
        .expect("find snapshot")
        .expect("snapshot exists");
    let state: ProjectionSnapshotState =
        serde_json::from_str(&snapshot.fold_json).expect("decode snapshot state");
    assert!(
        !state.full_fold,
        "write path must persist lightweight non-full_fold snapshot"
    );
    assert!(
        state.turns.is_empty(),
        "lightweight snapshot must not serialize full turn blocks"
    );
    assert_eq!(state.turn_order.len(), 10);

    let mut projector = IncrementalRowProjector::load(&pool, conversation_id, last_seq)
        .await
        .expect("load incremental projector");

    // Append an event targeting the unhydrated older `turn1_id`.
    let late_record = append_event(
        &pool,
        conversation_id,
        Some(turn1_id),
        "acp",
        ConversationEvent::AssistantTextDelta {
            text: " + addendum".into(),
            message_id: None,
        },
        None,
    )
    .await;

    let missing = projector.missing_turns_for_records(std::slice::from_ref(&late_record));
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].0, turn1_id);

    let hydrated = fetch_hydrated_turns_for_projector(
        &pool,
        conversation_id,
        projector.complete_antigravity_reads(),
        &missing,
    )
    .await
    .expect("hydrate missing turn");
    projector.insert_hydrated_turns(hydrated);

    let ops = projector.apply(&late_record).expect("apply late event");
    assert!(
        ops.iter().any(|op| matches!(
            op,
            ConversationRowOp::AppendText { row_id, delta, .. }
                if row_id == &format!("{turn1_id}:assistant") && delta == " + addendum"
        )),
        "expected AppendText op for lazily hydrated older turn: {ops:?}"
    );
    let assistant_text =
        ConversationProjector::assistant_text_for_turn(&pool, conversation_id, turn1_id)
            .await
            .expect("assistant_text_for_turn");
    assert_eq!(
        assistant_text.as_deref(),
        Some("turn-1 original answer + addendum")
    );
}

#[tokio::test]
async fn write_cache_trims_resident_turns_and_reloads_trimmed_turn_cleanly() {
    let pool = setup_pool().await;
    let (conversation_id, turn1_id) = seed_turn(&pool).await;

    append_event(
        &pool,
        conversation_id,
        Some(turn1_id),
        "user",
        ConversationEvent::UserTurnCreated {
            blocks: vec![ConversationInputBlock::Text {
                text: "first question".into(),
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
            text: "initial body".into(),
            message_id: None,
        },
        None,
    )
    .await;
    append_event(
        &pool,
        conversation_id,
        Some(turn1_id),
        "acp",
        ConversationEvent::TurnCompleted { stop_reason: None },
        None,
    )
    .await;

    // Exceed MAX_WRITE_RESIDENT_TURNS (8) so `turn1_id` is trimmed from write-side RAM cache.
    for i in 2..=12 {
        append_simple_turn(
            &pool,
            conversation_id,
            i,
            &format!("user-{i}"),
            &format!("reply-{i}"),
        )
        .await;
    }

    // Mutate `turn1_id` after it was trimmed; write path must reload prior state instead of overwriting it.
    append_event(
        &pool,
        conversation_id,
        Some(turn1_id),
        "acp",
        ConversationEvent::AssistantContentAppended {
            block: ContentBlock::Text {
                text: "tail note".into(),
            },
            message_id: None,
        },
        None,
    )
    .await;

    let full_turn1 =
        ConversationProjector::assistant_text_for_turn(&pool, conversation_id, turn1_id)
            .await
            .expect("assistant_text_for_turn after reload");
    let text = full_turn1.expect("turn1 assistant row exists");
    assert!(
        text.contains("initial body") && text.contains("tail note"),
        "trimmed turn reload must preserve initial content alongside new content, got: {text:?}"
    );
}

#[tokio::test]
async fn rows_since_with_tombstones_respects_row_limit_and_byte_budget() {
    let pool = setup_pool().await;
    let (conversation_id, turn1_id) = seed_turn(&pool).await;
    append_event(
        &pool,
        conversation_id,
        Some(turn1_id),
        "user",
        ConversationEvent::UserTurnCreated {
            blocks: vec![ConversationInputBlock::Text { text: "t1".into() }],
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
            text: "a1".into(),
            message_id: None,
        },
        None,
    )
    .await;
    append_event(
        &pool,
        conversation_id,
        Some(turn1_id),
        "acp",
        ConversationEvent::TurnCompleted { stop_reason: None },
        None,
    )
    .await;

    let mut latest_seq = 0;
    for i in 2..=5 {
        let (_, seq) = append_simple_turn(
            &pool,
            conversation_id,
            i,
            &format!("u{i}"),
            &format!("r{i}"),
        )
        .await;
        latest_seq = seq;
    }

    // 5 turns = 10 message rows + 1 `status:agent-request` side row = 11 rows.
    // Limiting to 3 rows must return reset=true without returning a huge batch.
    let limited =
        ConversationProjector::rows_since_with_tombstones(&pool, conversation_id, 0, Some(3))
            .await
            .expect("limited rows_since");
    assert!(
        limited.reset,
        "truncated row limit must trigger reset: true"
    );
    assert!(limited.ops.is_empty());
    assert_eq!(limited.last_sequence, latest_seq);

    let full =
        ConversationProjector::rows_since_with_tombstones(&pool, conversation_id, 0, Some(50))
            .await
            .expect("untruncated rows_since");
    assert!(!full.reset);
    assert_eq!(full.ops.len(), 11);

    // Inflate two rows in materialized table beyond MAX_WINDOW_BYTES to test byte-budget reset.
    let big_payload = "x".repeat(MAX_WINDOW_BYTES / 2 + 128 * 1024);
    for (idx, row_id) in ["big-row-1", "big-row-2"].into_iter().enumerate() {
        let row = TimelineRow {
            row_id: row_id.into(),
            revision: latest_seq,
            row: ConversationTimelineRow::MessageTurn {
                phase: "settled".into(),
                fork_point_status: None,
                turn: agents::conversation::MessageTurn {
                    id: row_id.into(),
                    role: agents::conversation::TurnRole::Assistant,
                    blocks: vec![ContentBlock::Text {
                        text: big_payload.clone(),
                    }],
                    timestamp: chrono::Utc::now(),
                    usage: None,
                    duration_ms: None,
                    model: None,
                    completed_at: None,
                    agent_message_id: None,
                },
            },
        };
        let row_json = serde_json::to_string(&row).expect("serialize big row");
        let mut conn = pool.acquire().await.expect("conn");
        ConversationTimelineRowRecord::upsert_row_on_conn(
            &mut conn,
            conversation_id,
            Some(20 + idx as i64),
            row_id,
            latest_seq,
            &row_json,
        )
        .await
        .expect("insert big row");
    }

    let over_budget =
        ConversationProjector::rows_since_with_tombstones(&pool, conversation_id, 0, Some(50))
            .await
            .expect("byte-budgeted rows_since");
    assert!(
        over_budget.reset,
        "exceeding MAX_WINDOW_BYTES must signal reset: true"
    );
    assert!(over_budget.ops.is_empty());
}

#[tokio::test]
async fn count_visible_turns_and_latest_assistant_text_use_bounded_materialized_queries() {
    let pool = setup_pool().await;
    let (conversation_id, turn1_id) = seed_turn(&pool).await;

    append_event(
        &pool,
        conversation_id,
        Some(turn1_id),
        "user",
        ConversationEvent::UserTurnCreated {
            blocks: vec![ConversationInputBlock::Text { text: "q1".into() }],
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
            text: "first answer".into(),
            message_id: None,
        },
        None,
    )
    .await;
    append_event(
        &pool,
        conversation_id,
        Some(turn1_id),
        "acp",
        ConversationEvent::TurnCompleted { stop_reason: None },
        None,
    )
    .await;

    let (turn2_id, _) = append_simple_turn(&pool, conversation_id, 2, "q2", "second answer").await;

    let count = ConversationProjector::count_visible_turns(&pool, conversation_id)
        .await
        .expect("count_visible_turns");
    assert_eq!(count, 4);

    let latest = ConversationProjector::latest_assistant_text(&pool, conversation_id)
        .await
        .expect("latest_assistant_text");
    assert_eq!(latest.as_deref(), Some("second answer"));

    let t1_text = ConversationProjector::assistant_text_for_turn(&pool, conversation_id, turn1_id)
        .await
        .expect("t1 text");
    assert_eq!(t1_text.as_deref(), Some("first answer"));

    let t2_text = ConversationProjector::assistant_text_for_turn(&pool, conversation_id, turn2_id)
        .await
        .expect("t2 text");
    assert_eq!(t2_text.as_deref(), Some("second answer"));
}
