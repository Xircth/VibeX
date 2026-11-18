use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex as StdMutex, OnceLock},
};

use agents::conversation::{
    ContentBlock, ConversationEvent, ConversationRowOp, ConversationSessionNotice,
    ConversationTimelineRow, SessionStats, TimelineRow, TimelineTextStream, TurnRole, TurnUsage,
    cap_content_blocks, cap_timeline_row_preview_fields,
    extract_and_strip_internal_messages_incremental,
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
    ProjectionFold, ProjectionSnapshotState, conversation_event_from_record,
    emit_captured_internal_message,
    fold::{ProjectedTurn, append_thinking_block, ensure_turn},
    rows::{message_row, message_rows},
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

impl ProjectedTurn {
    pub(super) fn clear_trailing_raw_text(&mut self) {
        self.trailing_raw_text.clear();
        self.emitted_internal_count = 0;
        self.internal_scan_cursor = Default::default();
    }
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
                    turn.clear_trailing_raw_text();
                }
                let prev_total_captured = turn.internal_scan_cursor.total_captured;
                let prev_emitted_count = turn.emitted_internal_count;
                turn.trailing_raw_text.push_str(text);

                let (visible_delta, newly_captured) = match turn.assistant.blocks.last_mut() {
                    Some(ContentBlock::Text { text: existing }) => {
                        let update = extract_and_strip_internal_messages_incremental(
                            &turn.trailing_raw_text,
                            existing,
                            &mut turn.internal_scan_cursor,
                            Some(record.conversation_id),
                            Some(turn_id),
                        );
                        (update.visible_delta, update.newly_captured)
                    }
                    _ => {
                        let mut buf = String::new();
                        let update = extract_and_strip_internal_messages_incremental(
                            &turn.trailing_raw_text,
                            &mut buf,
                            &mut turn.internal_scan_cursor,
                            Some(record.conversation_id),
                            Some(turn_id),
                        );
                        if !buf.is_empty() {
                            turn.assistant.blocks.push(ContentBlock::Text { text: buf });
                        }
                        (update.visible_delta, update.newly_captured)
                    }
                };

                let skip_already_emitted = if prev_total_captured == 0 {
                    prev_emitted_count
                } else {
                    0
                };
                for captured in newly_captured.into_iter().skip(skip_already_emitted) {
                    emit_captured_internal_message(captured);
                    turn.emitted_internal_count += 1;
                }

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
                turn.clear_trailing_raw_text();
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
    partial_turns: bool,
    loaded_turns: HashSet<Uuid>,
}

