use std::sync::Arc;

use agents::{
    AgentElicitationResponse, AgentId, AgentPermissionResponse, AgentSessionConfigOverride,
};
use async_trait::async_trait;
use conversations::{
    CancelConversationInput, ConversationContext, ConversationInputControl,
    ConversationInputControlError, ConversationInputSubmission, ConversationInputView,
    ConversationRelationControl, ConversationRelationView, ConversationServiceError,
    ConversationSessionService, ConversationStartTurnInput, ConversationSteerInput,
    ConversationSteeringReceipt, ConversationTurnSnapshot, ReorderConversationInput,
    SubmitConversationInput, UpdateConversationInput,
};
use executors::profile::ExecutorProfileId;

use crate::{
    ApplicationError, CancelConversationTurn, CompanionSessionPort, ConversationExecutionPort,
    ConversationLiveFeedbackNote, RespondConversationPermission, RespondConversationQuestion,
    StartConversationTurn, SubmitConversationFeedback,
};

pub struct ConversationSessionExecutionPort {
    service: ConversationSessionService,
    inputs: ConversationInputControl,
    relations: ConversationRelationControl,
    companion: Option<Arc<dyn CompanionSessionPort>>,
}

impl ConversationSessionExecutionPort {
    pub fn new(context: ConversationContext) -> Self {
        Self::with_companion(context, None)
    }

    pub fn with_companion(
        context: ConversationContext,
        companion: Option<Arc<dyn CompanionSessionPort>>,
    ) -> Self {
        let inputs = ConversationInputControl::with_publisher(
            context.deployment.db().pool.clone(),
            context.event_publisher.clone(),
        );
        Self {
            relations: ConversationRelationControl::new(context.deployment.db().pool.clone()),
            service: ConversationSessionService::new(context),
            inputs,
            companion,
        }
    }

    pub async fn dispatch_next_queued_input(
        &self,
        conversation_id: uuid::Uuid,
    ) -> Result<Option<ConversationTurnSnapshot>, ApplicationError> {
        self.service
            .dispatch_next_queued_input(conversation_id)
            .await
            .map_err(map_service_error)
    }
}

