use std::{collections::HashMap, path::PathBuf, sync::Arc};

use agents::{
    AgentAutoApproveMode, AgentConnectionId, AgentContentBlock, AgentId, AgentPromptId,
    AgentRuntime, AgentSessionConfigOverride, AgentSessionId, SessionLaunchLock,
    conversation::{ConversationError, ConversationEvent, ConversationWorkflowRef},
};
use db::models::{
    conversation::ConversationRecord, conversation_event::AppendConversationEvent,
    conversation_turn::ConversationTurnRecord, repo::Repo, workspace::Workspace,
};
use deployment::Deployment;
use executors::profile::ExecutorProfileId;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use ts_rs::TS;
use uuid::Uuid;

use crate::{ConversationEventAppender, ConversationInputControlError};

#[path = "turn/binding.rs"]
pub(crate) mod binding;
#[path = "turn/commit.rs"]
mod commit;
#[path = "turn/continuation.rs"]
mod continuation;
#[path = "turn/queue.rs"]
mod queue;
#[path = "turn/recover.rs"]
mod recover;
#[path = "turn/start.rs"]
mod start;
#[path = "turn/steer.rs"]
mod steer;

pub use binding::remember_creation_session_controls;
pub use commit::{finalize_checkpoint_file_changes, preview_checkpoint_file_changes};
pub use queue::{
    CreateDelegatedConversation, CreateForkConversation, CreateWorkflowConversation,
    ForkVisibleConversation, create_delegated_conversation, create_fork_conversation,
    create_workflow_conversation, fork_visible_conversation,
};
pub use start::{
    AfterTurnEvent, BeforeTurnContext, RuntimeEventNotification, clear_turn_hooks,
    register_after_turn_hook, register_before_turn_hook, subscribe_after_turn_events,
    subscribe_runtime_events,
};
pub(crate) use start::{
    collect_registered_before_turn_contributions, emit_after_turn_event, emit_runtime_event,
    spawn_turn_end_collaboration_cleanup,
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

impl ConversationServiceError {
    /// Queue dispatch may retry a transient Internal failure. Bind/load failures
    /// that need the user to rebind or reload must not spawn another attempt:
    /// that loop re-emits `AgentBindingLoadFailed` and desktop session toasts.
    pub fn should_retry_queued_dispatch(&self) -> bool {
        matches!(self, Self::Internal(_))
    }

    pub(self) fn turn_failure(&self) -> ConversationError {
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
                code: reason.code(),
                message: session_load_failure_message(&reason),
            },
            agents::AgentError::AcpSessionNotBound => Self::SessionUnavailable {
                code: "acp_session_not_bound",
                message: "ACP session is not bound on this connection".into(),
            },
            agents::AgentError::ConnectionNotFound(_)
            | agents::AgentError::SessionNotFound(_)
            | agents::AgentError::PromptNotFound(_) => Self::NotFound(e.to_string()),
            agents::AgentError::PiProjectTrustRequired(message)
            | agents::AgentError::NotInstalled(message) => Self::BadRequest(message),
            _ => Self::Internal(e.to_string()),
        }
    }
}

