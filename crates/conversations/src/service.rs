use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
    sync::{Arc, OnceLock},
};

use agents::{
    AgentAutoApproveMode, AgentConnectionId, AgentContentBlock, AgentElicitationId,
    AgentElicitationResponse, AgentId, AgentKind, AgentPermissionId, AgentPermissionResponse,
    AgentPromptId, AgentPromptSnapshot, AgentPromptStatus, AgentRuntime,
    AgentSessionConfigOverride, AgentSessionControlsSnapshot, AgentSessionId,
    CancelAgentPromptInput, ConversationInputPayload, EnsureAgentSessionInput,
    RespondAgentElicitationInput, RespondAgentPermissionInput, ResumeAgentSessionInput,
    SendAgentPromptInput, SessionControlPreferences, SessionLaunchLock, SteerAgentPromptInput,
    conversation::{
        AcpCapabilitySnapshot, ConversationAgentConnectionStatus, ConversationError,
        ConversationEvent, ConversationEventEnvelope, ConversationFileChange,
        ConversationFileChangeSummary, ConversationInputBlock, ConversationPermissionResponse,
        ConversationQuestionResponse, ConversationWorkflowRef,
    },
};
use chrono::{DateTime, Utc};
use db::models::{
    agent_management::SessionDefaultRepository,
    conversation::{
        BindingStatus, ConversationAgentBindingRecord, ConversationRecord,
        CreateConversationAgentBinding, CreateConversationRecord,
    },
    conversation_event::AppendConversationEvent,
    conversation_side_effects::ConversationPermissionRecord,
    conversation_steering::ConversationSteeringRecord,
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    repo::Repo,
    session::{CreateSession, Session, SessionStatus},
    session_checkpoint::SessionCheckpoint,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::profile::ExecutorProfileId;
use git::{Commit, DiffTarget};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{SqliteConnection, SqlitePool};
use tokio::sync::Mutex;
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    ConversationEventAppender, ConversationInputControl, ConversationInputControlError,
    ConversationInputStatus, ConversationInputSubmission, ConversationProjector,
    SubmitConversationInput,
};

/// Agent launch settings (auto-approve + env), resolved from persisted AgentSetting.
/// Moved here so both the orchestration core and the host impl share one type.
#[derive(Debug, Clone)]
pub struct AgentRuntimeLaunchSettings {
    pub auto_approve_mode: AgentAutoApproveMode,
    pub env: HashMap<String, String>,
    pub launch_lock: SessionLaunchLock,
}

/// Orchestration error. Mirrors the shell's `AppError` variants; mapped back to `AppError`
/// at the command boundary via `impl From<ConversationServiceError> for AppError`.
#[derive(Debug, thiserror::Error)]
pub enum ConversationServiceError {
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Conflict: {0}")]
    Conflict(String),
    #[error("Internal error: {0}")]
    Internal(String),
    #[error("agent authentication required: {0}")]
    AuthenticationRequired(String),
    #[error("{code}: {message}")]
    SessionUnavailable { code: &'static str, message: String },
}

impl From<sqlx::Error> for ConversationServiceError {
    fn from(e: sqlx::Error) -> Self {
        ConversationServiceError::Internal(e.to_string())
    }
}
impl From<agents::AgentError> for ConversationServiceError {
    fn from(e: agents::AgentError) -> Self {
        match e {
            agents::AgentError::SteeringUnsupported => Self::BadRequest(e.to_string()),
            agents::AgentError::PromptConflict { .. } => Self::Conflict(e.to_string()),
            agents::AgentError::AuthenticationRequired(message) => {
                Self::AuthenticationRequired(message)
            }
            agents::AgentError::SessionLoadFailed(reason) => Self::SessionUnavailable {
                code: match &reason {
                    agents::SessionLoadFailureReason::ResourceNotFound => "resource_not_found",
                    agents::SessionLoadFailureReason::AuthenticationRequired { .. } => {
                        "auth_required"
                    }
                    agents::SessionLoadFailureReason::Unsupported => "session_resume_unsupported",
                    agents::SessionLoadFailureReason::Other { .. } => "session_load_failed",
                },
                message: session_load_failure_message(&reason),
            },
            agents::AgentError::ConnectionNotFound(_)
            | agents::AgentError::SessionNotFound(_)
            | agents::AgentError::PromptNotFound(_) => Self::NotFound(e.to_string()),
            _ => Self::Internal(e.to_string()),
        }
    }
}

fn session_load_failure_message(reason: &agents::SessionLoadFailureReason) -> String {
    match reason {
        agents::SessionLoadFailureReason::ResourceNotFound => {
            "代理侧已不存在该会话。可见历史仍在，但 Agent 隐藏上下文已丢失。确认重新绑定后才能继续。".into()
        }
        agents::SessionLoadFailureReason::AuthenticationRequired { message } => message.clone(),
        agents::SessionLoadFailureReason::Unsupported => {
            "该代理无法恢复原会话。确认重新绑定后将冷启动，不会保留 Agent 侧上下文。".into()
        }
        agents::SessionLoadFailureReason::Other { message } => message.clone(),
    }
}

impl ConversationServiceError {
    fn turn_failure(&self) -> ConversationError {
        match self {
            Self::AuthenticationRequired(message) => {
                ConversationError::new(message.clone(), Some("auth_required".into()), None)
            }
            Self::SessionUnavailable { code, message } => {
                ConversationError::new(message.clone(), Some((*code).into()), None)
            }
            other => ConversationError::new(other.to_string(), None, None),
        }
    }
}
impl From<serde_json::Error> for ConversationServiceError {
    fn from(e: serde_json::Error) -> Self {
        ConversationServiceError::Internal(e.to_string())
    }
}
impl From<ConversationInputControlError> for ConversationServiceError {
    fn from(error: ConversationInputControlError) -> Self {
        match error {
            ConversationInputControlError::NotFound(_) => Self::NotFound(error.to_string()),
            ConversationInputControlError::EmptyInput
            | ConversationInputControlError::InputTooLarge { .. } => {
                Self::BadRequest(error.to_string())
            }
            ConversationInputControlError::OperationConflict { .. }
            | ConversationInputControlError::StateConflict { .. }
            | ConversationInputControlError::RevisionOverflow => Self::Conflict(error.to_string()),
            ConversationInputControlError::InvalidStatus(_)
            | ConversationInputControlError::Serialization(_)
            | ConversationInputControlError::Database(_) => Self::Internal(error.to_string()),
        }
    }
}
impl From<services::services::container::ContainerError> for ConversationServiceError {
    fn from(e: services::services::container::ContainerError) -> Self {
        ConversationServiceError::Internal(e.to_string())
    }
}

pub struct CreateDelegatedConversation {
    pub id: Uuid,
    pub parent_conversation_id: Uuid,
    pub parent_tool_call_id: String,
    pub delegation_id: String,
    pub agent_id: AgentId,
    pub prompt: String,
    pub policy: serde_json::Value,
}

pub struct CreateWorkflowConversation {
    pub id: Uuid,
    pub parent_conversation_id: Uuid,
    pub workspace_id: Uuid,
    pub workflow_run_id: Uuid,
    pub workflow_step_id: String,
    pub agent_id: AgentId,
    pub prompt: String,
    pub visible: bool,
}

pub struct CreateForkConversation {
    pub id: Uuid,
    pub parent_conversation_id: Uuid,
    pub agent_id: AgentId,
    pub title: Option<String>,
    pub initial_prompt: Option<String>,
    pub visible: bool,
}

/// Create a durable programmable child and its fork relation atomically. The
/// caller supplies an operation-derived id, so retries return the same child;
/// reusing that id with a different payload fails closed.
pub async fn create_fork_conversation(
    pool: &SqlitePool,
    input: CreateForkConversation,
) -> Result<Uuid, ConversationServiceError> {
    let payload_digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&serde_json::json!({
            "parentConversationId": input.parent_conversation_id,
            "agentId": input.agent_id.as_str(),
            "title": input.title,
            "initialPrompt": input.initial_prompt,
            "visible": input.visible,
        }))?)
    );
    if ConversationRecord::find_by_id(pool, input.id)
        .await?
        .is_some()
    {
        let metadata = sqlx::query_scalar::<_, String>(
            "SELECT metadata_json FROM conversation_relations
             WHERE parent_conversation_id = ? AND child_conversation_id = ?
               AND kind = 'fork'",
        )
        .bind(input.parent_conversation_id)
        .bind(input.id)
        .fetch_optional(pool)
        .await?;
        if metadata
            .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
            .and_then(|value| value["payloadDigest"].as_str().map(str::to_string))
            .as_deref()
            == Some(payload_digest.as_str())
        {
            return Ok(input.id);
        }
        return Err(ConversationServiceError::Conflict(
            "conversation child operation id was reused with a different payload".to_string(),
        ));
    }
    let parent = ConversationRecord::find_by_id(pool, input.parent_conversation_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!(
                "Parent Conversation {} not found",
                input.parent_conversation_id
            ))
        })?;
    ensure_conversation_has_no_in_flight_turn(pool, &parent).await?;
    let relation = ConversationEvent::ConversationRelationCreated {
        relation_id: Uuid::new_v4(),
        parent_conversation_id: input.parent_conversation_id,
        child_conversation_id: input.id,
        relation_kind: agents::ConversationRelationKind::Fork,
        visibility: if input.visible {
            agents::ConversationRelationVisibility::Visible
        } else {
            agents::ConversationRelationVisibility::Hidden
        },
        metadata: serde_json::json!({ "payloadDigest": payload_digest }),
    };
    let normalized_json = serde_json::to_string(&relation)?;
    let relation_key = format!("conversation-relation-fork:{}", input.id);
    let session = CreateSession {
        executor: None,
        agent_id: Some(input.agent_id),
        task_id: parent.task_id,
        name: input.title,
        initial_prompt: input.initial_prompt,
        status: Some(SessionStatus::InProgress),
    };
    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
    let transaction = async {
        Session::create_on_connection(&mut conn, &session, input.id, parent.workspace_id)
            .await
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
        ConversationEventAppender::append_and_apply(
            &mut conn,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id: input.parent_conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "system",
                event_kind: "conversation_relation_created",
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: Some(&relation_key),
            },
        )
        .await?;
        Ok::<_, ConversationServiceError>(())
    }
    .await;
    match transaction {
        Ok(()) => sqlx::query("COMMIT").execute(&mut *conn).await?,
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(error);
        }
    };
    drop(conn);
    copy_conversation_history(pool, input.parent_conversation_id, input.id).await?;
    Ok(input.id)
}

async fn copy_conversation_history(
    pool: &SqlitePool,
    source_id: Uuid,
    destination_id: Uuid,
) -> Result<(), ConversationServiceError> {
    let events = db::models::conversation_event::ConversationEventRecord::events_since(
        pool,
        source_id,
        0,
        i64::MAX,
    )
    .await?;
    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
    let copied = async {
        let mut turn_map = HashMap::new();
        for record in events {
            let event: ConversationEvent = serde_json::from_str(&record.normalized_json)?;
            if matches!(
                event,
                ConversationEvent::ConversationRelationCreated { .. }
                    | ConversationEvent::ConversationCreated { .. }
                    | ConversationEvent::ConversationInput { .. }
                    | ConversationEvent::ConversationSteering { .. }
            ) {
                continue;
            }
            let new_turn_id = if let Some(old_turn_id) = record.turn_id {
                Some(
                    ensure_copied_turn(
                        &mut conn,
                        destination_id,
                        old_turn_id,
                        &event,
                        &mut turn_map,
                    )
                    .await?,
                )
            } else {
                None
            };
            let copy_key = format!(
                "fork-copy:{destination_id}:{}",
                record
                    .idempotency_key
                    .as_deref()
                    .map(str::to_owned)
                    .unwrap_or_else(|| record.sequence.to_string())
            );
            ConversationEventAppender::append_and_apply(
                &mut conn,
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id: destination_id,
                    turn_id: new_turn_id,
                    binding_id: None,
                    connection_id: record.connection_id.as_deref(),
                    prompt_id: record.prompt_id.as_deref(),
                    source: "import",
                    event_kind: &record.event_kind,
                    normalized_json: &record.normalized_json,
                    raw_json: record.raw_json.as_deref(),
                    idempotency_key: Some(&copy_key),
                },
            )
            .await?;
        }
        Ok::<_, ConversationServiceError>(())
    }
    .await;
    match copied {
        Ok(()) => {
            sqlx::query("COMMIT").execute(&mut *conn).await?;
            Ok(())
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(error)
        }
    }
}

async fn ensure_copied_turn(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    old_turn_id: Uuid,
    event: &ConversationEvent,
    turn_map: &mut HashMap<Uuid, Uuid>,
) -> Result<Uuid, ConversationServiceError> {
    if let Some(existing) = turn_map.get(&old_turn_id) {
        return Ok(*existing);
    }
    let new_turn_id = Uuid::new_v4();
    let text_preview = match event {
        ConversationEvent::UserTurnCreated { blocks, .. } => blocks.iter().find_map(|block| {
            if let agents::conversation::ConversationInputBlock::Text { text } = block {
                Some(text.as_str())
            } else {
                None
            }
        }),
        _ => None,
    };
    ConversationTurnRecord::create_pending_on_connection(
        conn,
        new_turn_id,
        CreateConversationTurn {
            conversation_id,
            prompt_id: None,
            text_preview,
            input_blocks_json: "[]",
        },
    )
    .await?;
    turn_map.insert(old_turn_id, new_turn_id);
    Ok(new_turn_id)
}

pub async fn create_workflow_conversation(
    pool: &SqlitePool,
    input: CreateWorkflowConversation,
) -> Result<Uuid, ConversationServiceError> {
    if let Some(existing) = ConversationRecord::find_by_id(pool, input.id).await? {
        if existing.workspace_id == input.workspace_id {
            return Ok(input.id);
        }
        return Err(ConversationServiceError::Conflict(format!(
            "Workflow child Conversation {} already belongs to another workspace",
            input.id
        )));
    }
    let relation = ConversationEvent::ConversationRelationCreated {
        relation_id: Uuid::new_v4(),
        parent_conversation_id: input.parent_conversation_id,
        child_conversation_id: input.id,
        relation_kind: agents::ConversationRelationKind::WorkflowStep,
        visibility: if input.visible {
            agents::ConversationRelationVisibility::Visible
        } else {
            agents::ConversationRelationVisibility::Hidden
        },
        metadata: serde_json::json!({
            "workflowRunId": input.workflow_run_id,
            "workflowStepId": &input.workflow_step_id,
        }),
    };
    let normalized_json = serde_json::to_string(&relation)?;
    let relation_key = format!(
        "conversation-relation-workflow:{}:{}:{}",
        input.workflow_run_id, input.workflow_step_id, input.id
    );
    let session = CreateSession {
        executor: None,
        agent_id: Some(input.agent_id),
        task_id: None,
        name: Some(format!("Workflow · {}", input.workflow_step_id)),
        initial_prompt: Some(input.prompt),
        status: Some(SessionStatus::InProgress),
    };
    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
    let transaction = async {
        Session::create_on_connection(&mut conn, &session, input.id, input.workspace_id)
            .await
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
        ConversationEventAppender::append_and_apply(
            &mut conn,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id: input.parent_conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "system",
                event_kind: "conversation_relation_created",
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: Some(&relation_key),
            },
        )
        .await?;
        Ok::<_, ConversationServiceError>(())
    }
    .await;
    match transaction {
        Ok(()) => sqlx::query("COMMIT").execute(&mut *conn).await?,
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(error);
        }
    };
    Ok(input.id)
}

/// Create the durable one-shot child Conversation before launching its first
/// turn. The link is committed in the same insert as the child identity so
/// projection rebuild and DB fallback never observe an unlinked child.
pub async fn create_delegated_conversation(
    pool: &SqlitePool,
    input: CreateDelegatedConversation,
) -> Result<Uuid, ConversationServiceError> {
    let parent = ConversationRecord::find_by_id(pool, input.parent_conversation_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!(
                "Parent Conversation {} not found",
                input.parent_conversation_id
            ))
        })?;
    let relation_id = Uuid::new_v4();
    let relation = ConversationEvent::ConversationRelationCreated {
        relation_id,
        parent_conversation_id: input.parent_conversation_id,
        child_conversation_id: input.id,
        relation_kind: agents::ConversationRelationKind::Delegation,
        visibility: agents::ConversationRelationVisibility::Visible,
        metadata: serde_json::json!({
            "parentToolCallId": &input.parent_tool_call_id,
            "delegationId": &input.delegation_id,
            "policy": &input.policy,
        }),
    };
    let normalized_json = serde_json::to_string(&relation)?;
    let relation_key = format!("conversation-relation-delegation:{}", input.id);
    let turn_id = Uuid::new_v4();
    let conversation_blocks = vec![ConversationInputBlock::Text {
        text: input.prompt.clone(),
    }];
    let conversation_blocks_json = serde_json::to_string(&conversation_blocks)?;
    let created_event = ConversationEvent::UserTurnCreated {
        blocks: conversation_blocks,
        workflow_refs: Vec::new(),
    };
    let created_json = serde_json::to_string(&created_event)?;
    let created_key = format!("turn:{turn_id}:created");
    let session = CreateSession {
        executor: None,
        agent_id: Some(input.agent_id),
        task_id: parent.task_id,
        name: None,
        initial_prompt: Some(input.prompt.clone()),
        status: Some(SessionStatus::InProgress),
    };
    let mut conn = pool.acquire().await?;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
    let transaction = async {
        Session::create_with_delegation_on_connection(
            &mut conn,
            &session,
            input.id,
            parent.workspace_id,
            input.parent_conversation_id,
            &input.parent_tool_call_id,
            &input.delegation_id,
        )
        .await
        .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
        ConversationTurnRecord::create_pending_on_connection(
            &mut conn,
            turn_id,
            CreateConversationTurn {
                conversation_id: input.id,
                prompt_id: None,
                text_preview: Some(&input.prompt),
                input_blocks_json: &conversation_blocks_json,
            },
        )
        .await?;
        ConversationRecord::update_active_turn_on_connection(&mut conn, input.id, Some(turn_id))
            .await?;
        ConversationEventAppender::append_and_apply(
            &mut conn,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id: input.id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "user",
                event_kind: "user_turn_created",
                normalized_json: &created_json,
                raw_json: None,
                idempotency_key: Some(&created_key),
            },
        )
        .await?;
        ConversationEventAppender::append_and_apply(
            &mut conn,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id: input.parent_conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "system",
                event_kind: "conversation_relation_created",
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: Some(&relation_key),
            },
        )
        .await?;
        Ok::<_, ConversationServiceError>(())
    }
    .await;
    match transaction {
        Ok(()) => {
            if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                return Err(error.into());
            }
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            return Err(error);
        }
    }
    Ok(input.id)
}

