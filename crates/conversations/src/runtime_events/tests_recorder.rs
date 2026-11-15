use std::str::FromStr;

use agents::{
    AgentConnectionId, AgentContentBlock, AgentEvent, AgentEventEnvelope, AgentPromptId,
    AgentPromptSnapshot, AgentPromptStatus, AgentSessionId, AgentUsage,
    conversation::ConversationEvent,
};
use chrono::Utc;
use db::models::{
    conversation::{ConversationRecord, CreateConversationRecord},
    conversation_event::AppendConversationEvent,
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    session::Session,
};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use uuid::Uuid;

use super::{
    ConversationAgentEventRecorder, append_mapped_event,
    coalescer::StreamingThrottleCoalescer,
    mapping::{
        bind_prompt_turn, is_turn_scoped_content, persist_session_linked_external_id,
        resolve_agent_event_turn_id,
    },
    start_agent_event_persistence_loop,
    tests_coalescer::{connection_ready_event, envelope, mapped_record},
};

async fn setup_pool() -> SqlitePool {
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

async fn setup_pool_with_foreign_keys() -> SqlitePool {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite options")
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("connect memory db");
    sqlx::migrate!("../db/migrations")
        .run(&pool)
        .await
        .expect("run migrations");
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .expect("enable foreign keys");
    pool
}

async fn seed_conversation_turn(pool: &SqlitePool, prompt_id: &str, preview: &str) -> (Uuid, Uuid) {
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
            prompt_id: Some(prompt_id),
            text_preview: Some(preview),
            input_blocks_json: "[]",
        },
    )
    .await
    .expect("create turn");
    ConversationRecord::update_active_turn(pool, conversation_id, Some(turn.id))
        .await
        .expect("set active turn");
    (conversation_id, turn.id)
}

fn message_chunk() -> AgentEvent {
    AgentEvent::MessageChunk {
        content: AgentContentBlock::Text {
            text: "token".into(),
        },
    }
}

fn prompt_started(prompt_id: AgentPromptId, session_id: AgentSessionId) -> AgentEvent {
    let now = Utc::now();
    AgentEvent::PromptStarted {
        snapshot: AgentPromptSnapshot {
            id: prompt_id,
            session_id,
            status: AgentPromptStatus::Running,
            text_preview: "B".into(),
            created_at: now,
            updated_at: now,
        },
    }
}

fn test_recorder(pool: SqlitePool) -> ConversationAgentEventRecorder {
    ConversationAgentEventRecorder {
        pool,
        deployment: None,
        conversation_context: None,
        event_publisher: None,
        coalescer: StreamingThrottleCoalescer::new(),
        active_turn_cache: std::collections::HashMap::new(),
        cached_turn_epoch: db::models::conversation::active_turn_mutation_epoch(),
        pending_step_text: std::collections::HashMap::new(),
        turn_had_tool_call: std::collections::HashSet::new(),
        turn_db_lookups: 0,
    }
}

#[tokio::test]
async fn session_linked_writes_external_session_id() {
    let pool = setup_pool().await;
    let (conversation_id, _) = seed_conversation_turn(&pool, "prompt-1", "hello").await;

    persist_session_linked_external_id(
        &pool,
        conversation_id,
        "acp-live-session-9",
        &agents::AgentId::parse("codex").unwrap(),
    )
    .await
    .expect("persist SessionLinked");

    let session = Session::find_by_id(&pool, conversation_id)
        .await
        .expect("load session")
        .expect("session exists");
    assert_eq!(
        session.external_session_id.as_deref(),
        Some("acp-live-session-9")
    );
}

