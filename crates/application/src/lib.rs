//! Transport-neutral VibeX application use cases.

mod command;
mod conversation;
mod error;
mod principal;

pub use command::{CommandRegistry, RegisteredCommand};
pub use conversation::{
    ApplicationCore, ConversationRepository, ConversationSubscriptionRegistrar, ListConversations,
    SqliteConversationRepository,
};
pub use db::models::conversation::DbConversationSummary as ConversationSummary;
pub use error::ApplicationError;
pub use principal::Principal;
