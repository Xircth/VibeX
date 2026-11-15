use async_trait::async_trait;
use conversations::{
    CancelConversationInput, ConversationInputSubmission, ConversationInputView,
    ConversationRelationView, ConversationSteerInput, ConversationSteeringReceipt,
    ConversationTurnSnapshot, ReorderConversationInput, SubmitConversationInput,
    UpdateConversationInput,
};
pub use db::SqliteConversationRepository;
use db::models::conversation::DbConversationSummary;
use remote_protocol::{
    ConversationId, OfflineConversationCache, SubscriptionBootstrap, SubscriptionId,
    TerminalNotificationSummary,
};
use uuid::Uuid;

use crate::ApplicationError;

#[path = "conversation_core.rs"]
mod core;
#[path = "conversation_repository.rs"]
mod repository;

pub use core::ApplicationCore;
#[allow(unused_imports)]
pub(crate) use repository::catalog_agent_usable;

pub(super) const READ_CONVERSATIONS_SCOPE: &str = "conversation.read";
pub(super) const WRITE_CONVERSATIONS_SCOPE: &str = "conversation.write";
pub(super) const ATTACH_CONVERSATIONS_SCOPE: &str = "conversation.attach";
pub(super) const RESPOND_PERMISSION_SCOPE: &str = "conversation.permission";
pub(super) const RESPOND_QUESTION_SCOPE: &str = "conversation.question";
pub(super) const CANCEL_CONVERSATION_SCOPE: &str = "conversation.cancel";
pub(super) const STEER_CONVERSATION_SCOPE: &str = "conversation.steer";
pub(super) const LIVE_FEEDBACK_SCOPE: &str = "conversation.steer";
pub(super) const OFFLINE_READ_SCOPE: &str = "offline.read";
pub(super) const NOTIFICATION_SUMMARY_SCOPE: &str = "notification.summary";
pub(super) const MAX_OFFLINE_EVENTS: i64 = 10_000;
pub(super) const MAX_LIVE_EVENTS: i64 = 500;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ListConversations {
    pub workspace_id: Uuid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ListRecentConversations {
    pub since_days: i64,
    pub project_id: Option<Uuid>,
    pub limit: i64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCatalogProject {
    pub id: Uuid,
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCatalogWorkspace {
    pub id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    pub branch: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCatalogAgent {
    pub id: String,
    pub ready: bool,
    #[serde(default)]
    pub usable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authentication: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_svg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_config: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_modes: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_config_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_modes_json: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCatalogTag {
    pub id: String,
    pub name: String,
    pub content: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationWorkspaceEntry {
    pub name: String,
    pub path: String,
    pub directory: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSlashCommand {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub kind: String,
    pub source_kind: String,
    pub source_id: String,
    pub value: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCatalog {
    pub projects: Vec<ConversationCatalogProject>,
    pub workspaces: Vec<ConversationCatalogWorkspace>,
    pub agents: Vec<ConversationCatalogAgent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<ConversationCatalogTag>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateConversation {
    pub workspace_id: Uuid,
    pub agent_id: String,
    pub title: Option<String>,
    pub initial_prompt: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateConversationWorkspace {
    pub project_id: Uuid,
    pub name: String,
    pub branch: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChildConversationRequest {
    pub parent_conversation_id: Uuid,
    pub agent_id: String,
    pub title: Option<String>,
    pub initial_prompt: Option<String>,
    #[serde(default = "default_child_visibility")]
    pub visible: bool,
}

const fn default_child_visibility() -> bool {
    true
}

const fn default_allow_interrupt_restart() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartConversationTurn {
    #[serde(default)]
    pub continuation_policy: Option<agents::conversation::ContinuationPolicy>,
    #[serde(default)]
    pub expected_binding_revision: Option<u64>,
    pub agent_id: String,
    pub workspace_id: Uuid,
    pub conversation_id: Uuid,
    pub executor_profile_id: Option<serde_json::Value>,
    pub text: String,
    #[serde(default)]
    pub display_text: Option<String>,
    pub images: Vec<String>,
    pub mode_override: Option<String>,
    pub config_overrides: Vec<serde_json::Value>,
    #[serde(default, alias = "pluginActions")]
    pub workflow_refs: Vec<crate::ConversationWorkflowRef>,
    #[serde(default)]
    pub internal_prompt_contributions: Vec<agents::InternalPromptBlock>,
    #[serde(default)]
    pub operation_id: Option<uuid::Uuid>,
    #[serde(default)]
    pub provider_instance_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespondConversationPermission {
    pub conversation_id: Uuid,
    pub permission_id: String,
    pub response: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespondConversationQuestion {
    pub conversation_id: Uuid,
    pub question_id: String,
    pub response: serde_json::Value,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelConversationTurn {
    pub conversation_id: Uuid,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteerConversationTurnRequest {
    pub conversation_id: Uuid,
    pub expected_turn_id: Uuid,
    pub text: String,
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default, alias = "promoted_input_id")]
    pub promoted_input_id: Option<Uuid>,
    #[serde(
        default,
        alias = "expected_revision",
        alias = "promotedInputExpectedRevision",
        alias = "promoted_input_expected_revision"
    )]
    pub expected_revision: Option<u64>,
    #[serde(default = "default_allow_interrupt_restart", alias = "allow_interrupt_restart")]
    pub allow_interrupt_restart: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitConversationFeedback {
    pub conversation_id: Uuid,
    pub text: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConversationFeedbackRequest {
    pub conversation_id: Uuid,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalvageConversationFeedback {
    pub conversation_id: Uuid,
    pub note_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DismissConversationFeedback {
    pub conversation_id: Uuid,
    pub note_id: String,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ConversationLiveFeedbackNote {
    pub id: String,
    pub text: String,
    pub created_at: String,
    pub status: String,
    pub delivered_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitConversationInputRequest {
    pub conversation_id: Uuid,
    pub payload: agents::ConversationInputPayload,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConversationInputRequest {
    pub conversation_id: Uuid,
    pub input_id: Uuid,
    pub expected_revision: u64,
    pub payload: agents::ConversationInputPayload,
    #[serde(default)]
    pub delay_seconds: Option<i64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderConversationInputRequest {
    pub conversation_id: Uuid,
    pub input_id: Uuid,
    pub expected_revision: u64,
    pub sort_key: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelConversationInputRequest {
    pub conversation_id: Uuid,
    pub input_id: Uuid,
    pub expected_revision: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConversationInputsRequest {
    pub conversation_id: Uuid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConversationRelationsRequest {
    pub conversation_id: Uuid,
}

#[derive(Clone, Debug, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ConversationOutputView {
    pub conversation_id: Uuid,
    pub turn: Option<ConversationTurnSnapshot>,
    pub assistant_text: Option<String>,
}

#[async_trait]
pub trait ConversationExecutionPort: Send + Sync {
    async fn start_turn(
        &self,
        request: StartConversationTurn,
    ) -> Result<ConversationTurnSnapshot, ApplicationError>;

    async fn respond_permission(
        &self,
        _request: RespondConversationPermission,
    ) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation permission response is not configured",
        ))
    }

    async fn respond_question(
        &self,
        _request: RespondConversationQuestion,
    ) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation question response is not configured",
        ))
    }

    async fn cancel_turn(&self, _request: CancelConversationTurn) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation cancellation is not configured",
        ))
    }

    async fn steer(
        &self,
        _request: ConversationSteerInput,
    ) -> Result<ConversationSteeringReceipt, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation steering is not configured",
        ))
    }

    async fn submit_input(
        &self,
        _request: SubmitConversationInput,
    ) -> Result<ConversationInputSubmission, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input submission is not configured",
        ))
    }

    async fn list_inputs(
        &self,
        _conversation_id: Uuid,
    ) -> Result<Vec<ConversationInputView>, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input listing is not configured",
        ))
    }

    async fn list_relations(
        &self,
        _conversation_id: Uuid,
    ) -> Result<Vec<ConversationRelationView>, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation relation listing is not configured",
        ))
    }

    async fn update_input(
        &self,
        _request: UpdateConversationInput,
    ) -> Result<ConversationInputView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input update is not configured",
        ))
    }

    async fn reorder_input(
        &self,
        _request: ReorderConversationInput,
    ) -> Result<ConversationInputView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input reorder is not configured",
        ))
    }

    async fn cancel_input(
        &self,
        _request: CancelConversationInput,
    ) -> Result<ConversationInputView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input cancellation is not configured",
        ))
    }

    async fn set_session_mode(
        &self,
        _conversation_id: Uuid,
        _mode_id: String,
    ) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "session mode is not configured",
        ))
    }

    async fn set_session_config_option(
        &self,
        _conversation_id: Uuid,
        _key: String,
        _value: serde_json::Value,
    ) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "session config is not configured",
        ))
    }

    async fn submit_feedback(
        &self,
        _request: SubmitConversationFeedback,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "live feedback is not configured",
        ))
    }

    async fn list_feedback(
        &self,
        _conversation_id: Uuid,
    ) -> Result<Vec<ConversationLiveFeedbackNote>, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "live feedback is not configured",
        ))
    }

    async fn salvage_feedback(
        &self,
        _conversation_id: Uuid,
        _note_id: &str,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "live feedback salvage is not configured",
        ))
    }

    async fn dismiss_feedback(
        &self,
        _conversation_id: Uuid,
        _note_id: &str,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "live feedback dismiss is not configured",
        ))
    }
}