#[tokio::test]
async fn recorder_attributes_current_events_and_refuses_invalidated_session_linked() {
    use db::models::conversation::ConversationAgentBindingRecord;
    let pool = setup_pool().await;
    let (conversation_id, _) = seed_conversation_turn(&pool, "prompt-binding", "hello").await;
    let connection_id = AgentConnectionId::new();
    let agent = agents::AgentId::parse("codex").unwrap();
    let binding = ConversationAgentBindingRecord::link_native_session(
        &pool,
        conversation_id,
        &agent,
        "/work",
        "native-old",
        &connection_id.to_string(),
    )
    .await
    .unwrap();
    let mut recorder = test_recorder(pool.clone());
    let mut env = envelope(AgentEvent::SessionLinked {
        acp_session_id: "native-old".into(),
        agent_id: agent.clone(),
        capabilities: Default::default(),
    });
    env.connection_id = connection_id;
    env.session_id = Some(AgentSessionId(conversation_id));
    recorder.record(&env).await.unwrap();
    let attributed: Option<Uuid> = sqlx::query_scalar(
        "SELECT binding_id FROM conversation_events WHERE conversation_id = ? ORDER BY sequence DESC LIMIT 1",
    )
    .bind(conversation_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(attributed, Some(binding.id));
    env.sequence += 1;
    env.event = AgentEvent::SessionInvalidated {
        reason: "cancel_timeout".into(),
    };
    recorder.record(&env).await.unwrap();
    env.sequence += 1;
    env.event = AgentEvent::SessionLinked {
        acp_session_id: "native-old".into(),
        agent_id: agent,
        capabilities: Default::default(),
    };
    assert!(recorder.record(&env).await.unwrap().events.is_empty());
    let active = ConversationAgentBindingRecord::active_for_conversation(&pool, conversation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(active.id, binding.id);
    assert!(!active.resume_allowed);
    assert_eq!(active.acp_session_id.as_deref(), Some("native-old"));
}

#[tokio::test]
async fn completed_prompt_cannot_claim_a_new_pending_turn() {
    let pool = setup_pool().await;
    let (conversation, old) = seed_conversation_turn(&pool, "old-prompt", "old").await;
    ConversationTurnRecord::mark_completed(&pool, old, Some("end_turn"), None, None)
        .await
        .unwrap();
    let next = ConversationTurnRecord::create_pending(
        &pool,
        Uuid::new_v4(),
        CreateConversationTurn {
            conversation_id: conversation,
            prompt_id: None,
            text_preview: Some("next"),
            input_blocks_json: "[]",
        },
    )
    .await
    .unwrap();
    ConversationRecord::update_active_turn(&pool, conversation, Some(next.id))
        .await
        .unwrap();
    assert_eq!(
        bind_prompt_turn(&pool, conversation, "old-prompt")
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        ConversationTurnRecord::find_by_id(&pool, next.id)
            .await
            .unwrap()
            .unwrap()
            .prompt_id,
        None
    );
}

#[tokio::test]
async fn prompt_start_binds_once_and_late_start_cannot_capture_another_turn() {
    let pool = setup_pool().await;
    let (conversation, turn) = seed_conversation_turn(&pool, "unused", "hello").await;
    sqlx::query("UPDATE conversation_turns SET prompt_id = NULL WHERE id = ?")
        .bind(turn)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        bind_prompt_turn(&pool, conversation, "unreserved-request")
            .await
            .unwrap(),
        None
    );
    ConversationTurnRecord::set_prompt_id(&pool, turn, "request-a")
        .await
        .unwrap();
    assert_eq!(
        bind_prompt_turn(&pool, conversation, "request-a")
            .await
            .unwrap(),
        Some(turn)
    );
    assert_eq!(
        ConversationTurnRecord::find_by_id(&pool, turn)
            .await
            .unwrap()
            .unwrap()
            .prompt_id
            .as_deref(),
        Some("request-a")
    );
    assert_eq!(
        bind_prompt_turn(&pool, conversation, "late-request")
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn post_completion_events_do_not_pin_the_next_turn_to_the_previous() {
    let pool = setup_pool().await;
    let prompt_a = AgentPromptId::new();
    let (conversation_id, turn_a) = seed_conversation_turn(&pool, &prompt_a.to_string(), "A").await;

    let first = resolve_agent_event_turn_id(&pool, conversation_id, &message_chunk())
        .await
        .expect("bind A stream");
    assert_eq!(first, Some(turn_a));

    ConversationTurnRecord::mark_completed(&pool, turn_a, Some("end_turn"), None, None)
        .await
        .expect("complete A");

    let usage = resolve_agent_event_turn_id(
        &pool,
        conversation_id,
        &AgentEvent::Usage {
            usage: AgentUsage::default(),
        },
    )
    .await
    .expect("bind usage");
    assert_eq!(usage, Some(turn_a));

    let prompt_b = AgentPromptId::new();
    let turn_b = ConversationTurnRecord::create_pending(
        &pool,
        Uuid::new_v4(),
        CreateConversationTurn {
            conversation_id,
            prompt_id: Some(&prompt_b.to_string()),
            text_preview: Some("B"),
            input_blocks_json: "[]",
        },
    )
    .await
    .expect("create B")
    .id;
    ConversationRecord::update_active_turn(&pool, conversation_id, Some(turn_b))
        .await
        .expect("activate B");

    let started = resolve_agent_event_turn_id(
        &pool,
        conversation_id,
        &prompt_started(prompt_b, AgentSessionId(conversation_id)),
    )
    .await
    .expect("bind PromptStarted");
    assert_eq!(started, Some(turn_b));

    let second = resolve_agent_event_turn_id(&pool, conversation_id, &message_chunk())
        .await
        .expect("bind B stream");
    assert_eq!(
        second,
        Some(turn_b),
        "B's stream must not inherit A's turn id"
    );
}

#[tokio::test]
async fn completed_active_pointer_does_not_capture_the_next_message_chunk() {
    let pool = setup_pool().await;
    let prompt_a = AgentPromptId::new();
    let (conversation_id, turn_a) = seed_conversation_turn(&pool, &prompt_a.to_string(), "A").await;
    ConversationTurnRecord::mark_completed(&pool, turn_a, Some("end_turn"), None, None)
        .await
        .expect("complete A");

    let orphan = resolve_agent_event_turn_id(&pool, conversation_id, &message_chunk())
        .await
        .expect("refuse completed pointer");
    assert_eq!(orphan, None);

    let prompt_b = AgentPromptId::new();
    let turn_b = ConversationTurnRecord::create_pending(
        &pool,
        Uuid::new_v4(),
        CreateConversationTurn {
            conversation_id,
            prompt_id: Some(&prompt_b.to_string()),
            text_preview: Some("B"),
            input_blocks_json: "[]",
        },
    )
    .await
    .expect("create B")
    .id;
    ConversationRecord::update_active_turn(&pool, conversation_id, Some(turn_b))
        .await
        .expect("activate B");

    let second = resolve_agent_event_turn_id(&pool, conversation_id, &message_chunk())
        .await
        .expect("bind B");
    assert_eq!(second, Some(turn_b));
}

#[tokio::test]
async fn request_activity_never_falls_back_from_an_old_or_unknown_prompt() {
    let pool = setup_pool().await;
    let prompt_a = AgentPromptId::new();
    let (conversation_id, turn_a) = seed_conversation_turn(&pool, &prompt_a.to_string(), "A").await;
    ConversationTurnRecord::mark_completed(&pool, turn_a, None, None, None)
        .await
        .unwrap();
    let prompt_b = AgentPromptId::new();
    let turn_b = ConversationTurnRecord::create_pending(
        &pool,
        Uuid::new_v4(),
        CreateConversationTurn {
            conversation_id,
            prompt_id: Some(&prompt_b.to_string()),
            text_preview: Some("B"),
            input_blocks_json: "[]",
        },
    )
    .await
    .unwrap();
    ConversationRecord::update_active_turn(&pool, conversation_id, Some(turn_b.id))
        .await
        .unwrap();
    for prompt in [prompt_a, AgentPromptId::new()] {
        let event = AgentEvent::RequestActivity {
            prompt_id: prompt,
            activity: agents::request_status::RequestActivity::phase(
                agents::request_status::RequestPhase::Retrying,
            ),
        };
        assert_eq!(
            resolve_agent_event_turn_id(&pool, conversation_id, &event)
                .await
                .unwrap(),
            None
        );
    }
    let event = AgentEvent::RequestActivity {
        prompt_id: prompt_b,
        activity: agents::request_status::RequestActivity::phase(
            agents::request_status::RequestPhase::Retrying,
        ),
    };
    assert_eq!(
        resolve_agent_event_turn_id(&pool, conversation_id, &event)
            .await
            .unwrap(),
        Some(turn_b.id)
    );
}

#[tokio::test]
async fn a_cancelled_turns_trailing_output_is_dropped_immediately() {
    let pool = setup_pool().await;
    let prompt_a = AgentPromptId::new();
    let (conversation_id, turn_a) = seed_conversation_turn(&pool, &prompt_a.to_string(), "A").await;

    assert_eq!(
        resolve_agent_event_turn_id(&pool, conversation_id, &message_chunk())
            .await
            .expect("bind while in flight"),
        Some(turn_a)
    );

    ConversationTurnRecord::mark_cancelled(&pool, turn_a, Some("user cancelled"))
        .await
        .expect("cancel A");
    ConversationRecord::update_active_turn(&pool, conversation_id, None)
        .await
        .expect("clear active turn");

    let trailing = resolve_agent_event_turn_id(&pool, conversation_id, &message_chunk())
        .await
        .expect("resolve trailing chunk");
    assert_eq!(
        trailing, None,
        "a cancelled turn's trailing output must not be attributed to any turn"
    );
    assert!(
        is_turn_scoped_content(&message_chunk()),
        "turn content with no in-flight turn is dropped by `map_record`"
    );
}

#[tokio::test]
async fn missing_conversation_rows_skip_the_event_instead_of_failing_the_batch() {
    let pool = setup_pool_with_foreign_keys().await;
    let mapped = mapped_record(1, connection_ready_event());
    let normalized = serde_json::to_string(&mapped.event).expect("serialize");

    let skipped = append_mapped_event(&pool, &mapped, &normalized)
        .await
        .expect("a missing conversation is skippable");
    assert!(
        skipped.is_none(),
        "events for an unknown conversation must not abort the recorder"
    );

    let mut connect_event = mapped_record(2, connection_ready_event());
    connect_event.turn_id = None;
    let connect_normalized = serde_json::to_string(&connect_event.event).expect("serialize");
    let skipped_connect = append_mapped_event(&pool, &connect_event, &connect_normalized)
        .await
        .expect("connect-time events without a turn are skippable");
    assert!(
        skipped_connect.is_none(),
        "bind/status events for an unknown conversation must not abort the recorder"
    );
}

#[tokio::test]
async fn missing_turn_rows_are_persisted_on_the_conversation() {
    let pool = setup_pool().await;
    let (conversation_id, _) = seed_conversation_turn(&pool, "prompt-1", "hello").await;
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .expect("enable foreign keys");

    let mut mapped = mapped_record(1, connection_ready_event());
    mapped.conversation_id = conversation_id;
    mapped.turn_id = Some(Uuid::new_v4());
    let normalized = serde_json::to_string(&mapped.event).expect("serialize");

    let record = append_mapped_event(&pool, &mapped, &normalized)
        .await
        .expect("retry without turn")
        .expect("event persisted");
    assert_eq!(record.conversation_id, conversation_id);
    assert_eq!(record.turn_id, None);
}

#[tokio::test]
async fn resilient_agent_event_loop_recovers_after_panic_and_keeps_receiver_alive() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::mpsc;

    let pool = setup_pool().await;
    let (tx, rx) = mpsc::channel(16);
    let processed = Arc::new(AtomicUsize::new(0));
    let processed_clone = Arc::clone(&processed);

    let handle = start_agent_event_persistence_loop(
        move || test_recorder(pool.clone()),
        rx,
        move |env| {
            if env.sequence == 1 {
                panic!("simulated panic on malformed event");
            }
            processed_clone.fetch_add(1, Ordering::SeqCst);
        },
    );

    let mut env1 = envelope(message_chunk());
    env1.sequence = 1;
    tx.send(env1).await.expect("send first event");

    let mut env2 = envelope(message_chunk());
    env2.sequence = 2;
    tx.send(env2)
        .await
        .expect("receiver must stay open after worker panic");

    drop(tx);
    handle.await.expect("loop task finishes cleanly");
    assert_eq!(
        processed.load(Ordering::SeqCst),
        1,
        "second event after panic must still be processed"
    );
}

#[tokio::test]
async fn streaming_100_message_chunks_caches_active_turn_and_persists_coalesced_delta_to_sqlite() {
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct CapturingPublisher {
        persisted_batches: Mutex<Vec<Vec<db::models::conversation_event::ConversationEventRecord>>>,
    }

    #[async_trait::async_trait]
    impl crate::ConversationEventPublisher for CapturingPublisher {
        async fn publish(&self, record: &db::models::conversation_event::ConversationEventRecord) {
            self.persisted_batches
                .lock()
                .unwrap()
                .push(vec![record.clone()]);
        }

        async fn publish_batch(
            &self,
            records: &[db::models::conversation_event::ConversationEventRecord],
        ) {
            self.persisted_batches
                .lock()
                .unwrap()
                .push(records.to_vec());
        }
    }

    let pool = setup_pool().await;
    let prompt_id = AgentPromptId::new();
    let (conversation_id, turn_id) =
        seed_conversation_turn(&pool, &prompt_id.to_string(), "stream test").await;
    let publisher = Arc::new(CapturingPublisher::default());
    let connection_id = AgentConnectionId::new();

    let mut recorder = test_recorder(pool.clone());
    recorder.event_publisher = Some(publisher.clone());

    let mut expected_text = String::new();
    for seq in 1..=100_i64 {
        let token = format!("tok-{seq} ");
        expected_text.push_str(&token);
        let env = AgentEventEnvelope {
            sequence: seq,
            workspace_id: Uuid::new_v4(),
            connection_id,
            session_id: Some(AgentSessionId(conversation_id)),
            event: AgentEvent::MessageChunk {
                content: AgentContentBlock::Text { text: token },
            },
            created_at: Utc::now(),
        };
        let batch = recorder
            .record_buffered(&env)
            .await
            .expect("record buffered chunk");
        assert!(batch.events.is_empty());
        assert!(
            recorder
                .coalescer
                .buffer
                .first()
                .expect("pending delta exists")
                .base
                .raw_json
                .is_none(),
            "per-chunk map_record must not serialize raw_json for transcript deltas"
        );
    }

    assert_eq!(
        recorder.turn_db_lookups, 1,
        "100 consecutive streaming chunks must query SQLite at most once for active_turn_id"
    );

    let flushed = recorder
        .flush_buffered()
        .await
        .expect("flush buffered chunks");
    assert_eq!(flushed.events.len(), 1);
    assert_eq!(recorder.turn_db_lookups, 1);

    let batches = publisher.persisted_batches.lock().unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].len(), 1);
    assert_eq!(batches[0][0].conversation_id, conversation_id);
    assert_eq!(batches[0][0].turn_id, Some(turn_id));
    assert_eq!(batches[0][0].event_kind, "assistant_text_delta");

    // Verify durable persistence in `conversation_events` AND materialized timeline rows!
    let open = crate::ConversationProjector::project_open(&pool, conversation_id, 16)
        .await
        .expect("project_open from SQLite");
    assert!(open.timeline.rows.iter().any(|r| {
        matches!(
            &r.row,
            agents::conversation::ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.blocks.iter().any(|b| matches!(b, agents::ContentBlock::Text { text } if text == &expected_text))
        )
    }));
}

