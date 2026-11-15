use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex as StdMutex, OnceLock},
};

use agents::conversation::{
    ContentBlock, ConversationEvent, ConversationRowOp, ConversationSessionNotice,
    ConversationTimelineRow, SessionStats, TimelineRow, TimelineTextStream, TurnRole, TurnUsage,
    cap_content_blocks, cap_timeline_row_preview_fields,
};
use db::models::{
    conversation_event::ConversationEventRecord,
    conversation_snapshot::ConversationProjectionSnapshotRecord,
    conversation_timeline_row::ConversationTimelineRowRecord,
};
use sqlx::{Executor, Sqlite, SqliteConnection, SqlitePool};
use tokio::{sync::Mutex, time::Instant};
use uuid::Uuid;

use super::{
    AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID, AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
    CONVERSATION_PROJECTION_VERSION, ConversationProjector, ConversationRowWindow, ParsedEvent,
    ProjectionFold, ProjectionSnapshotState, TurnMetricsSummary, conversation_event_from_record,
    emit_captured_internal_message,
    fold::{ProjectedTurn, append_thinking_block, ensure_turn},
    rows::{message_row, message_rows},
    session_stats_from_metrics, summarize_turn_metrics,
};

pub(super) enum TouchedTurnRows {
    ChangedAt(Uuid, i64),
    AssistantOnly(Uuid),
}

pub(super) enum AssistantEmit {
    Full,
    Patch {
        blocks: Vec<ContentBlock>,
        usage: Option<TurnUsage>,
    },
}

impl ProjectionFold {
    pub(super) fn apply_streaming_delta(
        &mut self,
        record: &ConversationEventRecord,
        event: &ConversationEvent,
        text: &str,
    ) -> Vec<ConversationRowOp> {
        let turn_id = self
            .resolved_turn_id(record)
            .unwrap_or(record.conversation_id);
        let stream = if matches!(event, ConversationEvent::AssistantReasoningDelta { .. }) {
            TimelineTextStream::Reasoning
        } else {
            TimelineTextStream::Text
        };
        ensure_turn(&mut self.turns, &mut self.turn_order, turn_id, record);
        let turn: &mut ProjectedTurn = self.turns.get_mut(&turn_id).expect("turn exists");
        if let ConversationEvent::AssistantTextDelta {
            message_id: Some(message_id),
            ..
        } = &event
            && turn.assistant.agent_message_id.is_none()
        {
            turn.assistant.agent_message_id = Some(message_id.clone());
        }
        match stream {
            TimelineTextStream::Text => {
                if !turn.assistant.blocks.is_empty()
                    && !matches!(
                        turn.assistant.blocks.last(),
                        Some(ContentBlock::Text { .. })
                    )
                {
                    turn.trailing_raw_text.clear();
                    turn.emitted_internal_count = 0;
                }
                let prev_visible = match turn.assistant.blocks.last() {
                    Some(ContentBlock::Text { text }) => text.to_string(),
                    _ => String::new(),
                };
                turn.trailing_raw_text.push_str(text);
                let extracted = agents::extract_and_strip_internal_messages(
                    &turn.trailing_raw_text,
                    Some(record.conversation_id),
                    Some(turn_id),
                    true,
                );
                for captured in extracted
                    .captured
                    .iter()
                    .skip(turn.emitted_internal_count)
                    .cloned()
                {
                    emit_captured_internal_message(captured);
                }
                turn.emitted_internal_count = extracted.captured.len();

                if !extracted.visible_text.is_empty() {
                    if let Some(ContentBlock::Text { text: existing }) =
                        turn.assistant.blocks.last_mut()
                    {
                        *existing = extracted.visible_text.to_string();
                    } else {
                        turn.assistant.blocks.push(ContentBlock::Text {
                            text: extracted.visible_text.to_string(),
                        });
                    }
                }

                let visible_delta = extracted
                    .visible_text
                    .strip_prefix(&prev_visible)
                    .unwrap_or(&extracted.visible_text)
                    .to_string();
                turn.revision = record.sequence;
                let mut ops = Vec::new();
                if !visible_delta.is_empty() {
                    ops.push(ConversationRowOp::AppendText {
                        row_id: turn.assistant.id.clone(),
                        revision: record.sequence,
                        stream,
                        delta: visible_delta,
                    });
                }
                if turn.assistant.usage.is_some() && !turn.usage_announced {
                    ops.push(ConversationRowOp::PatchBlocks {
                        row_id: turn.assistant.id.clone(),
                        revision: record.sequence,
                        phase: turn.phase.clone(),
                        blocks: Vec::new(),
                        usage: turn.assistant.usage.clone(),
                    });
                    turn.usage_announced = true;
                }
                return ops;
            }
            TimelineTextStream::Reasoning => {
                turn.trailing_raw_text.clear();
                turn.emitted_internal_count = 0;
                append_thinking_block(&mut turn.assistant.blocks, text.to_string())
            }
        }
        turn.revision = record.sequence;
        let mut ops = vec![ConversationRowOp::AppendText {
            row_id: turn.assistant.id.clone(),
            revision: record.sequence,
            stream,
            delta: text.to_string(),
        }];
        // A usage sample that landed before any block is already on the fold.
        // The first text delta is the moment the live assistant row appears,
        // so the token count has to ride along or the footer never sees it.
        if turn.assistant.usage.is_some() && !turn.usage_announced {
            ops.push(ConversationRowOp::PatchBlocks {
                row_id: turn.assistant.id.clone(),
                revision: record.sequence,
                phase: turn.phase.clone(),
                blocks: Vec::new(),
                usage: turn.assistant.usage.clone(),
            });
            turn.usage_announced = true;
        }
        ops
    }

