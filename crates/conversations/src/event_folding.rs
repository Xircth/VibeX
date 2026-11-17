//! Lossless Event Folding for settled historical turns (`[D10-Backend]` Phase 3).
//!
//! Never deletes turns by age. Within settled turns strictly outside [`RECENT_TURN_BUFFER`],
//! contiguous `AssistantTextDelta`, `AssistantReasoningDelta`, and intermediate `ToolCallUpsert`
//! runs are compacted into canonical `ConversationEvent` rows preserving untruncated payloads,
//! monotonic sequences (`last_allocated_sequence`), and cold `ConversationProjector` rebuilds.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use agents::conversation::{ConversationEvent, ConversationToolCallPatch};
use db::{WritePool, models::conversation_event::ConversationEventRecord};
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use tokio::sync::Notify;
use ts_rs::TS;
use uuid::Uuid;

use crate::projection::CONVERSATION_PROJECTION_VERSION;

pub const RECENT_TURN_BUFFER: usize = 50;
pub const DEFAULT_FOLD_INITIAL_DELAY: Duration = Duration::from_secs(5 * 60);
pub const DEFAULT_FOLD_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
pub const FOLDED_EVENT_SOURCE: &str = "system";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum FoldedEventType {
    AssistantText,
    AssistantReasoning,
    ToolProgress,
}

/// Lossless provenance & untruncated payload stored alongside a folded `conversation_events` row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct FoldedEvent {
    #[serde(alias = "folded_type")]
    pub folded_type: FoldedEventType,
    /// Full, untruncated text or JSON payload (not subject to the 32 KiB timeline preview cap).
    #[serde(alias = "full_content")]
    pub full_content: String,
    /// Total number of raw constituent events represented by this folded row.
    #[serde(alias = "event_count")]
    pub event_count: usize,
    #[serde(alias = "first_sequence")]
    pub first_sequence: i64,
    #[serde(alias = "last_sequence")]
    pub last_sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FoldedRawEnvelope {
    folded: bool,
    #[serde(alias = "folded_type")]
    folded_type: FoldedEventType,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "full_content"
    )]
    full_content: Option<String>,
    #[serde(alias = "event_count")]
    event_count: usize,
    #[serde(alias = "first_sequence")]
    first_sequence: i64,
    #[serde(alias = "last_sequence")]
    last_sequence: i64,
}

impl FoldedEvent {
    /// Extract [`FoldedEvent`] provenance and full untruncated payload from a folded record.
    pub fn from_record(record: &ConversationEventRecord) -> Option<Self> {
        let raw = record.raw_json.as_deref()?;
        let env: FoldedRawEnvelope = serde_json::from_str(raw).ok()?;
        if !env.folded {
            return None;
        }
        let full_content = env.full_content.unwrap_or_else(|| {
            match serde_json::from_str::<ConversationEvent>(&record.normalized_json).ok() {
                Some(ConversationEvent::AssistantTextDelta { text, .. })
                | Some(ConversationEvent::AssistantReasoningDelta { text, .. }) => text,
                Some(ConversationEvent::ToolCallUpsert { tool_call }) => {
                    serde_json::to_string(&tool_call).unwrap_or_default()
                }
                _ => record.normalized_json.clone(),
            }
        });
        Some(Self {
            folded_type: env.folded_type,
            full_content,
            event_count: env.event_count,
            first_sequence: env.first_sequence,
            last_sequence: env.last_sequence,
        })
    }
}

/// Summary telemetry returned by [`EventFolder::fold_conversation`] and [`EventFolder::fold_all_settled`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct FoldReport {
    #[serde(alias = "conversations_scanned")]
    pub conversations_scanned: usize,
    #[serde(alias = "events_before")]
    pub events_before: usize,
    #[serde(alias = "events_after")]
    pub events_after: usize,
    #[serde(alias = "bytes_reclaimed")]
    pub bytes_reclaimed: usize,
    #[serde(alias = "fold_operations")]
    pub fold_operations: usize,
}

/// Wire alias matching `frontend/src/lib/dbHealthApi.ts` (`EventFoldReport`).
pub type EventFoldReport = FoldReport;

