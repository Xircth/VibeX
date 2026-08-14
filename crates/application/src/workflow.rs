use agents::{
    AgentId, ConversationInputPayload,
    conversation::{ContentBlock, ConversationTimelineRow, TurnRole},
};
use async_trait::async_trait;
use chrono::Duration;
use conversations::{
    ConversationContext, ConversationProjector, CreateWorkflowConversation,
    SubmitConversationInput, create_workflow_conversation,
};
use db::models::{
    conversation::{ConversationRecord, CreateConversationRecord},
    conversation_side_effects::ConversationFileChangeRecord,
    conversation_turn::ConversationTurnRecord,
    task::{CreateTask, Task, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use uuid::Uuid;
use workflows::{
    CompleteWorkflowStep, DecideApproval, PublishWorkflow, ReviewWorkflow, StartWorkflow,
    WorkflowCore, WorkflowDefinition, WorkflowEventRecord, WorkflowPolicy, WorkflowReviewDecision,
    WorkflowRunView, WorkflowStepSpec, WorkflowStepView, WorkflowStore, WorkflowValidationView,
    WorkflowVersionView, WorkspaceAccess,
};

use crate::{
    ApplicationError, ConversationExecutionPort, ConversationSessionExecutionPort, Principal,
};

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishWorkflowRequest {
    pub definition_id: Option<Uuid>,
    pub definition: WorkflowDefinition,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateWorkflowRequest {
    pub definition: WorkflowDefinition,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWorkflowRequest {
    pub definition_version_id: Uuid,
    pub workspace_id: Uuid,
    pub input: serde_json::Value,
    pub policy_override: Option<WorkflowPolicy>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteWorkflowStepRequest {
    pub run_id: Uuid,
    pub step_id: String,
    pub output: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecideWorkflowRequest {
    pub run_id: Uuid,
    pub step_id: String,
    pub decision: serde_json::Value,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelWorkflowRequest {
    pub run_id: Uuid,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeWorkflowRequest {
    pub run_id: Uuid,
    pub decision: WorkflowReviewDecision,
}

#[async_trait]
pub trait WorkflowExecutionPort: Send + Sync {
    async fn validate(
        &self,
        request: ValidateWorkflowRequest,
    ) -> Result<WorkflowValidationView, ApplicationError> {
        let _ = request;
        Err(ApplicationError::capability_unavailable(
            "workflow validation is not configured",
        ))
    }
    async fn publish(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: PublishWorkflowRequest,
    ) -> Result<WorkflowVersionView, ApplicationError>;
    async fn start(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: StartWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError>;
    async fn show(&self, run_id: Uuid) -> Result<WorkflowRunView, ApplicationError>;
    async fn version(&self, version_id: Uuid) -> Result<WorkflowVersionView, ApplicationError>;
    async fn steps(&self, run_id: Uuid) -> Result<Vec<WorkflowStepView>, ApplicationError>;
    async fn events(
        &self,
        run_id: Uuid,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<WorkflowEventRecord>, ApplicationError>;
    async fn complete_step(
        &self,
        request: CompleteWorkflowStepRequest,
    ) -> Result<WorkflowRunView, ApplicationError>;
    async fn decide(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: DecideWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError>;
    async fn cancel(
        &self,
        operation_id: Uuid,
        request: CancelWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError>;
    async fn resume(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ResumeWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError>;
}

pub struct WorkflowStoreExecutionPort {
    core: WorkflowCore,
    store: WorkflowStore,
    pool: sqlx::SqlitePool,
    conversation_context: Option<ConversationContext>,
}

#[derive(Clone)]
pub struct WorkflowAgentDispatcher {
    store: WorkflowStore,
    core: WorkflowCore,
    conversations: std::sync::Arc<ConversationSessionExecutionPort>,
    context: ConversationContext,
    next_retention_at: std::sync::Arc<std::sync::Mutex<std::time::Instant>>,
}

struct RepairRequest<'a> {
    step_run_id: Uuid,
    run_id: Uuid,
    step_id: &'a str,
    conversation_id: Uuid,
    workspace_id: Uuid,
    agent: &'a workflows::AgentStepSpec,
    validation_error: &'a str,
}

impl WorkflowAgentDispatcher {
    pub fn new(context: ConversationContext) -> Self {
        let store = WorkflowStore::new(context.deployment.db().pool.clone());
        Self {
            core: WorkflowCore::new(store.clone()),
            store,
            conversations: std::sync::Arc::new(ConversationSessionExecutionPort::new(
                context.clone(),
            )),
            context,
            next_retention_at: std::sync::Arc::new(
                std::sync::Mutex::new(std::time::Instant::now()),
            ),
        }
    }

    pub async fn tick(&self) -> Result<bool, ApplicationError> {
        if self.cleanup_retained_runs().await? {
            return Ok(true);
        }
        if self.cancel_expired_runs().await? {
            return Ok(true);
        }
        if self.reconcile_waiting_interactions().await? {
            return Ok(true);
        }
        if self.reconcile_terminal_steps().await? {
            return Ok(true);
        }
        let Some(claimed) = self
            .store
            .claim_ready(16, Duration::seconds(30))
            .await
            .map_err(map_error)?
        else {
            return Ok(false);
        };
        let step = claimed
            .definition
            .steps
            .iter()
            .find(|step| step.id == claimed.step.step_id)
            .ok_or_else(|| ApplicationError::internal("claimed workflow step is missing"))?;
        let WorkflowStepSpec::Agent(agent) = &step.spec else {
            return Err(ApplicationError::internal(
                "dispatcher claimed a non-agent workflow step",
            ));
        };
        let agent_id = AgentId::parse(&agent.agent_id)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let resolved_input = match self.store.resolve_step_input(claimed.run.id, step).await {
            Ok(input) => input,
            Err(error) => {
                self.store
                    .fail_step(
                        claimed.run.id,
                        &step.id,
                        "input_binding_failed",
                        &error.to_string(),
                    )
                    .await
                    .map_err(map_error)?;
                return Ok(true);
            }
        };
        let (step_workspace_id, workspace_evidence) =
            if agent.workspace_access == WorkspaceAccess::WriteIsolated {
                match create_isolated_step_workspace(
                    &self.context,
                    claimed.run.workspace_id,
                    claimed.run.id,
                    &step.id,
                    claimed.step.attempt,
                    claimed.step.id,
                )
                .await
                {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        self.store
                            .fail_step(
                                claimed.run.id,
                                &step.id,
                                "workspace_isolation_failed",
                                &error.to_string(),
                            )
                            .await
                            .map_err(map_error)?;
                        return Ok(true);
                    }
                }
            } else {
                (
                    claimed.run.workspace_id,
                    serde_json::json!({
                        "isolated": false,
                        "workspaceId": claimed.run.workspace_id,
                        "policy": agent.workspace_access,
                    }),
                )
            };
        self.store
            .prepare_step(
                claimed.run.id,
                step,
                claimed.claim_token,
                &resolved_input,
                step_workspace_id,
                &workspace_evidence,
            )
            .await
            .map_err(map_error)?;
        let prompt = render_agent_prompt(&agent.prompt, &resolved_input.values)?;
        // The StepRun id is a stable child identity. A crash after child
        // creation but before StepStarted can safely retry this preflight
        // without creating a second child Conversation.
        let child_id = claimed.step.id;
        if let Err(error) = create_workflow_conversation(
            &self.context.deployment.db().pool,
            CreateWorkflowConversation {
                id: child_id,
                parent_conversation_id: claimed.run.id,
                workspace_id: step_workspace_id,
                workflow_run_id: claimed.run.id,
                workflow_step_id: step.id.clone(),
                agent_id: agent_id.clone(),
                prompt: prompt.clone(),
                visible: false,
            },
        )
        .await
        {
            self.store
                .fail_step(
                    claimed.run.id,
                    &step.id,
                    "child_create_failed",
                    &error.to_string(),
                )
                .await
                .map_err(map_error)?;
            return Ok(true);
        }
        self.store
            .mark_started(
                claimed.run.id,
                &step.id,
                claimed.claim_token,
                Some(child_id),
                None,
            )
            .await
            .map_err(map_error)?;
        let submission = self
            .conversations
            .submit_input(SubmitConversationInput {
                conversation_id: child_id,
                operation_id: child_id,
                payload: ConversationInputPayload {
                    agent_id,
                    workspace_id: step_workspace_id,
                    executor_profile_id: None,
                    text: prompt,
                    display_text: None,
                    images: Vec::new(),
                    mode_override: None,
                    config_overrides: Vec::new(),
                    plugin_actions: Vec::new(),
                },
                principal: serde_json::json!({
                    "id": "workflow-dispatcher",
                    "workflowRunId": claimed.run.id,
                    "workflowStepId": step.id,
                }),
            })
            .await;
        match submission {
            Ok(submission) => {
                let turn = submission.turn.ok_or_else(|| {
                    ApplicationError::internal("workflow input was queued instead of dispatched")
                })?;
                self.store
                    .bind_turn(claimed.run.id, &step.id, child_id, turn.turn_id)
                    .await
                    .map_err(map_error)?;
            }
            Err(error) => {
                self.store
                    .fail_step(
                        claimed.run.id,
                        &step.id,
                        "conversation_start_failed",
                        &error.to_string(),
                    )
                    .await
                    .map_err(map_error)?;
            }
        }
        Ok(true)
    }

    async fn cleanup_retained_runs(&self) -> Result<bool, ApplicationError> {
        let should_run = {
            let mut next = self.next_retention_at.lock().unwrap();
            let now = std::time::Instant::now();
            if now < *next {
                false
            } else {
                *next = now + std::time::Duration::from_secs(60 * 60);
                true
            }
        };
        if !should_run {
            return Ok(false);
        }
        let cutoff = chrono::Utc::now() - chrono::Duration::days(30);
        let candidates = self
            .store
            .retention_candidates(cutoff, 100)
            .await
            .map_err(map_error)?;
        let mut deleted = false;
        for candidate in candidates {
            let mut cleanup_failed = false;
            for workspace_id in candidate.isolated_workspace_ids {
                let workspace =
                    Workspace::find_by_id(&self.context.deployment.db().pool, workspace_id)
                        .await
                        .map_err(|error| ApplicationError::internal(error.to_string()))?;
                let Some(workspace) = workspace else {
                    continue;
                };
                if self
                    .context
                    .deployment
                    .container()
                    .delete(&workspace)
                    .await
                    .is_err()
                {
                    cleanup_failed = true;
                    break;
                }
                Workspace::delete(&self.context.deployment.db().pool, workspace.id)
                    .await
                    .map_err(|error| ApplicationError::internal(error.to_string()))?;
                let _ = Task::delete(&self.context.deployment.db().pool, workspace.task_id).await;
            }
            if cleanup_failed {
                continue;
            }
            deleted |= self
                .store
                .cleanup_terminal_run(candidate.run_id, cutoff)
                .await
                .map_err(map_error)?;
        }
        Ok(deleted)
    }

    async fn cancel_expired_runs(&self) -> Result<bool, ApplicationError> {
        let run_ids = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM workflow_runs
             WHERE status IN ('running', 'waiting') AND deadline_at <= ?
             ORDER BY deadline_at, id LIMIT 32",
        )
        .bind(chrono::Utc::now())
        .fetch_all(&self.context.deployment.db().pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        if run_ids.is_empty() {
            return Ok(false);
        }
        let service = conversations::ConversationSessionService::new(self.context.clone());
        for run_id in run_ids {
            for step in self.store.steps(run_id).await.map_err(map_error)? {
                if matches!(step.status.as_str(), "claimed" | "running")
                    && let Some(conversation_id) = step.conversation_id
                {
                    let _ = service
                        .cancel_turn(
                            conversation_id,
                            Some("Workflow deadline exceeded".to_string()),
                        )
                        .await;
                }
            }
            self.store
                .cancel(run_id, Uuid::new_v4(), Some("deadline exceeded"))
                .await
                .map_err(map_error)?;
        }
        Ok(true)
    }

    async fn reconcile_terminal_steps(&self) -> Result<bool, ApplicationError> {
        let rows = sqlx::query_as::<_, (Uuid, Uuid, String, Uuid, Uuid, Option<Uuid>)>(
            "SELECT id, run_id, step_id, conversation_id, turn_id, workspace_id
             FROM workflow_step_runs
             WHERE status = 'running' AND conversation_id IS NOT NULL AND turn_id IS NOT NULL
             ORDER BY updated_at LIMIT 32",
        )
        .fetch_all(&self.context.deployment.db().pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let mut changed = false;
        for (step_run_id, run_id, step_id, conversation_id, turn_id, step_workspace_id) in rows {
            let Some(turn) =
                ConversationTurnRecord::find_by_id(&self.context.deployment.db().pool, turn_id)
                    .await
                    .map_err(|error| ApplicationError::internal(error.to_string()))?
            else {
                continue;
            };
            match turn.status.as_str() {
                "completed" => {
                    self.record_step_artifacts(run_id, &step_id, turn_id)
                        .await?;
                    let run = self.store.run(run_id).await.map_err(map_error)?;
                    let definition = self
                        .store
                        .version(run.definition_version_id)
                        .await
                        .map_err(map_error)?
                        .definition()
                        .map_err(map_error)?;
                    let step = definition
                        .steps
                        .iter()
                        .find(|step| step.id == step_id)
                        .ok_or_else(|| ApplicationError::internal("workflow step is missing"))?;
                    let output = match &step.spec {
                        WorkflowStepSpec::Agent(agent) if agent.output_schema.is_some() => {
                            match extract_structured_output(
                                &self.context.deployment.db().pool,
                                conversation_id,
                            )
                            .await
                            {
                                Ok(output) => Some(output),
                                Err(error)
                                    if agent.allow_one_repair
                                        && self
                                            .request_repair(RepairRequest {
                                                step_run_id,
                                                run_id,
                                                step_id: &step_id,
                                                conversation_id,
                                                workspace_id: step_workspace_id.ok_or_else(|| {
                                                    ApplicationError::internal(
                                                        "running workflow step has no workspace evidence",
                                                    )
                                                })?,
                                                agent,
                                                validation_error: &error.to_string(),
                                            })
                                            .await? =>
                                {
                                    changed = true;
                                    continue;
                                }
                                Err(error) => {
                                    self.store
                                        .fail_step(
                                            run_id,
                                            &step_id,
                                            "invalid_structured_output",
                                            &error.to_string(),
                                        )
                                        .await
                                        .map_err(map_error)?;
                                    changed = true;
                                    continue;
                                }
                            }
                        }
                        _ => None,
                    };
                    match self
                        .core
                        .complete_step(CompleteWorkflowStep {
                            run_id,
                            step_id: step_id.clone(),
                            output,
                        })
                        .await
                    {
                        Ok(_) => {}
                        Err(error) => {
                            self.store
                                .fail_step(
                                    run_id,
                                    &step_id,
                                    "invalid_structured_output",
                                    &error.to_string(),
                                )
                                .await
                                .map_err(map_error)?;
                        }
                    }
                    changed = true;
                }
                "failed" | "cancelled" => {
                    self.record_step_artifacts(run_id, &step_id, turn_id)
                        .await?;
                    self.store
                        .fail_step(
                            run_id,
                            &step_id,
                            &turn.status,
                            "Agent Turn did not complete",
                        )
                        .await
                        .map_err(map_error)?;
                    changed = true;
                }
                "interrupted" => {
                    self.record_step_artifacts(run_id, &step_id, turn_id)
                        .await?;
                    self.store
                        .needs_review_step(
                            run_id,
                            &step_id,
                            "Agent Turn was interrupted after dispatch",
                        )
                        .await
                        .map_err(map_error)?;
                    changed = true;
                }
                _ => {}
            }
        }
        Ok(changed)
    }

    async fn reconcile_waiting_interactions(&self) -> Result<bool, ApplicationError> {
        let rows = sqlx::query_as::<_, (Uuid, String, bool, bool)>(
            "SELECT step.run_id, step.step_id,
                    turn.status = 'blocked' AS child_waiting,
                    step.waiting_interaction
             FROM workflow_step_runs step
             JOIN conversation_turns turn ON turn.id = step.turn_id
             WHERE step.status = 'running'
             ORDER BY step.updated_at LIMIT 64",
        )
        .fetch_all(&self.context.deployment.db().pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let mut changed = false;
        for (run_id, step_id, child_waiting, projected_waiting) in rows {
            if child_waiting != projected_waiting {
                changed |= self
                    .store
                    .set_interaction_waiting(run_id, &step_id, child_waiting)
                    .await
                    .map_err(map_error)?;
            }
        }
        Ok(changed)
    }

    async fn record_step_artifacts(
        &self,
        run_id: Uuid,
        step_id: &str,
        turn_id: Uuid,
    ) -> Result<(), ApplicationError> {
        let files = ConversationFileChangeRecord::list_for_turn(
            &self.context.deployment.db().pool,
            turn_id,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let artifacts = serde_json::json!({
            "turnId": turn_id,
            "fileChanges": files,
            "autoMerge": false,
        });
        self.store
            .record_step_artifacts(run_id, step_id, &artifacts)
            .await
            .map_err(map_error)?;
        Ok(())
    }

    async fn request_repair(&self, request: RepairRequest<'_>) -> Result<bool, ApplicationError> {
        if !self
            .store
            .begin_repair(request.run_id, request.step_id)
            .await
            .map_err(map_error)?
        {
            return Ok(false);
        }
        let schema = request
            .agent
            .output_schema
            .as_ref()
            .ok_or_else(|| ApplicationError::internal("repair requires output schema"))?;
        let prompt = format!(
            "Return only one JSON value matching this schema. No Markdown.\nSchema: {}\nPrevious validation error: {}",
            serde_json::to_string(schema)
                .map_err(|error| ApplicationError::internal(error.to_string()))?,
            request.validation_error,
        );
        let agent_id = AgentId::parse(&request.agent.agent_id)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        match self
            .conversations
            .submit_input(SubmitConversationInput {
                conversation_id: request.conversation_id,
                operation_id: request.step_run_id,
                payload: ConversationInputPayload {
                    agent_id,
                    workspace_id: request.workspace_id,
                    executor_profile_id: None,
                    text: prompt,
                    display_text: None,
                    images: Vec::new(),
                    mode_override: None,
                    config_overrides: Vec::new(),
                    plugin_actions: Vec::new(),
                },
                principal: serde_json::json!({
                    "id": "workflow-output-repair",
                    "workflowRunId": request.run_id,
                    "workflowStepId": request.step_id,
                }),
            })
            .await
        {
            Ok(submission) => {
                let turn = submission.turn.ok_or_else(|| {
                    ApplicationError::internal("workflow repair input was not dispatched")
                })?;
                self.store
                    .bind_turn(
                        request.run_id,
                        request.step_id,
                        request.conversation_id,
                        turn.turn_id,
                    )
                    .await
                    .map_err(map_error)?;
                Ok(true)
            }
            Err(error) => {
                self.store
                    .fail_step(
                        request.run_id,
                        request.step_id,
                        "repair_start_failed",
                        &error.to_string(),
                    )
                    .await
                    .map_err(map_error)?;
                Ok(true)
            }
        }
    }
}

async fn create_isolated_step_workspace(
    context: &ConversationContext,
    parent_workspace_id: Uuid,
    run_id: Uuid,
    step_id: &str,
    attempt: i64,
    isolated_workspace_id: Uuid,
) -> Result<(Uuid, serde_json::Value), ApplicationError> {
    let pool = &context.deployment.db().pool;
    let parent = Workspace::find_by_id(pool, parent_workspace_id)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
        .ok_or_else(|| ApplicationError::not_found("workflow workspace not found"))?;
    let repos = WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, parent.id)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    if repos.is_empty() {
        return Err(ApplicationError::bad_request(
            "write_isolated requires at least one repository",
        ));
    }
    let branch = format!("workflow/{run_id}/step-{step_id}-attempt-{attempt}");
    let agent_working_dir = match repos.as_slice() {
        [repo] => Some(repo.repo.default_working_dir.as_deref().map_or_else(
            || repo.repo.name.clone(),
            |subdir| {
                std::path::PathBuf::from(&repo.repo.name)
                    .join(subdir)
                    .to_string_lossy()
                    .into_owned()
            },
        )),
        _ => None,
    };
    let workspace = if let Some(existing) = Workspace::find_by_id(pool, isolated_workspace_id)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
    {
        existing
    } else {
        let title = format!("Workflow {run_id} · {step_id} · attempt {attempt}");
        let task = Task::create(
            pool,
            &CreateTask {
                project_id: parent.project_id,
                title,
                description: None,
                status: Some(TaskStatus::Todo),
                parent_workspace_id: Some(parent.id),
                image_ids: None,
            },
            Uuid::new_v4(),
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let workspace = Workspace::create(
            pool,
            &CreateWorkspace {
                project_id: parent.project_id,
                parent_workspace_id: Some(parent.id),
                branch: branch.clone(),
                container_ref: None,
                use_worktree: true,
                agent_working_dir,
            },
            isolated_workspace_id,
            task.id,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        WorkspaceRepo::create_many(
            pool,
            workspace.id,
            &repos
                .iter()
                .map(|repo| CreateWorkspaceRepo {
                    repo_id: repo.repo.id,
                    target_branch: repo.target_branch.clone(),
                })
                .collect::<Vec<_>>(),
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        workspace
    };

    if let Err(error) = context
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await
    {
        let _ = context.deployment.container().delete(&workspace).await;
        let _ = Workspace::delete(pool, workspace.id).await;
        let _ = Task::delete(pool, workspace.task_id).await;
        return Err(ApplicationError::internal(format!(
            "failed to create isolated workflow worktree: {error}"
        )));
    }
    let materialized = Workspace::find_by_id(pool, workspace.id)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
        .ok_or_else(|| ApplicationError::internal("isolated workspace disappeared"))?;
    let mut checkpoints = Vec::new();
    for repo in &repos {
        let path = materialized
            .repo_path(&repo.repo)
            .ok_or_else(|| ApplicationError::internal("isolated repo path is unavailable"))?;
        let head = context
            .deployment
            .git()
            .get_head_info(&path)
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        checkpoints.push(serde_json::json!({
            "repoId": repo.repo.id,
            "path": path,
            "targetBranch": repo.target_branch,
            "headCommit": head.oid,
        }));
    }
    Ok((
        workspace.id,
        serde_json::json!({
            "isolated": true,
            "workspaceId": workspace.id,
            "parentWorkspaceId": parent.id,
            "branch": branch,
            "checkpoint": checkpoints,
            "autoMerge": false,
        }),
    ))
}

fn render_agent_prompt(
    prompt: &str,
    input: &std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<String, ApplicationError> {
    if input.is_empty() {
        return Ok(prompt.to_string());
    }
    let bindings = serde_json::to_string_pretty(input)
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    Ok(format!(
        "{prompt}\n\nWorkflow input bindings (authoritative JSON):\n{bindings}"
    ))
}

async fn extract_structured_output(
    pool: &sqlx::SqlitePool,
    conversation_id: Uuid,
) -> Result<serde_json::Value, ApplicationError> {
    let timeline = ConversationProjector::project(pool, conversation_id)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    let text = timeline
        .rows
        .iter()
        .rev()
        .find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.role == TurnRole::Assistant =>
            {
                let text = turn
                    .blocks
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<String>();
                (!text.trim().is_empty()).then_some(text)
            }
            _ => None,
        })
        .ok_or_else(|| ApplicationError::bad_request("Agent produced no structured output"))?;
    serde_json::from_str(text.trim())
        .map_err(|error| ApplicationError::bad_request(format!("invalid JSON output: {error}")))
}

impl WorkflowStoreExecutionPort {
    pub fn new(pool: sqlx::SqlitePool) -> Self {
        let store = WorkflowStore::new(pool.clone());
        Self {
            core: WorkflowCore::new(store.clone()),
            store,
            pool,
            conversation_context: None,
        }
    }

    pub fn with_conversations(pool: sqlx::SqlitePool, context: ConversationContext) -> Self {
        let mut port = Self::new(pool);
        port.conversation_context = Some(context);
        port
    }

    pub async fn reconcile_interrupted(&self) -> Result<usize, ApplicationError> {
        let evidence_mismatches = self
            .store
            .reconcile_completed_evidence()
            .await
            .map_err(map_error)?;
        let interrupted = self
            .store
            .reconcile_interrupted()
            .await
            .map_err(map_error)?;
        for run in self
            .store
            .runs_awaiting_dispatch(1_000)
            .await
            .map_err(map_error)?
        {
            self.ensure_run_shell_and_dispatch(&run).await?;
        }
        Ok(interrupted + evidence_mismatches)
    }

    async fn ensure_run_shell_and_dispatch(
        &self,
        run: &WorkflowRunView,
    ) -> Result<(), ApplicationError> {
        if ConversationRecord::find_by_id(&self.pool, run.id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .is_none()
        {
            let created = ConversationRecord::create(
                &self.pool,
                run.id,
                CreateConversationRecord {
                    workspace_id: run.workspace_id,
                    task_id: None,
                    title: Some("Workflow run"),
                    initial_prompt: None,
                    status: None,
                    executor: Some("workflow"),
                },
            )
            .await;
            if let Err(error) = created {
                let raced = ConversationRecord::find_by_id(&self.pool, run.id)
                    .await
                    .map_err(|lookup| ApplicationError::internal(lookup.to_string()))?
                    .is_some_and(|shell| shell.workspace_id == run.workspace_id);
                if !raced {
                    return Err(ApplicationError::internal(error.to_string()));
                }
            }
        }
        self.store.enable_dispatch(run.id).await.map_err(map_error)
    }
}

#[async_trait]
impl WorkflowExecutionPort for WorkflowStoreExecutionPort {
    async fn validate(
        &self,
        request: ValidateWorkflowRequest,
    ) -> Result<WorkflowValidationView, ApplicationError> {
        self.core.validate(request.definition).map_err(map_error)
    }

    async fn publish(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: PublishWorkflowRequest,
    ) -> Result<WorkflowVersionView, ApplicationError> {
        self.core
            .publish(PublishWorkflow {
                definition_id: request.definition_id,
                definition: request.definition,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)
    }

    async fn start(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: StartWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        let run = self
            .core
            .start(StartWorkflow {
                definition_version_id: request.definition_version_id,
                workspace_id: request.workspace_id,
                input: request.input,
                policy_override: request.policy_override,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)?;
        self.ensure_run_shell_and_dispatch(&run).await?;
        Ok(run)
    }

    async fn show(&self, run_id: Uuid) -> Result<WorkflowRunView, ApplicationError> {
        self.store.run(run_id).await.map_err(map_error)
    }

    async fn version(&self, version_id: Uuid) -> Result<WorkflowVersionView, ApplicationError> {
        self.store.version(version_id).await.map_err(map_error)
    }

    async fn steps(&self, run_id: Uuid) -> Result<Vec<WorkflowStepView>, ApplicationError> {
        self.store.steps(run_id).await.map_err(map_error)
    }

    async fn events(
        &self,
        run_id: Uuid,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<WorkflowEventRecord>, ApplicationError> {
        self.store
            .events_since(run_id, after_sequence, limit)
            .await
            .map_err(map_error)
    }

    async fn complete_step(
        &self,
        request: CompleteWorkflowStepRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        self.core
            .complete_step(CompleteWorkflowStep {
                run_id: request.run_id,
                step_id: request.step_id,
                output: request.output,
            })
            .await
            .map_err(map_error)
    }

    async fn decide(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: DecideWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        self.core
            .decide(DecideApproval {
                run_id: request.run_id,
                step_id: request.step_id,
                decision: request.decision,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)
    }

    async fn cancel(
        &self,
        operation_id: Uuid,
        request: CancelWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if let Some(context) = &self.conversation_context {
            let service = conversations::ConversationSessionService::new(context.clone());
            for step in self.store.steps(request.run_id).await.map_err(map_error)? {
                if matches!(step.status.as_str(), "claimed" | "running")
                    && let Some(conversation_id) = step.conversation_id
                {
                    let _ = service
                        .cancel_turn(conversation_id, Some("Workflow run cancelled".to_string()))
                        .await;
                }
            }
        }
        self.core
            .cancel(request.run_id, operation_id, request.reason.as_deref())
            .await
            .map_err(map_error)
    }

    async fn resume(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ResumeWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        self.core
            .review(ReviewWorkflow {
                run_id: request.run_id,
                decision: request.decision,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)
    }
}

pub(crate) struct UnavailableWorkflowExecution;

#[async_trait]
impl WorkflowExecutionPort for UnavailableWorkflowExecution {
    async fn validate(
        &self,
        _: ValidateWorkflowRequest,
    ) -> Result<WorkflowValidationView, ApplicationError> {
        unavailable()
    }

    async fn publish(
        &self,
        _: &Principal,
        _: Uuid,
        _: PublishWorkflowRequest,
    ) -> Result<WorkflowVersionView, ApplicationError> {
        unavailable()
    }
    async fn start(
        &self,
        _: &Principal,
        _: Uuid,
        _: StartWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        unavailable()
    }
    async fn show(&self, _: Uuid) -> Result<WorkflowRunView, ApplicationError> {
        unavailable()
    }
    async fn version(&self, _: Uuid) -> Result<WorkflowVersionView, ApplicationError> {
        unavailable()
    }
    async fn steps(&self, _: Uuid) -> Result<Vec<WorkflowStepView>, ApplicationError> {
        unavailable()
    }
    async fn events(
        &self,
        _: Uuid,
        _: i64,
        _: i64,
    ) -> Result<Vec<WorkflowEventRecord>, ApplicationError> {
        unavailable()
    }
    async fn complete_step(
        &self,
        _: CompleteWorkflowStepRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        unavailable()
    }
    async fn decide(
        &self,
        _: &Principal,
        _: Uuid,
        _: DecideWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        unavailable()
    }
    async fn cancel(
        &self,
        _: Uuid,
        _: CancelWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        unavailable()
    }
    async fn resume(
        &self,
        _: &Principal,
        _: Uuid,
        _: ResumeWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        unavailable()
    }
}

fn unavailable<T>() -> Result<T, ApplicationError> {
    Err(ApplicationError::capability_unavailable(
        "workflow execution is not configured",
    ))
}

fn principal_json(principal: &Principal) -> serde_json::Value {
    principal.evidence()
}

fn map_error(error: workflows::WorkflowError) -> ApplicationError {
    match error {
        workflows::WorkflowError::Validation(message) => ApplicationError::bad_request(message),
        workflows::WorkflowError::NotFound(message) => ApplicationError::not_found(message),
        workflows::WorkflowError::Conflict(message) => ApplicationError::conflict(message),
        other => ApplicationError::internal(other.to_string()),
    }
}