    pub(super) fn collect_step_row_ops(
        &self,
        sequence: i64,
        deleted_rows: Vec<ConversationRowOp>,
        touched_turn_rows: Option<TouchedTurnRows>,
        assistant_emit: Option<AssistantEmit>,
    ) -> Vec<ConversationRowOp> {
        let mut ops = deleted_rows;
        match touched_turn_rows {
            Some(TouchedTurnRows::ChangedAt(turn_id, changed_seq)) => {
                if let Some(turn) = self.turns.get(&turn_id) {
                    for mut row in message_rows(turn) {
                        if row.revision == changed_seq {
                            cap_timeline_row_preview_fields(&mut row);
                            ops.push(ConversationRowOp::Upsert { row });
                        }
                    }
                }
            }
            Some(TouchedTurnRows::AssistantOnly(turn_id)) => {
                if let Some(turn) = self.turns.get(&turn_id) {
                    match assistant_emit {
                        Some(AssistantEmit::Patch { mut blocks, usage })
                            if !blocks.is_empty() || usage.is_some() =>
                        {
                            cap_content_blocks(&mut blocks);
                            ops.push(ConversationRowOp::PatchBlocks {
                                row_id: turn.assistant.id.clone(),
                                revision: turn.revision,
                                phase: turn.phase.clone(),
                                blocks,
                                usage,
                            });
                        }
                        _ if !turn.assistant.blocks.is_empty() => {
                            let mut row = message_row(turn, TurnRole::Assistant);
                            cap_timeline_row_preview_fields(&mut row);
                            ops.push(ConversationRowOp::Upsert { row });
                        }
                        _ => {}
                    }
                }
            }
            None => {}
        }
        for row in &self.side_rows {
            if row.revision == sequence {
                let mut row = row.clone();
                cap_timeline_row_preview_fields(&mut row);
                ops.push(ConversationRowOp::Upsert { row });
            }
        }
        ops
    }
}

pub(super) fn upsert_stable_notice(
    side_rows: &mut Vec<TimelineRow>,
    row_id: &str,
    sequence: i64,
    notice: ConversationSessionNotice,
) {
    if let Some(existing) = side_rows.iter_mut().find(|row| row.row_id == row_id) {
        existing.revision = sequence;
        existing.row = ConversationTimelineRow::SessionNotice { notice };
    } else {
        side_rows.push(TimelineRow {
            row_id: row_id.into(),
            revision: sequence,
            row: ConversationTimelineRow::SessionNotice { notice },
        });
    }
}

pub(super) fn clear_session_connect_notices(
    side_rows: &mut Vec<TimelineRow>,
    deleted_rows: &mut Vec<ConversationRowOp>,
    sequence: i64,
) {
    remove_side_row(
        side_rows,
        deleted_rows,
        AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
        sequence,
    );
    remove_side_row(
        side_rows,
        deleted_rows,
        AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
        sequence,
    );
}

pub(super) fn remove_side_row(
    side_rows: &mut Vec<TimelineRow>,
    deleted_rows: &mut Vec<ConversationRowOp>,
    row_id: &str,
    sequence: i64,
) {
    if side_rows.iter().any(|row| row.row_id == row_id) {
        side_rows.retain(|row| row.row_id != row_id);
        deleted_rows.push(ConversationRowOp::Delete {
            row_id: row_id.into(),
            revision: sequence,
        });
    }
}

pub(super) async fn antigravity_conversation<'e, E>(
    executor: E,
    conversation_id: Uuid,
) -> Result<bool, sqlx::Error>
where
    E: Executor<'e, Database = Sqlite>,
{
    let agent_id: Option<String> = sqlx::query_scalar(
        r#"SELECT agent_id FROM conversation_agent_bindings
           WHERE conversation_id = ?
           ORDER BY created_at DESC
           LIMIT 1"#,
    )
    .bind(conversation_id)
    .fetch_optional(executor)
    .await?;
    Ok(agent_id.as_deref() == Some("antigravity"))
}

struct RebuiltProjectorEntry {
    generation: u64,
    fold: ProjectionFold,
}

static REBUILT_PROJECTOR_STATES: OnceLock<StdMutex<HashMap<Uuid, RebuiltProjectorEntry>>> =
    OnceLock::new();

