use chrono::{DateTime, Duration, Utc};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use uuid::Uuid;

use crate::{
    UserInteractionKind, WorkflowDefinition, WorkflowError, WorkflowEvent, WorkflowEventRecord,
    WorkflowStep, WorkflowStepSpec,
    pulse_steps::{evaluate_gate_condition_on_value, evaluate_gate_filter_on_value},
    spec::effective_forward_dependencies,
    store::{EVENT_VERSION, find_run, select_pointer},
    store_execution::resolve_step_input_on_connection,
};

pub(crate) async fn append_event(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    operation_id: Option<Uuid>,
    event: &WorkflowEvent,
) -> Result<WorkflowEventRecord, WorkflowError> {
    if let Some(operation_id) = operation_id
        && let Some(existing) = sqlx::query_as::<_, WorkflowEventRecord>(
            "SELECT id, run_id, sequence, event_version, event_kind, payload_json,
                    operation_id, created_at
             FROM workflow_events WHERE run_id = ? AND operation_id = ?",
        )
        .bind(run_id)
        .bind(operation_id)
        .fetch_optional(&mut *conn)
        .await?
    {
        return Ok(existing);
    }
    let sequence: i64 = sqlx::query_scalar(
        "UPDATE workflow_runs SET last_sequence = last_sequence + 1,
                updated_at = datetime('now', 'subsec')
         WHERE id = ? RETURNING last_sequence",
    )
    .bind(run_id)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query_as::<_, WorkflowEventRecord>(
        "INSERT INTO workflow_events (
             id, run_id, sequence, event_version, event_kind, payload_json, operation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id, run_id, sequence, event_version, event_kind, payload_json,
                   operation_id, created_at",
    )
    .bind(Uuid::new_v4())
    .bind(run_id)
    .bind(sequence)
    .bind(EVENT_VERSION)
    .bind(event.kind())
    .bind(serde_json::to_string(event)?)
    .bind(operation_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(WorkflowError::from)
}

async fn build_inline_step_context(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    definition: &WorkflowDefinition,
    step: &WorkflowStep,
    extra_step_ids: &[String],
) -> Result<serde_json::Value, WorkflowError> {
    let run = find_run(conn, run_id).await?;
    let mut map = serde_json::Map::new();
    let run_input: serde_json::Value = serde_json::from_str(&run.input_json)?;
    if let Some(obj) = run_input.as_object() {
        for (k, v) in obj {
            map.insert(k.clone(), v.clone());
        }
    }
    map.insert("runInput".to_string(), run_input.clone());

    if let Ok(resolved) = resolve_step_input_on_connection(conn, &run, definition, step).await {
        for (k, v) in resolved.values {
            map.insert(k, v);
        }
    } else {
        for (name, binding) in &step.input_bindings {
            if let crate::WorkflowBinding::RunInput { pointer } = binding
                && let Some(selected) = select_pointer(&run_input, pointer)
            {
                map.insert(name.clone(), selected.clone());
            }
        }
    }

    let mut steps_map = serde_json::Map::new();
    let completed_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT step_id, output_json FROM workflow_step_runs
         WHERE run_id = ? AND status = 'completed' AND output_json IS NOT NULL
         ORDER BY attempt ASC",
    )
    .bind(run_id)
    .fetch_all(&mut *conn)
    .await?;
    for (completed_id, raw) in completed_rows {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
            steps_map.insert(
                completed_id,
                serde_json::json!({ "output": parsed }),
            );
        }
    }

    for target_id in extra_step_ids {
        let output_json: Option<String> = sqlx::query_scalar(
            "SELECT output_json FROM workflow_step_runs
             WHERE run_id = ? AND step_id = ? AND status = 'completed'
               AND output_json IS NOT NULL
             ORDER BY attempt DESC LIMIT 1",
        )
        .bind(run_id)
        .bind(target_id)
        .fetch_optional(&mut *conn)
        .await?;
        if let Some(raw) = output_json
            && let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw)
        {
            if let Some(obj) = parsed.as_object() {
                for (k, v) in obj {
                    map.entry(k.clone()).or_insert_with(|| v.clone());
                }
            }
            steps_map.insert(
                target_id.clone(),
                serde_json::json!({ "output": parsed.clone() }),
            );
            map.insert(target_id.clone(), parsed);
        }
    }
    map.insert("steps".to_string(), serde_json::Value::Object(steps_map));

    Ok(serde_json::Value::Object(map))
}

