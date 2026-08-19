use std::sync::Arc;

use agents::conversation::{ContentBlock, ConversationTimelineRow, TurnRole};
use async_trait::async_trait;
use conversations::{
    CancelConversationInput, ConversationInputSubmission, ConversationInputView,
    ConversationProjector, ConversationRelationView, ConversationSteerInput,
    ConversationSteeringReceipt, ConversationTurnSnapshot, CreateForkConversation,
    ReorderConversationInput, SubmitConversationInput, UpdateConversationInput,
    create_fork_conversation,
};
use db::models::{
    conversation::{ConversationRecord, CreateConversationRecord, DbConversationSummary},
    conversation_event::ConversationEventRecord,
    conversation_turn::ConversationTurnRecord,
};
use remote_protocol::{
    ConversationId, NotificationOutcome, NotificationSource, OfflineConversationCache, OperationId,
    RemoteEvent, SubscriptionBootstrap, SubscriptionId, SubscriptionSnapshot,
    TerminalNotificationSummary,
};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    AcceptWorkflowCandidateRequest, ApplicationDomainPort, ApplicationError, CancelWorkflowRequest,
    CompleteWorkflowStepRequest, DebugWorkflowRequest, DecideWorkflowRequest, DomainCommand,
    ForkWorkflowRequest, NotificationProjector, PauseWorkflowRequest, PauseWorkflowStepRequest,
    Principal, PublishWorkflowRequest, ResumePausedWorkflowRequest, ResumeWorkflowRequest,
    StartWorkflowRequest, SubmitWorkflowStepInputRequest, TerminalNotificationEvidence,
    ValidateWorkflowRequest, WorkflowDefinitionSummary, WorkflowEventRecord, WorkflowExecutionPort,
    WorkflowRunView, WorkflowStepView, WorkflowValidationView, WorkflowVersionView,
    domain::unavailable_domains, workflow::UnavailableWorkflowExecution,
};

const READ_CONVERSATIONS_SCOPE: &str = "conversation.read";
const WRITE_CONVERSATIONS_SCOPE: &str = "conversation.write";
const ATTACH_CONVERSATIONS_SCOPE: &str = "conversation.attach";
const RESPOND_PERMISSION_SCOPE: &str = "conversation.permission";
const RESPOND_QUESTION_SCOPE: &str = "conversation.question";
const CANCEL_CONVERSATION_SCOPE: &str = "conversation.cancel";
const STEER_CONVERSATION_SCOPE: &str = "conversation.steer";
const OFFLINE_READ_SCOPE: &str = "offline.read";
const NOTIFICATION_SUMMARY_SCOPE: &str = "notification.summary";
const MAX_OFFLINE_EVENTS: i64 = 10_000;

fn require_workflow_run(principal: &Principal) -> Result<(), ApplicationError> {
    if principal.allows("workflow.run") {
        Ok(())
    } else {
        Err(ApplicationError::forbidden("principal lacks workflow.run"))
    }
}

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

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChildConversationRequest {
    pub parent_conversation_id: Uuid,
    pub agent_id: String,
    pub title: Option<String>,
    pub initial_prompt: Option<String>,
    #[serde(default = "default_child_visibility")]
    pub visible: bool,
}

