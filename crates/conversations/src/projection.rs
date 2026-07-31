use std::collections::BTreeMap;

use agents::conversation::{
    ContentBlock, ConversationDelegationResult, ConversationDelegationView, ConversationErrorView,
    ConversationEvent, ConversationPermissionView, ConversationRowOp, ConversationSessionNotice,
    ConversationTerminalView, ConversationTimeline, ConversationTimelineRow, MessageTurn,
    PlanEntry, SessionLoadFailureReason, TimelineRow, TimelineTextStream, TurnRole, TurnUsage,
};
use db::models::{
    conversation_event::{
        AppendConversationEvent, ConversationEventRecord, find_conversation_event_by_idempotency,
        insert_conversation_event,
    },
    conversation_side_effects::{
        ConversationFileChangeRecord, ConversationPermissionRecord, ConversationTerminalRecord,
        InsertConversationFileChange, UpsertConversationPermission, UpsertConversationTerminal,
    },
    conversation_snapshot::ConversationProjectionSnapshotRecord,
    conversation_tool::{ConversationToolCallRecord, UpsertConversationToolCall},
    conversation_turn::ConversationTurnRecord,
};
use serde::{Deserialize, Serialize};
use sqlx::{Executor, Sqlite, SqliteConnection, SqlitePool};
use uuid::Uuid;

// v3: Artifact revisions now project into timeline side rows. v2 snapshots may
// already have advanced past Artifact events while ignoring them, so they must
// be discarded and rebuilt by `load_fold_from_snapshot`.
pub const CONVERSATION_PROJECTION_VERSION: u32 = 3;

pub struct ConversationEventAppender;

impl ConversationEventAppender {
    /// Append an event and apply its projection side-effects **atomically**.
    ///
    /// Root-cause fix for 架构报告 A-3: the event insert, the derived-table projection
    /// (`apply_record`), and the snapshot refresh now run inside a single
    /// `BEGIN IMMEDIATE` transaction. If anything fails the whole thing rolls back, so
    /// the event log and its projection can never drift out of sync.
    pub async fn append(
        pool: &SqlitePool,
        input: AppendConversationEvent<'_>,
    ) -> Result<ConversationEventRecord, sqlx::Error> {
        let mut conn = pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

        match Self::append_and_apply(&mut conn, input).await {
            Ok(record) => {
                if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                    return Err(error);
                }
                Ok(record)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(error)
            }
        }
    }

    async fn append_and_apply(
        conn: &mut SqliteConnection,
        input: AppendConversationEvent<'_>,
    ) -> Result<ConversationEventRecord, sqlx::Error> {
        // Idempotency is checked inside the IMMEDIATE transaction so it is serialized
        // with concurrent appends. A duplicate's side-effects were already applied at
        // first insert, so return it without re-applying (avoids double inserts).
        if let Some(existing) = find_conversation_event_by_idempotency(
            conn,
            input.conversation_id,
            input.idempotency_key,
        )
        .await?
        {
            return Ok(existing);
        }

        let record = insert_conversation_event(conn, input).await?;
        ConversationStateApplier::apply_record(conn, &record).await?;
        ConversationProjector::refresh_snapshot_on_settle(conn, &record).await?;
        Ok(record)
    }
}

pub struct ConversationStateApplier;

impl ConversationStateApplier {
    /// Apply one event's side-effects to the derived projection tables.
    ///
    /// Takes a `&mut SqliteConnection` (not a pool) so it participates in the caller's
    /// transaction — either the append transaction or a projection rebuild.
    pub async fn apply_record(
        conn: &mut SqliteConnection,
        record: &ConversationEventRecord,
    ) -> Result<(), sqlx::Error> {
        // An event this build can't parse has no derived-table side-effects we can
        // safely apply, so skip it. It still surfaces to the user as a placeholder
        // row via the projection fold (`ProjectionFold::apply`).
        let event = match conversation_event_from_record(record) {
            ParsedEvent::Known(event) => event,
            ParsedEvent::Unknown { .. } => return Ok(()),
        };

        match event {
            ConversationEvent::UserTurnQueued => {
                if let Some(turn_id) = record.turn_id {
                    ConversationTurnRecord::mark_queued(&mut *conn, turn_id).await?;
                }
            }
            ConversationEvent::UserTurnStarted => {
                if let Some(turn_id) = record.turn_id {
                    ConversationTurnRecord::mark_running(&mut *conn, turn_id).await?;
                }
            }
            ConversationEvent::TurnBlocked { .. } => {
                if let Some(turn_id) = record.turn_id {
                    ConversationTurnRecord::mark_blocked(&mut *conn, turn_id).await?;
                }
            }
            ConversationEvent::TurnCompleted { stop_reason } => {
                if let Some(turn_id) = record.turn_id {
                    ConversationTurnRecord::mark_completed(
                        &mut *conn,
                        turn_id,
                        stop_reason.as_deref(),
                        None,
                        None,
                    )
                    .await?;
                }
            }
            ConversationEvent::TurnFailed { error } => {
                if let Some(turn_id) = record.turn_id {
                    let error_json = json_string(&error)?;
                    ConversationTurnRecord::mark_failed(&mut *conn, turn_id, &error_json).await?;
                }
            }
            ConversationEvent::TurnCancelled { reason } => {
                if let Some(turn_id) = record.turn_id {
                    let reason_json =
                        reason.map(|message| serde_json::json!({ "message": message }).to_string());
                    ConversationTurnRecord::mark_cancelled(
                        &mut *conn,
                        turn_id,
                        reason_json.as_deref(),
                    )
                    .await?;
                }
            }
            ConversationEvent::TurnInterrupted { reason } => {
                if let Some(turn_id) = record.turn_id {
                    let reason_json =
                        reason.map(|message| serde_json::json!({ "message": message }).to_string());
                    ConversationTurnRecord::mark_interrupted(
                        &mut *conn,
                        turn_id,
                        reason_json.as_deref(),
                    )
                    .await?;
                }
            }
            ConversationEvent::ToolCallUpsert { tool_call } => {
                if let Some(turn_id) = record.turn_id {
                    let raw_input_json = json_string_ref(&tool_call.raw_input)?;
                    let raw_output_json = json_string_ref(&tool_call.raw_output)?;
                    let content_json = json_string_ref(&tool_call.content)?;
                    let locations_json = json_string_ref(&tool_call.locations)?;
                    let metadata_json = json_string_ref(&tool_call.metadata)?;
                    let images_json = if tool_call.images.is_empty() {
                        None
                    } else {
                        Some(json_string(&tool_call.images)?)
                    };
                    ConversationToolCallRecord::upsert(
                        &mut *conn,
                        UpsertConversationToolCall {
                            id: Uuid::new_v4(),
                            conversation_id: record.conversation_id,
                            turn_id,
                            tool_call_id: &tool_call.tool_call_id,
                            title: tool_call.title.as_deref(),
                            kind: tool_call.kind.as_deref(),
                            status: tool_call.status.as_deref().unwrap_or("running"),
                            raw_input_json: raw_input_json.as_deref(),
                            raw_output_json: raw_output_json.as_deref(),
                            content_json: content_json.as_deref(),
                            locations_json: locations_json.as_deref(),
                            metadata_json: metadata_json.as_deref(),
                            images_json: images_json.as_deref(),
                        },
                    )
                    .await?;
                }
            }
            ConversationEvent::PermissionRequested { request } => {
                if let Some(turn_id) = record.turn_id {
                    let details_json = request
                        .request
                        .details
                        .as_ref()
                        .map(json_string)
                        .transpose()?
                        .unwrap_or_else(|| "{}".to_string());
                    let options_json = json_string(&request.request.options)?;
                    ConversationPermissionRecord::upsert_pending(
                        &mut *conn,
                        UpsertConversationPermission {
                            id: Uuid::new_v4(),
                            conversation_id: record.conversation_id,
                            turn_id,
                            permission_id: &request.permission_id,
                            title: Some(&request.request.title),
                            details_json: &details_json,
                            options_json: &options_json,
                            auto: false,
                        },
                    )
                    .await?;
                }
            }
            ConversationEvent::PermissionResponded {
                permission_id,
                response,
            } => {
                let response_json = json_string(&response)?;
                ConversationPermissionRecord::respond(
                    &mut *conn,
                    record.conversation_id,
                    &permission_id,
                    &response_json,
                )
                .await?;
            }
            ConversationEvent::TerminalUpdated { terminal } => {
                if let Some(turn_id) = record.turn_id {
                    let args_json = json_string(&terminal.args)?;
                    let exit_status_json = json_string_ref(&terminal.exit_status)?;
                    ConversationTerminalRecord::upsert(
                        &mut *conn,
                        UpsertConversationTerminal {
                            id: Uuid::new_v4(),
                            conversation_id: record.conversation_id,
                            turn_id,
                            terminal_id: &terminal.terminal_id,
                            command: terminal.command.as_deref(),
                            args_json: &args_json,
                            cwd: terminal.cwd.as_deref(),
                            status: &terminal.status,
                            output_summary: terminal.output_summary.as_deref(),
                            output_truncated: terminal.output_truncated,
                            exit_status_json: exit_status_json.as_deref(),
                        },
                    )
                    .await?;
                }
            }
            ConversationEvent::FileChangeSummaryUpdated { summary } => {
                if let Some(turn_id) = record.turn_id {
                    for file in summary.files {
                        ConversationFileChangeRecord::insert(
                            &mut *conn,
                            InsertConversationFileChange {
                                id: Uuid::new_v4(),
                                conversation_id: record.conversation_id,
                                turn_id,
                                source: &summary.source,
                                path: &file.path,
                                change_kind: &file.change_kind,
                                additions: file.additions,
                                deletions: file.deletions,
                                old_path: file.old_path.as_deref(),
                                diff_summary_json: summary.summary.as_deref(),
                            },
                        )
                        .await?;
                    }
                }
            }
            _ => {}
        }

        Ok(())
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
        let mut fold = Self::load_fold_from_snapshot(pool, conversation_id).await?;
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
        Ok(fold.into_timeline(conversation_id))
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
        let timeline = Self::project(pool, conversation_id).await?;
        let last_sequence = timeline.last_sequence;
        let rows = timeline
            .rows
            .into_iter()
            .filter(|row| row.revision > after_sequence)
            .collect();
        Ok((rows, last_sequence))
    }

