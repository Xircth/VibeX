use async_trait::async_trait;
use db::models::{
    conversation::DbConversationSummary, conversation_event::ConversationEventRecord,
};
use remote_protocol::{
    ConversationId, RemoteEvent, SubscriptionBootstrap, SubscriptionId, SubscriptionSnapshot,
};
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

    async fn attach(
        &self,
        subscription_id: SubscriptionId,
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> Result<SubscriptionBootstrap, ApplicationError>;
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

    async fn attach(
        &self,
        subscription_id: SubscriptionId,
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> Result<SubscriptionBootstrap, ApplicationError> {
        let conversation_uuid = conversation_id.as_uuid();
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let high_water_mark = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(sequence), 0)
             FROM conversation_events
             WHERE conversation_id = ?",
        )
        .bind(conversation_uuid)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let records = ConversationEventRecord::events_since(
            &mut *transaction,
            conversation_uuid,
            after_sequence,
            i64::MAX,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        transaction
            .commit()
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;

        let events = records
            .into_iter()
            .filter(|record| record.sequence <= high_water_mark)
            .map(|record| RemoteEvent {
                sequence: record.sequence,
                kind: record.event_kind,
                payload: serde_json::from_str(&record.normalized_json)
                    .unwrap_or_else(|_| serde_json::json!({ "unparsed": record.normalized_json })),
            })
            .collect::<Vec<_>>();
        let (snapshot, replay) = if after_sequence == 0 {
            (
                Some(SubscriptionSnapshot {
                    through_sequence: high_water_mark,
                    payload: serde_json::json!({ "events": events }),
                }),
                Vec::new(),
            )
        } else {
            (None, events)
        };
        Ok(SubscriptionBootstrap {
            subscription_id,
            ready: false,
            snapshot,
            replay,
            high_water_mark,
        })
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

    pub async fn attach_conversation<S>(
        &self,
        principal: &Principal,
        subscription_id: SubscriptionId,
        conversation_id: ConversationId,
        after_sequence: i64,
        subscriptions: &S,
    ) -> Result<SubscriptionBootstrap, ApplicationError>
    where
        S: ConversationSubscriptionRegistrar + ?Sized,
    {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        subscriptions
            .register(subscription_id, conversation_id)
            .await?;
        let mut bootstrap = self
            .conversations
            .attach(subscription_id, conversation_id, after_sequence)
            .await?;
        bootstrap.ready = true;
        Ok(bootstrap)
    }
}