/// Injected src-tauri-coupled operations the turn lifecycle needs but that don't
/// belong in this crate (workspace path resolution, prompt-block building from the
/// workspace, agent launch settings). Implemented in the shell (`AppState`).
#[async_trait::async_trait]
pub trait ConversationHost: Send + Sync {
    fn resolve_working_dir(
        &self,
        workspace: &Workspace,
        container_ref: &str,
        repos: &[Repo],
    ) -> Option<String>;
    fn resolve_additional_directories(
        &self,
        workspace: &Workspace,
        container_ref: &str,
        repos: &[Repo],
        working_dir: &str,
    ) -> Vec<PathBuf>;
    async fn build_prompt_blocks(
        &self,
        working_dir: &str,
        text: String,
        images: &[String],
        file_refs: &[agents::ConversationFileRef],
    ) -> Result<Vec<AgentContentBlock>, ConversationServiceError>;
    async fn launch_settings(
        &self,
        pool: &SqlitePool,
        agent_id: &agents::AgentId,
    ) -> Result<AgentRuntimeLaunchSettings, ConversationServiceError>;

    /// Product MCP identities Host will deliver on this session new/resume/rebind.
    fn product_mcp_server_names(&self) -> Vec<String> {
        Vec::new()
    }
}

/// Receives a durable conversation event immediately after its append transaction
/// commits. The desktop shell uses this boundary to publish row operations before
/// orchestration can trigger any causally-later Agent work; headless compositions
/// can keep the default no-op implementation and serve projections on demand.
#[async_trait::async_trait]
pub trait ConversationEventPublisher: Send + Sync {
    async fn publish(&self, record: &db::models::conversation_event::ConversationEventRecord);
}

#[derive(Debug, Default)]
pub struct NoopConversationEventPublisher;

#[async_trait::async_trait]
impl ConversationEventPublisher for NoopConversationEventPublisher {
    async fn publish(&self, _record: &db::models::conversation_event::ConversationEventRecord) {}
}

