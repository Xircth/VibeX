mod applier;
mod backfill;
mod cache;
mod fold;
mod query;
mod rows;
mod runtime_status;
mod write_cache;
#[cfg(test)]
mod bounds_tests;

use std::{
    collections::{BTreeMap, HashSet},
    str::FromStr,
    sync::{Arc, Mutex, OnceLock, RwLock},
};

use agents::conversation::{
    AcpCapabilitySnapshot, ContentBlock, ConversationEvent, ConversationInputEvent,
    ConversationRowOp, ConversationTimeline, ConversationTimelineRow, ConversationUsage,
    MessageTurn, SessionStats, TimelineRow, TurnRole, TurnUsage, cap_timeline_preview_fields,
    cap_timeline_row_preview_fields,
};
use db::models::{
    conversation::ConversationAgentBindingRecord,
    conversation_event::{CURRENT_EVENT_VERSION, ConversationEventRecord},
    conversation_timeline_row::ConversationTimelineRowRecord,
    session::Session,
};
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use tokio::sync::broadcast;
use uuid::Uuid;

pub use agents::conversation::ConversationRowsSincePage;
pub use self::{
    applier::{
        BatchAppendResult, BatchConversationEvent, CheckpointMetadataUpdate,
        CommittedConversationEvent, ConversationEventAppender, ConversationStateApplier,
        MAX_BATCH_BYTES, MAX_BATCH_EVENTS,
    },
    backfill::{
        backfill_next_legacy_batch, ensure_legacy_jsonl_migrated,
        ensure_legacy_jsonl_migrated_on_pool, register_acp_replay_history_probe,
        spawn_legacy_jsonl_backfill_worker,
    },
    cache::{
        CachedRowProjector, ConversationRowProjectors, IncrementalRowProjector,
        evict_least_recently_used_projectors, extend_coalesced_row_ops,
    },
    query::{
        MAX_WINDOW_BYTES, TimelineKeysetCursor, decode_timeline_cursor, encode_timeline_cursor,
    },
};
pub(crate) use self::{
    applier::apply_checkpoint_metadata_update_on_conn as applier_checkpoint_update,
    cache::fetch_hydrated_turns_for_projector,
};
use self::{
    cache::{antigravity_conversation, decode_timeline_row_records, record_rebuilt_projector_fold},
    fold::ProjectedTurn,
    rows::annotate_fork_point_rows,
};

/// Occupancy-only usage must not erase a protocol breakdown already stored on
/// the turn. A later `_meta.totalTokens` sample updates context fields only.
pub(super) fn merge_reported_turn_usage(
    existing: Option<TurnUsage>,
    incoming: &ConversationUsage,
) -> TurnUsage {
    let keep_buckets = incoming.input_tokens == 0
        && incoming.output_tokens == 0
        && incoming.cache_creation_input_tokens == 0
        && incoming.cache_read_input_tokens == 0;
    let buckets = if keep_buckets {
        existing.as_ref()
    } else {
        None
    };
    TurnUsage {
        input_tokens: buckets
            .map(|usage| usage.input_tokens)
            .unwrap_or(incoming.input_tokens),
        output_tokens: buckets
            .map(|usage| usage.output_tokens)
            .unwrap_or(incoming.output_tokens),
        cache_creation_input_tokens: buckets
            .map(|usage| usage.cache_creation_input_tokens)
            .unwrap_or(incoming.cache_creation_input_tokens),
        cache_read_input_tokens: buckets
            .map(|usage| usage.cache_read_input_tokens)
            .unwrap_or(incoming.cache_read_input_tokens),
        context_used: incoming
            .context_used
            .or_else(|| existing.as_ref().and_then(|usage| usage.context_used)),
        context_window_max: incoming
            .context_window_max
            .or_else(|| existing.as_ref().and_then(|usage| usage.context_window_max)),
        cost_amount: incoming
            .cost_amount
            .or_else(|| existing.as_ref().and_then(|usage| usage.cost_amount)),
        cost_currency: incoming.cost_currency.clone().or_else(|| {
            existing
                .as_ref()
                .and_then(|usage| usage.cost_currency.clone())
        }),
    }
}

// v22 folds AgentBindingRecoveryFailed into the stable connect-error notice row
// so a subsequent AgentBindingReady / AgentBindingRecovered clears it instead of
// leaving a permanent error banner in cached snapshots.
// v23 adds replayable connection/request facts, with independent binding readiness.
pub const CONVERSATION_PROJECTION_VERSION: u32 = 23;
pub const OPEN_TIMELINE_ROW_LIMIT: usize = 16;