impl FoldReport {
    fn accumulate(&mut self, other: &FoldReport) {
        self.conversations_scanned = self
            .conversations_scanned
            .saturating_add(other.conversations_scanned);
        self.events_before = self.events_before.saturating_add(other.events_before);
        self.events_after = self.events_after.saturating_add(other.events_after);
        self.bytes_reclaimed = self.bytes_reclaimed.saturating_add(other.bytes_reclaimed);
        self.fold_operations = self.fold_operations.saturating_add(other.fold_operations);
    }
}

#[derive(Debug)]
struct PlannedFoldMutation {
    keep_id: Uuid,
    keep_created_at: chrono::DateTime<chrono::Utc>,
    normalized_json: String,
    raw_json: String,
    delete_ids: Vec<Uuid>,
    bytes_reclaimed: usize,
}

/// Lossless background and on-demand event folder.
pub struct EventFolder;

impl EventFolder {
    /// Fold settled historical turns of `conversation_id` outside [`RECENT_TURN_BUFFER`].
    pub async fn fold_conversation(
        write_pool: &WritePool,
        conversation_id: Uuid,
    ) -> Result<FoldReport, sqlx::Error> {
        Self::fold_conversation_with_buffer(write_pool, conversation_id, RECENT_TURN_BUFFER).await
    }

    /// Fold settled turns of `conversation_id`, keeping the newest `recent_turn_buffer` turns
    /// untouched at raw streaming granularity.
    pub async fn fold_conversation_with_buffer(
        write_pool: &WritePool,
        conversation_id: Uuid,
        recent_turn_buffer: usize,
    ) -> Result<FoldReport, sqlx::Error> {
        fold_conversation_on_pool(write_pool.as_pool(), conversation_id, recent_turn_buffer).await
    }

    /// Scan all conversations with settled turns outside [`RECENT_TURN_BUFFER`] and fold them one
    /// short `BEGIN IMMEDIATE` transaction per conversation, yielding between conversations so
    /// interactive writes never starve.
    pub async fn fold_all_settled(write_pool: &WritePool) -> Result<FoldReport, sqlx::Error> {
        Self::fold_all_settled_with_buffer(write_pool, RECENT_TURN_BUFFER).await
    }

    /// Configurable buffer variant of [`Self::fold_all_settled`].
    pub async fn fold_all_settled_with_buffer(
        write_pool: &WritePool,
        recent_turn_buffer: usize,
    ) -> Result<FoldReport, sqlx::Error> {
        let pool = write_pool.as_pool();
        let min_events_threshold = (recent_turn_buffer as i64).saturating_mul(3).max(2);
        let candidate_ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT conversation_id \
             FROM conversation_events \
             GROUP BY conversation_id \
             HAVING COUNT(*) >= ? \
             ORDER BY MAX(sequence) ASC",
        )
        .bind(min_events_threshold)
        .fetch_all(pool)
        .await?;

        let mut aggregate = FoldReport::default();
        for conversation_id in candidate_ids {
            let single =
                fold_conversation_on_pool(pool, conversation_id, recent_turn_buffer).await?;
            aggregate.accumulate(&single);
            tokio::task::yield_now().await;
        }
        Ok(aggregate)
    }
}

/// Spawn the low-priority periodic event-folding worker (`initial_delay = 5m`, `interval = 6h`).
///
/// Trigger `shutdown.notify_waiters()` (or drop the runtime) to stop the loop cleanly.
pub fn spawn_periodic_event_folding_worker(
    write_pool: WritePool,
    shutdown: Arc<Notify>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(DEFAULT_FOLD_INITIAL_DELAY) => {}
            _ = shutdown.notified() => return,
        }

        loop {
            if let Err(err) = EventFolder::fold_all_settled(&write_pool).await {
                tracing::warn!(error = %err, "periodic event folding sweep failed");
            }

            tokio::select! {
                _ = tokio::time::sleep(DEFAULT_FOLD_INTERVAL) => {}
                _ = shutdown.notified() => break,
            }
        }
    })
}

