//! Transport-neutral VibeX application use cases.

mod command;
mod conversation;
mod conversation_execution;
mod domain;
mod error;
mod notification;
mod principal;

pub use command::{CommandRegistry, RegisteredCommand};
pub use conversation::{
    ApplicationCore, CancelConversationTurn, ConversationExecutionPort,
    ConversationPluginActionInvocation, ConversationRepository, ConversationSubscriptionRegistrar,
    CreateConversation, ListConversations, RespondConversationPermission,
    RespondConversationQuestion, SqliteConversationRepository, StartConversationTurn,
};
pub use conversation_execution::ConversationSessionExecutionPort;
pub use conversations::ConversationTurnSnapshot;
pub use db::models::conversation::DbConversationSummary as ConversationSummary;
pub use domain::{ApplicationDomainPort, DomainCommand};
pub use error::ApplicationError;
pub use notification::{NotificationProjector, TerminalNotificationEvidence};
pub use principal::Principal;