/// Everything the orchestration core needs from the shell, decoupled from AppState.
#[derive(Clone)]
pub struct ConversationContext {
    pub deployment: Arc<dyn Deployment>,
    pub agent_runtime: Arc<AgentRuntime>,
    pub turn_locks: Arc<Mutex<HashMap<Uuid, Arc<Mutex<()>>>>>,
    pub runtime_states: Arc<Mutex<HashMap<Uuid, ConversationRuntimeState>>>,
    /// Per-conversation live incremental row projectors, dropped when a conversation
    /// closes (`forget_conversation_runtime`). Owned by the shell's `AppState`.
    pub row_projectors: crate::ConversationRowProjectors,
    pub host: Arc<dyn ConversationHost>,
    pub event_publisher: Arc<dyn ConversationEventPublisher>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRuntimeState {
    pub conversation_id: Option<Uuid>,
    pub binding_id: Option<Uuid>,
    pub acp_session_id: Option<String>,
    pub connection_id: Option<String>,
    pub active_turn_id: Option<Uuid>,
    pub active_prompt_id: Option<String>,
    pub live_message: Option<String>,
    pub active_tool_call_ids: Vec<String>,
    pub pending_permission_id: Option<String>,
    pub pending_question_id: Option<String>,
    pub active_delegation_ids: Vec<String>,
    pub current_mode: Option<String>,
    pub event_sequence: i64,
    pub pending_user_message: Option<String>,
    #[serde(default)]
    pub commit_reminder_pending: bool,
    pub turn_in_flight: bool,
    pub config_stale: bool,
    pub connection_status: Option<String>,
    pub recovery_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConversationTurnSnapshot {
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<Uuid>,
    pub status: String,
    pub last_sequence: i64,
}

pub struct ConversationStartTurnInput {
    pub agent_id: AgentId,
    pub workspace_id: Uuid,
    pub conversation_id: Uuid,
    pub executor_profile_id: Option<ExecutorProfileId>,
    pub text: String,
    pub display_text: Option<String>,
    pub images: Vec<String>,
    /// User-selected session mode for this turn (from the composer's mode
    /// picker, sourced from the agent's advertised `session_modes`). Applied via
    /// the real ACP `SetSessionMode` during prompt setup. `None` keeps the
    /// profile/default mode.
    pub mode_override: Option<String>,
    /// User-selected config option overrides for this turn (real ACP
    /// `SetSessionConfigOption`), e.g. an advertised select option.
    pub config_overrides: Vec<AgentSessionConfigOverride>,
    /// Structured workflow identities retained in the durable turn event.
    pub workflow_refs: Vec<ConversationWorkflowRef>,
    pub file_refs: Vec<agents::ConversationFileRef>,
    /// Present only when this turn was claimed from the durable input queue.
    /// InputDispatched(input -> turn) is persisted before any Agent prompt send.
    pub queued_input_claim: Option<QueuedConversationInputClaim>,
    /// Optional client operation id so a retried start/submit stays one input.
    pub operation_id: Option<Uuid>,
}

#[derive(Debug, Clone, Copy)]
pub struct QueuedConversationInputClaim {
    pub input_id: Uuid,
    pub claim_token: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ConversationSteeringStatus {
    Requested,
    Accepted,
    Rejected,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ConversationSteeringReceipt {
    pub steering_id: Uuid,
    pub conversation_id: Uuid,
    pub operation_id: Uuid,
    pub expected_turn_id: Uuid,
    pub status: ConversationSteeringStatus,
    pub code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ConversationSteerInput {
    pub conversation_id: Uuid,
    pub operation_id: Uuid,
    pub expected_turn_id: Uuid,
    pub text: String,
    pub images: Vec<String>,
    pub principal: serde_json::Value,
}

enum SteeringSettlement {
    Accepted,
    Rejected { code: &'static str, message: String },
    Unknown { message: String },
}

#[derive(Debug, Clone, Default)]
struct AgentPromptOverrides {
    mode_override: Option<String>,
    config_overrides: Vec<AgentSessionConfigOverride>,
}

pub struct ConversationSessionService {
    ctx: ConversationContext,
}

impl ConversationSessionService {
    pub fn new(ctx: ConversationContext) -> Self {
        Self { ctx }
    }

    pub async fn start_turn(
        &self,
        input: ConversationStartTurnInput,
    ) -> Result<(ConversationTurnSnapshot, AgentPromptSnapshot), ConversationServiceError> {
        self.start_turn_with_origin(input, crate::commit_reminder::USER_ORIGIN)
            .await
    }

    pub async fn start_turn_with_origin(
        &self,
        input: ConversationStartTurnInput,
        origin: &str,
    ) -> Result<(ConversationTurnSnapshot, AgentPromptSnapshot), ConversationServiceError> {
        if input.queued_input_claim.is_none() {
            let conversation_id = input.conversation_id;
            let submission = self.submit_and_dispatch(input, origin).await?;
            if let Some(turn) = submission.turn {
                return Ok((turn, unused_prompt_snapshot(conversation_id)));
            }
            return Ok((
                queued_turn_snapshot(conversation_id),
                unused_prompt_snapshot(conversation_id),
            ));
        }
        let turn_lock = self.turn_lock(input.conversation_id).await;
        let _turn_guard = turn_lock.lock().await;
        self.start_turn_under_lock(input, origin).await
    }

    /// Persist a durable input, then claim/dispatch if the conversation is idle.
    /// Persist is the user-visible success boundary (ADR-0044).
    pub async fn submit_and_dispatch(
        &self,
        input: ConversationStartTurnInput,
        origin: &str,
    ) -> Result<ConversationInputSubmission, ConversationServiceError> {
        let conversation_id = input.conversation_id;
        let inputs = ConversationInputControl::with_publisher(
            self.ctx.deployment.db().pool.clone(),
            self.ctx.event_publisher.clone(),
        );
        let submitted = inputs
            .submit(SubmitConversationInput {
                conversation_id,
                operation_id: input.operation_id.unwrap_or_else(Uuid::new_v4),
                payload: start_turn_input_payload(&input)?,
                principal: serde_json::json!({ "kind": "origin", "origin": origin }),
            })
            .await?;
        let dispatched = match self.dispatch_next_queued_input(conversation_id).await {
            Ok(turn) => turn,
            Err(error) => {
                tracing::warn!(
                    %conversation_id,
                    input_id = %submitted.id,
                    %error,
                    "durable conversation input was accepted; dispatch will retry later"
                );
                None
            }
        };
        let input = inputs.find(conversation_id, submitted.id).await?;
        let turn = match (dispatched, input.turn_id) {
            (Some(turn), _) => Some(turn),
            (None, Some(turn_id)) => self.turn_snapshot(turn_id).await?,
            (None, None) => None,
        };
        Ok(ConversationInputSubmission { input, turn })
    }

    async fn start_turn_under_lock(
        &self,
        input: ConversationStartTurnInput,
        origin: &str,
    ) -> Result<(ConversationTurnSnapshot, AgentPromptSnapshot), ConversationServiceError> {
        let display_text = input
            .display_text
            .as_deref()
            .unwrap_or(&input.text)
            .to_string();
        if display_text.trim().is_empty() && input.images.is_empty() {
            return Err(ConversationServiceError::BadRequest(
                "Prompt must include text or an image".to_string(),
            ));
        }
        if input.text.trim().is_empty() && input.images.is_empty() {
            return Err(ConversationServiceError::BadRequest(
                "Agent prompt must include text or an image".to_string(),
            ));
        }
        self.interrupt_orphaned_turn(input.conversation_id).await?;

        let pool = &self.ctx.deployment.db().pool;
        let workspace = Workspace::find_by_id(pool, input.workspace_id)
            .await?
            .ok_or_else(|| {
                ConversationServiceError::NotFound(format!(
                    "Workspace {} not found",
                    input.workspace_id
                ))
            })?;
        let container_ref = self
            .ctx
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await?;
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
        let working_dir = self
            .ctx
            .host
            .resolve_working_dir(&workspace, &container_ref, &repos)
            .unwrap_or_else(|| container_ref.clone());
        let additional_directories = self.ctx.host.resolve_additional_directories(
            &workspace,
            &container_ref,
            &repos,
            &working_dir,
        );
        let smart_reminder = crate::commit_reminder::pending_smart_reminder_prompt(
            &self.ctx,
            input.conversation_id,
            workspace.clone(),
            origin,
        )
        .await?;
        let agent_text = match smart_reminder.as_deref() {
            Some(reminder) if !input.text.trim().is_empty() => {
                format!("{}\n\n{}", input.text, reminder)
            }
            Some(reminder) => reminder.to_string(),
            None => input.text.clone(),
        };
        let agent_blocks = self
            .ctx
            .host
            .build_prompt_blocks(&working_dir, agent_text, &input.images, &input.file_refs)
            .await?;
        let conversation_blocks =
            conversation_input_blocks_with_display_text(&agent_blocks, &display_text);

        let conversation = self
            .ensure_conversation(pool, &input, &display_text)
            .await?;
        ensure_conversation_has_no_in_flight_turn(pool, &conversation).await?;
        let turn_id = Uuid::new_v4();
        let conversation_blocks_json = serde_json::to_string(&conversation_blocks)
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
        let created_event = ConversationEvent::UserTurnCreated {
            blocks: conversation_blocks,
            workflow_refs: input.workflow_refs.clone(),
        };

        let (turn, created) = if let Some(claim) = input.queued_input_claim {
            // The durable input is the acceptance boundary. Its claim, the Turn row,
            // active-turn pointer, and both causal events therefore commit together.
            // Agent I/O begins only after this transaction has committed and published.
            let dispatched_event = ConversationEvent::ConversationInput {
                event: agents::ConversationInputEvent::Dispatched {
                    input_id: claim.input_id,
                    claim_token: claim.claim_token,
                    turn_id,
                },
            };
            let dispatched_json = serde_json::to_string(&dispatched_event)
                .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
            let created_json = serde_json::to_string(&created_event)
                .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
            let dispatched_key = format!("conversation-input:{}:dispatched", claim.input_id);
            let created_key = format!("turn:{turn_id}:created");
            let dispatched_id = Uuid::new_v4();
            let created_id = Uuid::new_v4();
            let mut conn = pool.acquire().await?;
            sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
            let transaction = async {
                let active_status: Option<String> = sqlx::query_scalar(
                    r#"SELECT status
                       FROM conversation_turns
                       WHERE id = (
                           SELECT active_turn_id FROM sessions WHERE id = ?
                       )"#,
                )
                .bind(input.conversation_id)
                .fetch_optional(&mut *conn)
                .await?;
                if active_status
                    .as_deref()
                    .is_some_and(is_in_flight_turn_status)
                {
                    return Err(ConversationServiceError::Conflict(
                        "Conversation already has an active turn".to_string(),
                    ));
                }

                ConversationRecord::capture_initial_prompt_on_connection(
                    &mut conn,
                    input.conversation_id,
                    &display_text,
                )
                .await?;
                let turn = ConversationTurnRecord::create_pending_on_connection(
                    &mut conn,
                    turn_id,
                    CreateConversationTurn {
                        conversation_id: input.conversation_id,
                        prompt_id: None,
                        text_preview: Some(&display_text),
                        input_blocks_json: &conversation_blocks_json,
                    },
                )
                .await?;
                if origin != crate::commit_reminder::USER_ORIGIN {
                    ConversationTurnRecord::set_origin_on_connection(&mut conn, turn.id, origin)
                        .await?;
                }
                ConversationRecord::update_active_turn_on_connection(
                    &mut conn,
                    input.conversation_id,
                    Some(turn.id),
                )
                .await?;
                let dispatched = ConversationEventAppender::append_and_apply(
                    &mut conn,
                    AppendConversationEvent {
                        id: dispatched_id,
                        conversation_id: input.conversation_id,
                        turn_id: Some(turn.id),
                        binding_id: None,
                        connection_id: None,
                        prompt_id: None,
                        source: "system",
                        event_kind: "conversation_input",
                        normalized_json: &dispatched_json,
                        raw_json: None,
                        idempotency_key: Some(&dispatched_key),
                    },
                )
                .await?;
                let created = ConversationEventAppender::append_and_apply(
                    &mut conn,
                    AppendConversationEvent {
                        id: created_id,
                        conversation_id: input.conversation_id,
                        turn_id: Some(turn.id),
                        binding_id: None,
                        connection_id: None,
                        prompt_id: None,
                        source: "user",
                        event_kind: "user_turn_created",
                        normalized_json: &created_json,
                        raw_json: None,
                        idempotency_key: Some(&created_key),
                    },
                )
                .await?;
                Ok::<_, ConversationServiceError>((turn, dispatched, created))
            }
            .await;
            let (turn, dispatched, created) = match transaction {
                Ok(committed) => {
                    if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
                        let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                        return Err(error.into());
                    }
                    committed
                }
                Err(error) => {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                    return Err(error);
                }
            };
            drop(conn);
            self.ctx.event_publisher.publish(&dispatched).await;
            self.ctx.event_publisher.publish(&created).await;
            (turn, created)
        } else {
            ConversationRecord::capture_initial_prompt(pool, input.conversation_id, &display_text)
                .await?;
            let turn = ConversationTurnRecord::create_pending(
                pool,
                turn_id,
                CreateConversationTurn {
                    conversation_id: input.conversation_id,
                    prompt_id: None,
                    text_preview: Some(&display_text),
                    input_blocks_json: &conversation_blocks_json,
                },
            )
            .await?;
            crate::workbench_status::reconcile(pool, input.conversation_id).await?;
            if origin != crate::commit_reminder::USER_ORIGIN {
                ConversationTurnRecord::set_origin(pool, turn.id, origin).await?;
            }
            ConversationRecord::update_active_turn(pool, input.conversation_id, Some(turn.id))
                .await?;
            let created = self
                .append_event(
                    input.conversation_id,
                    Some(turn.id),
                    "user",
                    created_event,
                    Some(format!("turn:{}:created", turn.id)),
                )
                .await?;
            (turn, created)
        };

        self.update_runtime_state(input.conversation_id, |state| {
            state.conversation_id = Some(input.conversation_id);
            state.active_turn_id = Some(turn.id);
            state.pending_user_message = Some(display_text.clone());
            state.turn_in_flight = true;
            state.event_sequence = created.sequence;
        })
        .await;

        let result = self
            .send_turn_to_agent(
                &input,
                &working_dir,
                &additional_directories,
                agent_blocks,
                turn.id,
            )
            .await;

        match result {
            Ok(prompt) => {
                if smart_reminder.is_some() {
                    crate::commit_reminder::clear_pending_smart_reminder(
                        &self.ctx,
                        input.conversation_id,
                    )
                    .await;
                }
                self.append_event(
                    input.conversation_id,
                    Some(turn.id),
                    "runtime",
                    ConversationEvent::UserTurnStarted,
                    Some(format!("turn:{}:started", turn.id)),
                )
                .await?;
                let prompt_uuid = prompt.id.0;
                ConversationTurnRecord::set_prompt_id(pool, turn.id, &prompt.id.to_string())
                    .await?;
                self.update_runtime_state(input.conversation_id, |state| {
                    state.active_prompt_id = Some(prompt.id.to_string());
                })
                .await;
                Ok((
                    ConversationTurnSnapshot {
                        conversation_id: input.conversation_id,
                        turn_id: turn.id,
                        prompt_id: Some(prompt_uuid),
                        status: "running".to_string(),
                        last_sequence: created.sequence + 1,
                    },
                    prompt,
                ))
            }
            Err(error) => {
                if matches!(error, ConversationServiceError::AuthenticationRequired(_)) {
                    let blocked = self
                        .append_event(
                            input.conversation_id,
                            Some(turn.id),
                            "runtime",
                            ConversationEvent::TurnBlocked {
                                reason: agents::conversation::TurnBlockedReason::Authentication {
                                    message: error.to_string(),
                                },
                            },
                            Some(format!("turn:{}:auth_required", turn.id)),
                        )
                        .await?;
                    self.update_runtime_state(input.conversation_id, |state| {
                        state.event_sequence = blocked.sequence;
                        state.recovery_status = Some("auth_required".to_string());
                    })
                    .await;
                    return Err(error);
                }
                let failed = self
                    .append_event(
                        input.conversation_id,
                        Some(turn.id),
                        "runtime",
                        ConversationEvent::TurnFailed {
                            error: error
                                .turn_failure()
                                .with_cached_plan_usage(Some(&input.agent_id)),
                        },
                        Some(format!("turn:{}:send_failed", turn.id)),
                    )
                    .await?;
                self.update_runtime_state(input.conversation_id, |state| {
                    state.turn_in_flight = false;
                    state.event_sequence = failed.sequence;
                    state.recovery_status = Some("send_failed".to_string());
                })
                .await;
                Err(error)
            }
        }
    }

    async fn turn_lock(&self, conversation_id: Uuid) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.ctx.turn_locks.lock().await;
        Arc::clone(
            locks
                .entry(conversation_id)
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    /// Dispatch exactly one durable queued input when the conversation is idle.
    /// The per-conversation turn lock covers idle-check -> claim -> Turn creation,
    /// so concurrent host/remote dispatchers cannot strand a second claim.
    pub async fn dispatch_next_queued_input(
        &self,
        conversation_id: Uuid,
    ) -> Result<Option<ConversationTurnSnapshot>, ConversationServiceError> {
        let turn_lock = self.turn_lock(conversation_id).await;
        let _turn_guard = turn_lock.lock().await;
        let pool = &self.ctx.deployment.db().pool;
        let conversation = ConversationRecord::find_by_id(pool, conversation_id)
            .await?
            .ok_or_else(|| {
                ConversationServiceError::NotFound(format!(
                    "Conversation {conversation_id} not found"
                ))
            })?;
        if let Some(active_turn_id) = conversation.active_turn_id
            && let Some(active_turn) =
                ConversationTurnRecord::find_by_id(pool, active_turn_id).await?
            && is_in_flight_turn_status(&active_turn.status)
        {
            return Ok(None);
        }

        let inputs = ConversationInputControl::with_publisher(
            pool.clone(),
            self.ctx.event_publisher.clone(),
        );
        let released_claims = inputs.recover_stale_claims(Utc::now()).await?;
        if released_claims > 0 {
            tracing::info!(
                %conversation_id,
                released_claims,
                "released expired conversation input claims before dispatch"
            );
        }
        let Some(claim) = inputs
            .claim_next(conversation_id, chrono::Duration::seconds(30))
            .await?
        else {
            return Ok(None);
        };
        let input_id = claim.input.id;
        let claim_token = claim.claim_token;
        let payload = claim.input.payload;
        let executor_profile_id = payload
            .executor_profile_id
            .map(serde_json::from_value::<ExecutorProfileId>)
            .transpose()
            .map_err(|error| ConversationServiceError::BadRequest(error.to_string()));
        let executor_profile_id = match executor_profile_id {
            Ok(profile) => profile,
            Err(error) => {
                inputs
                    .release_claim(conversation_id, input_id, claim_token)
                    .await?;
                return Err(error);
            }
        };
        let result = self
            .start_turn_under_lock(
                ConversationStartTurnInput {
                    agent_id: payload.agent_id,
                    workspace_id: payload.workspace_id,
                    conversation_id,
                    executor_profile_id,
                    text: payload.text,
                    display_text: payload.display_text,
                    images: payload.images,
                    mode_override: payload.mode_override,
                    config_overrides: payload.config_overrides,
                    workflow_refs: payload.workflow_refs,
                    file_refs: payload.file_refs,
                    queued_input_claim: Some(QueuedConversationInputClaim {
                        input_id,
                        claim_token,
                    }),
                    operation_id: None,
                },
                crate::commit_reminder::LOCAL_USER_ORIGIN,
            )
            .await;
        match result {
            Ok((turn, _)) => Ok(Some(turn)),
            Err(error) => {
                let current = inputs.find(conversation_id, input_id).await?;
                if current.status == ConversationInputStatus::Claimed {
                    inputs
                        .release_claim(conversation_id, input_id, claim_token)
                        .await?;
                }
                Err(error)
            }
        }
    }

    /// Read a durable Turn snapshot for idempotent command retries. This does
    /// not consult the in-memory runtime state.
    pub async fn turn_snapshot(
        &self,
        turn_id: Uuid,
    ) -> Result<Option<ConversationTurnSnapshot>, ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let Some(turn) = ConversationTurnRecord::find_by_id(pool, turn_id).await? else {
            return Ok(None);
        };
        let last_sequence = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(sequence), 0)
             FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(turn.conversation_id)
        .fetch_one(pool)
        .await?;
        Ok(Some(ConversationTurnSnapshot {
            conversation_id: turn.conversation_id,
            turn_id: turn.id,
            prompt_id: turn
                .prompt_id
                .as_deref()
                .and_then(|value| Uuid::parse_str(value).ok()),
            status: turn.status,
            last_sequence,
        }))
    }

    /// Inject guidance into exactly one currently active Turn. This never
    /// falls back to queueing or starting a new Turn: the caller receives a
    /// durable accepted/rejected/unknown receipt for the negotiated wire call.
    pub async fn steer(
        &self,
        input: ConversationSteerInput,
    ) -> Result<ConversationSteeringReceipt, ConversationServiceError> {
        if input.text.trim().is_empty() && input.images.is_empty() {
            return Err(ConversationServiceError::BadRequest(
                "Steering input must include text or an image".to_string(),
            ));
        }
        let payload_digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&serde_json::json!({
                "text": &input.text,
                "images": &input.images,
            }))?)
        );
        let pool = &self.ctx.deployment.db().pool;
        if let Some(existing) = ConversationSteeringRecord::find_by_operation(
            pool,
            input.conversation_id,
            input.operation_id,
        )
        .await?
        {
            let principal = serde_json::from_str::<serde_json::Value>(&existing.principal_json)?;
            if existing.expected_turn_id != input.expected_turn_id
                || existing.payload_digest != payload_digest
                || principal != input.principal
            {
                return Err(ConversationServiceError::Conflict(format!(
                    "Steering operation {} was retried with different intent",
                    input.operation_id
                )));
            }
            return steering_receipt(existing);
        }

        let conversation = ConversationRecord::find_by_id(pool, input.conversation_id)
            .await?
            .ok_or_else(|| {
                ConversationServiceError::NotFound(format!(
                    "Conversation {} not found",
                    input.conversation_id
                ))
            })?;
        let active_turn_id = conversation.active_turn_id.ok_or_else(|| {
            ConversationServiceError::Conflict("Conversation has no active Turn".to_string())
        })?;
        if active_turn_id != input.expected_turn_id {
            return Err(ConversationServiceError::Conflict(format!(
                "Active Turn changed: expected {}, active is {}",
                input.expected_turn_id, active_turn_id
            )));
        }
        let active_turn = ConversationTurnRecord::find_by_id(pool, active_turn_id)
            .await?
            .ok_or_else(|| {
                ConversationServiceError::NotFound(format!("Turn {active_turn_id} not found"))
            })?;
        if !is_in_flight_turn_status(&active_turn.status) {
            return Err(ConversationServiceError::Conflict(format!(
                "Turn {active_turn_id} is no longer active"
            )));
        }

        let workspace = Workspace::find_by_id(pool, conversation.workspace_id)
            .await?
            .ok_or_else(|| {
                ConversationServiceError::NotFound(format!(
                    "Workspace {} not found",
                    conversation.workspace_id
                ))
            })?;
        let container_ref = self
            .ctx
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await?;
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
        let working_dir = self
            .ctx
            .host
            .resolve_working_dir(&workspace, &container_ref, &repos)
            .unwrap_or(container_ref);
        let agent_blocks = self
            .ctx
            .host
            .build_prompt_blocks(&working_dir, input.text.clone(), &input.images, &[])
            .await?;
        let visible_blocks =
            conversation_input_blocks_with_display_text(&agent_blocks, &input.text);
        let steering_id = Uuid::new_v4();
        self.append_event(
            input.conversation_id,
            Some(input.expected_turn_id),
            "user",
            ConversationEvent::ConversationSteering {
                event: agents::ConversationSteeringEvent::Requested {
                    steering_id,
                    operation_id: input.operation_id,
                    expected_turn_id: input.expected_turn_id,
                    payload_digest,
                    blocks: visible_blocks,
                    principal: input.principal,
                },
            },
            Some(format!(
                "conversation-steering-operation:{}",
                input.operation_id
            )),
        )
        .await?;

        let runtime_session_id = AgentSessionId(input.conversation_id);
        let runtime = self.runtime_snapshot(input.conversation_id).await;
        let connection_id = runtime
            .connection_id
            .as_deref()
            .and_then(parse_agent_connection_id);
        let prompt_id = runtime
            .active_prompt_id
            .as_deref()
            .and_then(parse_agent_prompt_id);
        if runtime.active_turn_id != Some(input.expected_turn_id)
            || connection_id.is_none()
            || prompt_id.is_none()
        {
            return self
                .settle_steering(
                    input.conversation_id,
                    steering_id,
                    input.expected_turn_id,
                    SteeringSettlement::Rejected {
                        code: "turn_not_live",
                        message: "The expected Turn is not live on this host".to_string(),
                    },
                )
                .await;
        }
        let controls = self
            .ctx
            .agent_runtime
            .session_controls_snapshot(runtime_session_id)
            .await;
        if !controls
            .as_ref()
            .ok()
            .and_then(|controls| controls.capabilities.as_ref())
            .is_some_and(|capabilities| capabilities.steering)
        {
            return self
                .settle_steering(
                    input.conversation_id,
                    steering_id,
                    input.expected_turn_id,
                    SteeringSettlement::Rejected {
                        code: "steering_unsupported",
                        message: "Agent did not negotiate in-flight steering".to_string(),
                    },
                )
                .await;
        }

        let result = self
            .ctx
            .agent_runtime
            .steer_prompt(SteerAgentPromptInput {
                connection_id: connection_id.expect("checked above"),
                session_id: runtime_session_id,
                expected_prompt_id: prompt_id.expect("checked above"),
                blocks: agent_blocks,
            })
            .await;
        let settlement = match result {
            Ok(receipt) => match receipt.outcome {
                agents::AgentSteerOutcome::Injected => SteeringSettlement::Accepted,
                agents::AgentSteerOutcome::PromptRequired => SteeringSettlement::Rejected {
                    code: "no_running_turn",
                    message: receipt
                        .reason
                        .unwrap_or_else(|| "Agent found no running Turn".to_string()),
                },
                agents::AgentSteerOutcome::StartedNewTurn => SteeringSettlement::Unknown {
                    message: "Agent started a new Turn despite promptRequired fallback policy"
                        .to_string(),
                },
            },
            Err(agents::AgentError::SteeringUnsupported) => SteeringSettlement::Rejected {
                code: "steering_unsupported",
                message: "Agent did not negotiate in-flight steering".to_string(),
            },
            Err(agents::AgentError::PromptConflict { .. })
            | Err(agents::AgentError::PromptNotFound(_)) => SteeringSettlement::Rejected {
                code: "turn_conflict",
                message: "The expected Turn is no longer active".to_string(),
            },
            Err(error) => SteeringSettlement::Unknown {
                message: error.to_string(),
            },
        };
        self.settle_steering(
            input.conversation_id,
            steering_id,
            input.expected_turn_id,
            settlement,
        )
        .await
    }

    async fn settle_steering(
        &self,
        conversation_id: Uuid,
        steering_id: Uuid,
        expected_turn_id: Uuid,
        settlement: SteeringSettlement,
    ) -> Result<ConversationSteeringReceipt, ConversationServiceError> {
        let event = match settlement {
            SteeringSettlement::Accepted => agents::ConversationSteeringEvent::Accepted {
                steering_id,
                expected_turn_id,
            },
            SteeringSettlement::Rejected { code, message } => {
                agents::ConversationSteeringEvent::Rejected {
                    steering_id,
                    expected_turn_id,
                    code: code.to_string(),
                    message,
                }
            }
            SteeringSettlement::Unknown { message } => agents::ConversationSteeringEvent::Unknown {
                steering_id,
                expected_turn_id,
                message,
            },
        };
        self.append_event(
            conversation_id,
            Some(expected_turn_id),
            "runtime",
            ConversationEvent::ConversationSteering { event },
            Some(format!("conversation-steering:{steering_id}:settled")),
        )
        .await?;
        let record = ConversationSteeringRecord::find_by_id(
            &self.ctx.deployment.db().pool,
            conversation_id,
            steering_id,
        )
        .await?
        .ok_or_else(|| {
            ConversationServiceError::Internal(format!(
                "Steering receipt {steering_id} projection is missing"
            ))
        })?;
        steering_receipt(record)
    }

    pub async fn respond_permission(
        &self,
        conversation_id: Uuid,
        permission_id: String,
        response: AgentPermissionResponse,
    ) -> Result<(), ConversationServiceError> {
        let (connection_id, turn_id) = self
            .runtime_connection_and_turn(conversation_id)
            .await
            .ok_or_else(|| {
                ConversationServiceError::BadRequest(
                    "Conversation has no active Agent connection for permission response"
                        .to_string(),
                )
            })?;
        let permission_uuid = Uuid::parse_str(&permission_id).map_err(|error| {
            ConversationServiceError::BadRequest(format!(
                "invalid permission id `{permission_id}`: {error}"
            ))
        })?;
        self.ctx
            .agent_runtime
            .respond_permission(RespondAgentPermissionInput {
                connection_id,
                permission_id: AgentPermissionId(permission_uuid),
                response: response.clone(),
            })
            .await?;
        self.append_event(
            conversation_id,
            turn_id,
            "host",
            ConversationEvent::PermissionResponded {
                permission_id: permission_id.clone(),
                response: ConversationPermissionResponse {
                    response,
                    auto: false,
                },
            },
            Some(format!("permission:{permission_id}:responded")),
        )
        .await?;
        Ok(())
    }

    /// Answer a pending agent question (ACP elicitation). Mirrors
    /// [`Self::respond_permission`]: forward to the runtime (which unblocks the
    /// agent's `elicitation/create` request) and append the response event so
    /// the timeline row settles even if the runtime's own event races.
    pub async fn respond_question(
        &self,
        conversation_id: Uuid,
        question_id: String,
        response: AgentElicitationResponse,
    ) -> Result<(), ConversationServiceError> {
        let (connection_id, turn_id) = self
            .runtime_connection_and_turn(conversation_id)
            .await
            .ok_or_else(|| {
                ConversationServiceError::BadRequest(
                    "Conversation has no active Agent connection for question response".to_string(),
                )
            })?;
        let question_uuid = Uuid::parse_str(&question_id).map_err(|error| {
            ConversationServiceError::BadRequest(format!(
                "invalid question id `{question_id}`: {error}"
            ))
        })?;
        self.ctx
            .agent_runtime
            .respond_elicitation(RespondAgentElicitationInput {
                connection_id,
                elicitation_id: AgentElicitationId(question_uuid),
                response: response.clone(),
            })
            .await?;
        self.append_event(
            conversation_id,
            turn_id,
            "host",
            ConversationEvent::QuestionResponded {
                question_id: question_id.clone(),
                response: ConversationQuestionResponse {
                    answer: response.summary(),
                    content: match response {
                        AgentElicitationResponse::Accept { content } => Some(content),
                        _ => None,
                    },
                },
            },
            Some(format!("question:{question_id}:responded")),
        )
        .await?;
        Ok(())
    }

    /// Immediately switch the conversation's live session mode. Mode is a
    /// Config Option category; the ACP adapter translates the intent to
    /// `session/set_mode` or `session/set_config_option`. Errors when there is
    /// no live session or a turn is in flight — the frontend then keeps the
    /// choice as a next-turn override.
    pub async fn set_session_mode(
        &self,
        conversation_id: Uuid,
        mode_id: String,
    ) -> Result<(), ConversationServiceError> {
        self.ctx
            .agent_runtime
            .set_session_mode(AgentSessionId(conversation_id), mode_id.clone())
            .await?;
        self.remember_session_controls_selection(conversation_id, Some(&mode_id), &[])
            .await;
        Ok(())
    }

    /// Immediately change one agent-advertised session config option
    /// (`session/set_config_option`, e.g. model or permission mode). Same
    /// caveats as [`Self::set_session_mode`].
    pub async fn set_session_config_option(
        &self,
        conversation_id: Uuid,
        key: String,
        value: serde_json::Value,
    ) -> Result<(), ConversationServiceError> {
        self.ctx
            .agent_runtime
            .set_session_config_option(AgentSessionId(conversation_id), key.clone(), value.clone())
            .await?;
        // Prompt-time overrides are string-valued (`session/set_config_option` accepts
        // either form for boolean options), so remember the selection in that domain.
        let value = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        self.remember_session_controls_selection(
            conversation_id,
            None,
            &[AgentSessionConfigOverride { key, value }],
        )
        .await;
        Ok(())
    }

    /// Record the conversation's effective session-control selection on its binding so
    /// a later cold `session/new` can replay it. Best-effort: failing to remember a
    /// selection must not fail the turn or the control change that already succeeded.
    async fn remember_session_controls_selection(
        &self,
        conversation_id: Uuid,
        mode: Option<&str>,
        config_overrides: &[AgentSessionConfigOverride],
    ) {
        let config_selection_json = (!config_overrides.is_empty())
            .then(|| {
                serde_json::to_string(
                    &config_overrides
                        .iter()
                        .map(|ovr| {
                            (
                                ovr.key.clone(),
                                serde_json::Value::String(ovr.value.clone()),
                            )
                        })
                        .collect::<serde_json::Map<_, _>>(),
                )
                .ok()
            })
            .flatten();
        if mode.is_none() && config_selection_json.is_none() {
            return;
        }
        let pool = &self.ctx.deployment.db().pool;
        if let Err(error) = ConversationAgentBindingRecord::update_session_controls_selection(
            pool,
            conversation_id,
            mode,
            config_selection_json.as_deref(),
        )
        .await
        {
            tracing::warn!(
                %conversation_id,
                %error,
                "failed to remember the conversation's session-control selection"
            );
        }
        // Last-used per Agent, same store new sessions already read (CodeG
        // `selector-prefs` per agentType). A rejected upsert must not fail the pick.
        if let Ok(Some(binding)) =
            ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id).await
        {
            let repo = SessionDefaultRepository::new(pool.clone());
            if let Some(mode) = mode.filter(|mode| !mode.is_empty())
                && let Err(error) = repo
                    .upsert(
                        &binding.agent_id,
                        "mode",
                        &serde_json::Value::String(mode.to_string()).to_string(),
                    )
                    .await
            {
                tracing::warn!(
                    %conversation_id,
                    agent_id = %binding.agent_id,
                    %error,
                    "failed to remember the agent's last-used session mode"
                );
            }
            for override_item in config_overrides {
                let value_json = serde_json::Value::String(override_item.value.clone()).to_string();
                if let Err(error) = repo
                    .upsert(&binding.agent_id, &override_item.key, &value_json)
                    .await
                {
                    tracing::warn!(
                        %conversation_id,
                        agent_id = %binding.agent_id,
                        option_id = %override_item.key,
                        %error,
                        "failed to remember the agent's last-used session config"
                    );
                }
            }
        }
    }