    /// Load the snapshot fold for a conversation, or an empty fold when there is no
    /// usable snapshot (missing, or a stale projection version that must be rebuilt).
    async fn load_fold_from_snapshot<'e, E>(
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

    /// Refresh the materialized snapshot when a turn settles, inside the append
    /// transaction. Loads the prior snapshot and folds only this turn's tail, so the
    /// cost is bounded by the turn rather than the whole conversation.
    pub(super) async fn refresh_snapshot_on_settle(
        conn: &mut SqliteConnection,
        record: &ConversationEventRecord,
    ) -> Result<(), sqlx::Error> {
        if !matches!(
            record.event_kind.as_str(),
            "turn_completed" | "turn_failed" | "turn_cancelled" | "turn_interrupted"
        ) {
            return Ok(());
        }

        let conversation_id = record.conversation_id;
        let mut fold = Self::load_fold_from_snapshot(&mut *conn, conversation_id).await?;
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

        // Best-effort full-text reindex from the freshly-settled projection.
        // A search-index failure must never block a turn from settling (P1-2).
        let timeline = fold.into_timeline(conversation_id);
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

    async fn rebuild_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        // Clear the purely event-derived projection rows. Turn rows are kept (they
        // carry the user's input from create_pending); their status is re-derived by
        // replaying the status events below.
        for table in [
            "conversation_tool_calls",
            "conversation_permissions",
            "conversation_terminals",
            "conversation_file_changes",
        ] {
            sqlx::query(&format!("DELETE FROM {table} WHERE conversation_id = ?"))
                .bind(conversation_id)
                .execute(&mut *conn)
                .await?;
        }

        let events =
            ConversationEventRecord::events_since(&mut *conn, conversation_id, 0, i64::MAX).await?;
        let mut fold = ProjectionFold::default();
        for record in &events {
            ConversationStateApplier::apply_record(&mut *conn, record).await?;
            fold.apply(record)?;
        }
        Self::persist_snapshot(&mut *conn, conversation_id, &fold).await
    }

    /// Truncate the conversation to *before* the user turn at `ordinal`: delete that
    /// turn and every later turn, drop every event from that turn onward, then rebuild
    /// the derived projection + snapshot — all in one `BEGIN IMMEDIATE` transaction.
    /// Powers reset-to-here / retry. No-op if no turn has that ordinal.
    pub async fn truncate_to_turn_ordinal(
        pool: &SqlitePool,
        conversation_id: Uuid,
        ordinal: i64,
    ) -> Result<(), sqlx::Error> {
        let mut conn = pool.acquire().await?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

        match Self::truncate_on_connection(&mut conn, conversation_id, ordinal).await {
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

    async fn truncate_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        ordinal: i64,
    ) -> Result<(), sqlx::Error> {
        // The first event sequence owned by the target turn (or any later turn) is the
        // truncation cut: dropping events at/after it removes the target turn and
        // everything that followed, while turn-less infra events before it stay put.
        let cut_sequence: Option<i64> = sqlx::query_scalar(
            r#"SELECT MIN(events.sequence)
               FROM conversation_events events
               JOIN conversation_turns turns ON events.turn_id = turns.id
               WHERE events.conversation_id = ? AND turns.ordinal >= ?"#,
        )
        .bind(conversation_id)
        .bind(ordinal)
        .fetch_one(&mut *conn)
        .await?;

        if let Some(cut_sequence) = cut_sequence {
            sqlx::query(
                r#"DELETE FROM conversation_events
                   WHERE conversation_id = ? AND sequence >= ?"#,
            )
            .bind(conversation_id)
            .bind(cut_sequence)
            .execute(&mut *conn)
            .await?;
        }

        sqlx::query(
            r#"DELETE FROM conversation_turns
               WHERE conversation_id = ? AND ordinal >= ?"#,
        )
        .bind(conversation_id)
        .bind(ordinal)
        .execute(&mut *conn)
        .await?;

        // Re-derive the side-effect tables + snapshot from the surviving events.
        Self::rebuild_on_connection(conn, conversation_id).await?;

        // Best-effort full-text reindex — truncate removed message text, so the
        // stale index would otherwise still match the discarded turns (P1-2).
        let reindex = async {
            let fold = Self::load_fold_from_snapshot(&mut *conn, conversation_id).await?;
            let timeline = fold.into_timeline(conversation_id);
            let body = crate::search::extract_searchable_text(&timeline);
            crate::search::reindex_conversation(&mut *conn, conversation_id, &body).await
        }
        .await;
        if let Err(error) = reindex {
            tracing::warn!("conversation FTS reindex on truncate failed: {error}");
        }
        Ok(())
    }

    async fn persist_snapshot<'e, E>(
        executor: E,
        conversation_id: Uuid,
        fold: &ProjectionFold,
    ) -> Result<(), sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        let fold_json =
            serde_json::to_string(&fold.to_snapshot_state()).map_err(json_decode_error)?;
        ConversationProjectionSnapshotRecord::upsert(
            executor,
            conversation_id,
            CONVERSATION_PROJECTION_VERSION as i64,
            fold.last_sequence,
            &fold_json,
        )
        .await
    }
}

/// A live, per-conversation incremental projector: it holds the folded state in
/// memory and turns each newly-appended event into row ops via [`ProjectionFold::apply`]
/// — the O(1)-amortized realtime path that eliminates the double projection. One
/// instance is cached per active conversation (dropped on close);
/// `emit_conversation_row_ops_after` in the Tauri layer feeds it in sequence order.
pub struct IncrementalRowProjector {
    fold: ProjectionFold,
}

impl IncrementalRowProjector {
    /// A projector positioned exactly at `up_to_sequence` (snapshot + replay of every
    /// event ≤ up_to, without emitting), ready to fold newer events into ops.
    pub async fn load(
        pool: &SqlitePool,
        conversation_id: Uuid,
        up_to_sequence: i64,
    ) -> Result<Self, sqlx::Error> {
        let mut fold =
            ConversationProjector::load_fold_from_snapshot(pool, conversation_id).await?;
        // A snapshot ahead of the cursor (e.g. after a truncate/retry rewind) can't be
        // reused — rebuild from the event log.
        if fold.last_sequence > up_to_sequence {
            fold = ProjectionFold::default();
        }
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
        Ok(Self { fold })
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
}

/// Mutable accumulator that folds events into a conversation timeline. Persisted to
/// the snapshot table via [`ProjectionSnapshotState`] so reads can resume from it.
#[derive(Default)]
struct ProjectionFold {
    turns: BTreeMap<Uuid, ProjectedTurn>,
    turn_order: Vec<Uuid>,
    /// Side rows carry their own `row_id` + `revision` (the incremental row-op protocol,
    /// 消灭双投影). `revision` is the sequence of the latest event that touched the row.
    side_rows: Vec<TimelineRow>,
    last_sequence: i64,
}

/// Serializable form of [`ProjectionFold`] (turns kept in order, no map keys → portable JSON).
#[derive(Default, Serialize, Deserialize)]
struct ProjectionSnapshotState {
    turns: Vec<ProjectedTurn>,
    side_rows: Vec<TimelineRow>,
    last_sequence: i64,
}

impl ProjectionFold {
    fn from_snapshot_state(state: ProjectionSnapshotState) -> Self {
        let mut fold = ProjectionFold {
            last_sequence: state.last_sequence,
            side_rows: state.side_rows,
            ..ProjectionFold::default()
        };
        for turn in state.turns {
            fold.turn_order.push(turn.turn_id);
            fold.turns.insert(turn.turn_id, turn);
        }
        fold
    }

    fn to_snapshot_state(&self) -> ProjectionSnapshotState {
        let turns = self
            .turn_order
            .iter()
            .filter_map(|turn_id| self.turns.get(turn_id).cloned())
            .collect();
        ProjectionSnapshotState {
            turns,
            side_rows: self.side_rows.clone(),
            last_sequence: self.last_sequence,
        }
    }

