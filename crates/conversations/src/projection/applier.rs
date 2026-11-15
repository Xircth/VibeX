use std::collections::{HashMap, HashSet};

use agents::conversation::{ConversationEvent, ConversationInputEvent};
use db::models::{
    conversation::{ConversationAgentBindingRecord, ConversationRecord},
    conversation_event::{
        AppendConversationEvent, ConversationEventRecord, find_conversation_event_by_idempotency,
        insert_conversation_event,
    },
    conversation_input::{ConversationInputRecord, CreateConversationInput},
    conversation_relation::ConversationRelationRecord,
    conversation_side_effects::{
        ConversationFileChangeRecord, ConversationPermissionRecord, ConversationTerminalRecord,
        InsertConversationFileChange, UpsertConversationPermission, UpsertConversationTerminal,
    },
    conversation_snapshot::ConversationProjectionSnapshotRecord,
    conversation_steering::ConversationSteeringRecord,
    conversation_timeline_row::{ConversationTimelineRowRecord, SORT_INDEX_SLOT_SPAN},
    conversation_tool::{ConversationToolCallRecord, UpsertConversationToolCall},
    conversation_turn::ConversationTurnRecord,
};
use serde::Serialize;
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;

use super::{
    CONVERSATION_PROJECTION_VERSION, ConversationProjector, ParsedEvent,
    cache::{
        self, WriteSideProjectorState, apply_and_persist_incremental_on_conn,
        commit_write_projector_states, evict_write_projector,
        flush_write_projector_snapshot_on_conn, get_or_load_write_projector_on_conn,
        json_decode_error,
    },
    conversation_event_from_record, conversation_input_event_id,
};

pub const MAX_BATCH_EVENTS: usize = 64;
pub const MAX_BATCH_BYTES: usize = 1_048_576;

/// Pre-computed checkpoint finalization metadata committed inside the same `BEGIN IMMEDIATE`
/// transaction as its corresponding event (zero filesystem/git I/O inside the transaction).
#[derive(Debug, Clone)]
pub struct CheckpointMetadataUpdate {
    pub checkpoint_id: Uuid,
    pub after_snapshot_json: String,
    pub diff_summary_json: String,
}

#[derive(Debug, Clone)]
pub struct BatchConversationEvent {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Option<Uuid>,
    pub binding_id: Option<Uuid>,
    pub connection_id: Option<String>,
    pub prompt_id: Option<String>,
    pub source: String,
    pub event_kind: String,
    pub normalized_json: String,
    pub raw_json: Option<String>,
    pub idempotency_key: Option<String>,
    pub checkpoint_update: Option<CheckpointMetadataUpdate>,
}

impl BatchConversationEvent {
    pub fn from_append(input: AppendConversationEvent<'_>) -> Self {
        Self {
            id: input.id,
            conversation_id: input.conversation_id,
            turn_id: input.turn_id,
            binding_id: input.binding_id,
            connection_id: input.connection_id.map(str::to_owned),
            prompt_id: input.prompt_id.map(str::to_owned),
            source: input.source.to_owned(),
            event_kind: input.event_kind.to_owned(),
            normalized_json: input.normalized_json.to_owned(),
            raw_json: input.raw_json.map(str::to_owned),
            idempotency_key: input.idempotency_key.map(str::to_owned),
            checkpoint_update: None,
        }
    }

    pub fn as_append(&self) -> AppendConversationEvent<'_> {
        AppendConversationEvent {
            id: self.id,
            conversation_id: self.conversation_id,
            turn_id: self.turn_id,
            binding_id: self.binding_id,
            connection_id: self.connection_id.as_deref(),
            prompt_id: self.prompt_id.as_deref(),
            source: canonical_event_source(&self.source),
            event_kind: &self.event_kind,
            normalized_json: &self.normalized_json,
            raw_json: self.raw_json.as_deref(),
            idempotency_key: self.idempotency_key.as_deref(),
        }
    }

    fn estimated_bytes(&self) -> usize {
        self.normalized_json.len()
            + self.raw_json.as_deref().map_or(0, str::len)
            + self
                .checkpoint_update
                .as_ref()
                .map_or(0, |cp| cp.after_snapshot_json.len() + cp.diff_summary_json.len())
    }
}

#[derive(Debug, Clone)]
pub struct CommittedConversationEvent {
    pub index: usize,
    pub record: ConversationEventRecord,
    pub duplicate: bool,
}

