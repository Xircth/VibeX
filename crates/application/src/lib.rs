//! Transport-neutral VibeX application use cases.

mod command;
mod conversation;
mod conversation_execution;
mod error;
mod principal;

pub use command::{CommandRegistry, RegisteredCommand};
pub use conversation::{
    ApplicationCore, CancelConversationTurn, ConversationExecutionPort, ConversationRepository,
    ConversationSubscriptionRegistrar, CreateConversation, ListConversations,
    RespondConversationPermission, SqliteConversationRepository, StartConversationTurn,
};
pub use conversation_execution::ConversationSessionExecutionPort;
pub use conversations::ConversationTurnSnapshot;
pub use db::models::conversation::DbConversationSummary as ConversationSummary;
pub use error::ApplicationError;
pub use principal::Principal;
