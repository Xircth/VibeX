//! Conversation read/write commands backed by the VibeX event log.
//!
//! Agent transcript files are import inputs only. Product conversation detail is
//! rebuilt from `conversation_events` through the DB projector.

use agents::{
    AgentAvailableCommand, AgentConnectionId, AgentElicitationId, AgentElicitationResponse,
    AgentEvent, AgentId, AgentPermissionResponse, AgentSessionConfigOption,
    AgentSessionConfigOverride, AgentSessionControlsSnapshot, AgentSessionId,
    ImportedAgentMessageRole, ImportedAgentSession,
    conversation::{
        AcpCapabilitySnapshot, ConversationAgentConnectionStatus, ConversationEvent,
        ConversationEventEnvelope, ConversationEventsPage, ConversationFileChangeSummary,
        ConversationInputBlock, ConversationRowPage, ConversationSessionModes,
        ConversationTimeline, ConversationTimelinePage, ConversationTimelineRow,
        ConversationToolCallPatch, ConversationWorkflowRef, MessageTurn, SessionStats, TurnUsage,
    },
};
use automation::{
    AgentSelectionIntent, ComposerCanonicalInput, IsolationSpec, PluginActionRef, TurnLaunchSpec,
    TurnLaunchSpecInput, WorkspaceTarget,
};
use conversations::{
    CONVERSATION_PROJECTION_VERSION, ConversationEventAppender, ConversationProjector,
    ConversationRelationControl, CreateConversationRelation,
};
use db::models::{
    conversation::{
        ConversationAgentBindingRecord, ConversationRecord, CreateConversationAgentBinding,
        CreateConversationRecord, DbConversationSummary,
    },
    conversation_event::{AppendConversationEvent, ConversationEventRecord},
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    session::SessionStatus,
    workspace::Workspace,
};
use executors::profile::ExecutorProfileId;
use plugins::PromptBlock;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    conversation_bundle::{
        ConversationExportResult, ConversationForkResult, ConversationImportResult,
        export_conversation_bundle, import_conversation_bundle,
    },
    conversation_service::{
        ConversationSessionService, ConversationStartTurnInput, ConversationTurnSnapshot,
    },
    error::AppError,
    state::AppState,
};

