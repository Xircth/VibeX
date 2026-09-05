//! Transport-neutral VibeX application use cases.

mod args;
mod command;
mod conversation;
mod conversation_artifacts;
mod conversation_execution;
mod domain;
mod error;
mod notification;
mod principal;
mod workflow;

pub use agents::ConversationWorkflowRef;
pub use args::{ArgShape, decode_command_args, decode_command_args_shaped};
pub use command::{CommandRegistry, HostCommandDescriptor, HostCommandKind, RegisteredCommand};
pub use conversation::{
    ApplicationCore, CancelConversationInputRequest, CancelConversationTurn, CompanionSessionPort,
    ConversationCatalog, ConversationCatalogAgent, ConversationCatalogProject,
    ConversationCatalogTag, ConversationCatalogWorkspace, ConversationExecutionPort,
    ConversationLiveFeedbackNote, ConversationOutputView, ConversationRepository,
    ConversationSlashCommand, ConversationSubscriptionRegistrar, ConversationWorkspaceEntry,
    CreateChildConversationRequest, CreateConversation, CreateConversationWorkspace,
    ListConversationFeedbackRequest, ListConversationInputsRequest,
    ListConversationRelationsRequest, ListConversations, ListRecentConversations,
    NoopConversationSubscriptions, ReorderConversationInputRequest, RespondConversationPermission,
    RespondConversationQuestion, SqliteConversationRepository, StartConversationTurn,
    SteerConversationTurnRequest, SubmitConversationFeedback, SubmitConversationInputRequest,
    UpdateConversationInputRequest,
};
pub use conversation_artifacts::SqliteConversationArtifactEventSink;
pub use conversation_execution::ConversationSessionExecutionPort;
pub use conversations::{
    ConversationInputStatus, ConversationInputSubmission, ConversationInputView,
    ConversationRelationView, ConversationSteeringReceipt, ConversationSteeringStatus,
    ConversationTurnSnapshot,
};
pub use db::models::conversation::DbConversationSummary as ConversationSummary;
pub use domain::{AdapterCapabilities, ApplicationDomainPort, DomainCommand};
pub use error::ApplicationError;
pub use notification::{NotificationProjector, TerminalNotificationEvidence};
pub use principal::Principal;
pub use workflow::{
    AcceptWorkflowCandidateRequest, CancelWorkflowRequest, CompleteWorkflowStepRequest,
    DebugWorkflowRequest, DecideWorkflowRequest, ForkWorkflowRequest, PauseWorkflowRequest,
    PauseWorkflowStepRequest, PublishWorkflowRequest, ResumePausedWorkflowRequest,
    ResumeWorkflowRequest, StartWorkflowRequest, SubmitWorkflowStepInputRequest,
    ValidateWorkflowRequest, WorkflowAgentDispatcher, WorkflowExecutionPort,
    WorkflowStoreExecutionPort,
};
pub use workflows::{
    CompletionPolicy, DebugRunScope, WorkflowDefinition, WorkflowDefinitionSummary,
    WorkflowEventRecord, WorkflowReviewDecision, WorkflowRunView, WorkflowStepView,
    WorkflowValidationView, WorkflowVersionView,
};