#[async_trait]
pub trait CompanionSessionPort: Send + Sync {
    async fn submit_feedback(
        &self,
        conversation_id: Uuid,
        text: &str,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError>;

    async fn list_feedback(
        &self,
        conversation_id: Uuid,
    ) -> Result<Vec<ConversationLiveFeedbackNote>, ApplicationError>;

    async fn salvage_feedback(
        &self,
        conversation_id: Uuid,
        note_id: &str,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        let _ = (conversation_id, note_id);
        Err(ApplicationError::capability_unavailable(
            "live feedback salvage is not configured",
        ))
    }

    async fn dismiss_feedback(
        &self,
        conversation_id: Uuid,
        note_id: &str,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        let _ = (conversation_id, note_id);
        Err(ApplicationError::capability_unavailable(
            "live feedback dismiss is not configured",
        ))
    }

    async fn answer_question(
        &self,
        conversation_id: Uuid,
        question_id: &str,
        response: agents::AgentElicitationResponse,
    ) -> Result<bool, ApplicationError>;

    async fn answer_permission(
        &self,
        conversation_id: Uuid,
        permission_id: &str,
        response: agents::AgentPermissionResponse,
    ) -> Result<bool, ApplicationError> {
        let _ = (conversation_id, permission_id, response);
        Ok(false)
    }

    async fn clear_turn(&self, conversation_id: Uuid);
}

pub(super) struct UnavailableConversationExecution;

#[async_trait]
impl ConversationExecutionPort for UnavailableConversationExecution {
    async fn start_turn(
        &self,
        _request: StartConversationTurn,
    ) -> Result<ConversationTurnSnapshot, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation execution is not configured",
        ))
    }

    async fn respond_permission(
        &self,
        _request: RespondConversationPermission,
    ) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation execution is not configured",
        ))
    }

    async fn respond_question(
        &self,
        _request: RespondConversationQuestion,
    ) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation execution is not configured",
        ))
    }

    async fn cancel_turn(&self, _request: CancelConversationTurn) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation execution is not configured",
        ))
    }
}

