use std::collections::BTreeMap;

use chrono::Utc;
use sqlx::{Row, SqliteConnection};
use uuid::Uuid;

pub(crate) use crate::store_scheduler::{
    append_event, enqueue_newly_ready, recover_stale_claims, settle_if_complete,
};
use crate::{
    WorkflowError, WorkflowEvent, WorkflowEventRecord, WorkflowStepSpec, WorkflowStore,
    store::{find_run, version_on_connection},
};

impl WorkflowStore {
    pub async fn reconcile_interrupted(&self) -> Result<usize, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            recover_stale_claims(&mut conn, Utc::now()).await?;
            let running = sqlx::query(
                "SELECT step.run_id, step.step_id, step.attempt
                 FROM workflow_step_runs step
                 JOIN workflow_runs run ON run.id = step.run_id
                 WHERE step.status = 'running' AND run.status IN ('running', 'waiting')
                   AND run.control_state = 'active' AND step.awaiting_input = 0
                   AND step.awaiting_acceptance = 0
                 ORDER BY step.run_id, step.step_id",
            )
            .fetch_all(&mut *conn)
            .await?;
            let mut affected_runs = BTreeMap::<Uuid, ()>::new();
            for row in running {
                let run_id: Uuid = row.try_get("run_id")?;
                let step_id: String = row.try_get("step_id")?;
                let attempt: i64 = row.try_get("attempt")?;
                sqlx::query(
                    "UPDATE workflow_step_runs SET status = 'needs_review',
                            updated_at = datetime('now', 'subsec')
                     WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'running'",
                )
                .bind(run_id)
                .bind(&step_id)
                .bind(attempt)
                .execute(&mut *conn)
                .await?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepNeedsReview {
                        step_id,
                        attempt: attempt as u32,
                        reason: "host_restarted_after_agent_step_started".to_string(),
                    },
                )
                .await?;
                affected_runs.insert(run_id, ());
            }
            for run_id in affected_runs.keys() {
                append_event(
                    &mut conn,
                    *run_id,
                    None,
                    &WorkflowEvent::RunNeedsReview {
                        reason: "one or more running steps may have produced side effects"
                            .to_string(),
                    },
                )
                .await?;
                sqlx::query(
                    "UPDATE workflow_runs SET status = 'needs_review',
                            updated_at = datetime('now', 'subsec') WHERE id = ?",
                )
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            }
            Ok(affected_runs.len())
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn reconcile_completed_evidence(&self) -> Result<usize, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let rows = sqlx::query(
                "SELECT step.run_id, step.step_id, step.attempt,
                        step.resolved_input_digest, step.execution_evidence_json,
                        step.workspace_id, run.definition_version_id
                 FROM workflow_step_runs step
                 JOIN workflow_runs run ON run.id = step.run_id
                 WHERE step.status = 'completed' AND run.status IN ('running', 'waiting')
                   AND step.attempt = (
                       SELECT MAX(latest.attempt)
                       FROM workflow_step_runs latest
                       WHERE latest.run_id = step.run_id AND latest.step_id = step.step_id
                   )
                 ORDER BY step.run_id, step.step_id, step.attempt",
            )
            .fetch_all(&mut *conn)
            .await?;
            let mut affected = BTreeMap::<Uuid, ()>::new();
            for row in rows {
                let run_id: Uuid = row.try_get("run_id")?;
                let step_id: String = row.try_get("step_id")?;
                let attempt: i64 = row.try_get("attempt")?;
                let resolved_input_digest: Option<String> = row.try_get("resolved_input_digest")?;
                let evidence_json: Option<String> = row.try_get("execution_evidence_json")?;
                let workspace_id: Option<Uuid> = row.try_get("workspace_id")?;
                let definition_version_id: Uuid = row.try_get("definition_version_id")?;
                let version = version_on_connection(&mut conn, definition_version_id).await?;
                let definition = version.definition()?;
                let Some(definition_step) = definition.steps.iter().find(|step| step.id == step_id)
                else {
                    continue;
                };
                if !matches!(
                    definition_step.spec,
                    WorkflowStepSpec::Agent(_)
                        | WorkflowStepSpec::Session(_)
                        | WorkflowStepSpec::Bot(_)
                ) {
                    continue;
                }
                let accepted_via_review: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM workflow_review_decisions
                     WHERE run_id = ? AND step_id = ? AND decision_kind = 'accept'",
                )
                .bind(run_id)
                .bind(&step_id)
                .fetch_one(&mut *conn)
                .await?;
                if accepted_via_review > 0 && evidence_json.is_none() {
                    continue;
                }
                let evidence = evidence_json
                    .as_deref()
                    .map(serde_json::from_str::<serde_json::Value>)
                    .transpose()?;
                let consistent = evidence.as_ref().is_some_and(|evidence| {
                    evidence
                        .get("definitionDigest")
                        .and_then(serde_json::Value::as_str)
                        == Some(version.digest.as_str())
                        && evidence
                            .get("resolvedInputDigest")
                            .and_then(serde_json::Value::as_str)
                            == resolved_input_digest.as_deref()
                        && evidence
                            .get("workspace")
                            .and_then(|workspace| workspace.get("workspaceId"))
                            .and_then(serde_json::Value::as_str)
                            .and_then(|value| Uuid::parse_str(value).ok())
                            == workspace_id
                });
                if consistent {
                    continue;
                }
                sqlx::query(
                    "UPDATE workflow_step_runs SET status = 'needs_review',
                            updated_at = datetime('now', 'subsec')
                     WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'completed'",
                )
                .bind(run_id)
                .bind(&step_id)
                .bind(attempt)
                .execute(&mut *conn)
                .await?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepNeedsReview {
                        step_id,
                        attempt: attempt as u32,
                        reason: "completed_step_evidence_mismatch".to_string(),
                    },
                )
                .await?;
                affected.insert(run_id, ());
            }
            for run_id in affected.keys() {
                sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
                    .bind(run_id)
                    .execute(&mut *conn)
                    .await?;
                append_event(
                    &mut conn,
                    *run_id,
                    None,
                    &WorkflowEvent::RunNeedsReview {
                        reason: "completed step evidence no longer matches the active Run"
                            .to_string(),
                    },
                )
                .await?;
                sqlx::query(
                    "UPDATE workflow_runs SET status = 'needs_review',
                            updated_at = datetime('now', 'subsec') WHERE id = ?",
                )
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            }
            Ok(affected.len())
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn rebuild_run_projection(&self, run_id: Uuid) -> Result<(), WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            find_run(&mut conn, run_id).await?;
            let records = sqlx::query_as::<_, WorkflowEventRecord>(
                "SELECT id, run_id, sequence, event_version, event_kind, payload_json,
                        operation_id, created_at
                 FROM workflow_events WHERE run_id = ? ORDER BY sequence",
            )
            .bind(run_id)
            .fetch_all(&mut *conn)
            .await?;
            if records.is_empty() {
                return Err(WorkflowError::Projection(format!(
                    "workflow run {run_id} has no event history"
                )));
            }

            sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            sqlx::query("DELETE FROM workflow_step_runs WHERE run_id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'running', agent_calls_started = 0,
                        last_sequence = 0, updated_at = created_at WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;

            for record in &records {
                apply_projection_event(&mut conn, record).await?;
            }
            let last = records.last().expect("non-empty checked above");
            sqlx::query("UPDATE workflow_runs SET last_sequence = ?, updated_at = ? WHERE id = ?")
                .bind(last.sequence)
                .bind(last.created_at)
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            Ok(())
        }
        .await;
        self.finish(conn, result).await
    }
}

