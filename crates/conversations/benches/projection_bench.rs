//! End-to-end SQLite WAL projection, batch-append, dual-pool concurrency, and FTS5 search
//! benchmark suite (`[D10-Backend]` Phase 3 Part C1).
//!
//! Uses a standalone Tokio runtime + percentile harness (`fn main()`) so no extra benchmark
//! crate dependencies are required in `Cargo.toml`.
//!
//! Run with:
//! ```bash
//! cargo bench -p conversations --bench projection_bench
//! ```

use std::time::{Duration, Instant};

use agents::conversation::{ConversationEvent, ConversationInputBlock};
use conversations::{
    projection::{
        BatchConversationEvent, ConversationEventAppender, ConversationProjector,
        OPEN_TIMELINE_ROW_LIMIT,
    },
    search::search_conversations,
};
use db::{DBService, models::conversation_event::AppendConversationEvent};
use sqlx::SqlitePool;
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
struct LatencyStats {
    samples: usize,
    p50: Duration,
    p95: Duration,
    p99: Duration,
    max: Duration,
}

impl LatencyStats {
    fn from_durations(mut samples: Vec<Duration>) -> Self {
        samples.sort_unstable();
        let n = samples.len();
        if n == 0 {
            return Self {
                samples: 0,
                p50: Duration::ZERO,
                p95: Duration::ZERO,
                p99: Duration::ZERO,
                max: Duration::ZERO,
            };
        }
        let idx = |pct: usize| -> usize { ((n * pct).saturating_sub(1) / 100).min(n - 1) };
        Self {
            samples: n,
            p50: samples[idx(50)],
            p95: samples[idx(95)],
            p99: samples[idx(99)],
            max: samples[n - 1],
        }
    }

    fn report(&self, label: &str) {
        println!(
            "{label:<46} | n={:<4} | p50={:>7.3}ms | p95={:>7.3}ms | p99={:>7.3}ms | max={:>7.3}ms",
            self.samples,
            self.p50.as_secs_f64() * 1_000.0,
            self.p95.as_secs_f64() * 1_000.0,
            self.p99.as_secs_f64() * 1_000.0,
            self.max.as_secs_f64() * 1_000.0,
        );
    }
}

async fn insert_session(pool: &SqlitePool, conversation_id: Uuid, workspace_id: Uuid, title: &str) {
    sqlx::query(
        "INSERT INTO sessions (id, workspace_id, name, status, created_at, updated_at) \
         VALUES (?, ?, ?, 'todo', datetime('now'), datetime('now'))",
    )
    .bind(conversation_id)
    .bind(workspace_id)
    .bind(title)
    .execute(pool)
    .await
    .expect("insert benchmark session");
}

fn build_turn_events(conversation_id: Uuid, turn_index: usize) -> Vec<BatchConversationEvent> {
    let turn_id = Uuid::new_v4();
    let user_text = format!(
        "Turn {turn_index} user prompt: investigate SQLite WAL latency and deterministic projection windowing"
    );
    let user_ev = ConversationEvent::UserTurnCreated {
        blocks: vec![ConversationInputBlock::Text { text: user_text }],
        workflow_refs: Vec::new(),
    };
    let user_json = serde_json::to_string(&user_ev).expect("serialize user_ev");

    let mut out = Vec::with_capacity(6);
    out.push(BatchConversationEvent::from_append(
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "user",
            event_kind: "user_turn_created",
            normalized_json: &user_json,
            raw_json: None,
            idempotency_key: None,
        },
    ));

    for chunk_idx in 0..4 {
        let delta = ConversationEvent::AssistantTextDelta {
            text: format!(
                "Chunk {chunk_idx} of turn {turn_index}: keyset cursor pagination keeps open timeline O(1). "
            ),
            message_id: Some(format!("msg-{turn_index}")),
        };
        let delta_json = serde_json::to_string(&delta).expect("serialize delta");
        out.push(BatchConversationEvent::from_append(
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "agent",
                event_kind: "assistant_text_delta",
                normalized_json: &delta_json,
                raw_json: None,
                idempotency_key: None,
            },
        ));
    }

    let completed = ConversationEvent::TurnCompleted {
        stop_reason: Some("end_turn".into()),
    };
    let completed_json = serde_json::to_string(&completed).expect("serialize completed");
    out.push(BatchConversationEvent::from_append(
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "agent",
            event_kind: "turn_completed",
            normalized_json: &completed_json,
            raw_json: None,
            idempotency_key: None,
        },
    ));

    out
}