pub struct OpenConversationProjection {
    pub timeline: ConversationTimeline,
    pub session_stats: Option<SessionStats>,
}

pub struct ConversationRowWindow {
    pub rows: Vec<TimelineRow>,
    pub last_sequence: i64,
    pub projection_version: u32,
    pub total_rows: usize,
}

const AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID: &str = "notice:agent-binding-load-failed";
const AGENT_BINDING_REBIND_NOTICE_ROW_ID: &str = "notice:agent-session-rebound";
const AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID: &str = "notice:agent-connection-recovering";
const AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID: &str = "notice:agent-session-connect-error";
const AUTO_PERMISSION_NOTICE_ROW_ID: &str = "notice:auto-permission-approved";
const AUTO_PERMISSION_NOTICE_TITLE: &str = "已自动批准权限";
const ANNOUNCEMENT_ROW_PREFIX: &str = "notice:announcement:";

type InternalMessageListenerFn = dyn Fn(&agents::CapturedInternalMessage) + Send + Sync + 'static;

static INTERNAL_MESSAGE_TX: OnceLock<broadcast::Sender<agents::CapturedInternalMessage>> =
    OnceLock::new();
static INTERNAL_MESSAGE_LISTENERS: OnceLock<RwLock<Vec<Arc<InternalMessageListenerFn>>>> =
    OnceLock::new();
static EMITTED_INTERNAL_MESSAGE_KEYS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn internal_message_sender() -> &'static broadcast::Sender<agents::CapturedInternalMessage> {
    INTERNAL_MESSAGE_TX.get_or_init(|| {
        let (tx, _) = broadcast::channel(256);
        tx
    })
}

fn internal_message_listeners() -> &'static RwLock<Vec<Arc<InternalMessageListenerFn>>> {
    INTERNAL_MESSAGE_LISTENERS.get_or_init(|| RwLock::new(Vec::new()))
}

fn emitted_internal_message_keys() -> &'static Mutex<HashSet<String>> {
    EMITTED_INTERNAL_MESSAGE_KEYS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Subscribe to structured internal side-channel messages captured and stripped from
/// Assistant turns.
pub fn subscribe_internal_messages() -> broadcast::Receiver<agents::CapturedInternalMessage> {
    internal_message_sender().subscribe()
}

/// Register an in-process listener invoked whenever a new internal side-channel message
/// is captured and stripped from an Assistant turn.
pub fn register_internal_message_listener<F>(listener: F)
where
    F: Fn(&agents::CapturedInternalMessage) + Send + Sync + 'static,
{
    let mut guard = internal_message_listeners()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.push(Arc::new(listener));
}

/// Clears registered internal message listeners and deduplication state (primarily for tests).
pub fn clear_internal_message_listeners() {
    internal_message_listeners()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    emitted_internal_message_keys()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

pub(crate) fn emit_captured_internal_message(message: agents::CapturedInternalMessage) {
    let dedup_key = format!(
        "{}:{}:{}:{}:{}:{}",
        message.conversation_id.unwrap_or_default(),
        message.turn_id.unwrap_or_default(),
        message.plugin_id,
        message.channel,
        message.nonce,
        message.raw_payload
    );
    {
        let mut seen = emitted_internal_message_keys()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if seen.len() >= 4096 {
            seen.clear();
        }
        if !seen.insert(dedup_key) {
            return;
        }
    }
    let listeners = internal_message_listeners()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if listeners.is_empty() {
        let _ = internal_message_sender().send(message);
        return;
    }
    let _ = internal_message_sender().send(message.clone());
    for listener in listeners {
        listener(&message);
    }
}

static PROJECTION_REPAIR_HOOK: OnceLock<Arc<dyn Fn(Uuid) + Send + Sync + 'static>> = OnceLock::new();
static PENDING_PROJECTION_REPAIRS: OnceLock<Mutex<HashSet<Uuid>>> = OnceLock::new();

/// Register a background repair hook backed by `WritePool` so cold-fold fallbacks on
/// read queries deduplicatedly rebuild stale or missing projections.
pub fn register_projection_repair_hook(write_pool: db::WritePool) {
    let _ = PROJECTION_REPAIR_HOOK.set(Arc::new(move |conversation_id| {
        let pending = PENDING_PROJECTION_REPAIRS.get_or_init(|| Mutex::new(HashSet::new()));
        {
            let mut guard = pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if !guard.insert(conversation_id) {
                return;
            }
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            let mut guard = pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.remove(&conversation_id);
            return;
        };
        let pool = write_pool.clone();
        handle.spawn(async move {
            if let Err(error) =
                ConversationProjector::rebuild_projection(pool.as_pool(), conversation_id).await
            {
                tracing::warn!(%conversation_id, %error, "background projection repair failed");
            }
            if let Some(pending) = PENDING_PROJECTION_REPAIRS.get() {
                pending
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&conversation_id);
            }
        });
    }));
}

