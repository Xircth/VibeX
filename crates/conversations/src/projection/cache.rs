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
mod tests {
    use agents::conversation::{
        AcpCapabilitySnapshot, ContentBlock, ConversationError, ConversationEvent,
        ConversationInputBlock, ConversationRowOp, ConversationTerminalPatch,
        ConversationTimelineRow, ConversationToolCallPatch, ConversationUsage,
        SessionLoadFailureReason, SessionRecoveryStrategy, TimelineTextStream, TurnRole,
    };
    use db::models::conversation_turn::{ConversationTurnRecord, CreateConversationTurn};
    use uuid::Uuid;

    use super::{CachedRowProjector, IncrementalRowProjector, extend_coalesced_row_ops};
    use crate::projection::{
        AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID, ConversationProjector,
        rows::tests::{append_event, record_of, seed_turn, setup_pool},
    };
    #[test]
    fn unpersisted_delta_does_not_hide_the_next_database_event() {
        let conversation_id = Uuid::new_v4();
        let mut cached = CachedRowProjector::new(IncrementalRowProjector::at_sequence(4));
        cached
            .apply_unpersisted(&record_of(
                conversation_id,
                0,
                ConversationEvent::AssistantTextDelta {
                    text: "hi".into(),
                    message_id: None,
                },
            ))
            .expect("delta");
        assert_eq!(cached.db_cursor, 4);
        assert_eq!(cached.projector.last_sequence(), 5);
        assert!(cached.has_unpersisted());

        cached
            .apply_persisted(&record_of(
                conversation_id,
                5,
                ConversationEvent::TurnCompleted { stop_reason: None },
            ))
            .expect("completed");
        assert_eq!(cached.db_cursor, 5);
        assert_eq!(cached.projector.last_sequence(), 6);
        assert!(!cached.has_unpersisted());
    }

    #[test]
    fn intermediate_persisted_events_do_not_clear_has_unpersisted() {
        let conversation_id = Uuid::new_v4();
        let mut cached = CachedRowProjector::new(IncrementalRowProjector::at_sequence(4));
        cached
            .apply_unpersisted(&record_of(
                conversation_id,
                0,
                ConversationEvent::AssistantTextDelta {
                    text: "streaming".into(),
                    message_id: None,
                },
            ))
            .expect("delta");
        assert!(cached.has_unpersisted());

        cached
            .apply_persisted(&record_of(
                conversation_id,
                5,
                ConversationEvent::UsageUpdated {
                    usage: agents::conversation::ConversationUsage {
                        context_used: Some(128),
                        context_window_max: Some(4096),
                        ..Default::default()
                    },
                },
            ))
            .expect("usage update");
        assert_eq!(cached.db_cursor, 5);
        assert!(
            cached.has_unpersisted(),
            "mid-turn UsageUpdated must not clear has_unpersisted while streaming text is in memory"
        );

        cached
            .apply_persisted(&record_of(
                conversation_id,
                6,
                ConversationEvent::TurnCompleted { stop_reason: None },
            ))
            .expect("completed");
        assert!(!cached.has_unpersisted());
    }