async fn fold_conversation_on_pool(
    pool: &SqlitePool,
    conversation_id: Uuid,
    recent_turn_buffer: usize,
) -> Result<FoldReport, sqlx::Error> {
    let records: Vec<ConversationEventRecord> = sqlx::query_as(
        r#"SELECT id, conversation_id, turn_id, binding_id, connection_id, prompt_id,
                  sequence, source, event_kind, event_version, normalized_json, raw_json,
                  idempotency_key, created_at
           FROM conversation_events
           WHERE conversation_id = ?
           ORDER BY sequence ASC"#,
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;

    let events_before = records.len();
    if events_before < 2 {
        return Ok(FoldReport {
            conversations_scanned: 1,
            events_before,
            events_after: events_before,
            bytes_reclaimed: 0,
            fold_operations: 0,
        });
    }

    let max_sequence_before = records.iter().map(|r| r.sequence).max().unwrap_or(0);
    let in_flight_turns: HashSet<Uuid> = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM conversation_turns \
         WHERE conversation_id = ? AND status IN ('pending', 'running', 'blocked')",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    let mutations = plan_conversation_folds(&records, &in_flight_turns, recent_turn_buffer);
    if mutations.is_empty() {
        return Ok(FoldReport {
            conversations_scanned: 1,
            events_before,
            events_after: events_before,
            bytes_reclaimed: 0,
            fold_operations: 0,
        });
    }
    drop(records);

    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

    let result = apply_planned_folds_in_tx(
        &mut conn,
        conversation_id,
        recent_turn_buffer,
        events_before,
        max_sequence_before,
        &in_flight_turns,
        &mutations,
    )
    .await;
    match result {
        Ok(report) => {
            sqlx::query("COMMIT").execute(&mut *conn).await?;
            Ok(report)
        }
        Err(err) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(err)
        }
    }
}

async fn apply_planned_folds_in_tx(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    recent_turn_buffer: usize,
    planned_events_before: usize,
    planned_max_sequence: i64,
    planned_in_flight_turns: &HashSet<Uuid>,
    planned_mutations: &[PlannedFoldMutation],
) -> Result<FoldReport, sqlx::Error> {
    let tx_max_sequence: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sequence), 0) FROM conversation_events WHERE conversation_id = ?",
    )
    .bind(conversation_id)
    .fetch_one(&mut *conn)
    .await?;
    let tx_in_flight_turns: HashSet<Uuid> = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM conversation_turns \
         WHERE conversation_id = ? AND status IN ('pending', 'running', 'blocked')",
    )
    .bind(conversation_id)
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect();

    let (events_before, max_sequence_before, recomputed_mutations);
    let mutations: &[PlannedFoldMutation] = if tx_max_sequence == planned_max_sequence
        && tx_in_flight_turns == *planned_in_flight_turns
    {
        events_before = planned_events_before;
        max_sequence_before = planned_max_sequence;
        planned_mutations
    } else {
        let records: Vec<ConversationEventRecord> = sqlx::query_as(
            r#"SELECT id, conversation_id, turn_id, binding_id, connection_id, prompt_id,
                          sequence, source, event_kind, event_version, normalized_json, raw_json,
                          idempotency_key, created_at
                   FROM conversation_events
                   WHERE conversation_id = ?
                   ORDER BY sequence ASC"#,
        )
        .bind(conversation_id)
        .fetch_all(&mut *conn)
        .await?;
        events_before = records.len();
        if events_before < 2 {
            return Ok(FoldReport {
                conversations_scanned: 1,
                events_before,
                events_after: events_before,
                bytes_reclaimed: 0,
                fold_operations: 0,
            });
        }
        max_sequence_before = records.iter().map(|r| r.sequence).max().unwrap_or(0);
        recomputed_mutations =
            plan_conversation_folds(&records, &tx_in_flight_turns, recent_turn_buffer);
        if recomputed_mutations.is_empty() {
            return Ok(FoldReport {
                conversations_scanned: 1,
                events_before,
                events_after: events_before,
                bytes_reclaimed: 0,
                fold_operations: 0,
            });
        }
        &recomputed_mutations
    };

    let mut deleted_total = 0usize;
    let mut bytes_reclaimed = 0usize;
    let fold_operations = mutations.len();

    for mutation in mutations {
        sqlx::query(
            "UPDATE conversation_events \
             SET source = ?, normalized_json = ?, raw_json = ?, created_at = ? \
             WHERE id = ?",
        )
        .bind(FOLDED_EVENT_SOURCE)
        .bind(&mutation.normalized_json)
        .bind(&mutation.raw_json)
        .bind(mutation.keep_created_at)
        .bind(mutation.keep_id)
        .execute(&mut *conn)
        .await?;

        for chunk in mutation.delete_ids.chunks(256) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(", ");
            let delete_sql =
                format!("DELETE FROM conversation_events WHERE id IN ({placeholders})");
            let mut q = sqlx::query(&delete_sql);
            for id in chunk {
                q = q.bind(*id);
            }
            let res = q.execute(&mut *conn).await?;
            deleted_total += res.rows_affected() as usize;
        }
        bytes_reclaimed = bytes_reclaimed.saturating_add(mutation.bytes_reclaimed);
    }

    // Ensure `last_allocated_sequence` never regresses below `max_sequence_before` even if no
    // snapshot row existed prior to folding.
    sqlx::query(
        r#"INSERT INTO conversation_projection_snapshots (
               conversation_id, projection_version, last_sequence, fold_json,
               total_rows, session_stats_json, last_allocated_sequence
           )
           VALUES (?, ?, 0, '{}', 0, NULL, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET
               last_allocated_sequence = MAX(
                   conversation_projection_snapshots.last_allocated_sequence,
                   excluded.last_allocated_sequence
               )"#,
    )
    .bind(conversation_id)
    .bind(i64::from(CONVERSATION_PROJECTION_VERSION))
    .bind(max_sequence_before)
    .execute(&mut *conn)
    .await?;

    Ok(FoldReport {
        conversations_scanned: 1,
        events_before,
        events_after: events_before.saturating_sub(deleted_total),
        bytes_reclaimed,
        fold_operations,
    })
}