pub(super) fn schedule_projection_repair(conversation_id: Uuid) {
    if let Some(hook) = PROJECTION_REPAIR_HOOK.get() {
        hook(conversation_id);
    }
}

pub struct ConversationProjector;

impl ConversationProjector {
    /// Project a conversation timeline, resuming from a full materialized snapshot when present.
    pub async fn project(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<ConversationTimeline, sqlx::Error> {
        let timeline = Self::fold(pool, conversation_id)
            .await?
            .into_timeline(conversation_id);
        annotate_fork_points(pool, timeline).await
    }

    /// Open-conversation window: pure read path (never writes to SQLite, safe on `ReadPool`).
    pub async fn project_open(
        pool: &SqlitePool,
        conversation_id: Uuid,
        limit: usize,
    ) -> Result<OpenConversationProjection, sqlx::Error> {
        if let Some(open) = Self::try_materialized_open_with_budget(pool, conversation_id, limit)
            .await?
        {
            let timeline = annotate_fork_points(pool, open.timeline).await?;
            return Ok(OpenConversationProjection {
                timeline,
                session_stats: open.session_stats,
            });
        }
        let fold = Self::fold(pool, conversation_id).await?;
        if fold.last_sequence > 0 {
            schedule_projection_repair(conversation_id);
        }
        let session_stats = fold.session_stats();
        let timeline = annotate_fork_points(
            pool,
            fold.into_open_timeline_with_budget(conversation_id, limit),
        )
        .await?;
        Ok(OpenConversationProjection {
            timeline,
            session_stats,
        })
    }

    /// Page a row window without cloning unrequested rows onto the response (pure read path).
    pub async fn project_row_window(
        pool: &SqlitePool,
        conversation_id: Uuid,
        start: usize,
        limit: usize,
    ) -> Result<ConversationRowWindow, sqlx::Error> {
        if let Some(mut window) =
            Self::try_materialized_window(pool, conversation_id, start, limit).await?
        {
            let (fork_session, agent_kind) = fork_capability(pool, conversation_id).await?;
            annotate_fork_point_rows(&mut window.rows, fork_session, agent_kind);
            return Ok(window);
        }
        let fold = Self::fold(pool, conversation_id).await?;
        let mut window = fold.into_row_window(start, limit);
        let (fork_session, agent_kind) = fork_capability(pool, conversation_id).await?;
        annotate_fork_point_rows(&mut window.rows, fork_session, agent_kind);
        Ok(window)
    }

    pub(super) async fn fold(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<ProjectionFold, sqlx::Error> {
        let mut fold = Self::load_fold_from_snapshot(pool, conversation_id).await?;
        fold.complete_antigravity_reads = antigravity_conversation(pool, conversation_id).await?;
        let tail = ConversationEventRecord::events_since(
            pool,
            conversation_id,
            fold.last_sequence,
            i64::MAX,
        )
        .await?;
        for record in &tail {
            fold.apply(record)?;
        }
        let prompt = Session::find_by_id(pool, conversation_id)
            .await?
            .and_then(|session| session.initial_prompt);
        fold.seed_user_prompt_from_session(conversation_id, prompt.as_deref());
        Ok(fold)
    }

    /// Fold a fixed slice of records into a timeline (no snapshot). Used by import
    /// paths and tests that already hold the events.
    pub fn project_records(
        conversation_id: Uuid,
        records: &[ConversationEventRecord],
    ) -> Result<ConversationTimeline, sqlx::Error> {
        let mut fold = ProjectionFold::default();
        for record in records {
            fold.apply(record)?;
        }
        Ok(fold.into_timeline(conversation_id))
    }

    /// Timeline rows whose state changed after `after_sequence` (`revision > after_sequence`),
    /// plus the conversation's last sequence.
    pub async fn rows_since(
        pool: &SqlitePool,
        conversation_id: Uuid,
        after_sequence: i64,
    ) -> Result<(Vec<TimelineRow>, i64), sqlx::Error> {
        if let Some(page) =
            Self::try_materialized_rows_since(pool, conversation_id, after_sequence).await?
        {
            return Ok(page);
        }
        let mut fold = Self::load_fold_from_snapshot(pool, conversation_id).await?;
        fold.complete_antigravity_reads = antigravity_conversation(pool, conversation_id).await?;
        let tail = ConversationEventRecord::events_since(
            pool,
            conversation_id,
            fold.last_sequence,
            i64::MAX,
        )
        .await?;
        for record in &tail {
            fold.apply(record)?;
        }
        Ok((fold.changed_rows_since(after_sequence), fold.last_sequence))
    }

    /// Read non-message side rows for a conversation (pure read path, safe on `ReadPool`).
    pub async fn persisted_side_rows(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Vec<TimelineRow>, sqlx::Error> {
        let latest = cache::latest_event_sequence(pool, conversation_id).await?;
        let snapshot_fresh = match Self::usable_snapshot(pool, conversation_id).await? {
            Some(snapshot) => snapshot.last_sequence >= latest,
            None => latest == 0,
        };
        if !snapshot_fresh {
            let fold = Self::fold(pool, conversation_id).await?;
            return Ok(fold.side_rows);
        }
        let records =
            ConversationTimelineRowRecord::list_non_message_rows(pool, conversation_id).await?;
        let rows = decode_timeline_row_records(&records)?;
        Ok(rows
            .into_iter()
            .filter(|row| !matches!(row.row, ConversationTimelineRow::MessageTurn { .. }))
            .collect())
    }

    /// Authoritatively rebuild the derived projection tables and the snapshot from the
    /// event log, in a single transaction.
    pub async fn rebuild_projection(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        let mut conn = pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

        match Self::rebuild_on_connection(&mut conn, conversation_id).await {
            Ok(()) => {
                if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                    cache::evict_write_projector(conversation_id);
                    return Err(error);
                }
                Ok(())
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                cache::evict_write_projector(conversation_id);
                Err(error)
            }
        }
    }

    pub(crate) async fn rebuild_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        let allocated_floor = sqlx::query_scalar::<_, Option<i64>>(
            "SELECT last_allocated_sequence FROM conversation_projection_snapshots WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_optional(&mut *conn)
        .await?
        .flatten()
        .unwrap_or(0);
        let tombstone_floor = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(deleted_sequence), 0) FROM conversation_timeline_rows WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(&mut *conn)
        .await?;

        for table in [
            "conversation_inputs",
            "conversation_steering",
            "conversation_tool_calls",
            "conversation_permissions",
            "conversation_terminals",
            "conversation_file_changes",
            "conversation_usage_snapshots",
        ] {
            sqlx::query(&format!("DELETE FROM {table} WHERE conversation_id = ?"))
                .bind(conversation_id)
                .execute(&mut *conn)
                .await?;
        }
        // Delete only active rows so soft-deleted tombstones (`deleted_sequence IS NOT NULL`)
        // survive across `truncate_to_turn_ordinal`.
        sqlx::query(
            "DELETE FROM conversation_timeline_rows WHERE conversation_id = ? AND deleted_sequence IS NULL",
        )
        .bind(conversation_id)
        .execute(&mut *conn)
        .await?;
        sqlx::query("DELETE FROM conversation_relations WHERE parent_conversation_id = ?")
            .bind(conversation_id)
            .execute(&mut *conn)
            .await?;

        let events =
            ConversationEventRecord::events_since(&mut *conn, conversation_id, 0, i64::MAX).await?;
        let mut fold = ProjectionFold {
            complete_antigravity_reads: antigravity_conversation(&mut *conn, conversation_id)
                .await?,
            ..ProjectionFold::default()
        };
        for record in &events {
            ConversationStateApplier::apply_record(&mut *conn, record).await?;
            fold.apply(record)?;
        }
        if !fold.turns.is_empty() {
            let prompt = sqlx::query_scalar::<_, Option<String>>(
                "SELECT initial_prompt FROM sessions WHERE id = ?",
            )
            .bind(conversation_id)
            .fetch_optional(&mut *conn)
            .await?
            .flatten();
            fold.seed_user_prompt_from_session(conversation_id, prompt.as_deref());
        }
        fold.last_sequence = fold.last_sequence.max(allocated_floor).max(tombstone_floor);
        Self::persist_snapshot(&mut *conn, conversation_id, &fold).await?;
        if let Err(error) = crate::search::reindex_timeline_rows_on_conn(
            &mut *conn,
            conversation_id,
            &fold.timeline_rows(),
        )
        .await
        {
            tracing::warn!("conversation FTS reindex during rebuild failed: {error}");
        }
        record_rebuilt_projector_fold(conversation_id, &fold);
        cache::sync_write_projector_on_rebuild(conversation_id, &fold);
        Ok(())
    }
}

#[derive(Default, Clone)]
pub(super) struct ProjectionFold {
    turns: BTreeMap<Uuid, ProjectedTurn>,
    turn_order: Vec<Uuid>,
    pub(crate) side_rows: Vec<TimelineRow>,
    pub(super) side_row_turns: BTreeMap<String, Uuid>,
    pub(crate) last_sequence: i64,
    auto_permission_approvals: u32,
    complete_antigravity_reads: bool,
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub(super) struct TurnMetricsSummary {
    #[serde(default)]
    pub(super) ordinal: i64,
    #[serde(default)]
    pub(super) usage: Option<TurnUsage>,
    #[serde(default)]
    pub(super) duration_ms: Option<u64>,
}

fn summarize_turn_metrics(
    turn: &ProjectedTurn,
    ordinal: i64,
) -> Option<TurnMetricsSummary> {
    let mut segments: Vec<&MessageTurn> = Vec::new();
    if !turn.user.blocks.is_empty() {
        segments.push(&turn.user);
    }
    for segment in &turn.prefix_segments {
        if !segment.blocks.is_empty() {
            segments.push(segment);
        }
    }
    if !turn.assistant.blocks.is_empty()
        || turn.assistant.usage.is_some()
        || turn.assistant.duration_ms.is_some()
    {
        segments.push(&turn.assistant);
    }
    let mut has_usage = false;
    let mut agg = TurnUsage::default();
    for seg in &segments {
        if let Some(u) = seg.usage.as_ref() {
            has_usage = true;
            agg.input_tokens += u.input_tokens;
            agg.output_tokens += u.output_tokens;
            agg.cache_creation_input_tokens += u.cache_creation_input_tokens;
            agg.cache_read_input_tokens += u.cache_read_input_tokens;
            if u.cost_amount.is_some() {
                agg.cost_amount = u.cost_amount;
            }
            if u.cost_currency.is_some() {
                agg.cost_currency = u.cost_currency.clone();
            }
        }
    }
    if let Some(latest_max_seg) = segments.iter().rev().find(|s| {
        s.usage
            .as_ref()
            .is_some_and(|u| u.context_window_max.is_some() || u.context_used.is_some())
    }) && let Some(u) = latest_max_seg.usage.as_ref()
    {
        agg.context_window_max = u.context_window_max;
        agg.context_used = u.context_used.or(Some(
            u.input_tokens
                + u.output_tokens
                + u.cache_creation_input_tokens
                + u.cache_read_input_tokens,
        ));
    }
    let duration_sum: u64 = segments.iter().filter_map(|s| s.duration_ms).sum();
    let has_duration = segments.iter().any(|s| s.duration_ms.is_some());
    if !has_usage && !has_duration {
        return None;
    }
    Some(TurnMetricsSummary {
        ordinal,
        usage: has_usage.then_some(agg),
        duration_ms: has_duration.then_some(duration_sum),
    })
}

fn default_full_fold() -> bool {
    true
}

/// Serializable form of [`ProjectionFold`].
///
/// Cold rebuilds set `full_fold = true` and serialize `turns`. Hot incremental writes set
/// `full_fold = false` (`turns = []`) to avoid O(N_turns) JSON serialization on every event.
#[derive(Serialize, Deserialize)]
struct ProjectionSnapshotState {
    #[serde(default)]
    turns: Vec<ProjectedTurn>,
    #[serde(default)]
    turn_order: Vec<Uuid>,
    #[serde(default)]
    side_rows: Vec<TimelineRow>,
    #[serde(default)]
    side_row_turns: BTreeMap<String, Uuid>,
    #[serde(default)]
    last_sequence: i64,
    #[serde(default)]
    auto_permission_approvals: u32,
    #[serde(default = "default_full_fold")]
    full_fold: bool,
    #[serde(default)]
    turn_metrics: BTreeMap<Uuid, TurnMetricsSummary>,
}

impl Default for ProjectionSnapshotState {
    fn default() -> Self {
        Self {
            turns: Vec::new(),
            turn_order: Vec::new(),
            side_rows: Vec::new(),
            side_row_turns: BTreeMap::new(),
            last_sequence: 0,
            auto_permission_approvals: 0,
            full_fold: true,
            turn_metrics: BTreeMap::new(),
        }
    }
}

impl ProjectionFold {
    fn side_row_turn_id(&self, row: &TimelineRow) -> Option<Uuid> {
        if let Some(turn_id) = self.side_row_turns.get(&row.row_id).copied() {
            return Some(turn_id);
        }
        if let Some(turn_id_str) = row.row_id.strip_prefix("host-note:agent-handoff:after:")
            && let Ok(turn_id) = Uuid::parse_str(turn_id_str)
        {
            return Some(turn_id);
        }
        match &row.row {
            ConversationTimelineRow::SessionNotice { .. } => None,
            ConversationTimelineRow::TurnError { error } => error.turn_id,
            ConversationTimelineRow::FileChangeSummary { turn_id, .. } => *turn_id,
            _ => None,
        }
    }