const fn default_child_visibility() -> bool {
    true
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
    #[serde(default, alias = "pluginActions")]
    pub workflow_refs: Vec<crate::ConversationWorkflowRef>,
    #[serde(default)]
    pub operation_id: Option<uuid::Uuid>,
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

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteerConversationTurnRequest {
    pub conversation_id: Uuid,
    pub expected_turn_id: Uuid,
    pub text: String,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitConversationInputRequest {
    pub conversation_id: Uuid,
    pub payload: agents::ConversationInputPayload,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConversationInputRequest {
    pub conversation_id: Uuid,
    pub input_id: Uuid,
    pub expected_revision: u64,
    pub payload: agents::ConversationInputPayload,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderConversationInputRequest {
    pub conversation_id: Uuid,
    pub input_id: Uuid,
    pub expected_revision: u64,
    pub sort_key: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelConversationInputRequest {
    pub conversation_id: Uuid,
    pub input_id: Uuid,
    pub expected_revision: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConversationInputsRequest {
    pub conversation_id: Uuid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConversationRelationsRequest {
    pub conversation_id: Uuid,
}

#[derive(Clone, Debug, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ConversationOutputView {
    pub conversation_id: Uuid,
    pub turn: Option<ConversationTurnSnapshot>,
    pub assistant_text: Option<String>,
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

    async fn steer(
        &self,
        _request: ConversationSteerInput,
    ) -> Result<ConversationSteeringReceipt, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation steering is not configured",
        ))
    }

    async fn submit_input(
        &self,
        _request: SubmitConversationInput,
    ) -> Result<ConversationInputSubmission, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input submission is not configured",
        ))
    }

    async fn list_inputs(
        &self,
        _conversation_id: Uuid,
    ) -> Result<Vec<ConversationInputView>, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input listing is not configured",
        ))
    }

    async fn list_relations(
        &self,
        _conversation_id: Uuid,
    ) -> Result<Vec<ConversationRelationView>, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation relation listing is not configured",
        ))
    }

    async fn update_input(
        &self,
        _request: UpdateConversationInput,
    ) -> Result<ConversationInputView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input update is not configured",
        ))
    }

    async fn reorder_input(
        &self,
        _request: ReorderConversationInput,
    ) -> Result<ConversationInputView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input reorder is not configured",
        ))
    }

    async fn cancel_input(
        &self,
        _request: CancelConversationInput,
    ) -> Result<ConversationInputView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input cancellation is not configured",
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

    async fn create_child(
        &self,
        _operation_id: Uuid,
        _request: CreateChildConversationRequest,
    ) -> Result<DbConversationSummary, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation child creation is not configured",
        ))
    }

    async fn output(
        &self,
        _conversation_id: Uuid,
    ) -> Result<ConversationOutputView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation output is not configured",
        ))
    }

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

    async fn create_child(
        &self,
        operation_id: Uuid,
        request: CreateChildConversationRequest,
    ) -> Result<DbConversationSummary, ApplicationError> {
        let agent_id = agents::AgentId::parse(&request.agent_id)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let conversation_id = create_fork_conversation(
            &self.pool,
            CreateForkConversation {
                id: operation_id,
                parent_conversation_id: request.parent_conversation_id,
                agent_id,
                title: request.title,
                initial_prompt: request.initial_prompt,
                visible: request.visible,
            },
        )
        .await
        .map_err(|error| match error {
            conversations::ConversationServiceError::NotFound(message) => {
                ApplicationError::not_found(message)
            }
            conversations::ConversationServiceError::BadRequest(message) => {
                ApplicationError::bad_request(message)
            }
            conversations::ConversationServiceError::Conflict(message) => {
                ApplicationError::conflict(message)
            }
            conversations::ConversationServiceError::Internal(message) => {
                ApplicationError::internal(message)
            }
            conversations::ConversationServiceError::AuthenticationRequired(message) => {
                ApplicationError::bad_request(message)
            }
            conversations::ConversationServiceError::SessionUnavailable { message, .. } => {
                ApplicationError::bad_request(message)
            }
        })?;
        DbConversationSummary::find_by_id(&self.pool, conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| {
                ApplicationError::not_found(format!(
                    "conversation {conversation_id} was not created"
                ))
            })
    }

    async fn output(
        &self,
        conversation_id: Uuid,
    ) -> Result<ConversationOutputView, ApplicationError> {
        let turn = ConversationTurnRecord::list_for_conversation(&self.pool, conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .into_iter()
            .last();
        let last_sequence: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sequence), 0)
             FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let timeline = ConversationProjector::project(&self.pool, conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let assistant_text = timeline.rows.iter().rev().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.role == TurnRole::Assistant =>
            {
                let text = turn
                    .blocks
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<String>();
                (!text.trim().is_empty()).then_some(text)
            }
            _ => None,
        });
        Ok(ConversationOutputView {
            conversation_id,
            turn: turn.map(|turn| ConversationTurnSnapshot {
                conversation_id,
                turn_id: turn.id,
                prompt_id: turn
                    .prompt_id
                    .and_then(|value| Uuid::parse_str(&value).ok()),
                status: turn.status,
                last_sequence,
            }),
            assistant_text,
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
    workflows: Arc<dyn WorkflowExecutionPort>,
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
            workflows: Arc::new(UnavailableWorkflowExecution),
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
            workflows: Arc::new(UnavailableWorkflowExecution),
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
            workflows: Arc::new(UnavailableWorkflowExecution),
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
            workflows: Arc::new(UnavailableWorkflowExecution),
        }
    }

    pub fn with_all_ports<E, D, W>(
        conversations: R,
        execution: Arc<E>,
        domains: Arc<D>,
        workflows: Arc<W>,
    ) -> Self
    where
        E: ConversationExecutionPort + 'static,
        D: ApplicationDomainPort + 'static,
        W: WorkflowExecutionPort + 'static,
    {
        Self {
            conversations,
            execution,
            domains,
            workflows,
        }
    }

    pub fn with_execution_and_workflows<E, W>(
        conversations: R,
        execution: Arc<E>,
        workflows: Arc<W>,
    ) -> Self
    where
        E: ConversationExecutionPort + 'static,
        W: WorkflowExecutionPort + 'static,
    {
        Self {
            conversations,
            execution,
            domains: unavailable_domains(),
            workflows,
        }
    }

    pub fn with_workflows<W>(conversations: R, workflows: Arc<W>) -> Self
    where
        W: WorkflowExecutionPort + 'static,
    {
        Self {
            conversations,
            execution: Arc::new(UnavailableConversationExecution),
            domains: unavailable_domains(),
            workflows,
        }
    }

    pub async fn publish_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: PublishWorkflowRequest,
    ) -> Result<WorkflowVersionView, ApplicationError> {
        if !principal.allows("workflow.write") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.write",
            ));
        }
        self.workflows
            .publish(principal, operation_id, request)
            .await
    }

    pub async fn validate_workflow(
        &self,
        principal: &Principal,
        request: ValidateWorkflowRequest,
    ) -> Result<WorkflowValidationView, ApplicationError> {
        if !principal.allows("workflow.write") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.write",
            ));
        }
        self.workflows.validate(request).await
    }

    pub async fn start_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: StartWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.run") {
            return Err(ApplicationError::forbidden("principal lacks workflow.run"));
        }
        self.workflows.start(principal, operation_id, request).await
    }

    pub async fn debug_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: DebugWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.write") || !principal.allows("workflow.run") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.write or workflow.run",
            ));
        }
        self.workflows.debug(principal, operation_id, request).await
    }

    pub async fn show_workflow(
        &self,
        principal: &Principal,
        run_id: Uuid,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.show(run_id).await
    }

    pub async fn workflow_steps(
        &self,
        principal: &Principal,
        run_id: Uuid,
    ) -> Result<Vec<WorkflowStepView>, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.steps(run_id).await
    }

    pub async fn workflow_version(
        &self,
        principal: &Principal,
        version_id: Uuid,
    ) -> Result<WorkflowVersionView, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.version(version_id).await
    }

    pub async fn workflow_definitions(
        &self,
        principal: &Principal,
        limit: u32,
    ) -> Result<Vec<WorkflowDefinitionSummary>, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.definitions(limit).await
    }

    pub async fn workflow_versions(
        &self,
        principal: &Principal,
        definition_id: Uuid,
        limit: u32,
    ) -> Result<Vec<WorkflowVersionView>, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.versions(definition_id, limit).await
    }

    pub async fn workflow_events(
        &self,
        principal: &Principal,
        run_id: Uuid,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<WorkflowEventRecord>, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.events(run_id, after_sequence, limit).await
    }

    pub async fn attach_workflow_run(
        &self,
        principal: &Principal,
        subscription_id: SubscriptionId,
        run_id: Uuid,
        after_sequence: i64,
    ) -> Result<SubscriptionBootstrap, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        let run = self.workflows.show(run_id).await?;
        if after_sequence == 0 {
            let steps = self.workflows.steps(run_id).await?;
            return Ok(SubscriptionBootstrap {
                subscription_id,
                ready: true,
                snapshot: Some(SubscriptionSnapshot {
                    through_sequence: run.last_sequence,
                    payload: serde_json::json!({"run": run, "steps": steps}),
                }),
                replay: Vec::new(),
                high_water_mark: run.last_sequence,
            });
        }
        let records = self
            .workflows
            .events(run_id, after_sequence, 10_000)
            .await?;
        let replay = records
            .into_iter()
            .filter(|event| event.sequence <= run.last_sequence)
            .map(|event| RemoteEvent {
                sequence: event.sequence,
                kind: event.event_kind,
                payload: serde_json::from_str(&event.payload_json)
                    .unwrap_or_else(|_| serde_json::json!({"unparsed": event.payload_json})),
            })
            .collect::<Vec<_>>();
        let high_water_mark = replay
            .last()
            .map(|event| event.sequence)
            .unwrap_or(after_sequence)
            .min(run.last_sequence);
        Ok(SubscriptionBootstrap {
            subscription_id,
            ready: true,
            snapshot: None,
            replay,
            high_water_mark,
        })
    }

    pub async fn complete_workflow_step(
        &self,
        principal: &Principal,
        request: CompleteWorkflowStepRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.internal") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.internal",
            ));
        }
        self.workflows.complete_step(request).await
    }

    pub async fn decide_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: DecideWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.approve") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.approve",
            ));
        }
        self.workflows
            .decide(principal, operation_id, request)
            .await
    }

    pub async fn cancel_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: CancelWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.run") {
            return Err(ApplicationError::forbidden("principal lacks workflow.run"));
        }
        self.workflows.cancel(operation_id, request).await
    }

    pub async fn resume_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ResumeWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.run") {
            return Err(ApplicationError::forbidden("principal lacks workflow.run"));
        }
        self.workflows
            .resume(principal, operation_id, request)
            .await
    }

    pub async fn pause_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: PauseWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .pause_run(principal, operation_id, request)
            .await
    }

    pub async fn resume_paused_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ResumePausedWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .resume_paused_run(principal, operation_id, request)
            .await
    }

    pub async fn accept_workflow_candidate(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: AcceptWorkflowCandidateRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .accept_candidate(principal, operation_id, request)
            .await
    }

    pub async fn pause_workflow_step(
        &self,
        principal: &Principal,
        request: PauseWorkflowStepRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows.pause_step(request).await
    }

    pub async fn submit_workflow_step_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: SubmitWorkflowStepInputRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .submit_step_input(operation_id, request)
            .await
    }

    pub async fn fork_workflow_from_step(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ForkWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .fork_from_step(principal, operation_id, request)
            .await
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

    pub async fn create_child_conversation(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: CreateChildConversationRequest,
    ) -> Result<DbConversationSummary, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.create_child(operation_id, request).await
    }

    pub async fn conversation_output(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
    ) -> Result<ConversationOutputView, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.conversations.output(conversation_id).await
    }

    pub async fn start_conversation_turn(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        mut request: StartConversationTurn,
    ) -> Result<ConversationTurnSnapshot, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        request.operation_id = Some(operation_id);
        self.execution.start_turn(request).await
    }

    pub async fn submit_conversation_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: SubmitConversationInputRequest,
    ) -> Result<ConversationInputSubmission, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .submit_input(SubmitConversationInput {
                conversation_id: request.conversation_id,
                operation_id,
                payload: request.payload,
                principal: principal_evidence(principal),
            })
            .await
    }

    pub async fn steer_conversation_turn(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: SteerConversationTurnRequest,
    ) -> Result<ConversationSteeringReceipt, ApplicationError> {
        if !principal.allows(STEER_CONVERSATION_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.steer",
            ));
        }
        self.execution
            .steer(ConversationSteerInput {
                conversation_id: request.conversation_id,
                operation_id,
                expected_turn_id: request.expected_turn_id,
                text: request.text,
                images: request.images,
                principal: principal_evidence(principal),
            })
            .await
    }

    pub async fn list_conversation_inputs(
        &self,
        principal: &Principal,
        request: ListConversationInputsRequest,
    ) -> Result<Vec<ConversationInputView>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.execution.list_inputs(request.conversation_id).await
    }

    pub async fn list_conversation_relations(
        &self,
        principal: &Principal,
        request: ListConversationRelationsRequest,
    ) -> Result<Vec<ConversationRelationView>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.execution.list_relations(request.conversation_id).await
    }

    pub async fn update_conversation_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: UpdateConversationInputRequest,
    ) -> Result<ConversationInputView, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .update_input(UpdateConversationInput {
                conversation_id: request.conversation_id,
                input_id: request.input_id,
                operation_id,
                expected_revision: request.expected_revision,
                payload: request.payload,
            })
            .await
    }

    pub async fn reorder_conversation_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ReorderConversationInputRequest,
    ) -> Result<ConversationInputView, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .reorder_input(ReorderConversationInput {
                conversation_id: request.conversation_id,
                input_id: request.input_id,
                operation_id,
                expected_revision: request.expected_revision,
                sort_key: request.sort_key,
            })
            .await
    }

    pub async fn cancel_conversation_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: CancelConversationInputRequest,
    ) -> Result<ConversationInputView, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .cancel_input(CancelConversationInput {
                conversation_id: request.conversation_id,
                input_id: request.input_id,
                operation_id,
                expected_revision: request.expected_revision,
            })
            .await
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

fn principal_evidence(principal: &Principal) -> serde_json::Value {
    match principal {
        Principal::LocalDesktop => serde_json::json!({ "kind": "local_desktop" }),
        Principal::Remote {
            subject,
            credential_id,
            device_id,
            ..
        } => serde_json::json!({
            "kind": "remote",
            "subject": subject,
            "credentialId": credential_id,
            "deviceId": device_id,
        }),
    }
}
