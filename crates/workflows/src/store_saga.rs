use chrono::{DateTime, Utc};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    EventEnvelope, WaitingWorkflowStep, WorkflowError, WorkflowEvent, WorkflowRunView,
    WorkflowStepSpec, WorkflowStore, match_waiting_step,
    store::{find_latest_step, find_run, version_on_connection},
    store_reconcile::{
        append_event, enqueue_newly_ready, restore_running_if_not_waiting, settle_if_complete,
    },
};

impl WorkflowStore {
    /// Lists all active `WaitForEvent` Saga steps currently suspended and awaiting a matching event.
    pub async fn waiting_event_steps(&self) -> Result<Vec<WaitingWorkflowStep>, WorkflowError> {
        let mut conn = self.pool.acquire().await?;
        let rows = sqlx::query(
            "SELECT step.run_id, run.workspace_id, run.input_json,
                    wdv.normalized_json,
                    step.step_id, step.attempt, step.resolved_input_json,
                    step.execution_evidence_json
             FROM workflow_step_runs step
             JOIN workflow_runs run ON run.id = step.run_id
             JOIN workflow_definition_versions wdv ON wdv.id = run.definition_version_id
             WHERE step.status = 'waiting_approval'
               AND json_extract(step.execution_evidence_json, '$.primitive') = 'wait_for_event'
               AND run.status = 'waiting'
               AND run.control_state = 'active'
               AND step.attempt = (
                   SELECT MAX(latest.attempt)
                   FROM workflow_step_runs latest
                   WHERE latest.run_id = step.run_id AND latest.step_id = step.step_id
               )
             ORDER BY run.created_at, step.step_id",
        )
        .fetch_all(&mut *conn)
        .await?;

        let mut waiting = Vec::new();
        for row in rows {
            let run_id: Uuid = row.try_get("run_id")?;
            let workspace_id: Uuid = row.try_get("workspace_id")?;
            let input_json: String = row.try_get("input_json")?;
            let normalized_json: String = row.try_get("normalized_json")?;
            let step_id: String = row.try_get("step_id")?;
            let attempt: i64 = row.try_get("attempt")?;
            let resolved_input_json: Option<String> = row.try_get("resolved_input_json")?;
            let evidence_json: Option<String> = row.try_get("execution_evidence_json")?;

            let definition: crate::WorkflowDefinition = serde_json::from_str(&normalized_json)?;
            let Some(definition_step) = definition.steps.iter().find(|s| s.id == step_id) else {
                continue;
            };
            let WorkflowStepSpec::WaitForEvent(wait_spec) = &definition_step.spec else {
                continue;
            };
            let correlation_context = match resolved_input_json.as_deref() {
                Some(raw) => serde_json::from_str::<serde_json::Value>(raw)?,
                None => serde_json::from_str::<serde_json::Value>(&input_json)?,
            };
            let timeout_at = parse_timeout_from_evidence(evidence_json.as_deref());
            waiting.push(WaitingWorkflowStep {
                run_id,
                workspace_id,
                step_id,
                attempt: attempt as u32,
                spec: wait_spec.clone(),
                correlation_context,
                timeout_at,
            });
        }
        Ok(waiting)
    }

