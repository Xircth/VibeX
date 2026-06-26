use std::collections::BTreeMap;

use agents::conversation::{
    ContentBlock, ConversationDelegationResult, ConversationDelegationView, ConversationErrorView,
    ConversationEvent, ConversationPermissionView, ConversationSessionNotice,
    ConversationTerminalView, ConversationTimeline, ConversationTimelineRow, MessageTurn, PlanEntry,
    SessionLoadFailureReason, TurnRole, TurnUsage,
};
use serde::{Deserialize, Serialize};
use sqlx::{Executor, Sqlite, SqliteConnection, SqlitePool};
use uuid::Uuid;

use super::{
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

pub const CONVERSATION_PROJECTION_VERSION: u32 = 1;

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
        if let Some(existing) =
            find_conversation_event_by_idempotency(conn, input.conversation_id, input.idempotency_key)
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
        let event = conversation_event_from_record(record)?;

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
            "turn_completed" | "turn_failed" | "turn_cancelled"
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
        Self::persist_snapshot(&mut *conn, conversation_id, &fold).await
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
        Self::rebuild_on_connection(conn, conversation_id).await
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

/// Mutable accumulator that folds events into a conversation timeline. Persisted to
/// the snapshot table via [`ProjectionSnapshotState`] so reads can resume from it.
#[derive(Default)]
struct ProjectionFold {
    turns: BTreeMap<Uuid, ProjectedTurn>,
    turn_order: Vec<Uuid>,
    side_rows: Vec<ConversationTimelineRow>,
    last_sequence: i64,
}

/// Serializable form of [`ProjectionFold`] (turns kept in order, no map keys → portable JSON).
#[derive(Default, Serialize, Deserialize)]
struct ProjectionSnapshotState {
    turns: Vec<ProjectedTurn>,
    side_rows: Vec<ConversationTimelineRow>,
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

    fn apply(&mut self, record: &ConversationEventRecord) -> Result<(), sqlx::Error> {
        self.last_sequence = self.last_sequence.max(record.sequence);
        let event = conversation_event_from_record(record)?;

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
                        })
                        .collect();
                }
            }
            ConversationEvent::AssistantTextDelta { text, .. } => {
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    append_text_block(&mut turn.assistant.blocks, text);
                }
            }
            ConversationEvent::AssistantReasoningDelta { text, .. } => {
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    let turn = turns.get_mut(&turn_id).expect("turn exists");
                    append_thinking_block(&mut turn.assistant.blocks, text);
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
                    turn.assistant.blocks.push(ContentBlock::ToolUse {
                        tool_use_id: Some(tool_call.tool_call_id.clone()),
                        tool_name: tool_call
                            .title
                            .or(tool_call.kind)
                            .unwrap_or(tool_call.tool_call_id),
                        input_preview: tool_call.raw_input.map(|value| value.to_string()),
                        meta: tool_call.metadata,
                    });
                    if let Some(output) = tool_call.raw_output {
                        turn.assistant.blocks.push(ContentBlock::ToolResult {
                            tool_use_id: None,
                            output_preview: Some(output.to_string()),
                            is_error: matches!(tool_call.status.as_deref(), Some("failed")),
                            agent_stats: None,
                        });
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
                    });
                }
            }
            ConversationEvent::TurnCompleted { .. } => {
                if let Some(turn_id) = record.turn_id {
                    ensure_turn(turns, turn_order, turn_id, record);
                    turns.get_mut(&turn_id).expect("turn exists").phase = "settled".into();
                }
            }
            ConversationEvent::PermissionRequested { request } => {
                side_rows.push(ConversationTimelineRow::PermissionRequest {
                    request: ConversationPermissionView {
                        permission_id: request.permission_id,
                        title: Some(request.request.title),
                        status: "pending".into(),
                        details: request.request.details,
                        options: request.request.options,
                    },
                });
            }
            ConversationEvent::QuestionRequested { request } => {
                side_rows.push(ConversationTimelineRow::QuestionRequest {
                    request,
                    response: None,
                });
            }
            ConversationEvent::QuestionResponded {
                question_id,
                response,
            } => {
                // Fold the answer onto the pending question row so a rebuilt projection
                // no longer shows answered questions as perpetually pending.
                for row in side_rows.iter_mut() {
                    if let ConversationTimelineRow::QuestionRequest {
                        request,
                        response: slot,
                    } = row
                        && request.question_id == question_id
                    {
                        *slot = Some(response);
                        break;
                    }
                }
            }
            ConversationEvent::FeedbackRequested { request } => {
                side_rows.push(ConversationTimelineRow::FeedbackRequest {
                    request,
                    response: None,
                });
            }
            ConversationEvent::FeedbackSubmitted {
                feedback_id,
                response,
            } => {
                for row in side_rows.iter_mut() {
                    if let ConversationTimelineRow::FeedbackRequest {
                        request,
                        response: slot,
                    } = row
                        && request.feedback_id == feedback_id
                    {
                        *slot = Some(response);
                        break;
                    }
                }
            }
            ConversationEvent::TerminalUpdated { terminal } => {
                side_rows.push(ConversationTimelineRow::TerminalSummary {
                    terminal: ConversationTerminalView {
                        terminal_id: terminal.terminal_id,
                        command: terminal.command,
                        status: terminal.status,
                        output_summary: terminal.output_summary,
                        output_truncated: terminal.output_truncated,
                    },
                });
            }
            ConversationEvent::DelegationStarted { delegation } => {
                side_rows.push(ConversationTimelineRow::Delegation {
                    delegation: ConversationDelegationView {
                        delegation_id: delegation.delegation_id,
                        parent_tool_call_id: Some(delegation.parent_tool_call_id),
                        child_conversation_id: Some(delegation.child_conversation_id),
                        agent_type: Some(delegation.agent_type),
                        task_preview: Some(delegation.task_preview),
                        status: "running".into(),
                        result: None,
                    },
                });
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
                    ConversationDelegationResult::Err { .. } => "failed",
                };
                let mut merged = false;
                for row in side_rows.iter_mut() {
                    if let ConversationTimelineRow::Delegation { delegation } = row
                        && delegation.delegation_id == delegation_id
                    {
                        delegation.status = status.into();
                        delegation.result = Some(result.clone());
                        merged = true;
                        break;
                    }
                }
                if !merged {
                    side_rows.push(ConversationTimelineRow::Delegation {
                        delegation: ConversationDelegationView {
                            delegation_id,
                            parent_tool_call_id: None,
                            child_conversation_id: None,
                            agent_type: None,
                            task_preview: None,
                            status: status.into(),
                            result: Some(result),
                        },
                    });
                }
            }
            ConversationEvent::FileChangeSummaryUpdated { summary } => {
                side_rows.push(ConversationTimelineRow::FileChangeSummary { summary });
            }
            ConversationEvent::TurnFailed { error } => {
                side_rows.push(ConversationTimelineRow::TurnError {
                    error: ConversationErrorView {
                        turn_id: record.turn_id,
                        error,
                    },
                });
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
                side_rows.push(ConversationTimelineRow::SessionNotice { notice });
            }
            ConversationEvent::AgentBindingRecoveryFailed { reason } => {
                side_rows.push(ConversationTimelineRow::SessionNotice {
                    notice: ConversationSessionNotice {
                        title: "Agent session recovery failed".into(),
                        message: Some(reason),
                        severity: "error".into(),
                    },
                });
            }
            ConversationEvent::SessionConfigStale { stale, reason } => {
                if stale {
                    side_rows.push(ConversationTimelineRow::SessionNotice {
                        notice: ConversationSessionNotice {
                            title: "Agent configuration changed".into(),
                            message: reason,
                            severity: "info".into(),
                        },
                    });
                }
            }
            _ => {}
        }

        Ok(())
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
                rows.push(ConversationTimelineRow::MessageTurn {
                    turn: turn.user,
                    phase: turn.phase.clone(),
                });
                if !turn.assistant.blocks.is_empty() {
                    rows.push(ConversationTimelineRow::MessageTurn {
                        turn: turn.assistant,
                        phase: turn.phase,
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
        },
    );
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

fn conversation_event_from_record(
    record: &ConversationEventRecord,
) -> Result<ConversationEvent, sqlx::Error> {
    serde_json::from_str::<ConversationEvent>(&record.normalized_json).map_err(json_decode_error)
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
        AgentPermissionId, AgentPermissionOption, AgentPermissionOptionKind,
        AgentPermissionRequest, AgentPermissionResponse, AgentSessionId, AgentType,
        conversation::{
            ConversationDelegation, ConversationDelegationResult, ConversationError,
            ConversationFeedbackRequest, ConversationFeedbackResponse, ConversationFileChange,
            ConversationFileChangeSummary, ConversationInputBlock, ConversationPermissionRequest,
            ConversationPermissionResponse, ConversationQuestionRequest, ConversationQuestionResponse,
            ConversationTerminalPatch, ConversationToolCallPatch, ConversationUsage,
        },
    };
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::models::{
        conversation::{ConversationRecord, CreateConversationRecord},
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    };

    async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
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
    async fn conversation_state_applier_rejects_invalid_event_json() {
        let pool = setup_pool().await;
        let mut conn = pool.acquire().await.expect("acquire connection");
        let error = ConversationStateApplier::apply_record(
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
                event_kind: "invalid".to_string(),
                normalized_json: r#"{"kind":"not_a_conversation_event"}"#.to_string(),
                raw_json: None,
                idempotency_key: None,
                created_at: chrono::Utc::now(),
            },
        )
        .await
        .expect_err("invalid normalized event should fail loudly");

        assert!(matches!(error, sqlx::Error::Decode(_)));
    }

    #[test]
    fn conversation_projection_fixtures_are_present_and_parse() {
        let fixtures = [
            (
                "happy-path",
                include_str!("../../fixtures/conversation-projection/happy-path.json"),
            ),
            (
                "no-assistant-output-error",
                include_str!(
                    "../../fixtures/conversation-projection/no-assistant-output-error.json"
                ),
            ),
            (
                "permission-blocked",
                include_str!("../../fixtures/conversation-projection/permission-blocked.json"),
            ),
            (
                "tool-heavy",
                include_str!("../../fixtures/conversation-projection/tool-heavy.json"),
            ),
            (
                "terminal",
                include_str!("../../fixtures/conversation-projection/terminal.json"),
            ),
            (
                "file-change",
                include_str!("../../fixtures/conversation-projection/file-change.json"),
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

        let tools = super::super::conversation_tool::ConversationToolCallRecord::list_for_turn(
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
            super::super::conversation_side_effects::ConversationPermissionRecord::list_for_turn(
                &pool, turn_id
            )
            .await
            .expect("permissions")[0]
                .status,
            "responded"
        );
        assert_eq!(
            super::super::conversation_side_effects::ConversationTerminalRecord::list_for_turn(
                &pool, turn_id
            )
            .await
            .expect("terminals")
            .len(),
            1
        );
        assert_eq!(
            super::super::conversation_side_effects::ConversationFileChangeRecord::list_for_turn(
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
            super::super::conversation_side_effects::ConversationFileChangeRecord::list_for_turn(
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
                    agent_type: AgentType::Codex,
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
            .map(|row| match row {
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
            .find_map(|row| match row {
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
            .find_map(|row| match row {
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
            timeline.rows[0],
            ConversationTimelineRow::MessageTurn { .. }
        ));
        assert!(
            timeline
                .rows
                .iter()
                .any(|row| matches!(row, ConversationTimelineRow::TurnError { .. }))
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
            super::super::conversation_tool::ConversationToolCallRecord::list_for_conversation(
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
            super::super::conversation_tool::ConversationToolCallRecord::list_for_conversation(
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
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
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

        // Inserts fine but cannot parse as a ConversationEvent, so apply_record errors
        // and the single append transaction must roll back — no orphaned event row.
        let result = ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "runtime",
                event_kind: "bogus",
                normalized_json: r#"{"kind":"not_a_conversation_event"}"#,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await;
        assert!(result.is_err(), "append must fail when projection apply fails");

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
            super::super::conversation_snapshot::ConversationProjectionSnapshotRecord::find(
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
            super::super::conversation_snapshot::ConversationProjectionSnapshotRecord::find(
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
                row,
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
                row,
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

        let event_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM conversation_events WHERE conversation_id = ?")
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