async fn seed_conversation_with_turns(pool: &SqlitePool, turn_count: usize) -> (Uuid, Uuid) {
    let conversation_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    insert_session(
        pool,
        conversation_id,
        workspace_id,
        &format!("Bench {turn_count} turns"),
    )
    .await;

    let mut pending = Vec::with_capacity(60);
    for turn_idx in 0..turn_count {
        pending.extend(build_turn_events(conversation_id, turn_idx));
        if pending.len() >= 48 {
            ConversationEventAppender::append_batch(pool, &pending)
                .await
                .expect("seed append_batch");
            pending.clear();
        }
    }
    if !pending.is_empty() {
        ConversationEventAppender::append_batch(pool, &pending)
            .await
            .expect("seed final append_batch");
    }
    (conversation_id, workspace_id)
}

async fn bench_open_projection(db: &DBService, iterations: usize) {
    for turn_count in [10usize, 100, 500] {
        let (conv_id, _) = seed_conversation_with_turns(db.writer().as_pool(), turn_count).await;
        let reader_pool = db.reader().as_pool();

        // Warm cache / page cache once.
        let warm =
            ConversationProjector::project_open(reader_pool, conv_id, OPEN_TIMELINE_ROW_LIMIT)
                .await
                .expect("warm project_open");
        assert!(!warm.timeline.rows.is_empty());

        let mut samples = Vec::with_capacity(iterations);
        for _ in 0..iterations {
            let start = Instant::now();
            let open =
                ConversationProjector::project_open(reader_pool, conv_id, OPEN_TIMELINE_ROW_LIMIT)
                    .await
                    .expect("project_open");
            std::hint::black_box(open.timeline.rows.len());
            samples.push(start.elapsed());
        }

        let stats = LatencyStats::from_durations(samples);
        stats.report(&format!("project_open ({turn_count} turns, limit=16)"));
    }
}

async fn bench_append_batch_10_deltas(db: &DBService, iterations: usize) {
    let pool = db.writer().as_pool();
    let conv_id = Uuid::new_v4();
    insert_session(pool, conv_id, Uuid::new_v4(), "Streaming Append Bench").await;

    let turn_id = Uuid::new_v4();
    let user_ev = ConversationEvent::UserTurnCreated {
        blocks: vec![ConversationInputBlock::Text {
            text: "Stream 10-delta batches".into(),
        }],
        workflow_refs: Vec::new(),
    };
    ConversationEventAppender::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id: conv_id,
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
    .expect("seed streaming user turn");

    let mut samples = Vec::with_capacity(iterations);
    for batch_idx in 0..iterations {
        let mut batch = Vec::with_capacity(10);
        for sub_idx in 0..10 {
            let delta = ConversationEvent::AssistantTextDelta {
                text: format!("tok_{batch_idx}_{sub_idx} "),
                message_id: Some("stream-msg".into()),
            };
            let json = serde_json::to_string(&delta).unwrap();
            batch.push(BatchConversationEvent::from_append(
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id: conv_id,
                    turn_id: Some(turn_id),
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source: "agent",
                    event_kind: "assistant_text_delta",
                    normalized_json: &json,
                    raw_json: None,
                    idempotency_key: None,
                },
            ));
        }

        let start = Instant::now();
        let res = ConversationEventAppender::append_batch(pool, &batch)
            .await
            .expect("append_batch 10 deltas");
        assert!(res.failed.is_empty());
        samples.push(start.elapsed());
    }

    LatencyStats::from_durations(samples).report("append_batch (10 streaming deltas)");
}