fn plan_conversation_folds(
    records: &[ConversationEventRecord],
    in_flight_turns: &HashSet<Uuid>,
    recent_turn_buffer: usize,
) -> Vec<PlannedFoldMutation> {
    let mut turn_order: Vec<Uuid> = Vec::new();
    let mut seen_turns: HashSet<Uuid> = HashSet::new();
    let mut settled_turns: HashSet<Uuid> = HashSet::new();
    let mut parsed_events: Vec<Option<ConversationEvent>> = Vec::with_capacity(records.len());

    let mut active_turn_id: Option<Uuid> = None;
    let mut effective_turn_ids: Vec<Option<Uuid>> = Vec::with_capacity(records.len());

    for record in records {
        if let Some(tid) = record.turn_id {
            active_turn_id = Some(tid);
            if seen_turns.insert(tid) {
                turn_order.push(tid);
            }
        }
        effective_turn_ids.push(record.turn_id.or(active_turn_id));

        let parsed = serde_json::from_str::<ConversationEvent>(&record.normalized_json).ok();
        if let Some(tid) = record.turn_id.or(active_turn_id)
            && let Some(ref ev) = parsed
            && matches!(
                ev,
                ConversationEvent::TurnCompleted { .. }
                    | ConversationEvent::TurnFailed { .. }
                    | ConversationEvent::TurnCancelled { .. }
                    | ConversationEvent::TurnInterrupted { .. }
            )
        {
            settled_turns.insert(tid);
        }
        parsed_events.push(parsed);
    }

    let cutoff = turn_order.len().saturating_sub(recent_turn_buffer);
    let eligible_turns: HashSet<Uuid> = turn_order[..cutoff]
        .iter()
        .copied()
        .filter(|tid| settled_turns.contains(tid) && !in_flight_turns.contains(tid))
        .collect();

    if eligible_turns.is_empty() {
        return Vec::new();
    }

    // Group contiguous record indices by eligible `turn_id` and scan foldable runs within each turn.
    let mut by_turn: HashMap<Uuid, Vec<usize>> = HashMap::new();
    for (idx, maybe_tid) in effective_turn_ids.iter().enumerate() {
        if let Some(tid) = *maybe_tid
            && eligible_turns.contains(&tid)
        {
            by_turn.entry(tid).or_default().push(idx);
        }
    }

    let mut mutations = Vec::new();
    for tid in &turn_order[..cutoff] {
        let Some(indices) = by_turn.get(tid) else {
            continue;
        };
        plan_turn_folds(records, &parsed_events, indices, &mut mutations);
    }
    mutations
}