pub(super) fn record_rebuilt_projector_fold(conversation_id: Uuid, fold: &ProjectionFold) {
    let mut map = REBUILT_PROJECTOR_STATES
        .get_or_init(|| StdMutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let next_gen = map
        .get(&conversation_id)
        .map(|entry| entry.generation.saturating_add(1))
        .unwrap_or(1);
    if map.len() >= 64
        && !map.contains_key(&conversation_id)
        && let Some(first_key) = map.keys().next().copied()
    {
        map.remove(&first_key);
    }
    map.insert(
        conversation_id,
        RebuiltProjectorEntry {
            generation: next_gen,
            fold: fold.clone(),
        },
    );
}

fn current_projector_generation(conversation_id: Uuid) -> u64 {
    REBUILT_PROJECTOR_STATES
        .get()
        .and_then(|lock| {
            lock.lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(&conversation_id)
                .map(|entry| entry.generation)
        })
        .unwrap_or(0)
}

fn is_turn_terminal_event_record(record: &ConversationEventRecord) -> bool {
    matches!(
        record.event_kind.as_str(),
        "turn_completed" | "turn_failed" | "turn_cancelled" | "turn_interrupted"
    ) || matches!(
        conversation_event_from_record(record),
        ParsedEvent::Known(
            ConversationEvent::TurnCompleted { .. }
                | ConversationEvent::TurnFailed { .. }
                | ConversationEvent::TurnCancelled { .. }
                | ConversationEvent::TurnInterrupted { .. }
        )
    )
}

/// A live, per-conversation incremental projector: it holds the folded state in
/// memory and turns each newly-appended event into row ops via [`ProjectionFold::apply`]
/// — the O(1)-amortized realtime path that eliminates the double projection. One
/// instance is cached per active conversation (dropped on close);
/// `emit_conversation_row_ops_after` in the Tauri layer feeds it in sequence order.
pub struct IncrementalRowProjector {
    fold: ProjectionFold,
    generation: u64,
}

impl IncrementalRowProjector {
    /// A projector positioned exactly at `up_to_sequence` (snapshot + replay of every
    /// event ≤ up_to, without emitting), ready to fold newer events into ops.
    pub async fn load(
        pool: &SqlitePool,
        conversation_id: Uuid,
        up_to_sequence: i64,
    ) -> Result<Self, sqlx::Error> {
        let generation = current_projector_generation(conversation_id);
        let mut fold =
            ConversationProjector::load_fold_from_snapshot(pool, conversation_id).await?;
        // A snapshot ahead of the cursor (e.g. after a truncate/retry rewind) can't be
        // reused — rebuild from the event log.
        if fold.last_sequence > up_to_sequence {
            fold = ProjectionFold::default();
        }
        fold.complete_antigravity_reads = antigravity_conversation(pool, conversation_id).await?;
        if up_to_sequence > fold.last_sequence {
            let tail = ConversationEventRecord::events_since(
                pool,
                conversation_id,
                fold.last_sequence,
                i64::MAX,
            )
            .await?;
            for record in &tail {
                if record.sequence <= up_to_sequence {
                    fold.apply(record)?;
                }
            }
        }
        Ok(Self { fold, generation })
    }

    /// Fold one newly-appended event and return the row ops it produced.
    pub fn apply(
        &mut self,
        record: &ConversationEventRecord,
    ) -> Result<Vec<ConversationRowOp>, sqlx::Error> {
        self.fold.apply(record)
    }

    pub fn last_sequence(&self) -> i64 {
        self.fold.last_sequence
    }

    /// Fold every durable event, including ones written after the snapshot.
    pub async fn load_through_latest(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Self, sqlx::Error> {
        let max_sequence = ConversationEventRecord::max_sequence(pool, conversation_id).await?;
        Self::load(pool, conversation_id, max_sequence).await
    }
}

///
/// `db_cursor` is the last SQLite sequence folded into this process. Transcript
/// deltas advance `projector.last_sequence()` without moving `db_cursor`, so the
/// next durable event (turn completed, checkpoint) is still applied.
const MAX_CACHED_ROW_PROJECTORS: usize = 96;
const MAX_WRITE_PROJECTORS: usize = 96;

pub struct CachedRowProjector {
    pub projector: IncrementalRowProjector,
    pub last_emitted_sequence: i64,
    pub db_cursor: i64,
    has_unpersisted: bool,
    last_used: Instant,
    generation: u64,
}

impl CachedRowProjector {
    pub fn new(projector: IncrementalRowProjector) -> Self {
        let last_emitted_sequence = projector.last_sequence();
        let generation = projector.generation;
        Self {
            projector,
            last_emitted_sequence,
            db_cursor: last_emitted_sequence,
            has_unpersisted: false,
            last_used: Instant::now(),
            generation,
        }
    }

    pub fn touch(&mut self) {
        self.last_used = Instant::now();
    }

    pub fn has_unpersisted(&self) -> bool {
        self.has_unpersisted
    }

    /// Synchronize with the latest rebuilt/truncated state if `truncate_to_turn_ordinal`
    /// or `rebuild_projection` ran since this projector was initialized.
    pub fn sync_if_rebuilt(&mut self, conversation_id: Uuid) -> bool {
        let Some(lock) = REBUILT_PROJECTOR_STATES.get() else {
            return false;
        };
        let map = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(entry) = map.get(&conversation_id) else {
            return false;
        };
        if entry.generation <= self.generation {
            return false;
        }
        self.projector.fold = entry.fold.clone();
        self.projector.generation = entry.generation;
        self.db_cursor = self.projector.last_sequence();
        self.last_emitted_sequence = self.db_cursor;
        self.has_unpersisted = false;
        self.generation = entry.generation;
        true
    }

    /// Fold one durable event. `None` means this sequence was already consumed.
    /// Keeps `projector.last_sequence()` aligned with SQLite `record.sequence` so live
    /// row revisions never drift above materialized SQLite revisions.
    pub fn apply_persisted(
        &mut self,
        record: &ConversationEventRecord,
    ) -> Result<Option<Vec<ConversationRowOp>>, sqlx::Error> {
        self.sync_if_rebuilt(record.conversation_id);
        if record.sequence <= self.db_cursor {
            if matches!(
                conversation_event_from_record(record),
                ParsedEvent::Known(ConversationEvent::UserTurnCreated { .. })
            ) {
                self.db_cursor = record.sequence.saturating_sub(1);
                self.last_emitted_sequence = self.db_cursor;
            } else {
                return Ok(None);
            }
        }
        self.db_cursor = record.sequence;
        if is_turn_terminal_event_record(record) {
            self.has_unpersisted = false;
        }
        self.projector.fold.last_sequence = record.sequence;
        let mut folded = record.clone();
        folded.sequence = record.sequence;
        Ok(Some(self.projector.apply(&folded)?))
    }

    /// Fold one transcript delta without advancing `db_cursor` or inflating live row
    /// revisions past the current SQLite sequence watermark.
    pub fn apply_unpersisted(
        &mut self,
        record: &ConversationEventRecord,
    ) -> Result<Vec<ConversationRowOp>, sqlx::Error> {
        self.sync_if_rebuilt(record.conversation_id);
        let mut folded = record.clone();
        folded.sequence = self.projector.last_sequence().max(self.db_cursor).max(1);
        self.has_unpersisted = true;
        self.projector.apply(&folded)
    }
}

fn row_op_target_id(op: &ConversationRowOp) -> &str {
    match op {
        ConversationRowOp::Upsert { row } => &row.row_id,
        ConversationRowOp::Delete { row_id, .. } => row_id,
        ConversationRowOp::AppendText { row_id, .. } => row_id,
        ConversationRowOp::PatchBlocks { row_id, .. } => row_id,
    }
}

/// Append `new_ops` into `ops`, coalescing redundant earlier ops for the same `row_id`
/// whenever a full-row `Upsert` or `Delete` supersedes them within the same batch, and
/// merging consecutive `AppendText` deltas on the same `(row_id, stream)`.
pub fn extend_coalesced_row_ops(
    ops: &mut Vec<ConversationRowOp>,
    new_ops: impl IntoIterator<Item = ConversationRowOp>,
) {
    for op in new_ops {
        match op {
            ConversationRowOp::Upsert { row } => {
                ops.retain(|existing| row_op_target_id(existing) != row.row_id);
                ops.push(ConversationRowOp::Upsert { row });
            }
            ConversationRowOp::Delete { row_id, revision } => {
                ops.retain(|existing| row_op_target_id(existing) != row_id);
                ops.push(ConversationRowOp::Delete { row_id, revision });
            }
            ConversationRowOp::AppendText {
                row_id,
                revision,
                stream,
                delta,
            } => {
                if let Some(ConversationRowOp::AppendText {
                    row_id: prev_id,
                    revision: prev_rev,
                    stream: prev_stream,
                    delta: prev_delta,
                }) = ops.last_mut()
                    && *prev_id == row_id
                    && *prev_stream == stream
                {
                    prev_delta.push_str(&delta);
                    *prev_rev = revision;
                } else {
                    ops.push(ConversationRowOp::AppendText {
                        row_id,
                        revision,
                        stream,
                        delta,
                    });
                }
            }
            ConversationRowOp::PatchBlocks { .. } => {
                ops.push(op);
            }
        }
    }
}

/// Per-conversation cache of live incremental projectors (消灭双投影). Owned by the
/// host's application state and fed through a single publish path.
pub type ConversationRowProjectors = Arc<Mutex<HashMap<Uuid, CachedRowProjector>>>;

/// Trim the projector cache to [`MAX_CACHED_ROW_PROJECTORS`], never evicting the
/// conversation that just published.
pub fn evict_least_recently_used_projectors(
    cache: &mut HashMap<Uuid, CachedRowProjector>,
    keep: Uuid,
) {
    while cache.len() > MAX_CACHED_ROW_PROJECTORS {
        let Some(oldest) = cache
            .iter()
            .filter(|(id, entry)| **id != keep && !entry.has_unpersisted)
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(id, _)| *id)
        else {
            return;
        };
        cache.remove(&oldest);
    }
}

#[derive(Clone)]
pub(crate) struct WriteSideProjectorState {
    pub(super) fold: ProjectionFold,
    pub(super) turn_ordinals: HashMap<Uuid, i64>,
    pub(super) turn_metrics: BTreeMap<Uuid, TurnMetricsSummary>,
    pub(super) loaded_turns: HashSet<Uuid>,
    pub(super) full_history_loaded: bool,
    pub(super) initial_prompt: Option<String>,
    pub(super) last_used: std::time::Instant,
}

static WRITE_SIDE_PROJECTORS: OnceLock<StdMutex<HashMap<Uuid, WriteSideProjectorState>>> =
    OnceLock::new();

fn write_side_projectors() -> &'static StdMutex<HashMap<Uuid, WriteSideProjectorState>> {
    WRITE_SIDE_PROJECTORS.get_or_init(|| StdMutex::new(HashMap::new()))
}

