use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Mutex as StdMutex, OnceLock},
};

use agents::conversation::{
    ConversationRowOp, ConversationTimelineRow, cap_timeline_row_preview_fields,
};
use db::models::{
    conversation_event::ConversationEventRecord,
    conversation_snapshot::ConversationProjectionSnapshotRecord,
    conversation_timeline_row::ConversationTimelineRowRecord,
};
use sqlx::SqliteConnection;
use uuid::Uuid;

use super::{
    CONVERSATION_PROJECTION_VERSION, ConversationProjector, ProjectionFold,
    ProjectionSnapshotState, TurnMetricsSummary,
    cache::{antigravity_conversation, json_decode_error, target_turn_id_for_fold},
    rows::message_rows,
    session_stats_from_metrics, summarize_turn_metrics,
};

const MAX_WRITE_PROJECTORS: usize = 96;
const MAX_WRITE_RESIDENT_TURNS: usize = 8;

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
    // Drop any cached state so the next write reloads fresh turn_ordinals + fold cleanly.
    map.remove(&conversation_id);
    let _ = fold;
}

fn trim_write_projector_turns(state: &mut WriteSideProjectorState) {
    if state.fold.turns.len() <= MAX_WRITE_RESIDENT_TURNS {
        return;
    }
    let keep_start = state
        .fold
        .turn_order
        .len()
        .saturating_sub(MAX_WRITE_RESIDENT_TURNS);
    let keep_ids: HashSet<Uuid> = state.fold.turn_order[keep_start..]
        .iter()
        .copied()
        .collect();
    state.fold.turns.retain(|id, _| keep_ids.contains(id));
    state.loaded_turns.retain(|id| keep_ids.contains(id));
    state.full_history_loaded = false;
}