    async fn resolved_session_control_preferences(
        &self,
        pool: &SqlitePool,
        agent_id: &AgentId,
        binding: Option<&ConversationAgentBindingRecord>,
    ) -> SessionControlPreferences {
        let agent_defaults = SessionDefaultRepository::new(pool.clone())
            .list_for_agent(agent_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|record| {
                serde_json::from_str(&record.value_json)
                    .ok()
                    .map(|value| (record.option_id, value))
            })
            .collect::<Vec<_>>();
        session_control_preferences(binding, &agent_defaults)
    }

    /// Belt-and-suspenders after establish: preferred controls are already applied
    /// before the first broadcast (ADR-0071 §4). This only sends genuine diffs
    /// (in-memory driver, rejected remembered values).
    ///
    /// Best-effort and skip-if-current. A remembered value the agent no longer
    /// advertises is logged and dropped rather than failing session setup. This
    /// is not a new user choice, so it must not rewrite the binding.
    async fn replay_remembered_session_controls(
        &self,
        conversation_id: Uuid,
        runtime_session_id: AgentSessionId,
        binding: Option<&ConversationAgentBindingRecord>,
    ) {
        let remembered_mode = binding_mode_selection(binding);
        let remembered_config = binding_config_selection(binding);
        if remembered_mode.is_none() && remembered_config.is_empty() {
            return;
        }
        let Ok(current) = self
            .ctx
            .agent_runtime
            .session_controls_snapshot(runtime_session_id)
            .await
        else {
            return;
        };
        let plan = session_control_replay_plan(remembered_mode, remembered_config, &current);

        if let Some(mode) = plan.mode
            && let Err(error) = self
                .ctx
                .agent_runtime
                .set_session_mode(runtime_session_id, mode.clone())
                .await
        {
            tracing::warn!(
                %conversation_id,
                %mode,
                %error,
                "remembered session mode was rejected by the re-established session"
            );
        }

        for selection in plan.config_overrides {
            if let Err(error) = self
                .ctx
                .agent_runtime
                .set_session_config_option(
                    runtime_session_id,
                    selection.key.clone(),
                    serde_json::Value::String(selection.value.clone()),
                )
                .await
            {
                tracing::warn!(
                    %conversation_id,
                    option_id = %selection.key,
                    %error,
                    "remembered session config option was rejected by the re-established session"
                );
            }
        }
    }

    /// Ensure an existing conversation has a concrete ACP session and return
    /// its authoritative controls without sending a prompt. This repairs older
    /// conversations whose initial session-control events were emitted before
    /// the durable Conversation row existed.
    pub async fn ensure_session_controls(
        &self,
        conversation_id: Uuid,
    ) -> Result<AgentSessionControlsSnapshot, ConversationServiceError> {
        let turn_lock = self.turn_lock(conversation_id).await;
        let _turn_guard = turn_lock.lock().await;
        self.ensure_session_controls_locked(conversation_id).await
    }

    async fn ensure_session_controls_locked(
        &self,
        conversation_id: Uuid,
    ) -> Result<AgentSessionControlsSnapshot, ConversationServiceError> {
        self.interrupt_orphaned_turn(conversation_id).await?;
        let runtime_session_id = AgentSessionId(conversation_id);

        if let Ok(controls) = self
            .ctx
            .agent_runtime
            .session_controls_snapshot(runtime_session_id)
            .await
        {
            self.ctx
                .agent_runtime
                .commit_prepared_session(runtime_session_id)
                .await;
            return Ok(controls);
        }

        let pool = &self.ctx.deployment.db().pool;
        let persisted_session = Session::find_by_id(pool, conversation_id)
            .await?
            .ok_or_else(|| {
                ConversationServiceError::NotFound(format!(
                    "Conversation session {conversation_id} was not found"
                ))
            })?;
        let agent_id = persisted_session
            .agent_id
            .clone()
            .or_else(|| {
                persisted_session
                    .executor
                    .as_deref()
                    .and_then(AgentKind::from_lenient)
                    .and_then(|kind| agents::AgentId::parse(kind.as_str()).ok())
            })
            .ok_or_else(|| {
                ConversationServiceError::BadRequest(format!(
                    "Conversation {conversation_id} has no supported coding agent"
                ))
            })?;
        let workspace = Workspace::find_by_id(pool, persisted_session.workspace_id)
            .await?
            .ok_or_else(|| {
                ConversationServiceError::NotFound(format!(
                    "Workspace {} for conversation {conversation_id} was not found",
                    persisted_session.workspace_id
                ))
            })?;
        let container_ref = self
            .ctx
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await?;
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
        let working_dir = self
            .ctx
            .host
            .resolve_working_dir(&workspace, &container_ref, &repos)
            .unwrap_or_else(|| container_ref.clone());
        let additional_directories = self.ctx.host.resolve_additional_directories(
            &workspace,
            &container_ref,
            &repos,
            &working_dir,
        );
        let launch_settings = self.ctx.host.launch_settings(pool, &agent_id).await?;
        let bindings =
            ConversationAgentBindingRecord::list_for_conversation(pool, conversation_id).await?;
        let latest_binding = bindings.first().cloned();
        let restorable_binding = restorable_agent_binding(&bindings, &agent_id);
        let preferences = self
            .resolved_session_control_preferences(
                pool,
                &agent_id,
                restorable_binding.or(latest_binding.as_ref()),
            )
            .await;
        let can_restore_agent_session = restorable_binding.is_some()
            || binding_can_restore_agent_session(latest_binding.as_ref());
        if !can_restore_agent_session
            && latest_binding
                .as_ref()
                .is_some_and(|binding| binding.status == "closed")
        {
            return Ok(AgentSessionControlsSnapshot::default());
        }
        let external_session_id = resume_external_session_id(
            restorable_binding
                .and_then(|binding| binding.acp_session_id.clone())
                .or_else(|| {
                    known_acp_session_id(
                        latest_binding.as_ref(),
                        Some(&persisted_session),
                        &agent_id,
                    )
                }),
            can_restore_agent_session,
            false,
        );

        let restored_existing_session = external_session_id.is_some();
        let mut restore_strategy = None;
        let runtime_snapshot = if let Some(external_session_id) = external_session_id {
            let (snapshot, strategy) = self
                .ctx
                .agent_runtime
                .resume_session(ResumeAgentSessionInput {
                    agent_id: agent_id.clone(),
                    launch_lock: launch_settings.launch_lock.clone(),
                    workspace_id: workspace.id,
                    working_dir: PathBuf::from(&working_dir),
                    additional_directories: additional_directories.clone(),
                    session_id: runtime_session_id,
                    external_session_id,
                    auto_approve_mode: launch_settings.auto_approve_mode,
                    env: launch_settings.env.clone(),
                    preferences: preferences.clone(),
                })
                .await?;
            restore_strategy = strategy;
            snapshot
        } else {
            let prepared = self
                .ctx
                .agent_runtime
                .prepare_session(EnsureAgentSessionInput {
                    agent_id: agent_id.clone(),
                    launch_lock: launch_settings.launch_lock.clone(),
                    workspace_id: workspace.id,
                    working_dir: PathBuf::from(&working_dir),
                    additional_directories,
                    session_id: runtime_session_id,
                    acp_session_id: format!("vibex-new-session-{conversation_id}"),
                    auto_approve_mode: launch_settings.auto_approve_mode,
                    env: launch_settings.env,
                    preferences,
                })
                .await?;
            Session::update_agent_metadata(
                pool,
                conversation_id,
                Some(&prepared.session.acp_session_id),
                Some(&agent_id),
            )
            .await?;
            prepared.session
        };

        // Preferred controls are applied before the first broadcast. Replay is
        // skip-if-current, so it only fires when that apply was rejected or the
        // in-memory driver never ran it.
        self.replay_remembered_session_controls(
            conversation_id,
            runtime_session_id,
            latest_binding.as_ref(),
        )
        .await;

        let controls = self
            .ctx
            .agent_runtime
            .session_controls_snapshot(runtime_session_id)
            .await?;
        self.ctx
            .agent_runtime
            .commit_prepared_session(runtime_session_id)
            .await;
        self.update_runtime_state(conversation_id, |state| {
            state.conversation_id = Some(conversation_id);
            state.acp_session_id = Some(runtime_snapshot.acp_session_id.clone());
            state.connection_id = Some(runtime_snapshot.connection_id.to_string());
            state.connection_status = Some("ready".to_string());
        })
        .await;
        if latest_binding
            .as_ref()
            .is_some_and(|binding| binding.status == "failed")
        {
            let strategy = restore_strategy.unwrap_or(if restored_existing_session {
                agents::SessionRecoveryStrategy::Resumed
            } else {
                agents::SessionRecoveryStrategy::CreatedNewSession
            });
            self.record_agent_binding_recovered(conversation_id, strategy)
                .await?;
        }
        Ok(controls)
    }

    pub async fn cancel_turn(
        &self,
        conversation_id: Uuid,
        reason: Option<String>,
    ) -> Result<(), ConversationServiceError> {
        // Share the exact same per-Conversation critical section as start_turn.
        // Without this, a Workflow can expose its child Conversation as running,
        // receive Pause while the first prompt is still being prepared, and then
        // start a follow-up before the first Turn has committed its active pointer.
        // The two Agent bindings race and the old connection's close event can fail
        // the new Turn. Holding this guard makes Pause an acknowledged boundary:
        // when it returns, any concurrent start has either committed and been
        // cancelled, or never existed.
        let turn_lock = self.turn_lock(conversation_id).await;
        let _turn_guard = turn_lock.lock().await;
        let snapshot = self.runtime_snapshot(conversation_id).await;
        let pool = &self.ctx.deployment.db().pool;
        // Runtime coordination is deliberately ephemeral. After a failed session
        // recovery it may be empty even though the event-sourced conversation still
        // has a persisted in-flight turn, so use the database as the fallback.
        let persisted_turn_id = ConversationRecord::find_by_id(pool, conversation_id)
            .await?
            .and_then(|conversation| conversation.active_turn_id);
        let turn_id = persisted_turn_id.or(snapshot.active_turn_id);
        let turn_id = match turn_id {
            Some(turn_id) => ConversationTurnRecord::find_by_id(pool, turn_id)
                .await?
                .filter(|turn| is_in_flight_turn_status(&turn.status))
                .map(|turn| turn.id),
            None => None,
        };
        let Some(turn_id) = turn_id else {
            return Ok(());
        };
        let cancel_target = match (
            snapshot
                .connection_id
                .as_deref()
                .and_then(parse_agent_connection_id),
            snapshot
                .active_prompt_id
                .as_deref()
                .and_then(parse_agent_prompt_id),
        ) {
            (Some(connection_id), Some(prompt_id)) => Some((connection_id, prompt_id)),
            _ => {
                self.ctx
                    .agent_runtime
                    .live_cancel_target(AgentSessionId(conversation_id))
                    .await
            }
        };
        if let Some((connection_id, prompt_id)) = cancel_target
            && let Err(error) = self
                .ctx
                .agent_runtime
                .cancel_prompt(CancelAgentPromptInput {
                    connection_id,
                    session_id: AgentSessionId(conversation_id),
                    prompt_id,
                })
                .await
        {
            // The runtime may already be dead (auth expiry, crashed process, lost
            // transport). The user's cancel intent must still settle the durable
            // turn locally instead of leaving the composer stuck forever.
            tracing::warn!(
                %conversation_id,
                %prompt_id,
                %error,
                "Agent prompt cancellation failed; settling turn locally"
            );
        }
        self.append_event(
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCancelled {
                reason: reason.clone(),
            },
            Some(format!("turn:{turn_id}:cancelled")),
        )
        .await?;
        ConversationRecord::update_active_turn(pool, conversation_id, None).await?;
        self.update_runtime_state(conversation_id, |state| {
            state.turn_in_flight = false;
            state.active_turn_id = None;
            state.active_prompt_id = None;
            state.recovery_status = reason;
        })
        .await;
        drop(_turn_guard);
        if let Err(error) = self.dispatch_next_queued_input(conversation_id).await {
            tracing::warn!(
                %conversation_id,
                %error,
                "failed to dispatch the next durable conversation input after cancel"
            );
        }
        Ok(())
    }

