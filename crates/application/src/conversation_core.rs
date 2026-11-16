use std::sync::Arc;

use conversations::{
    CancelConversationInput, ConversationInputSubmission, ConversationInputView,
    ConversationRelationView, ConversationSteerInput, ConversationSteeringReceipt,
    ConversationTurnSnapshot, ReorderConversationInput, SubmitConversationInput,
    UpdateConversationInput,
};
use db::models::conversation::DbConversationSummary;
use remote_protocol::{
    ConversationId, EventDurability, OfflineConversationCache, RemoteEvent, SubscriptionBootstrap,
    SubscriptionId, SubscriptionSnapshot, TerminalNotificationSummary,
};
use uuid::Uuid;

use super::{
    ATTACH_CONVERSATIONS_SCOPE, CANCEL_CONVERSATION_SCOPE, CancelConversationInputRequest,
    CancelConversationTurn, ConversationCatalog, ConversationCatalogWorkspace,
    ConversationExecutionPort, ConversationLiveFeedbackNote, ConversationOutputView,
    ConversationRepository, ConversationSlashCommand, ConversationSubscriptionRegistrar,
    ConversationWorkspaceEntry, CreateChildConversationRequest, CreateConversation,
    CreateConversationWorkspace, DismissConversationFeedback, LIVE_FEEDBACK_SCOPE,
    ListConversationFeedbackRequest, ListConversationInputsRequest,
    ListConversationRelationsRequest, ListConversations, ListRecentConversations, MAX_LIVE_EVENTS,
    NOTIFICATION_SUMMARY_SCOPE, OFFLINE_READ_SCOPE, READ_CONVERSATIONS_SCOPE,
    RESPOND_PERMISSION_SCOPE, RESPOND_QUESTION_SCOPE, ReorderConversationInputRequest,
    RespondConversationPermission, RespondConversationQuestion, STEER_CONVERSATION_SCOPE,
    SalvageConversationFeedback, StartConversationTurn, SteerConversationTurnRequest,
    SubmitConversationFeedback, SubmitConversationInputRequest, UnavailableConversationExecution,
    UpdateConversationInputRequest, WRITE_CONVERSATIONS_SCOPE,
};
use crate::{
    AcceptWorkflowCandidateRequest, ApplicationDomainPort, ApplicationError, CancelWorkflowRequest,
    CompleteWorkflowStepRequest, DebugWorkflowRequest, DecideWorkflowRequest, DomainCommand,
    ForkWorkflowRequest, PauseWorkflowRequest, PauseWorkflowStepRequest, Principal,
    PublishWorkflowRequest, ResumePausedWorkflowRequest, ResumeWorkflowRequest,
    StartWorkflowRequest, SubmitWorkflowStepInputRequest, ValidateWorkflowRequest,
    WorkflowDefinitionSummary, WorkflowEventRecord, WorkflowExecutionPort, WorkflowRunView,
    WorkflowStepView, WorkflowValidationView, WorkflowVersionView, domain::unavailable_domains,
    workflow::UnavailableWorkflowExecution,
};

fn require_workflow_run(principal: &Principal) -> Result<(), ApplicationError> {
    if principal.allows("workflow.run") {
        Ok(())
    } else {
        Err(ApplicationError::forbidden("principal lacks workflow.run"))
    }
}

pub struct ApplicationCore<R> {
    conversations: R,
    execution: Arc<dyn ConversationExecutionPort>,
    domains: Arc<dyn ApplicationDomainPort>,
    workflows: Arc<dyn WorkflowExecutionPort>,
}