#[tokio::test]
async fn streaming_2000_chars_uses_at_most_20_sqlite_write_transactions_and_recovers_from_db() {
    use tokio::time::{Duration, Instant};

    let pool = setup_pool().await;
    let prompt_id = AgentPromptId::new();
    let (conversation_id, turn_id) =
        seed_conversation_turn(&pool, &prompt_id.to_string(), "2000 char stream").await;

    let mut recorder = test_recorder(pool.clone());
    let t0 = Instant::now();
    let mut write_txns = 0_usize;
    let mut full_expected = String::new();

    // Simulate 100 chunks of 20 characters (~2,000 chars) arriving every 50ms (= 5,000ms total),
    // interspersed with paragraph breaks and a fenced code block.
    for idx in 0..100_i64 {
        let chunk = if idx == 20 {
            "```rust\nlet x = 1;\n\n".to_string() // 20 chars
        } else if idx == 30 {
            "println!(\"{x}\");\n```\n".to_string() // 21 chars
        } else if idx % 15 == 0 {
            format!("para-{idx:03}-boundary.\n\n") // 20 chars
        } else {
            format!("segment-{idx:03}-content ") // 20 chars
        };
        full_expected.push_str(&chunk);

        let mapped = super::mapping::MappedConversationEventRecord {
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: "conn-2000".to_string(),
            prompt_id: None,
            source: "acp",
            event_kind: "assistant_text_delta".to_string(),
            event: ConversationEvent::AssistantTextDelta {
                text: chunk,
                message_id: None,
            },
            raw_json: None,
            idempotency_key: format!("agent:conn-2000:{idx}:assistant_text_delta"),
            first_agent_sequence: idx + 1,
            last_agent_sequence: idx + 1,
            complete_reply: false,
        };
        let ready = recorder
            .coalescer
            .push_at(mapped, t0 + Duration::from_millis((idx as u64) * 50));
        if !ready.is_empty() {
            write_txns += 1;
            recorder.append_records(ready).await.expect("append batch");
        }
    }

    let tail = recorder.coalescer.flush_all();
    if !tail.is_empty() {
        write_txns += 1;
        recorder.append_records(tail).await.expect("append tail");
    }

    assert!(full_expected.len() >= 2000);
    assert!(
        write_txns <= 20,
        "expected <= 20 SQLite write transactions for 2000 streamed chars, got {write_txns}"
    );

    let timeline = crate::ConversationProjector::project(&pool, conversation_id)
        .await
        .expect("project recovered timeline");
    let assistant_text: String = timeline
        .rows
        .iter()
        .filter_map(|r| match &r.row {
            agents::conversation::ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.role == agents::TurnRole::Assistant =>
            {
                Some(
                    turn.blocks
                        .iter()
                        .filter_map(|b| match b {
                            agents::ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<String>(),
                )
            }
            _ => None,
        })
        .collect();
    assert_eq!(assistant_text, full_expected);
}

#[tokio::test]
async fn permission_and_question_responses_deduplicate_across_host_and_runtime_recorder() {
    let pool = setup_pool().await;
    let prompt_id = AgentPromptId::new();
    let (conversation_id, turn_id) =
        seed_conversation_turn(&pool, &prompt_id.to_string(), "interaction dedup").await;
    let mut recorder = test_recorder(pool.clone());

    let permission_id = Uuid::new_v4();
    let host_perm_event = ConversationEvent::PermissionResponded {
        permission_id: permission_id.to_string(),
        response: agents::conversation::ConversationPermissionResponse {
            response: agents::AgentPermissionResponse::Cancelled,
            auto: false,
        },
    };
    let host_perm_json = serde_json::to_string(&host_perm_event).unwrap();
    let host_perm_key =
        format!("conversation:{conversation_id}:permission:{permission_id}:responded");
    crate::projection::ConversationEventAppender::append(
        &pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "host",
            event_kind: "permission_responded",
            normalized_json: &host_perm_json,
            raw_json: None,
            idempotency_key: Some(&host_perm_key),
        },
    )
    .await
    .expect("append host permission response");

    let runtime_perm_env = AgentEventEnvelope {
        sequence: 50,
        workspace_id: Uuid::new_v4(),
        connection_id: AgentConnectionId::new(),
        session_id: Some(AgentSessionId(conversation_id)),
        event: AgentEvent::PermissionResponded {
            permission_id: agents::AgentPermissionId(permission_id),
            response: agents::AgentPermissionResponse::Cancelled,
            auto: false,
        },
        created_at: Utc::now(),
    };
    recorder
        .record(&runtime_perm_env)
        .await
        .expect("record runtime permission response");

    let perm_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_events WHERE conversation_id = ? AND event_kind = 'permission_responded'",
    )
    .bind(conversation_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(perm_count, 1);

    let question_id = Uuid::new_v4();
    let host_q_event = ConversationEvent::QuestionResponded {
        question_id: question_id.to_string(),
        response: agents::conversation::ConversationQuestionResponse {
            answer: "Cancel".to_string(),
            content: None,
        },
    };
    let host_q_json = serde_json::to_string(&host_q_event).unwrap();
    let host_q_key = format!("conversation:{conversation_id}:question:{question_id}:responded");
    crate::projection::ConversationEventAppender::append(
        &pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "host",
            event_kind: "question_responded",
            normalized_json: &host_q_json,
            raw_json: None,
            idempotency_key: Some(&host_q_key),
        },
    )
    .await
    .expect("append host question response");

    let runtime_q_env = AgentEventEnvelope {
        sequence: 51,
        workspace_id: Uuid::new_v4(),
        connection_id: AgentConnectionId::new(),
        session_id: Some(AgentSessionId(conversation_id)),
        event: AgentEvent::ElicitationResponded {
            elicitation_id: agents::AgentElicitationId(question_id),
            response: agents::AgentElicitationResponse::Cancel,
        },
        created_at: Utc::now(),
    };
    recorder
        .record(&runtime_q_env)
        .await
        .expect("record runtime question response");

    let q_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_events WHERE conversation_id = ? AND event_kind = 'question_responded'",
    )
    .bind(conversation_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(q_count, 1);
}

