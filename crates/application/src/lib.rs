//! Transport-neutral VibeX application use cases.

mod conversation;
mod error;
mod principal;

pub use conversation::{
    ApplicationCore, ConversationRepository, ListConversations, SqliteConversationRepository,
};
pub use db::models::conversation::DbConversationSummary as ConversationSummary;
pub use error::ApplicationError;
pub use principal::Principal;