pub(crate) fn commit_write_projector_states(states: HashMap<Uuid, WriteSideProjectorState>) {
    if states.is_empty() {
        return;
    }
    let mut map = write_side_projectors()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = std::time::Instant::now();
    let keep_ids: HashSet<Uuid> = states.keys().copied().collect();
    for (cid, mut state) in states {
        trim_write_projector_turns(&mut state);
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

pub(super) async fn load_turn_ordinals_on_conn(
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
    let initial_prompt =
        sqlx::query_scalar::<_, Option<String>>("SELECT initial_prompt FROM sessions WHERE id = ?")
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
        let turn_order = if snap_state.turn_order.is_empty() {
            let mut ordered_turns: Vec<(i64, Uuid)> =
                turn_ordinals.iter().map(|(&id, &ord)| (ord, id)).collect();
            ordered_turns.sort_by_key(|(ord, _)| *ord);
            ordered_turns.into_iter().map(|(_, id)| id).collect()
        } else {
            snap_state.turn_order
        };
        let fold = ProjectionFold {
            turn_order,
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
    let prior_events = ConversationEventRecord::events_since_before(
        &mut *conn,
        conversation_id,
        0,
        before_sequence,
    )
    .await?;
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

async fn ensure_turn_loaded_on_conn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    state: &mut WriteSideProjectorState,
    record: &ConversationEventRecord,
) -> Result<(), sqlx::Error> {
    if state.full_history_loaded {
        return Ok(());
    }
    let Some(turn_id) = target_turn_id_for_fold(&state.fold, Some(&state.turn_ordinals), record)
    else {
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
        let tail = ConversationEventRecord::events_for_turn_with_unassigned_before(
            &mut *conn,
            conversation_id,
            turn_id,
            min_seq.saturating_sub(1),
            record.sequence,
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
        let tail = ConversationEventRecord::events_since_before(
            &mut *conn,
            conversation_id,
            0,
            record.sequence,
        )
        .await?;
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

fn find_row_in_fold(fold: &ProjectionFold, row_id: &str) -> Option<super::TimelineRow> {
    if let Some((prefix, _)) = row_id.split_once(':')
        && let Ok(turn_id) = Uuid::parse_str(prefix)
        && let Some(turn) = fold.turns.get(&turn_id)
    {
        return message_rows(turn).into_iter().find(|r| r.row_id == row_id);
    }
    fold.side_rows.iter().find(|r| r.row_id == row_id).cloned()
}

pub(super) async fn row_turn_ordinal_on_conn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    fold: &ProjectionFold,
    turn_ordinals: &mut HashMap<Uuid, i64>,
    row_id: &str,
) -> Result<Option<i64>, sqlx::Error> {
    if let Some(turn_id) = fold.side_row_turns.get(row_id).copied() {
        let ord =
            resolve_turn_ordinal_on_conn(conn, conversation_id, turn_ordinals, turn_id).await?;
        return Ok(Some(ord));
    }
    if let Some((prefix, _)) = row_id.split_once(':')
        && let Ok(turn_id) = Uuid::parse_str(prefix)
    {
        let ord =
            resolve_turn_ordinal_on_conn(conn, conversation_id, turn_ordinals, turn_id).await?;
        return Ok(Some(ord));
    }
    if let Some(side) = fold.side_rows.iter().find(|r| r.row_id == row_id) {
        return match fold.side_row_turn_id(side) {
            Some(turn_id) => Ok(Some(
                resolve_turn_ordinal_on_conn(conn, conversation_id, turn_ordinals, turn_id).await?,
            )),
            None => Ok(None),
        };
    }
    Ok(None)
}

#[derive(Clone)]
pub(crate) enum DirtyRowAction {
    Upsert {
        need_fts: bool,
        fallback_row: Option<Box<super::TimelineRow>>,
    },
    Delete {
        revision: i64,
    },
}

pub(crate) type DirtyRowMap = HashMap<(Uuid, String), DirtyRowAction>;

fn record_dirty_upsert(
    dirty_rows: &mut DirtyRowMap,
    cid: Uuid,
    row_id: String,
    need_fts: bool,
    fallback_row: Option<Box<super::TimelineRow>>,
) {
    match dirty_rows.get_mut(&(cid, row_id.clone())) {
        Some(DirtyRowAction::Upsert {
            need_fts: existing_fts,
            fallback_row: existing_fallback,
        }) => {
            *existing_fts |= need_fts;
            if fallback_row.is_some() {
                *existing_fallback = fallback_row;
            }
        }
        _ => {
            dirty_rows.insert(
                (cid, row_id),
                DirtyRowAction::Upsert {
                    need_fts,
                    fallback_row,
                },
            );
        }
    }
}

pub(crate) fn merge_dirty_rows(target: &mut DirtyRowMap, source: DirtyRowMap) {
    for ((cid, row_id), action) in source {
        match action {
            DirtyRowAction::Upsert {
                need_fts,
                fallback_row,
            } => record_dirty_upsert(target, cid, row_id, need_fts, fallback_row),
            DirtyRowAction::Delete { revision } => {
                target.insert((cid, row_id), DirtyRowAction::Delete { revision });
            }
        }
    }
}

pub(crate) async fn apply_and_persist_incremental_on_conn(
    conn: &mut SqliteConnection,
    state: &mut WriteSideProjectorState,
    record: &ConversationEventRecord,
) -> Result<(), sqlx::Error> {
    apply_and_persist_incremental_with_dirty_on_conn(conn, state, record, None).await
}

pub(crate) async fn apply_and_persist_incremental_with_dirty_on_conn(
    conn: &mut SqliteConnection,
    state: &mut WriteSideProjectorState,
    record: &ConversationEventRecord,
    mut dirty_rows: Option<&mut DirtyRowMap>,
) -> Result<(), sqlx::Error> {
    let cid = record.conversation_id;
    ensure_turn_loaded_on_conn(conn, cid, state, record).await?;
    let prev_turn_count = state.fold.turn_order.len();
    let target_tid = target_turn_id_for_fold(&state.fold, Some(&state.turn_ordinals), record);
    let ops = state.fold.apply(record)?;

    let mut seeded_first_turn_id = None;
    if state.turn_ordinals.is_empty()
        && !state.fold.turns.is_empty()
        && !state.fold.turns.values().any(|t| !t.user.blocks.is_empty())
    {
        state
            .fold
            .seed_user_prompt_from_session(cid, state.initial_prompt.as_deref());
        if let Some(&first_turn_id) = state.fold.turn_order.first() {
            seeded_first_turn_id = Some(first_turn_id);
            let user_row_id = format!("{first_turn_id}:user");
            if let Some(dirty) = dirty_rows.as_deref_mut() {
                if find_row_in_fold(&state.fold, &user_row_id).is_some() {
                    record_dirty_upsert(dirty, cid, user_row_id, true, None);
                }
            } else if let Some(mut seeded_user) = find_row_in_fold(&state.fold, &user_row_id) {
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

    let mut touched_turns: HashSet<Uuid> = HashSet::new();
    for &turn_id in state.fold.turn_order.get(prev_turn_count..).unwrap_or(&[]) {
        touched_turns.insert(turn_id);
    }
    if let Some(tid) = target_tid {
        touched_turns.insert(tid);
    }
    if let Some(tid) = seeded_first_turn_id {
        touched_turns.insert(tid);
    }
    for op in &ops {
        let row_id = match op {
            ConversationRowOp::Upsert { row } => row.row_id.as_str(),
            ConversationRowOp::Delete { row_id, .. }
            | ConversationRowOp::AppendText { row_id, .. }
            | ConversationRowOp::PatchBlocks { row_id, .. } => row_id.as_str(),
        };
        if let Some((prefix, _)) = row_id.split_once(':')
            && let Ok(tid) = Uuid::parse_str(prefix)
        {
            touched_turns.insert(tid);
        }
    }

    for turn_id in touched_turns {
        let ord =
            resolve_turn_ordinal_on_conn(conn, cid, &mut state.turn_ordinals, turn_id).await?;
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

    if let Some(dirty) = dirty_rows {
        for op in &ops {
            match op {
                ConversationRowOp::Delete { row_id, revision } => {
                    dirty.insert(
                        (cid, row_id.clone()),
                        DirtyRowAction::Delete {
                            revision: *revision,
                        },
                    );
                }
                ConversationRowOp::Upsert { row } => {
                    let need_fts = matches!(row.row, ConversationTimelineRow::MessageTurn { .. });
                    let fallback = if find_row_in_fold(&state.fold, &row.row_id).is_some() {
                        None
                    } else {
                        Some(Box::new(row.clone()))
                    };
                    record_dirty_upsert(dirty, cid, row.row_id.clone(), need_fts, fallback);
                }
                ConversationRowOp::AppendText { row_id, .. }
                | ConversationRowOp::PatchBlocks { row_id, .. } => {
                    record_dirty_upsert(dirty, cid, row_id.clone(), false, None);
                }
            }
        }
        return Ok(());
    }

    for op in &ops {
        match op {
            ConversationRowOp::Delete { row_id, revision } => {
                ConversationTimelineRowRecord::soft_delete_row_on_conn(
                    conn, cid, row_id, *revision,
                )
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

pub(crate) async fn flush_dirty_rows_on_conn(
    conn: &mut SqliteConnection,
    states: &mut HashMap<Uuid, WriteSideProjectorState>,
    dirty_rows: DirtyRowMap,
) -> Result<(), sqlx::Error> {
    for ((cid, row_id), action) in dirty_rows {
        match action {
            DirtyRowAction::Delete { revision } => {
                ConversationTimelineRowRecord::soft_delete_row_on_conn(
                    conn, cid, &row_id, revision,
                )
                .await?;
                if let Err(error) = crate::search::delete_fts_row_on_conn(conn, cid, &row_id).await
                {
                    tracing::warn!("conversation FTS delete failed: {error}");
                }
            }
            DirtyRowAction::Upsert {
                need_fts,
                fallback_row,
            } => {
                let Some(state) = states.get_mut(&cid) else {
                    continue;
                };
                let Some(mut full_row) = find_row_in_fold(&state.fold, &row_id)
                    .or_else(|| fallback_row.map(|boxed| *boxed))
                else {
                    continue;
                };
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
                if need_fts
                    && matches!(full_row.row, ConversationTimelineRow::MessageTurn { .. })
                    && let Err(error) =
                        crate::search::upsert_fts_from_timeline_row_on_conn(conn, cid, &full_row)
                            .await
                {
                    tracing::warn!("conversation FTS upsert failed: {error}");
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

#[cfg(test)]
pub(crate) fn evict_write_projector_for_tests(conversation_id: Uuid) {
    evict_write_projector(conversation_id);
}