fn plan_turn_folds(
    records: &[ConversationEventRecord],
    parsed_events: &[Option<ConversationEvent>],
    indices: &[usize],
    mutations: &mut Vec<PlannedFoldMutation>,
) {
    let mut cursor = 0usize;
    while cursor < indices.len() {
        let start_idx = indices[cursor];
        let Some(ref first_ev) = parsed_events[start_idx] else {
            cursor += 1;
            continue;
        };

        match first_ev {
            ConversationEvent::AssistantTextDelta { .. }
            | ConversationEvent::AssistantReasoningDelta { .. } => {
                let is_text = matches!(first_ev, ConversationEvent::AssistantTextDelta { .. });
                let folded_type = if is_text {
                    FoldedEventType::AssistantText
                } else {
                    FoldedEventType::AssistantReasoning
                };
                let mut end = cursor + 1;
                while end < indices.len() && indices[end] == indices[end - 1] + 1 {
                    let same = match parsed_events[indices[end]] {
                        Some(ConversationEvent::AssistantTextDelta { .. }) => is_text,
                        Some(ConversationEvent::AssistantReasoningDelta { .. }) => !is_text,
                        _ => false,
                    };
                    if !same {
                        break;
                    }
                    end += 1;
                }
                if end - cursor >= 2
                    && let Some(m) = build_text_or_reasoning_fold(
                        records,
                        parsed_events,
                        &indices[cursor..end],
                        folded_type,
                    )
                {
                    mutations.push(m);
                }
                cursor = end;
            }
            ConversationEvent::ToolCallUpsert { tool_call } => {
                let target_call_id = &tool_call.tool_call_id;
                let mut end = cursor + 1;
                while end < indices.len() && indices[end] == indices[end - 1] + 1 {
                    let matches_same_call = match &parsed_events[indices[end]] {
                        Some(ConversationEvent::ToolCallUpsert { tool_call: next }) => {
                            &next.tool_call_id == target_call_id
                        }
                        _ => false,
                    };
                    if !matches_same_call {
                        break;
                    }
                    end += 1;
                }
                if end - cursor >= 2 {
                    plan_tool_call_run_fold(
                        records,
                        parsed_events,
                        &indices[cursor..end],
                        mutations,
                    );
                }
                cursor = end;
            }
            _ => {
                cursor += 1;
            }
        }
    }
}

fn record_constituent_count(record: &ConversationEventRecord) -> usize {
    FoldedEvent::from_record(record)
        .map(|f| f.event_count.max(1))
        .unwrap_or(1)
}

fn record_first_sequence(record: &ConversationEventRecord) -> i64 {
    FoldedEvent::from_record(record)
        .map(|f| f.first_sequence)
        .unwrap_or(record.sequence)
}

fn record_storage_bytes(record: &ConversationEventRecord) -> usize {
    record.normalized_json.len() + record.raw_json.as_deref().map_or(0, str::len) + 96
}

fn build_text_or_reasoning_fold(
    records: &[ConversationEventRecord],
    parsed_events: &[Option<ConversationEvent>],
    run_indices: &[usize],
    folded_type: FoldedEventType,
) -> Option<PlannedFoldMutation> {
    let first_rec = &records[*run_indices.first()?];
    let last_rec = &records[*run_indices.last()?];

    let mut full_content = String::new();
    let mut first_message_id: Option<String> = None;
    let mut total_count = 0usize;
    let mut before_bytes = 0usize;

    for &idx in run_indices {
        let rec = &records[idx];
        before_bytes += record_storage_bytes(rec);
        total_count += record_constituent_count(rec);
        match parsed_events[idx].as_ref()? {
            ConversationEvent::AssistantTextDelta { text, message_id }
            | ConversationEvent::AssistantReasoningDelta { text, message_id } => {
                full_content.push_str(text);
                if first_message_id.is_none() && message_id.is_some() {
                    first_message_id = message_id.clone();
                }
            }
            _ => return None,
        }
    }

    let merged_event = match folded_type {
        FoldedEventType::AssistantText => ConversationEvent::AssistantTextDelta {
            text: full_content.clone(),
            message_id: first_message_id,
        },
        FoldedEventType::AssistantReasoning => ConversationEvent::AssistantReasoningDelta {
            text: full_content.clone(),
            message_id: first_message_id,
        },
        FoldedEventType::ToolProgress => return None,
    };

    let normalized_json = serde_json::to_string(&merged_event).ok()?;
    let raw_envelope = FoldedRawEnvelope {
        folded: true,
        folded_type,
        full_content: None,
        event_count: total_count,
        first_sequence: record_first_sequence(first_rec),
        last_sequence: last_rec.sequence,
    };
    let raw_json = serde_json::to_string(&raw_envelope).ok()?;
    let after_bytes = normalized_json.len() + raw_json.len() + 96;
    let delete_ids: Vec<Uuid> = run_indices[..run_indices.len() - 1]
        .iter()
        .map(|&idx| records[idx].id)
        .collect();

    Some(PlannedFoldMutation {
        keep_id: last_rec.id,
        keep_created_at: first_rec.created_at,
        normalized_json,
        raw_json,
        delete_ids,
        bytes_reclaimed: before_bytes.saturating_sub(after_bytes),
    })
}

