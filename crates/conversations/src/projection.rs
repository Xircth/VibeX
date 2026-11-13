mod applier;
mod cache;
mod fold;
mod rows;
mod runtime_status;

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

pub use self::{
    applier::{ConversationEventAppender, ConversationStateApplier},
    cache::{
        CachedRowProjector, ConversationRowProjectors, IncrementalRowProjector,
        evict_least_recently_used_projectors, extend_coalesced_row_ops,
    },
};
use self::{
    cache::{antigravity_conversation, decode_timeline_row_records, record_rebuilt_projector_fold},
    fold::ProjectedTurn,
    rows::{annotate_fork_point_rows, message_rows},
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
const SNAPSHOT_REFRESH_EVENT_GAP: i64 = 40;

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

pub struct ConversationProjector;

impl ConversationProjector {
    /// Project a conversation timeline, resuming from the materialized snapshot.
    ///
    /// Loads the snapshot fold (when its projection version matches) and replays only
    /// the tail (`events_since(last_sequence)`) instead of the whole event log — the
    /// root-cause fix for the read amplification in 架构报告 A-3 / 代码报告 §5.1.
    pub async fn project(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<ConversationTimeline, sqlx::Error> {
        let timeline = Self::fold(pool, conversation_id)
            .await?
            .into_timeline(conversation_id);
        annotate_fork_points(pool, timeline).await
    }

    /// Open-conversation window: last `limit` rows on the wire, stats from the
    /// materialized snapshot so truncated history is not treated as the session total.
    pub async fn project_open(
        pool: &SqlitePool,
        conversation_id: Uuid,
        limit: usize,
    ) -> Result<OpenConversationProjection, sqlx::Error> {
        if let Some(open) = Self::try_materialized_open(pool, conversation_id, limit).await? {
            let timeline = annotate_fork_points(pool, open.timeline).await?;
            return Ok(OpenConversationProjection {
                timeline,
                session_stats: open.session_stats,
            });
        }
        let fold = Self::fold(pool, conversation_id).await?;
        let session_stats = fold.session_stats();
        if let Err(error) = Self::persist_fold_to_pool(pool, conversation_id, &fold).await {
            tracing::warn!("conversation timeline row persist failed: {error}");
        }
        let timeline =
            annotate_fork_points(pool, fold.into_open_timeline(conversation_id, limit)).await?;
        Ok(OpenConversationProjection {
            timeline,
            session_stats,
        })
    }

    /// Page a row window without cloning the unrequested rows onto the response.
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
        if let Err(error) = Self::persist_fold_to_pool(pool, conversation_id, &fold).await {
            tracing::warn!("conversation timeline row persist failed: {error}");
        }
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

    /// Timeline rows whose state changed after `after_sequence` (`revision >
    /// after_sequence`), plus the conversation's last sequence. Powers gap backfill:
    /// the frontend upserts these rows. Pulls rows, not raw events.
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

    /// Load the snapshot fold for a conversation, or an empty fold when there is no
    /// usable snapshot (missing, or a stale projection version that must be rebuilt).
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
            let _ = Self::persist_fold_to_pool(pool, conversation_id, &fold).await;
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

    /// Refresh the materialized snapshot on turn settle, on side-row changes, and
    /// every `SNAPSHOT_REFRESH_EVENT_GAP` events during a long in-flight turn so
    /// detail/gap reloads do not replay the whole turn.
    pub(super) async fn refresh_snapshot_on_settle(
        conn: &mut SqliteConnection,
        record: &ConversationEventRecord,
    ) -> Result<(), sqlx::Error> {
        let settled = matches!(
            record.event_kind.as_str(),
            "turn_completed" | "turn_failed" | "turn_cancelled" | "turn_interrupted"
        );
        let side_row_changed = matches!(
            record.event_kind.as_str(),
            "delegation_started"
                | "delegation_completed"
                | "permission_requested"
                | "permission_responded"
                | "question_requested"
                | "question_responded"
                | "feedback_requested"
                | "feedback_submitted"
                | "agent_binding_load_failed"
                | "agent_connection_status_changed"
                | "request_activity_changed"
                | "agent_binding_ready"
                | "agent_binding_recovered"
                | "agent_binding_recovery_failed"
                | "raw_diagnostic_recorded"
                | "session_config_stale"
                | "announcements_updated"
                | "turn_blocked"
                | "file_change_summary_updated"
                | "artifact_revision_recorded"
                | "terminal_updated"
        );

        let conversation_id = record.conversation_id;
        let mut fold = Self::load_fold_from_snapshot(&mut *conn, conversation_id).await?;
        fold.complete_antigravity_reads =
            antigravity_conversation(&mut *conn, conversation_id).await?;
        if !settled
            && !side_row_changed
            && record.sequence - fold.last_sequence < SNAPSHOT_REFRESH_EVENT_GAP
        {
            return Ok(());
        }
        let tail = ConversationEventRecord::events_since(
            &mut *conn,
            conversation_id,
            fold.last_sequence,
            i64::MAX,
        )
        .await?;
        for record in &tail {
            fold.apply(record)?;
        }
        Self::persist_snapshot(&mut *conn, conversation_id, &fold).await?;

        if !settled {
            return Ok(());
        }

        // Best-effort full-text reindex from the freshly-settled projection.
        // A search-index failure must never block a turn from settling (P1-2).
        let external_session_id = sqlx::query_scalar::<_, Option<String>>(
            r#"SELECT COALESCE(
                (SELECT external_session_id FROM sessions WHERE id = ?1),
                (SELECT acp_session_id FROM conversation_agent_bindings
                 WHERE conversation_id = ?1 AND acp_session_id IS NOT NULL
                 ORDER BY created_at DESC LIMIT 1)
            )"#,
        )
        .bind(conversation_id)
        .fetch_optional(&mut *conn)
        .await
        .ok()
        .flatten()
        .flatten();
        let timeline = match crate::jsonl_history::flush_and_read_existing_transcript_turns(
            conversation_id,
            external_session_id.as_deref(),
        )
        .await
        {
            Some(turns) => crate::jsonl_history::timeline_from_turns(conversation_id, &turns),
            None => fold.into_timeline(conversation_id),
        };
        let body = crate::search::extract_searchable_text(&timeline);
        if let Err(error) =
            crate::search::reindex_conversation(&mut *conn, conversation_id, &body).await
        {
            tracing::warn!("conversation FTS reindex on settle failed: {error}");
        }
        Ok(())
    }

    /// Authoritatively rebuild the derived projection tables and the snapshot from the
    /// event log, in a single transaction. Use on a projection-version bump or to
    /// repair a detected inconsistency (架构报告 A-3 `rebuild_projection`).
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
                    return Err(error);
                }
                Ok(())
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(error)
            }
        }
    }

    pub(super) async fn rebuild_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        // Clear the purely event-derived projection rows. Turn rows are kept (they
        // carry the user's input from create_pending); their status is re-derived by
        // replaying the status events below.
        for table in [
            "conversation_inputs",
            "conversation_steering",
            "conversation_tool_calls",
            "conversation_permissions",
            "conversation_terminals",
            "conversation_file_changes",
            "conversation_usage_snapshots",
            "conversation_timeline_rows",
        ] {
            sqlx::query(&format!("DELETE FROM {table} WHERE conversation_id = ?"))
                .bind(conversation_id)
                .execute(&mut *conn)
                .await?;
        }
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
        Self::persist_snapshot(&mut *conn, conversation_id, &fold).await?;
        record_rebuilt_projector_fold(conversation_id, &fold);
        Ok(())
    }
}