pub(crate) fn evict_write_projector(conversation_id: Uuid) {
    if let Some(lock) = WRITE_SIDE_PROJECTORS.get() {
        lock.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&conversation_id);
    }
}

pub(super) fn sync_write_projector_on_rebuild(conversation_id: Uuid, fold: &ProjectionFold) {
    let mut map = write_side_projectors()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Drop any cached state so the next write reloads fresh turn_ordinals + fold cleanly,
    // or if already cached, replace fold/metrics and clear stale turn_ordinals.
    map.remove(&conversation_id);
    let _ = fold;
}

pub(crate) fn commit_write_projector_states(
    states: HashMap<Uuid, WriteSideProjectorState>,
) {
    if states.is_empty() {
        return;
    }
    let mut map = write_side_projectors()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = std::time::Instant::now();
    let keep_ids: HashSet<Uuid> = states.keys().copied().collect();
    for (cid, mut state) in states {
        state.last_used = now;
        map.insert(cid, state);
    }
    while map.len() > MAX_WRITE_PROJECTORS {
        let candidate = map
            .iter()
            .filter(|(id, _)| !keep_ids.contains(id))
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(id, _)| *id)
            .or_else(|| {
                map.iter()
                    .min_by_key(|(_, entry)| entry.last_used)
                    .map(|(id, _)| *id)
            });
        let Some(evict_id) = candidate else {
            break;
        };
        map.remove(&evict_id);
    }
}

async fn load_turn_ordinals_on_conn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
) -> Result<HashMap<Uuid, i64>, sqlx::Error> {
    let rows: Vec<(Uuid, i64)> =
        sqlx::query_as("SELECT id, ordinal FROM conversation_turns WHERE conversation_id = ?")
            .bind(conversation_id)
            .fetch_all(&mut *conn)
            .await?;
    Ok(rows.into_iter().collect())
}

