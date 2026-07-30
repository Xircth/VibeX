use async_trait::async_trait;
use db::models::conversation::DbConversationSummary;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{ApplicationError, Principal};

const READ_CONVERSATIONS_SCOPE: &str = "conversation.read";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ListConversations {
    pub workspace_id: Uuid,
}

#[async_trait]
pub trait ConversationRepository: Send + Sync {
    async fn list_for_workspace(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError>;
}

#[derive(Clone)]
pub struct SqliteConversationRepository {
    pool: SqlitePool,
}

impl SqliteConversationRepository {
    pub const fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ConversationRepository for SqliteConversationRepository {
    async fn list_for_workspace(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError> {
        DbConversationSummary::list_for_workspace(&self.pool, workspace_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }
}

pub struct ApplicationCore<R> {
    conversations: R,
}

impl<R> ApplicationCore<R>
where
    R: ConversationRepository,
{
    pub const fn new(conversations: R) -> Self {
        Self { conversations }
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
}
