use std::collections::BTreeMap;

use chrono::{Duration, Utc};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use uuid::Uuid;

use crate::{
    BotMailboxPolicy, ClaimedWorkflowStep, DebugRunScope, ResolvedWorkflowStepInput,
    WorkflowBinding, WorkflowDefinition, WorkflowError, WorkflowEvent, WorkflowPolicy,
    WorkflowRunView, WorkflowStep, WorkflowStepSpec, WorkflowStepView, WorkflowStore,
    WorkflowVersionView, WorkspaceAccess,
    spec::{deterministic_order, is_bounded_loop_back_edge},
    store::{
        PersistDerivedWorkflowRun, PersistWorkflowRun, find_latest_step, find_run,
        find_run_by_operation, find_step, find_step_by_claim, rebase_reused_execution_evidence,
        select_pointer, version_on_connection,
    },
    store_reconcile::{
        append_event, enqueue_newly_ready, recover_stale_claims, restore_running_if_not_waiting,
        settle_if_complete,
    },
};

impl WorkflowStore {
    pub(crate) async fn start(
        &self,
        version: &WorkflowVersionView,
        request: PersistWorkflowRun<'_>,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let definition = version.definition()?;
        let deadline_at = Utc::now() + Duration::seconds(request.policy.deadline_seconds as i64);
        let input_json = serde_json::to_string(request.input)?;
        let policy_json = serde_json::to_string(request.policy)?;
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if let Some(existing) = find_run_by_operation(&mut conn, request.operation_id).await? {
                let existing_digest: String =
                    sqlx::query_scalar("SELECT payload_digest FROM workflow_runs WHERE id = ?")
                        .bind(existing.id)
                        .fetch_one(&mut *conn)
                        .await?;
                if existing_digest != request.payload_digest {
                    return Err(WorkflowError::Conflict(
                        "operation id was already used with another workflow run".to_string(),
                    ));
                }
                return Ok(existing);
            }
            let run_id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO workflow_runs (
                     id, definition_version_id, workspace_id, status, input_json, policy_json,
                     operation_id, payload_digest, principal_json, deadline_at,
                     fork_step_id, run_mode
                 ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(run_id)
            .bind(version.id)
            .bind(request.workspace_id)
            .bind(&input_json)
            .bind(&policy_json)
            .bind(request.operation_id)
            .bind(request.payload_digest)
            .bind(request.principal_json)
            .bind(deadline_at)
            .bind(request.debug_step_id)
            .bind(request.debug_step_id.map_or("standard", |_| "debug_node"))
            .execute(&mut *conn)
            .await?;
            let ordered = deterministic_order(&definition)?;
            for step_id in &ordered {
                let excluded = request
                    .debug_execution_steps
                    .is_some_and(|steps| !steps.contains(step_id));
                if excluded {
                    sqlx::query(
                        "INSERT INTO workflow_step_runs (
                             id, run_id, step_id, attempt, status, completed_at, execution_mode
                         ) VALUES (?, ?, ?, 1, 'skipped', ?, 'exclude')",
                    )
                    .bind(Uuid::new_v4())
                    .bind(run_id)
                    .bind(step_id)
                    .bind(Utc::now())
                    .execute(&mut *conn)
                    .await?;
                } else {
                    sqlx::query(
                        "INSERT INTO workflow_step_runs (
                             id, run_id, step_id, attempt, status, execution_mode
                         ) VALUES (?, ?, ?, 1, 'pending', 'execute')",
                    )
                    .bind(Uuid::new_v4())
                    .bind(run_id)
                    .bind(step_id)
                    .execute(&mut *conn)
                    .await?;
                }
            }
            append_event(
                &mut conn,
                run_id,
                Some(request.operation_id),
                &WorkflowEvent::RunStarted {
                    definition_version_id: version.id,
                    step_ids: ordered.clone(),
                    input: request.input.clone(),
                    policy: request.policy.clone(),
                    deadline_at,
                },
            )
            .await?;
            if request.debug_execution_steps.is_some() {
                for step_id in &ordered {
                    if request
                        .debug_execution_steps
                        .is_some_and(|steps| !steps.contains(step_id))
                    {
                        append_event(
                            &mut conn,
                            run_id,
                            None,
                            &WorkflowEvent::StepSkipped {
                                step_id: step_id.clone(),
                                attempt: 1,
                            },
                        )
                        .await?;
                    }
                }
            }
            enqueue_newly_ready(&mut conn, run_id, &definition).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub(crate) async fn start_derived(
        &self,
        version: &WorkflowVersionView,
        request: PersistDerivedWorkflowRun<'_>,
    ) -> Result<WorkflowRunView, WorkflowError> {
        let definition = version.definition()?;
        let input: serde_json::Value = serde_json::from_str(&request.parent.input_json)?;
        let policy: WorkflowPolicy = serde_json::from_str(&request.parent.policy_json)?;
        let deadline_at = Utc::now() + Duration::seconds(policy.deadline_seconds as i64);
        let mut conn = self.begin_immediate().await?;
        let result = async {
            if let Some(existing) = find_run_by_operation(&mut conn, request.operation_id).await? {
                let existing_digest: String =
                    sqlx::query_scalar("SELECT payload_digest FROM workflow_runs WHERE id = ?")
                        .bind(existing.id)
                        .fetch_one(&mut *conn)
                        .await?;
                if existing_digest != request.payload_digest {
                    return Err(WorkflowError::Conflict(
                        "operation id was already used with another derived Run".to_string(),
                    ));
                }
                return Ok(existing);
            }
            let run_id = Uuid::new_v4();
            let run_mode = match request.scope {
                DebugRunScope::Node => "debug_node",
                DebugRunScope::Downstream => "debug_downstream",
            };
            sqlx::query(
                "INSERT INTO workflow_runs (
                     id, definition_version_id, workspace_id, status, input_json, policy_json,
                     operation_id, payload_digest, principal_json, deadline_at,
                     parent_run_id, fork_step_id, run_mode
                 ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(run_id)
            .bind(version.id)
            .bind(request.parent.workspace_id)
            .bind(&request.parent.input_json)
            .bind(&request.parent.policy_json)
            .bind(request.operation_id)
            .bind(request.payload_digest)
            .bind(request.principal_json)
            .bind(deadline_at)
            .bind(request.parent.id)
            .bind(request.fork_step_id)
            .bind(run_mode)
            .execute(&mut *conn)
            .await?;
            let ordered = deterministic_order(&definition)?;
            append_event(
                &mut conn,
                run_id,
                Some(request.operation_id),
                &WorkflowEvent::RunStarted {
                    definition_version_id: version.id,
                    step_ids: ordered.clone(),
                    input,
                    policy: policy.clone(),
                    deadline_at,
                },
            )
            .await?;
            let mut reused = Vec::new();
            let mut excluded = Vec::new();
            for step_id in &ordered {
                let mode = request
                    .execution_modes
                    .get(step_id)
                    .copied()
                    .unwrap_or("exclude");
                match mode {
                    "reuse" => {
                        let parent_step =
                            find_latest_step(&mut conn, request.parent.id, step_id).await?;
                        if parent_step.status != "completed" {
                            return Err(WorkflowError::Conflict(format!(
                                "step `{step_id}` cannot be reused from {}",
                                parent_step.status
                            )));
                        }
                        let execution_evidence_json = parent_step
                            .execution_evidence_json
                            .as_deref()
                            .map(|evidence| {
                                rebase_reused_execution_evidence(evidence, &version.digest)
                            })
                            .transpose()?;
                        sqlx::query(
                            "INSERT INTO workflow_step_runs (
                                id, run_id, step_id, attempt, status, conversation_id,
                                output_json, output_schema_digest, resolved_input_json,
                                resolved_input_digest, execution_evidence_json, workspace_id,
                                completed_at, execution_mode
                             ) VALUES (?, ?, ?, 1, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, 'reuse')",
                        )
                        .bind(Uuid::new_v4())
                        .bind(run_id)
                        .bind(step_id)
                        .bind(parent_step.conversation_id)
                        .bind(&parent_step.output_json)
                        .bind(&parent_step.output_schema_digest)
                        .bind(&parent_step.resolved_input_json)
                        .bind(&parent_step.resolved_input_digest)
                        .bind(&execution_evidence_json)
                        .bind(parent_step.workspace_id)
                        .bind(parent_step.completed_at)
                        .execute(&mut *conn)
                        .await?;
                        append_event(
                            &mut conn,
                            run_id,
                            None,
                            &WorkflowEvent::StepReused {
                                step_id: step_id.clone(),
                                conversation_id: parent_step.conversation_id,
                                output_json: parent_step.output_json,
                                output_schema_digest: parent_step.output_schema_digest,
                                resolved_input_json: parent_step.resolved_input_json,
                                resolved_input_digest: parent_step.resolved_input_digest,
                                execution_evidence_json,
                                workspace_id: parent_step.workspace_id,
                                completed_at: parent_step.completed_at,
                            },
                        )
                        .await?;
                        reused.push(step_id.clone());
                    }
                    "execute" => {
                        sqlx::query(
                            "INSERT INTO workflow_step_runs (
                                id, run_id, step_id, attempt, status, execution_mode
                             ) VALUES (?, ?, ?, 1, 'pending', 'execute')",
                        )
                        .bind(Uuid::new_v4())
                        .bind(run_id)
                        .bind(step_id)
                        .execute(&mut *conn)
                        .await?;
                    }
                    _ => {
                        sqlx::query(
                            "INSERT INTO workflow_step_runs (
                                id, run_id, step_id, attempt, status, completed_at, execution_mode
                             ) VALUES (?, ?, ?, 1, 'skipped', ?, 'exclude')",
                        )
                        .bind(Uuid::new_v4())
                        .bind(run_id)
                        .bind(step_id)
                        .bind(Utc::now())
                        .execute(&mut *conn)
                        .await?;
                        append_event(
                            &mut conn,
                            run_id,
                            None,
                            &WorkflowEvent::StepSkipped {
                                step_id: step_id.clone(),
                                attempt: 1,
                            },
                        )
                        .await?;
                        excluded.push(step_id.clone());
                    }
                }
            }
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::RunDerived {
                    parent_run_id: request.parent.id,
                    fork_step_id: request.fork_step_id.to_string(),
                    run_mode: request.scope,
                    reused_step_ids: reused,
                    excluded_step_ids: excluded,
                },
            )
            .await?;
            enqueue_newly_ready(&mut conn, run_id, &definition).await?;
            settle_if_complete(&mut conn, run_id).await?;
            find_run(&mut conn, run_id).await
        }
        .await;
        self.finish(conn, result).await
    }

    /// Resolve a ready step's bindings exclusively from immutable Run input and
    /// accepted outputs of completed dependency attempts.
    pub async fn resolve_step_input(
        &self,
        run_id: Uuid,
        step: &WorkflowStep,
    ) -> Result<ResolvedWorkflowStepInput, WorkflowError> {
        let mut conn = self.pool.acquire().await?;
        let run = find_run(&mut conn, run_id).await?;
        let version = version_on_connection(&mut conn, run.definition_version_id).await?;
        let definition = version.definition()?;
        resolve_step_input_on_connection(&mut conn, &run, &definition, step).await
    }

    pub async fn prepare_step(
        &self,
        run_id: Uuid,
        step: &WorkflowStep,
        claim_token: Uuid,
        resolved: &ResolvedWorkflowStepInput,
        workspace_id: Uuid,
        workspace_evidence: &serde_json::Value,
    ) -> Result<WorkflowStepView, WorkflowError> {
        let run = self.run(run_id).await?;
        let version = self.version(run.definition_version_id).await?;
        let execution_evidence = match &step.spec {
            WorkflowStepSpec::Agent(agent) => serde_json::json!({
                "definitionDigest": version.digest,
                "resolvedInputDigest": resolved.digest,
                "agentId": agent.agent_id,
                "workspaceAccess": agent.workspace_access,
                "sideEffectClass": agent.side_effect_class,
                "runtimeVersion": { "available": false },
                "toolSetDigest": { "available": false },
                "workspaceCheckpoint": { "available": false },
                "workspace": workspace_evidence,
            }),
            WorkflowStepSpec::Session(session) => serde_json::json!({
                "definitionDigest": version.digest,
                "resolvedInputDigest": resolved.digest,
                "primitive": "session",
                "ephemeralSession": true,
                "agentId": session.agent_id,
                "workspaceAccess": session.workspace_access,
                "modelOverride": session.model_override,
                "subscribeThread": session.subscribe_thread,
                "workspace": workspace_evidence,
            }),
            WorkflowStepSpec::Bot(bot) => serde_json::json!({
                "definitionDigest": version.digest,
                "resolvedInputDigest": resolved.digest,
                "primitive": "bot",
                "ephemeralSession": false,
                "preserveLongTermContext": true,
                "memberId": bot.member_id,
                "conversationScope": bot.conversation_scope,
                "mailboxPolicy": bot.mailbox_policy,
                "workspace": workspace_evidence,
            }),
            WorkflowStepSpec::GroupStage(group) => serde_json::json!({
                "definitionDigest": version.digest,
                "resolvedInputDigest": resolved.digest,
                "primitive": "group_stage",
                "spaceId": group.space_id,
                "dispatchMode": group.dispatch_mode,
                "quorumCount": group.quorum_count,
                "workspace": workspace_evidence,
            }),
            WorkflowStepSpec::OutboxAction(outbox) => serde_json::json!({
                "definitionDigest": version.digest,
                "resolvedInputDigest": resolved.digest,
                "primitive": "outbox_action",
                "actionKind": outbox.action_kind,
                "targetTemplate": outbox.target_template,
                "workspace": workspace_evidence,
            }),
            WorkflowStepSpec::Approval(_)
            | WorkflowStepSpec::Notify(_)
            | WorkflowStepSpec::UserGate(_)
            | WorkflowStepSpec::ConditionBranch(_)
            | WorkflowStepSpec::BoundedLoop(_)
            | WorkflowStepSpec::WaitForEvent(_) => {
                return Err(WorkflowError::Conflict(
                    "approval and notify steps do not have Agent execution evidence".to_string(),
                ));
            }
        };
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step_run = find_step_by_claim(&mut conn, run_id, &step.id, claim_token).await?;
            if let Some(existing_digest) = step_run.resolved_input_digest.as_deref() {
                if existing_digest != resolved.digest || step_run.workspace_id != Some(workspace_id)
                {
                    return Err(WorkflowError::Conflict(format!(
                        "step `{}` preparation evidence changed for the same attempt",
                        step.id
                    )));
                }
                return Ok(step_run);
            }
            let input_json = serde_json::to_string(&resolved.values)?;
            let evidence_json = serde_json::to_string(&execution_evidence)?;
            sqlx::query(
                "UPDATE workflow_step_runs
                 SET resolved_input_json = ?, resolved_input_digest = ?,
                     execution_evidence_json = ?, workspace_id = ?,
                     updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?
                   AND status = 'claimed' AND claim_token = ?",
            )
            .bind(input_json)
            .bind(&resolved.digest)
            .bind(evidence_json)
            .bind(workspace_id)
            .bind(run_id)
            .bind(&step.id)
            .bind(step_run.attempt)
            .bind(claim_token)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepPrepared {
                    step_id: step.id.clone(),
                    attempt: step_run.attempt as u32,
                    resolved_input: resolved.values.clone(),
                    resolved_input_digest: resolved.digest.clone(),
                    execution_evidence,
                    workspace_id: Some(workspace_id),
                },
            )
            .await?;
            find_step(&mut conn, run_id, &step.id, step_run.attempt).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn record_step_artifacts(
        &self,
        run_id: Uuid,
        step_id: &str,
        artifacts: &serde_json::Value,
    ) -> Result<WorkflowStepView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let run = find_run(&mut conn, run_id).await?;
            let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            let mut evidence = step
                .execution_evidence_json
                .as_deref()
                .map(serde_json::from_str::<serde_json::Value>)
                .transpose()?
                .unwrap_or_else(|| serde_json::json!({}));
            let evidence = evidence.as_object_mut().ok_or_else(|| {
                WorkflowError::Conflict(format!(
                    "workflow step `{step_id}` has invalid execution evidence"
                ))
            })?;
            let history = evidence
                .entry("artifactHistory")
                .or_insert_with(|| serde_json::json!([]));
            if let Some(history) = history.as_array_mut()
                && !history.contains(artifacts)
            {
                history.push(artifacts.clone());
            }
            let execution_evidence = serde_json::Value::Object(evidence.clone());
            let evidence_json = serde_json::to_string(&execution_evidence)?;
            if evidence_json.len() > policy.max_output_bytes {
                return Err(WorkflowError::Validation(format!(
                    "step evidence exceeds {} bytes",
                    policy.max_output_bytes
                )));
            }
            let evidence_digest = format!("{:x}", Sha256::digest(evidence_json.as_bytes()));
            sqlx::query(
                "UPDATE workflow_step_runs SET execution_evidence_json = ?,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ?",
            )
            .bind(evidence_json)
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepEvidenceRecorded {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                    evidence_digest,
                    execution_evidence: Some(execution_evidence),
                },
            )
            .await?;
            find_step(&mut conn, run_id, step_id, step.attempt).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn claim_ready(
        &self,
        global_limit: u32,
        claim_ttl: Duration,
    ) -> Result<Option<ClaimedWorkflowStep>, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            recover_stale_claims(&mut conn, Utc::now()).await?;
            let global_active: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM workflow_step_runs
                 WHERE status IN ('claimed', 'running')",
            )
            .fetch_one(&mut *conn)
            .await?;
            if global_active >= i64::from(global_limit.max(1)) {
                return Ok(None);
            }
            let candidates = sqlx::query(
                "SELECT ready.run_id, ready.step_id, ready.attempt
                 FROM workflow_ready_steps ready
                 JOIN workflow_runs run ON run.id = ready.run_id
                 WHERE ready.status = 'ready' AND run.status IN ('running', 'waiting')
                   AND run.control_state = 'active'
                   AND run.deadline_at > ?
                   AND run.dispatch_ready = 1
                 ORDER BY ready.ready_sequence, ready.run_id, ready.step_id
                 LIMIT 100",
            )
            .bind(Utc::now())
            .fetch_all(&mut *conn)
            .await?;
            for candidate in candidates {
                let run_id: Uuid = candidate.try_get("run_id")?;
                let step_id: String = candidate.try_get("step_id")?;
                let attempt: i64 = candidate.try_get("attempt")?;
                let run = find_run(&mut conn, run_id).await?;
                let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
                let active: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM workflow_step_runs
                     WHERE run_id = ? AND status IN ('claimed', 'running')",
                )
                .bind(run_id)
                .fetch_one(&mut *conn)
                .await?;
                if active >= i64::from(policy.max_concurrent_agent_steps)
                    || run.agent_calls_started >= i64::from(policy.max_agent_calls)
                {
                    continue;
                }
                let version = version_on_connection(&mut conn, run.definition_version_id).await?;
                let definition = version.definition()?;
                let definition_step = definition
                    .steps
                    .iter()
                    .find(|step| step.id == step_id)
                    .ok_or_else(|| {
                        WorkflowError::Projection(format!(
                            "workflow step `{step_id}` is missing from its definition"
                        ))
                    })?;
                let requires_shared_workspace_lease = match &definition_step.spec {
                    WorkflowStepSpec::Agent(agent) => matches!(
                        agent.workspace_access,
                        WorkspaceAccess::ReadOnlyShared | WorkspaceAccess::WriteSerialized
                    ),
                    WorkflowStepSpec::Session(session) => matches!(
                        session.workspace_access,
                        WorkspaceAccess::ReadOnlyShared | WorkspaceAccess::WriteSerialized
                    ),
                    _ => false,
                };
                if requires_shared_workspace_lease {
                    let workspace_active: i64 = sqlx::query_scalar(
                        "SELECT COUNT(*)
                         FROM workflow_step_runs step
                         JOIN workflow_runs active_run ON active_run.id = step.run_id
                         WHERE active_run.workspace_id = ?
                           AND step.status IN ('claimed', 'running')",
                    )
                    .bind(run.workspace_id)
                    .fetch_one(&mut *conn)
                    .await?;
                    if workspace_active > 0 {
                        continue;
                    }
                }
                if let WorkflowStepSpec::Bot(bot) = &definition_step.spec
                    && bot.mailbox_policy == BotMailboxPolicy::FifoSerial
                    && bot_member_is_busy(&mut conn, &bot.member_id).await?
                {
                    continue;
                }
                let claim_token = Uuid::new_v4();
                let claim_deadline = Utc::now() + claim_ttl;
                let updated = sqlx::query(
                    "UPDATE workflow_ready_steps
                     SET status = 'claimed', claim_token = ?, claim_deadline = ?
                     WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'ready'",
                )
                .bind(claim_token)
                .bind(claim_deadline)
                .bind(run_id)
                .bind(&step_id)
                .bind(attempt)
                .execute(&mut *conn)
                .await?;
                if updated.rows_affected() != 1 {
                    continue;
                }
                sqlx::query(
                    "UPDATE workflow_step_runs
                     SET status = 'claimed', claim_token = ?, claim_deadline = ?,
                         updated_at = datetime('now', 'subsec')
                     WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'ready'",
                )
                .bind(claim_token)
                .bind(claim_deadline)
                .bind(run_id)
                .bind(&step_id)
                .bind(attempt)
                .execute(&mut *conn)
                .await?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepClaimed {
                        step_id: step_id.clone(),
                        attempt: attempt as u32,
                        claim_token,
                        claim_deadline,
                    },
                )
                .await?;
                let step = find_step(&mut conn, run_id, &step_id, attempt).await?;
                return Ok(Some(ClaimedWorkflowStep {
                    run,
                    step,
                    definition,
                    claim_token,
                }));
            }
            Ok(None)
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn mark_started(
        &self,
        run_id: Uuid,
        step_id: &str,
        claim_token: Uuid,
        conversation_id: Option<Uuid>,
        turn_id: Option<Uuid>,
    ) -> Result<WorkflowStepView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let updated = sqlx::query(
                "UPDATE workflow_step_runs
                 SET status = 'running', conversation_id = ?, turn_id = ?, started_at = ?,
                     updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ?
                   AND status = 'claimed' AND claim_token = ?",
            )
            .bind(conversation_id)
            .bind(turn_id)
            .bind(Utc::now())
            .bind(run_id)
            .bind(step_id)
            .bind(claim_token)
            .execute(&mut *conn)
            .await?;
            if updated.rows_affected() != 1 {
                return Err(WorkflowError::Conflict(
                    "workflow step claim is stale or no longer owned".to_string(),
                ));
            }
            sqlx::query(
                "DELETE FROM workflow_ready_steps
                 WHERE run_id = ? AND step_id = ? AND claim_token = ?",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(claim_token)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "UPDATE workflow_runs SET agent_calls_started = agent_calls_started + 1,
                        updated_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            let step = find_step_by_claim(&mut conn, run_id, step_id, claim_token).await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepStarted {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                    claim_token,
                    conversation_id,
                    turn_id,
                },
            )
            .await?;
            Ok(step)
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn bind_turn(
        &self,
        run_id: Uuid,
        step_id: &str,
        conversation_id: Uuid,
        turn_id: Uuid,
    ) -> Result<WorkflowStepView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            let updated = sqlx::query(
                "UPDATE workflow_step_runs SET conversation_id = ?, turn_id = ?,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'running'",
            )
            .bind(conversation_id)
            .bind(turn_id)
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            if updated.rows_affected() != 1 {
                return Err(WorkflowError::Conflict(format!(
                    "workflow step `{step_id}` is no longer running"
                )));
            }
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepTurnBound {
                    step_id: step_id.to_string(),
                    attempt: step.attempt as u32,
                    conversation_id,
                    turn_id,
                },
            )
            .await?;
            find_step(&mut conn, run_id, step_id, step.attempt).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn set_step_awaiting_input(
        &self,
        run_id: Uuid,
        step_id: &str,
        awaiting: bool,
        reason: Option<&str>,
        submitted_turn_id: Option<Uuid>,
    ) -> Result<WorkflowStepView, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            if step.status != "running" {
                return Err(WorkflowError::Conflict(format!(
                    "step `{step_id}` cannot change input state from {}",
                    step.status
                )));
            }
            let conversation_id = step.conversation_id.ok_or_else(|| {
                WorkflowError::Conflict(format!("step `{step_id}` has no child Conversation"))
            })?;
            if step.awaiting_input == awaiting {
                return Ok(step);
            }
            sqlx::query(
                "UPDATE workflow_step_runs SET awaiting_input = ?,
                        turn_id = CASE WHEN ? THEN NULL ELSE turn_id END,
                        user_intervened = CASE WHEN ? THEN user_intervened ELSE 1 END,
                        waiting_interaction = 0,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'running'",
            )
            .bind(awaiting)
            .bind(awaiting)
            .bind(awaiting)
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            if awaiting {
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepInputRequested {
                        step_id: step_id.to_string(),
                        attempt: step.attempt as u32,
                        conversation_id,
                        reason: reason.map(str::to_string),
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
            } else {
                let turn_id = submitted_turn_id.ok_or_else(|| {
                    WorkflowError::Validation(
                        "resuming a step requires the submitted Turn id".to_string(),
                    )
                })?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepInputSubmitted {
                        step_id: step_id.to_string(),
                        attempt: step.attempt as u32,
                        conversation_id,
                        turn_id,
                    },
                )
                .await?;
                restore_running_if_not_waiting(&mut conn, run_id).await?;
            }
            find_step(&mut conn, run_id, step_id, step.attempt).await
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn set_interaction_waiting(
        &self,
        run_id: Uuid,
        step_id: &str,
        waiting: bool,
    ) -> Result<bool, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let step = find_latest_step(&mut conn, run_id, step_id).await?;
            if step.status != "running" || step.waiting_interaction == waiting {
                return Ok(false);
            }
            let updated = sqlx::query(
                "UPDATE workflow_step_runs SET waiting_interaction = ?,
                        updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ? AND attempt = ? AND status = 'running'",
            )
            .bind(waiting)
            .bind(run_id)
            .bind(step_id)
            .bind(step.attempt)
            .execute(&mut *conn)
            .await?;
            if updated.rows_affected() != 1 {
                return Ok(false);
            }
            if waiting {
                let conversation_id = step.conversation_id.ok_or_else(|| {
                    WorkflowError::Projection("waiting step has no child Conversation".to_string())
                })?;
                let turn_id = step.turn_id.ok_or_else(|| {
                    WorkflowError::Projection("waiting step has no active Turn".to_string())
                })?;
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepInteractionWaiting {
                        step_id: step_id.to_string(),
                        attempt: step.attempt as u32,
                        conversation_id,
                        turn_id,
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
            } else {
                append_event(
                    &mut conn,
                    run_id,
                    None,
                    &WorkflowEvent::StepInteractionResumed {
                        step_id: step_id.to_string(),
                        attempt: step.attempt as u32,
                    },
                )
                .await?;
                restore_running_if_not_waiting(&mut conn, run_id).await?;
            }
            Ok(true)
        }
        .await;
        self.finish(conn, result).await
    }

    pub async fn begin_repair(&self, run_id: Uuid, step_id: &str) -> Result<bool, WorkflowError> {
        let mut conn = self.begin_immediate().await?;
        let result = async {
            let run = find_run(&mut conn, run_id).await?;
            let policy: WorkflowPolicy = serde_json::from_str(&run.policy_json)?;
            if run.agent_calls_started >= i64::from(policy.max_agent_calls) {
                return Ok(false);
            }
            let updated = sqlx::query(
                "UPDATE workflow_step_runs SET repair_count = repair_count + 1,
                        turn_id = NULL, updated_at = datetime('now', 'subsec')
                 WHERE run_id = ? AND step_id = ?
                   AND attempt = (SELECT MAX(attempt) FROM workflow_step_runs
                                  WHERE run_id = ? AND step_id = ?)
                   AND status = 'running' AND repair_count = 0",
            )
            .bind(run_id)
            .bind(step_id)
            .bind(run_id)
            .bind(step_id)
            .execute(&mut *conn)
            .await?;
            if updated.rows_affected() != 1 {
                return Ok(false);
            }
            sqlx::query(
                "UPDATE workflow_runs SET agent_calls_started = agent_calls_started + 1,
                        updated_at = datetime('now', 'subsec') WHERE id = ?",
            )
            .bind(run_id)
            .execute(&mut *conn)
            .await?;
            let attempt: i64 = sqlx::query_scalar(
                "SELECT MAX(attempt) FROM workflow_step_runs WHERE run_id = ? AND step_id = ?",
            )
            .bind(run_id)
            .bind(step_id)
            .fetch_one(&mut *conn)
            .await?;
            append_event(
                &mut conn,
                run_id,
                None,
                &WorkflowEvent::StepRepairRequested {
                    step_id: step_id.to_string(),
                    attempt: attempt as u32,
                },
            )
            .await?;
            Ok(true)
        }
        .await;
        self.finish(conn, result).await
    }
}