/// A conversation's metadata plus its event-sourced projection.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DbConversationDetail {
    pub summary: DbConversationSummary,
    /// Derived from `timeline` for transitional consumers only. The timeline is
    /// the canonical rendering contract.
    pub turns: Vec<MessageTurn>,
    pub timeline: ConversationTimeline,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_binding: Option<ConversationActiveBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_turn: Option<ConversationCurrentTurn>,
    pub projection_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_stats: Option<SessionStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_flight_user_turn_id: Option<String>,
    /// Latest agent-advertised session modes, hydrated from the event log so a
    /// reopened conversation renders the real ACP pickers immediately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_modes: Option<ConversationSessionModes>,
    /// Latest agent-advertised config options (model / permission / …), same
    /// hydration contract as `session_modes`.
    #[serde(default)]
    pub session_config_options: Vec<AgentSessionConfigOption>,
    /// Latest agent-advertised slash/skill catalog. `None` until the agent
    /// publishes `available_commands_update`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_commands: Option<Vec<AgentAvailableCommand>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationActiveBinding {
    pub id: Uuid,
    pub agent_type: String,
    pub working_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_session_id: Option<String>,
    pub status: String,
    pub capabilities: AcpCapabilitySnapshot,
    /// True when this binding was created while the multi-agent plugin was on,
    /// so Host delivered `vibex-delegation-mcp` on that session new/resume/rebind.
    #[serde(default)]
    pub delegation_mcp_delivered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationCurrentTurn {
    pub id: Uuid,
    pub ordinal: i64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_preview: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationStartTurnRequest {
    pub agent_id: AgentId,
    pub workspace_id: String,
    pub conversation_id: String,
    #[serde(default)]
    pub executor_profile_id: Option<ExecutorProfileId>,
    pub text: String,
    #[serde(default)]
    pub display_text: Option<String>,
    #[serde(default)]
    pub images: Vec<String>,
    /// Composer-selected session mode (from the agent's advertised modes).
    #[serde(default)]
    pub mode_override: Option<String>,
    /// Composer-selected config option overrides (advertised select options).
    #[serde(default)]
    pub config_overrides: Vec<AgentSessionConfigOverride>,
    /// Structured Plugin Workflow identities selected in the Composer for this turn.
    #[serde(default, alias = "pluginActions")]
    pub workflow_refs: Vec<ConversationWorkflowRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEventsSinceRequest {
    pub conversation_id: String,
    pub after_sequence: i64,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTimelinePageRequest {
    pub conversation_id: String,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPermissionResponseRequest {
    pub conversation_id: String,
    pub permission_id: String,
    pub response: AgentPermissionResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationQuestionResponseRequest {
    pub conversation_id: String,
    pub question_id: String,
    pub response: AgentElicitationResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSetSessionModeRequest {
    pub conversation_id: String,
    pub mode_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSetSessionConfigOptionRequest {
    pub conversation_id: String,
    pub key: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCancelTurnRequest {
    pub conversation_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCloseRequest {
    pub conversation_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSubmitFeedbackRequest {
    pub conversation_id: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTruncateToTurnRequest {
    pub conversation_id: String,
    /// The user-turn ordinal to reset to: this turn and everything after it is removed.
    pub ordinal: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCheckpointPreviewRequest {
    pub conversation_id: String,
    pub ordinal: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExportRequest {
    pub conversation_id: String,
    #[serde(default)]
    pub destination_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationImportRequest {
    pub workspace_id: String,
    pub bundle: agents::conversation::ConversationBundlePayload,
}

pub async fn conversation_detail_core(
    pool: &SqlitePool,
    id: Uuid,
) -> Result<Option<DbConversationDetail>, AppError> {
    let Some(summary) = DbConversationSummary::find_by_id(pool, id).await? else {
        return Ok(None);
    };
    let timeline = ConversationProjector::project(pool, id).await?;
    let turns = message_turns_from_timeline(&timeline);
    let session_stats = session_stats_from_turns(&turns);
    let active_binding = active_binding_for_conversation(pool, id).await?;
    let current_turn = current_turn_for_conversation(pool, id).await?;
    let in_flight_user_turn_id = current_turn.as_ref().and_then(|turn| {
        matches!(
            turn.status.as_str(),
            "pending" | "queued" | "running" | "blocked"
        )
        .then(|| turn.id.to_string())
    });
    let session_modes = latest_session_modes(pool, id).await?;
    let session_config_options = latest_session_config_options(pool, id).await?;
    let available_commands = latest_available_commands(pool, id).await?;
    Ok(Some(DbConversationDetail {
        summary,
        turns,
        timeline,
        active_binding,
        current_turn,
        projection_version: CONVERSATION_PROJECTION_VERSION,
        session_stats,
        in_flight_user_turn_id,
        session_modes,
        session_config_options,
        available_commands,
    }))
}

/// Latest agent-advertised session-mode state from the event log (None until the
/// agent's first `session/new` advertises modes).
async fn latest_session_modes(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<ConversationSessionModes>, AppError> {
    let record =
        ConversationEventRecord::latest_of_kind(pool, conversation_id, "session_mode_updated")
            .await?;
    Ok(record.and_then(|record| {
        match serde_json::from_str::<ConversationEvent>(&record.normalized_json) {
            Ok(ConversationEvent::SessionModeUpdated { current, modes }) => {
                Some(ConversationSessionModes { current, modes })
            }
            _ => None,
        }
    }))
}

/// Latest agent-advertised config options (model / permission / …) from the event log.
async fn latest_session_config_options(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Vec<AgentSessionConfigOption>, AppError> {
    let record = ConversationEventRecord::latest_of_kind(
        pool,
        conversation_id,
        "session_config_options_updated",
    )
    .await?;
    Ok(record
        .and_then(|record| {
            match serde_json::from_str::<ConversationEvent>(&record.normalized_json) {
                Ok(ConversationEvent::SessionConfigOptionsUpdated { options }) => Some(options),
                _ => None,
            }
        })
        .unwrap_or_default())
}

async fn latest_available_commands(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<Vec<AgentAvailableCommand>>, AppError> {
    let record = ConversationEventRecord::latest_of_kind(
        pool,
        conversation_id,
        "available_commands_updated",
    )
    .await?;
    Ok(record.and_then(|record| {
        match serde_json::from_str::<ConversationEvent>(&record.normalized_json) {
            Ok(ConversationEvent::AvailableCommandsUpdated { commands }) => Some(commands),
            _ => None,
        }
    }))
}

#[tauri::command]
pub async fn conversation_detail(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<Option<DbConversationDetail>, AppError> {
    let id = Uuid::parse_str(&session_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    conversation_detail_core(&state.deployment.db().pool, id).await
}

#[tauri::command]
pub async fn conversation_ensure_session_controls(
    state: tauri::State<'_, AppState>,
    conversation_id: String,
) -> Result<AgentSessionControlsSnapshot, AppError> {
    let id = Uuid::parse_str(&conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    ConversationSessionService::new(state.conversation_context())
        .ensure_session_controls(id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn conversation_rebind_session(
    state: tauri::State<'_, AppState>,
    conversation_id: String,
) -> Result<AgentSessionControlsSnapshot, AppError> {
    let id = Uuid::parse_str(&conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    ConversationSessionService::new(state.conversation_context())
        .rebind_session(id)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn conversation_list(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<DbConversationSummary>, remote_protocol::ErrorEnvelope> {
    use application::{
        ApplicationCore, ListConversations, Principal, SqliteConversationRepository,
    };
    use remote_protocol::{ErrorCode, ErrorEnvelope, OperationId};

    let workspace_id = Uuid::parse_str(&workspace_id).map_err(|error| {
        ErrorEnvelope::new(
            ErrorCode::BadRequest,
            format!("invalid workspace id: {error}"),
            false,
            OperationId::new(),
        )
    })?;
    let core = ApplicationCore::new(SqliteConversationRepository::new(
        state.deployment.db().pool.clone(),
    ));
    core.list_conversations(
        &Principal::local_desktop(),
        ListConversations { workspace_id },
    )
    .await
    .map_err(application::ApplicationError::into_envelope)
}

/// Closed application command adapter. Only names present in
/// `application::CommandRegistry` can cross this boundary.
#[tauri::command]
pub async fn application_call(
    state: tauri::State<'_, AppState>,
    command: String,
    operation_id: remote_protocol::OperationId,
    args: serde_json::Value,
) -> Result<remote_protocol::CommandResponse<serde_json::Value>, remote_protocol::ErrorEnvelope> {
    use application::{
        ApplicationCore, CommandRegistry, ConversationSessionExecutionPort, Principal,
        SqliteConversationRepository, WorkflowStoreExecutionPort,
    };

    CommandRegistry::new(ApplicationCore::with_execution_and_workflows(
        SqliteConversationRepository::new(state.deployment.db().pool.clone()),
        std::sync::Arc::new(ConversationSessionExecutionPort::new(
            state.conversation_context(),
        )),
        std::sync::Arc::new(WorkflowStoreExecutionPort::with_conversations(
            state.deployment.db().pool.clone(),
            state.conversation_context(),
        )),
    ))
    .execute_name(&Principal::local_desktop(), &command, operation_id, args)
    .await
}

#[tauri::command]
pub async fn conversation_attach(
    state: tauri::State<'_, AppState>,
    request: remote_protocol::SubscriptionRequest,
) -> Result<remote_protocol::SubscriptionBootstrap, remote_protocol::ErrorEnvelope> {
    use application::{
        ApplicationCore, ApplicationError, ConversationSubscriptionRegistrar, Principal,
        SqliteConversationRepository, WorkflowStoreExecutionPort,
    };
    use remote_protocol::SubscriptionResource;

    struct TauriConversationSubscriptions;

    #[async_trait::async_trait]
    impl ConversationSubscriptionRegistrar for TauriConversationSubscriptions {
        async fn register(
            &self,
            _subscription_id: remote_protocol::SubscriptionId,
            _conversation_id: remote_protocol::ConversationId,
        ) -> Result<(), ApplicationError> {
            // Tauri's process-wide event channel is already active; the desktop
            // transport installs its listener before invoking this command.
            Ok(())
        }
    }

    let core = ApplicationCore::with_workflows(
        SqliteConversationRepository::new(state.deployment.db().pool.clone()),
        std::sync::Arc::new(WorkflowStoreExecutionPort::with_conversations(
            state.deployment.db().pool.clone(),
            state.conversation_context(),
        )),
    );
    match request.resource {
        SubscriptionResource::Conversation {
            conversation_id,
            after_sequence,
        } => {
            core.attach_conversation(
                &Principal::local_desktop(),
                request.subscription_id,
                conversation_id,
                after_sequence,
                &TauriConversationSubscriptions,
            )
            .await
        }
        SubscriptionResource::WorkflowRun {
            run_id,
            after_sequence,
        } => {
            core.attach_workflow_run(
                &Principal::local_desktop(),
                request.subscription_id,
                run_id,
                after_sequence,
            )
            .await
        }
    }
    .map_err(application::ApplicationError::into_envelope)
}

pub async fn conversation_events_since_core(
    pool: &SqlitePool,
    conversation_id: Uuid,
    after_sequence: i64,
    limit: i64,
) -> Result<ConversationEventsPage, AppError> {
    let bounded_limit = limit.clamp(1, 500);
    let records = ConversationEventRecord::events_since(
        pool,
        conversation_id,
        after_sequence,
        bounded_limit + 1,
    )
    .await?;
    let has_more = records.len() as i64 > bounded_limit;
    let events = records
        .into_iter()
        .take(bounded_limit as usize)
        .map(event_envelope_from_record)
        .collect::<Result<Vec<_>, _>>()?;
    let last_sequence = events
        .last()
        .map(|event| event.sequence)
        .unwrap_or(after_sequence);

    Ok(ConversationEventsPage {
        conversation_id,
        after_sequence,
        last_sequence,
        has_more,
        events,
    })
}

/// Gap backfill (消灭双投影): returns the timeline **rows** whose state changed after
/// `after_sequence`, not raw events. The frontend upserts them by `row_id`, so the
/// backfill, initial load, and live stream all consume the same `TimelineRow` shape.
#[tauri::command]
pub async fn conversation_events_since(
    state: tauri::State<'_, AppState>,
    request: ConversationEventsSinceRequest,
) -> Result<ConversationRowPage, AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    let (rows, last_sequence) = ConversationProjector::rows_since(
        &state.deployment.db().pool,
        conversation_id,
        request.after_sequence,
    )
    .await?;
    Ok(ConversationRowPage {
        conversation_id,
        after_sequence: request.after_sequence,
        last_sequence,
        rows,
    })
}

pub async fn conversation_timeline_page_core(
    pool: &SqlitePool,
    conversation_id: Uuid,
    cursor: Option<String>,
    limit: usize,
) -> Result<ConversationTimelinePage, AppError> {
    let timeline = ConversationProjector::project(pool, conversation_id).await?;
    let start = cursor
        .as_deref()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let bounded_limit = limit.clamp(1, 200);
    let rows = timeline
        .rows
        .iter()
        .skip(start)
        .take(bounded_limit)
        .cloned()
        .collect::<Vec<_>>();
    let next_index = start + rows.len();
    let next_cursor = (next_index < timeline.rows.len()).then(|| next_index.to_string());

    Ok(ConversationTimelinePage {
        conversation_id,
        projection_version: timeline.projection_version,
        cursor,
        next_cursor,
        rows,
    })
}

#[tauri::command]
pub async fn conversation_timeline_page(
    state: tauri::State<'_, AppState>,
    request: ConversationTimelinePageRequest,
) -> Result<ConversationTimelinePage, AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    conversation_timeline_page_core(
        &state.deployment.db().pool,
        conversation_id,
        request.cursor,
        request.limit.unwrap_or(100),
    )
    .await
}

#[tauri::command]
pub async fn conversation_start_turn(
    _app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: ConversationStartTurnRequest,
) -> Result<ConversationTurnSnapshot, AppError> {
    let display_text = request
        .display_text
        .clone()
        .unwrap_or_else(|| request.text.clone());
    let workspace_id = Uuid::parse_str(&request.workspace_id)
        .map_err(|error| AppError::BadRequest(format!("invalid workspace id: {error}")))?;
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    let pool = state.deployment.db().pool.clone();
    let workspace = Workspace::find_by_id(&pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("workspace {workspace_id} not found")))?;
    let mut plugin_actions = Vec::with_capacity(request.workflow_refs.len());
    for invocation in &request.workflow_refs {
        let action = state
            .plugin_control_plane
            .resolve_action(&invocation.plugin_id, &invocation.workflow_id)
            .await
            .map_err(|error| AppError::BadRequest(error.to_string()))?;
        let plugin = state
            .plugin_control_plane
            .plugin(&invocation.plugin_id)
            .await
            .map_err(|error| AppError::BadRequest(error.to_string()))?
            .ok_or_else(|| AppError::NotFound(invocation.plugin_id.clone()))?;
        plugin_actions.push(PluginActionRef {
            plugin_id: plugin.id.clone(),
            action,
        });
    }
    let effective_text = if !request.text.trim().is_empty() || !plugin_actions.is_empty() {
        let launch = TurnLaunchSpec::from_composer(ComposerCanonicalInput(TurnLaunchSpecInput {
            prompt_blocks: vec![PromptBlock::Text {
                text: request.text.clone(),
            }],
            display_text: display_text.clone(),
            agent: AgentSelectionIntent {
                agent_id: request.agent_id.clone(),
                executor_profile_id: request.executor_profile_id.clone(),
            },
            mode_id: request.mode_override.clone(),
            config_values: request.config_overrides.clone(),
            plugin_actions,
            skills: Vec::new(),
            workspace: WorkspaceTarget {
                project_id: workspace.project_id,
                root_folder: workspace
                    .container_ref
                    .clone()
                    .unwrap_or_else(|| workspace.id.to_string()),
                branch: Some(workspace.branch),
                isolation: IsolationSpec::SharedInRoot,
            },
            label_snapshot: None,
        }))
        .map_err(|error| AppError::BadRequest(format!("{}: {error}", error.code())))?;
        launch
            .prompt_blocks
            .iter()
            .chain(
                launch
                    .plugin_actions
                    .iter()
                    .flat_map(|reference| reference.action.prompt_blocks.iter()),
            )
            .map(|block| match block {
                PromptBlock::Text { text } => text.as_str(),
            })
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        request.text.clone()
    };
    let previous_last_sequence = conversation_last_sequence(&pool, conversation_id).await?;
    let service = ConversationSessionService::new(state.conversation_context());
    let result = service
        .start_turn_with_origin(
            ConversationStartTurnInput {
                agent_id: request.agent_id,
                workspace_id,
                conversation_id,
                executor_profile_id: request.executor_profile_id,
                text: effective_text,
                display_text: Some(display_text),
                images: request.images,
                mode_override: request.mode_override,
                config_overrides: request.config_overrides,
                workflow_refs: request.workflow_refs,
                file_refs: Vec::new(),
                queued_input_claim: None,
                operation_id: None,
            },
            conversations::commit_reminder::LOCAL_USER_ORIGIN,
        )
        .await;

    notify_conversation_events_after(&pool, conversation_id, previous_last_sequence).await;

    let (turn, _prompt) = result?;
    Ok(turn)
}

async fn conversation_last_sequence(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<i64, AppError> {
    sqlx::query_scalar::<_, i64>(
        r#"SELECT COALESCE(MAX(sequence), 0)
           FROM conversation_events
           WHERE conversation_id = ?"#,
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

async fn notify_conversation_events_after(
    _pool: &SqlitePool,
    _conversation_id: Uuid,
    _after_sequence: i64,
) {
    // IM delivery happens on ConversationEventPublisher after append.
}

#[tauri::command]
pub async fn conversation_respond_permission(
    _app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: ConversationPermissionResponseRequest,
) -> Result<(), AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    let pool = state.deployment.db().pool.clone();
    let previous_last_sequence = conversation_last_sequence(&pool, conversation_id).await?;
    let result = ConversationSessionService::new(state.conversation_context())
        .respond_permission(conversation_id, request.permission_id, request.response)
        .await;
    notify_conversation_events_after(&pool, conversation_id, previous_last_sequence).await;
    result.map_err(Into::into)
}

#[tauri::command]
pub async fn conversation_respond_question(
    _app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: ConversationQuestionResponseRequest,
) -> Result<(), AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    let pool = state.deployment.db().pool.clone();
    let previous_last_sequence = conversation_last_sequence(&pool, conversation_id).await?;
    let companion_answer = match &request.response {
        AgentElicitationResponse::Accept { content } => content
            .get("answers")
            .cloned()
            .unwrap_or_else(|| content.clone()),
        AgentElicitationResponse::Decline | AgentElicitationResponse::Cancel => {
            serde_json::json!({ "__declined": true })
        }
    };
    if let Ok(pending) = state
        .delegation
        .features
        .answer_question(&request.question_id, conversation_id, companion_answer)
        .await
    {
        let connection_id = Uuid::parse_str(&pending.scope.parent_connection_id)
            .map(AgentConnectionId::from)
            .map_err(|error| {
                AppError::BadRequest(format!("invalid companion connection id: {error}"))
            })?;
        let question_id = Uuid::parse_str(&pending.id)
            .map(AgentElicitationId)
            .map_err(|error| {
                AppError::BadRequest(format!("invalid companion question id: {error}"))
            })?;
        state
            .agent_runtime
            .emit_external(
                connection_id,
                Some(AgentSessionId::from(pending.scope.parent_conversation_id)),
                AgentEvent::ElicitationResponded {
                    elicitation_id: question_id,
                    response: request.response,
                },
            )
            .await;
        return Ok(());
    }
    let result = ConversationSessionService::new(state.conversation_context())
        .respond_question(conversation_id, request.question_id, request.response)
        .await;
    notify_conversation_events_after(&pool, conversation_id, previous_last_sequence).await;
    result.map_err(Into::into)
}

#[tauri::command]
pub async fn conversation_submit_feedback(
    state: tauri::State<'_, AppState>,
    request: ConversationSubmitFeedbackRequest,
) -> Result<(), AppError> {
    let text = request.text.trim();
    if text.is_empty() {
        return Err(AppError::BadRequest("feedback is empty".into()));
    }
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    let gate = state.plugin_control_plane.official_product_mcp_gate();
    if !gate.allow_session_mcp() || gate.session_features() & plugins::SESSION_FEAT_FEEDBACK == 0 {
        return Err(AppError::Conflict("live feedback is off".into()));
    }
    let connection_id = state
        .conversation_runtime_states
        .lock()
        .await
        .get(&conversation_id)
        .and_then(|runtime| runtime.connection_id.clone())
        .ok_or_else(|| AppError::Conflict("no live session".into()))?;
    state
        .delegation
        .features
        .push_feedback(
            delegation::DelegationScope {
                parent_connection_id: connection_id,
                parent_conversation_id: conversation_id,
            },
            text,
        )
        .await;
    Ok(())
}

/// Immediately switch the conversation's live ACP session mode
/// (`session/set_mode`). The agent's `ModeChanged` event flows back through the
/// normal conversation event pipeline. Fails when no live session exists or a
/// turn is in flight — the frontend keeps the choice as a next-turn override.
#[tauri::command]
pub async fn conversation_set_session_mode(
    state: tauri::State<'_, AppState>,
    request: ConversationSetSessionModeRequest,
) -> Result<(), AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    ConversationSessionService::new(state.conversation_context())
        .set_session_mode(conversation_id, request.mode_id)
        .await
        .map_err(Into::into)
}

/// Immediately change one agent-advertised session config option
/// (`session/set_config_option`, e.g. model / permission mode). Same live-session
/// and in-flight-turn caveats as [`conversation_set_session_mode`].
#[tauri::command]
pub async fn conversation_set_session_config_option(
    state: tauri::State<'_, AppState>,
    request: ConversationSetSessionConfigOptionRequest,
) -> Result<(), AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    ConversationSessionService::new(state.conversation_context())
        .set_session_config_option(conversation_id, request.key, request.value)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn conversation_cancel_turn(
    _app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: ConversationCancelTurnRequest,
) -> Result<(), AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    let pool = state.deployment.db().pool.clone();
    let previous_last_sequence = conversation_last_sequence(&pool, conversation_id).await?;
    let result = ConversationSessionService::new(state.conversation_context())
        .cancel_turn(conversation_id, request.reason)
        .await;
    notify_conversation_events_after(&pool, conversation_id, previous_last_sequence).await;
    result.map_err(Into::into)
}

#[tauri::command]
pub async fn conversation_truncate_to_turn(
    state: tauri::State<'_, AppState>,
    request: ConversationTruncateToTurnRequest,
) -> Result<(), AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    ConversationSessionService::new(state.conversation_context())
        .truncate_to_turn(conversation_id, request.ordinal)
        .await
        .map_err(Into::into)
}

/// Read-only preview of the files a checkpoint restore would currently change.
#[tauri::command]
pub async fn conversation_checkpoint_file_changes_preview(
    state: tauri::State<'_, AppState>,
    request: ConversationCheckpointPreviewRequest,
) -> Result<ConversationFileChangeSummary, AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    conversations::preview_checkpoint_file_changes(
        state.deployment.as_ref(),
        conversation_id,
        request.ordinal,
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn conversation_close(
    state: tauri::State<'_, AppState>,
    request: ConversationCloseRequest,
) -> Result<(), AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    ConversationSessionService::new(state.conversation_context())
        .close_conversation(conversation_id, request.reason)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn conversation_export(
    state: tauri::State<'_, AppState>,
    request: ConversationExportRequest,
) -> Result<ConversationExportResult, AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    export_conversation_bundle(
        &state.deployment.db().pool,
        conversation_id,
        request.destination_path.as_deref(),
    )
    .await
}

/// Render a conversation as human-readable Markdown (for sharing / PR bodies).
#[tauri::command]
pub async fn conversation_export_markdown(
    state: tauri::State<'_, AppState>,
    conversation_id: String,
) -> Result<String, AppError> {
    let (title, timeline) = export_title_and_timeline(&state, &conversation_id).await?;
    Ok(conversations::render_markdown(&title, &timeline.rows))
}

/// Render a conversation as a self-contained HTML document.
#[tauri::command]
pub async fn conversation_export_html(
    state: tauri::State<'_, AppState>,
    conversation_id: String,
) -> Result<String, AppError> {
    let (title, timeline) = export_title_and_timeline(&state, &conversation_id).await?;
    Ok(conversations::render_html(&title, &timeline.rows))
}

/// Full-text search across conversations (P1-2). `workspace_id`, when set,
/// restricts results to one workspace.
#[tauri::command]
pub async fn conversation_search(
    state: tauri::State<'_, AppState>,
    query: String,
    workspace_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<conversations::ConversationSearchHit>, AppError> {
    let workspace_id = match workspace_id {
        Some(raw) => Some(
            Uuid::parse_str(&raw)
                .map_err(|error| AppError::BadRequest(format!("invalid workspace id: {error}")))?,
        ),
        None => None,
    };
    let pool = &state.deployment.db().pool;
    let mut conn = pool.acquire().await?;
    let limit = limit.unwrap_or(50).clamp(1, 200);
    conversations::search_conversations(&mut conn, &query, workspace_id, limit)
        .await
        .map_err(AppError::from)
}

async fn export_title_and_timeline(
    state: &AppState,
    conversation_id: &str,
) -> Result<(String, ConversationTimeline), AppError> {
    let id = Uuid::parse_str(conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    let pool = &state.deployment.db().pool;
    let title = DbConversationSummary::find_by_id(pool, id)
        .await?
        .and_then(|summary| summary.title)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| "会话".to_string());
    let timeline = ConversationProjector::project(pool, id).await?;
    Ok((title, timeline))
}

#[tauri::command]
pub async fn conversation_import(
    state: tauri::State<'_, AppState>,
    request: ConversationImportRequest,
) -> Result<ConversationImportResult, AppError> {
    let workspace_id = Uuid::parse_str(&request.workspace_id)
        .map_err(|error| AppError::BadRequest(format!("invalid workspace id: {error}")))?;
    import_conversation_bundle(&state.deployment.db().pool, request.bundle, workspace_id).await
}

/// Fork a conversation (P1-4): produce an independent, non-destructive copy of
/// its full history, then—when the agent advertised `session/fork` and has a
/// live session—branch the agent's server-side context into the new session so
/// continuing the fork keeps the pre-fork context. If ACP fork is unavailable,
/// the fork is a context-free copy that cold-starts on the next turn.
///
/// Forks from the CURRENT state, not a past turn:
/// truncating the copy would desync the visible history from the agent context.
#[tauri::command]
pub async fn conversation_fork(
    state: tauri::State<'_, AppState>,
    conversation_id: String,
) -> Result<ConversationForkResult, AppError> {
    let source_id = Uuid::parse_str(&conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    let pool = &state.deployment.db().pool;

    let summary = DbConversationSummary::find_by_id(pool, source_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("conversation {source_id} not found")))?;
    if let Some(conversation) = ConversationRecord::find_by_id(pool, source_id).await? {
        if let Some(active_turn_id) = conversation.active_turn_id
            && let Some(active_turn) =
                ConversationTurnRecord::find_by_id(pool, active_turn_id).await?
            && matches!(
                active_turn.status.as_str(),
                "pending" | "queued" | "running" | "blocked"
            )
        {
            return Err(AppError::Conflict(
                "Cannot fork a conversation while a turn is in flight".to_string(),
            ));
        }
    }

    // Full non-destructive copy with fresh ids via the tested export→import path.
    let exported = export_conversation_bundle(pool, source_id, None).await?;
    let result = import_conversation_bundle(pool, exported.bundle, summary.workspace_id).await?;
    let new_id = result.conversation_id;
    let conversation_context = state.conversation_context();
    ConversationRelationControl::with_publisher(pool.clone(), conversation_context.event_publisher)
        .create(CreateConversationRelation {
            parent_conversation_id: source_id,
            child_conversation_id: new_id,
            kind: agents::ConversationRelationKind::Fork,
            visibility: agents::ConversationRelationVisibility::Visible,
            metadata: serde_json::json!({ "source": "conversation_fork" }),
        })
        .await?;

    let base = summary
        .title
        .as_deref()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("会话");
    if let Err(error) =
        DbConversationSummary::set_title(pool, new_id, &format!("{base}（分叉）")).await
    {
        tracing::warn!(%error, conversation_id = %new_id, "forked conversation title was not updated");
    }

    let Some(agent_id) = summary.agent_id.as_ref() else {
        return Ok(ConversationForkResult::history_only(
            result,
            "The source conversation has no Agent binding; only visible history was copied",
        ));
    };
    let source_binding =
        ConversationAgentBindingRecord::latest_for_conversation(pool, source_id).await?;
    let Some(source_binding) = source_binding else {
        return Ok(ConversationForkResult::history_only(
            result,
            "The source Agent session has no resumable binding; only visible history was copied",
        ));
    };

    match state
        .agent_runtime
        .fork_session(AgentSessionId(source_id))
        .await
    {
        Ok(forked_external_id) => {
            let binding = ConversationAgentBindingRecord::create(
                pool,
                Uuid::new_v4(),
                CreateConversationAgentBinding {
                    conversation_id: new_id,
                    agent_id,
                    working_dir: &source_binding.working_dir,
                    acp_session_id: Some(&forked_external_id),
                    acp_protocol_version: source_binding.acp_protocol_version.as_deref(),
                    runtime_version: source_binding.runtime_version.as_deref(),
                    acp_version: source_binding.acp_version.as_deref(),
                    load_supported: source_binding.load_supported,
                    resume_supported: source_binding.resume_supported,
                    close_supported: source_binding.close_supported,
                    terminal_supported: source_binding.terminal_supported,
                    additional_directories_supported: source_binding
                        .additional_directories_supported,
                    prompt_capabilities_json: &source_binding.prompt_capabilities_json,
                    session_capabilities_json: &source_binding.session_capabilities_json,
                    client_capabilities_json: &source_binding.client_capabilities_json,
                    mcp_servers_json: &source_binding.mcp_servers_json,
                    modes_json: &source_binding.modes_json,
                    config_options_json: &source_binding.config_options_json,
                    current_mode: source_binding.current_mode.as_deref(),
                    status: "closed",
                },
            )
            .await;
            match binding {
                Ok(_) => Ok(ConversationForkResult::with_agent_context(result)),
                Err(error) => Ok(ConversationForkResult::history_only(
                    result,
                    format!("Agent context was forked but could not be attached: {error}"),
                )),
            }
        }
        Err(error) => Ok(ConversationForkResult::history_only(
            result,
            format!("Agent context could not be forked: {error}"),
        )),
    }
}

fn message_turns_from_timeline(timeline: &ConversationTimeline) -> Vec<MessageTurn> {
    timeline
        .rows
        .iter()
        .filter_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. } => Some(turn.clone()),
            _ => None,
        })
        .collect()
}

fn session_stats_from_turns(turns: &[MessageTurn]) -> Option<SessionStats> {
    let total_usage = turns.iter().filter_map(|turn| turn.usage.clone()).fold(
        TurnUsage::default(),
        |mut acc, usage| {
            acc.input_tokens += usage.input_tokens;
            acc.output_tokens += usage.output_tokens;
            acc.cache_creation_input_tokens += usage.cache_creation_input_tokens;
            acc.cache_read_input_tokens += usage.cache_read_input_tokens;
            acc
        },
    );
    let total_tokens = total_usage.input_tokens
        + total_usage.output_tokens
        + total_usage.cache_creation_input_tokens
        + total_usage.cache_read_input_tokens;
    // Latest agent-reported context-window snapshot (ACP usage), when available.
    let context_window = turns.iter().rev().find_map(|turn| {
        let usage = turn.usage.clone()?;
        let max = usage.context_window_max?;
        let used = usage.input_tokens
            + usage.output_tokens
            + usage.cache_creation_input_tokens
            + usage.cache_read_input_tokens;
        Some((used, max))
    });
    (total_tokens > 0).then_some(SessionStats {
        total_usage: Some(total_usage),
        total_tokens: Some(total_tokens),
        total_duration_ms: turns.iter().filter_map(|turn| turn.duration_ms).sum(),
        context_window_used_tokens: context_window.map(|(used, _)| used),
        context_window_max_tokens: context_window.map(|(_, max)| max),
        context_window_usage_percent: context_window.map(|(used, max)| {
            if max > 0 {
                (used as f64 / max as f64) * 100.0
            } else {
                0.0
            }
        }),
    })
}

async fn active_binding_for_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<ConversationActiveBinding>, AppError> {
    let Some(binding) =
        ConversationAgentBindingRecord::latest_for_conversation(pool, conversation_id).await?
    else {
        return Ok(None);
    };
    let mut capabilities =
        match serde_json::from_str::<AcpCapabilitySnapshot>(&binding.session_capabilities_json) {
            Ok(capabilities) => capabilities,
            Err(error) => {
                tracing::warn!(
                    conversation_id = %conversation_id,
                    binding_id = %binding.id,
                    %error,
                    "Invalid conversation binding session capabilities JSON"
                );
                AcpCapabilitySnapshot::default()
            }
        };
    match serde_json::from_str(&binding.prompt_capabilities_json) {
        Ok(prompt) => capabilities.prompt = prompt,
        Err(error) => {
            tracing::warn!(
                conversation_id = %conversation_id,
                binding_id = %binding.id,
                %error,
                "Invalid conversation binding prompt capabilities JSON"
            );
        }
    }
    capabilities.load_session = binding.load_supported;
    capabilities.resume_session = binding.resume_supported;
    capabilities.close_session = binding.close_supported;
    capabilities.terminal = binding.terminal_supported;
    capabilities.additional_directories = binding.additional_directories_supported;

    Ok(Some(ConversationActiveBinding {
        id: binding.id,
        agent_type: binding.agent_id.into_string(),
        working_dir: binding.working_dir,
        acp_session_id: binding.acp_session_id,
        status: binding.status,
        capabilities,
        delegation_mcp_delivered: plugins::binding_has_delegation_mcp(&binding.mcp_servers_json),
    }))
}

async fn current_turn_for_conversation(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<ConversationCurrentTurn>, AppError> {
    let Some(active_turn_id) =
        sqlx::query_scalar::<_, Option<Uuid>>("SELECT active_turn_id FROM sessions WHERE id = ?")
            .bind(conversation_id)
            .fetch_optional(pool)
            .await?
            .flatten()
    else {
        return Ok(None);
    };
    let Some(turn) = ConversationTurnRecord::find_by_id(pool, active_turn_id).await? else {
        return Ok(None);
    };
    Ok(Some(ConversationCurrentTurn {
        id: turn.id,
        ordinal: turn.ordinal,
        status: turn.status,
        prompt_id: turn.prompt_id,
        text_preview: turn.text_preview,
    }))
}

pub fn event_envelope_from_record(
    record: ConversationEventRecord,
) -> Result<ConversationEventEnvelope, AppError> {
    let event = serde_json::from_str::<ConversationEvent>(&record.normalized_json)
        .map_err(|error| AppError::Internal(format!("invalid conversation event: {error}")))?;
    Ok(ConversationEventEnvelope {
        id: record.id,
        conversation_id: record.conversation_id,
        turn_id: record.turn_id,
        sequence: record.sequence,
        source: record.source,
        event,
        created_at: record.created_at,
    })
}

pub async fn import_agent_session_to_conversation_events(
    pool: &SqlitePool,
    workspace_id: Uuid,
    session: &ImportedAgentSession,
) -> Result<Uuid, AppError> {
    let conversation_id = Uuid::new_v4();
    let title = session
        .title
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| first_message_preview(session));
    let initial_prompt = session.messages.iter().find_map(|message| {
        matches!(message.role, ImportedAgentMessageRole::User)
            .then(|| message.content.trim())
            .filter(|value| !value.is_empty())
    });

    ConversationRecord::create(
        pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id,
            task_id: None,
            title,
            initial_prompt,
            status: Some(SessionStatus::Done),
            executor: Some("agent"),
        },
    )
    .await?;

    let agent_id = agents::AgentId::parse(session.source_agent.as_str())
        .expect("imported AgentKind values are valid AgentIds");
    DbConversationSummary::bind_external_id(
        pool,
        conversation_id,
        &session.external_session_id,
        &agent_id,
    )
    .await?;
    DbConversationSummary::update_cached_agent_metadata(
        pool,
        conversation_id,
        session.messages.len() as i64,
        None,
    )
    .await?;

    let working_dir = session
        .workspace_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let binding = ConversationAgentBindingRecord::create(
        pool,
        Uuid::new_v4(),
        CreateConversationAgentBinding {
            conversation_id,
            agent_id: &agent_id,
            working_dir: &working_dir,
            acp_session_id: Some(&session.external_session_id),
            acp_protocol_version: None,
            runtime_version: None,
            acp_version: None,
            load_supported: false,
            resume_supported: false,
            close_supported: false,
            terminal_supported: false,
            additional_directories_supported: false,
            prompt_capabilities_json: "{}",
            session_capabilities_json: "{}",
            client_capabilities_json: "{}",
            mcp_servers_json: "[]",
            modes_json: "[]",
            config_options_json: "[]",
            current_mode: None,
            status: "closed",
        },
    )
    .await?;

    append_import_event(
        pool,
        conversation_id,
        None,
        Some(binding.id),
        ConversationEvent::ConversationCreated {
            title: title.map(str::to_string),
        },
        session,
        "conversation-created",
        None,
    )
    .await?;
    append_import_event(
        pool,
        conversation_id,
        None,
        Some(binding.id),
        ConversationEvent::AgentBindingStarted {
            agent_id: agents::AgentId::parse(session.source_agent.as_str())
                .expect("imported AgentKind values are valid AgentIds"),
            working_dir: working_dir.clone(),
        },
        session,
        "binding-started",
        None,
    )
    .await?;
    append_import_event(
        pool,
        conversation_id,
        None,
        Some(binding.id),
        ConversationEvent::AgentConnectionStatusChanged {
            status: ConversationAgentConnectionStatus::Closed,
        },
        session,
        "binding-closed",
        None,
    )
    .await?;

    let mut current_turn_id: Option<Uuid> = None;
    for (index, message) in session.messages.iter().enumerate() {
        match message.role {
            ImportedAgentMessageRole::User => {
                if let Some(turn_id) = current_turn_id.take() {
                    append_turn_completed(pool, conversation_id, turn_id, binding.id, session)
                        .await?;
                }
                let blocks = vec![ConversationInputBlock::Text {
                    text: message.content.clone(),
                }];
                let input_blocks_json = serde_json::to_string(&blocks)?;
                let text_preview = preview_text(&message.content);
                let turn = ConversationTurnRecord::create_pending(
                    pool,
                    Uuid::new_v4(),
                    CreateConversationTurn {
                        conversation_id,
                        prompt_id: None,
                        text_preview: Some(text_preview.as_str()),
                        input_blocks_json: &input_blocks_json,
                    },
                )
                .await?;
                append_import_event(
                    pool,
                    conversation_id,
                    Some(turn.id),
                    Some(binding.id),
                    ConversationEvent::UserTurnCreated {
                        blocks,
                        workflow_refs: Vec::new(),
                    },
                    session,
                    &format!("message-{index}-user-created"),
                    Some(serde_json::to_value(message)?),
                )
                .await?;
                append_import_event(
                    pool,
                    conversation_id,
                    Some(turn.id),
                    Some(binding.id),
                    ConversationEvent::UserTurnStarted,
                    session,
                    &format!("message-{index}-user-started"),
                    None,
                )
                .await?;
                current_turn_id = Some(turn.id);
            }
            ImportedAgentMessageRole::Assistant => {
                let turn_id = ensure_import_turn(
                    pool,
                    conversation_id,
                    current_turn_id,
                    "Imported assistant message",
                )
                .await?;
                current_turn_id = Some(turn_id);
                let event = if matches!(
                    message.metadata.kind.as_deref(),
                    Some("reasoning" | "reasoning_and_text")
                ) {
                    ConversationEvent::AssistantReasoningDelta {
                        text: message.content.clone(),
                        message_id: Some(format!("imported-message-{index}")),
                    }
                } else {
                    ConversationEvent::AssistantTextDelta {
                        text: message.content.clone(),
                        message_id: Some(format!("imported-message-{index}")),
                    }
                };
                append_import_event(
                    pool,
                    conversation_id,
                    Some(turn_id),
                    Some(binding.id),
                    event,
                    session,
                    &format!("message-{index}-assistant"),
                    Some(serde_json::to_value(message)?),
                )
                .await?;
            }
            ImportedAgentMessageRole::Tool => {
                let turn_id = ensure_import_turn(
                    pool,
                    conversation_id,
                    current_turn_id,
                    "Imported tool output",
                )
                .await?;
                current_turn_id = Some(turn_id);
                append_import_event(
                    pool,
                    conversation_id,
                    Some(turn_id),
                    Some(binding.id),
                    ConversationEvent::ToolCallUpsert {
                        tool_call: ConversationToolCallPatch {
                            tool_call_id: message
                                .metadata
                                .tool_call_id
                                .clone()
                                .unwrap_or_else(|| format!("imported-tool-{index}")),
                            title: message
                                .metadata
                                .tool_name
                                .clone()
                                .or_else(|| Some("Imported tool output".to_string())),
                            kind: message
                                .metadata
                                .kind
                                .clone()
                                .or_else(|| Some("imported".to_string())),
                            status: message.metadata.tool_status.clone().or_else(|| {
                                Some(
                                    if message.metadata.kind.as_deref() == Some("tool_call") {
                                        "pending"
                                    } else {
                                        "completed"
                                    }
                                    .to_string(),
                                )
                            }),
                            raw_input: message.metadata.raw_input.clone(),
                            raw_output: message.metadata.raw_output.clone().or_else(|| {
                                (message.metadata.kind.as_deref() != Some("tool_call"))
                                    .then(|| serde_json::Value::String(message.content.clone()))
                            }),
                            raw_output_append: None,
                            content: Some(serde_json::json!({ "text": message.content.clone() })),
                            locations: None,
                            metadata: Some(serde_json::json!({
                                "source": "agent_transcript",
                                "role": "tool",
                                "model": message.metadata.model.clone(),
                                "input_tokens": message.metadata.input_tokens,
                                "output_tokens": message.metadata.output_tokens,
                                "cost": message.metadata.cost,
                                "parent_session_id": message.metadata.parent_session_id.clone()
                            })),
                            images: Vec::new(),
                        },
                    },
                    session,
                    &format!("message-{index}-tool"),
                    Some(serde_json::to_value(message)?),
                )
                .await?;
            }
            ImportedAgentMessageRole::System | ImportedAgentMessageRole::Unknown => {
                let turn_id = ensure_import_turn(
                    pool,
                    conversation_id,
                    current_turn_id,
                    "Imported system message",
                )
                .await?;
                current_turn_id = Some(turn_id);
                append_import_event(
                    pool,
                    conversation_id,
                    Some(turn_id),
                    Some(binding.id),
                    ConversationEvent::AssistantReasoningDelta {
                        text: message.content.clone(),
                        message_id: Some(format!("imported-message-{index}")),
                    },
                    session,
                    &format!("message-{index}-system"),
                    Some(serde_json::to_value(message)?),
                )
                .await?;
            }
        }
    }

    if let Some(turn_id) = current_turn_id {
        append_turn_completed(pool, conversation_id, turn_id, binding.id, session).await?;
    }

    Ok(conversation_id)
}

async fn ensure_import_turn(
    pool: &SqlitePool,
    conversation_id: Uuid,
    current_turn_id: Option<Uuid>,
    text_preview: &str,
) -> Result<Uuid, AppError> {
    if let Some(turn_id) = current_turn_id {
        return Ok(turn_id);
    }
    let blocks: Vec<ConversationInputBlock> = Vec::new();
    let input_blocks_json = serde_json::to_string(&blocks)?;
    let turn = ConversationTurnRecord::create_pending(
        pool,
        Uuid::new_v4(),
        CreateConversationTurn {
            conversation_id,
            prompt_id: None,
            text_preview: Some(text_preview),
            input_blocks_json: &input_blocks_json,
        },
    )
    .await?;
    Ok(turn.id)
}

async fn append_turn_completed(
    pool: &SqlitePool,
    conversation_id: Uuid,
    turn_id: Uuid,
    binding_id: Uuid,
    session: &ImportedAgentSession,
) -> Result<(), AppError> {
    append_import_event(
        pool,
        conversation_id,
        Some(turn_id),
        Some(binding_id),
        ConversationEvent::TurnCompleted {
            stop_reason: Some("imported".to_string()),
        },
        session,
        &format!("turn-{turn_id}-completed"),
        None,
    )
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn append_import_event(
    pool: &SqlitePool,
    conversation_id: Uuid,
    turn_id: Option<Uuid>,
    binding_id: Option<Uuid>,
    event: ConversationEvent,
    session: &ImportedAgentSession,
    key: &str,
    raw_json: Option<serde_json::Value>,
) -> Result<(), AppError> {
    let value = serde_json::to_value(&event)?;
    let event_kind = value["kind"].as_str().unwrap_or("unknown").to_string();
    let normalized_json = serde_json::to_string(&event)?;
    let raw_json = raw_json.map(|value| value.to_string());
    let idempotency_key = format!("agent-transcript:{}:{}", session.external_session_id, key);
    ConversationEventAppender::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id,
            binding_id,
            connection_id: None,
            prompt_id: None,
            source: "import",
            event_kind: &event_kind,
            normalized_json: &normalized_json,
            raw_json: raw_json.as_deref(),
            idempotency_key: Some(&idempotency_key),
        },
    )
    .await?;
    Ok(())
}

fn first_message_preview(session: &ImportedAgentSession) -> Option<&str> {
    session
        .messages
        .iter()
        .map(|message| message.content.trim())
        .find(|content| !content.is_empty())
}

fn preview_text(content: &str) -> String {
    const MAX_CHARS: usize = 160;
    let trimmed = content.trim();
    let mut preview: String = trimmed.chars().take(MAX_CHARS).collect();
    if trimmed.chars().count() > MAX_CHARS {
        preview.push_str("...");
    }
    preview
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::{
        AgentKind, ImportedAgentMessage, ImportedAgentMessageRole, ImportedAgentSession,
        conversation::{ContentBlock, ConversationEvent, ConversationInputBlock},
    };
    use conversations::ConversationEventAppender;
    use db::models::{
        conversation::{ConversationRecord, CreateConversationRecord},
        conversation_event::AppendConversationEvent,
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    };
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    async fn migrated_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory db");
        sqlx::migrate!("../crates/db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    async fn seed_projected_conversation(pool: &SqlitePool) -> (Uuid, Uuid) {
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: Some("Projected"),
                initial_prompt: Some("hello"),
                status: None,
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
                prompt_id: Some("prompt-1"),
                text_preview: Some("hello"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");

        append_event(
            pool,
            conversation_id,
            turn.id,
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "hello".to_string(),
                }],
                workflow_refs: Vec::new(),
            },
            "created",
        )
        .await;
        append_event(
            pool,
            conversation_id,
            turn.id,
            ConversationEvent::AssistantTextDelta {
                text: "hi".to_string(),
                message_id: None,
            },
            "assistant",
        )
        .await;
        (conversation_id, turn.id)
    }

    async fn append_event(
        pool: &SqlitePool,
        conversation_id: Uuid,
        turn_id: Uuid,
        event: ConversationEvent,
        key: &'static str,
    ) {
        let value = serde_json::to_value(&event).expect("event value");
        let event_kind = value["kind"].as_str().unwrap_or("unknown").to_string();
        let normalized_json = serde_json::to_string(&event).expect("event json");
        ConversationEventAppender::append(
            pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "user",
                event_kind: &event_kind,
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key: Some(key),
            },
        )
        .await
        .expect("append event");
    }

    #[tokio::test]
    async fn conversation_detail_projection_uses_event_log() {
        let pool = migrated_pool().await;
        let (conversation_id, _) = seed_projected_conversation(&pool).await;

        let detail = conversation_detail_core(&pool, conversation_id)
            .await
            .expect("detail")
            .expect("conversation");

        assert_eq!(detail.timeline.last_sequence, 2);
        assert_eq!(detail.turns.len(), 2);
        assert_eq!(detail.projection_version, CONVERSATION_PROJECTION_VERSION);
    }

    #[tokio::test]
    async fn conversation_event_paging_returns_sequence_cursor() {
        let pool = migrated_pool().await;
        let (conversation_id, _) = seed_projected_conversation(&pool).await;

        let page = conversation_events_since_core(&pool, conversation_id, 0, 1)
            .await
            .expect("events page");

        assert_eq!(page.events.len(), 1);
        assert!(page.has_more);
        assert_eq!(page.last_sequence, 1);
    }

    #[tokio::test]
    async fn conversation_timeline_page_slices_projected_rows() {
        let pool = migrated_pool().await;
        let (conversation_id, _) = seed_projected_conversation(&pool).await;

        let page = conversation_timeline_page_core(&pool, conversation_id, None, 1)
            .await
            .expect("timeline page");

        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.next_cursor.as_deref(), Some("1"));
    }

    #[tokio::test]
    async fn history_import_to_conversation_events() {
        let pool = migrated_pool().await;
        let session = ImportedAgentSession {
            source_agent: AgentKind::Codex,
            external_session_id: "external-import-1".to_string(),
            title: Some("Imported session".to_string()),
            workspace_path: None,
            messages: vec![
                ImportedAgentMessage {
                    role: ImportedAgentMessageRole::User,
                    content: "hello from history".to_string(),
                    created_at: None,
                    metadata: Default::default(),
                },
                ImportedAgentMessage {
                    role: ImportedAgentMessageRole::Assistant,
                    content: "imported reply".to_string(),
                    created_at: None,
                    metadata: Default::default(),
                },
            ],
            raw_source_path: None,
        };

        let conversation_id =
            import_agent_session_to_conversation_events(&pool, Uuid::new_v4(), &session)
                .await
                .expect("import session");
        let detail = conversation_detail_core(&pool, conversation_id)
            .await
            .expect("detail")
            .expect("conversation");

        assert_eq!(
            detail.summary.external_session_id.as_deref(),
            Some("external-import-1")
        );
        assert!(
            detail.turns.iter().any(|turn| {
                matches!(turn.role, agents::conversation::TurnRole::Assistant)
                    && turn.blocks.iter().any(|block| {
                    matches!(block, ContentBlock::Text { text } if text.contains("imported reply"))
                })
            }),
            "imported assistant text should be renderable from the event log"
        );

        let events = ConversationEventRecord::events_since(&pool, conversation_id, 0, 100)
            .await
            .expect("events");
        assert!(events.iter().all(|event| event.source == "import"));
        assert!(
            events
                .iter()
                .any(|event| event.event_kind == "assistant_text_delta")
        );
    }
}