    fn from_snapshot_state(state: ProjectionSnapshotState) -> Self {
        let mut fold = ProjectionFold {
            turn_order: Vec::with_capacity(state.turns.len()),
            last_sequence: state.last_sequence,
            side_rows: state.side_rows,
            side_row_turns: state.side_row_turns,
            auto_permission_approvals: state.auto_permission_approvals,
            ..ProjectionFold::default()
        };
        for turn in state.turns {
            fold.turn_order.push(turn.turn_id);
            fold.turns.insert(turn.turn_id, turn);
        }
        fold
    }

    fn collect_turn_metrics(&self) -> BTreeMap<Uuid, TurnMetricsSummary> {
        let mut map = BTreeMap::new();
        for (idx, turn_id) in self.turn_order.iter().enumerate() {
            if let Some(turn) = self.turns.get(turn_id)
                && let Some(summary) = summarize_turn_metrics(turn, (idx as i64) + 1)
            {
                map.insert(*turn_id, summary);
            }
        }
        map
    }

    fn to_snapshot_state(&self) -> ProjectionSnapshotState {
        let turns = self
            .turn_order
            .iter()
            .filter_map(|turn_id| self.turns.get(turn_id).cloned())
            .collect();
        ProjectionSnapshotState {
            turns,
            turn_order: self.turn_order.clone(),
            side_rows: self.side_rows.clone(),
            side_row_turns: self.side_row_turns.clone(),
            last_sequence: self.last_sequence,
            auto_permission_approvals: self.auto_permission_approvals,
            full_fold: true,
            turn_metrics: self.collect_turn_metrics(),
        }
    }