#[derive(Default, Clone)]
pub(super) struct ProjectionFold {
    turns: BTreeMap<Uuid, ProjectedTurn>,
    turn_order: Vec<Uuid>,
    /// Side rows carry their own `row_id` + `revision` (the incremental row-op protocol,
    /// 消灭双投影). `revision` is the sequence of the latest event that touched the row.
    pub(crate) side_rows: Vec<TimelineRow>,
    pub(crate) last_sequence: i64,
    auto_permission_approvals: u32,
    /// Antigravity reports view_file failures for cascade and provider errors
    /// that are not the read. Not part of the snapshot: set from the binding
    /// before events are folded.
    complete_antigravity_reads: bool,
}

/// Serializable form of [`ProjectionFold`] (turns kept in order, no map keys → portable JSON).
#[derive(Default, Serialize, Deserialize)]
pub(super) struct ProjectionSnapshotState {
    turns: Vec<ProjectedTurn>,
    side_rows: Vec<TimelineRow>,
    last_sequence: i64,
    #[serde(default)]
    auto_permission_approvals: u32,
}

impl ProjectionFold {
    pub(super) fn from_snapshot_state(state: ProjectionSnapshotState) -> Self {
        let mut fold = ProjectionFold {
            turn_order: Vec::with_capacity(state.turns.len()),
            last_sequence: state.last_sequence,
            side_rows: state.side_rows,
            auto_permission_approvals: state.auto_permission_approvals,
            ..ProjectionFold::default()
        };
        for turn in state.turns {
            fold.turn_order.push(turn.turn_id);
            fold.turns.insert(turn.turn_id, turn);
        }
        fold
    }