pub(crate) async fn enqueue_newly_ready(
    conn: &mut SqliteConnection,
    run_id: Uuid,
    definition: &WorkflowDefinition,
) -> Result<(), WorkflowError> {
    let mut completed_inline = false;
    loop {
        let mut progressed = false;
        for step in &definition.steps {
            let (attempt, current): (i64, String) = sqlx::query_as(
                "SELECT attempt, status FROM workflow_step_runs
                 WHERE run_id = ? AND step_id = ? ORDER BY attempt DESC LIMIT 1",
            )
            .bind(run_id)
            .bind(&step.id)
            .fetch_one(&mut *conn)
            .await?;
            if current != "pending" {
                continue;
            }
            let forward_deps = effective_forward_dependencies(definition, step);
            let mut ready = true;
            let mut all_execute_skipped = !forward_deps.is_empty();
            for dependency in &forward_deps {
                let (dep_status, dep_mode): (String, String) = sqlx::query_as(
                    "SELECT status, execution_mode FROM workflow_step_runs
                     WHERE run_id = ? AND step_id = ? ORDER BY attempt DESC LIMIT 1",
                )
                .bind(run_id)
                .bind(dependency)
                .fetch_one(&mut *conn)
                .await?;
                if !matches!(dep_status.as_str(), "completed" | "skipped") {
                    ready = false;
                    break;
                }
                if !(dep_status == "skipped" && dep_mode == "execute") {
                    all_execute_skipped = false;
                }
            }
            if !ready {
                continue;
            }
            if all_execute_skipped {
                sqlx::query(
                    "UPDATE workflow_step_runs
                     SET status = 'skipped',
                         completed_at = datetime('now', 'subsec'),
                         updated_at = datetime('now', 'subsec')
                     WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'pending'",
                )
                .bind(run_id)
                .bind(&step.id)
                .bind(attempt)
                .execute(&mut *conn)
                .await?;
                append_event(
                    conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepSkipped {
                        step_id: step.id.clone(),
                        attempt: attempt as u32,
                    },
                )
                .await?;
                progressed = true;
                completed_inline = true;
                continue;
            }

            match &step.spec {
                WorkflowStepSpec::Agent(_)
                | WorkflowStepSpec::Session(_)
                | WorkflowStepSpec::Bot(_)
                | WorkflowStepSpec::GroupStage(_)
                | WorkflowStepSpec::OutboxAction(_) => {
                    let event = append_event(
                        conn,
                        run_id,
                        None,
                        &WorkflowEvent::StepReady {
                            step_id: step.id.clone(),
                            attempt: attempt as u32,
                        },
                    )
                    .await?;
                    sqlx::query(
                        "UPDATE workflow_step_runs SET status = 'ready',
                                updated_at = datetime('now', 'subsec')
                         WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'pending'",
                    )
                    .bind(run_id)
                    .bind(&step.id)
                    .bind(attempt)
                    .execute(&mut *conn)
                    .await?;
                    sqlx::query(
                        "INSERT INTO workflow_ready_steps (
                             run_id, step_id, attempt, ready_sequence, status
                         ) VALUES (?, ?, ?, ?, 'ready')",
                    )
                    .bind(run_id)
                    .bind(&step.id)
                    .bind(attempt)
                    .bind(event.sequence)
                    .execute(&mut *conn)
                    .await?;
                }
                WorkflowStepSpec::Approval(_) => {
                    sqlx::query(
                        "UPDATE workflow_step_runs SET status = 'waiting_approval',
                                updated_at = datetime('now', 'subsec')
                         WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'pending'",
                    )
                    .bind(run_id)
                    .bind(&step.id)
                    .bind(attempt)
                    .execute(&mut *conn)
                    .await?;
                    append_event(
                        conn,
                        run_id,
                        None,
                        &WorkflowEvent::StepWaitingApproval {
                            step_id: step.id.clone(),
                            attempt: attempt as u32,
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
                }
                WorkflowStepSpec::Notify(_) => {
                    sqlx::query(
                        "UPDATE workflow_step_runs
                         SET status = 'completed',
                             completed_at = datetime('now', 'subsec'),
                             updated_at = datetime('now', 'subsec')
                         WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'pending'",
                    )
                    .bind(run_id)
                    .bind(&step.id)
                    .bind(attempt)
                    .execute(&mut *conn)
                    .await?;
                    append_event(
                        conn,
                        run_id,
                        None,
                        &WorkflowEvent::StepCompleted {
                            step_id: step.id.clone(),
                            attempt: attempt as u32,
                        },
                    )
                    .await?;
                    progressed = true;
                    completed_inline = true;
                }
                WorkflowStepSpec::UserGate(gate) => {
                    let context =
                        build_inline_step_context(conn, run_id, definition, step, &step.depends_on)
                            .await?;
                    let rendered_title = render_context_template(&gate.title_template, &context);
                    let rendered_body = render_context_template(&gate.body_template, &context);
                    let now_iso = Utc::now().to_rfc3339();
                    let interaction_id = format!("wf-gate:{run_id}:{}:{attempt}", step.id);

                    match gate.interaction_kind {
                        UserInteractionKind::Notify | UserInteractionKind::Digest => {
                            let output = serde_json::json!({
                                "interactionKind": gate.interaction_kind,
                                "notified": true,
                            });
                            let output_json = serde_json::to_string(&output)?;
                            upsert_workflow_pulse_interaction(
                                conn,
                                WorkflowPulseInteractionInsert {
                                    id: &interaction_id,
                                    run_id,
                                    step_id: &step.id,
                                    kind: gate.interaction_kind,
                                    severity: "info",
                                    title: &rendered_title,
                                    body: &rendered_body,
                                    approval_options: &gate.approval_options,
                                    form_schema: gate.form_schema.as_ref(),
                                    resolution_json: Some(&output_json),
                                    status: "resolved",
                                    sla_deadline_at: None,
                                    created_at: &now_iso,
                                    resolved_at: Some(&now_iso),
                                },
                            )
                            .await?;
                            append_event(
                                conn,
                                run_id,
                                None,
                                &WorkflowEvent::StepOutputAccepted {
                                    step_id: step.id.clone(),
                                    attempt: attempt as u32,
                                    output: output.clone(),
                                    schema_digest: "user-gate-notify:v1".to_string(),
                                },
                            )
                            .await?;
                            sqlx::query(
                                "UPDATE workflow_step_runs
                                 SET status = 'completed', output_json = ?, output_schema_digest = ?,
                                     completed_at = datetime('now', 'subsec'),
                                     updated_at = datetime('now', 'subsec')
                                 WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'pending'",
                            )
                            .bind(&output_json)
                            .bind("user-gate-notify:v1")
                            .bind(run_id)
                            .bind(&step.id)
                            .bind(attempt)
                            .execute(&mut *conn)
                            .await?;
                            append_event(
                                conn,
                                run_id,
                                None,
                                &WorkflowEvent::StepCompleted {
                                    step_id: step.id.clone(),
                                    attempt: attempt as u32,
                                },
                            )
                            .await?;
                            progressed = true;
                            completed_inline = true;
                        }
                        UserInteractionKind::Approval | UserInteractionKind::AskForm => {
                            let timeout_at = gate
                                .sla_timeout_seconds
                                .map(|secs| Utc::now() + Duration::seconds(i64::from(secs)));
                            let sla_iso = timeout_at.map(|dt| dt.to_rfc3339());
                            upsert_workflow_pulse_interaction(
                                conn,
                                WorkflowPulseInteractionInsert {
                                    id: &interaction_id,
                                    run_id,
                                    step_id: &step.id,
                                    kind: gate.interaction_kind,
                                    severity: "warning",
                                    title: &rendered_title,
                                    body: &rendered_body,
                                    approval_options: &gate.approval_options,
                                    form_schema: gate.form_schema.as_ref(),
                                    resolution_json: None,
                                    status: "pending",
                                    sla_deadline_at: sla_iso.as_deref(),
                                    created_at: &now_iso,
                                    resolved_at: None,
                                },
                            )
                            .await?;
                            let evidence = serde_json::json!({
                                "primitive": "user_gate",
                                "interactionId": interaction_id,
                                "interactionKind": gate.interaction_kind,
                                "timeoutAt": timeout_at,
                            });
                            let evidence_json = serde_json::to_string(&evidence)?;
                            let evidence_digest =
                                format!("{:x}", Sha256::digest(evidence_json.as_bytes()));
                            sqlx::query(
                                "UPDATE workflow_step_runs
                                 SET status = 'waiting_approval', execution_evidence_json = ?,
                                     updated_at = datetime('now', 'subsec')
                                 WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'pending'",
                            )
                            .bind(&evidence_json)
                            .bind(run_id)
                            .bind(&step.id)
                            .bind(attempt)
                            .execute(&mut *conn)
                            .await?;
                            append_event(
                                conn,
                                run_id,
                                None,
                                &WorkflowEvent::StepEvidenceRecorded {
                                    step_id: step.id.clone(),
                                    attempt: attempt as u32,
                                    evidence_digest,
                                    execution_evidence: Some(evidence),
                                },
                            )
                            .await?;
                            append_event(
                                conn,
                                run_id,
                                None,
                                &WorkflowEvent::StepWaitingApproval {
                                    step_id: step.id.clone(),
                                    attempt: attempt as u32,
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
                        }
                    }
                }
                WorkflowStepSpec::ConditionBranch(branch) => {
                    let context =
                        build_inline_step_context(conn, run_id, definition, step, &[]).await?;
                    let matched = evaluate_gate_filter_on_value(&branch.filter, &context);
                    let output = serde_json::json!({
                        "matched": matched,
                        "branch": if matched { "then" } else { "else" },
                    });
                    append_event(
                        conn,
                        run_id,
                        None,
                        &WorkflowEvent::StepOutputAccepted {
                            step_id: step.id.clone(),
                            attempt: attempt as u32,
                            output: output.clone(),
                            schema_digest: "condition-branch:v1".to_string(),
                        },
                    )
                    .await?;
                    sqlx::query(
                        "UPDATE workflow_step_runs
                         SET status = 'completed', output_json = ?, output_schema_digest = ?,
                             completed_at = datetime('now', 'subsec'),
                             updated_at = datetime('now', 'subsec')
                         WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'pending'",
                    )
                    .bind(serde_json::to_string(&output)?)
                    .bind("condition-branch:v1")
                    .bind(run_id)
                    .bind(&step.id)
                    .bind(attempt)
                    .execute(&mut *conn)
                    .await?;
                    append_event(
                        conn,
                        run_id,
                        None,
                        &WorkflowEvent::StepCompleted {
                            step_id: step.id.clone(),
                            attempt: attempt as u32,
                        },
                    )
                    .await?;
                    let untaken = if matched {
                        &branch.else_step_ids
                    } else {
                        &branch.then_step_ids
                    };
                    for skip_id in untaken {
                        let skip_row: Option<(i64, String)> = sqlx::query_as(
                            "SELECT attempt, status FROM workflow_step_runs
                             WHERE run_id = ? AND step_id = ? ORDER BY attempt DESC LIMIT 1",
                        )
                        .bind(run_id)
                        .bind(skip_id)
                        .fetch_optional(&mut *conn)
                        .await?;
                        if let Some((skip_attempt, skip_status)) = skip_row
                            && skip_status == "pending"
                        {
                            sqlx::query(
                                "UPDATE workflow_step_runs
                                 SET status = 'skipped',
                                     completed_at = datetime('now', 'subsec'),
                                     updated_at = datetime('now', 'subsec')
                                 WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'pending'",
                            )
                            .bind(run_id)
                            .bind(skip_id)
                            .bind(skip_attempt)
                            .execute(&mut *conn)
                            .await?;
                            append_event(
                                conn,
                                run_id,
                                None,
                                &WorkflowEvent::StepSkipped {
                                    step_id: skip_id.clone(),
                                    attempt: skip_attempt as u32,
                                },
                            )
                            .await?;
                        }
                    }
                    progressed = true;
                    completed_inline = true;
                }
                WorkflowStepSpec::BoundedLoop(bounded) => {
                    let context = build_inline_step_context(
                        conn,
                        run_id,
                        definition,
                        step,
                        &bounded.target_step_ids,
                    )
                    .await?;
                    let iteration = attempt as u32;
                    let until_met = bounded
                        .until_condition
                        .as_ref()
                        .is_some_and(|cond| evaluate_gate_condition_on_value(cond, &context));
                    let continuing = !until_met && iteration < bounded.max_iterations;
                    let output = serde_json::json!({
                        "iteration": iteration,
                        "untilMet": until_met,
                        "continuing": continuing,
                    });
                    append_event(
                        conn,
                        run_id,
                        None,
                        &WorkflowEvent::StepOutputAccepted {
                            step_id: step.id.clone(),
                            attempt: iteration,
                            output: output.clone(),
                            schema_digest: "bounded-loop:v1".to_string(),
                        },
                    )
                    .await?;
                    sqlx::query(
                        "UPDATE workflow_step_runs
                         SET status = 'completed', output_json = ?, output_schema_digest = ?,
                             completed_at = datetime('now', 'subsec'),
                             updated_at = datetime('now', 'subsec')
                         WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'pending'",
                    )
                    .bind(serde_json::to_string(&output)?)
                    .bind("bounded-loop:v1")
                    .bind(run_id)
                    .bind(&step.id)
                    .bind(attempt)
                    .execute(&mut *conn)
                    .await?;
                    append_event(
                        conn,
                        run_id,
                        None,
                        &WorkflowEvent::StepCompleted {
                            step_id: step.id.clone(),
                            attempt: iteration,
                        },
                    )
                    .await?;

                    if continuing {
                        let mut target_steps = Vec::with_capacity(bounded.target_step_ids.len());
                        for target_id in &bounded.target_step_ids {
                            let max_target_attempt: i64 = sqlx::query_scalar(
                                "SELECT COALESCE(MAX(attempt), 0) FROM workflow_step_runs
                                 WHERE run_id = ? AND step_id = ?",
                            )
                            .bind(run_id)
                            .bind(target_id)
                            .fetch_one(&mut *conn)
                            .await?;
                            let next_target_attempt = max_target_attempt + 1;
                            sqlx::query(
                                "INSERT INTO workflow_step_runs (
                                     id, run_id, step_id, attempt, status, execution_mode
                                 ) VALUES (?, ?, ?, ?, 'pending', 'execute')",
                            )
                            .bind(Uuid::new_v4())
                            .bind(run_id)
                            .bind(target_id)
                            .bind(next_target_attempt)
                            .execute(&mut *conn)
                            .await?;
                            target_steps.push((target_id.clone(), next_target_attempt as u32));
                        }
                        let next_loop_attempt = attempt + 1;
                        sqlx::query(
                            "INSERT INTO workflow_step_runs (
                                 id, run_id, step_id, attempt, status, execution_mode
                             ) VALUES (?, ?, ?, ?, 'pending', 'execute')",
                        )
                        .bind(Uuid::new_v4())
                        .bind(run_id)
                        .bind(&step.id)
                        .bind(next_loop_attempt)
                        .execute(&mut *conn)
                        .await?;
                        append_event(
                            conn,
                            run_id,
                            None,
                            &WorkflowEvent::StepLoopIterated {
                                loop_step_id: step.id.clone(),
                                next_loop_attempt: next_loop_attempt as u32,
                                target_steps,
                            },
                        )
                        .await?;
                    } else {
                        completed_inline = true;
                    }
                    progressed = true;
                }
                WorkflowStepSpec::WaitForEvent(wait) => {
                    let context =
                        build_inline_step_context(conn, run_id, definition, step, &[]).await?;
                    let context_json = serde_json::to_string(&context)?;
                    let context_digest = format!("{:x}", Sha256::digest(context_json.as_bytes()));
                    let timeout_at = wait
                        .timeout_seconds
                        .map(|secs| Utc::now() + Duration::seconds(i64::from(secs)));
                    let evidence = serde_json::json!({
                        "primitive": "wait_for_event",
                        "eventTypes": wait.event_types,
                        "threadKeyPointer": wait.thread_key_pointer,
                        "timeoutAt": timeout_at,
                    });
                    sqlx::query(
                        "UPDATE workflow_step_runs
                         SET status = 'waiting_approval',
                             resolved_input_json = ?,
                             resolved_input_digest = ?,
                             execution_evidence_json = ?,
                             updated_at = datetime('now', 'subsec')
                         WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'pending'",
                    )
                    .bind(&context_json)
                    .bind(&context_digest)
                    .bind(serde_json::to_string(&evidence)?)
                    .bind(run_id)
                    .bind(&step.id)
                    .bind(attempt)
                    .execute(&mut *conn)
                    .await?;
                    append_event(
                        conn,
                        run_id,
                        None,
                        &WorkflowEvent::StepWaitingEvent {
                            step_id: step.id.clone(),
                            attempt: attempt as u32,
                            resolved_input: context,
                            resolved_input_digest: context_digest,
                            execution_evidence: evidence,
                            timeout_at,
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
                }
            }
        }
        if !progressed {
            break;
        }
    }
    if completed_inline {
        settle_if_complete(conn, run_id).await?;
    }
    Ok(())
}

pub(crate) async fn settle_if_complete(
    conn: &mut SqliteConnection,
    run_id: Uuid,
) -> Result<(), WorkflowError> {
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workflow_step_runs step
         WHERE run_id = ?
           AND attempt = (SELECT MAX(latest.attempt) FROM workflow_step_runs latest
                          WHERE latest.run_id = step.run_id AND latest.step_id = step.step_id)
           AND status NOT IN ('completed', 'skipped')",
    )
    .bind(run_id)
    .fetch_one(&mut *conn)
    .await?;
    if remaining == 0 {
        append_event(conn, run_id, None, &WorkflowEvent::RunCompleted).await?;
        sqlx::query(
            "UPDATE workflow_runs SET status = 'completed',
                    updated_at = datetime('now', 'subsec')
             WHERE id = ? AND status IN ('running', 'waiting')",
        )
        .bind(run_id)
        .execute(&mut *conn)
        .await?;
    } else {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM workflow_step_runs step
             WHERE run_id = ?
               AND attempt = (SELECT MAX(latest.attempt) FROM workflow_step_runs latest
                              WHERE latest.run_id = step.run_id AND latest.step_id = step.step_id)
               AND (
                 status = 'waiting_approval' OR waiting_interaction = 1
                 OR awaiting_input = 1 OR awaiting_acceptance = 1
               )",
        )
        .bind(run_id)
        .fetch_one(&mut *conn)
        .await?;
        if waiting == 0 {
            sqlx::query(
                "UPDATE workflow_runs SET status = 'running',
                        updated_at = datetime('now', 'subsec')
                 WHERE id = ? AND status = 'waiting'",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
        }
    }
    Ok(())
}

pub(crate) async fn recover_stale_claims(
    conn: &mut SqliteConnection,
    now: DateTime<Utc>,
) -> Result<usize, WorkflowError> {
    let rows = sqlx::query(
        "SELECT run_id, step_id, attempt FROM workflow_ready_steps
         WHERE status = 'claimed' AND claim_deadline < ? ORDER BY ready_sequence",
    )
    .bind(now)
    .fetch_all(&mut *conn)
    .await?;
    for row in &rows {
        let run_id: Uuid = row.try_get("run_id")?;
        let step_id: String = row.try_get("step_id")?;
        let attempt: i64 = row.try_get("attempt")?;
        sqlx::query(
            "UPDATE workflow_ready_steps SET status = 'ready', claim_token = NULL,
                    claim_deadline = NULL WHERE run_id = ? AND step_id = ? AND attempt = ?",
        )
        .bind(run_id)
        .bind(&step_id)
        .bind(attempt)
        .execute(&mut *conn)
        .await?;
        sqlx::query(
            "UPDATE workflow_step_runs SET status = 'ready', claim_token = NULL,
                    claim_deadline = NULL, updated_at = datetime('now', 'subsec')
             WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'claimed'",
        )
        .bind(run_id)
        .bind(&step_id)
        .bind(attempt)
        .execute(&mut *conn)
        .await?;
        append_event(
            conn,
            run_id,
            None,
            &WorkflowEvent::StepClaimReleased {
                step_id: step_id.clone(),
                attempt: attempt as u32,
            },
        )
        .await?;
    }
    Ok(rows.len())
}

struct WorkflowPulseInteractionInsert<'a> {
    id: &'a str,
    run_id: Uuid,
    step_id: &'a str,
    kind: UserInteractionKind,
    severity: &'a str,
    title: &'a str,
    body: &'a str,
    approval_options: &'a [crate::pulse_steps::ApprovalOptionSpec],
    form_schema: Option<&'a serde_json::Value>,
    resolution_json: Option<&'a str>,
    status: &'a str,
    sla_deadline_at: Option<&'a str>,
    created_at: &'a str,
    resolved_at: Option<&'a str>,
}

async fn upsert_workflow_pulse_interaction(
    conn: &mut SqliteConnection,
    input: WorkflowPulseInteractionInsert<'_>,
) -> Result<(), WorkflowError> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pulse_user_interactions (
            id                    TEXT PRIMARY KEY NOT NULL,
            rule_id               TEXT,
            workflow_run_id       TEXT,
            step_id               TEXT,
            kind                  TEXT NOT NULL,
            severity              TEXT NOT NULL,
            title                 TEXT NOT NULL,
            body                  TEXT NOT NULL,
            approval_options_json TEXT NOT NULL DEFAULT '[]',
            form_schema_json      TEXT,
            resolution_json       TEXT,
            status                TEXT NOT NULL DEFAULT 'pending',
            sla_deadline_at       TEXT,
            created_at            TEXT NOT NULL,
            resolved_at           TEXT
        )",
    )
    .execute(&mut *conn)
    .await?;

    let kind_str = match input.kind {
        UserInteractionKind::Notify => "notify",
        UserInteractionKind::Approval => "approval",
        UserInteractionKind::AskForm => "ask_form",
        UserInteractionKind::Digest => "digest",
    };
    let options_json = serde_json::to_string(input.approval_options)?;
    let form_schema_json = input.form_schema.map(serde_json::to_string).transpose()?;

    sqlx::query(
        "INSERT INTO pulse_user_interactions (
            id, rule_id, workflow_run_id, step_id, kind, severity,
            title, body, approval_options_json, form_schema_json, resolution_json,
            status, sla_deadline_at, created_at, resolved_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            body = excluded.body,
            approval_options_json = excluded.approval_options_json,
            form_schema_json = excluded.form_schema_json,
            resolution_json = excluded.resolution_json,
            status = excluded.status,
            sla_deadline_at = excluded.sla_deadline_at,
            resolved_at = excluded.resolved_at",
    )
    .bind(input.id)
    .bind(input.run_id.to_string())
    .bind(input.step_id)
    .bind(kind_str)
    .bind(input.severity)
    .bind(input.title)
    .bind(input.body)
    .bind(options_json)
    .bind(form_schema_json)
    .bind(input.resolution_json)
    .bind(input.status)
    .bind(input.sla_deadline_at)
    .bind(input.created_at)
    .bind(input.resolved_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

fn render_context_template(template: &str, context: &serde_json::Value) -> String {
    let mut output = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find("{{") {
        output.push_str(&rest[..open]);
        let after_open = &rest[open + 2..];
        let Some(close) = after_open.find("}}") else {
            output.push_str(&rest[open..]);
            return output;
        };
        let expr = after_open[..close].trim();
        if let Some(resolved) = lookup_context_expr(expr, context) {
            match resolved {
                serde_json::Value::String(s) => output.push_str(s),
                serde_json::Value::Null => {}
                other => output.push_str(&other.to_string()),
            }
        }
        rest = &after_open[close + 2..];
    }
    output.push_str(rest);
    output
}

fn lookup_context_expr<'a>(
    expr: &str,
    context: &'a serde_json::Value,
) -> Option<&'a serde_json::Value> {
    if expr.is_empty() {
        return None;
    }
    if let Some(direct) = context.get(expr) {
        return Some(direct);
    }
    let normalized = expr
        .strip_prefix("input.")
        .map(|tail| format!("runInput.{tail}"))
        .unwrap_or_else(|| expr.to_string());
    let pointer = format!("/{}", normalized.trim_start_matches('/').replace('.', "/"));
    select_pointer(context, &pointer)
}