    #[tokio::test]
    async fn cached_row_projector_recovers_after_truncate_to_turn_ordinal() {
        let pool = setup_pool().await;
        let (conversation_id, turn1_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn1_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "first".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        for idx in 2..=9 {
            append_event(
                &pool,
                conversation_id,
                Some(turn1_id),
                "acp",
                ConversationEvent::AssistantTextDelta {
                    text: format!("chunk-{idx} "),
                    message_id: None,
                },
                None,
            )
            .await;
        }
        let turn1_end = append_event(
            &pool,
            conversation_id,
            Some(turn1_id),
            "acp",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;
        assert_eq!(turn1_end.sequence, 10);

        let turn2 = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-2"),
                text_preview: Some("second"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn 2");
        assert_eq!(turn2.ordinal, 2);
        let turn2_id = turn2.id;
        append_event(
            &pool,
            conversation_id,
            Some(turn2_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "second".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        for idx in 12..=19 {
            append_event(
                &pool,
                conversation_id,
                Some(turn2_id),
                "acp",
                ConversationEvent::AssistantTextDelta {
                    text: format!("chunk-{idx} "),
                    message_id: None,
                },
                None,
            )
            .await;
        }
        let turn2_end = append_event(
            &pool,
            conversation_id,
            Some(turn2_id),
            "acp",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;
        assert_eq!(turn2_end.sequence, 20);

        let mut cached = CachedRowProjector::new(
            IncrementalRowProjector::load_through_latest(&pool, conversation_id)
                .await
                .expect("load projector at seq 20"),
        );
        assert_eq!(cached.db_cursor, 20);

        ConversationProjector::truncate_to_turn_ordinal(&pool, conversation_id, 2)
            .await
            .expect("truncate to ordinal 2");

        let turn2_retry = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-2-retry"),
                text_preview: Some("second retry"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn 2 retry");
        let turn2_retry_id = turn2_retry.id;
        let retry_event = append_event(
            &pool,
            conversation_id,
            Some(turn2_retry_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "second retry".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        assert_eq!(retry_event.sequence, 11);

        let ops = cached
            .apply_persisted(&retry_event)
            .expect("apply_persisted succeeds")
            .expect("must not drop sequence 11 after truncation rewind from 20 to 10");
        assert!(!ops.is_empty());
        assert_eq!(cached.db_cursor, 11);
    }

    #[tokio::test]
    async fn successful_load_clears_the_recoverable_load_failure_notice() {
        let pool = setup_pool().await;
        let (conversation_id, _) = seed_turn(&pool).await;

        let load_failure = append_event(
            &pool,
            conversation_id,
            None,
            "acp",
            ConversationEvent::AgentBindingLoadFailed {
                reason: SessionLoadFailureReason::Other {
                    message: "session/load failed: no rollout found".into(),
                },
            },
            None,
        )
        .await;

        let failed_timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project load failure");
        assert!(
            failed_timeline
                .rows
                .iter()
                .any(|row| matches!(row.row, ConversationTimelineRow::SessionNotice { .. }))
        );
        let mut realtime_projector =
            IncrementalRowProjector::load(&pool, conversation_id, load_failure.sequence)
                .await
                .expect("load realtime projector after failure");

        let binding_ready = append_event(
            &pool,
            conversation_id,
            None,
            "acp",
            ConversationEvent::AgentBindingReady {
                acp_session_id: "cold-start-session".into(),
                capabilities: AcpCapabilitySnapshot::default(),
            },
            None,
        )
        .await;
        let ready_ops = realtime_projector
            .apply(&binding_ready)
            .expect("project successful binding in realtime");
        assert!(ready_ops.iter().all(|op| !matches!(
            op,
            ConversationRowOp::Delete { row_id, .. }
                if row_id == AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
        )));

        let recovered = append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentBindingRecovered {
                strategy: SessionRecoveryStrategy::Loaded,
                continues_from: None,
            },
            None,
        )
        .await;
        let ops = realtime_projector
            .apply(&recovered)
            .expect("project successful load recovery");
        assert!(ops.iter().any(|op| matches!(
            op,
            ConversationRowOp::Delete { row_id, .. }
                if row_id == AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
        )));

        let recovered_timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project successful load");
        assert!(
            recovered_timeline
                .rows
                .iter()
                .all(|row| !matches!(row.row, ConversationTimelineRow::SessionNotice { .. }))
        );
    }

    #[tokio::test]
    async fn row_ops_text_deltas_append_and_terminal_upserts_full_row() {
        // 批次C: the realtime protocol. Streaming text → cheap AppendText (row_id +
        // stream + delta + revision), no full row. A non-text/terminal event →
        // Upsert(s) whose revision equals the producing event's sequence, carrying the
        // full folded row (text included) — the same fold as the initial load.
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("projector");

        let created = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "hi".into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        // Creating the turn upserts the user row at the creating sequence.
        let ops = projector.apply(&created).expect("ops");
        assert!(ops.iter().any(|op| matches!(
            op,
            ConversationRowOp::Upsert { row } if row.row_id == format!("{turn_id}:user")
                && row.revision == created.sequence
        )));

        let delta = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "hel".into(),
                message_id: None,
            },
            None,
        )
        .await;
        let ops = projector.apply(&delta).expect("ops");
        assert_eq!(ops.len(), 1, "a text delta emits exactly one AppendText");
        match &ops[0] {
            ConversationRowOp::AppendText {
                row_id,
                revision,
                stream,
                delta: chunk,
            } => {
                assert_eq!(row_id, &format!("{turn_id}:assistant"));
                assert_eq!(*revision, delta.sequence);
                assert!(matches!(stream, TimelineTextStream::Text));
                assert_eq!(chunk, "hel");
            }
            other => panic!("expected AppendText, got {other:?}"),
        }

        let failed = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnFailed {
                error: ConversationError {
                    message: "ACP connection closed".into(),
                    code: Some("connection_closed".into()),
                    raw: None,
                    kind: Default::default(),
                    plan_usage: None,
                },
            },
            None,
        )
        .await;
        let ops = projector.apply(&failed).expect("ops");
        // The terminal event upserts the full assistant row — folded text included —
        // at the terminal sequence, flushing the streamed deltas authoritatively.
        let assistant = ops.iter().find_map(|op| match op {
            ConversationRowOp::Upsert { row } if row.row_id == format!("{turn_id}:assistant") => {
                Some(row)
            }
            _ => None,
        });
        let assistant = assistant.expect("assistant row upserted on turn failure");
        assert_eq!(assistant.revision, failed.sequence);
        match &assistant.row {
            ConversationTimelineRow::MessageTurn { turn, phase, .. } => {
                assert_eq!(phase, "failed");
                assert!(
                    turn.blocks
                        .iter()
                        .any(|block| matches!(block, ContentBlock::Text { text } if text == "hel"))
                );
            }
            other => panic!("expected MessageTurn, got {other:?}"),
        }
    }

    /// Regression: each Turn's stream stays on its own assistant row. Deltas are
    /// attributed by the recorder from the authoritative active-turn pointer, so the
    /// fold must honour `turn_id` verbatim — re-pointing a settled Turn's late tail at
    /// whichever Turn is open produced the reported "用户 A - AI A - 用户 B - AI AB".
    #[tokio::test]
    async fn each_turns_stream_stays_on_its_own_assistant_row() {
        let pool = setup_pool().await;
        let (conversation_id, turn_a) = seed_turn(&pool).await;
        let turn_b = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-2"),
                text_preview: Some("B"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create second turn")
        .id;

        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("projector");

        let created_a = append_event(
            &pool,
            conversation_id,
            Some(turn_a),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "A".into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        projector.apply(&created_a).expect("fold A user");

        let delta_a = append_event(
            &pool,
            conversation_id,
            Some(turn_a),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "answer-A".into(),
                message_id: None,
            },
            None,
        )
        .await;
        projector.apply(&delta_a).expect("fold A assistant");

        let completed_a = append_event(
            &pool,
            conversation_id,
            Some(turn_a),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;
        projector.apply(&completed_a).expect("settle A");

        let created_b = append_event(
            &pool,
            conversation_id,
            Some(turn_b),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "B".into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        projector.apply(&created_b).expect("fold B user");

        let delta_b = append_event(
            &pool,
            conversation_id,
            Some(turn_b),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "answer-B".into(),
                message_id: None,
            },
            None,
        )
        .await;
        let ops = projector.apply(&delta_b).expect("fold B assistant");
        assert!(
            ops.iter().any(|op| matches!(
                op,
                ConversationRowOp::AppendText { row_id, delta, .. }
                    if row_id == &format!("{turn_b}:assistant") && delta == "answer-B"
            )),
            "B's delta must append to B: {ops:?}"
        );
        assert!(
            !ops.iter().any(|op| matches!(
                op,
                ConversationRowOp::AppendText { row_id, .. }
                    if row_id == &format!("{turn_a}:assistant")
            )),
            "B's stream must not grow A's assistant row: {ops:?}"
        );

        // A settled Turn's late-flushed tail belongs to that Turn, not to the Turn
        // that happens to be open.
        let late_tail_a = append_event(
            &pool,
            conversation_id,
            Some(turn_a),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "-tail".into(),
                message_id: None,
            },
            None,
        )
        .await;
        let ops = projector.apply(&late_tail_a).expect("fold A tail");
        assert!(
            ops.iter().any(|op| matches!(
                op,
                ConversationRowOp::AppendText { row_id, delta, .. }
                    if row_id == &format!("{turn_a}:assistant") && delta == "-tail"
            )),
            "A's late tail must stay on A: {ops:?}"
        );

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let assistant_texts: Vec<(String, String)> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    let text = turn
                        .blocks
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<String>();
                    Some((row.row_id.clone(), text))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            assistant_texts,
            vec![
                (format!("{turn_a}:assistant"), "answer-A-tail".into()),
                (format!("{turn_b}:assistant"), "answer-B".into()),
            ]
        );
    }

    #[tokio::test]
    async fn incremental_projector_skips_turn_reemission_on_non_turn_events_and_coalesces_batches()
    {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let user_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "investigate memory".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("load projector");
        let initial_ops = projector.apply(&user_rec).expect("apply user turn");
        assert_eq!(initial_ops.len(), 2);
        assert!(initial_ops.iter().any(|op| matches!(op, ConversationRowOp::Upsert { row } if row.row_id == "status:agent-request")));

        let diag_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::RawDiagnosticRecorded {
                label: "acp_frame".into(),
                payload: Some(serde_json::json!({"ok": true})),
            },
            None,
        )
        .await;
        let diag_ops = projector.apply(&diag_rec).expect("apply diagnostic");
        assert!(
            !diag_ops.iter().any(|op| matches!(
                op,
                ConversationRowOp::Upsert { row }
                    if matches!(row.row, ConversationTimelineRow::MessageTurn { .. })
            )),
            "diagnostic events must not re-emit MessageTurn rows"
        );

        let term_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::TerminalUpdated {
                terminal: ConversationTerminalPatch {
                    terminal_id: "term-1".into(),
                    command: Some("cargo".into()),
                    args: vec!["check".into()],
                    cwd: None,
                    status: "running".into(),
                    output_summary: Some("checking".into()),
                    output_truncated: false,
                    exit_status: None,
                },
            },
            None,
        )
        .await;
        let term_ops = projector.apply(&term_rec).expect("apply terminal");
        assert!(
            term_ops.iter().all(|op| !matches!(
                op,
                ConversationRowOp::Upsert { row }
                    if matches!(row.row, ConversationTimelineRow::MessageTurn { .. })
            )),
            "side-row events must only emit the side row, not re-emit MessageTurn rows"
        );

        let huge_meta = "x".repeat(64 * 1024);
        let tool1 = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "call-1".into(),
                    title: Some("Read".into()),
                    kind: Some("read".into()),
                    status: Some("running".into()),
                    raw_input: Some(serde_json::json!({"path": "main.rs"})),
                    raw_output: None,
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: Some(serde_json::json!({ "blob": huge_meta })),
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;
        let tool2 = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "call-1".into(),
                    title: None,
                    kind: None,
                    status: Some("completed".into()),
                    raw_input: None,
                    raw_output: Some(serde_json::Value::String("y".repeat(64 * 1024))),
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

        let mut coalesced = Vec::new();
        for rec in [&tool1, &tool2] {
            let ops = projector.apply(rec).expect("apply tool");
            // Only the assistant MessageTurn row should be emitted, never the user turn row.
            assert_eq!(ops.len(), 1);
            extend_coalesced_row_ops(&mut coalesced, ops);
        }
        assert_eq!(
            coalesced.len(),
            2,
            "the first tool creates the assistant row; the next tool patches that row"
        );
        match &coalesced[0] {
            ConversationRowOp::Upsert { row } => match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. } => {
                    assert_eq!(turn.role, TurnRole::Assistant);
                    let meta = turn.blocks.iter().find_map(|block| match block {
                        ContentBlock::ToolUse {
                            meta: Some(meta), ..
                        } => Some(meta),
                        _ => None,
                    });
                    let serialized = serde_json::to_string(meta.expect("capped meta")).unwrap();
                    assert!(
                        serialized.len() <= agents::conversation::MAX_TIMELINE_PREVIEW_BYTES + 32,
                        "tool metadata must be capped in live projection"
                    );
                }
                other => panic!("expected MessageTurn, got {other:?}"),
            },
            other => panic!("expected creation Upsert, got {other:?}"),
        }
        match &coalesced[1] {
            ConversationRowOp::PatchBlocks { blocks, .. } => {
                assert!(blocks.iter().all(|block| matches!(
                    block,
                    ContentBlock::ToolUse { .. } | ContentBlock::ToolResult { .. }
                )));
                let preview = blocks.iter().find_map(|block| match block {
                    ContentBlock::ToolResult {
                        output_preview: Some(preview),
                        ..
                    } => Some(preview),
                    _ => None,
                });
                let preview = preview.expect("patched output");
                assert!(
                    preview.len() <= agents::conversation::MAX_TIMELINE_PREVIEW_BYTES + 8,
                    "tool output_preview must be capped in live projection"
                );
            }
            other => panic!("expected PatchBlocks, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn tool_update_after_text_patches_only_the_changed_blocks() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let user_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "look".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("load projector");
        projector.apply(&user_rec).expect("apply user");
        let text_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "hello".into(),
                message_id: None,
            },
            None,
        )
        .await;
        let text_ops = projector.apply(&text_rec).expect("apply text");
        assert!(matches!(
            text_ops.as_slice(),
            [ConversationRowOp::AppendText { .. }]
        ));
        let tool_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "call-9".into(),
                    title: Some("Read".into()),
                    kind: Some("read".into()),
                    status: Some("completed".into()),
                    raw_input: None,
                    raw_output: Some(serde_json::json!("ok")),
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
        let tool_ops = projector.apply(&tool_rec).expect("apply tool");
        match tool_ops.as_slice() {
            [ConversationRowOp::PatchBlocks { blocks, .. }] => {
                assert!(blocks.iter().all(|block| matches!(
                    block,
                    ContentBlock::ToolUse { .. } | ContentBlock::ToolResult { .. }
                )));
                assert!(
                    !blocks
                        .iter()
                        .any(|block| matches!(block, ContentBlock::Text { .. }))
                );
            }
            other => panic!("expected a tool patch, got {other:?}"),
        }
        let usage_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: 3,
                    output_tokens: 4,
                    ..ConversationUsage::default()
                },
            },
            None,
        )
        .await;
        let usage_ops = projector.apply(&usage_rec).expect("apply usage");
        match usage_ops.as_slice() {
            [ConversationRowOp::PatchBlocks { blocks, usage, .. }] => {
                assert!(blocks.is_empty());
                assert_eq!(usage.as_ref().map(|usage| usage.input_tokens), Some(3));
                assert_eq!(usage.as_ref().map(|usage| usage.output_tokens), Some(4));
            }
            other => panic!("expected a usage patch, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn usage_before_the_first_block_is_still_pushed_live() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let user_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "hi".into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("load projector");
        projector.apply(&user_rec).expect("apply user");

        let usage_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: 20,
                    output_tokens: 4,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 70,
                    context_used: Some(18_658),
                    context_window_max: Some(200_000),
                    ..ConversationUsage::default()
                },
            },
            None,
        )
        .await;
        let usage_ops = projector.apply(&usage_rec).expect("apply usage");
        match usage_ops.as_slice() {
            [
                ConversationRowOp::PatchBlocks {
                    blocks,
                    usage,
                    phase,
                    ..
                },
            ] => {
                assert!(blocks.is_empty());
                assert_eq!(phase, "streaming");
                let usage = usage.as_ref().expect("usage");
                assert_eq!(usage.input_tokens, 20);
                assert_eq!(usage.cache_read_input_tokens, 70);
                assert_eq!(usage.context_used, Some(18_658));
            }
            other => panic!("expected a usage patch before any block, got {other:?}"),
        }

        let text_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "hello".into(),
                message_id: None,
            },
            None,
        )
        .await;
        let text_ops = projector.apply(&text_rec).expect("apply text");
        assert!(
            matches!(text_ops.as_slice(), [ConversationRowOp::AppendText { .. }]),
            "a later text delta must not repeat the usage patch, got {text_ops:?}"
        );
    }

    #[tokio::test]
    async fn projector_strips_internal_messages_across_streaming_deltas_and_emits_captured_messages()
     {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let user_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "hi".into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let mut rx = crate::subscribe_internal_messages();
        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("load projector");
        projector.apply(&user_rec).expect("apply user");

        let chunk1 = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "Hello user!\n<vibex-internal-meta channel=\"vibex.memory:extract:n77\">{\"key\":".into(),
                message_id: None,
            },
            None,
        )
        .await;
        projector.apply(&chunk1).expect("apply chunk1");
        assert_eq!(
            projector.fold.turns[&turn_id].assistant.blocks,
            vec![ContentBlock::Text {
                text: "Hello user!\n".into()
            }]
        );
        assert!(rx.try_recv().is_err());

        let chunk2 = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "\"val\"}</vibex-internal-meta>\n\nHow can I help?".into(),
                message_id: None,
            },
            None,
        )
        .await;
        projector.apply(&chunk2).expect("apply chunk2");
        assert_eq!(
            projector.fold.turns[&turn_id].assistant.blocks,
            vec![ContentBlock::Text {
                text: "Hello user!\n\nHow can I help?".into()
            }]
        );
        let captured = rx.try_recv().expect("captured internal message");
        assert_eq!(captured.plugin_id, "vibex.memory");
        assert_eq!(captured.channel, "vibex.memory:extract:n77");
        assert_eq!(captured.nonce, "n77");
        assert_eq!(captured.parsed_payload, serde_json::json!({"key": "val"}));
    }

    #[tokio::test]
    async fn projector_handles_multibyte_utf8_streaming_deltas_without_panicking() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let user_rec = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "你好".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let mut projector = IncrementalRowProjector::load(&pool, conversation_id, 0)
            .await
            .expect("load projector");
        projector.apply(&user_rec).expect("apply user");

        // Exact crash sequence: 27-byte Chinese + ASCII text delta ("这个报错是模型 ID ")
        let chunk = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "这个报错是模型 ID ".into(),
                message_id: None,
            },
            None,
        )
        .await;
        let ops = projector.apply(&chunk).expect("apply multibyte chunk");
        assert_eq!(
            ops,
            vec![ConversationRowOp::AppendText {
                row_id: format!("{turn_id}:assistant"),
                revision: chunk.sequence,
                stream: TimelineTextStream::Text,
                delta: "这个报错是模型 ID ".into(),
            }]
        );
        assert_eq!(
            projector.fold.turns[&turn_id].assistant.blocks,
            vec![ContentBlock::Text {
                text: "这个报错是模型 ID ".into()
            }]
        );
    }

    #[tokio::test]
    async fn connection_status_and_binding_ready_refresh_snapshot_and_clear_recovering_notice() {
        use agents::conversation::ConversationAgentConnectionStatus;

        let pool = setup_pool().await;
        let (conversation_id, _turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Connecting,
                message: None,
                bound: false,
            },
            None,
        )
        .await;

        let side_rows_connecting =
            ConversationProjector::persisted_side_rows(&pool, conversation_id)
                .await
                .expect("persisted side rows after connecting");
        assert!(
            side_rows_connecting
                .iter()
                .any(|row| row.row_id == "notice:agent-connection-recovering"),
            "connecting status should persist notice:agent-connection-recovering into snapshot"
        );

        append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Ready,
                message: None,
                bound: true,
            },
            None,
        )
        .await;

        let side_rows_ready = ConversationProjector::persisted_side_rows(&pool, conversation_id)
            .await
            .expect("persisted side rows after ready");
        assert!(
            !side_rows_ready
                .iter()
                .any(|row| row.row_id == "notice:agent-connection-recovering"),
            "ready status must immediately refresh snapshot and remove notice:agent-connection-recovering"
        );
    }

    #[tokio::test]
    async fn stale_snapshot_with_recovering_notice_self_heals_on_persisted_side_rows_and_project_open()
     {
        use agents::conversation::ConversationAgentConnectionStatus;

        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "hello".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let connecting_rec = append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Connecting,
                message: None,
                bound: false,
            },
            None,
        )
        .await;
        let fold_at_connecting = ConversationProjector::fold(&pool, conversation_id)
            .await
            .expect("fold at connecting");
        assert_eq!(fold_at_connecting.last_sequence, connecting_rec.sequence);

        append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Ready,
                message: None,
                bound: true,
            },
            None,
        )
        .await;

        // Simulate a historical stale snapshot frozen at the `Connecting` sequence.
        ConversationProjector::persist_fold_to_pool(&pool, conversation_id, &fold_at_connecting)
            .await
            .expect("overwrite with stale snapshot");

        let healed_side_rows = ConversationProjector::persisted_side_rows(&pool, conversation_id)
            .await
            .expect("self-healed persisted_side_rows");
        assert!(
            !healed_side_rows
                .iter()
                .any(|row| row.row_id == "notice:agent-connection-recovering"),
            "persisted_side_rows must detect stale snapshot and fold tail events to clear notice"
        );

        // Overwrite again to test try_materialized_open / project_open self-healing.
        ConversationProjector::persist_fold_to_pool(&pool, conversation_id, &fold_at_connecting)
            .await
            .expect("overwrite with stale snapshot again");

        let open_proj = ConversationProjector::project_open(&pool, conversation_id, 50)
            .await
            .expect("project_open self-heals stale snapshot");
        assert!(
            !open_proj
                .timeline
                .rows
                .iter()
                .any(|row| row.row_id == "notice:agent-connection-recovering"),
            "project_open must bypass stale snapshot and not return notice:agent-connection-recovering"
        );
    }
}