#[async_trait]
impl ConversationExecutionPort for ConversationSessionExecutionPort {
    async fn start_turn(
        &self,
        request: StartConversationTurn,
    ) -> Result<ConversationTurnSnapshot, ApplicationError> {
        let agent_id = AgentId::parse(&request.agent_id)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let executor_profile_id = request
            .executor_profile_id
            .map(serde_json::from_value::<ExecutorProfileId>)
            .transpose()
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let config_overrides = request
            .config_overrides
            .into_iter()
            .map(serde_json::from_value::<AgentSessionConfigOverride>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let conversation_id = request.conversation_id;
        let turn = self
            .service
            .start_turn(ConversationStartTurnInput {
                agent_id,
                workspace_id: request.workspace_id,
                conversation_id,
                executor_profile_id,
                text: request.text,
                display_text: None,
                images: request.images,
                mode_override: request.mode_override,
                config_overrides,
                workflow_refs: request
                    .workflow_refs
                    .into_iter()
                    .map(|invocation| agents::ConversationWorkflowRef {
                        plugin_id: invocation.plugin_id,
                        workflow_id: invocation.workflow_id,
                    })
                    .collect(),
                file_refs: Vec::new(),
                queued_input_claim: None,
                operation_id: request.operation_id,
            })
            .await
            .map(|(turn, _)| turn)
            .map_err(map_service_error)?;
        if let Some(companion) = &self.companion {
            companion.clear_turn(conversation_id).await;
        }
        Ok(turn)
    }

    async fn respond_permission(
        &self,
        request: RespondConversationPermission,
    ) -> Result<(), ApplicationError> {
        let response = serde_json::from_value::<AgentPermissionResponse>(request.response)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        self.service
            .respond_permission(request.conversation_id, request.permission_id, response)
            .await
            .map_err(map_service_error)
    }

    async fn respond_question(
        &self,
        request: RespondConversationQuestion,
    ) -> Result<(), ApplicationError> {
        let response = serde_json::from_value::<AgentElicitationResponse>(request.response)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        if let Some(companion) = &self.companion
            && companion
                .answer_question(
                    request.conversation_id,
                    &request.question_id,
                    response.clone(),
                )
                .await?
        {
            return Ok(());
        }
        self.service
            .respond_question(request.conversation_id, request.question_id, response)
            .await
            .map_err(map_service_error)
    }

    async fn cancel_turn(&self, request: CancelConversationTurn) -> Result<(), ApplicationError> {
        self.service
            .cancel_turn(request.conversation_id, request.reason)
            .await
            .map_err(map_service_error)
    }

    async fn steer(
        &self,
        request: ConversationSteerInput,
    ) -> Result<ConversationSteeringReceipt, ApplicationError> {
        self.service.steer(request).await.map_err(map_service_error)
    }

    async fn submit_input(
        &self,
        request: SubmitConversationInput,
    ) -> Result<ConversationInputSubmission, ApplicationError> {
        let conversation_id = request.conversation_id;
        let submitted = self.inputs.submit(request).await.map_err(map_input_error)?;
        let dispatched = match self.dispatch_next_queued_input(conversation_id).await {
            Ok(turn) => turn,
            Err(error) => {
                tracing::warn!(
                    %conversation_id,
                    input_id = %submitted.id,
                    %error,
                    "durable conversation input was accepted; dispatch will retry later"
                );
                None
            }
        };
        let input = self
            .inputs
            .find(conversation_id, submitted.id)
            .await
            .map_err(map_input_error)?;
        let turn = match (dispatched, input.turn_id) {
            (Some(turn), _) => Some(turn),
            (None, Some(turn_id)) => self
                .service
                .turn_snapshot(turn_id)
                .await
                .map_err(map_service_error)?,
            (None, None) => None,
        };
        Ok(ConversationInputSubmission { input, turn })
    }

    async fn list_inputs(
        &self,
        conversation_id: uuid::Uuid,
    ) -> Result<Vec<ConversationInputView>, ApplicationError> {
        if let Err(error) = self.inputs.recover_stale_claims(chrono::Utc::now()).await {
            tracing::warn!(%conversation_id, %error, "failed to release expired input claims");
        }
        self.inputs
            .list(conversation_id)
            .await
            .map_err(map_input_error)
    }

    async fn list_relations(
        &self,
        conversation_id: uuid::Uuid,
    ) -> Result<Vec<ConversationRelationView>, ApplicationError> {
        self.relations
            .list_children(conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn update_input(
        &self,
        request: UpdateConversationInput,
    ) -> Result<ConversationInputView, ApplicationError> {
        let conversation_id = request.conversation_id;
        let updated = self.inputs.update(request).await.map_err(map_input_error)?;
        if let Err(error) = self.dispatch_next_queued_input(conversation_id).await {
            tracing::warn!(
                %conversation_id,
                input_id = %updated.id,
                %error,
                "updated conversation input remains queued; dispatch will retry later"
            );
        }
        self.inputs
            .find(conversation_id, updated.id)
            .await
            .map_err(map_input_error)
    }

    async fn reorder_input(
        &self,
        request: ReorderConversationInput,
    ) -> Result<ConversationInputView, ApplicationError> {
        self.inputs.reorder(request).await.map_err(map_input_error)
    }

    async fn cancel_input(
        &self,
        request: CancelConversationInput,
    ) -> Result<ConversationInputView, ApplicationError> {
        self.inputs.cancel(request).await.map_err(map_input_error)
    }

    async fn set_session_mode(
        &self,
        conversation_id: uuid::Uuid,
        mode_id: String,
    ) -> Result<(), ApplicationError> {
        self.service
            .set_session_mode(conversation_id, mode_id)
            .await
            .map_err(map_service_error)
    }

    async fn set_session_config_option(
        &self,
        conversation_id: uuid::Uuid,
        key: String,
        value: serde_json::Value,
    ) -> Result<(), ApplicationError> {
        self.service
            .set_session_config_option(conversation_id, key, value)
            .await
            .map_err(map_service_error)
    }

    async fn submit_feedback(
        &self,
        request: SubmitConversationFeedback,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        let Some(companion) = &self.companion else {
            return Err(ApplicationError::capability_unavailable(
                "live feedback is not configured",
            ));
        };
        companion
            .submit_feedback(request.conversation_id, &request.text)
            .await
    }

    async fn list_feedback(
        &self,
        conversation_id: uuid::Uuid,
    ) -> Result<Vec<ConversationLiveFeedbackNote>, ApplicationError> {
        let Some(companion) = &self.companion else {
            return Ok(Vec::new());
        };
        companion.list_feedback(conversation_id).await
    }
}

fn map_service_error(error: ConversationServiceError) -> ApplicationError {
    match error {
        ConversationServiceError::NotFound(message) => ApplicationError::not_found(message),
        ConversationServiceError::BadRequest(message) => ApplicationError::bad_request(message),
        ConversationServiceError::Conflict(message) => ApplicationError::conflict(message),
        ConversationServiceError::Internal(message) => ApplicationError::internal(message),
        ConversationServiceError::AuthenticationRequired(message) => {
            ApplicationError::bad_request(message)
        }
        ConversationServiceError::SessionUnavailable { message, .. } => {
            ApplicationError::bad_request(message)
        }
    }
}

fn map_input_error(error: ConversationInputControlError) -> ApplicationError {
    match error {
        ConversationInputControlError::NotFound(_) => {
            ApplicationError::not_found(error.to_string())
        }
        ConversationInputControlError::EmptyInput
        | ConversationInputControlError::InputTooLarge { .. } => {
            ApplicationError::bad_request(error.to_string())
        }
        ConversationInputControlError::OperationConflict { .. }
        | ConversationInputControlError::StateConflict { .. }
        | ConversationInputControlError::RevisionOverflow => {
            ApplicationError::conflict(error.to_string())
        }
        ConversationInputControlError::InvalidStatus(_)
        | ConversationInputControlError::Serialization(_)
        | ConversationInputControlError::Database(_) => {
            ApplicationError::internal(error.to_string())
        }
    }
}