    /// Reset-to-here: truncate the conversation back to *before* the user turn at
    /// `ordinal` — delete that turn and everything after it (events, turns,
    /// checkpoints) and rebuild the projection — so the caller can re-send that
    /// message in its original position. The optional workspace file rollback is the
    /// caller's separate concern (it must run before this, while the ordinal's
    /// checkpoint still exists).
    pub async fn truncate_to_turn(
        &self,
        conversation_id: Uuid,
        user_ordinal: i64,
    ) -> Result<(), ConversationServiceError> {
        // Serialize against start_turn / cancel_turn on the same conversation.
        let turn_lock = {
            let mut locks = self.ctx.turn_locks.lock().await;
            Arc::clone(
                locks
                    .entry(conversation_id)
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        let _turn_guard = turn_lock.lock().await;

        let pool = &self.ctx.deployment.db().pool;
        // Detach the Agent session *before* deleting anything. The truncated prefix
        // must never be re-sent, and the old ACP session still holds it: if the
        // detach fails after the delete, the event log is short while the binding
        // still points at the full context, and the next send replays the deleted
        // messages through `session/load`. The `AgentBindingRecovered` event is
        // appended after the cut, since truncation drops every later sequence.
        self.detach_agent_session(conversation_id).await?;

        // `user_ordinal` is the 0-based user-message index (same basis as the checkpoint
        // ordinal / `reset_agent_session_to_checkpoint`). `conversation_turns.ordinal`
        // is 1-based (created via `MAX(ordinal)+1`), so the turn to reset *from* is
        // `user_ordinal + 1`; checkpoints share the 0-based basis.
        let turn_ordinal = user_ordinal + 1;
        ConversationProjector::truncate_to_turn_ordinal(pool, conversation_id, turn_ordinal)
            .await?;
        SessionCheckpoint::delete_from_ordinal(pool, conversation_id, user_ordinal).await?;
        ConversationRecord::update_active_turn(pool, conversation_id, None).await?;
        // The live projector cursor may now point beyond the truncated event log.
        // Invalidate it at the mutation boundary so the next committed event seeds a
        // fresh projector from its actual predecessor sequence.
        self.ctx
            .row_projectors
            .lock()
            .await
            .remove(&conversation_id);

        self.update_runtime_state(conversation_id, |state| {
            state.active_turn_id = None;
            state.active_prompt_id = None;
            state.turn_in_flight = false;
            state.pending_user_message = None;
        })
        .await;
        self.record_agent_binding_recovered(
            conversation_id,
            agents::SessionRecoveryStrategy::Rebound,
        )
        .await?;

        Ok(())
    }

    pub async fn rebind_session(
        &self,
        conversation_id: Uuid,
    ) -> Result<AgentSessionControlsSnapshot, ConversationServiceError> {
        let turn_lock = self.turn_lock(conversation_id).await;
        let _turn_guard = turn_lock.lock().await;
        self.interrupt_orphaned_turn(conversation_id).await?;
        self.detach_agent_session(conversation_id).await?;
        self.record_agent_binding_recovered(
            conversation_id,
            agents::SessionRecoveryStrategy::Rebound,
        )
        .await?;
        self.ensure_session_controls_locked(conversation_id).await
    }

    /// Drop the live Agent connection and point the binding at a fresh placeholder
    /// ACP session, so the next send cold-starts instead of loading the old context.
    /// Records no event — callers append `AgentBindingRecovered` once the surrounding
    /// mutation (if any) has settled.
    async fn detach_agent_session(
        &self,
        conversation_id: Uuid,
    ) -> Result<(), ConversationServiceError> {
        let snapshot = self.runtime_snapshot(conversation_id).await;
        if let Some(connection_id) = snapshot
            .connection_id
            .as_deref()
            .and_then(parse_agent_connection_id)
            && let Err(error) = self.ctx.agent_runtime.disconnect(connection_id).await
        {
            tracing::warn!(
                %conversation_id,
                %error,
                "failed to disconnect Agent connection while invalidating session"
            );
        }
        self.forget_conversation_runtime(conversation_id).await;
        self.append_event(
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentConnectionStatusChanged {
                status: agents::conversation::ConversationAgentConnectionStatus::Recovering,
            },
            None,
        )
        .await?;

        let pool = &self.ctx.deployment.db().pool;
        let placeholder = format!("vibex-new-session-{conversation_id}");
        if let Some(binding) =
            ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id).await?
        {
            ConversationAgentBindingRecord::bind_acp_session(
                pool,
                binding.id,
                &placeholder,
                None,
                BindingStatus::Recovering,
            )
            .await?;
        }
        sqlx::query(
            r#"UPDATE sessions
               SET external_session_id = ?,
                   updated_at = datetime('now', 'subsec')
               WHERE id = ?"#,
        )
        .bind(&placeholder)
        .bind(conversation_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Each rebind is a distinct fact, so this carries no idempotency key — a
    /// per-conversation key silently swallowed every rebind after the first, and the
    /// operation is already serialized under the conversation's turn lock.
    async fn record_agent_binding_recovered(
        &self,
        conversation_id: Uuid,
        strategy: agents::SessionRecoveryStrategy,
    ) -> Result<(), ConversationServiceError> {
        self.append_event(
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentBindingRecovered { strategy },
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn interrupt_orphaned_turn(
        &self,
        conversation_id: Uuid,
    ) -> Result<bool, ConversationServiceError> {
        let snapshot = self.runtime_snapshot(conversation_id).await;
        if snapshot.turn_in_flight
            && snapshot
                .connection_id
                .as_deref()
                .and_then(parse_agent_connection_id)
                .is_some()
        {
            return Ok(false);
        }

        let pool = &self.ctx.deployment.db().pool;
        let Some(conversation) = ConversationRecord::find_by_id(pool, conversation_id).await?
        else {
            return Ok(false);
        };
        let Some(turn_id) = conversation.active_turn_id else {
            return Ok(false);
        };
        let Some(turn) = ConversationTurnRecord::find_by_id(pool, turn_id).await? else {
            return Ok(false);
        };
        if !is_in_flight_turn_status(&turn.status) {
            return Ok(false);
        }
        if !turn_predates_this_host(turn.created_at) {
            return Ok(false);
        }

        self.interrupt_in_flight_turn(turn.conversation_id, turn.id)
            .await?;
        Ok(true)
    }

    async fn interrupt_in_flight_turn(
        &self,
        conversation_id: Uuid,
        turn_id: Uuid,
    ) -> Result<(), ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let permissions = ConversationPermissionRecord::list_for_turn(pool, turn_id).await?;
        for permission in permissions.into_iter().filter(|p| p.status == "pending") {
            self.append_event(
                conversation_id,
                Some(turn_id),
                "runtime",
                ConversationEvent::PermissionResponded {
                    permission_id: permission.permission_id.clone(),
                    response: ConversationPermissionResponse {
                        response: AgentPermissionResponse::Cancelled,
                        auto: true,
                    },
                },
                Some(format!(
                    "recovery:permission-cancelled:{}",
                    permission.permission_id
                )),
            )
            .await?;
        }
        self.append_event(
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnInterrupted {
                reason: Some("会话在生成过程中因应用重启而中断".to_string()),
            },
            Some(format!("recovery:turn-interrupted:{turn_id}")),
        )
        .await?;
        ConversationRecord::update_active_turn(pool, conversation_id, None).await?;
        self.forget_conversation_runtime(conversation_id).await;
        Ok(())
    }

    pub async fn close_conversation(
        &self,
        conversation_id: Uuid,
        reason: Option<String>,
    ) -> Result<(), ConversationServiceError> {
        let turn_lock = self.turn_lock(conversation_id).await;
        let _turn_guard = turn_lock.lock().await;
        let pool = &self.ctx.deployment.db().pool;
        if let Some(conversation) = ConversationRecord::find_by_id(pool, conversation_id).await?
            && let Some(turn_id) = conversation.active_turn_id
            && let Some(turn) = ConversationTurnRecord::find_by_id(pool, turn_id).await?
            && is_in_flight_turn_status(&turn.status)
        {
            self.append_event(
                conversation_id,
                Some(turn.id),
                "runtime",
                ConversationEvent::TurnCancelled {
                    reason: reason.clone(),
                },
                Some(format!("turn:{}:cancelled", turn.id)),
            )
            .await?;
            ConversationRecord::update_active_turn(pool, conversation_id, None).await?;
        }
        self.append_event(
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentConnectionStatusChanged {
                status: ConversationAgentConnectionStatus::Closed,
            },
            Some(format!("conversation:{conversation_id}:closed")),
        )
        .await?;
        ConversationRecord::update_status(
            &self.ctx.deployment.db().pool,
            conversation_id,
            SessionStatus::Done,
        )
        .await?;
        self.update_runtime_state(conversation_id, |state| {
            state.turn_in_flight = false;
            state.connection_status = Some("closed".to_string());
            state.recovery_status = reason;
        })
        .await;
        // Drop this conversation's in-memory coordination state now that it is closed.
        // Without this, both maps leaked one entry per conversation ever opened — the
        // whole codebase had no `remove` on either (架构报告 recovery). The closed
        // status is authoritative in the event log + SessionStatus, not these maps.
        self.forget_conversation_runtime(conversation_id).await;
        Ok(())
    }

    /// Reconcile turns orphaned by the previous process lifecycle (startup recovery,
    /// ADR-0001). A turn left in-flight (pending/queued/running/blocked) when the host
    /// died can never resume its generation, so drive it to the **Interrupted** terminal
    /// state *through the event log* (never a bare status UPDATE) and void its orphaned
    /// pending permission requests. Session *context* is reloaded lazily on the next
    /// open/send via ACP `session/load` — we deliberately do **not** eagerly reconnect
    /// agents here. Returns the number of turns recovered.
    pub async fn recover_interrupted_turns(&self) -> Result<usize, ConversationServiceError> {
        note_host_lifetime();
        let pool = &self.ctx.deployment.db().pool;
        let inputs = ConversationInputControl::with_publisher(
            pool.clone(),
            self.ctx.event_publisher.clone(),
        );
        let released_claims = inputs.recover_stale_claims(Utc::now()).await?;
        if released_claims > 0 {
            tracing::info!(released_claims, "released stale unsubmitted input claims");
        }
        let in_flight = ConversationTurnRecord::list_in_flight(pool).await?;
        if in_flight.is_empty() {
            return Ok(0);
        }

        let count = in_flight.len();
        tracing::info!(
            count,
            "startup recovery: marking orphaned in-flight turns as interrupted"
        );

        let mut recovered = 0usize;
        let mut failed = 0usize;
        for turn in &in_flight {
            match self
                .interrupt_in_flight_turn(turn.conversation_id, turn.id)
                .await
            {
                Ok(()) => recovered += 1,
                Err(error) => {
                    failed += 1;
                    tracing::error!(
                        conversation_id = %turn.conversation_id,
                        turn_id = %turn.id,
                        %error,
                        "startup crash-recovery failed for one turn"
                    );
                }
            }
        }
        if failed > 0 {
            tracing::error!(
                recovered,
                failed,
                "startup crash-recovery left orphaned in-flight turns; they will be interrupted when next opened"
            );
        }

        Ok(recovered)
    }

    /// Resume durable queues after host event persistence is online. Each
    /// conversation dispatches at most one Turn; terminal events pump the rest.
    pub async fn dispatch_queued_inputs(&self) -> Result<usize, ConversationServiceError> {
        let conversation_ids =
            db::models::conversation_input::ConversationInputRecord::queued_conversation_ids(
                &self.ctx.deployment.db().pool,
            )
            .await?;
        let mut started = 0;
        for conversation_id in conversation_ids {
            if self
                .dispatch_next_queued_input(conversation_id)
                .await?
                .is_some()
            {
                started += 1;
            }
        }
        Ok(started)
    }

    /// Remove a conversation's entries from the in-memory coordination maps (turn
    /// locks, runtime state, and the cached incremental row projector).
    ///
    /// The turn lock is only pruned when nobody still holds a clone of it. Removing
    /// a referenced lock lets a concurrent `start_turn` / `dispatch_next_queued_input`
    /// `or_insert` a *second* mutex for the same conversation, after which both tasks
    /// believe they hold exclusive access — the very double in-flight Turn the lock
    /// exists to prevent (ADR-0061 §4.2, CONTEXT.md "In-flight turn").
    async fn forget_conversation_runtime(&self, conversation_id: Uuid) {
        self.prune_turn_lock(conversation_id).await;
        self.ctx
            .runtime_states
            .lock()
            .await
            .remove(&conversation_id);
        self.ctx
            .row_projectors
            .lock()
            .await
            .remove(&conversation_id);
    }

    async fn prune_turn_lock(&self, conversation_id: Uuid) {
        prune_unreferenced_turn_lock(&mut *self.ctx.turn_locks.lock().await, conversation_id);
    }

    async fn ensure_conversation(
        &self,
        pool: &SqlitePool,
        input: &ConversationStartTurnInput,
        display_text: &str,
    ) -> Result<ConversationRecord, ConversationServiceError> {
        if let Some(existing) = ConversationRecord::find_by_id(pool, input.conversation_id).await? {
            return Ok(existing);
        }

        ConversationRecord::create(
            pool,
            input.conversation_id,
            CreateConversationRecord {
                workspace_id: input.workspace_id,
                task_id: None,
                title: None,
                initial_prompt: Some(display_text),
                status: Some(SessionStatus::InProgress),
                executor: Some("agent"),
            },
        )
        .await
        .map_err(Into::into)
    }

    async fn send_turn_to_agent(
        &self,
        input: &ConversationStartTurnInput,
        working_dir: &str,
        additional_directories: &[PathBuf],
        blocks: Vec<AgentContentBlock>,
        turn_id: Uuid,
    ) -> Result<AgentPromptSnapshot, ConversationServiceError> {
        let pool = &self.ctx.deployment.db().pool;
        let agent_id = input.agent_id.clone();
        let launch_settings = self.ctx.host.launch_settings(pool, &agent_id).await?;
        let bindings =
            ConversationAgentBindingRecord::list_for_conversation(pool, input.conversation_id)
                .await?;
        let latest_binding = bindings.first().cloned();
        let restorable_binding = restorable_agent_binding(&bindings, &agent_id);
        let preferences = self
            .resolved_session_control_preferences(
                pool,
                &agent_id,
                restorable_binding.or(latest_binding.as_ref()),
            )
            .await;
        let persisted_session = Session::find_by_id(pool, input.conversation_id).await?;
        let known_acp_session_id = restorable_binding
            .and_then(|binding| binding.acp_session_id.clone())
            .or_else(|| {
                known_acp_session_id(
                    latest_binding.as_ref(),
                    persisted_session.as_ref(),
                    &input.agent_id,
                )
            });
        let session_capabilities_json = serde_json::to_string(&AcpCapabilitySnapshot::default())
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
        let mcp_servers_json = serde_json::to_string(&self.ctx.host.product_mcp_server_names())
            .unwrap_or_else(|_| "[]".to_string());

        // Lazy reconnect (ADR-0001): reopen after the agent process ended only
        // reloads a live ACP session when that binding advertised load/resume.
        // Imported history stores the original tool session id but marks restore
        // unsupported; sending a follow-up must cold-start (`session/new`) instead
        // of failing `session/load` or pulling the original transcript into memory.
        let has_live_connection = self
            .runtime_connection_and_turn(input.conversation_id)
            .await
            .is_some();
        let can_restore_agent_session = restorable_binding.is_some()
            || binding_can_restore_agent_session(latest_binding.as_ref());
        let resume_external_session_id = resume_external_session_id(
            known_acp_session_id.clone(),
            can_restore_agent_session,
            has_live_connection,
        );
        let acp_session_id = resume_external_session_id
            .clone()
            .unwrap_or_else(|| format!("vibex-new-session-{}", input.conversation_id));

        let binding = ConversationAgentBindingRecord::create(
            pool,
            Uuid::new_v4(),
            CreateConversationAgentBinding {
                conversation_id: input.conversation_id,
                agent_id: &agent_id,
                working_dir,
                acp_session_id: Some(&acp_session_id),
                acp_protocol_version: None,
                runtime_version: Some(&launch_settings.launch_lock.runtime_version),
                acp_version: Some(&launch_settings.launch_lock.acp_version),
                load_supported: restorable_binding
                    .map(|binding| binding.load_supported)
                    .or_else(|| latest_binding.as_ref().map(|binding| binding.load_supported))
                    .unwrap_or(false),
                resume_supported: restorable_binding
                    .map(|binding| binding.resume_supported)
                    .or_else(|| {
                        latest_binding
                            .as_ref()
                            .map(|binding| binding.resume_supported)
                    })
                    .unwrap_or(false),
                close_supported: false,
                terminal_supported: false,
                additional_directories_supported: false,
                prompt_capabilities_json:
                    r#"{"text":true,"image":false,"audio":false,"resource":false,"resource_link":true}"#,
                session_capabilities_json: &session_capabilities_json,
                client_capabilities_json: "{}",
                mcp_servers_json: &mcp_servers_json,
                modes_json: "[]",
                config_options_json: "[]",
                current_mode: None,
                config_selection_json: "{}",
                status: BindingStatus::Connecting,
            },
        )
        .await?;
        self.append_event(
            input.conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::AgentBindingStarted {
                agent_id: agent_id.clone(),
                working_dir: working_dir.to_string(),
            },
            Some(format!("binding:{}:started", binding.id)),
        )
        .await?;

        let mut inject_host_history = resume_external_session_id.is_none();
        let session = if let Some(external_session_id) = resume_external_session_id {
            match self
                .ctx
                .agent_runtime
                .resume_session(ResumeAgentSessionInput {
                    agent_id: agent_id.clone(),
                    launch_lock: launch_settings.launch_lock.clone(),
                    workspace_id: input.workspace_id,
                    working_dir: PathBuf::from(working_dir),
                    additional_directories: additional_directories.to_vec(),
                    session_id: AgentSessionId(input.conversation_id),
                    external_session_id,
                    auto_approve_mode: launch_settings.auto_approve_mode,
                    env: launch_settings.env.clone(),
                    preferences: preferences.clone(),
                })
                .await
            {
                Ok(session) => session.0,
                Err(agents::AgentError::SessionLoadFailed(_)) => {
                    inject_host_history = true;
                    self.ctx
                        .agent_runtime
                        .prepare_session(EnsureAgentSessionInput {
                            agent_id: agent_id.clone(),
                            launch_lock: launch_settings.launch_lock.clone(),
                            workspace_id: input.workspace_id,
                            working_dir: PathBuf::from(working_dir),
                            additional_directories: additional_directories.to_vec(),
                            session_id: AgentSessionId(input.conversation_id),
                            acp_session_id: acp_session_id.clone(),
                            auto_approve_mode: launch_settings.auto_approve_mode,
                            env: launch_settings.env.clone(),
                            preferences: preferences.clone(),
                        })
                        .await?
                        .session
                }
                Err(error) => return Err(error.into()),
            }
        } else {
            self.ctx
                .agent_runtime
                .prepare_session(EnsureAgentSessionInput {
                    agent_id: agent_id.clone(),
                    launch_lock: launch_settings.launch_lock.clone(),
                    workspace_id: input.workspace_id,
                    working_dir: PathBuf::from(working_dir),
                    additional_directories: additional_directories.to_vec(),
                    session_id: AgentSessionId(input.conversation_id),
                    acp_session_id: acp_session_id.clone(),
                    auto_approve_mode: launch_settings.auto_approve_mode,
                    env: launch_settings.env.clone(),
                    preferences,
                })
                .await?
                .session
        };

        ConversationAgentBindingRecord::bind_acp_session(
            pool,
            binding.id,
            &session.acp_session_id,
            None,
            BindingStatus::Ready,
        )
        .await?;
        let negotiated_capabilities = self
            .ctx
            .agent_runtime
            .session_controls_snapshot(session.id)
            .await
            .ok()
            .and_then(|controls| controls.capabilities);
        if let Some(capabilities) = negotiated_capabilities {
            self.append_event(
                input.conversation_id,
                Some(turn_id),
                "runtime",
                ConversationEvent::AgentBindingReady {
                    acp_session_id: session.acp_session_id.clone(),
                    capabilities,
                },
                Some(format!("binding:{}:ready", binding.id)),
            )
            .await?;
        }

        match self
            .ctx
            .deployment
            .container()
            .checkpoint_agent_session(input.conversation_id)
            .await
        {
            Ok(ordinal) => {
                if let Err(error) = record_conversation_checkpoint(
                    self.ctx.deployment.as_ref(),
                    pool,
                    input.conversation_id,
                    turn_id,
                    ordinal,
                )
                .await
                {
                    tracing::warn!(%error, "failed to record conversation checkpoint mapping");
                }
            }
            Err(error) => {
                tracing::warn!(%error, "failed to record conversation checkpoint");
            }
        }

        let mut prompt_overrides = agent_prompt_overrides_from_profile(
            &input.agent_id,
            input.executor_profile_id.as_ref(),
        );
        // The conversation's remembered selection outranks profile/slash defaults but
        // yields to an explicit pick on this turn. Replaying it matters most when the
        // session was just cold-started (rebind, crash, lost connection): the agent
        // reverts to *its* default mode, and the composer clears its pending override
        // after each turn, so without this the conversation silently drops from full
        // access back to per-action approval.
        merge_user_prompt_overrides(
            &mut prompt_overrides,
            binding_mode_selection(latest_binding.as_ref()),
            binding_config_selection(latest_binding.as_ref()),
        );
        // The composer's explicit mode/config selection wins over profile/slash
        // defaults so the user-picked, agent-advertised mode actually takes effect.
        merge_user_prompt_overrides(
            &mut prompt_overrides,
            input.mode_override.clone(),
            input.config_overrides.clone(),
        );
        self.remember_session_controls_selection(
            input.conversation_id,
            prompt_overrides.mode_override.as_deref(),
            &prompt_overrides.config_overrides,
        )
        .await;
        let mut prompt_blocks = blocks;
        if inject_host_history {
            let current_text = prompt_blocks.iter().find_map(|block| match block {
                AgentContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            });
            if let Some(history) = crate::session_info::host_history_prompt(
                pool,
                input.conversation_id,
                current_text.unwrap_or(""),
            )
            .await
            {
                prompt_blocks.insert(0, AgentContentBlock::Text { text: history });
            }
        }
        let prompt = self
            .ctx
            .agent_runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: session.connection_id,
                session_id: session.id,
                blocks: prompt_blocks,
                mode_override: prompt_overrides.mode_override,
                config_overrides: prompt_overrides.config_overrides,
            })
            .await?;

        self.update_runtime_state(input.conversation_id, |state| {
            state.binding_id = Some(binding.id);
            state.acp_session_id = Some(session.acp_session_id.clone());
            state.connection_id = Some(session.connection_id.to_string());
            state.connection_status = Some("ready".to_string());
        })
        .await;

        Ok(prompt)
    }

    async fn append_event(
        &self,
        conversation_id: Uuid,
        turn_id: Option<Uuid>,
        source: &'static str,
        event: ConversationEvent,
        idempotency_key: Option<String>,
    ) -> Result<db::models::conversation_event::ConversationEventRecord, ConversationServiceError>
    {
        let value = serde_json::to_value(&event)
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
        // `ConversationEvent` is `#[serde(tag = "kind")]`, so its serialized form
        // always carries a string `kind`. Assert the invariant instead of masking
        // a would-be-impossible failure as the literal "unknown".
        let event_kind = value["kind"]
            .as_str()
            .expect("serialized ConversationEvent always has a string `kind` tag")
            .to_string();
        let normalized_json = serde_json::to_string(&event)
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
        append_and_publish_conversation_event(
            &self.ctx.deployment.db().pool,
            self.ctx.event_publisher.as_ref(),
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source,
                event_kind: &event_kind,
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: idempotency_key.as_deref(),
            },
        )
        .await
        .map_err(Into::into)
    }

    async fn update_runtime_state(
        &self,
        conversation_id: Uuid,
        update: impl FnOnce(&mut ConversationRuntimeState),
    ) {
        let mut states = self.ctx.runtime_states.lock().await;
        let state = states.entry(conversation_id).or_default();
        update(state);
    }

    async fn runtime_snapshot(&self, conversation_id: Uuid) -> ConversationRuntimeState {
        self.ctx
            .runtime_states
            .lock()
            .await
            .get(&conversation_id)
            .cloned()
            .unwrap_or_default()
    }

    async fn runtime_connection_and_turn(
        &self,
        conversation_id: Uuid,
    ) -> Option<(AgentConnectionId, Option<Uuid>)> {
        let snapshot = self.runtime_snapshot(conversation_id).await;
        snapshot
            .connection_id
            .as_deref()
            .and_then(parse_agent_connection_id)
            .map(|connection_id| (connection_id, snapshot.active_turn_id))
    }
}

async fn append_and_publish_conversation_event(
    pool: &SqlitePool,
    publisher: &dyn ConversationEventPublisher,
    input: AppendConversationEvent<'_>,
) -> Result<db::models::conversation_event::ConversationEventRecord, sqlx::Error> {
    let record = ConversationEventAppender::append(pool, input).await?;
    publisher.publish(&record).await;
    Ok(record)
}

fn steering_receipt(
    record: ConversationSteeringRecord,
) -> Result<ConversationSteeringReceipt, ConversationServiceError> {
    let status = match record.status.as_str() {
        "requested" => ConversationSteeringStatus::Requested,
        "accepted" => ConversationSteeringStatus::Accepted,
        "rejected" => ConversationSteeringStatus::Rejected,
        "unknown" => ConversationSteeringStatus::Unknown,
        status => {
            return Err(ConversationServiceError::Internal(format!(
                "Invalid steering status `{status}`"
            )));
        }
    };
    Ok(ConversationSteeringReceipt {
        steering_id: record.id,
        conversation_id: record.conversation_id,
        operation_id: record.operation_id,
        expected_turn_id: record.expected_turn_id,
        status,
        code: record.code,
        message: record.message,
    })
}

async fn ensure_conversation_has_no_in_flight_turn(
    pool: &SqlitePool,
    conversation: &ConversationRecord,
) -> Result<(), ConversationServiceError> {
    let Some(active_turn_id) = conversation.active_turn_id else {
        return Ok(());
    };
    let Some(active_turn) = ConversationTurnRecord::find_by_id(pool, active_turn_id).await? else {
        return Ok(());
    };

    if is_in_flight_turn_status(&active_turn.status) {
        return Err(ConversationServiceError::Conflict(format!(
            "Conversation {} already has an active turn",
            conversation.id
        )));
    }

    Ok(())
}

fn is_in_flight_turn_status(status: &str) -> bool {
    matches!(status, "pending" | "queued" | "running" | "blocked")
}

fn host_started_at() -> DateTime<Utc> {
    static STARTED: OnceLock<DateTime<Utc>> = OnceLock::new();
    *STARTED.get_or_init(Utc::now)
}

fn note_host_lifetime() {
    let _ = host_started_at();
}

fn turn_predates_this_host(created_at: DateTime<Utc>) -> bool {
    created_at < host_started_at()
}

#[derive(Debug, sqlx::FromRow)]
struct ConversationCheckpointRow {
    id: Uuid,
    ordinal: i64,
    before_snapshot_json: Option<String>,
}

struct CollectedCheckpointFileChanges {
    files: Vec<ConversationFileChange>,
    after_repos: Vec<serde_json::Value>,
}

async fn collect_checkpoint_file_changes<D: Deployment + ?Sized>(
    deployment: &D,
    conversation_id: Uuid,
    checkpoint: &ConversationCheckpointRow,
) -> Result<CollectedCheckpointFileChanges, ConversationServiceError> {
    let pool = &deployment.db().pool;
    let conversation = ConversationRecord::find_by_id(pool, conversation_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!("Conversation {conversation_id} not found"))
        })?;
    let workspace = Workspace::find_by_id(pool, conversation.workspace_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!(
                "Workspace {} not found",
                conversation.workspace_id
            ))
        })?;
    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let checkpoints =
        SessionCheckpoint::find_by_ordinal(pool, conversation_id, checkpoint.ordinal).await?;

    let mut files = Vec::new();
    let mut after_repos = Vec::new();
    for checkpoint_repo in checkpoints {
        let Some(repo) = repos.iter().find(|repo| repo.id == checkpoint_repo.repo_id) else {
            continue;
        };
        let repo_path = workspace
            .repo_path(repo)
            .unwrap_or_else(|| PathBuf::from(&container_ref));
        let after_head = deployment.container().git().get_head_info(&repo_path).ok();
        after_repos.push(serde_json::json!({
            "repoId": repo.id,
            "repoName": repo.name,
            "beforeHeadCommit": checkpoint_repo.before_head_commit,
            "afterHeadCommit": after_head.as_ref().map(|head| head.oid.clone()),
        }));

        let Ok(oid) = git2::Oid::from_str(&checkpoint_repo.before_head_commit) else {
            tracing::warn!(
                repo_id = %repo.id,
                before_head = %checkpoint_repo.before_head_commit,
                "failed to parse conversation checkpoint commit"
            );
            continue;
        };
        let base_commit = Commit::new(oid);
        let diffs = match deployment.container().git().get_diffs(
            DiffTarget::Worktree {
                worktree_path: &repo_path,
                base_commit: &base_commit,
            },
            None,
        ) {
            Ok(diffs) => diffs,
            Err(error) => {
                tracing::warn!(
                    repo_id = %repo.id,
                    path = %repo_path.display(),
                    %error,
                    "failed to compute conversation checkpoint diff"
                );
                continue;
            }
        };
        let repo_id = repo.id.to_string();
        if let Some(before_diffs) =
            checkpoint_before_diffs(checkpoint.before_snapshot_json.as_deref(), &repo_id)
        {
            files.extend(checkpoint_turn_file_changes(&before_diffs, &diffs));
        } else {
            let before_files =
                checkpoint_before_files(checkpoint.before_snapshot_json.as_deref(), &repo_id);
            let before_paths = before_files
                .iter()
                .flat_map(|file| std::iter::once(&file.path).chain(file.old_path.as_ref()))
                .collect::<std::collections::HashSet<_>>();
            files.extend(
                diffs
                    .into_iter()
                    .filter_map(diff_to_conversation_file_change)
                    .filter(|file| !before_paths.contains(&file.path)),
            );
        }
    }

    Ok(CollectedCheckpointFileChanges { files, after_repos })
}

