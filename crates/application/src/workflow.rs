use agents::{AgentId, ConversationInputPayload};
use async_trait::async_trait;
use chrono::Duration;
use conversations::{
    ConversationContext, CreateWorkflowConversation, SubmitConversationInput,
    create_workflow_conversation,
};
use db::models::{
    conversation::{ConversationRecord, CreateConversationRecord},
    conversation_input::ConversationInputRecord,
    conversation_side_effects::ConversationFileChangeRecord,
    conversation_turn::ConversationTurnRecord,
    task::{CreateTask, Task, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use uuid::Uuid;
use workflows::{
    AcceptWorkflowStepCandidate, CompleteWorkflowStep, CompletionPolicy, DebugRunScope,
    DecideApproval, ForkWorkflowRun, PauseWorkflowRun, PublishWorkflow, ResumePausedWorkflowRun,
    ReviewWorkflow, StageWorkflowStepCandidate, StartWorkflow, WorkflowCore, WorkflowDefinition,
    WorkflowDefinitionSummary, WorkflowEventRecord, WorkflowPolicy, WorkflowReviewDecision,
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
    pub source_path: Option<String>,
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
    pub debug_step_id: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugWorkflowRequest {
    pub definition_id: Option<Uuid>,
    pub definition: WorkflowDefinition,
    pub source_path: Option<String>,
    pub workspace_id: Option<Uuid>,
    pub input: serde_json::Value,
    pub policy_override: Option<WorkflowPolicy>,
    pub step_id: String,
    pub parent_run_id: Option<Uuid>,
    #[serde(default)]
    pub scope: DebugRunScope,
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

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseWorkflowRequest {
    pub run_id: Uuid,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePausedWorkflowRequest {
    pub run_id: Uuid,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptWorkflowCandidateRequest {
    pub run_id: Uuid,
    pub step_id: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseWorkflowStepRequest {
    pub run_id: Uuid,
    pub step_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitWorkflowStepInputRequest {
    pub run_id: Uuid,
    pub step_id: String,
    pub text: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkWorkflowRequest {
    pub parent_run_id: Uuid,
    pub definition_version_id: Uuid,
    pub step_id: String,
    pub scope: DebugRunScope,
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
    async fn debug(
        &self,
        _principal: &Principal,
        _operation_id: Uuid,
        _request: DebugWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow debug Runs are not configured",
        ))
    }
    async fn show(&self, run_id: Uuid) -> Result<WorkflowRunView, ApplicationError>;
    async fn version(&self, version_id: Uuid) -> Result<WorkflowVersionView, ApplicationError>;
    async fn definitions(
        &self,
        limit: u32,
    ) -> Result<Vec<WorkflowDefinitionSummary>, ApplicationError>;
    async fn versions(
        &self,
        definition_id: Uuid,
        limit: u32,
    ) -> Result<Vec<WorkflowVersionView>, ApplicationError>;
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
    async fn pause_run(
        &self,
        _principal: &Principal,
        _operation_id: Uuid,
        _request: PauseWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow pause is not configured",
        ))
    }
    async fn resume_paused_run(
        &self,
        _principal: &Principal,
        _operation_id: Uuid,
        _request: ResumePausedWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow pause is not configured",
        ))
    }
    async fn accept_candidate(
        &self,
        _principal: &Principal,
        _operation_id: Uuid,
        _request: AcceptWorkflowCandidateRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow candidate acceptance is not configured",
        ))
    }
    async fn pause_step(
        &self,
        _request: PauseWorkflowStepRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow step interaction is not configured",
        ))
    }
    async fn submit_step_input(
        &self,
        _operation_id: Uuid,
        _request: SubmitWorkflowStepInputRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow step interaction is not configured",
        ))
    }
    async fn fork_from_step(
        &self,
        _principal: &Principal,
        _operation_id: Uuid,
        _request: ForkWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workflow debug Runs are not configured",
        ))
    }
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
        let prompt = render_agent_prompt(
            &agent.prompt,
            &resolved_input.values,
            agent.output_schema.as_ref(),
            agent.output_description.as_deref(),
            agent.output_language.as_deref(),
        )?;
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
                    executor_profile_id: agent.executor_profile_id.clone(),
                    text: prompt,
                    display_text: None,
                    images: Vec::new(),
                    mode_override: agent.mode_override.clone(),
                    config_overrides: agent
                        .config_overrides
                        .iter()
                        .map(|(key, value)| agents::AgentSessionConfigOverride {
                            key: key.clone(),
                            value: value.clone(),
                        })
                        .collect(),
                    plugin_actions: Vec::new(),
                    file_refs: Vec::new(),
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
        let rows = sqlx::query_as::<_, (Uuid, Uuid, String, Uuid, Uuid, Option<Uuid>, bool)>(
            "SELECT id, run_id, step_id, conversation_id, turn_id, workspace_id,
                    user_intervened
             FROM workflow_step_runs
             WHERE status = 'running' AND awaiting_input = 0
               AND conversation_id IS NOT NULL AND turn_id IS NOT NULL
             ORDER BY updated_at LIMIT 32",
        )
        .fetch_all(&self.context.deployment.db().pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let mut changed = false;
        for (
            _step_run_id,
            run_id,
            step_id,
            conversation_id,
            turn_id,
            _step_workspace_id,
            user_intervened,
        ) in rows
        {
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
                        WorkflowStepSpec::Agent(_) => Some(serde_json::Value::String(
                            extract_last_assistant_text(
                                &self.context.deployment.db().pool,
                                conversation_id,
                                turn_id,
                            )
                            .await?,
                        )),
                        WorkflowStepSpec::Approval(_) | WorkflowStepSpec::Notify(_) => None,
                    };
                    let completion = match &step.spec {
                        WorkflowStepSpec::Agent(agent)
                            if agent.completion_policy == CompletionPolicy::Manual
                                || user_intervened =>
                        {
                            self.core
                                .stage_step_candidate(StageWorkflowStepCandidate {
                                    run_id,
                                    step_id: step_id.clone(),
                                    output,
                                })
                                .await
                        }
                        WorkflowStepSpec::Agent(_) => {
                            self.core
                                .complete_step(CompleteWorkflowStep {
                                    run_id,
                                    step_id: step_id.clone(),
                                    output,
                                })
                                .await
                        }
                        WorkflowStepSpec::Approval(_) | WorkflowStepSpec::Notify(_) => {
                            Err(workflows::WorkflowError::Conflict(
                                "dispatcher cannot complete approval or notify steps".to_string(),
                            ))
                        }
                    };
                    match completion {
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
    output_schema: Option<&serde_json::Value>,
    output_description: Option<&str>,
    output_language: Option<&str>,
) -> Result<String, ApplicationError> {
    let mut sections = Vec::new();
    if !input.is_empty() {
        let bindings = serde_json::to_string_pretty(input)
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        sections.push(format!(
            "The following values are the accepted final outputs of prerequisite Workflow Steps. Each key is the stable predecessor Step ID. Review the referenced artifacts, evidence, and conclusions, preserve their original meaning, and continue this Turn from that completed work.\n{bindings}"
        ));
    }
    sections.push(format!("Task for this Turn:\n{}", prompt.trim()));
    let brief = output_description
        .map(str::trim)
        .filter(|description| !description.is_empty());
    if let Some(description) = brief {
        sections.push(format!("Return this Turn's final result as: {description}"));
    } else if let Some(schema) = output_schema {
        let schema = serde_json::to_string_pretty(schema)
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        sections.push(format!(
            "Return this Turn's final result as JSON shaped like the following example. Output the JSON itself only: no Markdown code fences, commentary, or surrounding quotes. This is an output convention, not a request to discuss the schema.\n{schema}"
        ));
    }
    if let Some(language) = output_language.filter(|language| !language.trim().is_empty()) {
        let mut language_line = format!(
            "Use `{}` for natural-language content in the result.",
            language.trim()
        );
        if brief.is_none() && output_schema.is_some() {
            language_line.push_str(" Preserve JSON keys required by the example.");
        }
        sections.push(language_line);
    }
    Ok(sections.join("\n\n"))
}

pub(crate) async fn extract_last_assistant_text(
    pool: &sqlx::SqlitePool,
    conversation_id: Uuid,
    turn_id: Uuid,
) -> Result<String, ApplicationError> {
    let events = sqlx::query_as::<_, (i64, String, String)>(
        "SELECT sequence, event_kind, normalized_json
         FROM conversation_events
         WHERE conversation_id = ? AND turn_id = ?
         ORDER BY sequence",
    )
    .bind(conversation_id)
    .bind(turn_id)
    .fetch_all(pool)
    .await
    .map_err(|error| ApplicationError::internal(error.to_string()))?;
    final_assistant_text(&events)
        .ok_or_else(|| ApplicationError::bad_request("Agent produced no final text output"))
}

fn final_assistant_text(events: &[(i64, String, String)]) -> Option<String> {
    // Codex may emit user-visible progress before tools. A Turn's deliverable is
    // the assistant text after its last reasoning/tool/plan activity boundary,
    // not the concatenation of every progress message in the Turn.
    let boundary = events
        .iter()
        .filter(|(_, kind, _)| {
            matches!(
                kind.as_str(),
                "assistant_reasoning_delta" | "tool_call_upsert" | "plan_updated"
            )
        })
        .map(|(sequence, _, _)| *sequence)
        .max()
        .unwrap_or(i64::MIN);
    let text = events
        .iter()
        .filter(|(sequence, kind, _)| *sequence > boundary && kind == "assistant_text_delta")
        .filter_map(|(_, _, normalized)| {
            serde_json::from_str::<serde_json::Value>(normalized)
                .ok()?
                .get("text")?
                .as_str()
                .map(str::to_owned)
        })
        .collect::<String>();
    (!text.trim().is_empty()).then(|| text.trim().to_owned())
}

async fn wait_for_dispatched_input_turn(
    pool: &sqlx::SqlitePool,
    input_id: Uuid,
) -> Result<Uuid, ApplicationError> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let input = ConversationInputRecord::find_by_id(pool, input_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| ApplicationError::internal("workflow step input disappeared"))?;
        if let Some(turn_id) = input.turn_id {
            return Ok(turn_id);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(ApplicationError::internal(
                "workflow step input did not dispatch within five seconds",
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
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

    async fn submit_step_follow_up(
        &self,
        operation_id: Uuid,
        request: &SubmitWorkflowStepInputRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        if request.text.trim().is_empty() {
            return Err(ApplicationError::bad_request(
                "workflow step input cannot be empty",
            ));
        }
        let context = self.conversation_context.as_ref().ok_or_else(|| {
            ApplicationError::capability_unavailable(
                "workflow step Conversations are not configured",
            )
        })?;
        let run = self.store.run(request.run_id).await.map_err(map_error)?;
        let definition = self
            .store
            .version(run.definition_version_id)
            .await
            .map_err(map_error)?
            .definition()
            .map_err(map_error)?;
        let definition_step = definition
            .steps
            .iter()
            .find(|step| step.id == request.step_id)
            .ok_or_else(|| ApplicationError::not_found("workflow step not found"))?;
        let WorkflowStepSpec::Agent(agent) = &definition_step.spec else {
            return Err(ApplicationError::bad_request(
                "approval steps do not have Agent Conversations",
            ));
        };
        let step = self
            .store
            .steps(request.run_id)
            .await
            .map_err(map_error)?
            .into_iter()
            .filter(|step| step.step_id == request.step_id)
            .max_by_key(|step| step.attempt)
            .ok_or_else(|| ApplicationError::not_found("workflow step run not found"))?;
        if !step.awaiting_input {
            return Err(ApplicationError::bad_request(
                "workflow step is not awaiting input",
            ));
        }
        let conversation_id = step
            .conversation_id
            .ok_or_else(|| ApplicationError::internal("workflow step has no child Conversation"))?;
        let workspace_id = step.workspace_id.unwrap_or(run.workspace_id);
        let agent_id = AgentId::parse(&agent.agent_id)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let resolved_input_json = step
            .resolved_input_json
            .as_deref()
            .ok_or_else(|| ApplicationError::internal("workflow step has no resolved input"))?;
        let resolved_input: std::collections::BTreeMap<String, serde_json::Value> =
            serde_json::from_str(resolved_input_json).map_err(|error| {
                ApplicationError::internal(format!(
                    "workflow step resolved input is invalid: {error}"
                ))
            })?;
        let recovery_context = render_agent_prompt(
            &agent.prompt,
            &resolved_input,
            agent.output_schema.as_ref(),
            agent.output_description.as_deref(),
            agent.output_language.as_deref(),
        )?;
        let follow_up_prompt = format!(
            "{recovery_context}\n\nAdditional user guidance for this continuing Turn:\n{}",
            request.text.trim()
        );
        let submission = ConversationSessionExecutionPort::new(context.clone())
            .submit_input(SubmitConversationInput {
                conversation_id,
                operation_id,
                payload: ConversationInputPayload {
                    agent_id,
                    workspace_id,
                    executor_profile_id: agent.executor_profile_id.clone(),
                    text: follow_up_prompt,
                    display_text: None,
                    images: Vec::new(),
                    mode_override: agent.mode_override.clone(),
                    config_overrides: agent
                        .config_overrides
                        .iter()
                        .map(|(key, value)| agents::AgentSessionConfigOverride {
                            key: key.clone(),
                            value: value.clone(),
                        })
                        .collect(),
                    plugin_actions: Vec::new(),
                    file_refs: Vec::new(),
                },
                principal: serde_json::json!({
                    "id": "workflow-step-interaction",
                    "workflowRunId": request.run_id,
                    "workflowStepId": request.step_id,
                }),
            })
            .await?;
        let turn_id = if let Some(turn) = submission.turn {
            turn.turn_id
        } else {
            wait_for_dispatched_input_turn(&self.pool, submission.input.id).await?
        };
        self.store
            .bind_turn(request.run_id, &request.step_id, conversation_id, turn_id)
            .await
            .map_err(map_error)?;
        self.store
            .set_step_awaiting_input(request.run_id, &request.step_id, false, None, Some(turn_id))
            .await
            .map_err(map_error)
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
                source_path: request.source_path,
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
                debug_step_id: request.debug_step_id,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)?;
        self.ensure_run_shell_and_dispatch(&run).await?;
        Ok(run)
    }

    async fn debug(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: DebugWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        let version = self
            .core
            .materialize_debug(PublishWorkflow {
                definition_id: request.definition_id,
                definition: request.definition,
                source_path: request.source_path,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)?;
        let run = if let Some(parent_run_id) = request.parent_run_id {
            self.core
                .fork_from_step(ForkWorkflowRun {
                    parent_run_id,
                    definition_version_id: version.id,
                    step_id: request.step_id,
                    scope: request.scope,
                    operation_id,
                    principal: principal_json(principal),
                })
                .await
                .map_err(map_error)?
        } else {
            let workspace_id = request.workspace_id.ok_or_else(|| {
                ApplicationError::bad_request(
                    "workspaceId is required for the first Workflow debug Run",
                )
            })?;
            self.core
                .start(StartWorkflow {
                    definition_version_id: version.id,
                    workspace_id,
                    input: request.input,
                    policy_override: request.policy_override,
                    debug_step_id: Some(request.step_id),
                    operation_id,
                    principal: principal_json(principal),
                })
                .await
                .map_err(map_error)?
        };
        self.ensure_run_shell_and_dispatch(&run).await?;
        Ok(run)
    }

    async fn show(&self, run_id: Uuid) -> Result<WorkflowRunView, ApplicationError> {
        self.store.run(run_id).await.map_err(map_error)
    }

    async fn version(&self, version_id: Uuid) -> Result<WorkflowVersionView, ApplicationError> {
        self.store.version(version_id).await.map_err(map_error)
    }

    async fn definitions(
        &self,
        limit: u32,
    ) -> Result<Vec<WorkflowDefinitionSummary>, ApplicationError> {
        self.core.definitions(limit).await.map_err(map_error)
    }

    async fn versions(
        &self,
        definition_id: Uuid,
        limit: u32,
    ) -> Result<Vec<WorkflowVersionView>, ApplicationError> {
        self.core
            .versions(definition_id, limit)
            .await
            .map_err(map_error)
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

    async fn pause_run(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: PauseWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        let pausing = self
            .core
            .request_pause(PauseWorkflowRun {
                run_id: request.run_id,
                reason: request.reason.clone(),
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)?;
        if pausing.control_state == "paused" {
            return Ok(pausing);
        }
        let steps = self.store.steps(request.run_id).await.map_err(map_error)?;
        let service = self
            .conversation_context
            .as_ref()
            .map(|context| conversations::ConversationSessionService::new(context.clone()));
        for step in steps.into_iter().filter(|step| step.status == "running") {
            if let Some(conversation_id) = step.conversation_id {
                self.store
                    .set_step_awaiting_input(
                        request.run_id,
                        &step.step_id,
                        true,
                        request.reason.as_deref(),
                        None,
                    )
                    .await
                    .map_err(map_error)?;
                if let Some(service) = &service {
                    service
                        .cancel_turn(conversation_id, Some("Workflow run paused".to_string()))
                        .await
                        .map_err(|error| ApplicationError::internal(error.to_string()))?;
                }
            }
        }
        self.core
            .mark_paused(request.run_id)
            .await
            .map_err(map_error)
    }

    async fn resume_paused_run(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ResumePausedWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        self.core
            .resume_paused(ResumePausedWorkflowRun {
                run_id: request.run_id,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)?;
        let awaiting = self
            .store
            .steps(request.run_id)
            .await
            .map_err(map_error)?
            .into_iter()
            .filter(|step| step.awaiting_input)
            .collect::<Vec<_>>();
        for step in awaiting {
            self.submit_step_follow_up(
                Uuid::new_v4(),
                &SubmitWorkflowStepInputRequest {
                    run_id: request.run_id,
                    step_id: step.step_id,
                    text: "Continue this workflow step from the paused state.".to_string(),
                },
            )
            .await?;
        }
        self.store.run(request.run_id).await.map_err(map_error)
    }

    async fn accept_candidate(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: AcceptWorkflowCandidateRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        self.core
            .accept_step_candidate(AcceptWorkflowStepCandidate {
                run_id: request.run_id,
                step_id: request.step_id,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)
    }

    async fn pause_step(
        &self,
        request: PauseWorkflowStepRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        let step = self
            .store
            .steps(request.run_id)
            .await
            .map_err(map_error)?
            .into_iter()
            .filter(|step| step.step_id == request.step_id)
            .max_by_key(|step| step.attempt)
            .ok_or_else(|| ApplicationError::not_found("workflow step run not found"))?;
        let conversation_id = step.conversation_id.ok_or_else(|| {
            ApplicationError::bad_request("workflow step has no active Conversation")
        })?;
        // Cancellation shares the Conversation start/stop lock. Do it before
        // clearing the Workflow Turn binding so a Pause racing the initial Agent
        // startup cannot be overwritten by the dispatcher's later bind_turn.
        if let Some(context) = &self.conversation_context {
            let _ = conversations::ConversationSessionService::new(context.clone())
                .cancel_turn(
                    conversation_id,
                    Some("Workflow step paused for input".to_string()),
                )
                .await;
        }
        self.store
            .set_step_awaiting_input(
                request.run_id,
                &request.step_id,
                true,
                request.reason.as_deref(),
                None,
            )
            .await
            .map_err(map_error)
    }

    async fn submit_step_input(
        &self,
        operation_id: Uuid,
        request: SubmitWorkflowStepInputRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        self.submit_step_follow_up(operation_id, &request).await
    }

    async fn fork_from_step(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ForkWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        let run = self
            .core
            .fork_from_step(ForkWorkflowRun {
                parent_run_id: request.parent_run_id,
                definition_version_id: request.definition_version_id,
                step_id: request.step_id,
                scope: request.scope,
                operation_id,
                principal: principal_json(principal),
            })
            .await
            .map_err(map_error)?;
        self.ensure_run_shell_and_dispatch(&run).await?;
        Ok(run)
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
    async fn definitions(
        &self,
        _: u32,
    ) -> Result<Vec<WorkflowDefinitionSummary>, ApplicationError> {
        unavailable()
    }
    async fn versions(
        &self,
        _: Uuid,
        _: u32,
    ) -> Result<Vec<WorkflowVersionView>, ApplicationError> {
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{final_assistant_text, render_agent_prompt};

    #[test]
    fn agent_prompt_exposes_bound_input_and_the_exact_output_contract() {
        let input = BTreeMap::from([("brief".to_owned(), serde_json::json!({"id": 7}))]);
        let schema = serde_json::json!({
            "type": "object",
            "required": ["summary"],
            "properties": {"summary": {"type": "string"}}
        });

        let rendered =
            render_agent_prompt("Synthesize", &input, Some(&schema), None, Some("zh-CN")).unwrap();

        assert!(rendered.contains("accepted final outputs of prerequisite Workflow Steps"));
        assert!(rendered.contains("stable predecessor Step ID"));
        assert!(rendered.contains("Output the JSON itself only"));
        assert!(rendered.contains("\"summary\""));
        assert!(rendered.contains("`zh-CN`"));
        assert!(!rendered.contains("```"));
    }

    #[test]
    fn agent_prompt_uses_natural_language_description_without_a_schema() {
        let input = BTreeMap::new();
        let rendered = render_agent_prompt(
            "Summarize",
            &input,
            None,
            Some("a one-paragraph brief"),
            None,
        )
        .unwrap();

        assert!(rendered.contains("Return this Turn's final result as: a one-paragraph brief"));
        assert!(!rendered.contains("JSON"));
    }

    #[test]
    fn agent_prompt_prefers_a_brief_description_over_a_leftover_schema() {
        let input = BTreeMap::new();
        let schema = serde_json::json!({
            "type": "object",
            "required": ["summary"],
            "properties": {"summary": {"type": "string"}}
        });
        let rendered = render_agent_prompt(
            "review my code",
            &input,
            Some(&schema),
            Some("用自然语言写一段代码审阅"),
            Some("zh-CN"),
        )
        .unwrap();

        assert!(rendered.contains("Task for this Turn:\nreview my code"));
        assert!(rendered.contains("Return this Turn's final result as: 用自然语言写一段代码审阅"));
        assert!(rendered.contains("Use `zh-CN` for natural-language content in the result."));
        assert!(!rendered.contains("JSON"));
        assert!(!rendered.contains("Preserve JSON keys"));
    }

    #[test]
    fn final_output_excludes_progress_text_before_the_last_activity_boundary() {
        let event = |sequence, kind: &str, text: &str| {
            (
                sequence,
                kind.to_owned(),
                serde_json::json!({"kind": kind, "text": text}).to_string(),
            )
        };
        let events = vec![
            event(1, "assistant_text_delta", "正在检查仓库。"),
            event(2, "tool_call_upsert", ""),
            event(3, "assistant_text_delta", "还需要核对测试。"),
            event(4, "assistant_reasoning_delta", "prepare final"),
            event(5, "assistant_text_delta", "最终"),
            event(6, "assistant_text_delta", "结论"),
            event(7, "usage_updated", ""),
        ];

        assert_eq!(final_assistant_text(&events).as_deref(), Some("最终结论"));
    }
}
