use std::sync::Arc;

use async_trait::async_trait;
use conversations::ConversationTurnSnapshot;
use db::models::{
    conversation::{ConversationRecord, CreateConversationRecord, DbConversationSummary},
    conversation_event::ConversationEventRecord,
};
use remote_protocol::{
    ConversationId, RemoteEvent, SubscriptionBootstrap, SubscriptionId, SubscriptionSnapshot,
};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    ApplicationDomainPort, ApplicationError, DomainCommand, Principal, domain::unavailable_domains,
};

const READ_CONVERSATIONS_SCOPE: &str = "conversation.read";
const WRITE_CONVERSATIONS_SCOPE: &str = "conversation.write";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ListConversations {
    pub workspace_id: Uuid,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateConversation {
    pub workspace_id: Uuid,
    pub agent_id: String,
    pub title: Option<String>,
    pub initial_prompt: Option<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartConversationTurn {
    pub agent_id: String,
    pub workspace_id: Uuid,
    pub conversation_id: Uuid,
    pub executor_profile_id: Option<serde_json::Value>,
    pub text: String,
    pub images: Vec<String>,
    pub mode_override: Option<String>,
    pub config_overrides: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespondConversationPermission {
    pub conversation_id: Uuid,
    pub permission_id: String,
    pub response: serde_json::Value,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelConversationTurn {
    pub conversation_id: Uuid,
    pub reason: Option<String>,
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

    async fn cancel_turn(&self, _request: CancelConversationTurn) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation cancellation is not configured",
        ))
    }
}

struct UnavailableConversationExecution;

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

    async fn create(
        &self,
        request: CreateConversation,
    ) -> Result<DbConversationSummary, ApplicationError>;

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

    async fn create(
        &self,
        request: CreateConversation,
    ) -> Result<DbConversationSummary, ApplicationError> {
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &self.pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: request.workspace_id,
                task_id: None,
                title: request.title.as_deref(),
                initial_prompt: request.initial_prompt.as_deref(),
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        sqlx::query(
            "UPDATE sessions
             SET agent_type = ?, updated_at = datetime('now', 'subsec')
             WHERE id = ?",
        )
        .bind(request.agent_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        DbConversationSummary::find_by_id(&self.pool, conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| {
                ApplicationError::not_found(format!(
                    "conversation {conversation_id} was not created"
                ))
            })
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
    execution: Arc<dyn ConversationExecutionPort>,
    domains: Arc<dyn ApplicationDomainPort>,
}

impl<R> ApplicationCore<R>
where
    R: ConversationRepository,
{
    pub fn new(conversations: R) -> Self {
        Self {
            conversations,
            execution: Arc::new(UnavailableConversationExecution),
            domains: unavailable_domains(),
        }
    }

    pub fn with_execution<E>(conversations: R, execution: Arc<E>) -> Self
    where
        E: ConversationExecutionPort + 'static,
    {
        Self {
            conversations,
            execution,
            domains: unavailable_domains(),
        }
    }

    pub fn with_domains<D>(conversations: R, domains: Arc<D>) -> Self
    where
        D: ApplicationDomainPort + 'static,
    {
        Self {
            conversations,
            execution: Arc::new(UnavailableConversationExecution),
            domains,
        }
    }

    pub fn with_ports<E, D>(conversations: R, execution: Arc<E>, domains: Arc<D>) -> Self
    where
        E: ConversationExecutionPort + 'static,
        D: ApplicationDomainPort + 'static,
    {
        Self {
            conversations,
            execution,
            domains,
        }
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

    pub async fn create_conversation(
        &self,
        principal: &Principal,
        request: CreateConversation,
    ) -> Result<DbConversationSummary, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.create(request).await
    }

    pub async fn start_conversation_turn(
        &self,
        principal: &Principal,
        request: StartConversationTurn,
    ) -> Result<ConversationTurnSnapshot, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution.start_turn(request).await
    }

    pub async fn respond_conversation_permission(
        &self,
        principal: &Principal,
        request: RespondConversationPermission,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution.respond_permission(request).await
    }

    pub async fn cancel_conversation_turn(
        &self,
        principal: &Principal,
        request: CancelConversationTurn,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution.cancel_turn(request).await
    }

    pub async fn execute_domain(
        &self,
        principal: &Principal,
        command: DomainCommand,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ApplicationError> {
        if !principal.allows(command.required_scope()) {
            return Err(ApplicationError::forbidden(format!(
                "principal lacks {}",
                command.required_scope()
            )));
        }
        self.domains.execute(principal, command, args).await
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