async fn hydrate_turn_state_before(
    pool: &SqlitePool,
    conversation_id: Uuid,
    complete_antigravity_reads: bool,
    turn_id: Uuid,
    before_sequence: i64,
) -> Result<Option<ProjectedTurn>, sqlx::Error> {
    let events = if turn_id == conversation_id {
        ConversationEventRecord::events_since_before(pool, conversation_id, 0, before_sequence)
            .await?
    } else {
        let turn_events =
            ConversationEventRecord::events_for_turn(pool, conversation_id, turn_id).await?;
        let min_turn_seq = turn_events
            .iter()
            .filter(|ev| ev.sequence < before_sequence)
            .map(|ev| ev.sequence)
            .min();
        if let Some(min_seq) = min_turn_seq {
            ConversationEventRecord::events_for_turn_with_unassigned_before(
                pool,
                conversation_id,
                turn_id,
                min_seq.saturating_sub(1),
                before_sequence,
            )
            .await?
        } else {
            return Ok(None);
        }
    };

    let mut temp_fold = ProjectionFold {
        complete_antigravity_reads,
        ..ProjectionFold::default()
    };
    for ev in &events {
        if ev.sequence < before_sequence
            && (turn_id == conversation_id || ev.turn_id == Some(turn_id) || ev.turn_id.is_none())
        {
            temp_fold.apply(ev)?;
        }
    }
    Ok(temp_fold.turns.remove(&turn_id))
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
        let complete_antigravity_reads = antigravity_conversation(pool, conversation_id).await?;
        let mut fold = ProjectionFold {
            complete_antigravity_reads,
            ..ProjectionFold::default()
        };
        let mut partial_turns = false;
        let mut loaded_turns = HashSet::new();

        if let Some(snapshot) = ConversationProjectionSnapshotRecord::find(pool, conversation_id)
            .await?
            .filter(|s| s.projection_version == CONVERSATION_PROJECTION_VERSION as i64)
            && let Ok(snap_state) =
                serde_json::from_str::<ProjectionSnapshotState>(&snapshot.fold_json)
            && snap_state.last_sequence <= up_to_sequence
        {
            if snap_state.full_fold {
                fold = ProjectionFold::from_snapshot_state(snap_state);
                fold.complete_antigravity_reads = complete_antigravity_reads;
                loaded_turns = fold.turns.keys().copied().collect();
            } else {
                let turn_order = if snap_state.turn_order.is_empty() {
                    sqlx::query_scalar::<_, Uuid>(
                        "SELECT id FROM conversation_turns WHERE conversation_id = ? ORDER BY ordinal ASC",
                    )
                    .bind(conversation_id)
                    .fetch_all(pool)
                    .await?
                } else {
                    snap_state.turn_order
                };
                fold.turn_order = turn_order;
                fold.side_rows = snap_state.side_rows;
                fold.side_row_turns = snap_state.side_row_turns;
                fold.last_sequence = snap_state.last_sequence;
                fold.auto_permission_approvals = snap_state.auto_permission_approvals;
                partial_turns = true;
                if let Some(&latest_turn_id) = fold.turn_order.last() {
                    if let Some(hydrated) = hydrate_turn_state_before(
                        pool,
                        conversation_id,
                        complete_antigravity_reads,
                        latest_turn_id,
                        fold.last_sequence.saturating_add(1),
                    )
                    .await?
                    {
                        fold.turns.insert(latest_turn_id, hydrated);
                    }
                    loaded_turns.insert(latest_turn_id);
                }
            }
        }

        if up_to_sequence > fold.last_sequence {
            let tail = ConversationEventRecord::events_since_before(
                pool,
                conversation_id,
                fold.last_sequence,
                up_to_sequence.saturating_add(1),
            )
            .await?;
            if partial_turns {
                let missing =
                    missing_turns_for_projection(&fold, &loaded_turns, partial_turns, &tail);
                for (turn_id, seq) in missing {
                    if let Some(hydrated) = hydrate_turn_state_before(
                        pool,
                        conversation_id,
                        complete_antigravity_reads,
                        turn_id,
                        seq,
                    )
                    .await?
                    {
                        if !fold.turn_order.contains(&turn_id) {
                            fold.turn_order.push(turn_id);
                        }
                        fold.turns.insert(turn_id, hydrated);
                    }
                    loaded_turns.insert(turn_id);
                }
            }
            for record in &tail {
                if record.sequence <= up_to_sequence {
                    if let Some(turn_id) = target_turn_id_for_fold(&fold, None, record) {
                        loaded_turns.insert(turn_id);
                    }
                    fold.apply(record)?;
                }
            }
        }
        Ok(Self {
            fold,
            generation,
            partial_turns,
            loaded_turns,
        })
    }

    pub fn complete_antigravity_reads(&self) -> bool {
        self.fold.complete_antigravity_reads
    }

    pub fn missing_turns_for_records(
        &self,
        records: &[ConversationEventRecord],
    ) -> Vec<(Uuid, i64)> {
        missing_turns_for_projection(&self.fold, &self.loaded_turns, self.partial_turns, records)
    }

    pub(crate) fn insert_hydrated_turns(&mut self, hydrated: Vec<(Uuid, Option<ProjectedTurn>)>) {
        for (turn_id, turn_opt) in hydrated {
            if let Some(turn) = turn_opt {
                if !self.fold.turn_order.contains(&turn_id) {
                    self.fold.turn_order.push(turn_id);
                }
                self.fold.turns.insert(turn_id, turn);
            }
            self.loaded_turns.insert(turn_id);
        }
    }

    /// Fold one newly-appended event and return the row ops it produced.
    pub fn apply(
        &mut self,
        record: &ConversationEventRecord,
    ) -> Result<Vec<ConversationRowOp>, sqlx::Error> {
        if self.partial_turns
            && let Some(turn_id) = target_turn_id_for_fold(&self.fold, None, record)
        {
            self.loaded_turns.insert(turn_id);
        }
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

pub(crate) async fn fetch_hydrated_turns_for_projector(
    pool: &SqlitePool,
    conversation_id: Uuid,
    complete_antigravity_reads: bool,
    targets: &[(Uuid, i64)],
) -> Result<Vec<(Uuid, Option<ProjectedTurn>)>, sqlx::Error> {
    let mut out = Vec::with_capacity(targets.len());
    for &(turn_id, before_seq) in targets {
        let hydrated = hydrate_turn_state_before(
            pool,
            conversation_id,
            complete_antigravity_reads,
            turn_id,
            before_seq,
        )
        .await?;
        out.push((turn_id, hydrated));
    }
    Ok(out)
}

fn missing_turns_for_projection(
    fold: &ProjectionFold,
    loaded_turns: &HashSet<Uuid>,
    partial_turns: bool,
    records: &[ConversationEventRecord],
) -> Vec<(Uuid, i64)> {
    if !partial_turns {
        return Vec::new();
    }
    let mut seen = HashSet::new();
    let mut missing = Vec::new();
    for record in records {
        if let Some(turn_id) = target_turn_id_for_fold(fold, None, record)
            && !loaded_turns.contains(&turn_id)
            && seen.insert(turn_id)
        {
            missing.push((turn_id, record.sequence));
        }
    }
    missing
}

pub(super) fn target_turn_id_for_fold(
    fold: &ProjectionFold,
    fallback_turn_ordinals: Option<&HashMap<Uuid, i64>>,
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
            | ConversationEvent::TurnFailed { .. }
            | ConversationEvent::TurnInterrupted { .. },
        ) => fold
            .turn_order
            .last()
            .copied()
            .or_else(|| {
                fallback_turn_ordinals.and_then(|ordinals| {
                    ordinals
                        .iter()
                        .max_by_key(|(_, ord)| *ord)
                        .map(|(id, _)| *id)
                })
            })
            .or(Some(record.conversation_id)),
        _ => None,
    }
}