#[derive(Debug, Default)]
pub struct BatchAppendResult {
    pub committed: Vec<CommittedConversationEvent>,
    pub failed: Vec<(usize, sqlx::Error)>,
}

pub(crate) async fn apply_checkpoint_metadata_update_on_conn(
    conn: &mut SqliteConnection,
    update: &CheckpointMetadataUpdate,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE conversation_checkpoints
           SET after_snapshot_json = ?,
               diff_summary_json = ?,
               finalized_at = datetime('now', 'subsec')
           WHERE id = ?"#,
    )
    .bind(&update.after_snapshot_json)
    .bind(&update.diff_summary_json)
    .bind(update.checkpoint_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

fn split_batch_ranges(events: &[BatchConversationEvent]) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut start = 0usize;
    while start < events.len() {
        let mut end = start;
        let mut bytes = 0usize;
        while end < events.len() && (end - start) < MAX_BATCH_EVENTS {
            let item_bytes = events[end].estimated_bytes();
            if end > start && bytes.saturating_add(item_bytes) > MAX_BATCH_BYTES {
                break;
            }
            bytes = bytes.saturating_add(item_bytes);
            end += 1;
        }
        ranges.push(start..end);
        start = end;
    }
    ranges
}

fn canonical_event_source(source: &str) -> &str {
    match source {
        "agent" => "acp",
        other => other,
    }
}