    /// Resumes a suspended `WaitForEvent` step when a matching `EventEnvelope` arrives,
    /// recording the envelope as the step's accepted output and scheduling downstream steps.
    pub async fn resume_waiting_step(
        &self,
        run_id: Uuid,
        step_id: &str,
        envelope: &EventEnvelope,
        payload_digest: &str,
        operation_id: Uuid,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if let Some((existing_run_id, existing_step_id, existing_digest)) =
                sqlx::query_as::<_, (Uuid, String, String)>(
                    "SELECT run_id, step_id, payload_digest
                     FROM workflow_approval_decisions WHERE operation_id = ?",
                )
                .bind(operation_id)
                .fetch_optional(&mut *conn)
                .await?
            {
                if existing_run_id != run_id
                    || existing_step_id != step_id
                    || existing_digest != payload_digest
                {
                    return Err(WorkflowError::Conflict(
                        "operation id was already used with another saga resume".to_string(),
                    ));
                }
                return find_run(&mut conn, run_id).await;
            }

            let run = find_run(&mut conn, run_id).await?;
            let version = version_on_connection(&mut conn, run.definition_version_id).await?;
            let definition = version.definition()?;
            let definition_step = definition
                .steps
                .iter()
                .find(|s| s.id == step_id)
                .ok_or_else(|| WorkflowError::NotFound(format!("workflow step {step_id}")))?;
            let WorkflowStepSpec::WaitForEvent(wait_spec) = &definition_step.spec else {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` is not a wait_for_event step"
                )));
            };

            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            if step.status != "waiting_approval" {
                return Err(WorkflowError::Conflict(format!(
                    "wait_for_event step `{step_id}` is not currently suspended (status `{}`)",
                    step.status
                )));
            }
            if let Some(timeout_at) =
                parse_timeout_from_evidence(step.execution_evidence_json.as_deref())
                && timeout_at <= Utc::now()
            {
                return Err(WorkflowError::Conflict(format!(
                    "wait_for_event step `{step_id}` has exceeded its SLA timeout"
                )));
            }

            let correlation_context = match step.resolved_input_json.as_deref() {
                Some(raw) => serde_json::from_str::<serde_json::Value>(raw)?,
                None => serde_json::from_str::<serde_json::Value>(&run.input_json)?,
            };
            if !match_waiting_step(wait_spec, &correlation_context, envelope) {
                return Err(WorkflowError::Conflict(format!(
                    "incoming event `{}` (id `{}`) does not match WaitForEvent step `{step_id}`",
                    envelope.event_type, envelope.event_id
                )));
            }

            let envelope_json_value = serde_json::to_value(envelope)?;
            let envelope_json_text = serde_json::to_string(&envelope_json_value)?;
            let inserted = sqlx::query(
                "INSERT INTO workflow_approval_decisions (
                    run_id, step_id, attempt, operation_id, principal_json, decision_json,
                    payload_digest
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(run_id, step_id, attempt) DO NOTHING",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .bind(operation_id)
            .bind(serde_json::to_string(&envelope.actor)?)
            .bind(&envelope_json_text)
            .bind(payload_digest)
            .execute(&mut *conn)
            .await?;
            if inserted.rows_affected() == 0 {
                return Err(WorkflowError::Conflict(format!(
                    "wait_for_event step `{step_id}` was already resumed"
                )));
            }

            let attempt = step.attempt as u32;
            append_event(
                &mut conn,
                run_id,
                Some(operation_id),
                &WorkflowEvent::StepEventReceived {
                    step_id: step_id.to_string(),
                    attempt,
                    event_id: envelope.event_id.clone(),
                    event_type: envelope.event_type.clone(),
                },
            )
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepOutputAccepted {
                    step_id: step_id.to_string(),
                    attempt,
                    output: envelope_json_value.clone(),
                    schema_digest: "event-envelope:v1".to_string(),
                },
            )
            .await?;
            sqlx::query(
                "UPDATE workflow_step_runs
                 SET status = 'completed',
                     output_json = ?,
                     output_schema_digest = 'event-envelope:v1',
                     waiting_interaction = 0,
                     completed_at = ?,
                     updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?
",
            )
            .bind(serde_json::to_string(&envelope_json_value)?)
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
                    attempt,
                },
            )
            .await?;

            restore_running_if_not_waiting(&mut conn, run_id).await?;
            enqueue_newly_ready(&mut conn, run_id, &definition).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    /// Fails any suspended `WaitForEvent` or SLA-bounded `UserGate` step whose deadline has passed.
    pub async fn expire_timed_out_waiting_steps(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Vec<WorkflowRunView>, WorkflowError> {
        let candidates = {
            let mut conn = self.pool.acquire().await?;
            let rows = sqlx::query(
                "SELECT step.run_id, step.step_id, step.execution_evidence_json
                 FROM workflow_step_runs step
                 JOIN workflow_runs run ON run.id = step.run_id
                 WHERE step.status = 'waiting_approval'
                   AND run.status = 'waiting'
                   AND run.control_state = 'active'
                   AND step.attempt = (
                       SELECT MAX(latest.attempt)
                       FROM workflow_step_runs latest
                       WHERE latest.run_id = step.run_id AND latest.step_id = step.step_id
                   )
                 ORDER BY run.created_at, step.step_id",
            )
            .fetch_all(&mut *conn)
            .await?;
            let mut due = Vec::new();
            for row in rows {
                let run_id: Uuid = row.try_get("run_id")?;
                let step_id: String = row.try_get("step_id")?;
                let evidence_json: Option<String> = row.try_get("execution_evidence_json")?;
                if let Some(timeout_at) = parse_timeout_from_evidence(evidence_json.as_deref())
                    && timeout_at <= now
                {
                    due.push((run_id, step_id));
                }
            }
            due
        };

        let now_iso = now.to_rfc3339();
        let mut expired_runs = Vec::with_capacity(candidates.len());
        for (run_id, step_id) in candidates {
            let updated = self
                .fail_step(
                    run_id,
                    &step_id,
                    "wait_for_event_timeout",
                    &format!("suspended step `{step_id}` exceeded configured SLA timeout"),
                )
                .await?;
            let has_table: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pulse_user_interactions' LIMIT 1",
            )
            .fetch_optional(&self.pool)
            .await?;
            if has_table.is_some() {
                let _ = sqlx::query(
                    "UPDATE pulse_user_interactions
                     SET status = 'expired', resolved_at = ?
                     WHERE workflow_run_id = ? AND step_id = ? AND status = 'pending'",
                )
                .bind(&now_iso)
                .bind(run_id.to_string())
                .bind(&step_id)
                .execute(&self.pool)
                .await;
            }
            expired_runs.push(updated);
        }
        Ok(expired_runs)
    }
}

fn parse_timeout_from_evidence(evidence_json: Option<&str>) -> Option<DateTime<Utc>> {
    let raw = evidence_json?;
    let parsed = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let timeout_str = parsed.get("timeoutAt")?.as_str()?;
    DateTime::parse_from_rfc3339(timeout_str)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}
