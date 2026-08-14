//! Transport-neutral VibeX application use cases.

mod command;
mod conversation;
mod conversation_execution;
mod domain;
mod error;
mod notification;
mod principal;
mod workflow;

pub use command::{CommandRegistry, RegisteredCommand};
pub use conversation::{
    ApplicationCore, CancelConversationInputRequest, CancelConversationTurn,
    ConversationExecutionPort, ConversationOutputView, ConversationPluginActionInvocation,
    ConversationRepository, ConversationSubscriptionRegistrar, CreateChildConversationRequest,
    CreateConversation, ListConversationInputsRequest, ListConversationRelationsRequest,
    ListConversations, ReorderConversationInputRequest, RespondConversationPermission,
    RespondConversationQuestion, SqliteConversationRepository, StartConversationTurn,
    SteerConversationTurnRequest, SubmitConversationInputRequest, UpdateConversationInputRequest,
};
pub use conversation_execution::ConversationSessionExecutionPort;
pub use conversations::{
    ConversationInputStatus, ConversationInputSubmission, ConversationInputView,
    ConversationRelationView, ConversationSteeringReceipt, ConversationSteeringStatus,
    ConversationTurnSnapshot,
};
pub use db::models::conversation::DbConversationSummary as ConversationSummary;
pub use domain::{ApplicationDomainPort, DomainCommand};
pub use error::ApplicationError;
pub use notification::{NotificationProjector, TerminalNotificationEvidence};
pub use principal::Principal;
pub use workflow::{
    CancelWorkflowRequest, CompleteWorkflowStepRequest, DecideWorkflowRequest,
    PublishWorkflowRequest, ResumeWorkflowRequest, StartWorkflowRequest, ValidateWorkflowRequest,
    WorkflowAgentDispatcher, WorkflowExecutionPort, WorkflowStoreExecutionPort,
};
pub use workflows::{
    WorkflowDefinition, WorkflowEventRecord, WorkflowReviewDecision, WorkflowRunView,
    WorkflowStepView, WorkflowValidationView, WorkflowVersionView,
};