#[tokio::test]
async fn repeated_session_load_failures_do_not_reemit_binding_events() {
    let pool = setup_pool().await;
    let prompt_id = AgentPromptId::new();
    let (conversation_id, _turn_id) =
        seed_conversation_turn(&pool, &prompt_id.to_string(), "expired session").await;
    let mut recorder = test_recorder(pool.clone());

    let first = AgentEventEnvelope {
        sequence: 10,
        workspace_id: Uuid::new_v4(),
        connection_id: AgentConnectionId::new(),
        session_id: Some(AgentSessionId(conversation_id)),
        event: AgentEvent::SessionLoadFailed {
            reason: agents::conversation::SessionLoadFailureReason::ResourceNotFound,
        },
        created_at: Utc::now(),
    };
    let first_batch = recorder.record(&first).await.expect("first load failure");
    assert_eq!(first_batch.events.len(), 1);

    let second = AgentEventEnvelope {
        sequence: 11,
        workspace_id: first.workspace_id,
        connection_id: AgentConnectionId::new(),
        session_id: Some(AgentSessionId(conversation_id)),
        event: AgentEvent::SessionLoadFailed {
            reason: agents::conversation::SessionLoadFailureReason::ResourceNotFound,
        },
        created_at: Utc::now(),
    };
    let second_batch = recorder.record(&second).await.expect("second load failure");
    assert!(second_batch.events.is_empty());
}