pub(crate) async fn get_or_load_write_projector_on_conn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    before_sequence: i64,
) -> Result<WriteSideProjectorState, sqlx::Error> {
    let prev_max_seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sequence), 0) FROM conversation_events WHERE conversation_id = ? AND sequence < ?",
    )
    .bind(conversation_id)
    .bind(before_sequence)
    .fetch_one(&mut *conn)
    .await?;

    if let Some(cached) = write_side_projectors()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&conversation_id)
        .cloned()
        && cached.fold.last_sequence == prev_max_seq
    {
        return Ok(cached);
    }

    let complete_antigravity_reads = antigravity_conversation(&mut *conn, conversation_id).await?;
    let initial_prompt = sqlx::query_scalar::<_, Option<String>>(
        "SELECT initial_prompt FROM sessions WHERE id = ?",
    )
    .bind(conversation_id)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    let turn_ordinals = load_turn_ordinals_on_conn(&mut *conn, conversation_id).await?;

    if prev_max_seq == 0 {
        return Ok(WriteSideProjectorState {
            fold: ProjectionFold {
                complete_antigravity_reads,
                ..ProjectionFold::default()
            },
            turn_ordinals,
            turn_metrics: BTreeMap::new(),
            loaded_turns: HashSet::new(),
            full_history_loaded: true,
            initial_prompt,
            last_used: std::time::Instant::now(),
        });
    }

    if let Some(snapshot) = ConversationProjectionSnapshotRecord::find(&mut *conn, conversation_id)
        .await?
        .filter(|s| {
            s.projection_version == CONVERSATION_PROJECTION_VERSION as i64
                && s.last_sequence == prev_max_seq
        })
        && let Ok(snap_state) = serde_json::from_str::<ProjectionSnapshotState>(&snapshot.fold_json)
    {
        if snap_state.full_fold {
            let snap_metrics = snap_state.turn_metrics.clone();
            let mut fold = ProjectionFold::from_snapshot_state(snap_state);
            fold.complete_antigravity_reads = complete_antigravity_reads;
            let turn_metrics = if snap_metrics.is_empty() {
                fold.collect_turn_metrics()
            } else {
                snap_metrics
            };
            let loaded_turns = fold.turns.keys().copied().collect();
            return Ok(WriteSideProjectorState {
                fold,
                turn_ordinals,
                turn_metrics,
                loaded_turns,
                full_history_loaded: true,
                initial_prompt,
                last_used: std::time::Instant::now(),
            });
        }
        let mut ordered_turns: Vec<(i64, Uuid)> =
            turn_ordinals.iter().map(|(&id, &ord)| (ord, id)).collect();
        ordered_turns.sort_by_key(|(ord, _)| *ord);
        let fold = ProjectionFold {
            turn_order: ordered_turns.into_iter().map(|(_, id)| id).collect(),
            side_rows: snap_state.side_rows,
            side_row_turns: snap_state.side_row_turns,
            last_sequence: snap_state.last_sequence,
            auto_permission_approvals: snap_state.auto_permission_approvals,
            complete_antigravity_reads,
            ..ProjectionFold::default()
        };
        return Ok(WriteSideProjectorState {
            fold,
            turn_ordinals,
            turn_metrics: snap_state.turn_metrics,
            loaded_turns: HashSet::new(),
            full_history_loaded: false,
            initial_prompt,
            last_used: std::time::Instant::now(),
        });
    }

    // Snapshot missing or behind `prev_max_seq` (e.g. raw event insert in tests): replay
    // prior events once and backfill materialized rows before applying the new event.
    let prior_events =
        ConversationEventRecord::events_since(&mut *conn, conversation_id, 0, i64::MAX).await?;
    let mut fold = ProjectionFold {
        complete_antigravity_reads,
        ..ProjectionFold::default()
    };
    for ev in &prior_events {
        if ev.sequence < before_sequence {
            fold.apply(ev)?;
        }
    }
    if turn_ordinals.is_empty() && !fold.turns.is_empty() {
        fold.seed_user_prompt_from_session(conversation_id, initial_prompt.as_deref());
    }
    ConversationProjector::persist_snapshot(&mut *conn, conversation_id, &fold).await?;
    let _ = crate::search::reindex_timeline_rows_on_conn(
        &mut *conn,
        conversation_id,
        &fold.timeline_rows(),
    )
    .await;
    let turn_metrics = fold.collect_turn_metrics();
    let loaded_turns = fold.turns.keys().copied().collect();
    Ok(WriteSideProjectorState {
        fold,
        turn_ordinals,
        turn_metrics,
        loaded_turns,
        full_history_loaded: true,
        initial_prompt,
        last_used: std::time::Instant::now(),
    })
}

fn target_turn_id_for_record(
    state: &WriteSideProjectorState,
    record: &ConversationEventRecord,
) -> Option<Uuid> {
    if let Some(turn_id) = record.turn_id {
        return Some(turn_id);
    }
    match conversation_event_from_record(record) {
        ParsedEvent::Known(ConversationEvent::ConversationSteering { event }) => match event {
            agents::ConversationSteeringEvent::Requested {
                expected_turn_id, ..
            }
            | agents::ConversationSteeringEvent::Accepted {
                expected_turn_id, ..
            }
            | agents::ConversationSteeringEvent::Rejected {
                expected_turn_id, ..
            }
            | agents::ConversationSteeringEvent::Unknown {
                expected_turn_id, ..
            } => Some(expected_turn_id),
        },
        ParsedEvent::Known(
            ConversationEvent::AssistantTextDelta { .. }
            | ConversationEvent::AssistantReasoningDelta { .. }
            | ConversationEvent::AssistantContentAppended { .. }
            | ConversationEvent::ToolCallUpsert { .. }
            | ConversationEvent::UsageUpdated { .. }
            | ConversationEvent::TurnCompleted { .. }
            | ConversationEvent::TurnCancelled { .. }
            | ConversationEvent::TurnFailed { .. },
        ) => state
            .fold
            .turn_order
            .last()
            .copied()
            .or_else(|| {
                state
                    .turn_ordinals
                    .iter()
                    .max_by_key(|(_, ord)| *ord)
                    .map(|(id, _)| *id)
            })
            .or(Some(record.conversation_id)),
        _ => None,
    }
}