fn plan_tool_call_run_fold(
    records: &[ConversationEventRecord],
    parsed_events: &[Option<ConversationEvent>],
    run_indices: &[usize],
    mutations: &mut Vec<PlannedFoldMutation>,
) {
    let first_rec = &records[run_indices[0]];
    let last_rec = &records[*run_indices.last().expect("len >= 2")];

    let patches: Vec<&ConversationToolCallPatch> = run_indices
        .iter()
        .filter_map(|&idx| match parsed_events[idx].as_ref() {
            Some(ConversationEvent::ToolCallUpsert { tool_call }) => Some(tool_call),
            _ => None,
        })
        .collect();
    if patches.len() != run_indices.len() {
        return;
    }

    let merged_all = merge_tool_call_patches(&patches);
    let terminal = matches!(
        merged_all.status.as_deref(),
        Some("completed") | Some("failed")
    );

    // If `started_at != ended_at` on a terminal tool call, preserve `first_rec` untouched so
    // cold rebuilds retain exact `started_at` AND `ended_at` timestamps, and fold `[1..]` (>= 2).
    let (fold_slice, keep_created_at, merged_patch) =
        if terminal && first_rec.created_at != last_rec.created_at {
            if run_indices.len() < 3 {
                return;
            }
            (
                &run_indices[1..],
                last_rec.created_at,
                merge_tool_call_patches(&patches[1..]),
            )
        } else {
            (run_indices, first_rec.created_at, merged_all)
        };

    let event = ConversationEvent::ToolCallUpsert {
        tool_call: merged_patch,
    };
    let Ok(normalized_json) = serde_json::to_string(&event) else {
        return;
    };
    let total_count: usize = fold_slice
        .iter()
        .map(|&i| record_constituent_count(&records[i]))
        .sum();
    let before_bytes: usize = fold_slice
        .iter()
        .map(|&i| record_storage_bytes(&records[i]))
        .sum();

    let raw_envelope = FoldedRawEnvelope {
        folded: true,
        folded_type: FoldedEventType::ToolProgress,
        full_content: None,
        event_count: total_count,
        first_sequence: record_first_sequence(&records[fold_slice[0]]),
        last_sequence: last_rec.sequence,
    };
    let Ok(raw_json) = serde_json::to_string(&raw_envelope) else {
        return;
    };
    let after_bytes = normalized_json.len() + raw_json.len() + 96;
    let delete_ids: Vec<Uuid> = fold_slice[..fold_slice.len() - 1]
        .iter()
        .map(|&i| records[i].id)
        .collect();

    mutations.push(PlannedFoldMutation {
        keep_id: last_rec.id,
        keep_created_at,
        normalized_json,
        raw_json,
        delete_ids,
        bytes_reclaimed: before_bytes.saturating_sub(after_bytes),
    });
}