    fn to_lightweight_snapshot_state(
        &self,
        turn_metrics: &BTreeMap<Uuid, TurnMetricsSummary>,
    ) -> ProjectionSnapshotState {
        ProjectionSnapshotState {
            turns: Vec::new(),
            turn_order: self.turn_order.clone(),
            side_rows: self.side_rows.clone(),
            side_row_turns: self.side_row_turns.clone(),
            last_sequence: self.last_sequence,
            auto_permission_approvals: self.auto_permission_approvals,
            full_fold: false,
            turn_metrics: turn_metrics.clone(),
        }
    }

    pub(crate) fn apply(
        &mut self,
        record: &ConversationEventRecord,
    ) -> Result<Vec<ConversationRowOp>, sqlx::Error> {
        Ok(self.fold_record(record))
    }

    fn collect_rows(self) -> (Vec<TimelineRow>, i64) {
        let last_sequence = self.last_sequence;
        (self.timeline_rows(), last_sequence)
    }

    pub(super) fn into_timeline(self, conversation_id: Uuid) -> ConversationTimeline {
        let (rows, last_sequence) = self.collect_rows();
        let mut timeline = ConversationTimeline {
            conversation_id,
            projection_version: CONVERSATION_PROJECTION_VERSION,
            last_sequence,
            rows,
            truncated_from_start: false,
            older_cursor: None,
        };
        cap_timeline_preview_fields(&mut timeline);
        annotate_fork_point_rows(&mut timeline.rows, false, None);
        timeline
    }