async fn ensure_turn_loaded_on_conn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    state: &mut WriteSideProjectorState,
    record: &ConversationEventRecord,
) -> Result<(), sqlx::Error> {
    if state.full_history_loaded {
        return Ok(());
    }
    let Some(turn_id) = target_turn_id_for_record(state, record) else {
        return Ok(());
    };
    if state.loaded_turns.contains(&turn_id) {
        return Ok(());
    }

    let turn_events =
        ConversationEventRecord::events_for_turn(&mut *conn, conversation_id, turn_id).await?;
    let min_turn_seq = turn_events
        .iter()
        .filter(|ev| ev.sequence < record.sequence)
        .map(|ev| ev.sequence)
        .min();

    if let Some(min_seq) = min_turn_seq {
        let tail = ConversationEventRecord::events_since(
            &mut *conn,
            conversation_id,
            min_seq.saturating_sub(1),
            i64::MAX,
        )
        .await?;
        let mut temp_fold = ProjectionFold {
            complete_antigravity_reads: state.fold.complete_antigravity_reads,
            ..ProjectionFold::default()
        };
        for ev in &tail {
            if ev.sequence < record.sequence
                && (ev.turn_id == Some(turn_id) || ev.turn_id.is_none())
            {
                temp_fold.apply(ev)?;
            }
        }
        if let Some(reconstructed) = temp_fold.turns.remove(&turn_id) {
            if !state.fold.turn_order.contains(&turn_id) {
                state.fold.turn_order.push(turn_id);
            }
            state.fold.turns.insert(turn_id, reconstructed);
        }
    } else if turn_id == conversation_id && state.turn_ordinals.is_empty() {
        let tail =
            ConversationEventRecord::events_since(&mut *conn, conversation_id, 0, i64::MAX).await?;
        let mut temp_fold = ProjectionFold {
            complete_antigravity_reads: state.fold.complete_antigravity_reads,
            ..ProjectionFold::default()
        };
        for ev in &tail {
            if ev.sequence < record.sequence && ev.turn_id.is_none() {
                temp_fold.apply(ev)?;
            }
        }
        if let Some(reconstructed) = temp_fold.turns.remove(&turn_id) {
            if !state.fold.turn_order.contains(&turn_id) {
                state.fold.turn_order.push(turn_id);
            }
            state.fold.turns.insert(turn_id, reconstructed);
        }
    }

    state.loaded_turns.insert(turn_id);
    Ok(())
}

async fn resolve_turn_ordinal_on_conn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    turn_ordinals: &mut HashMap<Uuid, i64>,
    turn_id: Uuid,
) -> Result<i64, sqlx::Error> {
    if let Some(ord) = turn_ordinals.get(&turn_id).copied() {
        return Ok(ord);
    }
    if let Some(ord) =
        sqlx::query_scalar::<_, i64>("SELECT ordinal FROM conversation_turns WHERE id = ?")
            .bind(turn_id)
            .fetch_optional(&mut *conn)
            .await?
    {
        turn_ordinals.insert(turn_id, ord);
        return Ok(ord);
    }
    let existing_slot: Option<i64> = sqlx::query_scalar(
        "SELECT sort_index / 1000000 FROM conversation_timeline_rows WHERE conversation_id = ? AND (row_id = ? OR row_id = ?) LIMIT 1",
    )
    .bind(conversation_id)
    .bind(format!("{turn_id}:user"))
    .bind(format!("{turn_id}:assistant"))
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(slot) = existing_slot.filter(|s| *s >= 1) {
        turn_ordinals.insert(turn_id, slot);
        return Ok(slot);
    }
    let max_db_slot: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_index), 0) / 1000000 FROM conversation_timeline_rows WHERE conversation_id = ?",
    )
    .bind(conversation_id)
    .fetch_one(&mut *conn)
    .await?;
    let max_mem = turn_ordinals.values().copied().max().unwrap_or(0);
    let synthetic = max_db_slot.max(max_mem) + 1;
    turn_ordinals.insert(turn_id, synthetic);
    Ok(synthetic)
}

fn find_row_in_fold(fold: &ProjectionFold, row_id: &str) -> Option<TimelineRow> {
    if let Some((prefix, _)) = row_id.split_once(':')
        && let Ok(turn_id) = Uuid::parse_str(prefix)
        && let Some(turn) = fold.turns.get(&turn_id)
    {
        return message_rows(turn).into_iter().find(|r| r.row_id == row_id);
    }
    fold.side_rows.iter().find(|r| r.row_id == row_id).cloned()
}

async fn row_turn_ordinal_on_conn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    fold: &ProjectionFold,
    turn_ordinals: &mut HashMap<Uuid, i64>,
    row_id: &str,
) -> Result<Option<i64>, sqlx::Error> {
    if let Some(side) = fold.side_rows.iter().find(|r| r.row_id == row_id) {
        return match fold.side_row_turn_id(side) {
            Some(turn_id) => Ok(Some(
                resolve_turn_ordinal_on_conn(conn, conversation_id, turn_ordinals, turn_id).await?,
            )),
            None => Ok(None),
        };
    }
    if let Some((prefix, _)) = row_id.split_once(':')
        && let Ok(turn_id) = Uuid::parse_str(prefix)
    {
        let ord =
            resolve_turn_ordinal_on_conn(conn, conversation_id, turn_ordinals, turn_id).await?;
        return Ok(Some(ord));
    }
    Ok(None)
}