fn merge_tool_call_patches(patches: &[&ConversationToolCallPatch]) -> ConversationToolCallPatch {
    let mut acc = patches[0].clone();
    for patch in &patches[1..] {
        if patch.title.is_some() {
            acc.title = patch.title.clone();
        }
        if patch.kind.is_some() {
            acc.kind = patch.kind.clone();
        }
        if patch.status.is_some() {
            acc.status = patch.status.clone();
        }
        if let Some(ref raw) = patch.raw_input
            && (!raw.as_object().is_some_and(|m| m.is_empty()) || acc.raw_input.is_none())
        {
            acc.raw_input = Some(raw.clone());
        }
        if patch.raw_output.is_some() {
            acc.raw_output = patch.raw_output.clone();
        }
        if let Some(ref append) = patch.raw_output_append {
            acc.raw_output_append
                .get_or_insert_with(String::new)
                .push_str(append);
        }
        if patch.content.is_some() {
            acc.content = patch.content.clone();
        }
        if patch.locations.is_some() {
            acc.locations = patch.locations.clone();
        }
        if patch.metadata.is_some() {
            acc.metadata = patch.metadata.clone();
        }
        if !patch.images.is_empty() {
            acc.images = patch.images.clone();
        }
    }
    acc
}

#[cfg(test)]
mod tests {
    use agents::conversation::{ContentBlock, ConversationInputBlock, ConversationTimelineRow};
    use db::{DBService, models::conversation_event::AppendConversationEvent};

    use super::*;
    use crate::projection::{ConversationEventAppender, ConversationProjector};