async fn apply_projection_event(
    conn: &mut SqliteConnection,
    record: &WorkflowEventRecord,
) -> Result<(), WorkflowError> {
    let run_id = record.run_id;
    match record.event()? {
        WorkflowEvent::RunStarted { step_ids, .. } => {
            for step_id in step_ids {
                sqlx::query(
                    "INSERT INTO workflow_step_runs (id, run_id, step_id, attempt, status)
                     VALUES (?, ?, ?, 1, 'pending')",
                )
                .bind(Uuid::new_v4())
                .bind(run_id)
                .bind(step_id)
                .execute(&mut *conn)
                .await?;
            }
        }
        WorkflowEvent::RunDerived {
            reused_step_ids,
            excluded_step_ids,
            ..
        } => {
            for step_id in reused_step_ids {
                sqlx::query(
                    "UPDATE workflow_step_runs SET execution_mode = 'reuse'
                     WHERE run_id = ? AND step_id = ? AND attempt = 1",
                )
                .bind(run_id)
                .bind(step_id)
                .execute(&mut *conn)
                .await?;
            }
            for step_id in excluded_step_ids {
                sqlx::query(
                    "UPDATE workflow_step_runs SET execution_mode = 'exclude'
                     WHERE run_id = ? AND step_id = ? AND attempt = 1",
                )
                .bind(run_id)
                .bind(step_id)
                .execute(&mut *conn)
                .await?;
            }
        }
        WorkflowEvent::StepReused {
            step_id,
            conversation_id,
            output_json,
            output_schema_digest,
            resolved_input_json,
            resolved_input_digest,
            execution_evidence_json,
            workspace_id,
            completed_at,
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'completed', conversation_id = ?,
                        output_json = ?, output_schema_digest = ?, resolved_input_json = ?,
                        resolved_input_digest = ?, execution_evidence_json = ?, workspace_id = ?,
                        completed_at = ?, execution_mode = 'reuse', updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = 1",
            )
            .bind(conversation_id)
            .bind(output_json)
            .bind(output_schema_digest)
            .bind(resolved_input_json)
            .bind(resolved_input_digest)
            .bind(execution_evidence_json)
            .bind(workspace_id)
            .bind(completed_at)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepReady { step_id, attempt } => {
            sqlx::query(
                "INSERT INTO workflow_step_runs (id, run_id, step_id, attempt, status, updated_at)
                 VALUES (?, ?, ?, ?, 'ready', ?)
                 ON CONFLICT(run_id, step_id, attempt) DO UPDATE SET
                   status = 'ready', claim_token = NULL, claim_deadline = NULL,
                   updated_at = excluded.updated_at",
            )
            .bind(Uuid::new_v4())
            .bind(run_id)
            .bind(&step_id)
            .bind(i64::from(attempt))
            .bind(record.created_at)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "INSERT INTO workflow_ready_steps (
                     run_id, step_id, attempt, ready_sequence, status
                 ) VALUES (?, ?, ?, ?, 'ready')
                 ON CONFLICT(run_id, step_id, attempt) DO UPDATE SET
                   ready_sequence = excluded.ready_sequence, status = 'ready',
                   claim_token = NULL, claim_deadline = NULL",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .bind(record.sequence)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'running' WHERE id = ?
                 AND status IN ('waiting', 'needs_review')",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepClaimed {
            step_id,
            attempt,
            claim_token,
            claim_deadline,
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'claimed', claim_token = ?,
                        claim_deadline = ?, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(claim_token)
            .bind(claim_deadline)
            .bind(record.created_at)
            .bind(run_id)
            .bind(&step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_ready_steps SET status = 'claimed', claim_token = ?,
                        claim_deadline = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(claim_token)
            .bind(claim_deadline)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepClaimReleased { step_id, attempt } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'ready', claim_token = NULL,
                        claim_deadline = NULL, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(&step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_ready_steps SET status = 'ready', claim_token = NULL,
                        claim_deadline = NULL
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepPrepared {
            step_id,
            attempt,
            resolved_input,
            resolved_input_digest,
            execution_evidence,
            workspace_id,
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET resolved_input_json = ?,
                        resolved_input_digest = ?, execution_evidence_json = ?,
                        workspace_id = ?, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(serde_json::to_string(&resolved_input)?)
            .bind(resolved_input_digest)
            .bind(serde_json::to_string(&execution_evidence)?)
            .bind(workspace_id)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepEvidenceRecorded {
            step_id,
            attempt,
            execution_evidence,
            ..
        } => {
            if let Some(execution_evidence) = execution_evidence {
                sqlx::query(
                    "UPDATE workflow_step_runs SET execution_evidence_json = ?, updated_at = ?
                     WHERE run_id = ? AND step_id = ? AND attempt = ?",
                )
                .bind(serde_json::to_string(&execution_evidence)?)
                .bind(record.created_at)
                .bind(run_id)
                .bind(step_id)
                .bind(i64::from(attempt))
                .execute(&mut *conn)
                .await?;
            }
        }
        WorkflowEvent::StepStarted {
            step_id,
            attempt,
            conversation_id,
            turn_id,
            ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'running', conversation_id = ?,
                        turn_id = ?, started_at = ?, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(conversation_id)
            .bind(turn_id)
            .bind(record.created_at)
            .bind(record.created_at)
            .bind(run_id)
            .bind(&step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "DELETE FROM workflow_ready_steps
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET agent_calls_started = agent_calls_started + 1
                 WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepTurnBound {
            step_id,
            attempt,
            conversation_id,
            turn_id,
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET conversation_id = ?, turn_id = ?, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(conversation_id)
            .bind(turn_id)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepWaitingApproval { step_id, attempt } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'waiting_approval', updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query("UPDATE workflow_runs SET status = 'waiting' WHERE id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
        }
        WorkflowEvent::StepWaitingEvent {
            step_id,
            attempt,
            resolved_input,
            resolved_input_digest,
            execution_evidence,
            ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs
                 SET status = 'waiting_approval', resolved_input_json = ?,
                     resolved_input_digest = ?, execution_evidence_json = ?, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(serde_json::to_string(&resolved_input)?)
            .bind(resolved_input_digest)
            .bind(serde_json::to_string(&execution_evidence)?)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query("UPDATE workflow_runs SET status = 'waiting' WHERE id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
        }
        WorkflowEvent::StepEventReceived {
            step_id, attempt, ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepLoopIterated {
            loop_step_id,
            next_loop_attempt,
            target_steps,
        } => {
            for (target_id, target_attempt) in target_steps {
                sqlx::query(
                    "INSERT INTO workflow_step_runs (
                         id, run_id, step_id, attempt, status, execution_mode, updated_at
                     ) VALUES (?, ?, ?, ?, 'pending', 'execute', ?)
                     ON CONFLICT(run_id, step_id, attempt) DO NOTHING",
                )
                .bind(Uuid::new_v4())
                .bind(run_id)
                .bind(target_id)
                .bind(i64::from(target_attempt))
                .bind(record.created_at)
                .execute(&mut *conn)
                .await?;
            }
            sqlx::query(
                "INSERT INTO workflow_step_runs (
                     id, run_id, step_id, attempt, status, execution_mode, updated_at
                 ) VALUES (?, ?, ?, ?, 'pending', 'execute', ?)
                 ON CONFLICT(run_id, step_id, attempt) DO NOTHING",
            )
            .bind(Uuid::new_v4())
            .bind(run_id)
            .bind(loop_step_id)
            .bind(i64::from(next_loop_attempt))
            .bind(record.created_at)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepInteractionWaiting {
            step_id, attempt, ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET waiting_interaction = 1, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query("UPDATE workflow_runs SET status = 'waiting' WHERE id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
        }
        WorkflowEvent::StepInteractionResumed { step_id, attempt } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET waiting_interaction = 0, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            restore_running_if_not_waiting(conn, run_id).await?;
        }
        WorkflowEvent::StepInputRequested {
            step_id, attempt, ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET awaiting_input = 1, turn_id = NULL,
                        waiting_interaction = 0, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query("UPDATE workflow_runs SET status = 'waiting' WHERE id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
        }
        WorkflowEvent::StepInputSubmitted {
            step_id,
            attempt,
            turn_id,
            ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET awaiting_input = 0, turn_id = ?, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(turn_id)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            restore_running_if_not_waiting(conn, run_id).await?;
        }
        WorkflowEvent::StepOutputAccepted {
            step_id,
            attempt,
            output,
            schema_digest,
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET output_json = ?, output_schema_digest = ?,
                        updated_at = ? WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(serde_json::to_string(&output)?)
            .bind(schema_digest)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepCandidateProduced {
            step_id,
            attempt,
            output,
            schema_digest,
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET candidate_output_json = ?,
                        candidate_schema_digest = ?, awaiting_acceptance = 1,
                        turn_id = NULL, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(output.as_ref().map(serde_json::to_string).transpose()?)
            .bind(schema_digest)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query("UPDATE workflow_runs SET status = 'waiting' WHERE id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
        }
        WorkflowEvent::StepCandidateAccepted {
            step_id, attempt, ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET awaiting_acceptance = 0,
                        candidate_output_json = NULL, candidate_schema_digest = NULL,
                        updated_at = ? WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepRepairRequested { step_id, attempt } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET repair_count = repair_count + 1,
                        turn_id = NULL, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET agent_calls_started = agent_calls_started + 1
                 WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::StepCompleted { step_id, attempt } => {
            set_rebuilt_step_terminal(conn, record, &step_id, attempt, "completed").await?;
            restore_running_if_not_waiting(conn, run_id).await?;
        }
        WorkflowEvent::StepFailed {
            step_id, attempt, ..
        } => {
            set_rebuilt_step_terminal(conn, record, &step_id, attempt, "failed").await?;
        }
        WorkflowEvent::StepCancelled { step_id, attempt } => {
            set_rebuilt_step_terminal(conn, record, &step_id, attempt, "cancelled").await?;
        }
        WorkflowEvent::StepInterrupted { step_id, attempt } => {
            set_rebuilt_step_terminal(conn, record, &step_id, attempt, "interrupted").await?;
        }
        WorkflowEvent::StepSkipped { step_id, attempt } => {
            set_rebuilt_step_terminal(conn, record, &step_id, attempt, "skipped").await?;
        }
        WorkflowEvent::StepNeedsReview {
            step_id, attempt, ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'needs_review', updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
            sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
        }
        WorkflowEvent::ReviewDecided { .. } => {
            sqlx::query("UPDATE workflow_runs SET status = 'running' WHERE id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
        }
        WorkflowEvent::ApprovalDecided {
            step_id,
            attempt,
            decision,
            ..
        } => {
            sqlx::query(
                "UPDATE workflow_step_runs SET output_json = ?, updated_at = ?
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(serde_json::to_string(&decision)?)
            .bind(record.created_at)
            .bind(run_id)
            .bind(step_id)
            .bind(i64::from(attempt))
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::RunCompleted => set_rebuilt_run_status(conn, record, "completed").await?,
        WorkflowEvent::RunFailed { .. } => set_rebuilt_run_status(conn, record, "failed").await?,
        WorkflowEvent::RunCancelled { .. } => {
            set_rebuilt_run_status(conn, record, "cancelled").await?
        }
        WorkflowEvent::RunPauseRequested { reason, .. } => {
            sqlx::query(
                "UPDATE workflow_runs SET control_state = 'pausing', pause_reason = ?,
                        updated_at = ? WHERE id = ?",
            )
            .bind(reason)
            .bind(record.created_at)
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::RunPaused => {
            sqlx::query(
                "UPDATE workflow_runs SET control_state = 'paused', paused_at = ?,
                        updated_at = ? WHERE id = ?",
            )
            .bind(record.created_at)
            .bind(record.created_at)
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::RunResumed { .. } => {
            sqlx::query(
                "UPDATE workflow_runs SET control_state = 'active', pause_reason = NULL,
                        paused_at = NULL, updated_at = ? WHERE id = ?",
            )
            .bind(record.created_at)
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
        WorkflowEvent::RunNeedsReview { .. } => {
            set_rebuilt_run_status(conn, record, "needs_review").await?
        }
    }
    Ok(())
}

async fn set_rebuilt_step_terminal(
    conn: &mut SqliteConnection,
    record: &WorkflowEventRecord,
    step_id: &str,
    attempt: u32,
    status: &str,
) -> Result<(), WorkflowError> {
    sqlx::query(
        "UPDATE workflow_step_runs SET status = ?, completed_at = ?, claim_token = NULL,
                claim_deadline = NULL, waiting_interaction = 0, updated_at = ?
         WHERE run_id = ? AND step_id = ? AND attempt = ?",
    )
    .bind(status)
    .bind(record.created_at)
    .bind(record.created_at)
    .bind(record.run_id)
    .bind(step_id)
    .bind(i64::from(attempt))
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM workflow_ready_steps WHERE run_id = ? AND step_id = ? AND attempt = ?",
    )
    .bind(record.run_id)
    .bind(step_id)
    .bind(i64::from(attempt))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub(crate) async fn restore_running_if_not_waiting(
    conn: &mut SqliteConnection,
    run_id: Uuid,
) -> Result<(), WorkflowError> {
    let needs_review: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workflow_step_runs
         WHERE run_id = ? AND attempt = (
             SELECT MAX(latest.attempt) FROM workflow_step_runs latest
             WHERE latest.run_id = workflow_step_runs.run_id
               AND latest.step_id = workflow_step_runs.step_id
         ) AND status = 'needs_review'",
    )
    .bind(run_id)
    .fetch_one(&mut *conn)
    .await?;
    if needs_review > 0 {
        return Ok(());
    }
    let waiting: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workflow_step_runs
         WHERE run_id = ? AND attempt = (
             SELECT MAX(latest.attempt) FROM workflow_step_runs latest
             WHERE latest.run_id = workflow_step_runs.run_id
               AND latest.step_id = workflow_step_runs.step_id
         ) AND (
           status = 'waiting_approval' OR waiting_interaction = 1
           OR awaiting_input = 1 OR awaiting_acceptance = 1
         )",
    )
    .bind(run_id)
    .fetch_one(&mut *conn)
    .await?;
    let status = if waiting == 0 { "running" } else { "waiting" };
    sqlx::query(
        "UPDATE workflow_runs SET status = ?, updated_at = datetime('now', 'subsec')
         WHERE id = ? AND status IN ('waiting', 'needs_review')",
    )
    .bind(status)
    .bind(run_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn set_rebuilt_run_status(
    conn: &mut SqliteConnection,
    record: &WorkflowEventRecord,
    status: &str,
) -> Result<(), WorkflowError> {
    sqlx::query("UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?")
        .bind(status)
        .bind(record.created_at)
        .bind(record.run_id)
        .execute(&mut *conn)
        .await?;
    if status != "running" {
        sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
            .bind(record.run_id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}
