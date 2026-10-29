use std::collections::HashSet;

use agents::conversation::{ConversationEvent, ConversationInputEvent};
use db::models::{
    conversation::{ConversationAgentBindingRecord, ConversationRecord},
    conversation_event::{
        AppendConversationEvent, ConversationEventRecord,
        find_conversation_event_by_idempotency, insert_conversation_event,
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

use super::cache::json_decode_error;
use super::{
    ConversationProjector, ParsedEvent, conversation_event_from_record,
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
            let body = crate::search::extract_searchable_text(&timeline);
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
mod tests {
    use crate::projection::CONVERSATION_PROJECTION_VERSION;
    use agents::{
        AcpCapabilitySnapshot, AgentId, AgentPermissionId, AgentPermissionOption,
        AgentPermissionOptionKind, AgentPermissionRequest, AgentPermissionResponse,
        AgentSessionConfigOption, AgentSessionId,
        conversation::{
            AgentPromptCapabilities, ConversationEvent, ConversationFileChange,
            ConversationFileChangeSummary, ConversationInputBlock, ConversationPermissionRequest,
            ConversationPermissionResponse, ConversationTerminalPatch, ConversationToolCallPatch,
            ConversationUsage,
        },
    };
    use db::models::{
        conversation::{
            ConversationAgentBindingRecord, CreateConversationAgentBinding,
            DbConversationSummary,
        },
        conversation_event::{
            AppendConversationEvent, ConversationEventRecord,
        },
        conversation_turn::ConversationTurnRecord,
        session::Session,
    };
    use uuid::Uuid;

    use super::{ConversationEventAppender, ConversationStateApplier};
    use crate::projection::rows::tests::{append_event, seed_turn, setup_pool};
    #[tokio::test]
    async fn negotiated_handshake_snapshot_updates_binding_columns() {
        let pool = setup_pool().await;
        let (conversation_id, _) = seed_turn(&pool).await;
        let agent_id = AgentId::parse("codex").unwrap();
        ConversationAgentBindingRecord::create(
            &pool,
            Uuid::new_v4(),
            CreateConversationAgentBinding {
                conversation_id,
                agent_id: &agent_id,
                working_dir: "/tmp/work",
                acp_session_id: None,
                acp_protocol_version: None,
                runtime_version: None,
                acp_version: None,
                load_supported: false,
                resume_supported: false,
                close_supported: false,
                terminal_supported: false,
                additional_directories_supported: false,
                prompt_capabilities_json:
                    r#"{"text":true,"image":false,"audio":false,"resource":false,"resource_link":true}"#,
                session_capabilities_json: "{}",
                client_capabilities_json: "{}",
                mcp_servers_json: "[]",
                modes_json: "[]",
                config_options_json: "[]",
                current_mode: None,
                config_selection_json: "{}",
                status: db::models::conversation::BindingStatus::Connecting,
            },
        )
        .await
        .expect("create conservative binding");

        let capabilities = AcpCapabilitySnapshot {
            load_session: false,
            resume_session: true,
            close_session: false,
            terminal: true,
            additional_directories: true,
            mcp_stdio: true,
            prompt: AgentPromptCapabilities {
                text: true,
                image: false,
                resource_link: true,
                ..Default::default()
            },
            ..Default::default()
        };

        append_event(
            &pool,
            conversation_id,
            None,
            "acp",
            ConversationEvent::AgentBindingReady {
                acp_session_id: "acp-session-1".into(),
                capabilities,
            },
            None,
        )
        .await;

        let binding =
            ConversationAgentBindingRecord::latest_for_conversation(&pool, conversation_id)
                .await
                .expect("latest binding")
                .expect("binding exists");
        assert!(!binding.load_supported);
        assert!(binding.resume_supported);
        assert!(!binding.close_supported);
        assert!(binding.terminal_supported);
        assert!(binding.additional_directories_supported);
        let prompt: serde_json::Value =
            serde_json::from_str(&binding.prompt_capabilities_json).expect("prompt json");
        assert_eq!(prompt["text"], true);
        assert_eq!(prompt["image"], false);
        assert_eq!(prompt["resource_link"], true);
        let session: AcpCapabilitySnapshot =
            serde_json::from_str(&binding.session_capabilities_json).expect("session json");
        assert!(session.mcp_stdio);
        assert!(!session.load_session);
        assert!(session.resume_session);
    }


    #[tokio::test]
    async fn usage_and_config_events_cache_session_model() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::SessionConfigOptionsUpdated {
                options: vec![AgentSessionConfigOption {
                    key: "model".into(),
                    label: "Model".into(),
                    description: None,
                    category: Some("model".into()),
                    value: Some(serde_json::json!("grok-4.6")),
                    choices: Vec::new(),
                    dependency: None,
                }],
            },
            None,
        )
        .await;

        let session = DbConversationSummary::find_by_id(&pool, conversation_id)
            .await
            .expect("load")
            .expect("session");
        assert_eq!(session.model.as_deref(), Some("grok-4.6"));

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: 29_214,
                    output_tokens: 1_652,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 56_960,
                    context_used: Some(18_658),
                    context_window_max: Some(500_000),
                    cost_amount: None,
                    cost_currency: None,
                    model: Some("grok-4.6".into()),
                },
            },
            None,
        )
        .await;

        let snapshot = db::models::conversation_usage::ConversationUsageSnapshotRecord::find(
            &pool,
            conversation_id,
        )
        .await
        .expect("snapshot")
        .expect("exists");
        assert_eq!(snapshot.model.as_deref(), Some("grok-4.6"));
        assert_eq!(snapshot.protocol_total_tokens, Some(87_826));
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
    async fn completed_unviewed_turn_moves_session_to_in_review() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;

        let session = Session::find_by_id(&pool, conversation_id)
            .await
            .expect("load session")
            .expect("session");
        assert_eq!(session.status, db::models::session::SessionStatus::InReview);
    }


    #[tokio::test]
    async fn viewing_a_completed_turn_moves_session_to_done() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;
        crate::workbench_status::mark_latest_turn_viewed(&pool, conversation_id)
            .await
            .expect("mark viewed");

        let session = Session::find_by_id(&pool, conversation_id)
            .await
            .expect("load session")
            .expect("session");
        assert_eq!(session.status, db::models::session::SessionStatus::Done);
    }


    #[tokio::test]
    async fn viewing_an_in_flight_turn_stays_in_review_when_the_turn_completes() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        crate::workbench_status::mark_latest_turn_viewed(&pool, conversation_id)
            .await
            .expect("view while the turn is still in flight");
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;

        let session = Session::find_by_id(&pool, conversation_id)
            .await
            .expect("load session")
            .expect("session");
        assert_eq!(session.status, db::models::session::SessionStatus::InReview);
        let viewed: Option<Uuid> =
            sqlx::query_scalar("SELECT last_viewed_turn_id FROM sessions WHERE id = ?")
                .bind(conversation_id)
                .fetch_one(&pool)
                .await
                .expect("view cursor");
        assert_ne!(viewed, Some(turn_id));
    }


    #[tokio::test]
    async fn in_flight_view_cursor_is_cleared_when_the_turn_completes() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        sqlx::query(
            "UPDATE sessions SET status = 'inprogress', last_viewed_turn_id = ? WHERE id = ?",
        )
        .bind(turn_id)
        .bind(conversation_id)
        .execute(&pool)
        .await
        .expect("record an in-flight view");
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;

        let session = Session::find_by_id(&pool, conversation_id)
            .await
            .expect("load session")
            .expect("session");
        assert_eq!(session.status, db::models::session::SessionStatus::InReview);
    }


    #[tokio::test]
    async fn manual_done_during_an_in_flight_turn_stays_done_after_completion() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        crate::workbench_status::apply_manual_status(
            &pool,
            conversation_id,
            db::models::session::SessionStatus::Done,
        )
        .await
        .expect("drag to done");
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;

        let session = Session::find_by_id(&pool, conversation_id)
            .await
            .expect("load session")
            .expect("session");
        assert_eq!(session.status, db::models::session::SessionStatus::Done);
    }


    #[tokio::test]
    async fn cancelled_turn_moves_session_to_done() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCancelled { reason: None },
            None,
        )
        .await;

        let session = Session::find_by_id(&pool, conversation_id)
            .await
            .expect("load session")
            .expect("session");
        assert_eq!(session.status, db::models::session::SessionStatus::Done);
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
                    response: AgentPermissionResponse::selected("allow"),
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
                workflow_refs: Vec::new(),
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

}