fn session_load_failure_message(reason: &agents::SessionLoadFailureReason) -> String {
    match reason {
        agents::SessionLoadFailureReason::ResourceNotFound => {
            "代理侧已不存在该会话。可见历史仍在，但 Agent 隐藏上下文已丢失。确认重新绑定后才能继续。"
                .into()
        }
        agents::SessionLoadFailureReason::AuthenticationRequired { message } => message.clone(),
        agents::SessionLoadFailureReason::Unsupported => {
            "该代理无法恢复原会话。确认重新绑定后将冷启动，不会保留 Agent 侧上下文。".into()
        }
        agents::SessionLoadFailureReason::SessionArchived { recovery_command } => {
            match recovery_command {
                Some(command) => format!("代理会话已归档。运行 `{command}` 后重新加载。"),
                None => "代理会话已归档。确认重新绑定或新建对话后才能继续。".into(),
            }
        }
        agents::SessionLoadFailureReason::SessionBusy => {
            "代理会话正被占用。关闭占用该会话的窗口后重新加载，不要新建会话。".into()
        }
        agents::SessionLoadFailureReason::SessionUnavailable => {
            "代理侧会话已结束或不存在。可见历史仍在，但 Agent 隐藏上下文已丢失。".into()
        }
        agents::SessionLoadFailureReason::Other { message } => message.clone(),
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
            ConversationInputControlError::BindingRevisionConflict => Self::SessionUnavailable {
                code: "binding_revision_conflict",
                message: error.to_string(),
            },
            ConversationInputControlError::ContinuationNotAllowed => Self::SessionUnavailable {
                code: "continuation_not_allowed",
                message: error.to_string(),
            },
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

    /// Optional `beforeTurn` hook allowing the Host to contribute implicit prompt blocks.
    async fn before_turn(
        &self,
        _ctx: &BeforeTurnContext,
    ) -> Result<Vec<agents::InternalPromptBlock>, ConversationServiceError> {
        Ok(Vec::new())
    }

    /// Optional `afterTurn` hook invoked when a turn reaches a terminal state.
    async fn after_turn(&self, _event: &AfterTurnEvent) {}
}

/// Receives a conversation event at the recorder boundary. `publish` runs after a
/// durable append. `publish_unpersisted` folds a transcript delta that was written
/// to the JSONL file and not inserted into `conversation_events`. The default
/// forwards to `publish`, which is only correct for a publisher that applies the
/// record it is given. A publisher that re-reads the durable tail must override it.
#[async_trait::async_trait]
pub trait ConversationEventPublisher: Send + Sync {
    async fn publish(&self, record: &db::models::conversation_event::ConversationEventRecord);

    async fn publish_unpersisted(
        &self,
        record: &db::models::conversation_event::ConversationEventRecord,
    ) {
        self.publish(record).await;
    }
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
    pub continuation_policy: Option<agents::conversation::ContinuationPolicy>,
    pub expected_binding_revision: Option<u64>,
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
    /// Implicit plugin prompt contributions injected into the Agent prompt under
    /// `<vibex-plugin-context>` while hidden from the user-facing timeline.
    pub internal_prompt_contributions: Vec<agents::InternalPromptBlock>,
    /// Present only when this turn was claimed from the durable input queue.
    /// InputDispatched(input -> turn) is persisted before any Agent prompt send.
    pub queued_input_claim: Option<QueuedConversationInputClaim>,
    /// Optional client operation id so a retried start/submit stays one input.
    pub operation_id: Option<Uuid>,
    /// Present when this turn was delivered from a collaboration space.
    pub collaboration_origin: Option<agents::CollaborationSpaceOrigin>,
}

#[derive(Debug, Clone, Copy)]
pub struct QueuedConversationInputClaim {
    pub input_id: Uuid,
    pub claim_token: Uuid,
}

/// Turn row, active pointer, and causal events after the per-conversation lock
/// is released. Agent I/O must not hold that lock: tokio's Mutex is not
/// reentrant, and Stop needs it during the ACP handshake.
struct CommittedTurnLaunch {
    input: ConversationStartTurnInput,
    origin: String,
    preparation_lock: Arc<Mutex<()>>,
    turn_id: Uuid,
    created_sequence: i64,
}

struct PreparedTurnPrompt {
    working_dir: String,
    additional_directories: Vec<PathBuf>,
    agent_blocks: Vec<AgentContentBlock>,
    display_blocks: Vec<AgentContentBlock>,
    smart_reminder: Option<String>,
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

#[derive(Debug, Clone, Default)]
struct AgentPromptOverrides {
    mode_override: Option<String>,
    config_overrides: Vec<AgentSessionConfigOverride>,
}

pub struct ConversationSessionService {
    ctx: ConversationContext,
}

pub struct ConversationSessionWarmup {
    context: ConversationContext,
}

impl ConversationSessionWarmup {
    pub fn new(context: ConversationContext) -> Self {
        Self { context }
    }
}

#[async_trait::async_trait]
impl crate::collaboration::SessionProcessWarmup for ConversationSessionWarmup {
    async fn ensure_process(&self, conversation_id: Uuid) -> Result<bool, String> {
        ConversationSessionService::new(self.context.clone())
            .warmup_session_process(conversation_id)
            .await
            .map_err(|error| error.to_string())
    }
}

impl ConversationSessionService {
    pub fn new(ctx: ConversationContext) -> Self {
        Self { ctx }
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

    pub(self) async fn turn_lock(&self, conversation_id: Uuid) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.ctx.turn_locks.lock().await;
        Arc::clone(
            locks
                .entry(conversation_id)
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    pub(self) async fn append_event(
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
        let pool = &self.ctx.deployment.db().pool;
        let binding_id: Option<Uuid> = sqlx::query_scalar("SELECT COALESCE((SELECT agent_binding_id FROM conversation_turns WHERE id = ?), active_agent_binding_id) FROM sessions WHERE id = ?")
            .bind(turn_id).bind(conversation_id).fetch_optional(pool).await?.flatten();
        append_and_publish_conversation_event(
            &self.ctx.deployment.db().pool,
            self.ctx.event_publisher.as_ref(),
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                binding_id,
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

    pub(self) async fn update_runtime_state(
        &self,
        conversation_id: Uuid,
        update: impl FnOnce(&mut ConversationRuntimeState),
    ) {
        let mut states = self.ctx.runtime_states.lock().await;
        let state = states.entry(conversation_id).or_default();
        update(state);
    }

    pub(self) async fn runtime_snapshot(&self, conversation_id: Uuid) -> ConversationRuntimeState {
        self.ctx
            .runtime_states
            .lock()
            .await
            .get(&conversation_id)
            .cloned()
            .unwrap_or_default()
    }

    pub(self) async fn runtime_connection_and_turn(
        &self,
        conversation_id: Uuid,
    ) -> Option<(AgentConnectionId, Option<Uuid>)> {
        let snapshot = self.runtime_snapshot(conversation_id).await;
        let connection_id = match snapshot
            .connection_id
            .as_deref()
            .and_then(parse_agent_connection_id)
        {
            Some(connection_id) => connection_id,
            None => {
                self.ctx
                    .agent_runtime
                    .live_connection_id(AgentSessionId(conversation_id))
                    .await?
            }
        };
        let active_turn_id = match snapshot.active_turn_id {
            Some(turn_id) => Some(turn_id),
            None => ConversationRecord::find_by_id(&self.ctx.deployment.db().pool, conversation_id)
                .await
                .ok()
                .flatten()
                .and_then(|record| record.active_turn_id),
        };
        Some((connection_id, active_turn_id))
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

fn parse_agent_connection_id(value: &str) -> Option<AgentConnectionId> {
    Uuid::parse_str(value).ok().map(AgentConnectionId)
}

fn parse_agent_prompt_id(value: &str) -> Option<AgentPromptId> {
    Uuid::parse_str(value).ok().map(AgentPromptId)
}

#[cfg(test)]
use self::{
    binding::{
        persist_confirmed_session_controls, session_control_preferences,
        session_control_replay_plan,
    },
    commit::{
        checkpoint_before_files, checkpoint_file_change_summary, checkpoint_turn_file_changes,
        diff_to_conversation_file_change,
    },
    recover::{
        host_started_at, is_zombie_in_flight_turn, known_acp_session_id,
        prune_unreferenced_turn_lock, restorable_agent_binding, resume_external_session_id,
        turn_predates_this_host,
    },
    start::{
        agent_prompt_overrides_from_profile, conversation_input_blocks_with_display_text,
        merge_user_prompt_overrides,
    },
};

#[cfg(test)]
mod tests {
    use std::{str::FromStr, sync::Mutex as StdMutex};

    use agents::{
        AgentContentBlock, AgentId, AgentSessionConfigOverride,
        conversation::{
            AcpCapabilitySnapshot, ConversationAgentConnectionStatus, ConversationEvent,
            ConversationFileChange, SessionLoadFailureReason,
        },
    };
    use db::models::{
        agent_management::SessionDefaultRepository,
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
        checkpoint_before_files, checkpoint_file_change_summary, checkpoint_turn_file_changes,
        conversation_input_blocks_with_display_text, diff_to_conversation_file_change,
        ensure_conversation_has_no_in_flight_turn, host_started_at, is_zombie_in_flight_turn,
        known_acp_session_id, merge_user_prompt_overrides, persist_confirmed_session_controls,
        prune_unreferenced_turn_lock, remember_creation_session_controls,
        resume_external_session_id, session_control_preferences, session_control_replay_plan,
        turn_predates_this_host,
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
            resume_allowed: true,
            invalidated_reason: None,
            connection_id: None,
            continuation_key: None,
            is_resume_head: false,
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

    #[test]
    fn session_load_failure_messages_keep_legible_chinese() {
        let message =
            super::session_load_failure_message(&SessionLoadFailureReason::ResourceNotFound);
        assert_eq!(
            message,
            "代理侧已不存在该会话。可见历史仍在，但 Agent 隐藏上下文已丢失。确认重新绑定后才能继续。"
        );
        assert!(
            !message.contains('?'),
            "encoding must not replace Chinese with question marks"
        );
        let archived =
            super::session_load_failure_message(&SessionLoadFailureReason::SessionArchived {
                recovery_command: Some("codex unarchive abc".into()),
            });
        assert_eq!(
            archived,
            "代理会话已归档。运行 `codex unarchive abc` 后重新加载。"
        );
    }

    #[test]
    fn queued_dispatch_does_not_retry_an_expired_agent_session() {
        let expired = ConversationServiceError::SessionUnavailable {
            code: "resource_not_found",
            message: "gone".into(),
        };
        assert!(
            !expired.should_retry_queued_dispatch(),
            "ResourceNotFound needs rebind; retrying ensure_session_controls storms toasts"
        );
        assert!(
            !ConversationServiceError::AuthenticationRequired("login".into())
                .should_retry_queued_dispatch()
        );
        assert!(
            ConversationServiceError::Internal("agent spawn timeout".into())
                .should_retry_queued_dispatch()
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

    /// Antigravity cold resume advertises Default and Gemini 3.8 Flash. A live
    /// conversation often has no binding row, so YOLO and Gemini 4 Argon chosen
    /// in the composer were never stored and the next resume painted the
    /// agent's defaults.
    #[tokio::test]
    async fn confirmed_yolo_and_gemini_4_argon_survive_a_bindingless_resume() {
        let pool = migrated_pool().await;
        let conversation = ConversationRecord::create(
            &pool,
            Uuid::new_v4(),
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: Some("Antigravity"),
                initial_prompt: None,
                status: Some(SessionStatus::InProgress),
                executor: Some("antigravity"),
            },
        )
        .await
        .expect("create conversation");
        let antigravity = AgentId::parse("antigravity").expect("agent id");
        Session::update_agent_metadata(
            &pool,
            conversation.id,
            Some("agy-session-1"),
            Some(&antigravity),
        )
        .await
        .expect("store agent id");
        SessionDefaultRepository::new(pool.clone())
            .upsert(
                &antigravity,
                "thinking_level",
                &serde_json::Value::String("high".into()).to_string(),
            )
            .await
            .expect("seed thinking level");

        persist_confirmed_session_controls(&pool, conversation.id, Some("yolo"), &[]).await;
        persist_confirmed_session_controls(
            &pool,
            conversation.id,
            None,
            &[AgentSessionConfigOverride {
                key: "model".into(),
                value: "gemini-4-argon".into(),
            }],
        )
        .await;

        let binding =
            ConversationAgentBindingRecord::active_for_conversation(&pool, conversation.id)
                .await
                .expect("read binding")
                .expect("confirmed Antigravity controls create a conversation binding");
        let bindings =
            ConversationAgentBindingRecord::list_for_conversation(&pool, conversation.id)
                .await
                .expect("list bindings");
        assert_eq!(
            bindings.len(),
            1,
            "each confirmed pick updates the same binding"
        );
        assert_eq!(binding.acp_session_id.as_deref(), Some("agy-session-1"));
        assert!(
            binding.mcp_servers_json.contains("vibex-delegation-mcp"),
            "remembering controls must not hide agent mentions"
        );
        let defaults = SessionDefaultRepository::new(pool.clone())
            .list_for_agent(&antigravity)
            .await
            .expect("list defaults")
            .into_iter()
            .filter_map(|record| {
                serde_json::from_str(&record.value_json)
                    .ok()
                    .map(|value| (record.option_id, value))
            })
            .collect::<Vec<_>>();
        let prefs = session_control_preferences(Some(&binding), &defaults);
        assert_eq!(prefs.mode.as_deref(), Some("yolo"));
        let mut config = prefs
            .config
            .iter()
            .map(|item| (item.key.as_str(), item.value.as_str()))
            .collect::<Vec<_>>();
        config.sort();
        assert_eq!(
            config,
            vec![("model", "gemini-4-argon"), ("thinking_level", "high"),]
        );

        let resumed_defaults = agents::AgentSessionControlsSnapshot {
            current_mode: Some("default".into()),
            config_options: vec![
                config_option("model", "gemini-3.8-flash"),
                config_option("thinking_level", "high"),
            ],
            ..Default::default()
        };
        let plan = session_control_replay_plan(
            prefs.mode.clone(),
            prefs.config.clone(),
            &resumed_defaults,
        );
        assert_eq!(plan.mode.as_deref(), Some("yolo"));
        assert_eq!(
            plan.config_overrides
                .iter()
                .map(|item| (item.key.as_str(), item.value.as_str()))
                .collect::<Vec<_>>(),
            vec![("model", "gemini-4-argon")]
        );
    }

    /// The create form's YOLO pick has to be on the binding before the ACP
    /// session exists. Otherwise establishment applies the agent's last-used
    /// Default, and a later resume has nothing else to replay.
    #[tokio::test]
    async fn creation_time_yolo_is_remembered_before_the_acp_session_exists() {
        let pool = migrated_pool().await;
        let conversation = ConversationRecord::create(
            &pool,
            Uuid::new_v4(),
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: Some("Antigravity"),
                initial_prompt: None,
                status: Some(SessionStatus::Todo),
                executor: Some("antigravity"),
            },
        )
        .await
        .expect("create conversation");
        let antigravity = AgentId::parse("antigravity").expect("agent id");
        Session::update_agent_metadata(&pool, conversation.id, None, Some(&antigravity))
            .await
            .expect("store agent id");
        SessionDefaultRepository::new(pool.clone())
            .upsert(
                &antigravity,
                "mode",
                &serde_json::Value::String("default".into()).to_string(),
            )
            .await
            .expect("seed last-used default mode");

        remember_creation_session_controls(
            &pool,
            conversation.id,
            Some(" yolo "),
            [AgentSessionConfigOverride {
                key: " model ".into(),
                value: " gemini-4-argon ".into(),
            }],
        )
        .await;

        let binding =
            ConversationAgentBindingRecord::active_for_conversation(&pool, conversation.id)
                .await
                .expect("read binding")
                .expect("creation controls open a binding before ACP exists");
        assert_eq!(binding.acp_session_id, None);
        assert_eq!(binding.current_mode.as_deref(), Some("yolo"));
        let defaults = SessionDefaultRepository::new(pool.clone())
            .list_for_agent(&antigravity)
            .await
            .expect("list defaults")
            .into_iter()
            .filter_map(|record| {
                serde_json::from_str(&record.value_json)
                    .ok()
                    .map(|value| (record.option_id, value))
            })
            .collect::<Vec<_>>();
        let prefs = session_control_preferences(Some(&binding), &defaults);
        assert_eq!(prefs.mode.as_deref(), Some("yolo"));
        let advertised = agents::AgentSessionControlsSnapshot {
            current_mode: Some("default".into()),
            config_options: vec![config_option("model", "gemini-3.8-flash")],
            ..Default::default()
        };
        let plan =
            session_control_replay_plan(prefs.mode.clone(), prefs.config.clone(), &advertised);
        assert_eq!(plan.mode.as_deref(), Some("yolo"));
        assert_eq!(
            plan.config_overrides
                .iter()
                .map(|item| (item.key.as_str(), item.value.as_str()))
                .collect::<Vec<_>>(),
            vec![("model", "gemini-4-argon")]
        );

        remember_creation_session_controls(&pool, conversation.id, Some("   "), std::iter::empty())
            .await;
        let unchanged =
            ConversationAgentBindingRecord::active_for_conversation(&pool, conversation.id)
                .await
                .expect("read binding")
                .expect("blank mode does not drop the binding");
        assert_eq!(unchanged.current_mode.as_deref(), Some("yolo"));
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

    /// Dispatch holds this mutex across claim → Turn commit. Starting that Turn
    /// must not lock it again: tokio Mutex is not reentrant, and the hang is the
    /// user-visible "generating" with no timeline message and a queued input.
    #[tokio::test]
    async fn the_conversation_turn_lock_cannot_be_reacquired_by_the_holding_task() {
        use std::sync::Arc;

        use tokio::sync::Mutex;

        let lock = Arc::new(Mutex::new(()));
        let _guard = lock.lock().await;
        assert!(
            lock.try_lock().is_err(),
            "dispatch_next_queued_input must call commit_new_turn while holding the lock, not start_turn_under_lock"
        );
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

    #[tokio::test]
    async fn host_restart_closes_ready_connection_even_after_binding_event() {
        let pool = migrated_pool().await;
        let conversation = seed_conversation_with_active_turn(&pool).await;
        let events = [
            serde_json::json!({"kind":"agent_connection_status_changed","status":"ready","bound":true}),
            serde_json::json!({"kind":"agent_binding_ready","acp_session_id":"acp-session","capabilities":{}}),
        ];
        for event in events {
            let normalized = event.to_string();
            crate::ConversationEventAppender::append(
                &pool,
                AppendConversationEvent {
                    id: Uuid::new_v4(),
                    conversation_id: conversation.id,
                    turn_id: None,
                    binding_id: None,
                    connection_id: Some("previous-host-connection"),
                    prompt_id: None,
                    source: "runtime",
                    event_kind: event["kind"].as_str().unwrap(),
                    normalized_json: &normalized,
                    raw_json: None,
                    idempotency_key: None,
                },
            )
            .await
            .unwrap();
        }
        let count =
            super::recover::reconcile_orphaned_connecting_conversations_in_pool(&pool, None)
                .await
                .unwrap();
        assert_eq!(count, 1);
        let fold = crate::ConversationProjector::fold(&pool, conversation.id)
            .await
            .unwrap();
        assert!(fold.side_rows.iter().any(|row| matches!(&row.row,
            agents::conversation::ConversationTimelineRow::SessionNotice {notice}
            if notice.connection_status.as_ref().is_some_and(|status| status.status == ConversationAgentConnectionStatus::Closed && !status.bound))));
        assert_eq!(
            super::recover::reconcile_orphaned_connecting_conversations_in_pool(&pool, None)
                .await
                .unwrap(),
            0
        );
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
            message: None,
            bound: false,
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
    fn stored_thread_id_is_resumed_even_when_the_binding_never_advertised_restore() {
        // 0.2.6 still forked Codex threads because resume was gated on
        // resume_supported/load_supported. Old bindings often stored the
        // real thread id with both flags false, so follow-up called
        // session/new and Codex APP showed a new thread B.
        assert_eq!(
            resume_external_session_id(Some("codex-thread-a".to_string()), false).as_deref(),
            Some("codex-thread-a")
        );
        assert_eq!(
            resume_external_session_id(Some("claude-original-session".to_string()), false)
                .as_deref(),
            Some("claude-original-session")
        );
    }

    #[test]
    fn placeholder_and_live_sessions_do_not_call_session_resume() {
        assert_eq!(
            resume_external_session_id(Some("".to_string()), false),
            None
        );
        assert_eq!(
            resume_external_session_id(Some("vibex-new-session-abc".to_string()), false),
            None
        );
        assert_eq!(
            resume_external_session_id(Some("pending-abc".to_string()), false),
            None
        );
        assert_eq!(
            resume_external_session_id(Some("prepared-abc".to_string()), false),
            None
        );
        assert_eq!(
            resume_external_session_id(Some("acp-live-1".to_string()), true),
            None
        );
    }

    fn sample_binding(
        agent_id: AgentId,
        acp_session_id: &str,
        resume_supported: bool,
    ) -> ConversationAgentBindingRecord {
        ConversationAgentBindingRecord {
            resume_allowed: true,
            invalidated_reason: None,
            connection_id: None,
            continuation_key: None,
            is_resume_head: false,
            id: Uuid::new_v4(),
            conversation_id: Uuid::new_v4(),
            agent_id,
            working_dir: "/tmp".to_string(),
            acp_session_id: Some(acp_session_id.to_string()),
            acp_protocol_version: None,
            runtime_version: None,
            acp_version: None,
            load_supported: resume_supported,
            resume_supported,
            close_supported: false,
            terminal_supported: false,
            additional_directories_supported: false,
            prompt_capabilities_json: "{}".to_string(),
            session_capabilities_json: "{}".to_string(),
            client_capabilities_json: "{}".to_string(),
            mcp_servers_json: "[]".to_string(),
            modes_json: "[]".to_string(),
            config_options_json: "[]".to_string(),
            current_mode: None,
            config_selection_json: "{}".to_string(),
            status: "ready".to_string(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn restorable_binding_uses_the_newest_real_id_and_ignores_older_threads() {
        let codex = AgentId::parse("codex").unwrap();
        let older = sample_binding(codex.clone(), "thread-old", true);
        let newer = sample_binding(codex.clone(), "thread-new", false);
        assert_eq!(
            super::restorable_agent_binding(&[older.clone(), newer], &codex)
                .and_then(|binding| binding.acp_session_id.clone())
                .as_deref(),
            Some("thread-new")
        );

        let rebound = sample_binding(codex.clone(), "vibex-new-session-rebound", false);
        assert!(
            super::restorable_agent_binding(&[older, rebound], &codex).is_none(),
            "a rebind placeholder must not resume the abandoned older thread"
        );
    }

    #[test]
    fn stop_then_continue_resumes_stored_id_when_acp_session_is_unbound() {
        // A live connection id without a bound ACP session (cancel never
        // acknowledged) must resume this conversation's stored id, not skip
        // restore and call session/new.
        let resume_a = resume_external_session_id(Some("acp-session-a".to_string()), false);
        let resume_b = resume_external_session_id(Some("acp-session-b".to_string()), false);
        assert_eq!(resume_a.as_deref(), Some("acp-session-a"));
        assert_eq!(resume_b.as_deref(), Some("acp-session-b"));
        assert_ne!(resume_a, resume_b);
        assert_eq!(
            resume_external_session_id(Some("acp-session-a".to_string()), true),
            None
        );
    }

    #[test]
    fn zombie_in_flight_turn_is_only_the_dead_process_case() {
        assert!(
            is_zombie_in_flight_turn(true, false, false),
            "a running turn with no process cannot complete"
        );
        assert!(
            !is_zombie_in_flight_turn(true, false, true),
            "handshake still has a live process before session/resume binds"
        );
        assert!(
            !is_zombie_in_flight_turn(true, true, true),
            "a bound live session is generating, not a zombie"
        );
        assert!(!is_zombie_in_flight_turn(false, false, false));
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
            None,
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
            None,
        );

        assert!(matches!(
            &blocks[0],
            agents::conversation::ConversationInputBlock::Text { text }
                if text == "visible request"
        ));
        assert_eq!(blocks.len(), 2);
    }

    #[test]
    fn space_origin_is_a_protocol_block_ahead_of_display_text() {
        let origin = agents::CollaborationSpaceOrigin {
            space_id: "space-1".to_string(),
            thread_kind: "group".to_string(),
            sender_kind: "member".to_string(),
            sender_nickname: "小A".to_string(),
            sender_conversation_id: Some("conv-a".to_string()),
            sender_member_id: Some("member-a".to_string()),
        };
        let blocks = conversation_input_blocks_with_display_text(
            &[AgentContentBlock::Text {
                text: "full wrapper".to_string(),
            }],
            "请核对接口",
            Some(&origin),
        );
        assert!(matches!(
            &blocks[0],
            agents::conversation::ConversationInputBlock::Protocol { content }
                if content["kind"] == "collaboration_space_origin"
                    && content["senderNickname"] == "小A"
                    && content["threadKind"] == "group"
        ));
        assert!(matches!(
            &blocks[1],
            agents::conversation::ConversationInputBlock::Text { text }
                if text == "请核对接口"
        ));
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