    async fn create_test_session(pool: &SqlitePool) -> Uuid {
        let conv_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO sessions (id, workspace_id, name, status, created_at, updated_at) \
             VALUES (?, ?, 'Fold Test', 'todo', datetime('now'), datetime('now'))",
        )
        .bind(conv_id)
        .bind(Uuid::new_v4())
        .execute(pool)
        .await
        .expect("insert session");
        conv_id
    }

    async fn append_ev(
        pool: &SqlitePool,
        conv_id: Uuid,
        turn_id: Option<Uuid>,
        source: &str,
        kind: &str,
        ev: &ConversationEvent,
    ) -> ConversationEventRecord {
        let json = serde_json::to_string(ev).unwrap();
        ConversationEventAppender::append(
            pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id: conv_id,
                turn_id,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source,
                event_kind: kind,
                normalized_json: &json,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append test event")
    }

    async fn append_streaming_turn(
        pool: &SqlitePool,
        conv_id: Uuid,
        chunks: &[&str],
        complete: bool,
    ) -> Uuid {
        let turn_id = Uuid::new_v4();
        let user_ev = ConversationEvent::UserTurnCreated {
            blocks: vec![ConversationInputBlock::Text {
                text: "Hello".into(),
            }],
            workflow_refs: Vec::new(),
        };
        append_ev(
            pool,
            conv_id,
            Some(turn_id),
            "user",
            "user_turn_created",
            &user_ev,
        )
        .await;
        for chunk in chunks {
            let delta = ConversationEvent::AssistantTextDelta {
                text: (*chunk).to_string(),
                message_id: Some("msg-1".into()),
            };
            append_ev(
                pool,
                conv_id,
                Some(turn_id),
                "agent",
                "assistant_text_delta",
                &delta,
            )
            .await;
        }
        if complete {
            let done = ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            };
            append_ev(
                pool,
                conv_id,
                Some(turn_id),
                "agent",
                "turn_completed",
                &done,
            )
            .await;
        }
        turn_id
    }

    #[tokio::test]
    async fn fold_preserves_sequence_continuity() {
        let db = DBService::new_in_memory_for_tests()
            .await
            .expect("in-memory db");
        let pool = db.writer().as_pool();
        let conv_id = create_test_session(pool).await;

        let chunks = vec!["token "; 100];
        append_streaming_turn(pool, conv_id, &chunks, true).await;

        let alloc_before: i64 = sqlx::query_scalar(
            "SELECT last_allocated_sequence FROM conversation_projection_snapshots WHERE conversation_id = ?",
        )
        .bind(conv_id)
        .fetch_one(pool)
        .await
        .expect("alloc_before");
        assert_eq!(alloc_before, 102);

        let report = EventFolder::fold_conversation_with_buffer(db.writer(), conv_id, 0)
            .await
            .expect("fold");
        assert_eq!(report.events_before, 102);
        // 1 UserTurnCreated + 1 folded AssistantTextDelta + 1 TurnCompleted = 3!
        assert_eq!(report.events_after, 3);
        assert_eq!(report.fold_operations, 1);

        let alloc_after: i64 = sqlx::query_scalar(
            "SELECT last_allocated_sequence FROM conversation_projection_snapshots WHERE conversation_id = ?",
        )
        .bind(conv_id)
        .fetch_one(pool)
        .await
        .expect("alloc_after");
        assert_eq!(alloc_after, alloc_before);

        // Next appended event strictly advances to 103.
        let next_rec = append_ev(
            pool,
            conv_id,
            None,
            "user",
            "user_turn_queued",
            &ConversationEvent::UserTurnQueued,
        )
        .await;
        assert_eq!(next_rec.sequence, 103);
    }

    #[tokio::test]
    async fn fold_does_not_touch_unsettled_turns() {
        let db = DBService::new_in_memory_for_tests()
            .await
            .expect("in-memory db");
        let pool = db.writer().as_pool();
        let conv_id = create_test_session(pool).await;

        let chunks = vec!["streaming "; 50];
        append_streaming_turn(pool, conv_id, &chunks, false).await;

        let report = EventFolder::fold_conversation_with_buffer(db.writer(), conv_id, 0)
            .await
            .expect("fold unsettled");
        assert_eq!(report.fold_operations, 0);
        assert_eq!(report.events_before, 51);
        assert_eq!(report.events_after, 51);
    }

    #[tokio::test]
    async fn fold_preserves_full_content() {
        let db = DBService::new_in_memory_for_tests()
            .await
            .expect("in-memory db");
        let pool = db.writer().as_pool();
        let conv_id = create_test_session(pool).await;

        // 100 chunks * 520 bytes = 52,000 bytes (> 32 KiB preview cap!).
        let piece = "A".repeat(520);
        let chunks: Vec<&str> = (0..100).map(|_| piece.as_str()).collect();
        append_streaming_turn(pool, conv_id, &chunks, true).await;

        let report = EventFolder::fold_conversation_with_buffer(db.writer(), conv_id, 0)
            .await
            .expect("fold 50KB");
        assert_eq!(report.events_after, 3);

        let remaining = ConversationEventRecord::events_since(pool, conv_id, 0, i64::MAX)
            .await
            .expect("remaining");
        let folded_row = remaining
            .iter()
            .find(|r| r.source == FOLDED_EVENT_SOURCE)
            .expect("folded row");
        let meta = FoldedEvent::from_record(folded_row).expect("folded metadata");
        assert_eq!(meta.event_count, 100);
        assert_eq!(meta.full_content.len(), 52_000);
    }

    #[tokio::test]
    async fn fold_survives_projection_version_upgrade() {
        let db = DBService::new_in_memory_for_tests()
            .await
            .expect("in-memory db");
        let pool = db.writer().as_pool();
        let conv_id = create_test_session(pool).await;

        let chunks = vec![
            "Hello ",
            "world, ",
            "event ",
            "folding ",
            "is ",
            "lossless!",
        ];
        append_streaming_turn(pool, conv_id, &chunks, true).await;

        let timeline_before = ConversationProjector::project(pool, conv_id)
            .await
            .expect("project before");

        let report = EventFolder::fold_conversation_with_buffer(db.writer(), conv_id, 0)
            .await
            .expect("fold");
        assert_eq!(report.fold_operations, 1);

        // Simulate a projection version bump / cold snapshot wipe.
        sqlx::query("DELETE FROM conversation_projection_snapshots WHERE conversation_id = ?")
            .bind(conv_id)
            .execute(pool)
            .await
            .expect("wipe snapshot");
        sqlx::query("DELETE FROM conversation_timeline_rows WHERE conversation_id = ?")
            .bind(conv_id)
            .execute(pool)
            .await
            .expect("wipe timeline rows");

        let timeline_after = ConversationProjector::project(pool, conv_id)
            .await
            .expect("cold rebuild after fold");
        assert_eq!(timeline_after.rows, timeline_before.rows);
        assert_eq!(timeline_after.last_sequence, timeline_before.last_sequence);

        let assistant_text = timeline_after
            .rows
            .iter()
            .find_map(|r| match &r.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if matches!(turn.role, agents::conversation::TurnRole::Assistant) =>
                {
                    turn.blocks.iter().find_map(|b| match b {
                        ContentBlock::Text { text } => Some(text.clone()),
                        _ => None,
                    })
                }
                _ => None,
            })
            .expect("assistant text");
        assert_eq!(assistant_text, "Hello world, event folding is lossless!");
    }
}