    fn into_row_window(self, start: usize, limit: usize) -> ConversationRowWindow {
        let (mut rows, last_sequence) = self.collect_rows();
        let total_rows = rows.len();
        let bounded_limit = limit.max(1);
        let end = start.saturating_add(bounded_limit).min(total_rows);
        let mut window = if start >= total_rows {
            Vec::new()
        } else {
            rows.drain(start..end).collect()
        };
        for row in &mut window {
            cap_timeline_row_preview_fields(row);
        }
        ConversationRowWindow {
            rows: window,
            last_sequence,
            projection_version: CONVERSATION_PROJECTION_VERSION,
            total_rows,
        }
    }

    pub(super) fn session_stats(&self) -> Option<SessionStats> {
        let mut turns = Vec::new();
        for turn_id in &self.turn_order {
            let Some(turn) = self.turns.get(turn_id) else {
                continue;
            };
            if !turn.user.blocks.is_empty() {
                turns.push(&turn.user);
            }
            for segment in &turn.prefix_segments {
                if !segment.blocks.is_empty() {
                    turns.push(segment);
                }
            }
            if !turn.assistant.blocks.is_empty()
                || turn.assistant.usage.is_some()
                || turn.assistant.duration_ms.is_some()
            {
                turns.push(&turn.assistant);
            }
        }
        session_stats_from_turns(&turns)
    }

