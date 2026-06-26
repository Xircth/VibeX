//! Conversation read/write commands backed by the VibeX event log.
//!
//! Agent transcript files are import inputs only. Product conversation detail is
//! rebuilt from `conversation_events` through the DB projector.

use agents::{
    AgentPermissionResponse, AgentSessionConfigOverride, AgentType, ImportedAgentMessageRole,
    ImportedAgentSession,
    conversation::{
        AcpCapabilitySnapshot, ConversationAgentConnectionStatus, ConversationEvent,
        ConversationEventEnvelope, ConversationEventsPage, ConversationInputBlock,
        ConversationTimeline, ConversationTimelinePage, ConversationTimelineRow,
        ConversationToolCallPatch, MessageTurn, SessionStats, TurnUsage,
    },
    executor_key_for,
};
use db::models::{
    conversation::{
        ConversationAgentBindingRecord, ConversationRecord, CreateConversationAgentBinding,
        CreateConversationRecord, DbConversationSummary,
    },
    conversation_event::{AppendConversationEvent, ConversationEventRecord},
    conversation_projection::{
        CONVERSATION_PROJECTION_VERSION, ConversationEventAppender, ConversationProjector,
    },
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    session::SessionStatus,
};
use executors::profile::ExecutorProfileId;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::Emitter;
use ts_rs::TS;
use uuid::Uuid;