async fn bench_concurrent_writer_and_4_readers(db: &DBService, batches: usize) {
    let (conv_id, _) = seed_conversation_with_turns(db.writer().as_pool(), 120).await;
    let turn_id = Uuid::new_v4();
    let writer_pool = db.writer().as_pool().clone();

    let writer_handle = tokio::spawn(async move {
        let mut write_samples = Vec::with_capacity(batches);
        for b in 0..batches {
            let mut items = Vec::with_capacity(8);
            for k in 0..8 {
                let delta = ConversationEvent::AssistantTextDelta {
                    text: format!("concurrent_chunk_{b}_{k} "),
                    message_id: Some("conc-msg".into()),
                };
                let json = serde_json::to_string(&delta).unwrap();
                items.push(BatchConversationEvent::from_append(
                    AppendConversationEvent {
                        id: Uuid::new_v4(),
                        conversation_id: conv_id,
                        turn_id: Some(turn_id),
                        binding_id: None,
                        connection_id: None,
                        prompt_id: None,
                        source: "agent",
                        event_kind: "assistant_text_delta",
                        normalized_json: &json,
                        raw_json: None,
                        idempotency_key: None,
                    },
                ));
            }
            let t0 = Instant::now();
            let res = ConversationEventAppender::append_batch(&writer_pool, &items)
                .await
                .expect("concurrent writer append_batch must not SQLITE_BUSY");
            assert!(
                res.failed.is_empty(),
                "concurrent writer encountered item errors: {:?}",
                res.failed
            );
            write_samples.push(t0.elapsed());
            tokio::task::yield_now().await;
        }
        write_samples
    });

    let mut reader_handles = Vec::with_capacity(4);
    for _reader_id in 0..4 {
        let reader_pool = db.reader().as_pool().clone();
        reader_handles.push(tokio::spawn(async move {
            let mut read_samples = Vec::with_capacity(batches);
            for _ in 0..batches {
                let t0 = Instant::now();
                let open = ConversationProjector::project_open(
                    &reader_pool,
                    conv_id,
                    OPEN_TIMELINE_ROW_LIMIT,
                )
                .await
                .expect("concurrent ReadPool project_open must not SQLITE_BUSY");
                std::hint::black_box(open.timeline.last_sequence);
                read_samples.push(t0.elapsed());
                tokio::task::yield_now().await;
            }
            read_samples
        }));
    }

    let write_samples = writer_handle.await.expect("join writer");
    let mut all_read_samples = Vec::new();
    for handle in reader_handles {
        all_read_samples.extend(handle.await.expect("join reader"));
    }

    LatencyStats::from_durations(write_samples)
        .report("concurrent 1W+4R: writer append_batch (0 busy)");
    LatencyStats::from_durations(all_read_samples)
        .report("concurrent 1W+4R: reader project_open (0 busy)");
}

async fn bench_fts_trigram_search(db: &DBService, iterations: usize) {
    // Seed additional conversations so FTS5 spans 1,000+ timeline rows on disk.
    let mut target_ws = Uuid::new_v4();
    for i in 0..5 {
        let (conv_id, ws_id) = seed_conversation_with_turns(db.writer().as_pool(), 60).await;
        if i == 2 {
            target_ws = ws_id;
            let needle_turn = Uuid::new_v4();
            let needle_ev = ConversationEvent::AssistantTextDelta {
                text: "Unique needle token: quantum_wal_checkpoint_hyperdrive_42 verified.".into(),
                message_id: Some("needle-msg".into()),
            };
            ConversationEventAppender::append(
                db.writer().as_pool(),
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id: conv_id,
                    turn_id: Some(needle_turn),
                    binding_id: None,
                    connection_id: None,
                    prompt_id: None,
                    source: "agent",
                    event_kind: "assistant_text_delta",
                    normalized_json: &serde_json::to_string(&needle_ev).unwrap(),
                    raw_json: None,
                    idempotency_key: None,
                },
            )
            .await
            .expect("append needle");
        }
    }

    let mut samples = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let mut conn = db.reader().acquire().await.expect("acquire reader conn");
        let start = Instant::now();
        let hits = search_conversations(
            &mut conn,
            "quantum_wal_checkpoint_hyperdrive_42",
            Some(target_ws),
            20,
        )
        .await
        .expect("fts search_conversations");
        assert_eq!(hits.len(), 1);
        samples.push(start.elapsed());
    }

    LatencyStats::from_durations(samples).report("conversation_fts trigram search (1k+ rows)");
}

fn main() {
    let quick = std::env::args().any(|arg| arg == "--quick");
    let iterations = if quick { 20 } else { 80 };
    let concurrent_batches = if quick { 20 } else { 60 };

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .expect("build benchmark tokio runtime");

    rt.block_on(async move {
        let dir = tempfile::tempdir().expect("create benchmark tempdir");
        let db = DBService::new_at(dir.path())
            .await
            .expect("initialize disk-backed WAL DBService");

        println!("=========================================================================================================");
        println!(" VibeX Conversation Projection & WAL Dual-Pool Benchmark Suite");
        println!("=========================================================================================================");

        bench_open_projection(&db, iterations).await;
        bench_append_batch_10_deltas(&db, iterations).await;
        bench_concurrent_writer_and_4_readers(&db, concurrent_batches).await;
        bench_fts_trigram_search(&db, iterations).await;

        println!("=========================================================================================================");
    });
}
