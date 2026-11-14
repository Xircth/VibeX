use std::collections::HashSet;

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
    conversation_steering::ConversationSteeringRecord,
    conversation_tool::{ConversationToolCallRecord, UpsertConversationToolCall},
    conversation_turn::ConversationTurnRecord,
};
use serde::Serialize;
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;

use super::{
    ConversationProjector, ParsedEvent, cache::json_decode_error, conversation_event_from_record,
    conversation_input_event_id,
};

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

    pub(crate) async fn append_and_apply(
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
                } => {
                    ConversationSteeringRecord::settle_on_connection(
                        conn,
                        record.conversation_id,
                        steering_id,
                        expected_turn_id,
                        "accepted",
                        None,
                        None,
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
        let _ = crate::jsonl_history::truncate_transcript_to_user_ordinal(
            pool,
            conversation_id,
            ordinal.saturating_sub(1).max(0) as usize,
        )
        .await;
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
        // Durable input Submitted/Claimed events have no turn_id, so they sit
        // before the turn-owned cut. If they survive, rebuild re-queues the
        // truncated prompt and a reset-to-here resend submits it a second time.
        let drop_input_ids =
            Self::durable_inputs_undone_by_truncate(conn, conversation_id, ordinal).await?;

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

        Self::delete_durable_input_events(conn, conversation_id, &drop_input_ids).await?;

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
            let mut body = crate::search::extract_searchable_text(&timeline);
            let manifest = crate::transcript_segments::read_on_connection(
                conn,
                &agents::acp_transcript::vibex_acp_transcripts_root(),
                conversation_id,
            )
            .await?;
            if let Some(turns) = manifest
                .or_else(|| crate::jsonl_history::read_existing_transcript_turns(conversation_id))
            {
                let jsonl_timeline =
                    crate::jsonl_history::timeline_from_turns(conversation_id, &turns);
                let jsonl_body = crate::search::extract_searchable_text(&jsonl_timeline);
                if !jsonl_body.is_empty() {
                    body = jsonl_body;
                }
            }
            crate::search::reindex_conversation(&mut *conn, conversation_id, &body).await
        }
        .await;
        if let Err(error) = reindex {
            tracing::warn!("conversation FTS reindex on truncate failed: {error}");
        }
        Ok(())
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