    fn changed_rows_since(&self, after_sequence: i64) -> Vec<TimelineRow> {
        let mut rows: Vec<TimelineRow> = self
            .timeline_rows()
            .into_iter()
            .filter(|row| row.revision > after_sequence)
            .collect();
        for row in &mut rows {
            cap_timeline_row_preview_fields(row);
        }
        rows
    }

    pub(super) fn seed_user_prompt_from_session(
        &mut self,
        conversation_id: Uuid,
        prompt: Option<&str>,
    ) {
        let Some(prompt) = prompt.map(str::trim).filter(|value| !value.is_empty()) else {
            return;
        };
        if self.turns.values().any(|turn| !turn.user.blocks.is_empty()) {
            return;
        }
        let turn_id = self.turn_order.first().copied().unwrap_or(conversation_id);
        let rev = self.last_sequence.max(1);
        if !self.turns.contains_key(&turn_id) {
            self.turn_order.push(turn_id);
            self.turns.insert(
                turn_id,
                ProjectedTurn {
                    turn_id,
                    user: MessageTurn {
                        id: format!("{turn_id}:user"),
                        role: TurnRole::User,
                        blocks: vec![ContentBlock::Text {
                            text: prompt.to_string(),
                        }],
                        timestamp: chrono::Utc::now(),
                        usage: None,
                        duration_ms: None,
                        model: None,
                        completed_at: None,
                        agent_message_id: None,
                    },
                    assistant: MessageTurn {
                        id: format!("{turn_id}:assistant"),
                        role: TurnRole::Assistant,
                        blocks: Vec::new(),
                        timestamp: chrono::Utc::now(),
                        usage: None,
                        duration_ms: None,
                        model: None,
                        completed_at: None,
                        agent_message_id: None,
                    },
                    prefix_segments: Vec::new(),
                    prefix_segment_revisions: Vec::new(),
                    pending_steering: None,
                    phase: "settled".into(),
                    user_revision: rev,
                    revision: rev,
                    usage_announced: false,
                    trailing_raw_text: String::new(),
                    emitted_internal_count: 0,
                    internal_scan_cursor: Default::default(),
                },
            );
            return;
        }
        if let Some(turn) = self.turns.get_mut(&turn_id) {
            turn.user.blocks = vec![ContentBlock::Text {
                text: prompt.to_string(),
            }];
            turn.user_revision = rev;
        }
    }
}

async fn annotate_fork_points(
    pool: &SqlitePool,
    mut timeline: ConversationTimeline,
) -> Result<ConversationTimeline, sqlx::Error> {
    let (fork_session, agent_kind) = fork_capability(pool, timeline.conversation_id).await?;
    annotate_fork_point_rows(&mut timeline.rows, fork_session, agent_kind);
    Ok(timeline)
}

async fn fork_capability(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<(bool, Option<agents::AgentKind>), sqlx::Error> {
    let Some(binding) =
        ConversationAgentBindingRecord::active_for_conversation(pool, conversation_id).await?
    else {
        return Ok((false, None));
    };
    let capabilities =
        serde_json::from_str::<AcpCapabilitySnapshot>(&binding.session_capabilities_json)
            .unwrap_or_default();
    let agent_kind = agents::AgentKind::from_str(binding.agent_id.as_str()).ok();
    Ok((capabilities.fork_session, agent_kind))
}

pub(super) fn session_stats_from_metrics(
    metrics: &BTreeMap<Uuid, TurnMetricsSummary>,
) -> Option<SessionStats> {
    let mut ordered: Vec<&TurnMetricsSummary> = metrics.values().collect();
    ordered.sort_by_key(|m| m.ordinal);
    let total_usage =
        ordered
            .iter()
            .filter_map(|m| m.usage.as_ref())
            .fold(TurnUsage::default(), |mut acc, usage| {
                acc.input_tokens += usage.input_tokens;
                acc.output_tokens += usage.output_tokens;
                acc.cache_creation_input_tokens += usage.cache_creation_input_tokens;
                acc.cache_read_input_tokens += usage.cache_read_input_tokens;
                acc
            });
    let total_tokens = total_usage.input_tokens
        + total_usage.output_tokens
        + total_usage.cache_creation_input_tokens
        + total_usage.cache_read_input_tokens;
    let context_window = ordered.iter().rev().find_map(|m| {
        let usage = m.usage.as_ref()?;
        let max = usage.context_window_max?;
        let used = usage.context_used.unwrap_or(
            usage.input_tokens
                + usage.output_tokens
                + usage.cache_creation_input_tokens
                + usage.cache_read_input_tokens,
        );
        Some((used, max))
    });
    (total_tokens > 0).then_some(SessionStats {
        total_usage: Some(total_usage),
        total_tokens: Some(total_tokens),
        total_duration_ms: ordered.iter().filter_map(|m| m.duration_ms).sum(),
        context_window_used_tokens: context_window.map(|(used, _)| used),
        context_window_max_tokens: context_window.map(|(_, max)| max),
        context_window_usage_percent: context_window.map(|(used, max)| {
            if max > 0 {
                (used as f64 / max as f64) * 100.0
            } else {
                0.0
            }
        }),
    })
}

fn session_stats_from_turns(turns: &[&MessageTurn]) -> Option<SessionStats> {
    let total_usage = turns.iter().filter_map(|turn| turn.usage.as_ref()).fold(
        TurnUsage::default(),
        |mut acc, usage| {
            acc.input_tokens += usage.input_tokens;
            acc.output_tokens += usage.output_tokens;
            acc.cache_creation_input_tokens += usage.cache_creation_input_tokens;
            acc.cache_read_input_tokens += usage.cache_read_input_tokens;
            acc
        },
    );
    let total_tokens = total_usage.input_tokens
        + total_usage.output_tokens
        + total_usage.cache_creation_input_tokens
        + total_usage.cache_read_input_tokens;
    let context_window = turns.iter().rev().find_map(|turn| {
        let usage = turn.usage.as_ref()?;
        let max = usage.context_window_max?;
        let used = usage.context_used.unwrap_or(
            usage.input_tokens
                + usage.output_tokens
                + usage.cache_creation_input_tokens
                + usage.cache_read_input_tokens,
        );
        Some((used, max))
    });
    (total_tokens > 0).then_some(SessionStats {
        total_usage: Some(total_usage),
        total_tokens: Some(total_tokens),
        total_duration_ms: turns.iter().filter_map(|turn| turn.duration_ms).sum(),
        context_window_used_tokens: context_window.map(|(used, _)| used),
        context_window_max_tokens: context_window.map(|(_, max)| max),
        context_window_usage_percent: context_window.map(|(used, max)| {
            if max > 0 {
                (used as f64 / max as f64) * 100.0
            } else {
                0.0
            }
        }),
    })
}

/// A stored event as seen by the read side: either a known domain event, or an
/// `Unknown` wrapper for an event this build can't parse (e.g. one written by a
/// newer app version ? see [`event_version`](ConversationEventRecord::event_version)).
#[allow(clippy::large_enum_variant)]
pub(super) enum ParsedEvent {
    Known(ConversationEvent),
    /// The `normalized_json` did not match any known variant. `kind` is the event's
    /// `"kind"` discriminant (falling back to the stored `event_kind` column), and
    /// `raw` is the original payload so nothing is lost.
    Unknown {
        kind: String,
        #[allow(dead_code)]
        raw: serde_json::Value,
    },
}
pub(super) fn conversation_input_event_id(event: &ConversationInputEvent) -> Uuid {
    match event {
        ConversationInputEvent::Submitted { input_id, .. }
        | ConversationInputEvent::Updated { input_id, .. }
        | ConversationInputEvent::Reordered { input_id, .. }
        | ConversationInputEvent::Claimed { input_id, .. }
        | ConversationInputEvent::ClaimReleased { input_id, .. }
        | ConversationInputEvent::Dispatched { input_id, .. }
        | ConversationInputEvent::Cancelled { input_id, .. } => *input_id,
    }
}

pub(super) fn conversation_event_from_record(record: &ConversationEventRecord) -> ParsedEvent {
    match serde_json::from_str::<ConversationEvent>(&record.normalized_json) {
        Ok(event) => ParsedEvent::Known(event),
        Err(_) => {
            let raw = serde_json::from_str::<serde_json::Value>(&record.normalized_json)
                .unwrap_or_default();
            let kind = raw
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| record.event_kind.clone());
            ParsedEvent::Unknown { kind, raw }
        }
    }
}
