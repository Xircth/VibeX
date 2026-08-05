use agents::{
    AgentElicitationResponse, AgentId, AgentPermissionResponse, AgentSessionConfigOverride,
};
use async_trait::async_trait;
use conversations::{
    ConversationContext, ConversationServiceError, ConversationSessionService,
    ConversationStartTurnInput, ConversationTurnSnapshot,
};
use executors::profile::ExecutorProfileId;

use crate::{
    ApplicationError, CancelConversationTurn, ConversationExecutionPort,
    RespondConversationPermission, RespondConversationQuestion, StartConversationTurn,
};

pub struct ConversationSessionExecutionPort {
    service: ConversationSessionService,
}

impl ConversationSessionExecutionPort {
    pub fn new(context: ConversationContext) -> Self {
        Self {
            service: ConversationSessionService::new(context),
        }
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
        self.service
            .start_turn(ConversationStartTurnInput {
                agent_id,
                workspace_id: request.workspace_id,
                conversation_id: request.conversation_id,
                executor_profile_id,
                text: request.text,
                images: request.images,
                mode_override: request.mode_override,
                config_overrides,
                plugin_actions: request
                    .plugin_actions
                    .into_iter()
                    .map(|invocation| agents::ConversationPluginActionInvocation {
                        plugin_id: invocation.plugin_id,
                        action_id: invocation.action_id,
                    })
                    .collect(),
            })
            .await
            .map(|(turn, _)| turn)
            .map_err(map_service_error)
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
}

fn map_service_error(error: ConversationServiceError) -> ApplicationError {
    match error {
        ConversationServiceError::NotFound(message) => ApplicationError::not_found(message),
        ConversationServiceError::BadRequest(message) => ApplicationError::bad_request(message),
        ConversationServiceError::Conflict(message) => ApplicationError::conflict(message),
        ConversationServiceError::Internal(message) => ApplicationError::internal(message),
    }
}