///
/// `db_cursor` is the last SQLite sequence folded into this process. Transcript
/// deltas advance `projector.last_sequence()` without moving `db_cursor`, so the
/// next durable event (turn completed, checkpoint) is still applied.
const MAX_CACHED_ROW_PROJECTORS: usize = 96;
const HARD_MAX_CACHED_ROW_PROJECTORS: usize = MAX_CACHED_ROW_PROJECTORS * 2;

pub struct CachedRowProjector {
    pub projector: IncrementalRowProjector,
    pub last_emitted_sequence: i64,
    pub db_cursor: i64,
    has_unpersisted: bool,
    last_used: Instant,
    generation: u64,
    active_pins: Vec<std::sync::Weak<()>>,
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
            active_pins: Vec::new(),
        }
    }

    pub fn touch(&mut self) {
        self.last_used = Instant::now();
    }

    pub fn pin(&mut self) -> Arc<()> {
        self.active_pins.retain(|pin| pin.strong_count() > 0);
        let guard = Arc::new(());
        self.active_pins.push(Arc::downgrade(&guard));
        self.touch();
        guard
    }

    pub fn is_pinned(&self) -> bool {
        self.active_pins.iter().any(|pin| pin.strong_count() > 0)
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
        self.projector.partial_turns = false;
        self.projector.loaded_turns = self.projector.fold.turns.keys().copied().collect();
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

/// Trim the projector cache to [`MAX_CACHED_ROW_PROJECTORS`] for clean entries and
/// [`HARD_MAX_CACHED_ROW_PROJECTORS`] across all entries, never evicting `keep`.
pub fn evict_least_recently_used_projectors(
    cache: &mut HashMap<Uuid, CachedRowProjector>,
    keep: Uuid,
) {
    while cache.len() > MAX_CACHED_ROW_PROJECTORS {
        let Some(oldest) = cache
            .iter()
            .filter(|(id, entry)| **id != keep && !entry.has_unpersisted && !entry.is_pinned())
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(id, _)| *id)
        else {
            break;
        };
        cache.remove(&oldest);
    }
    while cache.len() > HARD_MAX_CACHED_ROW_PROJECTORS {
        let Some(oldest) = cache
            .iter()
            .filter(|(id, entry)| **id != keep && !entry.is_pinned())
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(id, _)| *id)
        else {
            break;
        };
        cache.remove(&oldest);
    }
}

pub(crate) use super::write_cache::*;

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

pub(super) fn decode_session_stats(
    json: Option<&str>,
) -> Result<Option<SessionStats>, sqlx::Error> {
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
            partial_turns: false,
            loaded_turns: HashSet::new(),
        }
    }
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