async fn ensure_turn_shell_for_user_turn_created(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    event_kind: &str,
    turn_id: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    if event_kind != "user_turn_created" {
        return Ok(());
    }
    let Some(turn_id) = turn_id else {
        return Ok(());
    };
    sqlx::query(
        r#"INSERT OR IGNORE INTO conversation_turns (id, conversation_id, ordinal, status)
           SELECT ?1,
                  ?2,
                  COALESCE((SELECT MAX(ordinal) FROM conversation_turns WHERE conversation_id = ?2), 0) + 1,
                  'pending'
           WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?2)"#,
    )
    .bind(turn_id)
    .bind(conversation_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub struct ConversationEventAppender;

impl ConversationEventAppender {
    /// Append an event and apply its projection side-effects **atomically** in one
    /// `BEGIN IMMEDIATE` transaction, incrementally updating `conversation_timeline_rows`,
    /// `conversation_fts`, and the lightweight snapshot watermark.
    pub async fn append(
        pool: &SqlitePool,
        input: AppendConversationEvent<'_>,
    ) -> Result<ConversationEventRecord, sqlx::Error> {
        let batch = [BatchConversationEvent::from_append(input)];
        let mut out = Self::append_batch(pool, &batch).await?;
        if let Some((_, error)) = out.failed.pop() {
            return Err(error);
        }
        out.committed
            .pop()
            .map(|c| c.record)
            .ok_or_else(|| sqlx::Error::Protocol("append_batch produced no result".into()))
    }

    /// Append a bounded batch (`<= 64` events and `<= 1 MiB` per `BEGIN IMMEDIATE` chunk),
    /// isolating per-item errors with `SAVEPOINT sp_item` so one malformed item never aborts
    /// valid sibling items in the same batch.
    pub async fn append_batch(
        pool: &SqlitePool,
        events: &[BatchConversationEvent],
    ) -> Result<BatchAppendResult, sqlx::Error> {
        if events.is_empty() {
            return Ok(BatchAppendResult::default());
        }

        let mut total = BatchAppendResult::default();
        for range in split_batch_ranges(events) {
            let mut conn = pool.acquire().await?;
            sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;

            let chunk_outcome: Result<
                (
                    Vec<CommittedConversationEvent>,
                    Vec<(usize, sqlx::Error)>,
                    HashMap<Uuid, WriteSideProjectorState>,
                ),
                (sqlx::Error, HashSet<Uuid>),
            > = async {
                let mut committed = Vec::with_capacity(range.len());
                let mut failed = Vec::new();
                let mut touched_states: HashMap<Uuid, WriteSideProjectorState> = HashMap::new();
                let mut dirty_conversations: HashSet<Uuid> = HashSet::new();

                for idx in range {
                    let item = &events[idx];
                    if let Err(err) = sqlx::query("SAVEPOINT sp_item").execute(&mut *conn).await {
                        return Err((err, touched_states.keys().copied().collect()));
                    }

                    enum StepDone {
                        Duplicate(ConversationEventRecord),
                        Applied(ConversationEventRecord, Box<WriteSideProjectorState>),
                    }

                    let step_res: Result<StepDone, sqlx::Error> = async {
                        if let Some(cp) = &item.checkpoint_update {
                            apply_checkpoint_metadata_update_on_conn(&mut conn, cp).await?;
                        }
                        if let Some(existing) = find_conversation_event_by_idempotency(
                            &mut conn,
                            item.conversation_id,
                            item.idempotency_key.as_deref(),
                        )
                        .await?
                        {
                            return Ok(StepDone::Duplicate(existing));
                        }

                        ensure_turn_shell_for_user_turn_created(
                            &mut conn,
                            item.conversation_id,
                            &item.event_kind,
                            item.turn_id,
                        )
                        .await?;
                        let record =
                            insert_conversation_event(&mut conn, item.as_append()).await?;
                        let mut candidate = match touched_states.get(&record.conversation_id) {
                            Some(in_batch) => in_batch.clone(),
                            None => {
                                get_or_load_write_projector_on_conn(
                                    &mut conn,
                                    record.conversation_id,
                                    record.sequence,
                                )
                                .await?
                            }
                        };
                        ConversationStateApplier::apply_record(&mut conn, &record).await?;
                        apply_and_persist_incremental_on_conn(&mut conn, &mut candidate, &record)
                            .await?;
                        Ok(StepDone::Applied(record, Box::new(candidate)))
                    }
                    .await;

                    match step_res {
                        Ok(StepDone::Duplicate(existing)) => {
                            if let Err(err) = sqlx::query("RELEASE SAVEPOINT sp_item")
                                .execute(&mut *conn)
                                .await
                            {
                                return Err((err, touched_states.keys().copied().collect()));
                            }
                            committed.push(CommittedConversationEvent {
                                index: idx,
                                record: existing,
                                duplicate: true,
                            });
                        }
                        Ok(StepDone::Applied(record, candidate)) => {
                            if let Err(err) = sqlx::query("RELEASE SAVEPOINT sp_item")
                                .execute(&mut *conn)
                                .await
                            {
                                return Err((err, touched_states.keys().copied().collect()));
                            }
                            dirty_conversations.insert(record.conversation_id);
                            touched_states.insert(record.conversation_id, *candidate);
                            committed.push(CommittedConversationEvent {
                                index: idx,
                                record,
                                duplicate: false,
                            });
                        }
                        Err(item_err) => {
                            let _ = sqlx::query("ROLLBACK TO SAVEPOINT sp_item")
                                .execute(&mut *conn)
                                .await;
                            let _ = sqlx::query("RELEASE SAVEPOINT sp_item")
                                .execute(&mut *conn)
                                .await;
                            failed.push((idx, item_err));
                        }
                    }
                }

                for cid in &dirty_conversations {
                    if let Some(state) = touched_states.get(cid)
                        && let Err(err) =
                            flush_write_projector_snapshot_on_conn(&mut conn, *cid, state).await
                    {
                        return Err((err, touched_states.keys().copied().collect()));
                    }
                }

                Ok((committed, failed, touched_states))
            }
            .await;

            match chunk_outcome {
                Ok((committed, failed, touched_states)) => {
                    if let Err(commit_err) = sqlx::query("COMMIT").execute(&mut *conn).await {
                        let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                        for cid in touched_states.keys() {
                            evict_write_projector(*cid);
                        }
                        return Err(commit_err);
                    }
                    commit_write_projector_states(touched_states);
                    total.committed.extend(committed);
                    total.failed.extend(failed);
                }
                Err((tx_err, touched_ids)) => {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                    for cid in touched_ids {
                        evict_write_projector(cid);
                    }
                    return Err(tx_err);
                }
            }
        }

        Ok(total)
    }

    pub(crate) async fn append_and_apply(
        conn: &mut SqliteConnection,
        input: AppendConversationEvent<'_>,
    ) -> Result<ConversationEventRecord, sqlx::Error> {
        if let Some(existing) = find_conversation_event_by_idempotency(
            conn,
            input.conversation_id,
            input.idempotency_key,
        )
        .await?
        {
            return Ok(existing);
        }

        ensure_turn_shell_for_user_turn_created(
            conn,
            input.conversation_id,
            input.event_kind,
            input.turn_id,
        )
        .await?;
        let mut normalized_input = input;
        normalized_input.source = canonical_event_source(normalized_input.source);
        let record = insert_conversation_event(conn, normalized_input).await?;
        let mut state =
            get_or_load_write_projector_on_conn(conn, record.conversation_id, record.sequence)
                .await?;
        ConversationStateApplier::apply_record(conn, &record).await?;
        apply_and_persist_incremental_on_conn(conn, &mut state, &record).await?;
        flush_write_projector_snapshot_on_conn(conn, record.conversation_id, &state).await?;
        let mut map = HashMap::with_capacity(1);
        map.insert(record.conversation_id, state);
        commit_write_projector_states(map);
        Ok(record)
    }

    /// Append and apply on the caller's open transaction.
    pub async fn append_on_connection(
        conn: &mut SqliteConnection,
        input: AppendConversationEvent<'_>,
    ) -> Result<ConversationEventRecord, sqlx::Error> {
        Self::append_and_apply(conn, input).await
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
        let should_reconcile_workbench = matches!(
            &event,
            ConversationEvent::UserTurnQueued
                | ConversationEvent::UserTurnStarted
                | ConversationEvent::TurnBlocked { .. }
                | ConversationEvent::TurnCompleted { .. }
                | ConversationEvent::TurnFailed { .. }
                | ConversationEvent::TurnCancelled { .. }
                | ConversationEvent::TurnInterrupted { .. }
                | ConversationEvent::ConversationInput { .. }
                | ConversationEvent::UserTurnCreated { .. }
        );

        match event {
            ConversationEvent::ConversationInput { event } => match event {
                ConversationInputEvent::Submitted {
                    input_id,
                    operation_id,
                    revision,
                    sort_key,
                    payload_digest,
                    payload,
                    principal,
                } => {
                    if revision != 1 {
                        return Err(projection_conflict(format!(
                            "input {input_id} submission revision must be 1"
                        )));
                    }
                    let payload_json = json_string(&payload)?;
                    let principal_json = json_string(&principal)?;
                    ConversationInputRecord::create_on_connection(
                        conn,
                        CreateConversationInput {
                            id: input_id,
                            conversation_id: record.conversation_id,
                            operation_id,
                            payload_digest: &payload_digest,
                            payload_json: &payload_json,
                            principal_json: &principal_json,
                            sort_key,
                        },
                    )
                    .await?;
                }
                agents::ConversationInputEvent::Updated {
                    input_id,
                    revision,
                    payload_digest,
                    payload,
                } => {
                    let payload_json = json_string(&payload)?;
                    let revision = event_revision(revision)?;
                    require_input_projection(
                        input_id,
                        "update",
                        ConversationInputRecord::update_payload_on_connection(
                            conn,
                            record.conversation_id,
                            input_id,
                            revision,
                            &payload_digest,
                            &payload_json,
                        )
                        .await?,
                    )?;
                }
                agents::ConversationInputEvent::Reordered {
                    input_id,
                    revision,
                    sort_key,
                } => {
                    let revision = event_revision(revision)?;
                    require_input_projection(
                        input_id,
                        "reorder",
                        ConversationInputRecord::reorder_on_connection(
                            conn,
                            record.conversation_id,
                            input_id,
                            revision,
                            sort_key,
                        )
                        .await?,
                    )?;
                }
                agents::ConversationInputEvent::Claimed {
                    input_id,
                    claim_token,
                    claim_deadline,
                } => {
                    require_input_projection(
                        input_id,
                        "claim",
                        ConversationInputRecord::claim_on_connection(
                            conn,
                            record.conversation_id,
                            input_id,
                            claim_token,
                            claim_deadline,
                        )
                        .await?,
                    )?;
                }
                agents::ConversationInputEvent::ClaimReleased {
                    input_id,
                    claim_token,
                } => {
                    require_input_projection(
                        input_id,
                        "release claim",
                        ConversationInputRecord::release_claim_on_connection(
                            conn,
                            record.conversation_id,
                            input_id,
                            claim_token,
                        )
                        .await?,
                    )?;
                }
                agents::ConversationInputEvent::Dispatched {
                    input_id,
                    claim_token,
                    turn_id,
                } => {
                    require_input_projection(
                        input_id,
                        "dispatch",
                        ConversationInputRecord::dispatch_on_connection(
                            conn,
                            record.conversation_id,
                            input_id,
                            claim_token,
                            turn_id,
                        )
                        .await?,
                    )?;
                }
                agents::ConversationInputEvent::Cancelled { input_id, revision } => {
                    let revision = event_revision(revision)?;
                    require_input_projection(
                        input_id,
                        "cancel",
                        ConversationInputRecord::cancel_on_connection(
                            conn,
                            record.conversation_id,
                            input_id,
                            revision,
                        )
                        .await?,
                    )?;
                }
            },
            ConversationEvent::ConversationSteering { event } => match event {
                agents::ConversationSteeringEvent::Requested {
                    steering_id,
                    operation_id,
                    expected_turn_id,
                    payload_digest,
                    blocks,
                    principal,
                } => {
                    let blocks_json = json_string(&blocks)?;
                    let principal_json = json_string(&principal)?;
                    ConversationSteeringRecord::create_on_connection(
                        conn,
                        db::models::conversation_steering::CreateConversationSteering {
                            id: steering_id,
                            conversation_id: record.conversation_id,
                            operation_id,
                            expected_turn_id,
                            payload_digest: &payload_digest,
                            blocks_json: &blocks_json,
                            principal_json: &principal_json,
                        },
                    )
                    .await?;
                }
                agents::ConversationSteeringEvent::Accepted {
                    steering_id,
                    expected_turn_id,
                    delivery_mode,
                    restarted_turn_id,
                } => {
                    let delivery_mode_str = match delivery_mode {
                        Some(agents::ConversationSteeringDeliveryMode::Native) => Some("native"),
                        Some(agents::ConversationSteeringDeliveryMode::InterruptRestart) => {
                            Some("interrupt_restart")
                        }
                        None => Some("native"),
                    };
                    ConversationSteeringRecord::settle_on_connection(
                        conn,
                        record.conversation_id,
                        steering_id,
                        expected_turn_id,
                        "accepted",
                        None,
                        None,
                        delivery_mode_str,
                        restarted_turn_id,
                    )
                    .await?;
                }
                agents::ConversationSteeringEvent::Rejected {
                    steering_id,
                    expected_turn_id,
                    code,
                    message,
                } => {
                    ConversationSteeringRecord::settle_on_connection(
                        conn,
                        record.conversation_id,
                        steering_id,
                        expected_turn_id,
                        "rejected",
                        Some(&code),
                        Some(&message),
                        None,
                        None,
                    )
                    .await?;
                }
                agents::ConversationSteeringEvent::Unknown {
                    steering_id,
                    expected_turn_id,
                    message,
                } => {
                    ConversationSteeringRecord::settle_on_connection(
                        conn,
                        record.conversation_id,
                        steering_id,
                        expected_turn_id,
                        "unknown",
                        Some("delivery_unknown"),
                        Some(&message),
                        None,
                        None,
                    )
                    .await?;
                }
            },
            ConversationEvent::ConversationRelationCreated {
                relation_id,
                parent_conversation_id,
                child_conversation_id,
                relation_kind,
                visibility,
                metadata,
            } => {
                if parent_conversation_id != record.conversation_id {
                    return Err(projection_conflict(format!(
                        "relation {relation_id} parent does not match its event stream"
                    )));
                }
                let relation_kind = match relation_kind {
                    agents::ConversationRelationKind::Delegation => "delegation",
                    agents::ConversationRelationKind::Fork => "fork",
                    agents::ConversationRelationKind::WorkflowStep => "workflow_step",
                    agents::ConversationRelationKind::Spawned => "spawned",
                };
                let visibility = match visibility {
                    agents::ConversationRelationVisibility::Visible => "visible",
                    agents::ConversationRelationVisibility::Hidden => "hidden",
                };
                ConversationRelationRecord::create_on_connection(
                    conn,
                    relation_id,
                    parent_conversation_id,
                    child_conversation_id,
                    relation_kind,
                    visibility,
                    &json_string(&metadata)?,
                )
                .await?;
            }
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
                    ConversationRecord::clear_active_turn_if_on_connection(
                        &mut *conn,
                        record.conversation_id,
                        turn_id,
                    )
                    .await?;
                    crate::workbench_status::release_unreviewed_in_flight_view_on_connection(
                        conn,
                        record.conversation_id,
                        turn_id,
                    )
                    .await?;
                }
            }
            ConversationEvent::TurnFailed { error } => {
                if let Some(turn_id) = record.turn_id {
                    let error_json = json_string(&error)?;
                    ConversationTurnRecord::mark_failed(&mut *conn, turn_id, &error_json).await?;
                    ConversationRecord::clear_active_turn_if_on_connection(
                        &mut *conn,
                        record.conversation_id,
                        turn_id,
                    )
                    .await?;
                    crate::workbench_status::release_unreviewed_in_flight_view_on_connection(
                        conn,
                        record.conversation_id,
                        turn_id,
                    )
                    .await?;
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
                    ConversationRecord::clear_active_turn_if_on_connection(
                        &mut *conn,
                        record.conversation_id,
                        turn_id,
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
                    ConversationRecord::clear_active_turn_if_on_connection(
                        &mut *conn,
                        record.conversation_id,
                        turn_id,
                    )
                    .await?;
                    crate::workbench_status::release_unreviewed_in_flight_view_on_connection(
                        conn,
                        record.conversation_id,
                        turn_id,
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
                            status: tool_call.status.as_deref(),
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
            ConversationEvent::AgentBindingReady { capabilities, .. } => {
                let prompt_json = serde_json::to_string(&capabilities.prompt).unwrap_or_else(|_| {
                    r#"{"text":true,"image":false,"audio":false,"resource":false,"resource_link":true}"#
                        .to_string()
                });
                let session_json =
                    serde_json::to_string(&capabilities).unwrap_or_else(|_| "{}".to_string());
                ConversationAgentBindingRecord::update_negotiated_capabilities(
                    &mut *conn,
                    record.conversation_id,
                    record.binding_id,
                    capabilities.load_session,
                    capabilities.resume_session,
                    capabilities.close_session,
                    capabilities.terminal,
                    capabilities.additional_directories,
                    &prompt_json,
                    &session_json,
                )
                .await?;
            }
            ConversationEvent::UsageUpdated { usage } => {
                crate::usage_accounting::apply_usage_updated(
                    &mut *conn,
                    record.conversation_id,
                    record.turn_id,
                    record.sequence,
                    &usage,
                    record.created_at,
                )
                .await?;
                db::models::conversation::DbConversationSummary::update_cached_model_on_connection(
                    &mut *conn,
                    record.conversation_id,
                    usage.model.as_deref(),
                )
                .await?;
            }
            ConversationEvent::SessionConfigOptionsUpdated { options } => {
                db::models::conversation::DbConversationSummary::update_cached_model_on_connection(
                    &mut *conn,
                    record.conversation_id,
                    agents::model_id_from_config_options(&options).as_deref(),
                )
                .await?;
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

        if should_reconcile_workbench {
            crate::workbench_status::reconcile_on_connection(conn, record.conversation_id).await?;
        }

        Ok(())
    }
}

impl ConversationProjector {
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

    async fn truncate_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        ordinal: i64,
    ) -> Result<(), sqlx::Error> {
        let drop_input_ids =
            Self::durable_inputs_undone_by_truncate(conn, conversation_id, ordinal).await?;

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

        let has_target_turns: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM conversation_turns WHERE conversation_id = ? AND ordinal >= ?)",
        )
        .bind(conversation_id)
        .bind(ordinal)
        .fetch_one(&mut *conn)
        .await?;

        if !has_target_turns && drop_input_ids.is_empty() && cut_sequence.is_none() {
            return Ok(());
        }

        let deleted_sequence = ConversationProjectionSnapshotRecord::allocate_next_sequence(
            conn,
            conversation_id,
            CONVERSATION_PROJECTION_VERSION as i64,
        )
        .await?;

        let min_sort_index = ordinal.max(1) * SORT_INDEX_SLOT_SPAN;
        let mut deleted_row_ids = ConversationTimelineRowRecord::soft_delete_from_sort_index_on_conn(
            conn,
            conversation_id,
            min_sort_index,
            deleted_sequence,
        )
        .await?;

        if let Some(cut_seq) = cut_sequence {
            let side_deleted: Vec<String> = sqlx::query_scalar(
                r#"UPDATE conversation_timeline_rows
                      SET revision = ?1,
                          deleted_sequence = ?1
                    WHERE conversation_id = ?2
                      AND sort_index < ?3
                      AND revision >= ?4
                      AND deleted_sequence IS NULL
                RETURNING row_id"#,
            )
            .bind(deleted_sequence)
            .bind(conversation_id)
            .bind(SORT_INDEX_SLOT_SPAN)
            .bind(cut_seq)
            .fetch_all(&mut *conn)
            .await?;
            deleted_row_ids.extend(side_deleted);
        }

        if let Err(error) =
            crate::search::delete_fts_rows_on_conn(conn, conversation_id, &deleted_row_ids).await
        {
            tracing::warn!("conversation FTS delete on truncate failed: {error}");
        }

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

        Self::delete_durable_input_events(conn, conversation_id, &drop_input_ids).await?;

        sqlx::query(
            r#"DELETE FROM conversation_turns
               WHERE conversation_id = ? AND ordinal >= ?"#,
        )
        .bind(conversation_id)
        .bind(ordinal)
        .execute(&mut *conn)
        .await?;

        // Re-derive the side-effect tables, surviving rows (preserving tombstones),
        // row-level FTS, and snapshot from the surviving events.
        Self::rebuild_on_connection(conn, conversation_id).await
    }

    async fn durable_inputs_undone_by_truncate(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        ordinal: i64,
    ) -> Result<HashSet<Uuid>, sqlx::Error> {
        let mut ids: HashSet<Uuid> = sqlx::query_scalar(
            r#"SELECT id
               FROM conversation_inputs
               WHERE conversation_id = ?
                 AND (
                   status IN ('queued', 'claimed')
                   OR (
                       status = 'dispatched'
                       AND (
                           turn_id IS NULL
                           OR turn_id IN (
                               SELECT id
                               FROM conversation_turns
                               WHERE conversation_id = ? AND ordinal >= ?
                           )
                       )
                   )
                 )"#,
        )
        .bind(conversation_id)
        .bind(conversation_id)
        .bind(ordinal)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect();

        let truncated_turn_ids: HashSet<Uuid> = sqlx::query_scalar(
            r#"SELECT id
               FROM conversation_turns
               WHERE conversation_id = ? AND ordinal >= ?"#,
        )
        .bind(conversation_id)
        .bind(ordinal)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect();
        if truncated_turn_ids.is_empty() {
            return Ok(ids);
        }

        let events =
            ConversationEventRecord::events_since(&mut *conn, conversation_id, 0, i64::MAX).await?;
        for record in events {
            if let ParsedEvent::Known(ConversationEvent::ConversationInput {
                event:
                    ConversationInputEvent::Dispatched {
                        input_id, turn_id, ..
                    },
            }) = conversation_event_from_record(&record)
                && truncated_turn_ids.contains(&turn_id)
            {
                ids.insert(input_id);
            }
        }
        Ok(ids)
    }

    async fn delete_durable_input_events(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        drop_input_ids: &HashSet<Uuid>,
    ) -> Result<(), sqlx::Error> {
        if drop_input_ids.is_empty() {
            return Ok(());
        }
        let events =
            ConversationEventRecord::events_since(&mut *conn, conversation_id, 0, i64::MAX).await?;
        for record in events {
            if record.event_kind != "conversation_input" {
                continue;
            }
            let ParsedEvent::Known(ConversationEvent::ConversationInput { event }) =
                conversation_event_from_record(&record)
            else {
                continue;
            };
            if drop_input_ids.contains(&conversation_input_event_id(&event)) {
                sqlx::query("DELETE FROM conversation_events WHERE id = ?")
                    .bind(record.id)
                    .execute(&mut *conn)
                    .await?;
            }
        }
        Ok(())
    }
}

fn json_string<T: Serialize>(value: &T) -> Result<String, sqlx::Error> {
    serde_json::to_string(value).map_err(json_decode_error)
}

fn json_string_ref<T: Serialize>(value: &Option<T>) -> Result<Option<String>, sqlx::Error> {
    value.as_ref().map(json_string).transpose()
}

fn event_revision(revision: u64) -> Result<i64, sqlx::Error> {
    i64::try_from(revision)
        .map_err(|_| projection_conflict(format!("input revision {revision} exceeds i64")))
}

fn require_input_projection(
    input_id: Uuid,
    operation: &str,
    applied: bool,
) -> Result<(), sqlx::Error> {
    if applied {
        Ok(())
    } else {
        Err(projection_conflict(format!(
            "cannot {operation} conversation input {input_id} from its current state"
        )))
    }
}

fn projection_conflict(message: String) -> sqlx::Error {
    sqlx::Error::Protocol(message)
}


#[cfg(test)]
#[path = "applier_tests.rs"]
mod tests;