use crate::{
    conversation_bundle::{
        ConversationExportResult, ConversationImportResult, export_conversation_bundle,
        import_conversation_bundle,
    },
    conversation_service::{
        ConversationSessionService, ConversationStartTurnInput, ConversationTurnSnapshot,
    },
    error::AppError,
    events::channels,
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
    pub agent_type: AgentType,
    pub workspace_id: String,
    pub conversation_id: String,
    #[serde(default)]
    pub executor_profile_id: Option<ExecutorProfileId>,
    pub text: String,
    #[serde(default)]
    pub images: Vec<String>,
    /// Composer-selected session mode (from the agent's advertised modes).
    #[serde(default)]
    pub mode_override: Option<String>,
    /// Composer-selected config option overrides (advertised select options).
    #[serde(default)]
    pub config_overrides: Vec<AgentSessionConfigOverride>,
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
pub struct ConversationTruncateToTurnRequest {
    pub conversation_id: String,
    /// The user-turn ordinal to reset to: this turn and everything after it is removed.
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
    Ok(Some(DbConversationDetail {
        summary,
        turns,
        timeline,
        active_binding,
        current_turn,
        projection_version: CONVERSATION_PROJECTION_VERSION,
        session_stats,
        in_flight_user_turn_id,
    }))
}

#[tauri::command]
pub async fn conversation_detail(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<Option<DbConversationDetail>, AppError> {
    let id = Uuid::parse_str(&session_id)
        .map_err(|error| AppError::BadRequest(format!("invalid session id: {error}")))?;
    conversation_detail_core(&state.deployment.db().pool, id).await
}

#[tauri::command]
pub async fn conversation_list(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<DbConversationSummary>, AppError> {
    let workspace_id = Uuid::parse_str(&workspace_id)
        .map_err(|error| AppError::BadRequest(format!("invalid workspace id: {error}")))?;
    DbConversationSummary::list_for_workspace(&state.deployment.db().pool, workspace_id)
        .await
        .map_err(Into::into)
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

#[tauri::command]
pub async fn conversation_events_since(
    state: tauri::State<'_, AppState>,
    request: ConversationEventsSinceRequest,
) -> Result<ConversationEventsPage, AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    conversation_events_since_core(
        &state.deployment.db().pool,
        conversation_id,
        request.after_sequence,
        request.limit.unwrap_or(100),
    )
    .await
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
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: ConversationStartTurnRequest,
) -> Result<ConversationTurnSnapshot, AppError> {
    let workspace_id = Uuid::parse_str(&request.workspace_id)
        .map_err(|error| AppError::BadRequest(format!("invalid workspace id: {error}")))?;
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    let pool = state.deployment.db().pool.clone();
    let previous_last_sequence = conversation_last_sequence(&pool, conversation_id).await?;
    let service = ConversationSessionService::new(&state);
    let result = service
        .start_turn(ConversationStartTurnInput {
            agent_type: request.agent_type,
            workspace_id,
            conversation_id,
            executor_profile_id: request.executor_profile_id,
            text: request.text,
            images: request.images,
            mode_override: request.mode_override,
            config_overrides: request.config_overrides,
        })
        .await;

    emit_conversation_events_after(&app, &pool, conversation_id, previous_last_sequence).await;

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

async fn emit_conversation_events_after(
    app: &tauri::AppHandle,
    pool: &SqlitePool,
    conversation_id: Uuid,
    after_sequence: i64,
) {
    match conversation_events_since_core(pool, conversation_id, after_sequence, 50).await {
        Ok(page) => {
            for event in page.events {
                if let Err(error) = app.emit(channels::CONVERSATION_EVENTS, &event) {
                    tracing::warn!(
                        conversation_id = %conversation_id,
                        sequence = event.sequence,
                        %error,
                        "Failed to emit conversation start-turn event"
                    );
                    break;
                }
            }
        }
        Err(error) => {
            tracing::warn!(
                conversation_id = %conversation_id,
                after_sequence,
                %error,
                "Failed to load conversation start-turn events for emission"
            );
        }
    }
}

#[tauri::command]
pub async fn conversation_respond_permission(
    state: tauri::State<'_, AppState>,
    request: ConversationPermissionResponseRequest,
) -> Result<(), AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    ConversationSessionService::new(&state)
        .respond_permission(conversation_id, request.permission_id, request.response)
        .await
}

#[tauri::command]
pub async fn conversation_cancel_turn(
    state: tauri::State<'_, AppState>,
    request: ConversationCancelTurnRequest,
) -> Result<(), AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    ConversationSessionService::new(&state)
        .cancel_turn(conversation_id, request.reason)
        .await
}

#[tauri::command]
pub async fn conversation_truncate_to_turn(
    state: tauri::State<'_, AppState>,
    request: ConversationTruncateToTurnRequest,
) -> Result<(), AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    ConversationSessionService::new(&state)
        .truncate_to_turn(conversation_id, request.ordinal)
        .await
}

#[tauri::command]
pub async fn conversation_close(
    state: tauri::State<'_, AppState>,
    request: ConversationCloseRequest,
) -> Result<(), AppError> {
    let conversation_id = Uuid::parse_str(&request.conversation_id)
        .map_err(|error| AppError::BadRequest(format!("invalid conversation id: {error}")))?;
    ConversationSessionService::new(&state)
        .close_conversation(conversation_id, request.reason)
        .await
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

#[tauri::command]
pub async fn conversation_import(
    state: tauri::State<'_, AppState>,
    request: ConversationImportRequest,
) -> Result<ConversationImportResult, AppError> {
    let workspace_id = Uuid::parse_str(&request.workspace_id)
        .map_err(|error| AppError::BadRequest(format!("invalid workspace id: {error}")))?;
    import_conversation_bundle(&state.deployment.db().pool, request.bundle, workspace_id).await
}

fn message_turns_from_timeline(timeline: &ConversationTimeline) -> Vec<MessageTurn> {
    timeline
        .rows
        .iter()
        .filter_map(|row| match row {
            ConversationTimelineRow::MessageTurn { turn, .. } => Some(turn.clone()),
            _ => None,
        })
        .collect()
}

fn session_stats_from_turns(turns: &[MessageTurn]) -> Option<SessionStats> {
    let total_usage =
        turns
            .iter()
            .filter_map(|turn| turn.usage)
            .fold(TurnUsage::default(), |mut acc, usage| {
                acc.input_tokens += usage.input_tokens;
                acc.output_tokens += usage.output_tokens;
                acc.cache_creation_input_tokens += usage.cache_creation_input_tokens;
                acc.cache_read_input_tokens += usage.cache_read_input_tokens;
                acc
            });
    let total_tokens = total_usage.input_tokens
        + total_usage.output_tokens
        + total_usage.cache_creation_input_tokens
        + total_usage.cache_read_input_tokens;
    // Latest agent-reported context-window snapshot (ACP usage), when available.
    let context_window = turns.iter().rev().find_map(|turn| {
        let usage = turn.usage?;
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
        agent_type: binding.agent_type,
        working_dir: binding.working_dir,
        acp_session_id: binding.acp_session_id,
        status: binding.status,
        capabilities,
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

    let agent_key = executor_key_for(session.source_agent);
    DbConversationSummary::bind_external_id(
        pool,
        conversation_id,
        &session.external_session_id,
        agent_key,
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
            agent_type: agent_key,
            working_dir: &working_dir,
            acp_session_id: Some(&session.external_session_id),
            acp_protocol_version: None,
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
            agent_type: session.source_agent,
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
                    ConversationEvent::UserTurnCreated { blocks },
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
                append_import_event(
                    pool,
                    conversation_id,
                    Some(turn_id),
                    Some(binding.id),
                    ConversationEvent::AssistantTextDelta {
                        text: message.content.clone(),
                        message_id: Some(format!("imported-message-{index}")),
                    },
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
                            tool_call_id: format!("imported-tool-{index}"),
                            title: Some("Imported tool output".to_string()),
                            kind: Some("imported".to_string()),
                            status: Some("completed".to_string()),
                            raw_input: None,
                            raw_output: Some(serde_json::Value::String(message.content.clone())),
                            raw_output_append: None,
                            content: Some(serde_json::json!({ "text": message.content.clone() })),
                            locations: None,
                            metadata: Some(serde_json::json!({
                                "source": "agent_transcript",
                                "role": "tool"
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
        AgentType, ImportedAgentMessage, ImportedAgentMessageRole, ImportedAgentSession,
        conversation::{ContentBlock, ConversationEvent, ConversationInputBlock},
    };
    use db::models::{
        conversation::{ConversationRecord, CreateConversationRecord},
        conversation_event::AppendConversationEvent,
        conversation_projection::ConversationEventAppender,
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
            source_agent: AgentType::Codex,
            external_session_id: "external-import-1".to_string(),
            title: Some("Imported session".to_string()),
            workspace_path: None,
            messages: vec![
                ImportedAgentMessage {
                    role: ImportedAgentMessageRole::User,
                    content: "hello from history".to_string(),
                    created_at: None,
                },
                ImportedAgentMessage {
                    role: ImportedAgentMessageRole::Assistant,
                    content: "imported reply".to_string(),
                    created_at: None,
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
