use chrono::Utc;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use uuid::Uuid;

use crate::{
    WorkflowError, WorkflowEvent, WorkflowPolicy, WorkflowRunView, WorkflowStore,
    store::{find_latest_step, find_run, is_terminal_run, version_on_connection},
    store_reconcile::{
        append_event, enqueue_newly_ready, restore_running_if_not_waiting, settle_if_complete,
    },
};

impl WorkflowStore {
    pub async fn complete_step(
        &self,
        run_id: Uuid,
        step_id: &str,
        output: Option<&serde_json::Value>,
        schema_digest: Option<&str>,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            let attempt = step.attempt;
            if step.status == "completed" {
                return find_run(&mut conn, run_id).await;
            }
            if step.awaiting_acceptance {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` has a candidate output awaiting acceptance"
                )));
            }
            if !matches!(step.status.as_str(), "running" | "waiting_approval") {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` cannot complete from {}",
                    step.status
                )));
            }
            if let Some(output) = output {
                let digest = schema_digest.ok_or_else(|| {
                    WorkflowError::Validation("accepted output requires schema digest".to_string())
                })?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepOutputAccepted {
                        step_id: step_id.to_string(),
                        attempt: attempt as u32,
                        output: output.clone(),
                        schema_digest: digest.to_string(),
                    },
                )
                .await?;
                sqlx::query(
                    "UPDATE workflow_step_runs SET output_json = ?, output_schema_digest = ?
                     WHERE run_id = ? AND step_id = ? AND attempt = ?",
                )
                .bind(serde_json::to_string(output)?)
                .bind(digest)
                .bind(run_id)
                .bind(step_id)
                .bind(attempt)
                .execute(&mut *conn)
                .await?;
            }
            sqlx::query(
                "UPDATE workflow_step_runs
                 SET status = 'completed', completed_at = ?, claim_token = NULL,
                     claim_deadline = NULL, waiting_interaction = 0,
                     updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(Utc::now())
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "DELETE FROM workflow_ready_steps
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepCompleted {
                    step_id: step_id.to_string(),
                    attempt: attempt as u32,
                },
            )
            .await?;
            let run = find_run(&mut conn, run_id).await?;
            let version = version_on_connection(&mut conn, run.definition_version_id).await?;
            let definition = version.definition()?;
            enqueue_newly_ready(&mut conn, run_id, &definition).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn stage_step_candidate(
        &self,
        run_id: Uuid,
        step_id: &str,
        output: Option<&serde_json::Value>,
        schema_digest: Option<&str>,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            if step.status != "running" {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` cannot produce a candidate from {}",
                    step.status
                )));
            }
            if step.awaiting_acceptance {
                let same_output = step.candidate_output_json.as_deref()
                    == output.map(serde_json::to_string).transpose()?.as_deref();
                let same_schema = step.candidate_schema_digest.as_deref() == schema_digest;
                if same_output && same_schema {
                    return find_run(&mut conn, run_id).await;
                }
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` already has another candidate output"
                )));
            }
            sqlx::query(
                "UPDATE workflow_step_runs
                 SET candidate_output_json = ?, candidate_schema_digest = ?,
                     awaiting_acceptance = 1, turn_id = NULL,
                     updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'running'",
            )
            .bind(output.map(serde_json::to_string).transpose()?)
            .bind(schema_digest)
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepCandidateProduced {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                    output: output.cloned(),
                    schema_digest: schema_digest.map(str::to_string),
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'waiting',
                        updated_at = datetime('now', 'subsec')
                 WHERE id = ? AND status = 'running'",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn accept_step_candidate(
        &self,
        run_id: Uuid,
        step_id: &str,
        operation_id: Uuid,
        payload_digest: &str,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if let Some((existing_run_id, existing_step_id, existing_digest)) =
                sqlx::query_as::<_, (Uuid, Option<String>, String)>(
                    "SELECT run_id, step_id, payload_digest
                     FROM workflow_run_control_operations WHERE operation_id = ?",
                )
                .bind(operation_id)
                .fetch_optional(&mut *conn)
                .await?
            {
                if existing_run_id != run_id
                    || existing_step_id.as_deref() != Some(step_id)
                    || existing_digest != payload_digest
                {
                    return Err(WorkflowError::Conflict(
                        "operation id was already used with another candidate acceptance"
                            .to_string(),
                    ));
                }
                return find_run(&mut conn, run_id).await;
            }
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            if step.status != "running" || !step.awaiting_acceptance {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` has no candidate output awaiting acceptance"
                )));
            }
            sqlx::query(
                "INSERT INTO workflow_run_control_operations (
                    operation_id, run_id, action, step_id, payload_digest, principal_json
                 ) VALUES (?, ?, 'accept_candidate', ?, ?, ?)",
            )
            .bind(operation_id)
            .bind(run_id)
            .bind(step_id)
            .bind(payload_digest)
            .bind(principal_json)
            .execute(&mut *conn)
            .await?;
            let output = step
                .candidate_output_json
                .as_deref()
                .map(serde_json::from_str::<serde_json::Value>)
                .transpose()?;
            if let Some(output) = &output {
                sqlx::query(
                    "UPDATE workflow_step_runs
                     SET output_json = ?, output_schema_digest = ?
                     WHERE run_id = ? AND step_id = ? AND attempt = ?",
                )
                .bind(serde_json::to_string(output)?)
                .bind(step.candidate_schema_digest.as_deref())
                .bind(run_id)
                .bind(step_id)
                .bind(step.attempt)
                .execute(&mut *conn)
                .await?;
                if let Some(schema_digest) = step.candidate_schema_digest.as_deref() {
                    append_event(
                        &mut conn,
                        run_id,
                        None,
                        &WorkflowEvent::StepOutputAccepted {
                            step_id: step_id.to_string(),
                            attempt: step.attempt as u32,
                            output: output.clone(),
                            schema_digest: schema_digest.to_string(),
                        },
                    )
                    .await?;
                }
            }
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::StepCandidateAccepted {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                    principal: serde_json::from_str(principal_json)?,
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_step_runs
                 SET status = 'completed', completed_at = ?, claim_token = NULL,
                     claim_deadline = NULL, waiting_interaction = 0,
                     awaiting_acceptance = 0,
                     candidate_output_json = NULL, candidate_schema_digest = NULL,
                     updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(Utc::now())
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepCompleted {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                },
            )
            .await?;
            let run = find_run(&mut conn, run_id).await?;
            let definition = version_on_connection(&mut conn, run.definition_version_id)
                .await?
                .definition()?;
            enqueue_newly_ready(&mut conn, run_id, &definition).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn fail_step(
        &self,
        run_id: Uuid,
        step_id: &str,
        code: &str,
        message: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            let attempt = step.attempt;
            if matches!(step.status.as_str(), "completed" | "failed" | "cancelled") {
                return find_run(&mut conn, run_id).await;
            }
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'failed', completed_at = ?,
                        claim_token = NULL, claim_deadline = NULL, waiting_interaction = 0,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(Utc::now())
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .execute(&mut *conn)
            .await?;
            sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepFailed {
                    step_id: step_id.to_string(),
                    attempt: attempt as u32,
                    code: code.to_string(),
                    message: message.to_string(),
                },
            )
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::RunFailed {
                    code: code.to_string(),
                    message: message.to_string(),
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'failed',
                        updated_at = datetime('now', 'subsec')
                 WHERE id = ? AND status IN ('running', 'waiting')",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn needs_review_step(
        &self,
        run_id: Uuid,
        step_id: &str,
        reason: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            let attempt = step.attempt;
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'needs_review',
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?
                   AND status IN ('claimed', 'running')",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepNeedsReview {
                    step_id: step_id.to_string(),
                    attempt: attempt as u32,
                    reason: reason.to_string(),
                },
            )
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::RunNeedsReview {
                    reason: reason.to_string(),
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'needs_review',
                        updated_at = datetime('now', 'subsec')
                 WHERE id = ? AND status IN ('running', 'waiting')",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn retry_review_step(
        &self,
        run_id: Uuid,
        step_id: &str,
        operation_id: Uuid,
        payload_digest: &str,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if review_operation_is_retry(&mut conn, run_id, operation_id, payload_digest).await? {
                return find_run(&mut conn, run_id).await;
            }
            let run = find_run(&mut conn, run_id).await?;
            if run.status != "needs_review" {
                return Err(WorkflowError::Conflict(
                    "workflow run is not awaiting review".to_string(),
                ));
            }
            if run.deadline_at <= Utc::now() {
                return Err(WorkflowError::Conflict(
                    "workflow deadline has expired".to_string(),
                ));
            }
            let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
            if run.agent_calls_started >= i64::from(policy.max_agent_calls) {
                return Err(WorkflowError::Conflict(
                    "workflow agent call budget is exhausted".to_string(),
                ));
            }
            let previous = find_latest_step(&mut conn, run_id, step_id).await?;
            if previous.status != "needs_review" {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` is not awaiting review"
                )));
            }
            record_review_decision(
                &mut conn,
                run_id,
                step_id,
                operation_id,
                payload_digest,
                "retry",
                principal_json,
            )
            .await?;
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::ReviewDecided {
                    step_id: step_id.to_string(),
                    from_attempt: previous.attempt as u32,
                    decision: "retry".to_string(),
                    principal: serde_json::from_str(principal_json)?,
                },
            )
            .await?;
            let attempt = previous.attempt + 1;
            let ready = append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepReady {
                    step_id: step_id.to_string(),
                    attempt: attempt as u32,
                },
            )
            .await?;
            sqlx::query(
                "INSERT INTO workflow_step_runs (id, run_id, step_id, attempt, status)
                 VALUES (?, ?, ?, ?, 'ready')",
            )
            .bind(Uuid::new_v4())
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "INSERT INTO workflow_ready_steps (
                     run_id, step_id, attempt, ready_sequence, status
                 ) VALUES (?, ?, ?, ?, 'ready')",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .bind(ready.sequence)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'running',
                        updated_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn accept_review_step(
        &self,
        run_id: Uuid,
        step_id: &str,
        output: Option<&serde_json::Value>,
        schema_digest: Option<&str>,
        operation_id: Uuid,
        payload_digest: &str,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if review_operation_is_retry(&mut conn, run_id, operation_id, payload_digest).await? {
                return find_run(&mut conn, run_id).await;
            }
            let run = find_run(&mut conn, run_id).await?;
            if run.status != "needs_review" {
                return Err(WorkflowError::Conflict(
                    "workflow run is not awaiting review".to_string(),
                ));
            }
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            if step.status != "needs_review" {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` is not awaiting review"
                )));
            }
            record_review_decision(
                &mut conn,
                run_id,
                step_id,
                operation_id,
                payload_digest,
                "accept",
                principal_json,
            )
            .await?;
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::ReviewDecided {
                    step_id: step_id.to_string(),
                    from_attempt: step.attempt as u32,
                    decision: "accept".to_string(),
                    principal: serde_json::from_str(principal_json)?,
                },
            )
            .await?;
            if let Some(output) = output {
                let digest = schema_digest.ok_or_else(|| {
                    WorkflowError::Validation("accepted output requires schema digest".to_string())
                })?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepOutputAccepted {
                        step_id: step_id.to_string(),
                        attempt: step.attempt as u32,
                        output: output.clone(),
                        schema_digest: digest.to_string(),
                    },
                )
                .await?;
                sqlx::query(
                    "UPDATE workflow_step_runs SET output_json = ?, output_schema_digest = ?
                     WHERE run_id = ? AND step_id = ? AND attempt = ?",
                )
                .bind(serde_json::to_string(output)?)
                .bind(digest)
                .bind(run_id)
                .bind(step_id)
                .bind(step.attempt)
                .execute(&mut *conn)
                .await?;
            }
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'completed', completed_at = ?,
                        waiting_interaction = 0,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(Utc::now())
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepCompleted {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                },
            )
            .await?;
            let version = version_on_connection(&mut conn, run.definition_version_id).await?;
            enqueue_newly_ready(&mut conn, run_id, &version.definition()?).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn skip_review_step(
        &self,
        run_id: Uuid,
        step_id: &str,
        operation_id: Uuid,
        payload_digest: &str,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if review_operation_is_retry(&mut conn, run_id, operation_id, payload_digest).await? {
                return find_run(&mut conn, run_id).await;
            }
            let run = find_run(&mut conn, run_id).await?;
            if run.status != "needs_review" {
                return Err(WorkflowError::Conflict(
                    "workflow run is not awaiting review".to_string(),
                ));
            }
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            if step.status != "needs_review" {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` is not awaiting review"
                )));
            }
            record_review_decision(
                &mut conn,
                run_id,
                step_id,
                operation_id,
                payload_digest,
                "skip",
                principal_json,
            )
            .await?;
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::ReviewDecided {
                    step_id: step_id.to_string(),
                    from_attempt: step.attempt as u32,
                    decision: "skip".to_string(),
                    principal: serde_json::from_str(principal_json)?,
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'skipped', completed_at = ?,
                        waiting_interaction = 0,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(Utc::now())
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepSkipped {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                },
            )
            .await?;
            let version = version_on_connection(&mut conn, run.definition_version_id).await?;
            enqueue_newly_ready(&mut conn, run_id, &version.definition()?).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn decide_approval(
        &self,
        run_id: Uuid,
        step_id: &str,
        decision: &serde_json::Value,
        payload_digest: &str,
        operation_id: Uuid,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let existing: Option<(String, String)> = sqlx::query_as(
                "SELECT step_id, payload_digest
                 FROM workflow_approval_decisions WHERE operation_id = ?",
            )
            .bind(operation_id)
            .fetch_optional(&mut *conn)
            .await?;
            if let Some((existing_step, existing_digest)) = existing {
                if existing_step != step_id || existing_digest != payload_digest {
                    return Err(WorkflowError::Conflict(
                        "approval operation id was already used with another payload".to_string(),
                    ));
                }
                return find_run(&mut conn, run_id).await;
            }
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            let attempt = step.attempt;
            if step.status != "waiting_approval" {
                return Err(WorkflowError::Conflict(format!(
                    "approval step `{step_id}` is no longer waiting"
                )));
            }
            let inserted = sqlx::query(
                "INSERT INTO workflow_approval_decisions (
                     run_id, step_id, attempt, operation_id, principal_json, decision_json,
                     payload_digest
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(run_id, step_id, attempt) DO NOTHING",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .bind(operation_id)
            .bind(principal_json)
            .bind(serde_json::to_string(decision)?)
            .bind(payload_digest)
            .execute(&mut *conn)
            .await?;
            if inserted.rows_affected() != 1 {
                return Err(WorkflowError::Conflict(
                    "approval step already has a decision".to_string(),
                ));
            }
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::ApprovalDecided {
                    step_id: step_id.to_string(),
                    attempt: attempt as u32,
                    decision: decision.clone(),
                    principal: serde_json::from_str(principal_json)?,
                },
            )
            .await?;
            let decision_str = serde_json::to_string(decision)?;
            let now_dt = Utc::now();
            sqlx::query(
                "UPDATE workflow_step_runs SET status = 'completed', output_json = ?,
                        waiting_interaction = 0,
                        completed_at = ?, updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(&decision_str)
            .bind(now_dt)
            .bind(run_id)
            .bind(step_id)
            .bind(attempt)
            .execute(&mut *conn)
            .await?;
            let has_interactions_table: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pulse_user_interactions' LIMIT 1",
            )
            .fetch_optional(&mut *conn)
            .await?;
            if has_interactions_table.is_some() {
                sqlx::query(
                    "UPDATE pulse_user_interactions
                     SET status = 'resolved', resolution_json = ?, resolved_at = ?
                     WHERE workflow_run_id = ? AND step_id = ? AND status = 'pending'",
                )
                .bind(&decision_str)
                .bind(now_dt.to_rfc3339())
                .bind(run_id.to_string())
                .bind(step_id)
                .execute(&mut *conn)
                .await?;
            }
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepCompleted {
                    step_id: step_id.to_string(),
                    attempt: attempt as u32,
                },
            )
            .await?;
            let run = find_run(&mut conn, run_id).await?;
            let version = version_on_connection(&mut conn, run.definition_version_id).await?;
            enqueue_newly_ready(&mut conn, run_id, &version.definition()?).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn cancel(
        &self,
        run_id: Uuid,
        operation_id: Uuid,
        reason: Option<&str>,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let payload_digest = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&serde_json::json!({
                    "runId": run_id,
                    "reason": reason,
                }))?)
            );
            let existing: Option<(Uuid, String)> = sqlx::query_as(
                "SELECT run_id, payload_digest
                 FROM workflow_cancel_operations WHERE operation_id = ?",
            )
            .bind(operation_id)
            .fetch_optional(&mut *conn)
            .await?;
            if let Some((existing_run_id, existing_digest)) = existing {
                if existing_run_id != run_id || existing_digest != payload_digest {
                    return Err(WorkflowError::Conflict(
                        "cancel operation id was already used with another payload".to_string(),
                    ));
                }
                return find_run(&mut conn, run_id).await;
            }
            sqlx::query(
                "INSERT INTO workflow_cancel_operations (run_id, operation_id, payload_digest)
                 VALUES (?, ?, ?)",
            )
            .bind(run_id)
            .bind(operation_id)
            .bind(&payload_digest)
            .execute(&mut *conn)
            .await?;
            let run = find_run(&mut conn, run_id).await?;
            if is_terminal_run(&run.status) {
                return Ok(run);
            }
            let active = sqlx::query(
                "SELECT step_id, attempt FROM workflow_step_runs
                 WHERE run_id = ? AND status NOT IN (
                     'completed', 'failed', 'cancelled', 'interrupted', 'skipped'
                 ) ORDER BY step_id, attempt",
            )
            .bind(run_id)
            .fetch_all(&mut *conn)
            .await?;
            for row in active {
                let step_id: String = row.try_get("step_id")?;
                let attempt: i64 = row.try_get("attempt")?;
                sqlx::query(
                    "UPDATE workflow_step_runs SET status = 'cancelled', completed_at = ?,
                            waiting_interaction = 0,
                            updated_at = datetime('now', 'subsec')
                     WHERE run_id = ? AND step_id = ? AND attempt = ?",
                )
                .bind(Utc::now())
                .bind(run_id)
                .bind(&step_id)
                .bind(attempt)
                .execute(&mut *conn)
                .await?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepCancelled {
                        step_id,
                        attempt: attempt as u32,
                    },
                )
                .await?;
            }
            sqlx::query("DELETE FROM workflow_ready_steps WHERE run_id = ?")
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
            let has_interactions_table: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pulse_user_interactions' LIMIT 1",
            )
            .fetch_optional(&mut *conn)
            .await?;
            if has_interactions_table.is_some() {
                sqlx::query(
                    "UPDATE pulse_user_interactions
                     SET status = 'expired', resolved_at = ?
                     WHERE workflow_run_id = ? AND status = 'pending'",
                )
                .bind(Utc::now().to_rfc3339())
                .bind(run_id.to_string())
                .execute(&mut *conn)
                .await?;
            }
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::RunCancelled {
                    reason: reason.map(str::to_string),
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET status = 'cancelled',
                        updated_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn request_pause(
        &self,
        run_id: Uuid,
        operation_id: Uuid,
        reason: Option<&str>,
        payload_digest: &str,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if let Some((existing_run_id, existing_digest)) = sqlx::query_as::<_, (Uuid, String)>(
                "SELECT run_id, payload_digest FROM workflow_run_control_operations
                     WHERE operation_id = ?",
            )
            .bind(operation_id)
            .fetch_optional(&mut *conn)
            .await?
            {
                if existing_run_id != run_id || existing_digest != payload_digest {
                    return Err(WorkflowError::Conflict(
                        "operation id was already used with another pause request".to_string(),
                    ));
                }
                return find_run(&mut conn, run_id).await;
            }
            let run = find_run(&mut conn, run_id).await?;
            if is_terminal_run(&run.status) {
                return Err(WorkflowError::Conflict(
                    "terminal workflow runs cannot be paused".to_string(),
                ));
            }
            sqlx::query(
                "INSERT INTO workflow_run_control_operations (
                    operation_id, run_id, action, payload_digest, principal_json
                 ) VALUES (?, ?, 'pause', ?, ?)",
            )
            .bind(operation_id)
            .bind(run_id)
            .bind(payload_digest)
            .bind(principal_json)
            .execute(&mut *conn)
            .await?;
            if run.control_state == "active" {
                sqlx::query(
                    "UPDATE workflow_runs SET control_state = 'pausing', pause_reason = ?,
                            updated_at = datetime('now', 'subsec') WHERE id = ?",
                )
                .bind(reason)
                .bind(run_id)
                .execute(&mut *conn)
                .await?;
                append_event(
                    &mut conn,
                    run_id,
                    Some(operation_id),
                    &WorkflowEvent::RunPauseRequested {
                        reason: reason.map(str::to_string),
                        principal: serde_json::from_str(principal_json)?,
                    },
                )
                .await?;
            }
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn mark_paused(&self, run_id: Uuid) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let run = find_run(&mut conn, run_id).await?;
            if run.control_state == "paused" {
                return Ok(run);
            }
            if run.control_state != "pausing" {
                return Err(WorkflowError::Conflict(
                    "workflow run has no pending pause request".to_string(),
                ));
            }
            sqlx::query(
                "UPDATE workflow_runs SET control_state = 'paused', paused_at = ?,
                        updated_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(Utc::now())
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            append_event(&mut conn, run_id, None, &WorkflowEvent::RunPaused).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn resume_paused_run(
        &self,
        run_id: Uuid,
        operation_id: Uuid,
        payload_digest: &str,
        principal_json: &str,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if let Some((existing_run_id, existing_digest)) = sqlx::query_as::<_, (Uuid, String)>(
                "SELECT run_id, payload_digest FROM workflow_run_control_operations
                     WHERE operation_id = ?",
            )
            .bind(operation_id)
            .fetch_optional(&mut *conn)
            .await?
            {
                if existing_run_id != run_id || existing_digest != payload_digest {
                    return Err(WorkflowError::Conflict(
                        "operation id was already used with another resume request".to_string(),
                    ));
                }
                return find_run(&mut conn, run_id).await;
            }
            let run = find_run(&mut conn, run_id).await?;
            if !matches!(run.control_state.as_str(), "pausing" | "paused") {
                return Err(WorkflowError::Conflict(
                    "workflow run is not paused".to_string(),
                ));
            }
            sqlx::query(
                "INSERT INTO workflow_run_control_operations (
                    operation_id, run_id, action, payload_digest, principal_json
                 ) VALUES (?, ?, 'resume', ?, ?)",
            )
            .bind(operation_id)
            .bind(run_id)
            .bind(payload_digest)
            .bind(principal_json)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET control_state = 'active', pause_reason = NULL,
                        paused_at = NULL, updated_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::RunResumed {
                    principal: serde_json::from_str(principal_json)?,
                },
            )
            .await?;
            restore_running_if_not_waiting(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }
}

async fn review_operation_is_retry(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    operation_id: Uuid,
    payload_digest: &str,
) -> Result<bool, WorkflowError> {
    let existing: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT run_id, payload_digest FROM workflow_review_decisions WHERE operation_id = ?",
    )
    .bind(operation_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((existing_run_id, existing_digest)) = existing else {
        return Ok(false);
    };
    if existing_run_id != run_id || existing_digest != payload_digest {
        return Err(WorkflowError::Conflict(
            "review operation id was already used with another payload".to_string(),
        ));
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
async fn record_review_decision(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    step_id: &str,
    operation_id: Uuid,
    payload_digest: &str,
    decision_kind: &str,
    principal_json: &str,
) -> Result<(), WorkflowError> {
    sqlx::query(
        "INSERT INTO workflow_review_decisions (
             run_id, step_id, operation_id, payload_digest, decision_kind, principal_json
         ) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(run_id)
    .bind(step_id)
    .bind(operation_id)
    .bind(payload_digest)
    .bind(decision_kind)
    .bind(principal_json)
    .execute(&mut *conn)
    .await?;
    Ok(())
}