/// Compute the files that a reset to the checkpoint before `ordinal` would
/// currently change. This is read-only and uses the same checkpoint snapshot
/// comparison as the persisted per-turn file summary.
pub async fn preview_checkpoint_file_changes<D: Deployment + ?Sized>(
    deployment: &D,
    conversation_id: Uuid,
    ordinal: i64,
) -> Result<ConversationFileChangeSummary, ConversationServiceError> {
    let checkpoint = sqlx::query_as::<_, ConversationCheckpointRow>(
        r#"SELECT id, ordinal, before_snapshot_json
           FROM conversation_checkpoints
           WHERE conversation_id = ? AND ordinal = ?
           ORDER BY created_at DESC
           LIMIT 1"#,
    )
    .bind(conversation_id)
    .bind(ordinal)
    .fetch_optional(&deployment.db().pool)
    .await?
    .ok_or_else(|| {
        ConversationServiceError::NotFound(format!(
            "No checkpoint at ordinal {ordinal} for conversation {conversation_id}"
        ))
    })?;

    let collected =
        collect_checkpoint_file_changes(deployment, conversation_id, &checkpoint).await?;
    let summary = checkpoint_file_change_summary(&collected.files);
    Ok(ConversationFileChangeSummary {
        source: "checkpoint_preview".to_string(),
        files: collected.files,
        summary: Some(summary),
    })
}

pub async fn finalize_checkpoint_file_changes<D: Deployment + ?Sized>(
    deployment: &D,
    conversation_id: Uuid,
    turn_id: Uuid,
) -> Result<Option<ConversationEventEnvelope>, ConversationServiceError> {
    let pool = &deployment.db().pool;
    let Some(checkpoint) = sqlx::query_as::<_, ConversationCheckpointRow>(
        r#"SELECT id, ordinal, before_snapshot_json
           FROM conversation_checkpoints
           WHERE conversation_id = ? AND turn_id = ? AND finalized_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1"#,
    )
    .bind(conversation_id)
    .bind(turn_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };

    let collected =
        collect_checkpoint_file_changes(deployment, conversation_id, &checkpoint).await?;
    let files = collected.files;
    let after_repos = collected.after_repos;

    let after_snapshot_json = serde_json::json!({
        "ordinal": checkpoint.ordinal,
        "repos": after_repos,
    })
    .to_string();
    let diff_summary = checkpoint_file_change_summary(&files);
    let diff_summary_json = serde_json::to_string(&serde_json::json!({
        "fileCount": files.len(),
        "summary": diff_summary,
        "before": checkpoint.before_snapshot_json,
    }))?;

    sqlx::query(
        r#"UPDATE conversation_checkpoints
           SET after_snapshot_json = ?,
               diff_summary_json = ?,
               finalized_at = datetime('now', 'subsec')
           WHERE id = ?"#,
    )
    .bind(&after_snapshot_json)
    .bind(&diff_summary_json)
    .bind(checkpoint.id)
    .execute(pool)
    .await?;

    if files.is_empty() {
        return Ok(None);
    }

    let event = ConversationEvent::FileChangeSummaryUpdated {
        summary: ConversationFileChangeSummary {
            source: "checkpoint_diff".to_string(),
            files,
            summary: Some(diff_summary),
        },
    };
    let value = serde_json::to_value(&event)?;
    let event_kind = value["kind"].as_str().unwrap_or("unknown").to_string();
    let normalized_json = serde_json::to_string(&event)?;
    let idempotency_key = format!("checkpoint:{turn_id}:file_changes");
    let record = ConversationEventAppender::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "system",
            event_kind: &event_kind,
            normalized_json: &normalized_json,
            raw_json: Some(&diff_summary_json),
            idempotency_key: Some(&idempotency_key),
        },
    )
    .await?;

    Ok(Some(ConversationEventEnvelope {
        id: record.id,
        conversation_id: record.conversation_id,
        turn_id: record.turn_id,
        sequence: record.sequence,
        source: record.source,
        event,
        created_at: record.created_at,
    }))
}

async fn record_conversation_checkpoint(
    deployment: &dyn Deployment,
    pool: &SqlitePool,
    conversation_id: Uuid,
    turn_id: Uuid,
    ordinal: i64,
) -> Result<(), ConversationServiceError> {
    let checkpoints = SessionCheckpoint::find_by_ordinal(pool, conversation_id, ordinal).await?;
    let conversation = ConversationRecord::find_by_id(pool, conversation_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!("Conversation {conversation_id} not found"))
        })?;
    let workspace = Workspace::find_by_id(pool, conversation.workspace_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!(
                "Workspace {} not found",
                conversation.workspace_id
            ))
        })?;
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    let before_snapshot_json = serde_json::json!({
        "ordinal": ordinal,
        "repos": checkpoints
            .iter()
            .map(|checkpoint| {
                let files = repos
                    .iter()
                    .find(|repo| repo.id == checkpoint.repo_id)
                    .and_then(|repo| {
                        let repo_path = workspace
                            .repo_path(repo)
                            .unwrap_or_else(|| PathBuf::from(&container_ref));
                        let oid = git2::Oid::from_str(&checkpoint.before_head_commit).ok()?;
                        let base_commit = Commit::new(oid);
                        deployment
                            .container()
                            .git()
                            .get_diffs(
                                DiffTarget::Worktree {
                                    worktree_path: &repo_path,
                                    base_commit: &base_commit,
                                },
                                None,
                            )
                            .ok()
                    })
                    .unwrap_or_default();
                serde_json::json!({
                    "repoId": checkpoint.repo_id,
                    "beforeHeadCommit": checkpoint.before_head_commit,
                    "files": files,
                })
            })
            .collect::<Vec<_>>(),
    })
    .to_string();
    sqlx::query(
        r#"INSERT INTO conversation_checkpoints (
               id, conversation_id, turn_id, ordinal, before_snapshot_json
           )
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id, ordinal) DO UPDATE SET
               turn_id = excluded.turn_id,
               before_snapshot_json = excluded.before_snapshot_json"#,
    )
    .bind(Uuid::new_v4())
    .bind(conversation_id)
    .bind(turn_id)
    .bind(ordinal)
    .bind(before_snapshot_json)
    .execute(pool)
    .await?;
    Ok(())
}

fn checkpoint_before_files(
    before_snapshot_json: Option<&str>,
    repo_id: &str,
) -> Vec<ConversationFileChange> {
    let Some(snapshot) =
        before_snapshot_json.and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
    else {
        return Vec::new();
    };
    snapshot["repos"]
        .as_array()
        .and_then(|repos| {
            repos
                .iter()
                .find(|repo| repo["repoId"].as_str() == Some(repo_id))
        })
        .and_then(|repo| serde_json::from_value(repo["files"].clone()).ok())
        .unwrap_or_default()
}

/// Reads the v2 checkpoint payload. Unlike the legacy file summary, a full diff
/// snapshot preserves the worktree contents at the beginning of a turn, which
/// lets us compare the two endpoints instead of comparing both to the branch
/// head.
fn checkpoint_before_diffs(
    before_snapshot_json: Option<&str>,
    repo_id: &str,
) -> Option<Vec<utils::diff::Diff>> {
    let snapshot: serde_json::Value =
        before_snapshot_json.and_then(|json| serde_json::from_str(json).ok())?;
    let repo = snapshot["repos"]
        .as_array()?
        .iter()
        .find(|repo| repo["repoId"].as_str() == Some(repo_id))?;
    serde_json::from_value(repo["files"].clone()).ok()
}