#[tokio::test]
async fn late_cancelled_prompt_finished_does_not_cancel_next_queued_turn() {
    let pool = setup_pool().await;
    let prompt_1 = AgentPromptId::new();
    let prompt_2 = AgentPromptId::new();
    let (conversation_id, turn_1) =
        seed_conversation_turn(&pool, &prompt_1.to_string(), "first turn").await;
    ConversationTurnRecord::mark_cancelled(&pool, turn_1, Some("user cancelled"))
        .await
        .expect("cancel turn 1");

    let turn_2 = ConversationTurnRecord::create_pending(
        &pool,
        Uuid::new_v4(),
        CreateConversationTurn {
            conversation_id,
            prompt_id: Some(&prompt_2.to_string()),
            text_preview: Some("queued turn"),
            input_blocks_json: "[]",
        },
    )
    .await
    .expect("create turn 2")
    .id;
    ConversationTurnRecord::mark_running(&pool, turn_2)
        .await
        .expect("mark turn 2 running");
    ConversationRecord::update_active_turn(&pool, conversation_id, Some(turn_2))
        .await
        .expect("set active turn to turn 2");

    let mut recorder = test_recorder(pool.clone());
    let late_cancel = AgentEventEnvelope {
        sequence: 20,
        workspace_id: Uuid::new_v4(),
        connection_id: AgentConnectionId::new(),
        session_id: Some(AgentSessionId(conversation_id)),
        event: AgentEvent::PromptFinished {
            finished: agents::AgentPromptFinished {
                prompt_id: prompt_1,
                stop_reason: Some("cancelled".to_string()),
                usage: None,
            },
        },
        created_at: Utc::now(),
    };

    let batch = recorder
        .record(&late_cancel)
        .await
        .expect("record late PromptFinished");
    assert!(batch.events.is_empty());

    let turn_2_record = ConversationTurnRecord::find_by_id(&pool, turn_2)
        .await
        .expect("fetch turn 2")
        .expect("turn 2 exists");
    assert_eq!(turn_2_record.status, "running");
}