impl<R> ApplicationCore<R>
where
    R: ConversationRepository,
{
    pub fn new(conversations: R) -> Self {
        Self {
            conversations,
            execution: Arc::new(UnavailableConversationExecution),
            domains: unavailable_domains(),
            workflows: Arc::new(UnavailableWorkflowExecution),
        }
    }

    pub fn with_execution<E>(conversations: R, execution: Arc<E>) -> Self
    where
        E: ConversationExecutionPort + 'static,
    {
        Self {
            conversations,
            execution,
            domains: unavailable_domains(),
            workflows: Arc::new(UnavailableWorkflowExecution),
        }
    }

    pub fn with_domains<D>(conversations: R, domains: Arc<D>) -> Self
    where
        D: ApplicationDomainPort + 'static,
    {
        Self {
            conversations,
            execution: Arc::new(UnavailableConversationExecution),
            domains,
            workflows: Arc::new(UnavailableWorkflowExecution),
        }
    }

    pub fn with_ports<E, D>(conversations: R, execution: Arc<E>, domains: Arc<D>) -> Self
    where
        E: ConversationExecutionPort + 'static,
        D: ApplicationDomainPort + 'static,
    {
        Self {
            conversations,
            execution,
            domains,
            workflows: Arc::new(UnavailableWorkflowExecution),
        }
    }

    pub fn with_all_ports<E, D, W>(
        conversations: R,
        execution: Arc<E>,
        domains: Arc<D>,
        workflows: Arc<W>,
    ) -> Self
    where
        E: ConversationExecutionPort + 'static,
        D: ApplicationDomainPort + 'static,
        W: WorkflowExecutionPort + 'static,
    {
        Self {
            conversations,
            execution,
            domains,
            workflows,
        }
    }

    pub fn with_execution_and_workflows<E, W>(
        conversations: R,
        execution: Arc<E>,
        workflows: Arc<W>,
    ) -> Self
    where
        E: ConversationExecutionPort + 'static,
        W: WorkflowExecutionPort + 'static,
    {
        Self {
            conversations,
            execution,
            domains: unavailable_domains(),
            workflows,
        }
    }

    pub fn with_workflows<W>(conversations: R, workflows: Arc<W>) -> Self
    where
        W: WorkflowExecutionPort + 'static,
    {
        Self {
            conversations,
            execution: Arc::new(UnavailableConversationExecution),
            domains: unavailable_domains(),
            workflows,
        }
    }

    pub async fn publish_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: PublishWorkflowRequest,
    ) -> Result<WorkflowVersionView, ApplicationError> {
        if !principal.allows("workflow.write") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.write",
            ));
        }
        self.workflows
            .publish(principal, operation_id, request)
            .await
    }

    pub async fn validate_workflow(
        &self,
        principal: &Principal,
        request: ValidateWorkflowRequest,
    ) -> Result<WorkflowValidationView, ApplicationError> {
        if !principal.allows("workflow.write") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.write",
            ));
        }
        self.workflows.validate(request).await
    }

    pub async fn start_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: StartWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.run") {
            return Err(ApplicationError::forbidden("principal lacks workflow.run"));
        }
        self.workflows.start(principal, operation_id, request).await
    }

    pub async fn debug_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: DebugWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.write") || !principal.allows("workflow.run") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.write or workflow.run",
            ));
        }
        self.workflows.debug(principal, operation_id, request).await
    }

    pub async fn show_workflow(
        &self,
        principal: &Principal,
        run_id: Uuid,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.show(run_id).await
    }

    pub async fn workflow_steps(
        &self,
        principal: &Principal,
        run_id: Uuid,
    ) -> Result<Vec<WorkflowStepView>, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.steps(run_id).await
    }

    pub async fn workflow_version(
        &self,
        principal: &Principal,
        version_id: Uuid,
    ) -> Result<WorkflowVersionView, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.version(version_id).await
    }

    pub async fn workflow_definitions(
        &self,
        principal: &Principal,
        limit: u32,
    ) -> Result<Vec<WorkflowDefinitionSummary>, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.definitions(limit).await
    }

    pub async fn delete_workflow_definition(
        &self,
        principal: &Principal,
        definition_id: Uuid,
    ) -> Result<bool, ApplicationError> {
        if !principal.allows("workflow.write") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.write",
            ));
        }
        self.workflows.delete_definition(definition_id).await
    }

    pub async fn workflow_versions(
        &self,
        principal: &Principal,
        definition_id: Uuid,
        limit: u32,
    ) -> Result<Vec<WorkflowVersionView>, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.versions(definition_id, limit).await
    }

    pub async fn workflow_runs(
        &self,
        principal: &Principal,
        definition_id: Uuid,
        limit: u32,
    ) -> Result<Vec<WorkflowRunView>, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.runs(definition_id, limit).await
    }

    pub async fn workflow_events(
        &self,
        principal: &Principal,
        run_id: Uuid,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<WorkflowEventRecord>, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.events(run_id, after_sequence, limit).await
    }

    pub async fn attach_workflow_run(
        &self,
        principal: &Principal,
        subscription_id: SubscriptionId,
        run_id: Uuid,
        after_sequence: i64,
    ) -> Result<SubscriptionBootstrap, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        let run = self.workflows.show(run_id).await?;
        if after_sequence == 0 {
            let steps = self.workflows.steps(run_id).await?;
            return Ok(SubscriptionBootstrap {
                subscription_id,
                ready: true,
                snapshot: Some(SubscriptionSnapshot {
                    through_sequence: run.last_sequence,
                    payload: serde_json::json!({"run": run, "steps": steps}),
                }),
                replay: Vec::new(),
                high_water_mark: run.last_sequence,
                durability: EventDurability::Durable,
            });
        }
        if after_sequence >= run.last_sequence {
            return Ok(SubscriptionBootstrap {
                subscription_id,
                ready: true,
                snapshot: None,
                replay: Vec::new(),
                high_water_mark: run.last_sequence,
                durability: EventDurability::Durable,
            });
        }
        let records = self
            .workflows
            .events(run_id, after_sequence, MAX_LIVE_EVENTS)
            .await?;
        let replay = records
            .into_iter()
            .filter(|event| event.sequence <= run.last_sequence)
            .map(|event| RemoteEvent {
                sequence: event.sequence,
                kind: event.event_kind,
                payload: serde_json::from_str(&event.payload_json)
                    .unwrap_or_else(|_| serde_json::json!({"unparsed": event.payload_json})),
            })
            .collect::<Vec<_>>();
        let high_water_mark = replay
            .last()
            .map(|event| event.sequence)
            .unwrap_or(after_sequence)
            .min(run.last_sequence);
        Ok(SubscriptionBootstrap {
            subscription_id,
            ready: true,
            snapshot: None,
            replay,
            high_water_mark,
            durability: EventDurability::Durable,
        })
    }

    pub async fn complete_workflow_step(
        &self,
        principal: &Principal,
        request: CompleteWorkflowStepRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.internal") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.internal",
            ));
        }
        self.workflows.complete_step(request).await
    }

    pub async fn decide_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: DecideWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.approve") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.approve",
            ));
        }
        self.workflows
            .decide(principal, operation_id, request)
            .await
    }

    pub async fn cancel_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: CancelWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.run") {
            return Err(ApplicationError::forbidden("principal lacks workflow.run"));
        }
        self.workflows.cancel(operation_id, request).await
    }

    pub async fn resume_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ResumeWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.run") {
            return Err(ApplicationError::forbidden("principal lacks workflow.run"));
        }
        self.workflows
            .resume(principal, operation_id, request)
            .await
    }

    pub async fn pause_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: PauseWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .pause_run(principal, operation_id, request)
            .await
    }

    pub async fn resume_paused_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ResumePausedWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .resume_paused_run(principal, operation_id, request)
            .await
    }

    pub async fn accept_workflow_candidate(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: AcceptWorkflowCandidateRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .accept_candidate(principal, operation_id, request)
            .await
    }

    pub async fn pause_workflow_step(
        &self,
        principal: &Principal,
        request: PauseWorkflowStepRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows.pause_step(request).await
    }

    pub async fn submit_workflow_step_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: SubmitWorkflowStepInputRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .submit_step_input(operation_id, request)
            .await
    }

    pub async fn fork_workflow_from_step(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ForkWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .fork_from_step(principal, operation_id, request)
            .await
    }

    pub async fn list_conversations(
        &self,
        principal: &Principal,
        request: ListConversations,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.conversations
            .list_for_workspace(request.workspace_id)
            .await
    }

    pub async fn list_recent_conversations(
        &self,
        principal: &Principal,
        request: ListRecentConversations,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.conversations.list_recent(request).await
    }

    pub async fn conversation_catalog(
        &self,
        principal: &Principal,
    ) -> Result<ConversationCatalog, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.conversations.catalog().await
    }

    pub async fn conversation_workspace_entries(
        &self,
        principal: &Principal,
        workspace_id: Uuid,
    ) -> Result<Vec<ConversationWorkspaceEntry>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.conversations.workspace_entries(workspace_id).await
    }

    pub async fn conversation_slash_commands(
        &self,
        principal: &Principal,
        agent_id: String,
        workspace_id: Option<Uuid>,
        conversation_id: Option<Uuid>,
    ) -> Result<Vec<ConversationSlashCommand>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.conversations
            .slash_commands(agent_id, workspace_id, conversation_id)
            .await
    }

    pub async fn archive_conversation(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.archive(conversation_id).await
    }

    pub async fn set_conversation_pinned(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
        pinned: bool,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.set_pinned(conversation_id, pinned).await
    }

    pub async fn delete_conversation(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.delete(conversation_id).await
    }

    pub async fn rename_conversation(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
        title: String,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.rename(conversation_id, title).await
    }

    pub async fn set_conversation_status(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
        status: String,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.set_status(conversation_id, status).await
    }

    pub async fn set_session_mode(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
        mode_id: String,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .set_session_mode(conversation_id, mode_id)
            .await
    }

    pub async fn set_session_config_option(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
        key: String,
        value: serde_json::Value,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .set_session_config_option(conversation_id, key, value)
            .await
    }

    pub async fn create_conversation_workspace(
        &self,
        principal: &Principal,
        request: CreateConversationWorkspace,
    ) -> Result<ConversationCatalogWorkspace, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.create_workspace(request).await
    }

    pub async fn create_conversation(
        &self,
        principal: &Principal,
        request: CreateConversation,
    ) -> Result<DbConversationSummary, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.create(request).await
    }

    pub async fn create_child_conversation(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: CreateChildConversationRequest,
    ) -> Result<DbConversationSummary, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.create_child(operation_id, request).await
    }

    pub async fn conversation_output(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
    ) -> Result<ConversationOutputView, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.conversations.output(conversation_id).await
    }

    pub async fn start_conversation_turn(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        mut request: StartConversationTurn,
    ) -> Result<ConversationTurnSnapshot, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        request.operation_id = Some(operation_id);
        self.execution.start_turn(request).await
    }

    pub async fn submit_conversation_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: SubmitConversationInputRequest,
    ) -> Result<ConversationInputSubmission, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .submit_input(SubmitConversationInput {
                conversation_id: request.conversation_id,
                operation_id,
                payload: request.payload,
                principal: principal_evidence(principal),
            })
            .await
    }

    pub async fn steer_conversation_turn(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: SteerConversationTurnRequest,
    ) -> Result<ConversationSteeringReceipt, ApplicationError> {
        if !principal.allows(STEER_CONVERSATION_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.steer",
            ));
        }
        self.execution
            .steer(ConversationSteerInput {
                conversation_id: request.conversation_id,
                operation_id,
                expected_turn_id: request.expected_turn_id,
                text: request.text,
                images: request.images,
                principal: principal_evidence(principal),
                promoted_input_id: request.promoted_input_id,
                promoted_input_expected_revision: request.expected_revision,
                allow_interrupt_restart: request.allow_interrupt_restart,
            })
            .await
    }

    pub async fn submit_conversation_feedback(
        &self,
        principal: &Principal,
        request: SubmitConversationFeedback,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        if !principal.allows(LIVE_FEEDBACK_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.steer",
            ));
        }
        self.execution.submit_feedback(request).await
    }

    pub async fn list_conversation_feedback(
        &self,
        principal: &Principal,
        request: ListConversationFeedbackRequest,
    ) -> Result<Vec<ConversationLiveFeedbackNote>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.execution.list_feedback(request.conversation_id).await
    }

    pub async fn salvage_conversation_feedback(
        &self,
        principal: &Principal,
        request: SalvageConversationFeedback,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        if !principal.allows(LIVE_FEEDBACK_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.steer",
            ));
        }
        self.execution
            .salvage_feedback(request.conversation_id, &request.note_id)
            .await
    }

    pub async fn dismiss_conversation_feedback(
        &self,
        principal: &Principal,
        request: DismissConversationFeedback,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        if !principal.allows(LIVE_FEEDBACK_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.steer",
            ));
        }
        self.execution
            .dismiss_feedback(request.conversation_id, &request.note_id)
            .await
    }

    pub async fn list_conversation_inputs(
        &self,
        principal: &Principal,
        request: ListConversationInputsRequest,
    ) -> Result<Vec<ConversationInputView>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.execution.list_inputs(request.conversation_id).await
    }

    pub async fn list_conversation_relations(
        &self,
        principal: &Principal,
        request: ListConversationRelationsRequest,
    ) -> Result<Vec<ConversationRelationView>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.execution.list_relations(request.conversation_id).await
    }

    pub async fn update_conversation_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: UpdateConversationInputRequest,
    ) -> Result<ConversationInputView, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .update_input(UpdateConversationInput {
                conversation_id: request.conversation_id,
                input_id: request.input_id,
                operation_id,
                expected_revision: request.expected_revision,
                payload: request.payload,
                delay_seconds: request.delay_seconds,
            })
            .await
    }

    pub async fn reorder_conversation_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ReorderConversationInputRequest,
    ) -> Result<ConversationInputView, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .reorder_input(ReorderConversationInput {
                conversation_id: request.conversation_id,
                input_id: request.input_id,
                operation_id,
                expected_revision: request.expected_revision,
                sort_key: request.sort_key,
            })
            .await
    }

    pub async fn cancel_conversation_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: CancelConversationInputRequest,
    ) -> Result<ConversationInputView, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .cancel_input(CancelConversationInput {
                conversation_id: request.conversation_id,
                input_id: request.input_id,
                operation_id,
                expected_revision: request.expected_revision,
            })
            .await
    }

    pub async fn respond_conversation_permission(
        &self,
        principal: &Principal,
        request: RespondConversationPermission,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(RESPOND_PERMISSION_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.permission",
            ));
        }
        self.execution.respond_permission(request).await
    }

    pub async fn respond_conversation_question(
        &self,
        principal: &Principal,
        request: RespondConversationQuestion,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(RESPOND_QUESTION_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.question",
            ));
        }
        self.execution.respond_question(request).await
    }

    pub async fn cancel_conversation_turn(
        &self,
        principal: &Principal,
        request: CancelConversationTurn,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(CANCEL_CONVERSATION_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.cancel",
            ));
        }
        self.execution.cancel_turn(request).await
    }

    pub async fn execute_domain(
        &self,
        principal: &Principal,
        command: DomainCommand,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ApplicationError> {
        if !principal.allows(command.required_scope()) {
            return Err(ApplicationError::forbidden(format!(
                "principal lacks {}",
                command.required_scope()
            )));
        }
        self.domains.execute(principal, command, args).await
    }

    pub async fn execute_dynamic_domain(
        &self,
        principal: &Principal,
        command_name: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ApplicationError> {
        if !principal.allows("application.call") {
            return Err(ApplicationError::forbidden(
                "principal lacks application.call",
            ));
        }
        self.domains
            .execute_dynamic(principal, command_name, args)
            .await
    }

    pub async fn offline_conversation_cache(
        &self,
        principal: &Principal,
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> Result<OfflineConversationCache, ApplicationError> {
        if !principal.allows(OFFLINE_READ_SCOPE) {
            return Err(ApplicationError::forbidden("principal lacks offline.read"));
        }
        self.conversations
            .offline_cache(conversation_id, after_sequence)
            .await
    }

    pub async fn terminal_notification_summary(
        &self,
        principal: &Principal,
        conversation_id: ConversationId,
    ) -> Result<TerminalNotificationSummary, ApplicationError> {
        if !principal.allows(NOTIFICATION_SUMMARY_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks notification.summary",
            ));
        }
        self.conversations
            .terminal_notification(conversation_id)
            .await
    }

    pub async fn attach_conversation<S>(
        &self,
        principal: &Principal,
        subscription_id: SubscriptionId,
        conversation_id: ConversationId,
        after_sequence: i64,
        subscriptions: &S,
    ) -> Result<SubscriptionBootstrap, ApplicationError>
    where
        S: ConversationSubscriptionRegistrar + ?Sized,
    {
        if !principal.allows(ATTACH_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.attach",
            ));
        }
        subscriptions
            .register(subscription_id, conversation_id)
            .await?;
        let mut bootstrap = self
            .conversations
            .attach(subscription_id, conversation_id, after_sequence)
            .await?;
        bootstrap.ready = true;
        Ok(bootstrap)
    }
}

fn principal_evidence(principal: &Principal) -> serde_json::Value {
    match principal {
        Principal::LocalDesktop => serde_json::json!({ "kind": "local_desktop" }),
        Principal::Remote {
            subject,
            credential_id,
            device_id,
            ..
        } => serde_json::json!({
            "kind": "remote",
            "subject": subject,
            "credentialId": credential_id,
            "deviceId": device_id,
        }),
    }
}