pub(crate) async fn apply_and_persist_incremental_on_conn(
    conn: &mut SqliteConnection,
    state: &mut WriteSideProjectorState,
    record: &ConversationEventRecord,
) -> Result<(), sqlx::Error> {
    let cid = record.conversation_id;
    ensure_turn_loaded_on_conn(conn, cid, state, record).await?;
    let ops = state.fold.apply(record)?;

    if state.turn_ordinals.is_empty()
        && !state.fold.turns.is_empty()
        && !state.fold.turns.values().any(|t| !t.user.blocks.is_empty())
    {
        state
            .fold
            .seed_user_prompt_from_session(cid, state.initial_prompt.as_deref());
        if let Some(&first_turn_id) = state.fold.turn_order.first() {
            let user_row_id = format!("{first_turn_id}:user");
            if let Some(mut seeded_user) = find_row_in_fold(&state.fold, &user_row_id) {
                cap_timeline_row_preview_fields(&mut seeded_user);
                let ord = resolve_turn_ordinal_on_conn(
                    conn,
                    cid,
                    &mut state.turn_ordinals,
                    first_turn_id,
                )
                .await?;
                let row_json = serde_json::to_string(&seeded_user).map_err(json_decode_error)?;
                ConversationTimelineRowRecord::upsert_row_on_conn(
                    conn,
                    cid,
                    Some(ord),
                    &seeded_user.row_id,
                    seeded_user.revision,
                    &row_json,
                )
                .await?;
                let _ =
                    crate::search::upsert_fts_from_timeline_row_on_conn(conn, cid, &seeded_user)
                        .await;
            }
        }
    }

    let fold_turn_ids = state.fold.turn_order.clone();
    for turn_id in fold_turn_ids {
        let ord = resolve_turn_ordinal_on_conn(conn, cid, &mut state.turn_ordinals, turn_id).await?;
        if let Some(turn) = state.fold.turns.get(&turn_id) {
            match summarize_turn_metrics(turn, ord) {
                Some(summary) => {
                    state.turn_metrics.insert(turn_id, summary);
                }
                None => {
                    state.turn_metrics.remove(&turn_id);
                }
            }
        }
    }

    for op in &ops {
        match op {
            ConversationRowOp::Delete { row_id, revision } => {
                ConversationTimelineRowRecord::soft_delete_row_on_conn(conn, cid, row_id, *revision)
                    .await?;
                if let Err(error) = crate::search::delete_fts_row_on_conn(conn, cid, row_id).await {
                    tracing::warn!("conversation FTS delete failed: {error}");
                }
            }
            ConversationRowOp::Upsert { row } => {
                let mut full_row =
                    find_row_in_fold(&state.fold, &row.row_id).unwrap_or_else(|| row.clone());
                cap_timeline_row_preview_fields(&mut full_row);
                let turn_ordinal = row_turn_ordinal_on_conn(
                    conn,
                    cid,
                    &state.fold,
                    &mut state.turn_ordinals,
                    &full_row.row_id,
                )
                .await?;
                let row_json = serde_json::to_string(&full_row).map_err(json_decode_error)?;
                ConversationTimelineRowRecord::upsert_row_on_conn(
                    conn,
                    cid,
                    turn_ordinal,
                    &full_row.row_id,
                    full_row.revision,
                    &row_json,
                )
                .await?;
                if matches!(full_row.row, ConversationTimelineRow::MessageTurn { .. })
                    && let Err(error) =
                        crate::search::upsert_fts_from_timeline_row_on_conn(conn, cid, &full_row)
                            .await
                {
                    tracing::warn!("conversation FTS upsert failed: {error}");
                }
            }
            ConversationRowOp::AppendText { row_id, .. }
            | ConversationRowOp::PatchBlocks { row_id, .. } => {
                if let Some(mut full_row) = find_row_in_fold(&state.fold, row_id) {
                    cap_timeline_row_preview_fields(&mut full_row);
                    let turn_ordinal = row_turn_ordinal_on_conn(
                        conn,
                        cid,
                        &state.fold,
                        &mut state.turn_ordinals,
                        &full_row.row_id,
                    )
                    .await?;
                    let row_json = serde_json::to_string(&full_row).map_err(json_decode_error)?;
                    ConversationTimelineRowRecord::upsert_row_on_conn(
                        conn,
                        cid,
                        turn_ordinal,
                        &full_row.row_id,
                        full_row.revision,
                        &row_json,
                    )
                    .await?;
                }
            }
        }
    }

    Ok(())
}

pub(crate) async fn flush_write_projector_snapshot_on_conn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    state: &WriteSideProjectorState,
) -> Result<(), sqlx::Error> {
    let total_rows = ConversationTimelineRowRecord::count(&mut *conn, conversation_id).await?;
    let session_stats_json = session_stats_from_metrics(&state.turn_metrics)
        .map(|stats| serde_json::to_string(&stats))
        .transpose()
        .map_err(json_decode_error)?;
    let fold_json = serde_json::to_string(
        &state
            .fold
            .to_lightweight_snapshot_state(&state.turn_metrics),
    )
    .map_err(json_decode_error)?;
    ConversationProjectionSnapshotRecord::upsert(
        &mut *conn,
        conversation_id,
        CONVERSATION_PROJECTION_VERSION as i64,
        state.fold.last_sequence,
        &fold_json,
        total_rows,
        session_stats_json.as_deref(),
    )
    .await
}