#[async_trait]
pub trait ConversationRepository: Send + Sync {
    async fn list_for_workspace(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError>;

    async fn list_recent(
        &self,
        _request: ListRecentConversations,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError> {
        Ok(Vec::new())
    }

    async fn catalog(&self) -> Result<ConversationCatalog, ApplicationError> {
        Ok(ConversationCatalog::default())
    }

    async fn workspace_entries(
        &self,
        _workspace_id: Uuid,
    ) -> Result<Vec<ConversationWorkspaceEntry>, ApplicationError> {
        Ok(Vec::new())
    }

    async fn slash_commands(
        &self,
        _agent_id: String,
        _workspace_id: Option<Uuid>,
        _conversation_id: Option<Uuid>,
    ) -> Result<Vec<ConversationSlashCommand>, ApplicationError> {
        Ok(Vec::new())
    }

    async fn archive(&self, _conversation_id: Uuid) -> Result<(), ApplicationError> {
        Ok(())
    }

    async fn set_pinned(
        &self,
        _conversation_id: Uuid,
        _pinned: bool,
    ) -> Result<(), ApplicationError> {
        Ok(())
    }

    async fn delete(&self, _conversation_id: Uuid) -> Result<(), ApplicationError> {
        Ok(())
    }

    async fn rename(&self, _conversation_id: Uuid, _title: String) -> Result<(), ApplicationError> {
        Ok(())
    }

    async fn set_status(
        &self,
        _conversation_id: Uuid,
        _status: String,
    ) -> Result<(), ApplicationError> {
        Ok(())
    }

    async fn create_workspace(
        &self,
        _request: CreateConversationWorkspace,
    ) -> Result<ConversationCatalogWorkspace, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workspace creation is not configured",
        ))
    }

    async fn create(
        &self,
        request: CreateConversation,
    ) -> Result<DbConversationSummary, ApplicationError>;

    async fn create_child(
        &self,
        _operation_id: Uuid,
        _request: CreateChildConversationRequest,
    ) -> Result<DbConversationSummary, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation child creation is not configured",
        ))
    }

    async fn output(
        &self,
        _conversation_id: Uuid,
    ) -> Result<ConversationOutputView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation output is not configured",
        ))
    }

    async fn attach(
        &self,
        subscription_id: SubscriptionId,
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> Result<SubscriptionBootstrap, ApplicationError>;

    async fn offline_cache(
        &self,
        _conversation_id: ConversationId,
        _after_sequence: i64,
    ) -> Result<OfflineConversationCache, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "offline conversation reads are not configured",
        ))
    }

    async fn terminal_notification(
        &self,
        _conversation_id: ConversationId,
    ) -> Result<TerminalNotificationSummary, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "terminal notification summaries are not configured",
        ))
    }
}

/// Adapter-owned live stream registration. Implementations must make future
/// events observable before returning, so the durable snapshot taken
/// afterwards closes the attach race without depending on a UI runtime.
#[async_trait]
pub trait ConversationSubscriptionRegistrar: Send + Sync {
    async fn register(
        &self,
        subscription_id: SubscriptionId,
        conversation_id: ConversationId,
    ) -> Result<(), ApplicationError>;
}

pub struct NoopConversationSubscriptions;

#[async_trait::async_trait]
impl ConversationSubscriptionRegistrar for NoopConversationSubscriptions {
    async fn register(
        &self,
        _subscription_id: SubscriptionId,
        _conversation_id: ConversationId,
    ) -> Result<(), ApplicationError> {
        Ok(())
    }
}