fn checkpoint_turn_file_changes(
    before_diffs: &[utils::diff::Diff],
    after_diffs: &[utils::diff::Diff],
) -> Vec<ConversationFileChange> {
    let before_by_path = checkpoint_diffs_by_path(before_diffs);
    let after_by_path = checkpoint_diffs_by_path(after_diffs);
    let renamed_from_after = after_diffs
        .iter()
        .filter_map(|diff| {
            diff.old_path
                .as_ref()
                .filter(|old_path| diff.new_path.as_ref() != Some(*old_path))
                .cloned()
        })
        .collect::<BTreeSet<_>>();
    let paths = before_by_path
        .keys()
        .filter(|path| !renamed_from_after.contains(*path))
        .chain(after_by_path.keys())
        .cloned()
        .collect::<BTreeSet<_>>();

    paths
        .into_iter()
        .filter_map(|path| {
            let after = after_by_path.get(&path).copied();
            let before = before_by_path.get(&path).copied().or_else(|| {
                after.and_then(|diff| {
                    diff.old_path
                        .as_ref()
                        .and_then(|old_path| before_by_path.get(old_path).copied())
                })
            });
            checkpoint_turn_file_change(&path, before, after)
        })
        .collect()
}

fn checkpoint_diffs_by_path(diffs: &[utils::diff::Diff]) -> HashMap<String, &utils::diff::Diff> {
    diffs
        .iter()
        .filter_map(|diff| {
            let path = git::GitService::diff_path(diff);
            (!path.trim().is_empty()).then_some((path, diff))
        })
        .collect()
}

fn checkpoint_turn_file_change(
    path: &str,
    before: Option<&utils::diff::Diff>,
    after: Option<&utils::diff::Diff>,
) -> Option<ConversationFileChange> {
    let before_exists = before
        .map(|diff| diff.new_path.is_some())
        .unwrap_or_else(|| after.is_some_and(|diff| diff.old_path.is_some()));
    let after_exists = after
        .map(|diff| diff.new_path.is_some())
        .unwrap_or_else(|| before.is_some_and(|diff| diff.old_path.is_some()));
    let before_content = before
        .and_then(|diff| diff.new_content.as_deref())
        .or_else(|| after.and_then(|diff| diff.old_content.as_deref()));
    let after_content = after
        .and_then(|diff| diff.new_content.as_deref())
        .or_else(|| before.and_then(|diff| diff.old_content.as_deref()));

    let (change_kind, additions, deletions) = match (before_exists, after_exists) {
        (false, false) => return None,
        (false, true) => (
            "added",
            after_content.map(|content| content.lines().count() as i64),
            Some(0),
        ),
        (true, false) => (
            "deleted",
            Some(0),
            before_content.map(|content| content.lines().count() as i64),
        ),
        (true, true) => match (before_content, after_content) {
            (Some(before_content), Some(after_content)) if before_content == after_content => {
                return None;
            }
            (Some(before_content), Some(after_content)) => {
                let (additions, deletions) =
                    utils::diff::compute_line_change_counts(before_content, after_content);
                let change_kind = after
                    .map(|diff| diff_change_kind(&diff.change))
                    .unwrap_or("modified");
                (change_kind, Some(additions as i64), Some(deletions as i64))
            }
            // For binary or very large files, inline contents are deliberately
            // absent. We can still report endpoint changes that are unambiguous,
            // but never re-list an unchanged pre-existing opaque diff.
            _ if before.is_none() || after.is_none() => (
                after
                    .map(|diff| diff_change_kind(&diff.change))
                    .unwrap_or("modified"),
                None,
                None,
            ),
            _ => return None,
        },
    };

    Some(ConversationFileChange {
        path: path.to_string(),
        change_kind: change_kind.to_string(),
        additions,
        deletions,
        old_path: after
            .and_then(|diff| diff.old_path.clone())
            .filter(|old_path| old_path != path),
    })
}

fn diff_to_conversation_file_change(diff: utils::diff::Diff) -> Option<ConversationFileChange> {
    let path = git::GitService::diff_path(&diff);
    if path.trim().is_empty() {
        return None;
    }
    Some(ConversationFileChange {
        path,
        change_kind: diff_change_kind(&diff.change).to_string(),
        additions: diff.additions.map(|value| value as i64),
        deletions: diff.deletions.map(|value| value as i64),
        old_path: diff.old_path,
    })
}

fn diff_change_kind(change: &utils::diff::DiffChangeKind) -> &'static str {
    match change {
        utils::diff::DiffChangeKind::Added => "added",
        utils::diff::DiffChangeKind::Deleted => "deleted",
        utils::diff::DiffChangeKind::Renamed => "renamed",
        utils::diff::DiffChangeKind::Modified
        | utils::diff::DiffChangeKind::Copied
        | utils::diff::DiffChangeKind::PermissionChange => "modified",
    }
}

fn checkpoint_file_change_summary(files: &[ConversationFileChange]) -> String {
    let added = files
        .iter()
        .filter(|file| file.change_kind == "added")
        .count();
    let modified = files
        .iter()
        .filter(|file| file.change_kind == "modified")
        .count();
    let deleted = files
        .iter()
        .filter(|file| file.change_kind == "deleted")
        .count();
    let renamed = files
        .iter()
        .filter(|file| file.change_kind == "renamed")
        .count();
    format!(
        "{} file(s) changed: {} added, {} modified, {} deleted, {} renamed",
        files.len(),
        added,
        modified,
        deleted,
        renamed
    )
}

fn start_turn_input_payload(
    input: &ConversationStartTurnInput,
) -> Result<ConversationInputPayload, ConversationServiceError> {
    Ok(ConversationInputPayload {
        agent_id: input.agent_id.clone(),
        workspace_id: input.workspace_id,
        executor_profile_id: input
            .executor_profile_id
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| ConversationServiceError::BadRequest(error.to_string()))?,
        text: input.text.clone(),
        display_text: input.display_text.clone(),
        images: input.images.clone(),
        mode_override: input.mode_override.clone(),
        config_overrides: input.config_overrides.clone(),
        workflow_refs: input.workflow_refs.clone(),
        file_refs: input.file_refs.clone(),
    })
}

fn queued_turn_snapshot(conversation_id: Uuid) -> ConversationTurnSnapshot {
    ConversationTurnSnapshot {
        conversation_id,
        turn_id: Uuid::nil(),
        prompt_id: None,
        status: "queued".to_string(),
        last_sequence: 0,
    }
}

fn unused_prompt_snapshot(conversation_id: Uuid) -> AgentPromptSnapshot {
    let now = Utc::now();
    AgentPromptSnapshot {
        id: AgentPromptId::new(),
        session_id: AgentSessionId(conversation_id),
        status: AgentPromptStatus::Queued,
        text_preview: String::new(),
        created_at: now,
        updated_at: now,
    }
}

/// Drop a conversation's turn mutex only when the map holds its last reference.
///
/// The map itself owns one strong reference; anything above that is a live guard
/// holder. Evicting a referenced mutex lets the next `or_insert` mint a second one
/// for the same conversation, so two tasks can hold "the" turn lock at once.
fn prune_unreferenced_turn_lock(locks: &mut HashMap<Uuid, Arc<Mutex<()>>>, conversation_id: Uuid) {
    if locks
        .get(&conversation_id)
        .is_some_and(|lock| Arc::strong_count(lock) == 1)
    {
        locks.remove(&conversation_id);
    }
}

fn conversation_input_blocks_with_display_text(
    blocks: &[AgentContentBlock],
    display_text: &str,
) -> Vec<ConversationInputBlock> {
    let mut visible = Vec::with_capacity(blocks.len());
    if !display_text.trim().is_empty() {
        visible.push(ConversationInputBlock::Text {
            text: display_text.to_string(),
        });
    }
    visible.extend(blocks.iter().filter_map(|block| match block {
        AgentContentBlock::Text { .. } => None,
        AgentContentBlock::Image { mime_type, uri, .. } => Some(ConversationInputBlock::Image {
            uri: uri.clone().unwrap_or_else(|| "inline-image".to_string()),
            mime_type: mime_type.clone(),
            title: None,
        }),
        AgentContentBlock::Resource { uri, title } => Some(ConversationInputBlock::Resource {
            uri: uri.clone(),
            title: title.clone(),
            mime_type: None,
        }),
        AgentContentBlock::Protocol { content } => Some(ConversationInputBlock::Protocol {
            content: content.clone(),
        }),
    }));
    visible
}

/// What a freshly established session still needs in order to match the
/// conversation's remembered selection.
#[derive(Debug, Default, PartialEq, Eq)]
struct SessionControlReplayPlan {
    mode: Option<String>,
    config_overrides: Vec<AgentSessionConfigOverride>,
}

/// Diff the remembered selection against what the session currently advertises.
///
/// Only genuine differences are replayed. Re-sending a value the session already
/// holds is not free: some agents rebuild dependent config options on every
/// `session/set_config_option`, so a redundant replay on each session establishment
/// would churn the very controls it is meant to preserve.
fn session_control_replay_plan(
    remembered_mode: Option<String>,
    remembered_config: Vec<AgentSessionConfigOverride>,
    current: &AgentSessionControlsSnapshot,
) -> SessionControlReplayPlan {
    SessionControlReplayPlan {
        mode: remembered_mode.filter(|mode| current.current_mode.as_deref() != Some(mode.as_str())),
        config_overrides: remembered_config
            .into_iter()
            .filter(|selection| {
                !current.config_options.iter().any(|option| {
                    option.key == selection.key
                        && option.value.as_ref().and_then(|value| value.as_str())
                            == Some(selection.value.as_str())
                })
            })
            .collect(),
    }
}

/// Conversation selection wins per key over the agent's last-used / settings
/// defaults (CodeG `getSavedPrefsForConnect`).
fn session_control_preferences(
    binding: Option<&ConversationAgentBindingRecord>,
    agent_defaults: &[(String, serde_json::Value)],
) -> SessionControlPreferences {
    let mut config = Vec::new();
    for (key, value) in agent_defaults {
        if key == "mode" {
            continue;
        }
        let value = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        if value.is_empty() {
            continue;
        }
        config.push(AgentSessionConfigOverride {
            key: key.clone(),
            value,
        });
    }
    for override_item in binding_config_selection(binding) {
        if let Some(existing) = config
            .iter_mut()
            .find(|existing| existing.key == override_item.key)
        {
            existing.value = override_item.value;
        } else {
            config.push(override_item);
        }
    }
    let mode = binding_mode_selection(binding).or_else(|| {
        agent_defaults.iter().find_map(|(key, value)| {
            (key == "mode")
                .then(|| value.as_str().map(str::to_string))
                .flatten()
        })
    });
    SessionControlPreferences { mode, config }
}

fn binding_mode_selection(binding: Option<&ConversationAgentBindingRecord>) -> Option<String> {
    binding
        .and_then(|binding| binding.current_mode.clone())
        .map(|mode| mode.trim().to_string())
        .filter(|mode| !mode.is_empty())
}

