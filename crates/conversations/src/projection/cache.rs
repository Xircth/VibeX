use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex, OnceLock},
};

use agents::conversation::{
    ContentBlock, ConversationEvent, ConversationRowOp, ConversationSessionNotice,
    ConversationTimeline, ConversationTimelineRow, SessionStats, TimelineRow, TimelineTextStream,
    TurnRole, TurnUsage, cap_content_blocks, cap_timeline_preview_fields,
    cap_timeline_row_preview_fields,
};
use db::models::{
    conversation_event::ConversationEventRecord,
    conversation_snapshot::ConversationProjectionSnapshotRecord,
    conversation_timeline_row::{ConversationTimelineRowRecord, NewConversationTimelineRow},
};
use sqlx::{Executor, Sqlite, SqliteConnection, SqlitePool};
use tokio::{sync::Mutex, time::Instant};
use uuid::Uuid;

use super::{
    AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID, AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
    CONVERSATION_PROJECTION_VERSION, ConversationProjector, ConversationRowWindow,
    OpenConversationProjection, ParsedEvent, ProjectionFold, ProjectionSnapshotState,
    conversation_event_from_record, emit_captured_internal_message,
    fold::{ProjectedTurn, append_thinking_block, ensure_turn},
    rows::{message_row, message_rows},
};

pub(super) enum TouchedTurnRows {
    All(Uuid),
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
            Some(TouchedTurnRows::All(turn_id)) => {
                if let Some(turn) = self.turns.get(&turn_id) {
                    for mut row in message_rows(turn) {
                        cap_timeline_row_preview_fields(&mut row);
                        ops.push(ConversationRowOp::Upsert { row });
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
    side_rows.retain(|row| row.row_id != row_id);
    side_rows.push(TimelineRow {
        row_id: row_id.into(),
        revision: sequence,
        row: ConversationTimelineRow::SessionNotice { notice },
    });
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
const MAX_CACHED_ROW_PROJECTORS: usize = 32;

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
    /// When in-memory deltas have passed the SQLite sequence, the event is
    /// renumbered so the fold does not drop it.
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
        let mut folded = record.clone();
        if folded.sequence <= self.projector.last_sequence() {
            folded.sequence = self.projector.last_sequence().saturating_add(1);
        }
        Ok(Some(self.projector.apply(&folded)?))
    }

    /// Fold one transcript delta. The database cursor stays put.
    pub fn apply_unpersisted(
        &mut self,
        record: &ConversationEventRecord,
    ) -> Result<Vec<ConversationRowOp>, sqlx::Error> {
        self.sync_if_rebuilt(record.conversation_id);
        let mut folded = record.clone();
        folded.sequence = self.projector.last_sequence().saturating_add(1);
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
/// whenever a full-row `Upsert` or `Delete` supersedes them within the same batch.
pub fn extend_coalesced_row_ops(
    ops: &mut Vec<ConversationRowOp>,
    new_ops: impl IntoIterator<Item = ConversationRowOp>,
) {
    for op in new_ops {
        match &op {
            ConversationRowOp::Upsert { row } => {
                ops.retain(|existing| row_op_target_id(existing) != row.row_id);
            }
            ConversationRowOp::Delete { row_id, .. } => {
                ops.retain(|existing| row_op_target_id(existing) != row_id);
            }
            ConversationRowOp::AppendText { .. } | ConversationRowOp::PatchBlocks { .. } => {}
        }
        ops.push(op);
    }
}

/// Per-conversation cache of live incremental projectors (消灭双投影). Owned by the
/// host's application state and fed through a single publish path.
pub type ConversationRowProjectors = Arc<Mutex<HashMap<Uuid, CachedRowProjector>>>;

/// Trim the projector cache to [`MAX_CACHED_ROW_PROJECTORS`], never evicting the
/// conversation that just published.
///
/// Eviction is by least recent use rather than on turn settle: settle is the busiest
/// moment on the publish path, so dropping the projector there guaranteed a cold
/// reload — and a full replay of the turn's events — exactly when several publishers
/// were racing to emit the terminal row op.
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
                Ok(ProjectionFold::from_snapshot_state(state))
            }
            _ => Ok(ProjectionFold::default()),
        }
    }

    pub(crate) async fn persist_fold_to_pool(
        pool: &SqlitePool,
        conversation_id: Uuid,
        fold: &ProjectionFold,
    ) -> Result<(), sqlx::Error> {
        let mut conn = pool.acquire().await?;
        Self::persist_snapshot(&mut conn, conversation_id, fold).await
    }

    pub(super) async fn persist_snapshot(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        fold: &ProjectionFold,
    ) -> Result<(), sqlx::Error> {
        let rows = fold.timeline_rows();
        let session_stats_json = fold
            .session_stats()
            .map(|stats| serde_json::to_string(&stats))
            .transpose()
            .map_err(json_decode_error)?;
        let fold_json =
            serde_json::to_string(&fold.to_snapshot_state()).map_err(json_decode_error)?;
        let encoded: Vec<(i64, String, i64, String)> = rows
            .iter()
            .enumerate()
            .map(|(index, row)| {
                serde_json::to_string(row)
                    .map(|row_json| (index as i64, row.row_id.clone(), row.revision, row_json))
                    .map_err(json_decode_error)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let stored: Vec<NewConversationTimelineRow<'_>> = encoded
            .iter()
            .map(
                |(sort_index, row_id, revision, row_json)| NewConversationTimelineRow {
                    sort_index: *sort_index,
                    row_id,
                    revision: *revision,
                    row_json,
                },
            )
            .collect();
        ConversationTimelineRowRecord::replace_all(conn, conversation_id, &stored).await?;
        ConversationProjectionSnapshotRecord::upsert(
            &mut *conn,
            conversation_id,
            CONVERSATION_PROJECTION_VERSION as i64,
            fold.last_sequence,
            &fold_json,
            rows.len() as i64,
            session_stats_json.as_deref(),
        )
        .await
    }

    pub(super) async fn try_materialized_open(
        pool: &SqlitePool,
        conversation_id: Uuid,
        limit: usize,
    ) -> Result<Option<OpenConversationProjection>, sqlx::Error> {
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
        let bounded = limit.max(1) as i64;
        let records =
            ConversationTimelineRowRecord::list_tail(pool, conversation_id, bounded).await?;
        let expected = snapshot.total_rows.min(bounded);
        if records.len() as i64 != expected {
            return Ok(None);
        }
        let rows = decode_timeline_row_records(&records)?;
        let truncated = snapshot.total_rows > rows.len() as i64;
        let start = snapshot.total_rows.saturating_sub(rows.len() as i64);
        let mut timeline = ConversationTimeline {
            conversation_id,
            projection_version: CONVERSATION_PROJECTION_VERSION,
            last_sequence: snapshot.last_sequence,
            rows,
            truncated_from_start: truncated,
            older_cursor: truncated.then(|| start.to_string()),
        };
        cap_timeline_preview_fields(&mut timeline);
        let session_stats = decode_session_stats(snapshot.session_stats_json.as_deref())?;
        Ok(Some(OpenConversationProjection {
            timeline,
            session_stats,
        }))
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

fn decode_session_stats(json: Option<&str>) -> Result<Option<SessionStats>, sqlx::Error> {
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
#[path = "cache_tests.rs"]
mod tests;
