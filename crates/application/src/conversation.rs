use std::sync::Arc;

use async_trait::async_trait;
use conversations::ConversationTurnSnapshot;
use db::models::{
    conversation::{ConversationRecord, CreateConversationRecord, DbConversationSummary},
    conversation_event::ConversationEventRecord,
};
use remote_protocol::{
    ConversationId, NotificationOutcome, NotificationSource, OfflineConversationCache, OperationId,
    RemoteEvent, SubscriptionBootstrap, SubscriptionId, SubscriptionSnapshot,
    TerminalNotificationSummary,
};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    ApplicationDomainPort, ApplicationError, DomainCommand, NotificationProjector, Principal,
    TerminalNotificationEvidence, domain::unavailable_domains,
};

const READ_CONVERSATIONS_SCOPE: &str = "conversation.read";
const WRITE_CONVERSATIONS_SCOPE: &str = "conversation.write";
const ATTACH_CONVERSATIONS_SCOPE: &str = "conversation.attach";
const RESPOND_PERMISSION_SCOPE: &str = "conversation.permission";
const RESPOND_QUESTION_SCOPE: &str = "conversation.question";
const CANCEL_CONVERSATION_SCOPE: &str = "conversation.cancel";
const OFFLINE_READ_SCOPE: &str = "offline.read";
const NOTIFICATION_SUMMARY_SCOPE: &str = "notification.summary";
const MAX_OFFLINE_EVENTS: i64 = 10_000;

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
    #[serde(default)]
    pub plugin_actions: Vec<ConversationPluginActionInvocation>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPluginActionInvocation {
    pub plugin_id: String,
    pub action_id: String,
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

    async fn offline_cache(
        &self,
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> Result<OfflineConversationCache, ApplicationError> {
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
            MAX_OFFLINE_EVENTS,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        transaction
            .commit()
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let confirmed_through = records
            .last()
            .map_or(after_sequence.max(0).min(high_water_mark), |record| {
                record.sequence
            });
        let events = records
            .into_iter()
            .filter(|record| record.sequence <= high_water_mark)
            .map(remote_event)
            .collect();
        Ok(OfflineConversationCache {
            conversation_id,
            confirmed_through,
            read_only: true,
            events,
        })
    }

    async fn terminal_notification(
        &self,
        conversation_id: ConversationId,
    ) -> Result<TerminalNotificationSummary, ApplicationError> {
        let conversation_uuid = conversation_id.as_uuid();
        let record = sqlx::query_as::<_, (Uuid, String, String, chrono::DateTime<chrono::Utc>)>(
            "SELECT id, event_kind, normalized_json, created_at
             FROM conversation_events
             WHERE conversation_id = ?
               AND event_kind IN (
                   'turn_completed', 'turn_failed', 'turn_cancelled', 'turn_interrupted'
               )
             ORDER BY sequence DESC
             LIMIT 1",
        )
        .bind(conversation_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
        .ok_or_else(|| {
            ApplicationError::not_found(format!(
                "conversation {conversation_id} has no terminal event"
            ))
        })?;
        let source = sqlx::query_as::<_, (Uuid, Uuid)>(
            "SELECT id, automation_id
             FROM automation_runs
             WHERE conversation_id = ?
             ORDER BY started_at DESC
             LIMIT 1",
        )
        .bind(conversation_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
        .map_or(
            NotificationSource::Conversation { conversation_id },
            |row| NotificationSource::Automation {
                run_id: row.0.to_string(),
                automation_id: row.1.to_string(),
                conversation_id: Some(conversation_id),
            },
        );
        let outcome = match record.1.as_str() {
            "turn_completed" => NotificationOutcome::Completed,
            "turn_failed" => NotificationOutcome::Failed,
            "turn_cancelled" => NotificationOutcome::Cancelled,
            "turn_interrupted" => NotificationOutcome::Interrupted,
            _ => {
                return Err(ApplicationError::internal(
                    "terminal event query returned a non-terminal event",
                ));
            }
        };
        Ok(NotificationProjector::project(
            TerminalNotificationEvidence {
                source,
                outcome,
                occurred_at: record.3.to_rfc3339(),
                operation_id: OperationId::from_uuid(record.0),
                private_detail: Some(record.2),
            },
        ))
    }
}

fn remote_event(record: ConversationEventRecord) -> RemoteEvent {
    RemoteEvent {
        sequence: record.sequence,
        kind: record.event_kind,
        payload: serde_json::from_str(&record.normalized_json)
            .unwrap_or_else(|_| serde_json::json!({ "unparsed": record.normalized_json })),
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
        if !principal.allows(RESPOND_PERMISSION_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.permission",
            ));
        }
        self.execution.respond_permission(request).await
    }

    pub async fn respond_conversation_question(
        &self,
        principal: &Principal,
        request: RespondConversationQuestion,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(RESPOND_QUESTION_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.question",
            ));
        }
        self.execution.respond_question(request).await
    }

    pub async fn cancel_conversation_turn(
        &self,
        principal: &Principal,
        request: CancelConversationTurn,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(CANCEL_CONVERSATION_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.cancel",
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

    pub async fn offline_conversation_cache(
        &self,
        principal: &Principal,
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> Result<OfflineConversationCache, ApplicationError> {
        if !principal.allows(OFFLINE_READ_SCOPE) {
            return Err(ApplicationError::forbidden("principal lacks offline.read"));
        }
        self.conversations
            .offline_cache(conversation_id, after_sequence)
            .await
    }

    pub async fn terminal_notification_summary(
        &self,
        principal: &Principal,
        conversation_id: ConversationId,
    ) -> Result<TerminalNotificationSummary, ApplicationError> {
        if !principal.allows(NOTIFICATION_SUMMARY_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks notification.summary",
            ));
        }
        self.conversations
            .terminal_notification(conversation_id)
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
        if !principal.allows(ATTACH_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.attach",
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