pub(crate) async fn resolve_step_input_on_connection(
    conn: &mut SqliteConnection,
    run: &WorkflowRunView,
    definition: &WorkflowDefinition,
    step: &WorkflowStep,
) -> Result<ResolvedWorkflowStepInput, WorkflowError> {
    let run_input: serde_json::Value = serde_json::from_str(&run.input_json)?;
    let mut values = BTreeMap::new();
    for dependency in &step.depends_on {
        let latest: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT status, output_json FROM workflow_step_runs
             WHERE run_id = ? AND step_id = ?
             ORDER BY attempt DESC LIMIT 1",
        )
        .bind(run.id)
        .bind(dependency)
        .fetch_optional(&mut *conn)
        .await?;
        let Some((status, output_json)) = latest else {
            return Err(WorkflowError::Conflict(format!(
                "dependency step `{dependency}` has no accepted output"
            )));
        };
        if status == "skipped" {
            continue;
        }
        if status == "pending" && is_bounded_loop_back_edge(definition, &step.id, dependency) {
            continue;
        }
        if status != "completed" {
            return Err(WorkflowError::Conflict(format!(
                "dependency step `{dependency}` has no accepted output"
            )));
        }
        let output_json = output_json.ok_or_else(|| {
            WorkflowError::Conflict(format!(
                "dependency step `{dependency}` has no accepted output"
            ))
        })?;
        values.insert(
            dependency.clone(),
            serde_json::from_str::<serde_json::Value>(&output_json)?,
        );
    }
    for (name, binding) in &step.input_bindings {
        let (source, pointer) = match binding {
            WorkflowBinding::RunInput { pointer } => (&run_input, pointer.as_str()),
            WorkflowBinding::StepOutput { step_id, pointer } => {
                let output_json: Option<String> = sqlx::query_scalar(
                    "SELECT output_json FROM workflow_step_runs
                     WHERE run_id = ? AND step_id = ? AND status = 'completed'
                       AND output_json IS NOT NULL
                     ORDER BY attempt DESC LIMIT 1",
                )
                .bind(run.id)
                .bind(step_id)
                .fetch_optional(&mut *conn)
                .await?;
                let output_json = output_json.ok_or_else(|| {
                    WorkflowError::Conflict(format!(
                        "step `{step_id}` has no accepted output for binding `{name}`"
                    ))
                })?;
                let output = serde_json::from_str::<serde_json::Value>(&output_json)?;
                let selected = select_pointer(&output, pointer).ok_or_else(|| {
                    WorkflowError::Validation(format!(
                        "binding `{name}` pointer `{pointer}` does not exist in step `{step_id}` output"
                    ))
                })?;
                values.insert(name.clone(), selected.clone());
                continue;
            }
        };
        let selected = select_pointer(source, pointer).ok_or_else(|| {
            WorkflowError::Validation(format!(
                "binding `{name}` pointer `{pointer}` does not exist in Run input"
            ))
        })?;
        values.insert(name.clone(), selected.clone());
    }
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&values)?));
    Ok(ResolvedWorkflowStepInput { values, digest })
}

async fn bot_member_is_busy(
    conn: &mut SqliteConnection,
    member_id: &str,
) -> Result<bool, WorkflowError> {
    let active_rows = sqlx::query(
        "SELECT step.step_id, run.definition_version_id
         FROM workflow_step_runs step
         JOIN workflow_runs run ON run.id = step.run_id
         WHERE step.status IN ('claimed', 'running')
           AND run.status IN ('running', 'waiting')",
    )
    .fetch_all(&mut *conn)
    .await?;
    for row in active_rows {
        let active_step_id: String = row.try_get("step_id")?;
        let version_id: Uuid = row.try_get("definition_version_id")?;
        let version = version_on_connection(&mut *conn, version_id).await?;
        let definition = version.definition()?;
        if let Some(active_step) = definition.steps.iter().find(|s| s.id == active_step_id)
            && let WorkflowStepSpec::Bot(active_bot) = &active_step.spec
            && active_bot.member_id == member_id
        {
            return Ok(true);
        }
    }
    Ok(false)
}