    /// Fold one event into the projection **and** return the incremental row ops it
    /// produced (the single-projection realtime protocol, 消灭双投影). Callers that only
    /// want the folded state (`project`, `project_records`) discard the ops.
    fn apply(
        &mut self,
        record: &ConversationEventRecord,
    ) -> Result<Vec<ConversationRowOp>, sqlx::Error> {
        self.last_sequence = self.last_sequence.max(record.sequence);
        let event = match conversation_event_from_record(record) {
            ParsedEvent::Known(event) => event,
            ParsedEvent::Unknown { kind, .. } => {
                // Forward-incompatible event (written by a newer app version): keep the
                // rest of the timeline folding and mark its slot with a placeholder row.
                tracing::warn!(
                    event_kind = %kind,
                    sequence = record.sequence,
                    "conversation event not renderable by this build; showing placeholder row"
                );
                let row = side_row(
                    record.sequence,
                    ConversationTimelineRow::SessionNotice {
                        notice: ConversationSessionNotice {
                            title: "此事件由更新版本产生，无法显示".into(),
                            message: None,
                            severity: "warning".into(),
                        },
                    },
                );
                let op = ConversationRowOp::Upsert { row: row.clone() };
                self.side_rows.push(row);
                return Ok(vec![op]);
            }
        };

        // Streaming text/reasoning: fold the delta into the assistant blocks and emit a
        // cheap `AppendText` — never a full-row upsert — so a long reply doesn't
        // re-broadcast its whole text every frame (the O(n²) this batch kills).
        if let ConversationEvent::AssistantTextDelta { ref text, .. }
        | ConversationEvent::AssistantReasoningDelta { ref text, .. } = event
            && let Some(turn_id) = record.turn_id
        {
            let stream = if matches!(event, ConversationEvent::AssistantReasoningDelta { .. }) {
                TimelineTextStream::Reasoning
            } else {
                TimelineTextStream::Text
            };
            ensure_turn(&mut self.turns, &mut self.turn_order, turn_id, record);
            let turn = self.turns.get_mut(&turn_id).expect("turn exists");
            match stream {
                TimelineTextStream::Text => {
                    append_text_block(&mut turn.assistant.blocks, text.clone())
                }
                TimelineTextStream::Reasoning => {
                    append_thinking_block(&mut turn.assistant.blocks, text.clone())
                }
            }
            turn.revision = record.sequence;
            return Ok(vec![ConversationRowOp::AppendText {
                row_id: turn.assistant.id.clone(),
                revision: record.sequence,
                stream,
                delta: text.clone(),
            }]);
        }

        // Bump the touched turn's revision so its message rows re-upsert at this
        // sequence. Over-bumping on a side-row event is harmless — the frontend upsert
        // is idempotent by revision. A brand-new turn gets its revision from
        // `ensure_turn` below (it does not exist here yet).
        if let Some(turn_id) = record.turn_id
            && let Some(turn) = self.turns.get_mut(&turn_id)
        {
            turn.revision = record.sequence;
        }

        let turns = &mut self.turns;
        let turn_order = &mut self.turn_order;
        let side_rows = &mut self.side_rows;

        match event {
            ConversationEvent::UserTurnCreated { blocks } => {
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    turn.user.blocks = blocks
                        .into_iter()
                        .filter_map(|block| match block {
                            agents::conversation::ConversationInputBlock::Text { text } => {
                                Some(ContentBlock::Text { text })
                            }
                            agents::conversation::ConversationInputBlock::Image {
                                uri,
                                mime_type,
                                ..
                            } => Some(ContentBlock::Image {
                                data: String::new(),
                                mime_type,
                                uri: Some(uri),
                            }),
                            agents::conversation::ConversationInputBlock::Resource { .. } => None,
                            agents::conversation::ConversationInputBlock::Protocol { .. } => None,
                        })
                        .collect();
                }
            }
            ConversationEvent::PlanUpdated { entries } => {
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    turn.assistant.blocks.push(ContentBlock::Plan {
                        entries: entries
                            .into_iter()
                            .map(|entry| PlanEntry {
                                content: entry.content,
                                status: entry.status,
                                priority: entry.priority,
                            })
                            .collect(),
                    });
                }
            }
            ConversationEvent::ToolCallUpsert { tool_call } => {
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    let call_id = tool_call.tool_call_id.clone();

                    // Upsert semantics: a tool_call_update must fold into the
                    // existing card, not spawn a second titleless block.
                    let existing_use =
                        turn.assistant
                            .blocks
                            .iter_mut()
                            .find_map(|block| match block {
                                ContentBlock::ToolUse {
                                    tool_use_id: Some(id),
                                    tool_name,
                                    kind,
                                    input_preview,
                                    ..
                                } if *id == call_id => Some((tool_name, kind, input_preview)),
                                _ => None,
                            });
                    match existing_use {
                        Some((tool_name, kind, input_preview)) => {
                            if let Some(title) = tool_call.title {
                                *tool_name = title;
                            }
                            if tool_call.kind.is_some() {
                                *kind = tool_call.kind;
                            }
                            if let Some(raw) = tool_call.raw_input {
                                *input_preview = Some(raw.to_string());
                            }
                        }
                        None => {
                            turn.assistant.blocks.push(ContentBlock::ToolUse {
                                tool_use_id: Some(call_id.clone()),
                                tool_name: tool_call
                                    .title
                                    .clone()
                                    .or(tool_call.kind.clone())
                                    .unwrap_or_else(|| call_id.clone()),
                                kind: tool_call.kind.clone(),
                                input_preview: tool_call
                                    .raw_input
                                    .as_ref()
                                    .map(|value| value.to_string()),
                                meta: tool_call.metadata.clone(),
                            });
                        }
                    }

                    // Attach/refresh the paired result so the card's status dot
                    // settles: on output, or on a terminal status without one.
                    let is_error = matches!(tool_call.status.as_deref(), Some("failed"));
                    let terminal = matches!(
                        tool_call.status.as_deref(),
                        Some("completed") | Some("failed")
                    );
                    let output_preview = tool_call.raw_output.map(|output| match output {
                        serde_json::Value::String(text) => text,
                        other => other.to_string(),
                    });
                    if output_preview.is_some() || terminal {
                        let existing_result =
                            turn.assistant
                                .blocks
                                .iter_mut()
                                .find_map(|block| match block {
                                    ContentBlock::ToolResult {
                                        tool_use_id: Some(id),
                                        output_preview,
                                        is_error,
                                        ..
                                    } if *id == call_id => Some((output_preview, is_error)),
                                    _ => None,
                                });
                        match existing_result {
                            Some((existing_output, existing_error)) => {
                                if output_preview.is_some() {
                                    *existing_output = output_preview;
                                }
                                *existing_error = is_error;
                            }
                            None => {
                                turn.assistant.blocks.push(ContentBlock::ToolResult {
                                    tool_use_id: Some(call_id),
                                    output_preview,
                                    is_error,
                                    agent_stats: None,
                                });
                            }
                        }
                    }
                }
            }
            ConversationEvent::UsageUpdated { usage } => {
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    turn.assistant.usage = Some(TurnUsage {
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                        cache_creation_input_tokens: usage.cache_creation_input_tokens,
                        cache_read_input_tokens: usage.cache_read_input_tokens,
                        context_window_max: usage.context_window_max,
                        cost_amount: usage.cost_amount,
                        cost_currency: usage.cost_currency.clone(),
                    });
                }
            }
            // ACP session metadata is preserved in the durable event log. It is
            // intentionally not folded into VibeX conversation identity/title.
            ConversationEvent::AgentSessionInfoUpdated { .. } => {}
            ConversationEvent::TurnCompleted { .. } => {
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    turns.get_mut(&turn_id).expect("turn exists").phase = "settled".into();
                }
            }
            ConversationEvent::TurnInterrupted { .. } => {
                // Mark the turn's phase so the timeline renders the "因重启中断" state
                // with a one-click resend affordance (the user prompt lives on the
                // turn's user row). Never auto-retried — ADR-0001.
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    turns.get_mut(&turn_id).expect("turn exists").phase = "interrupted".into();
                }
            }
            ConversationEvent::PermissionRequested { request } => {
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::PermissionRequest {
                        request: ConversationPermissionView {
                            permission_id: request.permission_id,
                            title: Some(request.request.title),
                            status: "pending".into(),
                            details: request.request.details,
                            options: request.request.options,
                        },
                    },
                ));
            }
            ConversationEvent::PermissionResponded { permission_id, .. } => {
                // Fold the response onto the pending permission row so a rebuilt
                // projection matches the live store (which sets `status: 'responded'`)
                // — otherwise an answered (or recovery-voided, ADR-0001) permission
                // reloads as perpetually pending.
                for entry in side_rows.iter_mut() {
                    if let ConversationTimelineRow::PermissionRequest { request } = &mut entry.row
                        && request.permission_id == permission_id
                    {
                        request.status = "responded".into();
                        entry.revision = record.sequence;
                        break;
                    }
                }
            }
            ConversationEvent::QuestionRequested { request } => {
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::QuestionRequest {
                        request,
                        response: None,
                    },
                ));
            }
            ConversationEvent::QuestionResponded {
                question_id,
                response,
            } => {
                // Fold the answer onto the pending question row so a rebuilt projection
                // no longer shows answered questions as perpetually pending.
                for entry in side_rows.iter_mut() {
                    if let ConversationTimelineRow::QuestionRequest {
                        request,
                        response: slot,
                    } = &mut entry.row
                        && request.question_id == question_id
                    {
                        *slot = Some(response);
                        entry.revision = record.sequence;
                        break;
                    }
                }
            }
            ConversationEvent::FeedbackRequested { request } => {
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::FeedbackRequest {
                        request,
                        response: None,
                    },
                ));
            }
            ConversationEvent::FeedbackSubmitted {
                feedback_id,
                response,
            } => {
                for entry in side_rows.iter_mut() {
                    if let ConversationTimelineRow::FeedbackRequest {
                        request,
                        response: slot,
                    } = &mut entry.row
                        && request.feedback_id == feedback_id
                    {
                        *slot = Some(response);
                        entry.revision = record.sequence;
                        break;
                    }
                }
            }
            ConversationEvent::TerminalUpdated { terminal } => {
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::TerminalSummary {
                        terminal: ConversationTerminalView {
                            terminal_id: terminal.terminal_id,
                            command: terminal.command,
                            status: terminal.status,
                            output_summary: terminal.output_summary,
                            output_truncated: terminal.output_truncated,
                        },
                    },
                ));
            }
            ConversationEvent::DelegationStarted { delegation } => {
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::Delegation {
                        delegation: ConversationDelegationView {
                            delegation_id: delegation.delegation_id,
                            parent_tool_call_id: Some(delegation.parent_tool_call_id),
                            child_conversation_id: Some(delegation.child_conversation_id),
                            agent_id: Some(delegation.agent_id),
                            task_preview: Some(delegation.task_preview),
                            status: "running".into(),
                            result: None,
                        },
                    },
                ));
            }
            ConversationEvent::DelegationCompleted {
                delegation_id,
                result,
            } => {
                // Fold the outcome onto the running delegation row so a rebuilt
                // projection shows one card per delegation (keeping agent_type,
                // task_preview, child_conversation_id from the start event) rather
                // than a second, context-less "completed" row.
                let status = match &result {
                    ConversationDelegationResult::Ok { .. } => "completed",
                    ConversationDelegationResult::Err { error }
                        if matches!(
                            error.code.as_deref(),
                            Some("canceled" | "cancelled" | "request_cancelled")
                        ) =>
                    {
                        "canceled"
                    }
                    ConversationDelegationResult::Err { .. } => "failed",
                };
                let mut merged = false;
                for entry in side_rows.iter_mut() {
                    if let ConversationTimelineRow::Delegation { delegation } = &mut entry.row
                        && delegation.delegation_id == delegation_id
                    {
                        delegation.status = status.into();
                        delegation.result = Some(result.clone());
                        entry.revision = record.sequence;
                        merged = true;
                        break;
                    }
                }
                if !merged {
                    side_rows.push(side_row(
                        record.sequence,
                        ConversationTimelineRow::Delegation {
                            delegation: ConversationDelegationView {
                                delegation_id,
                                parent_tool_call_id: None,
                                child_conversation_id: None,
                                agent_id: None,
                                task_preview: None,
                                status: status.into(),
                                result: Some(result),
                            },
                        },
                    ));
                }
            }
            ConversationEvent::FileChangeSummaryUpdated { summary } => {
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::FileChangeSummary {
                        summary,
                        turn_id: record.turn_id,
                    },
                ));
            }
            ConversationEvent::ArtifactRevisionRecorded { artifact } => {
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::ArtifactRevision { artifact },
                ));
            }
            ConversationEvent::TurnFailed { error } => {
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::TurnError {
                        error: ConversationErrorView {
                            turn_id: record.turn_id,
                            error,
                        },
                    },
                ));
            }
            ConversationEvent::AgentBindingLoadFailed { reason } => {
                // Reload path must read the same as the live path: a legible,
                // code-aware notice — not a raw debug blob.
                let notice = match reason {
                    SessionLoadFailureReason::ResourceNotFound => ConversationSessionNotice {
                        title: "代理会话已过期".into(),
                        message: Some("代理侧已不存在该会话，将在下一条消息时重新建立。".into()),
                        severity: "warning".into(),
                    },
                    SessionLoadFailureReason::AuthenticationRequired { message } => {
                        ConversationSessionNotice {
                            title: "需要重新认证".into(),
                            message: Some(message),
                            severity: "error".into(),
                        }
                    }
                    SessionLoadFailureReason::Unsupported => ConversationSessionNotice {
                        title: "代理不支持会话恢复".into(),
                        message: Some("已自动新建会话继续。".into()),
                        severity: "info".into(),
                    },
                    SessionLoadFailureReason::Other { message } => ConversationSessionNotice {
                        title: "加载代理会话失败".into(),
                        message: Some(message),
                        severity: "warning".into(),
                    },
                };
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::SessionNotice { notice },
                ));
            }
            ConversationEvent::AgentBindingRecoveryFailed { reason } => {
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::SessionNotice {
                        notice: ConversationSessionNotice {
                            title: "Agent session recovery failed".into(),
                            message: Some(reason),
                            severity: "error".into(),
                        },
                    },
                ));
            }
            ConversationEvent::SessionConfigStale { stale, reason } => {
                if stale {
                    side_rows.push(side_row(
                        record.sequence,
                        ConversationTimelineRow::SessionNotice {
                            notice: ConversationSessionNotice {
                                title: "Agent configuration changed".into(),
                                message: reason,
                                severity: "info".into(),
                            },
                        },
                    ));
                }
            }
            _ => {}
        }

        // Every row this event touched carries `revision == record.sequence` now, so
        // emit an `Upsert` for each — the message row(s) of the touched turn and any
        // created/modified side row. (Streaming text already returned early above.)
        let mut ops = Vec::new();
        if let Some(turn_id) = record.turn_id
            && let Some(turn) = self.turns.get(&turn_id)
            && turn.revision == record.sequence
        {
            ops.push(ConversationRowOp::Upsert {
                row: message_row(turn, TurnRole::User),
            });
            if !turn.assistant.blocks.is_empty() {
                ops.push(ConversationRowOp::Upsert {
                    row: message_row(turn, TurnRole::Assistant),
                });
            }
        }
        for row in &self.side_rows {
            if row.revision == record.sequence {
                ops.push(ConversationRowOp::Upsert { row: row.clone() });
            }
        }
        Ok(ops)
    }

    fn into_timeline(self, conversation_id: Uuid) -> ConversationTimeline {
        let ProjectionFold {
            mut turns,
            turn_order,
            side_rows,
            last_sequence,
        } = self;

        let mut rows = Vec::new();
        for turn_id in turn_order {
            if let Some(turn) = turns.remove(&turn_id) {
                let ProjectedTurn {
                    user,
                    assistant,
                    phase,
                    revision,
                    ..
                } = turn;
                rows.push(TimelineRow {
                    row_id: user.id.clone(),
                    revision,
                    row: ConversationTimelineRow::MessageTurn {
                        turn: user,
                        phase: phase.clone(),
                    },
                });
                if !assistant.blocks.is_empty() {
                    rows.push(TimelineRow {
                        row_id: assistant.id.clone(),
                        revision,
                        row: ConversationTimelineRow::MessageTurn {
                            turn: assistant,
                            phase,
                        },
                    });
                }
            }
        }
        rows.extend(side_rows);

        ConversationTimeline {
            conversation_id,
            projection_version: CONVERSATION_PROJECTION_VERSION,
            last_sequence,
            rows,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct ProjectedTurn {
    turn_id: Uuid,
    user: MessageTurn,
    assistant: MessageTurn,
    phase: String,
    /// Sequence of the latest event that touched this turn; the revision both message
    /// rows carry. `#[serde(default)]` lets pre-v2 snapshots load (they are discarded
    /// by the projection-version check, but be defensive).
    #[serde(default)]
    revision: i64,
}

fn ensure_turn(
    turns: &mut BTreeMap<Uuid, ProjectedTurn>,
    turn_order: &mut Vec<Uuid>,
    turn_id: Uuid,
    record: &ConversationEventRecord,
) {
    if turns.contains_key(&turn_id) {
        return;
    }

    turn_order.push(turn_id);
    turns.insert(
        turn_id,
        ProjectedTurn {
            turn_id,
            user: MessageTurn {
                id: format!("{turn_id}:user"),
                role: TurnRole::User,
                blocks: Vec::new(),
                timestamp: record.created_at,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: None,
            },
            assistant: MessageTurn {
                id: format!("{turn_id}:assistant"),
                role: TurnRole::Assistant,
                blocks: Vec::new(),
                timestamp: record.created_at,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: None,
            },
            phase: "streaming".into(),
            revision: record.sequence,
        },
    );
}

/// Stable per-row id for the incremental row-op protocol (消灭双投影). Message rows
/// reuse the `${turn}:user` / `${turn}:assistant` convention (the frontend
/// pending-bubble logic depends on it); rows with a natural id use it; append-only
/// rows without one (`file_change`, `session_notice`, `turn_error`) fall back to the
/// producing event's `sequence`, which is unique.
fn row_id_for(row: &ConversationTimelineRow, sequence: i64) -> String {
    match row {
        ConversationTimelineRow::MessageTurn { turn, .. } => turn.id.clone(),
        ConversationTimelineRow::PermissionRequest { request } => {
            format!("perm:{}", request.permission_id)
        }
        ConversationTimelineRow::QuestionRequest { request, .. } => {
            format!("q:{}", request.question_id)
        }
        ConversationTimelineRow::FeedbackRequest { request, .. } => {
            format!("fb:{}", request.feedback_id)
        }
        ConversationTimelineRow::TerminalSummary { terminal } => {
            format!("term:{}", terminal.terminal_id)
        }
        ConversationTimelineRow::Delegation { delegation } => {
            format!("del:{}", delegation.delegation_id)
        }
        ConversationTimelineRow::FileChangeSummary { .. } => format!("fc:{sequence}"),
        ConversationTimelineRow::ArtifactRevision { artifact } => {
            format!("artifact:{}:{}", artifact.artifact_id, artifact.revision)
        }
        ConversationTimelineRow::TurnError { error } => match error.turn_id {
            Some(turn_id) => format!("err:{turn_id}:{sequence}"),
            None => format!("err:{sequence}"),
        },
        ConversationTimelineRow::SessionNotice { .. } => format!("notice:{sequence}"),
    }
}

/// Wrap a freshly-produced side row with its row_id + revision (= the producing
/// event's sequence).
fn side_row(sequence: i64, row: ConversationTimelineRow) -> TimelineRow {
    TimelineRow {
        row_id: row_id_for(&row, sequence),
        revision: sequence,
        row,
    }
}

/// Build the current `TimelineRow` for one side of a turn (`user` / `assistant`),
/// used when emitting an `Upsert` op. row_id is the `${turn}:user` / `${turn}:assistant`
/// message id; revision is the turn's latest-touched sequence.
fn message_row(turn: &ProjectedTurn, role: TurnRole) -> TimelineRow {
    // Only User / Assistant message rows are projected; anything else maps to the
    // assistant side (there is no System row in a conversation turn).
    let message = match role {
        TurnRole::User => turn.user.clone(),
        _ => turn.assistant.clone(),
    };
    TimelineRow {
        row_id: message.id.clone(),
        revision: turn.revision,
        row: ConversationTimelineRow::MessageTurn {
            turn: message,
            phase: turn.phase.clone(),
        },
    }
}

fn append_text_block(blocks: &mut Vec<ContentBlock>, text: String) {
    if let Some(ContentBlock::Text { text: existing }) = blocks.last_mut() {
        existing.push_str(&text);
    } else {
        blocks.push(ContentBlock::Text { text });
    }
}

fn append_thinking_block(blocks: &mut Vec<ContentBlock>, text: String) {
    if let Some(ContentBlock::Thinking { text: existing }) = blocks.last_mut() {
        existing.push_str(&text);
    } else {
        blocks.push(ContentBlock::Thinking { text });
    }
}

/// A stored event as seen by the read side: either a known domain event, or an
/// `Unknown` wrapper for an event this build can't parse (e.g. one written by a
/// newer app version — see [`event_version`](ConversationEventRecord::event_version)).
///
/// Fault tolerance lives entirely here, on the read side: the domain
/// [`ConversationEvent`] enum deliberately has **no** `Unknown` variant, so every
/// producer keeps writing fully-typed events.
// `Known` wraps the large `ConversationEvent` (itself `#[allow(large_enum_variant)]`);
// this transient parse result is never stored in bulk, so boxing buys nothing.
#[allow(clippy::large_enum_variant)]
enum ParsedEvent {
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

/// The single parse entry for a stored event. Never fails: an unparseable payload
/// degrades to [`ParsedEvent::Unknown`] rather than propagating a decode error, so
/// one forward-incompatible event can't take down the whole conversation timeline.
fn conversation_event_from_record(record: &ConversationEventRecord) -> ParsedEvent {
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

fn json_string<T: Serialize>(value: &T) -> Result<String, sqlx::Error> {
    serde_json::to_string(value).map_err(json_decode_error)
}

fn json_string_ref<T: Serialize>(value: &Option<T>) -> Result<Option<String>, sqlx::Error> {
    value.as_ref().map(json_string).transpose()
}

fn json_decode_error(error: serde_json::Error) -> sqlx::Error {
    sqlx::Error::Decode(Box::new(error))
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::{
        AgentId, AgentPermissionId, AgentPermissionOption, AgentPermissionOptionKind,
        AgentPermissionRequest, AgentPermissionResponse, AgentSessionId,
        conversation::{
            ConversationArtifactReference, ConversationDelegation, ConversationDelegationResult,
            ConversationError, ConversationFeedbackRequest, ConversationFeedbackResponse,
            ConversationFileChange, ConversationFileChangeSummary, ConversationInputBlock,
            ConversationPermissionRequest, ConversationPermissionResponse,
            ConversationQuestionRequest, ConversationQuestionResponse, ConversationTerminalPatch,
            ConversationToolCallPatch, ConversationUsage,
        },
    };
    use db::models::{
        conversation::{ConversationRecord, CreateConversationRecord},
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
        session::Session,
    };
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::{CreateDelegatedConversation, create_delegated_conversation};

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

    async fn setup_temp_pool() -> (tempfile::TempDir, SqlitePool) {
        let dir = tempfile::tempdir().expect("temp db dir");
        let options = SqliteConnectOptions::new()
            .filename(dir.path().join("conversations.sqlite"))
            .create_if_missing(true)
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect temp db");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        (dir, pool)
    }

    async fn seed_turn(pool: &SqlitePool) -> (Uuid, Uuid) {
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
                prompt_id: Some("prompt-1"),
                text_preview: Some("hello"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");
        (conversation_id, turn.id)
    }

    async fn append_event(
        pool: &SqlitePool,
        conversation_id: Uuid,
        turn_id: Option<Uuid>,
        source: &'static str,
        event: ConversationEvent,
        idempotency_key: Option<&'static str>,
    ) -> ConversationEventRecord {
        let value = serde_json::to_value(&event).expect("event value");
        let event_kind = value["kind"].as_str().expect("event kind").to_string();
        let normalized_json = serde_json::to_string(&event).expect("event json");
        ConversationEventAppender::append(
            pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source,
                event_kind: &event_kind,
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key,
            },
        )
        .await
        .expect("append event")
    }

    #[tokio::test]
    async fn artifact_revision_event_projects_reference_without_file_bytes() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let artifact_id = Uuid::new_v4();

        let record = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::ArtifactRevisionRecorded {
                artifact: ConversationArtifactReference {
                    artifact_id,
                    workspace_id: Some(Uuid::new_v4()),
                    relative_path: "reports/quarter.xlsx".into(),
                    media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        .into(),
                    content_hash: "a".repeat(64),
                    revision: 1,
                    plugin_id: "builtin.office".into(),
                    plugin_version: "2.0.0".into(),
                    provider_id: "officecli".into(),
                    tool_lock_id: "officecli:test:1.0.140".into(),
                },
            },
            Some("artifact-revision-1"),
        )
        .await;

        assert_eq!(record.event_kind, "artifact_revision_recorded");
        assert!(record.normalized_json.contains(&artifact_id.to_string()));
        assert!(!record.normalized_json.contains("\"bytes\""));
        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project artifact event");
        assert_eq!(timeline.last_sequence, record.sequence);
        let artifact_row = timeline
            .rows
            .iter()
            .find(|row| {
                matches!(
                    &row.row,
                    ConversationTimelineRow::ArtifactRevision { artifact }
                        if artifact.artifact_id == artifact_id
                )
            })
            .expect("artifact revision row");
        assert_eq!(artifact_row.row_id, format!("artifact:{artifact_id}:1"));

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::ArtifactRevisionRecorded {
                artifact: ConversationArtifactReference {
                    artifact_id,
                    workspace_id: Some(Uuid::new_v4()),
                    relative_path: "reports/quarter.xlsx".into(),
                    media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        .into(),
                    content_hash: "b".repeat(64),
                    revision: 2,
                    plugin_id: "builtin.office".into(),
                    plugin_version: "2.0.0".into(),
                    provider_id: "officecli".into(),
                    tool_lock_id: "officecli:test:1.0.140".into(),
                },
            },
            Some("artifact-revision-2"),
        )
        .await;
        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project both artifact revisions");
        assert_eq!(
            timeline
                .rows
                .iter()
                .filter(|row| matches!(
                    &row.row,
                    ConversationTimelineRow::ArtifactRevision { artifact }
                        if artifact.artifact_id == artifact_id
                ))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn artifact_projection_rebuilds_a_v2_snapshot_that_skipped_artifacts() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let artifact_id = Uuid::new_v4();
        let record = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::ArtifactRevisionRecorded {
                artifact: ConversationArtifactReference {
                    artifact_id,
                    workspace_id: Some(Uuid::new_v4()),
                    relative_path: "reports/history.pptx".into(),
                    media_type:
                        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                            .into(),
                    content_hash: "b".repeat(64),
                    revision: 1,
                    plugin_id: "builtin.office".into(),
                    plugin_version: "2.0.0".into(),
                    provider_id: "officecli".into(),
                    tool_lock_id: "officecli:test:1.0.140".into(),
                },
            },
            Some("artifact-v2-snapshot"),
        )
        .await;

        let skipped_artifact_snapshot = serde_json::to_string(&ProjectionSnapshotState {
            turns: Vec::new(),
            side_rows: Vec::new(),
            last_sequence: record.sequence,
        })
        .expect("serialize v2 snapshot");
        ConversationProjectionSnapshotRecord::upsert(
            &pool,
            conversation_id,
            2,
            record.sequence,
            &skipped_artifact_snapshot,
        )
        .await
        .expect("seed stale v2 snapshot");

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("rebuild artifact projection");
        assert!(
            timeline.rows.iter().any(|row| {
                matches!(
                    &row.row,
                    ConversationTimelineRow::ArtifactRevision { artifact }
                        if artifact.artifact_id == artifact_id
                )
            }),
            "a v2 snapshot that skipped Artifact events must be rebuilt"
        );
    }

    #[tokio::test]
    async fn conversation_state_applier_skips_unknown_event() {
        // An event this build can't parse (e.g. written by a newer version) must not
        // fail the projection — `apply_record` skips it, applying no side-effects.
        let pool = setup_pool().await;
        let mut conn = pool.acquire().await.expect("acquire connection");
        ConversationStateApplier::apply_record(
            &mut conn,
            &ConversationEventRecord {
                id: Uuid::new_v4(),
                conversation_id: Uuid::new_v4(),
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                sequence: 1,
                source: "test".to_string(),
                event_kind: "bogus_kind".to_string(),
                event_version: 999,
                normalized_json: r#"{"kind":"bogus_kind","payload":"unparseable"}"#.to_string(),
                raw_json: None,
                idempotency_key: None,
                created_at: chrono::Utc::now(),
            },
        )
        .await
        .expect("unknown event should be skipped, not fail");
    }

    #[tokio::test]
    async fn unknown_event_renders_placeholder_row_and_timeline_still_loads() {
        // Acceptance for 批次A: a forward-incompatible event surrounded by normal
        // events must not break timeline loading — it shows as a single placeholder
        // row while every other event folds as usual.
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnStarted,
            None,
        )
        .await;

        // A bogus event whose payload no known variant can parse, inserted through the
        // real append path (idempotency/sequence/side-effects all exercised).
        ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source: "acp",
                event_kind: "bogus_kind",
                normalized_json: r#"{"kind":"bogus_kind","from_the_future":true}"#,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append bogus event");

        append_event(
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

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline still loads despite the unknown event");

        let placeholders: Vec<_> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::SessionNotice { notice }
                    if notice.title == "此事件由更新版本产生，无法显示" =>
                {
                    Some(notice)
                }
                _ => None,
            })
            .collect();
        assert_eq!(placeholders.len(), 1, "exactly one placeholder row");

        // The normal assistant text still folded through, proving the unknown event
        // did not abort the rest of the timeline.
        let has_assistant_text = timeline.rows.iter().any(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. } => turn
                .blocks
                .iter()
                .any(|block| matches!(block, ContentBlock::Text { text } if text == "hello")),
            _ => false,
        });
        assert!(has_assistant_text, "surrounding events still fold");
    }

    #[tokio::test]
    async fn turn_interrupted_marks_status_and_phase() {
        // 批次B / ADR-0001: a TurnInterrupted event is the fourth terminal state. It
        // must drive the durable turn status to 'interrupted' (side-effect table) and
        // the projected turn phase to 'interrupted' (so the timeline renders the
        // 因重启中断 treatment).
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnStarted,
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnInterrupted {
                reason: Some("host restarted".into()),
            },
            None,
        )
        .await;

        let turn = ConversationTurnRecord::find_by_id(&pool, turn_id)
            .await
            .expect("find turn")
            .expect("turn");
        assert_eq!(turn.status, "interrupted");

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let user_phase = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, phase } if turn.role == TurnRole::User => {
                Some(phase.clone())
            }
            _ => None,
        });
        assert_eq!(user_phase.as_deref(), Some("interrupted"));
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

        let completed = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;
        let ops = projector.apply(&completed).expect("ops");
        // The terminal event upserts the full assistant row — folded text included —
        // at the terminal sequence, flushing the streamed deltas authoritatively.
        let assistant = ops.iter().find_map(|op| match op {
            ConversationRowOp::Upsert { row } if row.row_id == format!("{turn_id}:assistant") => {
                Some(row)
            }
            _ => None,
        });
        let assistant = assistant.expect("assistant row upserted on turn completion");
        assert_eq!(assistant.revision, completed.sequence);
        match &assistant.row {
            ConversationTimelineRow::MessageTurn { turn, phase } => {
                assert_eq!(phase, "settled");
                assert!(
                    turn.blocks
                        .iter()
                        .any(|block| matches!(block, ContentBlock::Text { text } if text == "hel"))
                );
            }
            other => panic!("expected MessageTurn, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rows_since_returns_only_changed_rows() {
        // 批次C gap backfill: rows_since returns rows whose revision advanced past the
        // cursor, so the frontend upserts only what changed.
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "hi".into() }],
            },
            None,
        )
        .await;
        let cutoff = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "a".into(),
                message_id: None,
            },
            None,
        )
        .await;
        // A later terminal event bumps the turn's rows past `cutoff`.
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;

        let (rows, last_sequence) =
            ConversationProjector::rows_since(&pool, conversation_id, cutoff.sequence)
                .await
                .expect("rows since");
        assert!(last_sequence > cutoff.sequence);
        assert!(
            rows.iter().all(|row| row.revision > cutoff.sequence),
            "only rows changed after the cursor are returned"
        );
        assert!(
            rows.iter()
                .any(|row| row.row_id == format!("{turn_id}:assistant")),
            "the assistant row (bumped by turn completion) is included"
        );
    }

    #[tokio::test]
    async fn permission_responded_folds_status_onto_row() {
        // 批次B: a responded (or recovery-voided) permission must reload as 'responded',
        // matching the live store — not perpetually 'pending'.
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::PermissionRequested {
                request: ConversationPermissionRequest {
                    permission_id: "perm-1".into(),
                    request: AgentPermissionRequest {
                        id: AgentPermissionId::new(),
                        session_id: AgentSessionId::new(),
                        title: "Allow edit?".into(),
                        details: None,
                        options: vec![AgentPermissionOption {
                            id: "allow".into(),
                            label: "Allow".into(),
                            kind: AgentPermissionOptionKind::AllowOnce,
                            description: None,
                        }],
                    },
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::PermissionResponded {
                permission_id: "perm-1".into(),
                response: ConversationPermissionResponse {
                    response: AgentPermissionResponse::Cancelled,
                    auto: true,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let status = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::PermissionRequest { request } => Some(request.status.clone()),
            _ => None,
        });
        assert_eq!(status.as_deref(), Some("responded"));
    }

    #[test]
    fn conversation_projection_fixtures_are_present_and_parse() {
        let fixtures = [
            (
                "happy-path",
                include_str!("../../db/fixtures/conversation-projection/happy-path.json"),
            ),
            (
                "no-assistant-output-error",
                include_str!(
                    "../../db/fixtures/conversation-projection/no-assistant-output-error.json"
                ),
            ),
            (
                "permission-blocked",
                include_str!("../../db/fixtures/conversation-projection/permission-blocked.json"),
            ),
            (
                "tool-heavy",
                include_str!("../../db/fixtures/conversation-projection/tool-heavy.json"),
            ),
            (
                "terminal",
                include_str!("../../db/fixtures/conversation-projection/terminal.json"),
            ),
            (
                "file-change",
                include_str!("../../db/fixtures/conversation-projection/file-change.json"),
            ),
        ];

        for (expected_name, raw) in fixtures {
            let value: serde_json::Value = serde_json::from_str(raw).expect("fixture json");
            assert_eq!(value["name"], expected_name);
            assert_eq!(value["projectionVersion"], CONVERSATION_PROJECTION_VERSION);
            assert!(
                value["events"]
                    .as_array()
                    .is_some_and(|events| !events.is_empty())
            );
            assert!(
                value["expectedTimeline"]
                    .as_array()
                    .is_some_and(|rows| !rows.is_empty())
            );
        }
    }

    #[tokio::test]
    async fn conversation_event_appender_dedupes_and_applies_turn_state() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        let first = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnStarted,
            Some("start"),
        )
        .await;
        let duplicate = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnStarted,
            Some("start"),
        )
        .await;
        assert_eq!(duplicate.id, first.id);

        let turn = ConversationTurnRecord::find_by_ordinal(&pool, conversation_id, 1)
            .await
            .expect("find turn")
            .expect("turn");
        assert_eq!(turn.status, "running");
    }

    #[tokio::test]
    async fn conversation_turn_state_is_event_driven() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnBlocked {
                reason: agents::conversation::TurnBlockedReason::Other {
                    message: "waiting".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            },
            None,
        )
        .await;

        let turn = ConversationTurnRecord::find_by_ordinal(&pool, conversation_id, 1)
            .await
            .expect("find turn")
            .expect("turn");
        assert_eq!(turn.status, "completed");
        assert_eq!(turn.stop_reason.as_deref(), Some("end_turn"));
    }

    #[tokio::test]
    async fn conversation_tool_projection_updates_by_tool_call_id() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "tool-1".into(),
                    title: Some("Edit".into()),
                    kind: Some("edit".into()),
                    status: Some("running".into()),
                    raw_input: Some(serde_json::json!({"path":"src/main.rs"})),
                    raw_output: None,
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
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "tool-1".into(),
                    title: None,
                    kind: None,
                    status: Some("completed".into()),
                    raw_input: None,
                    raw_output: Some(serde_json::json!({"ok":true})),
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

        let tools = db::models::conversation_tool::ConversationToolCallRecord::list_for_turn(
            &pool, turn_id,
        )
        .await
        .expect("tools");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].status, "completed");
        assert!(tools[0].raw_input_json.is_some());
        assert!(tools[0].raw_output_json.is_some());
    }

    #[tokio::test]
    async fn timeline_folds_tool_call_updates_into_one_block() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "tool-1".into(),
                    title: Some("Run tests".into()),
                    kind: Some("execute".into()),
                    status: Some("running".into()),
                    raw_input: Some(serde_json::json!({"command": "cargo test"})),
                    raw_output: None,
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
        // A status/output update must fold into the existing card, not spawn a
        // second titleless block; the output attaches as an id-paired result.
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "tool-1".into(),
                    title: None,
                    kind: None,
                    status: Some("completed".into()),
                    raw_input: None,
                    raw_output: Some(serde_json::Value::String("all green".into())),
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

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let blocks: Vec<_> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(&turn.blocks)
                }
                _ => None,
            })
            .flatten()
            .collect();

        let tool_uses: Vec<_> = blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolUse {
                    tool_use_id,
                    tool_name,
                    kind,
                    input_preview,
                    ..
                } => Some((tool_use_id, tool_name, kind, input_preview)),
                _ => None,
            })
            .collect();
        assert_eq!(tool_uses.len(), 1, "update must not spawn a second block");
        let (tool_use_id, tool_name, kind, input_preview) = &tool_uses[0];
        assert_eq!(tool_use_id.as_deref(), Some("tool-1"));
        assert_eq!(tool_name.as_str(), "Run tests");
        assert_eq!(kind.as_deref(), Some("execute"));
        assert!(
            input_preview
                .as_deref()
                .unwrap_or("")
                .contains("cargo test"),
            "real input fields must survive"
        );

        let results: Vec<_> = blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolResult {
                    tool_use_id,
                    output_preview,
                    is_error,
                    ..
                } => Some((tool_use_id, output_preview, is_error)),
                _ => None,
            })
            .collect();
        assert_eq!(results.len(), 1);
        let (result_id, output_preview, is_error) = &results[0];
        assert_eq!(result_id.as_deref(), Some("tool-1"));
        assert_eq!(output_preview.as_deref(), Some("all green"));
        assert!(!**is_error);
    }

    #[tokio::test]
    async fn conversation_side_effect_projection_updates_state_tables() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        let request = AgentPermissionRequest {
            id: AgentPermissionId::new(),
            session_id: AgentSessionId::new(),
            title: "Run command".into(),
            details: None,
            options: vec![AgentPermissionOption {
                id: "allow".into(),
                label: "Allow".into(),
                kind: AgentPermissionOptionKind::AllowOnce,
                description: None,
            }],
        };
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::PermissionRequested {
                request: ConversationPermissionRequest {
                    permission_id: "permission-1".into(),
                    request,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::PermissionResponded {
                permission_id: "permission-1".into(),
                response: ConversationPermissionResponse {
                    response: AgentPermissionResponse::Selected {
                        option_id: "allow".into(),
                    },
                    auto: false,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::TerminalUpdated {
                terminal: ConversationTerminalPatch {
                    terminal_id: "terminal-1".into(),
                    command: Some("cargo".into()),
                    args: vec!["test".into()],
                    cwd: None,
                    status: "exited".into(),
                    output_summary: Some("ok".into()),
                    output_truncated: false,
                    exit_status: Some(serde_json::json!({"code":0})),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::FileChangeSummaryUpdated {
                summary: ConversationFileChangeSummary {
                    source: "checkpoint_diff".into(),
                    files: vec![ConversationFileChange {
                        path: "src/main.rs".into(),
                        change_kind: "modified".into(),
                        additions: Some(1),
                        deletions: Some(0),
                        old_path: None,
                    }],
                    summary: Some("changed".into()),
                },
            },
            None,
        )
        .await;

        assert_eq!(
            db::models::conversation_side_effects::ConversationPermissionRecord::list_for_turn(
                &pool, turn_id
            )
            .await
            .expect("permissions")[0]
                .status,
            "responded"
        );
        assert_eq!(
            db::models::conversation_side_effects::ConversationTerminalRecord::list_for_turn(
                &pool, turn_id
            )
            .await
            .expect("terminals")
            .len(),
            1
        );
        assert_eq!(
            db::models::conversation_side_effects::ConversationFileChangeRecord::list_for_turn(
                &pool, turn_id
            )
            .await
            .expect("files")
            .len(),
            1
        );
    }

    #[tokio::test]
    async fn conversation_checkpoint_file_changes_are_projected_from_event() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::FileChangeSummaryUpdated {
                summary: ConversationFileChangeSummary {
                    source: "checkpoint_diff".into(),
                    files: vec![ConversationFileChange {
                        path: "src/lib.rs".into(),
                        change_kind: "modified".into(),
                        additions: Some(10),
                        deletions: Some(2),
                        old_path: None,
                    }],
                    summary: Some("checkpoint diff".into()),
                },
            },
            None,
        )
        .await;

        let files =
            db::models::conversation_side_effects::ConversationFileChangeRecord::list_for_turn(
                &pool, turn_id,
            )
            .await
            .expect("files");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].source, "checkpoint_diff");
        assert_eq!(files[0].path, "src/lib.rs");
    }

    #[tokio::test]
    async fn conversation_timeline_projection_covers_interaction_side_rows() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::QuestionRequested {
                request: ConversationQuestionRequest {
                    question_id: "question-1".into(),
                    prompt: "Pick one".into(),
                    options: vec!["A".into(), "B".into()],
                    schema: None,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::FeedbackRequested {
                request: ConversationFeedbackRequest {
                    feedback_id: "feedback-1".into(),
                    prompt: "Was this useful?".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationStarted {
                delegation: ConversationDelegation {
                    delegation_id: "delegation-1".into(),
                    parent_tool_call_id: "tool-1".into(),
                    child_conversation_id: Uuid::new_v4(),
                    agent_id: AgentId::parse("codex").unwrap(),
                    task_preview: "Review diff".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationCompleted {
                delegation_id: "delegation-1".into(),
                result: ConversationDelegationResult::Ok {
                    text_preview: Some("done".into()),
                    duration_ms: Some(10),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::SessionConfigStale {
                stale: true,
                reason: Some("settings changed".into()),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::RawDiagnosticRecorded {
                label: "stream recovered".into(),
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let kinds = timeline
            .rows
            .iter()
            .map(|row| match &row.row {
                ConversationTimelineRow::QuestionRequest { .. } => "question",
                ConversationTimelineRow::FeedbackRequest { .. } => "feedback",
                ConversationTimelineRow::Delegation { .. } => "delegation",
                ConversationTimelineRow::SessionNotice { .. } => "notice",
                _ => "other",
            })
            .collect::<Vec<_>>();

        assert!(kinds.contains(&"question"));
        assert!(kinds.contains(&"feedback"));
        // started + completed fold into a single delegation card that keeps the
        // start-event context and carries the completion result.
        assert_eq!(
            kinds.iter().filter(|kind| **kind == "delegation").count(),
            1
        );
        let delegation = timeline
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::Delegation { delegation } => Some(delegation),
                _ => None,
            })
            .expect("delegation row");
        assert_eq!(delegation.status, "completed");
        assert_eq!(delegation.task_preview.as_deref(), Some("Review diff"));
        assert!(delegation.child_conversation_id.is_some());
        assert!(matches!(
            delegation.result,
            Some(ConversationDelegationResult::Ok { .. })
        ));
        assert_eq!(kinds.iter().filter(|kind| **kind == "notice").count(), 1);
    }

    #[tokio::test]
    async fn delegation_events_rebuild_child_binding() {
        let (_dir, pool) = setup_temp_pool().await;
        let (parent_conversation_id, turn_id) = seed_turn(&pool).await;
        let child_conversation_id = Uuid::new_v4();
        let delegation_id = "delegation-call-1";
        create_delegated_conversation(
            &pool,
            CreateDelegatedConversation {
                id: child_conversation_id,
                parent_conversation_id,
                parent_tool_call_id: "tool-1".into(),
                delegation_id: delegation_id.into(),
                agent_id: AgentId::parse("codex").unwrap(),
                prompt: "Review the diff".into(),
            },
        )
        .await
        .expect("persist delegated child");
        append_event(
            &pool,
            parent_conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationStarted {
                delegation: ConversationDelegation {
                    delegation_id: delegation_id.into(),
                    parent_tool_call_id: "tool-1".into(),
                    child_conversation_id,
                    agent_id: AgentId::parse("codex").unwrap(),
                    task_preview: "Review the diff".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            parent_conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationCompleted {
                delegation_id: delegation_id.into(),
                result: ConversationDelegationResult::Ok {
                    text_preview: Some("done".into()),
                    duration_ms: Some(10),
                },
            },
            None,
        )
        .await;

        let before = ConversationProjector::project(&pool, parent_conversation_id)
            .await
            .expect("project before rebuild");
        ConversationProjector::rebuild_projection(&pool, parent_conversation_id)
            .await
            .expect("rebuild projection");
        let after = ConversationProjector::project(&pool, parent_conversation_id)
            .await
            .expect("project after rebuild");
        assert_eq!(after, before);
        let delegation = after
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::Delegation { delegation } => Some(delegation),
                _ => None,
            })
            .expect("delegation row");
        assert_eq!(delegation.delegation_id, delegation_id);
        assert_eq!(
            delegation.child_conversation_id,
            Some(child_conversation_id)
        );
        assert_eq!(delegation.status, "completed");
        let child = Session::find_by_delegation_call_id(&pool, delegation_id)
            .await
            .expect("find child")
            .expect("child exists");
        assert_eq!(child.parent_session_id, Some(parent_conversation_id));
        assert_eq!(child.parent_tool_use_id.as_deref(), Some("tool-1"));
    }

    #[tokio::test]
    async fn canceled_delegation_remains_canceled_after_projection_rebuild() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let delegation_id = "delegation-canceled-1";
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationStarted {
                delegation: ConversationDelegation {
                    delegation_id: delegation_id.into(),
                    parent_tool_call_id: "tool-canceled-1".into(),
                    child_conversation_id: Uuid::new_v4(),
                    agent_id: AgentId::parse("codex").unwrap(),
                    task_preview: "Review cancellation behavior".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationCompleted {
                delegation_id: delegation_id.into(),
                result: ConversationDelegationResult::Err {
                    error: ConversationError {
                        message: "canceled by request".into(),
                        code: Some("canceled".into()),
                        raw: None,
                    },
                },
            },
            None,
        )
        .await;

        ConversationProjector::rebuild_projection(&pool, conversation_id)
            .await
            .expect("rebuild projection");
        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project rebuilt timeline");
        let delegation = timeline
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::Delegation { delegation } => Some(delegation),
                _ => None,
            })
            .expect("delegation row");

        assert_eq!(delegation.status, "canceled");
        assert!(delegation.child_conversation_id.is_some());
    }

    #[tokio::test]
    async fn permission_view_carries_real_acp_detail_and_options() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        let request = AgentPermissionRequest {
            id: AgentPermissionId::new(),
            session_id: AgentSessionId::new(),
            title: "Edit README.md".into(),
            details: Some(serde_json::json!({
                "fields": { "kind": "edit", "content": [
                    { "type": "diff", "path": "README.md", "oldText": "a", "newText": "b" }
                ] }
            })),
            options: vec![
                AgentPermissionOption {
                    id: "allow".into(),
                    label: "Allow".into(),
                    kind: AgentPermissionOptionKind::AllowOnce,
                    description: None,
                },
                AgentPermissionOption {
                    id: "deny".into(),
                    label: "Deny".into(),
                    kind: AgentPermissionOptionKind::RejectOnce,
                    description: None,
                },
            ],
        };
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::PermissionRequested {
                request: ConversationPermissionRequest {
                    permission_id: "permission-1".into(),
                    request,
                },
            },
            None,
        )
        .await;

        // Reloading through the projection must preserve the full tool detail and
        // the selectable options — the card relies on these to show the real diff
        // and offer the real Allow/Reject answers after a refresh.
        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let permission = timeline
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::PermissionRequest { request } => Some(request),
                _ => None,
            })
            .expect("permission row");

        assert_eq!(permission.permission_id, "permission-1");
        assert_eq!(permission.status, "pending");
        assert_eq!(permission.options.len(), 2);
        assert_eq!(permission.options[0].id, "allow");
        let detail = permission.details.as_ref().expect("details preserved");
        assert_eq!(detail["fields"]["kind"], "edit");
        assert_eq!(detail["fields"]["content"][0]["path"], "README.md");
    }

    #[tokio::test]
    async fn conversation_timeline_projection_folds_messages_and_errors() {
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
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "he".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "llo".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: 1,
                    output_tokens: 2,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    context_window_max: None,
                    cost_amount: None,
                    cost_currency: None,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnFailed {
                error: ConversationError {
                    message: "late visible error".into(),
                    code: None,
                    raw: None,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project timeline");
        assert_eq!(timeline.last_sequence, 6);
        assert!(timeline.rows.len() >= 3);
        assert!(matches!(
            timeline.rows[0].row,
            ConversationTimelineRow::MessageTurn { .. }
        ));
        assert!(
            timeline
                .rows
                .iter()
                .any(|row| matches!(row.row, ConversationTimelineRow::TurnError { .. }))
        );
    }

    #[tokio::test]
    async fn rebuild_projection_matches_incremental_and_repopulates_tables() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "hi".into() }],
            },
            None,
        )
        .await;
        append_event(
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
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "tool-1".into(),
                    title: Some("Edit".into()),
                    kind: Some("edit".into()),
                    status: Some("completed".into()),
                    raw_input: Some(serde_json::json!({"path":"a.rs"})),
                    raw_output: Some(serde_json::json!({"ok":true})),
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
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            },
            None,
        )
        .await;

        // The snapshot path (materialized on the TurnCompleted settle) must equal a
        // pure full fold of the same events.
        let incremental = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project via snapshot");
        let all_events = ConversationEventRecord::events_since(&pool, conversation_id, 0, i64::MAX)
            .await
            .expect("events");
        let pure = ConversationProjector::project_records(conversation_id, &all_events)
            .expect("pure fold");
        assert_eq!(incremental, pure, "snapshot+tail must equal pure fold");

        let tools_before =
            db::models::conversation_tool::ConversationToolCallRecord::list_for_conversation(
                &pool,
                conversation_id,
            )
            .await
            .expect("tools")
            .len();
        assert_eq!(tools_before, 1);

        // Authoritative rebuild from the event log must reproduce both the timeline
        // and the derived projection tables (without duplicating rows).
        ConversationProjector::rebuild_projection(&pool, conversation_id)
            .await
            .expect("rebuild");
        let rebuilt = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project after rebuild");
        assert_eq!(rebuilt, pure, "rebuilt projection must equal pure fold");

        let tools_after =
            db::models::conversation_tool::ConversationToolCallRecord::list_for_conversation(
                &pool,
                conversation_id,
            )
            .await
            .expect("tools")
            .len();
        assert_eq!(
            tools_after, 1,
            "rebuild must repopulate (not duplicate) derived tables"
        );
    }

    #[tokio::test]
    async fn append_rolls_back_event_when_apply_fails() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        // A well-formed event whose *side-effect* insert fails: the terminal status is
        // not in the `conversation_terminals` CHECK allowlist, so `apply_record` errors
        // mid-transaction. The single append transaction must roll back — no orphaned
        // event row. (Unparseable events are now tolerated, so a real DB failure is the
        // right way to exercise the atomicity guarantee.)
        let event = ConversationEvent::TerminalUpdated {
            terminal: ConversationTerminalPatch {
                terminal_id: "term-1".into(),
                command: None,
                args: Vec::new(),
                cwd: None,
                status: "not_a_valid_status".into(),
                output_summary: None,
                output_truncated: false,
                exit_status: None,
            },
        };
        let normalized_json = serde_json::to_string(&event).expect("event json");
        let result = ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "runtime",
                event_kind: "terminal_updated",
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await;
        assert!(
            result.is_err(),
            "append must fail when projection apply fails"
        );

        let events = ConversationEventRecord::events_since(&pool, conversation_id, 0, i64::MAX)
            .await
            .expect("events");
        assert!(
            events.is_empty(),
            "failed append must not leave an orphaned event row"
        );
    }

    #[tokio::test]
    async fn snapshot_is_materialized_only_on_turn_settle() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "hi".into() }],
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "ok".into(),
                message_id: None,
            },
            None,
        )
        .await;
        assert!(
            db::models::conversation_snapshot::ConversationProjectionSnapshotRecord::find(
                &pool,
                conversation_id,
            )
            .await
            .expect("find snapshot")
            .is_none(),
            "no snapshot before the turn settles"
        );

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            },
            None,
        )
        .await;
        let snapshot =
            db::models::conversation_snapshot::ConversationProjectionSnapshotRecord::find(
                &pool,
                conversation_id,
            )
            .await
            .expect("find snapshot")
            .expect("snapshot exists after settle");
        assert_eq!(snapshot.last_sequence, 3);
        assert_eq!(
            snapshot.projection_version,
            CONVERSATION_PROJECTION_VERSION as i64
        );
    }

    #[tokio::test]
    async fn question_and_feedback_responses_fold_onto_rows() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::QuestionRequested {
                request: ConversationQuestionRequest {
                    question_id: "q1".into(),
                    prompt: "Pick".into(),
                    options: vec!["A".into(), "B".into()],
                    schema: None,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::QuestionResponded {
                question_id: "q1".into(),
                response: ConversationQuestionResponse {
                    answer: "A".into(),
                    content: None,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::FeedbackRequested {
                request: ConversationFeedbackRequest {
                    feedback_id: "f1".into(),
                    prompt: "Rate".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::FeedbackSubmitted {
                feedback_id: "f1".into(),
                response: ConversationFeedbackResponse {
                    rating: "up".into(),
                    comment: None,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let question_answered = timeline.rows.iter().any(|row| {
            matches!(
                &row.row,
                ConversationTimelineRow::QuestionRequest { response: Some(answer), .. }
                    if answer.answer == "A"
            )
        });
        assert!(
            question_answered,
            "answered question must carry its response after the fold"
        );
        let feedback_answered = timeline.rows.iter().any(|row| {
            matches!(
                &row.row,
                ConversationTimelineRow::FeedbackRequest { response: Some(resp), .. }
                    if resp.rating == "up"
            )
        });
        assert!(
            feedback_answered,
            "submitted feedback must carry its response after the fold"
        );
    }

    #[tokio::test]
    async fn truncate_to_turn_ordinal_drops_target_turn_and_tail() {
        let pool = setup_pool().await;
        let (conversation_id, turn1_id) = seed_turn(&pool).await; // ordinal 1

        // Turn 1 (ordinal 1): user → assistant → completed (sequences 1,2,3).
        append_event(
            &pool,
            conversation_id,
            Some(turn1_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "first".into(),
                }],
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn1_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "one".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn1_id),
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            },
            None,
        )
        .await;

        // Turn 2 (ordinal 2): user → assistant (sequences 4,5).
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
        append_event(
            &pool,
            conversation_id,
            Some(turn2.id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "second".into(),
                }],
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn2.id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "two".into(),
                message_id: None,
            },
            None,
        )
        .await;

        let before = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project before");
        assert_eq!(before.last_sequence, 5);

        // Reset to here: drop turn 2 (ordinal 2) and everything after.
        ConversationProjector::truncate_to_turn_ordinal(&pool, conversation_id, 2)
            .await
            .expect("truncate");

        let remaining = ConversationTurnRecord::list_for_conversation(&pool, conversation_id)
            .await
            .expect("list turns");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].ordinal, 1);

        let event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(&pool)
        .await
        .expect("count events");
        assert_eq!(event_count, 3, "only turn 1's three events survive");

        let after = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project after");
        assert_eq!(after.last_sequence, 3);
    }
}