fn binding_config_selection(
    binding: Option<&ConversationAgentBindingRecord>,
) -> Vec<AgentSessionConfigOverride> {
    binding
        .and_then(|binding| {
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(
                &binding.config_selection_json,
            )
            .ok()
        })
        .map(|selection| {
            selection
                .into_iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| AgentSessionConfigOverride {
                        key,
                        value: value.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Layer the composer's explicit selection on top of profile/slash defaults.
/// A user-picked mode replaces the default; user config overrides win per-key.
fn merge_user_prompt_overrides(
    overrides: &mut AgentPromptOverrides,
    mode_override: Option<String>,
    config_overrides: Vec<AgentSessionConfigOverride>,
) {
    if let Some(mode) = mode_override.and_then(|mode| {
        let trimmed = mode.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    }) {
        overrides.mode_override = Some(mode);
    }
    for ovr in config_overrides {
        if let Some(existing) = overrides
            .config_overrides
            .iter_mut()
            .find(|existing| existing.key == ovr.key)
        {
            existing.value = ovr.value;
        } else {
            overrides.config_overrides.push(ovr);
        }
    }
}

fn agent_prompt_overrides_from_profile(
    agent_id: &AgentId,
    profile: Option<&ExecutorProfileId>,
) -> AgentPromptOverrides {
    let Some(profile) = profile else {
        return AgentPromptOverrides::default();
    };

    if profile.executor != *agent_id {
        tracing::warn!(
            requested_agent = %agent_id,
            profile_executor = %profile.executor,
            "Ignoring executor profile overrides for mismatched ACP agent"
        );
    }

    // Every managed Agent is ACP-driven. Only explicit options selected from
    // the Agent's advertised session controls may be sent to a live session.
    AgentPromptOverrides::default()
}

fn parse_agent_connection_id(value: &str) -> Option<AgentConnectionId> {
    Uuid::parse_str(value).ok().map(AgentConnectionId)
}

fn binding_can_restore_agent_session(binding: Option<&ConversationAgentBindingRecord>) -> bool {
    binding.is_some_and(|binding| binding.resume_supported || binding.load_supported)
}

fn resume_external_session_id(
    known_id: Option<String>,
    can_restore: bool,
    has_live_connection: bool,
) -> Option<String> {
    known_id
        .filter(|id| !id.starts_with("vibex-new-session-"))
        .filter(|_| !has_live_connection)
        .filter(|_| can_restore)
}

fn is_placeholder_acp_session_id(id: &str) -> bool {
    id.starts_with("vibex-new-session-")
}

fn restorable_agent_binding<'a>(
    bindings: &'a [ConversationAgentBindingRecord],
    agent_id: &AgentId,
) -> Option<&'a ConversationAgentBindingRecord> {
    bindings.iter().find(|binding| {
        binding.agent_id == *agent_id
            && (binding.load_supported || binding.resume_supported)
            && binding
                .acp_session_id
                .as_deref()
                .is_some_and(|id| !is_placeholder_acp_session_id(id))
    })
}

fn known_acp_session_id(
    latest_binding: Option<&ConversationAgentBindingRecord>,
    persisted_session: Option<&Session>,
    agent_id: &AgentId,
) -> Option<String> {
    latest_binding
        .filter(|binding| binding.agent_id == *agent_id)
        .and_then(|binding| binding.acp_session_id.clone())
        .filter(|id| !is_placeholder_acp_session_id(id))
        .or_else(|| {
            persisted_session
                .filter(|session| {
                    session
                        .agent_id
                        .as_ref()
                        .is_some_and(|persisted_id| persisted_id == agent_id)
                })
                .and_then(|session| session.external_session_id.clone())
                .filter(|id| !is_placeholder_acp_session_id(id))
        })
}

fn parse_agent_prompt_id(value: &str) -> Option<AgentPromptId> {
    Uuid::parse_str(value).ok().map(AgentPromptId)
}

#[cfg(test)]
mod tests {
    use std::{str::FromStr, sync::Mutex as StdMutex};

    use agents::{
        AgentContentBlock, AgentId, AgentSessionConfigOverride,
        conversation::{
            AcpCapabilitySnapshot, ConversationAgentConnectionStatus, ConversationEvent,
            ConversationFileChange,
        },
    };
    use db::models::{
        conversation::{
            ConversationAgentBindingRecord, ConversationRecord, CreateConversationRecord,
        },
        conversation_event::AppendConversationEvent,
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
        session::{Session, SessionStatus},
    };
    use executors::profile::ExecutorProfileId;
    use sqlx::{
        SqlitePool,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };
    use utils::diff::{Diff, DiffChangeKind};
    use uuid::Uuid;

    use super::{
        AgentPromptOverrides, ConversationServiceError, agent_prompt_overrides_from_profile,
        binding_can_restore_agent_session, checkpoint_before_files, checkpoint_file_change_summary,
        checkpoint_turn_file_changes, conversation_input_blocks_with_display_text,
        diff_to_conversation_file_change, ensure_conversation_has_no_in_flight_turn,
        host_started_at, known_acp_session_id, merge_user_prompt_overrides,
        prune_unreferenced_turn_lock, resume_external_session_id, session_control_preferences,
        session_control_replay_plan, turn_predates_this_host,
    };

    #[test]
    fn conversation_selection_outranks_the_agents_last_used_defaults() {
        let agent_defaults = [
            (
                "mode".to_string(),
                serde_json::Value::String("default".into()),
            ),
            (
                "model".to_string(),
                serde_json::Value::String("sonnet".into()),
            ),
            (
                "thought_level".to_string(),
                serde_json::Value::String("low".into()),
            ),
        ];
        let prefs = session_control_preferences(None, &agent_defaults);
        assert_eq!(prefs.mode.as_deref(), Some("default"));
        assert_eq!(
            prefs
                .config
                .iter()
                .map(|item| (item.key.as_str(), item.value.as_str()))
                .collect::<Vec<_>>(),
            vec![("model", "sonnet"), ("thought_level", "low")]
        );

        let binding = ConversationAgentBindingRecord {
            id: Uuid::nil(),
            conversation_id: Uuid::nil(),
            agent_id: AgentId::parse("codex").expect("agent id"),
            working_dir: String::new(),
            acp_session_id: None,
            acp_protocol_version: None,
            runtime_version: None,
            acp_version: None,
            load_supported: false,
            resume_supported: false,
            close_supported: false,
            terminal_supported: false,
            additional_directories_supported: false,
            prompt_capabilities_json: "{}".into(),
            session_capabilities_json: "{}".into(),
            client_capabilities_json: "{}".into(),
            mcp_servers_json: "[]".into(),
            modes_json: "[]".into(),
            config_options_json: "[]".into(),
            current_mode: Some("bypassPermissions".into()),
            config_selection_json: r#"{"model":"opus"}"#.into(),
            status: "ready".into(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        let prefs = session_control_preferences(Some(&binding), &agent_defaults);
        assert_eq!(prefs.mode.as_deref(), Some("bypassPermissions"));
        assert_eq!(
            prefs
                .config
                .iter()
                .map(|item| (item.key.as_str(), item.value.as_str()))
                .collect::<Vec<_>>(),
            vec![("model", "opus"), ("thought_level", "low")]
        );
    }

    /// Regression: a re-established session reports the agent's own defaults, and
    /// those reached the UI unchallenged. The conversation would show "Approve for me"
    /// after a rebind even though the user had chosen full access and the next turn
    /// would run with full access.
    #[test]
    fn a_re_established_session_replays_the_remembered_selection_over_agent_defaults() {
        let agent_defaults = agents::AgentSessionControlsSnapshot {
            current_mode: Some("default".to_string()),
            config_options: vec![config_option("model", "sonnet")],
            ..Default::default()
        };

        let plan = session_control_replay_plan(
            Some("bypassPermissions".to_string()),
            vec![AgentSessionConfigOverride {
                key: "model".to_string(),
                value: "opus".to_string(),
            }],
            &agent_defaults,
        );

        assert_eq!(plan.mode.as_deref(), Some("bypassPermissions"));
        assert_eq!(
            plan.config_overrides
                .iter()
                .map(|item| (item.key.as_str(), item.value.as_str()))
                .collect::<Vec<_>>(),
            vec![("model", "opus")]
        );
    }

    /// Replaying a value the session already holds is not free: some agents rebuild
    /// dependent options on every `set_config_option`.
    #[test]
    fn a_remembered_selection_the_session_already_holds_is_not_replayed() {
        let already_applied = agents::AgentSessionControlsSnapshot {
            current_mode: Some("bypassPermissions".to_string()),
            config_options: vec![config_option("model", "opus")],
            ..Default::default()
        };

        let plan = session_control_replay_plan(
            Some("bypassPermissions".to_string()),
            vec![AgentSessionConfigOverride {
                key: "model".to_string(),
                value: "opus".to_string(),
            }],
            &already_applied,
        );

        assert_eq!(plan, Default::default());
    }

    fn config_option(key: &str, value: &str) -> agents::AgentSessionConfigOption {
        agents::AgentSessionConfigOption {
            key: key.to_string(),
            label: key.to_string(),
            description: None,
            category: None,
            value: Some(serde_json::Value::String(value.to_string())),
            choices: Vec::new(),
            dependency: None,
        }
    }

    /// Regression: `forget_conversation_runtime` used to evict the turn mutex while
    /// `truncate_to_turn` / `rebind_session` still held its guard, so the next
    /// `or_insert` minted a second mutex and two tasks could run turns concurrently.
    #[tokio::test]
    async fn a_held_turn_lock_survives_pruning_and_keeps_its_identity() {
        use std::{collections::HashMap, sync::Arc};

        use tokio::sync::Mutex;

        let conversation_id = Uuid::new_v4();
        let mut locks: HashMap<Uuid, Arc<Mutex<()>>> = HashMap::new();
        let lock = Arc::clone(locks.entry(conversation_id).or_default());
        let _guard = lock.lock().await;

        prune_unreferenced_turn_lock(&mut locks, conversation_id);

        let same_lock = Arc::clone(
            locks
                .get(&conversation_id)
                .expect("a referenced turn lock must not be pruned"),
        );
        assert!(Arc::ptr_eq(&lock, &same_lock));
        assert!(
            same_lock.try_lock().is_err(),
            "the surviving lock must still be the one the guard holds"
        );

        drop(_guard);
        drop(same_lock);
        drop(lock);
        prune_unreferenced_turn_lock(&mut locks, conversation_id);
        assert!(
            !locks.contains_key(&conversation_id),
            "an unreferenced turn lock must be pruned so the map stays bounded"
        );
    }

    async fn migrated_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory db");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    #[derive(Default)]
    struct RecordingConversationEventPublisher {
        published_sequences: StdMutex<Vec<i64>>,
    }

    #[async_trait::async_trait]
    impl super::ConversationEventPublisher for RecordingConversationEventPublisher {
        async fn publish(&self, record: &db::models::conversation_event::ConversationEventRecord) {
            self.published_sequences
                .lock()
                .expect("publisher lock")
                .push(record.sequence);
        }
    }

    #[tokio::test]
    async fn append_boundary_publishes_committed_event_before_returning() {
        let pool = migrated_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: Some("Publish boundary"),
                initial_prompt: None,
                status: Some(SessionStatus::InProgress),
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");
        let event = ConversationEvent::AgentConnectionStatusChanged {
            status: ConversationAgentConnectionStatus::Closed,
        };
        let normalized_json = serde_json::to_string(&event).expect("serialize event");
        let publisher = RecordingConversationEventPublisher::default();

        let record = super::append_and_publish_conversation_event(
            &pool,
            &publisher,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "runtime",
                event_kind: "agent_connection_status_changed",
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: Some("publish-boundary"),
            },
        )
        .await
        .expect("append and publish");

        assert_eq!(
            *publisher
                .published_sequences
                .lock()
                .expect("publisher lock"),
            vec![record.sequence]
        );
    }

    async fn seed_conversation_with_active_turn(pool: &SqlitePool) -> ConversationRecord {
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: Some("Guard test"),
                initial_prompt: Some("hello"),
                status: Some(SessionStatus::InProgress),
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");

        let turn = ConversationTurnRecord::create_pending(
            pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: None,
                text_preview: Some("hello"),
                input_blocks_json: r#"[{"kind":"text","text":"hello"}]"#,
            },
        )
        .await
        .expect("create turn");
        ConversationRecord::update_active_turn(pool, conversation_id, Some(turn.id))
            .await
            .expect("set active turn");

        ConversationRecord::find_by_id(pool, conversation_id)
            .await
            .expect("find conversation")
            .expect("conversation exists")
    }

    #[tokio::test]
    async fn prepared_external_session_id_survives_until_first_turn() {
        let pool = migrated_pool().await;
        let conversation = ConversationRecord::create(
            &pool,
            Uuid::new_v4(),
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: Some("Prepared"),
                initial_prompt: None,
                status: Some(SessionStatus::Todo),
                executor: Some("codex"),
            },
        )
        .await
        .unwrap();
        let codex = AgentId::parse("codex").unwrap();
        Session::update_agent_metadata(
            &pool,
            conversation.id,
            Some("external-prepared-1"),
            Some(&codex),
        )
        .await
        .unwrap();
        let persisted = Session::find_by_id(&pool, conversation.id)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            known_acp_session_id(None, Some(&persisted), &AgentId::parse("codex").unwrap())
                .as_deref(),
            Some("external-prepared-1")
        );
        assert_eq!(
            known_acp_session_id(
                None,
                Some(&persisted),
                &AgentId::parse("claude_code").unwrap()
            ),
            None
        );
    }

    #[test]
    fn imported_history_follow_up_cold_starts_instead_of_resuming_the_original_session() {
        assert!(!binding_can_restore_agent_session(None));
        assert_eq!(
            resume_external_session_id(Some("claude-original-session".to_string()), false, false,),
            None
        );
        assert_eq!(
            resume_external_session_id(Some("acp-live-1".to_string()), true, false).as_deref(),
            Some("acp-live-1")
        );
        assert_eq!(
            resume_external_session_id(Some("acp-live-1".to_string()), true, true),
            None
        );
    }

    #[test]
    fn restart_interrupt_only_applies_to_turns_from_the_previous_host() {
        let started = host_started_at();
        assert!(!turn_predates_this_host(started));
        assert!(!turn_predates_this_host(
            started + chrono::Duration::seconds(1)
        ));
        assert!(turn_predates_this_host(
            started - chrono::Duration::seconds(1)
        ));
    }

    #[test]
    fn conversation_start_turn_maps_agent_blocks_to_input_blocks() {
        let blocks = conversation_input_blocks_with_display_text(
            &[
                AgentContentBlock::Text {
                    text: "hello".to_string(),
                },
                AgentContentBlock::Image {
                    data: "abc".to_string(),
                    mime_type: "image/png".to_string(),
                    uri: Some("image.png".to_string()),
                },
            ],
            "hello",
        );

        assert_eq!(blocks.len(), 2);
    }

    #[test]
    fn hidden_agent_suffix_is_not_persisted_in_the_visible_user_message() {
        let blocks = conversation_input_blocks_with_display_text(
            &[
                AgentContentBlock::Text {
                    text: "visible request\n\nhidden commit instruction".to_string(),
                },
                AgentContentBlock::Image {
                    data: "abc".to_string(),
                    mime_type: "image/png".to_string(),
                    uri: Some("image.png".to_string()),
                },
            ],
            "visible request",
        );

        assert!(matches!(
            &blocks[0],
            agents::conversation::ConversationInputBlock::Text { text }
                if text == "visible request"
        ));
        assert_eq!(blocks.len(), 2);
    }

    #[test]
    fn user_prompt_overrides_take_precedence_over_profile_defaults() {
        let mut overrides = AgentPromptOverrides {
            mode_override: Some("plan".to_string()),
            config_overrides: vec![AgentSessionConfigOverride {
                key: "reasoning".to_string(),
                value: "low".to_string(),
            }],
        };

        merge_user_prompt_overrides(
            &mut overrides,
            Some("code".to_string()),
            vec![
                // Overrides the existing key…
                AgentSessionConfigOverride {
                    key: "reasoning".to_string(),
                    value: "high".to_string(),
                },
                // …and adds a new one.
                AgentSessionConfigOverride {
                    key: "verbosity".to_string(),
                    value: "concise".to_string(),
                },
            ],
        );

        assert_eq!(overrides.mode_override.as_deref(), Some("code"));
        assert_eq!(overrides.config_overrides.len(), 2);
        let reasoning = overrides
            .config_overrides
            .iter()
            .find(|o| o.key == "reasoning")
            .unwrap();
        assert_eq!(reasoning.value, "high");
    }

    #[test]
    fn blank_user_mode_override_keeps_the_default() {
        let mut overrides = AgentPromptOverrides {
            mode_override: Some("plan".to_string()),
            config_overrides: Vec::new(),
        };

        merge_user_prompt_overrides(&mut overrides, Some("   ".to_string()), Vec::new());

        assert_eq!(overrides.mode_override.as_deref(), Some("plan"));
    }

    #[test]
    fn local_acp_runtime_profiles_do_not_inject_session_controls() {
        for agent_id in [
            "codex",
            "claude_code",
            "opencode",
            "gemini",
            "openclaw",
            "cline",
            "hermes",
            "registry_generic",
        ] {
            let profile = ExecutorProfileId {
                executor: AgentId::parse(agent_id).unwrap(),
                variant: Some("PLAN".to_string()),
                model: Some("stale-profile-model".to_string()),
                fast_mode: Some(true),
                reasoning_effort: Some("high".to_string()),
            };

            let overrides = agent_prompt_overrides_from_profile(&profile.executor, Some(&profile));

            assert_eq!(
                overrides.mode_override, None,
                "{agent_id} profile must not write an unverified mode"
            );
            assert!(
                overrides.config_overrides.is_empty(),
                "{agent_id} profile must not write unverified session controls"
            );
        }
    }

    #[test]
    fn catalog_managed_agent_explicit_session_controls_survive_profile_suppression() {
        let profile = ExecutorProfileId {
            executor: AgentId::parse("codex").unwrap(),
            variant: Some("GPT_5_5".to_string()),
            model: Some("stale-profile-model".to_string()),
            fast_mode: Some(true),
            reasoning_effort: Some("high".to_string()),
        };
        let mut overrides = agent_prompt_overrides_from_profile(&profile.executor, Some(&profile));

        // These are the controls the user picked from the verified persisted catalog
        // (or the live ACP selector) when creating the first session.
        merge_user_prompt_overrides(
            &mut overrides,
            Some("plan".to_string()),
            vec![
                AgentSessionConfigOverride {
                    key: "model".to_string(),
                    value: "gpt-5.6-sol".to_string(),
                },
                AgentSessionConfigOverride {
                    key: "reasoning_effort".to_string(),
                    value: "xhigh".to_string(),
                },
                AgentSessionConfigOverride {
                    key: "fast_mode".to_string(),
                    value: "true".to_string(),
                },
            ],
        );

        assert_eq!(overrides.mode_override.as_deref(), Some("plan"));
        assert_eq!(
            overrides.config_overrides,
            vec![
                AgentSessionConfigOverride {
                    key: "model".to_string(),
                    value: "gpt-5.6-sol".to_string(),
                },
                AgentSessionConfigOverride {
                    key: "reasoning_effort".to_string(),
                    value: "xhigh".to_string(),
                },
                AgentSessionConfigOverride {
                    key: "fast_mode".to_string(),
                    value: "true".to_string(),
                },
            ]
        );
    }

    #[test]
    fn generic_acp_profiles_do_not_inject_unadvertised_overrides() {
        let profile = ExecutorProfileId {
            executor: AgentId::parse("qa_mock").unwrap(),
            variant: None,
            model: Some("qa-model".to_string()),
            fast_mode: Some(true),
            reasoning_effort: Some("high".to_string()),
        };

        let overrides = agent_prompt_overrides_from_profile(&profile.executor, Some(&profile));

        assert_eq!(overrides.mode_override, None);
        assert!(overrides.config_overrides.is_empty());
    }

    #[test]
    fn conversation_capabilities_are_conservative_until_handshake_event() {
        let capabilities = AcpCapabilitySnapshot::default();

        assert!(!capabilities.prompt.text);
        assert!(!capabilities.prompt.image);
        assert!(!capabilities.load_session);
        assert!(!capabilities.close_session);
        assert!(!capabilities.terminal);
    }

    #[test]
    fn conversation_checkpoint_file_changes_map_git_diffs() {
        let change = diff_to_conversation_file_change(Diff {
            change: DiffChangeKind::Renamed,
            old_path: Some("src/old.rs".to_string()),
            new_path: Some("src/new.rs".to_string()),
            old_content: None,
            new_content: None,
            content_omitted: false,
            additions: Some(4),
            deletions: Some(1),
            repo_id: None,
        })
        .expect("file change");

        assert_eq!(change.path, "src/new.rs");
        assert_eq!(change.old_path.as_deref(), Some("src/old.rs"));
        assert_eq!(change.change_kind, "renamed");
        assert_eq!(change.additions, Some(4));
        assert_eq!(
            checkpoint_file_change_summary(&[change]),
            "1 file(s) changed: 0 added, 0 modified, 0 deleted, 1 renamed"
        );
    }

    #[test]
    fn checkpoint_file_summary_excludes_preexisting_worktree_changes() {
        let existing = ConversationFileChange {
            path: "src/existing.rs".to_string(),
            change_kind: "modified".to_string(),
            additions: Some(2),
            deletions: Some(1),
            old_path: None,
        };
        let snapshot = serde_json::json!({
            "repos": [{ "repoId": "repo-1", "files": [existing.clone()] }]
        })
        .to_string();

        let before = checkpoint_before_files(Some(&snapshot), "repo-1");
        let current = vec![existing];

        assert!(current.iter().all(|file| before.contains(file)));
        assert!(!current.into_iter().any(|file| !before.contains(&file)));
    }

    fn modified_diff(path: &str, old_content: &str, new_content: &str) -> Diff {
        Diff {
            change: DiffChangeKind::Modified,
            old_path: Some(path.to_string()),
            new_path: Some(path.to_string()),
            old_content: Some(old_content.to_string()),
            new_content: Some(new_content.to_string()),
            content_omitted: false,
            additions: None,
            deletions: None,
            repo_id: None,
        }
    }

    #[test]
    fn checkpoint_file_summary_only_reports_changes_made_after_turn_start() {
        let before = vec![
            modified_diff("src/already-dirty.ts", "base\n", "base\nlocal\n"),
            modified_diff("src/untouched.ts", "old\n", "old\nlocal\n"),
        ];
        let after = vec![
            modified_diff("src/already-dirty.ts", "base\n", "base\nlocal\nagent\n"),
            modified_diff("src/untouched.ts", "old\n", "old\nlocal\n"),
            modified_diff("src/new-change.ts", "before\n", "after\n"),
        ];

        let files = checkpoint_turn_file_changes(&before, &after);

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/already-dirty.ts");
        assert_eq!(files[0].change_kind, "modified");
        assert_eq!(files[0].additions, Some(1));
        assert_eq!(files[0].deletions, Some(0));
        assert_eq!(files[1].path, "src/new-change.ts");
        assert_eq!(files[1].additions, Some(1));
        assert_eq!(files[1].deletions, Some(1));
    }

    #[test]
    fn checkpoint_file_summary_omits_a_preexisting_change_when_unchanged() {
        let before = vec![modified_diff("src/dirty.ts", "base\n", "base\nlocal\n")];
        let after = before.clone();

        assert!(checkpoint_turn_file_changes(&before, &after).is_empty());
    }

    #[tokio::test]
    async fn in_flight_active_turn_blocks_starting_another_turn() {
        let pool = migrated_pool().await;
        let conversation = seed_conversation_with_active_turn(&pool).await;

        let error = ensure_conversation_has_no_in_flight_turn(&pool, &conversation)
            .await
            .expect_err("pending active turn should block");

        assert!(matches!(
            error,
            ConversationServiceError::Conflict(message) if message.contains("active turn")
        ));
    }

    #[tokio::test]
    async fn terminal_active_turn_does_not_block_next_turn() {
        let pool = migrated_pool().await;
        let conversation = seed_conversation_with_active_turn(&pool).await;
        let active_turn_id = conversation
            .active_turn_id
            .expect("seeded conversation has active turn");

        ConversationTurnRecord::mark_completed(&pool, active_turn_id, Some("end_turn"), None, None)
            .await
            .expect("mark completed");

        ensure_conversation_has_no_in_flight_turn(&pool, &conversation)
            .await
            .expect("completed active turn should not block");
    }
}