    pub(super) fn to_snapshot_state(&self) -> ProjectionSnapshotState {
        let turns = self
            .turn_order
            .iter()
            .filter_map(|turn_id| self.turns.get(turn_id).cloned())
            .collect();
        ProjectionSnapshotState {
            turns,
            side_rows: self.side_rows.clone(),
            last_sequence: self.last_sequence,
            auto_permission_approvals: self.auto_permission_approvals,
        }
    }

    /// Fold one event into the projection **and** return the incremental row ops it
    /// produced (the single-projection realtime protocol, 消灭双投影). Callers that only
    /// want the folded state (`project`, `project_records`) discard the ops.
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

    fn into_open_timeline(self, conversation_id: Uuid, limit: usize) -> ConversationTimeline {
        let (mut rows, last_sequence) = self.collect_rows();
        let total = rows.len();
        let truncated = limit > 0 && total > limit;
        let start = if truncated { total - limit } else { 0 };
        if truncated {
            rows = rows.split_off(start);
        }
        let mut timeline = ConversationTimeline {
            conversation_id,
            projection_version: CONVERSATION_PROJECTION_VERSION,
            last_sequence,
            rows,
            truncated_from_start: truncated,
            older_cursor: truncated.then(|| start.to_string()),
        };
        cap_timeline_preview_fields(&mut timeline);
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
            if !turn.assistant.blocks.is_empty() {
                turns.push(&turn.assistant);
            }
        }
        session_stats_from_turns(&turns)
    }

    fn changed_rows_since(&self, after_sequence: i64) -> Vec<TimelineRow> {
        let mut rows = Vec::new();
        for turn_id in &self.turn_order {
            let Some(turn) = self.turns.get(turn_id) else {
                continue;
            };
            if turn.revision <= after_sequence {
                continue;
            }
            rows.extend(message_rows(turn));
        }
        rows.extend(
            self.side_rows
                .iter()
                .filter(|row| row.revision > after_sequence)
                .cloned(),
        );
        for row in &mut rows {
            cap_timeline_row_preview_fields(row);
        }
        rows
    }

    fn seed_user_prompt_from_session(&mut self, conversation_id: Uuid, prompt: Option<&str>) {
        let Some(prompt) = prompt.map(str::trim).filter(|value| !value.is_empty()) else {
            return;
        };
        if self.turns.values().any(|turn| !turn.user.blocks.is_empty()) {
            return;
        }
        let turn_id = self.turn_order.first().copied().unwrap_or(conversation_id);
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
                    pending_steering: None,
                    phase: "settled".into(),
                    revision: self.last_sequence.max(1),
                    usage_announced: false,
                    trailing_raw_text: String::new(),
                    emitted_internal_count: 0,
                },
            );
            return;
        }
        if let Some(turn) = self.turns.get_mut(&turn_id) {
            turn.user.blocks = vec![ContentBlock::Text {
                text: prompt.to_string(),
            }];
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
        ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id).await?
    else {
        return Ok((false, None));
    };
    let capabilities =
        serde_json::from_str::<AcpCapabilitySnapshot>(&binding.session_capabilities_json)
            .unwrap_or_default();
    let agent_kind = agents::AgentKind::from_str(binding.agent_id.as_str()).ok();
    Ok((capabilities.fork_session, agent_kind))
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
        let used = usage.input_tokens
            + usage.output_tokens
            + usage.cache_creation_input_tokens
            + usage.cache_read_input_tokens;
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