impl ConversationProjector {
    pub(super) async fn load_fold_from_snapshot<'e, E>(
        executor: E,
        conversation_id: Uuid,
    ) -> Result<ProjectionFold, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        match ConversationProjectionSnapshotRecord::find(executor, conversation_id).await? {
            Some(snapshot)
                if snapshot.projection_version == CONVERSATION_PROJECTION_VERSION as i64 =>
            {
                let state: ProjectionSnapshotState =
                    serde_json::from_str(&snapshot.fold_json).map_err(json_decode_error)?;
                if state.full_fold {
                    Ok(ProjectionFold::from_snapshot_state(state))
                } else {
                    Ok(ProjectionFold::default())
                }
            }
            _ => Ok(ProjectionFold::default()),
        }
    }

    pub(super) async fn persist_snapshot(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        fold: &ProjectionFold,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "DELETE FROM conversation_timeline_rows WHERE conversation_id = ? AND deleted_sequence IS NULL",
        )
        .bind(conversation_id)
        .execute(&mut *conn)
        .await?;

        let mut turn_ordinals = load_turn_ordinals_on_conn(&mut *conn, conversation_id).await?;
        for mut row in fold.timeline_rows() {
            cap_timeline_row_preview_fields(&mut row);
            let turn_ordinal = row_turn_ordinal_on_conn(
                &mut *conn,
                conversation_id,
                fold,
                &mut turn_ordinals,
                &row.row_id,
            )
            .await?;
            let row_json = serde_json::to_string(&row).map_err(json_decode_error)?;
            ConversationTimelineRowRecord::upsert_row_on_conn(
                &mut *conn,
                conversation_id,
                turn_ordinal,
                &row.row_id,
                row.revision,
                &row_json,
            )
            .await?;
        }

        let total_rows = ConversationTimelineRowRecord::count(&mut *conn, conversation_id).await?;
        let session_stats_json = fold
            .session_stats()
            .map(|stats| serde_json::to_string(&stats))
            .transpose()
            .map_err(json_decode_error)?;
        let fold_json =
            serde_json::to_string(&fold.to_snapshot_state()).map_err(json_decode_error)?;
        ConversationProjectionSnapshotRecord::upsert(
            &mut *conn,
            conversation_id,
            CONVERSATION_PROJECTION_VERSION as i64,
            fold.last_sequence,
            &fold_json,
            total_rows,
            session_stats_json.as_deref(),
        )
        .await
    }

    pub(super) async fn try_materialized_window(
        pool: &SqlitePool,
        conversation_id: Uuid,
        start: usize,
        limit: usize,
    ) -> Result<Option<ConversationRowWindow>, sqlx::Error> {
        let Some(snapshot) = Self::usable_snapshot(pool, conversation_id).await? else {
            return Ok(None);
        };
        if snapshot.total_rows <= 0 {
            return Ok(None);
        }
        let latest = latest_event_sequence(pool, conversation_id).await?;
        if latest > snapshot.last_sequence {
            return Ok(None);
        }
        let bounded_limit = limit.max(1) as i64;
        let records = ConversationTimelineRowRecord::list_range(
            pool,
            conversation_id,
            start as i64,
            bounded_limit,
        )
        .await?;
        let mut rows = decode_timeline_row_records(&records)?;
        for row in &mut rows {
            cap_timeline_row_preview_fields(row);
        }
        Ok(Some(ConversationRowWindow {
            rows,
            last_sequence: snapshot.last_sequence,
            projection_version: CONVERSATION_PROJECTION_VERSION,
            total_rows: snapshot.total_rows as usize,
        }))
    }

    pub(super) async fn try_materialized_rows_since(
        pool: &SqlitePool,
        conversation_id: Uuid,
        after_sequence: i64,
    ) -> Result<Option<(Vec<TimelineRow>, i64)>, sqlx::Error> {
        let Some(snapshot) = Self::usable_snapshot(pool, conversation_id).await? else {
            return Ok(None);
        };
        if snapshot.total_rows <= 0 {
            return Ok(None);
        }
        let latest = latest_event_sequence(pool, conversation_id).await?;
        if latest > snapshot.last_sequence {
            return Ok(None);
        }
        let records = ConversationTimelineRowRecord::list_changed_since(
            pool,
            conversation_id,
            after_sequence,
        )
        .await?;
        let mut rows = decode_timeline_row_records(&records)?;
        for row in &mut rows {
            cap_timeline_row_preview_fields(row);
        }
        Ok(Some((rows, snapshot.last_sequence)))
    }

    pub(super) async fn usable_snapshot(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Option<ConversationProjectionSnapshotRecord>, sqlx::Error> {
        match ConversationProjectionSnapshotRecord::find(pool, conversation_id).await? {
            Some(snapshot)
                if snapshot.projection_version == CONVERSATION_PROJECTION_VERSION as i64 =>
            {
                Ok(Some(snapshot))
            }
            _ => Ok(None),
        }
    }
}

pub(super) fn json_decode_error(error: serde_json::Error) -> sqlx::Error {
    sqlx::Error::Decode(Box::new(error))
}

pub(super) fn decode_timeline_row_records(
    records: &[ConversationTimelineRowRecord],
) -> Result<Vec<TimelineRow>, sqlx::Error> {
    records
        .iter()
        .map(|record| serde_json::from_str(&record.row_json).map_err(json_decode_error))
        .collect()
}

pub(super) fn decode_session_stats(json: Option<&str>) -> Result<Option<SessionStats>, sqlx::Error> {
    json.map(|value| serde_json::from_str(value).map_err(json_decode_error))
        .transpose()
}

pub(super) async fn latest_event_sequence(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(sequence), 0) FROM conversation_events WHERE conversation_id = ?",
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await
}

#[cfg(test)]
impl IncrementalRowProjector {
    pub(super) fn at_sequence(sequence: i64) -> Self {
        let fold = ProjectionFold {
            last_sequence: sequence,
            ..Default::default()
        };
        Self {
            fold,
            generation: 0,
        }
    }
}

#[cfg(test)]
pub(crate) fn evict_write_projector_for_tests(conversation_id: Uuid) {
    evict_write_projector(conversation_id);
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
