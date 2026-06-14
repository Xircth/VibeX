use std::sync::Arc;

use agents::{
    AgentConnectionSnapshot, AgentConnectionStatus, AgentContentBlock, AgentEvent,
    AgentEventEnvelope, AgentPromptSnapshot, AgentPromptStatus, AgentSessionSnapshot,
    RuntimeEventSink,
    conversation::{
        AcpCapabilitySnapshot, AgentPromptCapabilities, ConversationAgentConnectionStatus,
        ConversationDelegation, ConversationDelegationResult, ConversationError, ConversationEvent,
        ConversationEventEnvelope, ConversationFileLocation, ConversationPermissionRequest,
        ConversationPermissionResponse, ConversationPlanEntry, ConversationTerminalPatch,
        ConversationToolCallPatch, ConversationUsage, SessionLoadFailureReason,
    },
    executor_key_for,
    terminal::{AgentTerminalLifecycleEvent, agent_terminal_registry},
};
use db::models::{
    agent_runtime::{
        AgentRuntimeStore, InsertAgentEvent, UpsertAgentConnection, UpsertAgentPendingPermission,
        UpsertAgentPermissionRequest, UpsertAgentPrompt, UpsertAgentSession, json_kind,
    },
    conversation::DbConversationSummary,
    conversation_event::AppendConversationEvent,
    conversation_projection::ConversationEventAppender,
    workspace::Workspace,
};
use deployment::Deployment;
use futures::StreamExt;
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::state::AppState;

pub mod channels {
    pub const GLOBAL_EVENTS: &str = "global-events";
    pub const AGENT_EVENTS: &str = "agent-events";
    pub const CONVERSATION_EVENTS: &str = "conversation-events";
    pub const AGENT_TERMINAL_EVENTS: &str = "agent-terminal-events";
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTerminalSource {
    Acp,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentTerminalUiEvent {
    Created {
        source: AgentTerminalSource,
        session_id: Uuid,
        workspace_id: Option<Uuid>,
        title: String,
        command: String,
        cwd: Option<String>,
    },
    Released {
        source: AgentTerminalSource,
        session_id: Uuid,
        workspace_id: Option<Uuid>,
    },
}

pub struct SqliteAgentRuntimeSink {
    pool: SqlitePool,
}

impl SqliteAgentRuntimeSink {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

impl RuntimeEventSink for SqliteAgentRuntimeSink {
    fn emit(&self, envelope: AgentEventEnvelope) {
        let pool = self.pool.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = persist_agent_event(&pool, &envelope).await {
                tracing::warn!(
                    sequence = envelope.sequence,
                    error = %error,
                    "Failed to persist agent runtime event"
                );
            }
        });
    }
}

pub fn agent_runtime_sink(pool: SqlitePool) -> Arc<dyn RuntimeEventSink> {
    Arc::new(SqliteAgentRuntimeSink::new(pool))
}

/// Start forwarding global events from EventService to Tauri Events.
/// Called during app setup, after AppState is initialized.
pub fn start_event_forwarding(app: &AppHandle, state: &AppState) {
    let app_handle = app.clone();
    let msg_store = state.deployment.events().msg_store().clone();

    tauri::async_runtime::spawn(async move {
        let mut stream = msg_store.history_plus_stream();
        while let Some(result) = stream.next().await {
            match result {
                Ok(msg) => {
                    if app_handle.emit(channels::GLOBAL_EVENTS, &msg).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

pub fn start_agent_event_forwarding(app: &AppHandle, state: &AppState) {
    let app_handle = app.clone();
    let conversation_pool = state.deployment.db().pool.clone();
    let deployment = state.deployment.clone();
    let mut agent_events = state.agent_runtime.subscribe_events();

    tauri::async_runtime::spawn(async move {
        loop {
            match agent_events.recv().await {
                Ok(event) => {
                    let notification_event = event.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) =
                            crate::commands::chat_channel::notify_agent_event(&notification_event)
                                .await
                        {
                            tracing::warn!("Failed to dispatch chat channel event: {}", error);
                        }
                    });
                    match persist_conversation_event(&conversation_pool, &event).await {
                        Ok(Some(conversation_event)) => {
                            if app_handle
                                .emit(channels::CONVERSATION_EVENTS, &conversation_event)
                                .is_err()
                            {
                                break;
                            }
                            if is_terminal_conversation_event(&conversation_event.event)
                                && let Some(turn_id) = conversation_event.turn_id
                            {
                                match crate::conversation_service::finalize_checkpoint_file_changes(
                                    deployment.as_ref(),
                                    conversation_event.conversation_id,
                                    turn_id,
                                )
                                .await
                                {
                                    Ok(Some(file_event)) => {
                                        if app_handle
                                            .emit(channels::CONVERSATION_EVENTS, &file_event)
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                    Ok(None) => {}
                                    Err(error) => {
                                        tracing::warn!(
                                            conversation_id = %conversation_event.conversation_id,
                                            turn_id = %turn_id,
                                            %error,
                                            "Failed to finalize conversation checkpoint diff"
                                        );
                                    }
                                }
                            }
                        }
                        Ok(None) => {}
                        Err(error) => {
                            tracing::warn!(
                                sequence = event.sequence,
                                error = %error,
                                "Failed to persist and emit conversation event"
                            );
                        }
                    }
                    if app_handle.emit(channels::AGENT_EVENTS, &event).is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

fn is_terminal_conversation_event(event: &ConversationEvent) -> bool {
    matches!(
        event,
        ConversationEvent::TurnCompleted { .. }
            | ConversationEvent::TurnFailed { .. }
            | ConversationEvent::TurnCancelled { .. }
    )
}

async fn persist_agent_event(
    pool: &SqlitePool,
    envelope: &AgentEventEnvelope,
) -> Result<(), anyhow::Error> {
    match &envelope.event {
        AgentEvent::ConnectionStatusChanged { snapshot } => {
            persist_connection_snapshot(pool, snapshot).await?;
            if matches!(
                snapshot.status,
                AgentConnectionStatus::Disconnected | AgentConnectionStatus::Failed
            ) {
                let connection_id = snapshot.id.to_string();
                let responded_at = envelope.created_at.to_rfc3339();
                AgentRuntimeStore::cancel_pending_permissions_for_connection(
                    pool,
                    &connection_id,
                    &responded_at,
                )
                .await?;
            }
        }
        AgentEvent::SessionCreated { snapshot } => {
            persist_session_snapshot(pool, envelope.workspace_id, snapshot).await?;
        }
        AgentEvent::SessionLinked {
            acp_session_id,
            agent_type,
        } => {
            if let Some(session_id) = envelope.session_id {
                DbConversationSummary::bind_external_id(
                    pool,
                    session_id.0,
                    acp_session_id,
                    executor_key_for(*agent_type),
                )
                .await?;
            }
        }
        AgentEvent::PromptStarted { snapshot } => {
            persist_prompt_snapshot(pool, snapshot).await?;
        }
        AgentEvent::PermissionRequested { request } => {
            let request_json = serde_json::to_string(request)?;
            let tool_call_json = serde_json::to_string(&request.details)?;
            let options_json = serde_json::to_string(&request.options)?;
            let permission_id = request.id.to_string();
            let session_id = request.session_id.to_string();
            let connection_id = envelope.connection_id.to_string();
            let created_at = envelope.created_at.to_rfc3339();
            AgentRuntimeStore::upsert_permission_request(
                pool,
                UpsertAgentPermissionRequest {
                    id: &permission_id,
                    session_id: &session_id,
                    connection_id: &connection_id,
                    request_json: &request_json,
                    created_at: &created_at,
                },
            )
            .await?;
            AgentRuntimeStore::upsert_pending_permission(
                pool,
                UpsertAgentPendingPermission {
                    id: Uuid::new_v4(),
                    session_id: request.session_id.0,
                    request_id: &permission_id,
                    tool_call_json: &tool_call_json,
                    options_json: &options_json,
                    created_at: &created_at,
                },
            )
            .await?;
        }
        AgentEvent::PermissionResponded {
            permission_id,
            response,
            ..
        } => {
            let response_json = serde_json::to_string(response)?;
            let permission_id = permission_id.to_string();
            let responded_at = envelope.created_at.to_rfc3339();
            AgentRuntimeStore::complete_permission(
                pool,
                &permission_id,
                &response_json,
                &responded_at,
            )
            .await?;
            if let Some(session_id) = envelope.session_id {
                AgentRuntimeStore::resolve_pending_permission_for_request(
                    pool,
                    session_id.0,
                    &permission_id,
                    &response_json,
                    &responded_at,
                )
                .await?;
            }
        }
        AgentEvent::PromptFinished { finished } => {
            let status = AgentPromptStatus::Completed {
                stop_reason: finished.stop_reason.clone(),
            };
            let status_json = serde_json::to_string(&status)?;
            sqlx::query(
                r#"UPDATE agent_prompts
                   SET status = $1, status_json = $2, updated_at = $3
                   WHERE id = $4"#,
            )
            .bind(status_kind(&status))
            .bind(status_json)
            .bind(envelope.created_at.to_rfc3339())
            .bind(finished.prompt_id.to_string())
            .execute(pool)
            .await?;
            if let Some(session_id) = envelope.session_id {
                let session_id = session_id.to_string();
                let responded_at = envelope.created_at.to_rfc3339();
                AgentRuntimeStore::cancel_pending_permissions_for_session(
                    pool,
                    &session_id,
                    &responded_at,
                )
                .await?;
            }
        }
        AgentEvent::Error { error } => {
            if let Some(session_id) = envelope.session_id {
                let session_id = session_id.to_string();
                let responded_at = envelope.created_at.to_rfc3339();
                AgentRuntimeStore::cancel_pending_permissions_for_session(
                    pool,
                    &session_id,
                    &responded_at,
                )
                .await?;
            }
            tracing::warn!(message = %error.message, "Agent runtime emitted error event");
        }
        _ => {}
    }

    persist_conversation_event(pool, envelope).await?;

    // The `agent_events` table is a runtime/debug audit log. Product
    // conversations are rebuilt from `conversation_events`, while the runtime
    // snapshot serves recent agent events from memory. Persisting every
    // streaming chunk here once an agent actually runs floods the single SQLite
    // writer because each event spawns its own task and INSERT, starving
    // git-status reads ("database is locked" / pool-acquire timeouts). Skip the
    // high-frequency streaming kinds; keep the low-frequency lifecycle events for
    // the audit trail.
    if should_log_event(&envelope.event) {
        let event_json_value = serde_json::to_value(&envelope.event)?;
        let event_json = serde_json::to_string(&envelope.event)?;
        let workspace_id = envelope.workspace_id.to_string();
        let connection_id = envelope.connection_id.to_string();
        let session_id = envelope.session_id.map(|session_id| session_id.to_string());
        let created_at = envelope.created_at.to_rfc3339();
        AgentRuntimeStore::insert_event(
            pool,
            InsertAgentEvent {
                sequence: envelope.sequence,
                workspace_id: &workspace_id,
                connection_id: &connection_id,
                session_id: session_id.as_deref(),
                event_kind: json_kind(&event_json_value),
                event_json: &event_json,
                created_at: &created_at,
            },
        )
        .await?;
    }

    Ok(())
}

async fn persist_conversation_event(
    pool: &SqlitePool,
    envelope: &AgentEventEnvelope,
) -> Result<Option<ConversationEventEnvelope>, anyhow::Error> {
    let Some(session_id) = envelope.session_id else {
        return Ok(None);
    };

    let conversation_id = session_id.0;
    let turn_id = match active_turn_id(pool, conversation_id).await {
        Ok(turn_id) => turn_id,
        Err(sqlx::Error::Database(error)) if error.message().contains("no such table") => {
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    let Some(event) = map_agent_event_to_conversation_event(envelope, turn_id) else {
        return Ok(None);
    };
    let value = serde_json::to_value(&event)?;
    let event_kind = value["kind"].as_str().unwrap_or("unknown").to_string();
    let normalized_json = serde_json::to_string(&event)?;
    let raw_json = serde_json::to_string(&envelope.event)?;
    let idempotency_key = format!("agent:{}:{event_kind}", envelope.sequence);

    if let AgentEvent::SessionLinked { acp_session_id, .. } = &envelope.event
        && let Some(binding_id) = latest_binding_id(pool, conversation_id).await?
    {
        db::models::conversation::ConversationAgentBindingRecord::bind_acp_session(
            pool,
            binding_id,
            acp_session_id,
            None,
            "ready",
        )
        .await?;
    }

    let record = ConversationEventAppender::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id,
            binding_id: None,
            connection_id: Some(&envelope.connection_id.to_string()),
            prompt_id: None,
            source: conversation_event_source(&envelope.event),
            event_kind: &event_kind,
            normalized_json: &normalized_json,
            raw_json: Some(&raw_json),
            idempotency_key: Some(&idempotency_key),
        },
    )
    .await?;

    let event = serde_json::from_str::<ConversationEvent>(&record.normalized_json)?;
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

async fn active_turn_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT active_turn_id FROM sessions WHERE id = ?")
        .bind(conversation_id)
        .fetch_optional(pool)
        .await
}

async fn latest_binding_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT id
           FROM conversation_agent_bindings
           WHERE conversation_id = ?
           ORDER BY created_at DESC
           LIMIT 1"#,
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await
}

fn map_agent_event_to_conversation_event(
    envelope: &AgentEventEnvelope,
    turn_id: Option<Uuid>,
) -> Option<ConversationEvent> {
    match &envelope.event {
        AgentEvent::ConnectionStatusChanged { snapshot } => {
            Some(ConversationEvent::AgentConnectionStatusChanged {
                status: match snapshot.status {
                    AgentConnectionStatus::Disconnected => {
                        ConversationAgentConnectionStatus::Closed
                    }
                    AgentConnectionStatus::Connecting => {
                        ConversationAgentConnectionStatus::Connecting
                    }
                    AgentConnectionStatus::Ready => ConversationAgentConnectionStatus::Ready,
                    AgentConnectionStatus::Failed => ConversationAgentConnectionStatus::Error,
                },
            })
        }
        AgentEvent::SessionLinked {
            acp_session_id,
            agent_type: _,
        } => Some(ConversationEvent::AgentBindingReady {
            acp_session_id: acp_session_id.clone(),
            capabilities: default_conversation_capabilities(),
        }),
        AgentEvent::MessageChunk {
            content: AgentContentBlock::Text { text },
        } => Some(ConversationEvent::AssistantTextDelta {
            text: text.clone(),
            message_id: None,
        }),
        AgentEvent::ThoughtChunk {
            content: AgentContentBlock::Text { text },
        } => Some(ConversationEvent::AssistantReasoningDelta {
            text: text.clone(),
            message_id: None,
        }),
        AgentEvent::ToolCall { tool_call } => Some(ConversationEvent::ToolCallUpsert {
            tool_call: ConversationToolCallPatch {
                tool_call_id: tool_call.id.clone(),
                title: Some(tool_call.title.clone()),
                kind: tool_call.kind.clone(),
                status: Some("running".to_string()),
                raw_input: tool_call
                    .input_preview
                    .as_ref()
                    .map(|preview| serde_json::json!({ "preview": preview })),
                raw_output: None,
                raw_output_append: None,
                content: None,
                locations: None,
                metadata: None,
                images: Vec::new(),
            },
        }),
        AgentEvent::ToolCallUpdate { update } => Some(ConversationEvent::ToolCallUpsert {
            tool_call: ConversationToolCallPatch {
                tool_call_id: update.id.clone(),
                title: None,
                kind: None,
                status: update.status.clone(),
                raw_input: None,
                raw_output: None,
                raw_output_append: update.content.clone(),
                content: update
                    .content
                    .as_ref()
                    .map(|content| serde_json::json!({ "text": content })),
                locations: Some(Vec::<ConversationFileLocation>::new()),
                metadata: None,
                images: Vec::new(),
            },
        }),
        AgentEvent::Plan { plan } => Some(ConversationEvent::PlanUpdated {
            entries: plan
                .entries
                .iter()
                .enumerate()
                .map(|(index, content)| ConversationPlanEntry {
                    id: format!("plan-{index}"),
                    content: content.clone(),
                    status: "pending".to_string(),
                    priority: None,
                })
                .collect(),
        }),
        AgentEvent::Usage { usage } => Some(ConversationEvent::UsageUpdated {
            usage: ConversationUsage {
                input_tokens: usage.used,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
        }),
        AgentEvent::SessionModes { modes, current } => {
            Some(ConversationEvent::SessionModeUpdated {
                current: current.clone(),
                modes: modes.clone(),
            })
        }
        AgentEvent::SessionConfigOptions { options } => {
            Some(ConversationEvent::SessionConfigOptionsUpdated {
                options: options.clone(),
            })
        }
        AgentEvent::AvailableCommands { commands } => {
            Some(ConversationEvent::AvailableCommandsUpdated {
                commands: commands.clone(),
            })
        }
        AgentEvent::SessionLoadFailed { reason } => {
            Some(ConversationEvent::AgentBindingLoadFailed {
                reason: SessionLoadFailureReason::Other {
                    message: reason.clone(),
                },
            })
        }
        AgentEvent::TurnCompleted { stop_reason }
        | AgentEvent::PromptFinished {
            finished: agents::AgentPromptFinished { stop_reason, .. },
        } => Some(ConversationEvent::TurnCompleted {
            stop_reason: stop_reason.clone(),
        }),
        AgentEvent::ForkSupported => {
            Some(ConversationEvent::ForkSupportUpdated { supported: true })
        }
        AgentEvent::SessionConfigStale { reason } => Some(ConversationEvent::SessionConfigStale {
            stale: true,
            reason: reason.clone(),
        }),
        AgentEvent::PermissionRequested { request } => {
            Some(ConversationEvent::PermissionRequested {
                request: ConversationPermissionRequest {
                    permission_id: request.id.to_string(),
                    request: request.clone(),
                },
            })
        }
        AgentEvent::PermissionResponded {
            permission_id,
            response,
            auto,
        } => Some(ConversationEvent::PermissionResponded {
            permission_id: permission_id.to_string(),
            response: ConversationPermissionResponse {
                response: response.clone(),
                auto: *auto,
            },
        }),
        AgentEvent::TerminalCreated { terminal } => Some(ConversationEvent::TerminalUpdated {
            terminal: ConversationTerminalPatch {
                terminal_id: terminal.id.to_string(),
                command: Some(terminal.command.clone()),
                args: terminal.args.clone(),
                cwd: terminal.cwd.clone(),
                status: "created".to_string(),
                output_summary: None,
                output_truncated: false,
                exit_status: None,
            },
        }),
        AgentEvent::TerminalOutput { output } => Some(ConversationEvent::TerminalUpdated {
            terminal: ConversationTerminalPatch {
                terminal_id: output.terminal_id.to_string(),
                command: None,
                args: Vec::new(),
                cwd: None,
                status: if output.exit_status.is_some() {
                    "exited".to_string()
                } else {
                    "running".to_string()
                },
                output_summary: Some(output.output.clone()),
                output_truncated: output.truncated,
                exit_status: output
                    .exit_status
                    .map(|code| serde_json::json!({ "code": code })),
            },
        }),
        AgentEvent::DelegationStarted {
            parent_tool_use_id,
            child_session_id,
            agent_type,
            task_preview,
        } => Some(ConversationEvent::DelegationStarted {
            delegation: ConversationDelegation {
                delegation_id: format!("delegation-{child_session_id}"),
                parent_tool_call_id: parent_tool_use_id.clone(),
                child_conversation_id: *child_session_id,
                agent_type: *agent_type,
                task_preview: task_preview.clone(),
            },
        }),
        AgentEvent::DelegationCompleted {
            parent_tool_use_id: _,
            child_session_id,
            result,
            ..
        } => Some(ConversationEvent::DelegationCompleted {
            delegation_id: format!("delegation-{child_session_id}"),
            result: match result {
                agents::DelegationResultSummary::Ok {
                    duration_ms,
                    text_preview,
                } => ConversationDelegationResult::Ok {
                    duration_ms: *duration_ms,
                    text_preview: text_preview.clone(),
                },
                agents::DelegationResultSummary::Err { error_code } => {
                    ConversationDelegationResult::Err {
                        error: ConversationError {
                            message: error_code.clone(),
                            code: Some(error_code.clone()),
                            raw: None,
                        },
                    }
                }
            },
        }),
        AgentEvent::Error { error } => Some(if turn_id.is_some() {
            ConversationEvent::TurnFailed {
                error: ConversationError {
                    message: error.message.clone(),
                    code: None,
                    raw: error.raw.clone(),
                },
            }
        } else {
            ConversationEvent::AgentBindingRecoveryFailed {
                reason: error.message.clone(),
            }
        }),
        AgentEvent::RawAcpDiagnostic { .. } => Some(ConversationEvent::RawDiagnosticRecorded {
            label: "raw_acp_diagnostic".to_string(),
        }),
        AgentEvent::MessageChunk { .. } | AgentEvent::ThoughtChunk { .. } => None,
        AgentEvent::SessionCreated { .. }
        | AgentEvent::PromptStarted { .. }
        | AgentEvent::ModeChanged { .. }
        | AgentEvent::ConfigChanged { .. } => None,
    }
}

fn conversation_event_source(event: &AgentEvent) -> &'static str {
    match event {
        AgentEvent::PermissionRequested { .. }
        | AgentEvent::PermissionResponded { .. }
        | AgentEvent::TerminalCreated { .. }
        | AgentEvent::TerminalOutput { .. } => "host",
        AgentEvent::MessageChunk { .. }
        | AgentEvent::ThoughtChunk { .. }
        | AgentEvent::ToolCall { .. }
        | AgentEvent::ToolCallUpdate { .. }
        | AgentEvent::Plan { .. }
        | AgentEvent::Usage { .. }
        | AgentEvent::TurnCompleted { .. }
        | AgentEvent::PromptFinished { .. } => "acp",
        _ => "runtime",
    }
}

fn default_conversation_capabilities() -> AcpCapabilitySnapshot {
    AcpCapabilitySnapshot {
        prompt: AgentPromptCapabilities {
            text: true,
            image: true,
            resource: false,
        },
        load_session: true,
        close_session: true,
        terminal: true,
        ..Default::default()
    }
}

/// Whether an event is worth writing to the append-only `agent_events` log.
/// High-frequency streaming events (per-token chunks, tool output, stderr) are
/// excluded — nothing reads them back, and persisting each one floods the
/// SQLite writer while an agent streams.
fn should_log_event(event: &AgentEvent) -> bool {
    !matches!(
        event,
        AgentEvent::MessageChunk { .. }
            | AgentEvent::ThoughtChunk { .. }
            | AgentEvent::ToolCall { .. }
            | AgentEvent::ToolCallUpdate { .. }
            | AgentEvent::Plan { .. }
            | AgentEvent::Usage { .. }
            | AgentEvent::TerminalOutput { .. }
            | AgentEvent::RawAcpDiagnostic { .. }
    )
}

async fn persist_connection_snapshot(
    pool: &SqlitePool,
    snapshot: &AgentConnectionSnapshot,
) -> Result<(), anyhow::Error> {
    let snapshot_json = serde_json::to_string(snapshot)?;
    let agent_type = serde_json::to_value(snapshot.agent_type)?
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let status = serde_json::to_value(snapshot.status)?
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let id = snapshot.id.to_string();
    let workspace_id = snapshot.workspace_id.to_string();
    let created_at = snapshot.created_at.to_rfc3339();
    let updated_at = snapshot.updated_at.to_rfc3339();
    AgentRuntimeStore::upsert_connection(
        pool,
        UpsertAgentConnection {
            id: &id,
            agent_type: &agent_type,
            workspace_id: &workspace_id,
            status: &status,
            working_dir: &snapshot.working_dir,
            status_message: snapshot.status_message.as_deref(),
            snapshot_json: &snapshot_json,
            created_at: &created_at,
            updated_at: &updated_at,
        },
    )
    .await?;
    Ok(())
}

async fn persist_session_snapshot(
    pool: &SqlitePool,
    workspace_id: Uuid,
    snapshot: &AgentSessionSnapshot,
) -> Result<(), anyhow::Error> {
    let snapshot_json = serde_json::to_string(snapshot)?;
    let queued_prompt_ids = serde_json::to_string(&snapshot.queued_prompt_ids)?;
    let id = snapshot.id.to_string();
    let connection_id = snapshot.connection_id.to_string();
    let workspace_id = workspace_id.to_string();
    let status = serde_json::to_value(snapshot.status)?
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let active_prompt_id = snapshot
        .active_prompt_id
        .as_ref()
        .map(|prompt_id| prompt_id.to_string());
    let created_at = snapshot.created_at.to_rfc3339();
    let updated_at = snapshot.updated_at.to_rfc3339();
    AgentRuntimeStore::upsert_session(
        pool,
        UpsertAgentSession {
            id: &id,
            connection_id: &connection_id,
            workspace_id: &workspace_id,
            acp_session_id: &snapshot.acp_session_id,
            status: &status,
            active_prompt_id: active_prompt_id.as_deref(),
            queued_prompt_ids: &queued_prompt_ids,
            snapshot_json: &snapshot_json,
            created_at: &created_at,
            updated_at: &updated_at,
        },
    )
    .await?;
    Ok(())
}

async fn persist_prompt_snapshot(
    pool: &SqlitePool,
    snapshot: &AgentPromptSnapshot,
) -> Result<(), anyhow::Error> {
    let snapshot_json = serde_json::to_string(snapshot)?;
    let status_json = serde_json::to_string(&snapshot.status)?;
    let id = snapshot.id.to_string();
    let session_id = snapshot.session_id.to_string();
    let created_at = snapshot.created_at.to_rfc3339();
    let updated_at = snapshot.updated_at.to_rfc3339();
    AgentRuntimeStore::upsert_prompt(
        pool,
        UpsertAgentPrompt {
            id: &id,
            session_id: &session_id,
            status: status_kind(&snapshot.status),
            status_json: &status_json,
            text_preview: &snapshot.text_preview,
            snapshot_json: &snapshot_json,
            created_at: &created_at,
            updated_at: &updated_at,
        },
    )
    .await?;
    Ok(())
}

fn status_kind(status: &AgentPromptStatus) -> &'static str {
    match status {
        AgentPromptStatus::Queued => "queued",
        AgentPromptStatus::Running => "running",
        AgentPromptStatus::Cancelling => "cancelling",
        AgentPromptStatus::Completed { .. } => "completed",
        AgentPromptStatus::Failed { .. } => "failed",
    }
}

fn terminal_title(source: AgentTerminalSource, command: &str) -> String {
    let name = command
        .split_whitespace()
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("Terminal");
    match source {
        AgentTerminalSource::Acp => format!("ACP {name}"),
    }
}

pub fn start_agent_terminal_forwarding(app: &AppHandle, state: &AppState) {
    let acp_app_handle = app.clone();
    let acp_pool = state.deployment.db().pool.clone();
    let mut acp_lifecycle_rx = agent_terminal_registry().subscribe_lifecycle();

    tauri::async_runtime::spawn(async move {
        let mut workspace_by_session: std::collections::HashMap<Uuid, Option<Uuid>> =
            std::collections::HashMap::new();

        loop {
            match acp_lifecycle_rx.recv().await {
                Ok(AgentTerminalLifecycleEvent::Created(event)) => {
                    let workspace_id = match event.cwd.as_ref().and_then(|cwd| cwd.to_str()) {
                        Some(path) => Workspace::resolve_container_ref_by_prefix(&acp_pool, path)
                            .await
                            .ok()
                            .map(|info| info.workspace_id),
                        None => None,
                    };

                    workspace_by_session.insert(event.terminal_id.0, workspace_id);

                    let command = if event.args.is_empty() {
                        event.command
                    } else {
                        format!("{} {}", event.command, event.args.join(" "))
                    };
                    let payload = AgentTerminalUiEvent::Created {
                        source: AgentTerminalSource::Acp,
                        session_id: event.terminal_id.0,
                        workspace_id,
                        title: terminal_title(AgentTerminalSource::Acp, &command),
                        command,
                        cwd: event.cwd.and_then(|cwd| cwd.to_str().map(str::to_string)),
                    };

                    if acp_app_handle
                        .emit(channels::AGENT_TERMINAL_EVENTS, &payload)
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(AgentTerminalLifecycleEvent::Released { terminal_id }) => {
                    let workspace_id = workspace_by_session.remove(&terminal_id.0).flatten();
                    let payload = AgentTerminalUiEvent::Released {
                        source: AgentTerminalSource::Acp,
                        session_id: terminal_id.0,
                        workspace_id,
                    };
                    if acp_app_handle
                        .emit(channels::AGENT_TERMINAL_EVENTS, &payload)
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use agents::{
        AgentAvailableCommand, AgentConnectionId, AgentConnectionSnapshot, AgentContentBlock,
        AgentEvent, AgentEventEnvelope, AgentPermissionId, AgentPermissionOption,
        AgentPermissionOptionKind, AgentPermissionRequest, AgentSessionId, AgentSessionSnapshot,
        AgentTerminalId, AgentTerminalOutput, AgentType,
        state::{AgentConnectionStatus, AgentSessionStatus},
    };
    use chrono::Utc;
    use sqlx::SqlitePool;
    use uuid::Uuid;

    use super::persist_agent_event;

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.expect("memory db");
        sqlx::query(include_str!(
            "../../crates/db/migrations/20260611000000_create_agent_runtime_tables.sql"
        ))
        .execute(&pool)
        .await
        .expect("create agent runtime tables");
        pool
    }

    #[tokio::test]
    async fn agent_event_persistence_orders_and_serializes_envelopes() {
        let pool = setup_pool().await;
        let now = Utc::now();
        let workspace_id = Uuid::new_v4();
        let connection_id = AgentConnectionId::new();
        let session_id = AgentSessionId::new();
        let connection_snapshot = AgentConnectionSnapshot {
            id: connection_id,
            agent_type: AgentType::Codex,
            workspace_id,
            status: AgentConnectionStatus::Ready,
            working_dir: "C:/work".to_string(),
            status_message: None,
            created_at: now,
            updated_at: now,
        };
        let session_snapshot = AgentSessionSnapshot {
            id: session_id,
            connection_id,
            acp_session_id: "acp-session".to_string(),
            status: AgentSessionStatus::Ready,
            active_prompt_id: None,
            queued_prompt_ids: Vec::new(),
            created_at: now,
            updated_at: now,
        };

        persist_agent_event(
            &pool,
            &AgentEventEnvelope {
                sequence: 1,
                workspace_id,
                connection_id,
                session_id: None,
                event: AgentEvent::ConnectionStatusChanged {
                    snapshot: connection_snapshot,
                },
                created_at: now,
            },
        )
        .await
        .unwrap();
        persist_agent_event(
            &pool,
            &AgentEventEnvelope {
                sequence: 2,
                workspace_id,
                connection_id,
                session_id: Some(session_id),
                event: AgentEvent::SessionCreated {
                    snapshot: session_snapshot,
                },
                created_at: now,
            },
        )
        .await
        .unwrap();
        persist_agent_event(
            &pool,
            &AgentEventEnvelope {
                sequence: 1,
                workspace_id,
                connection_id,
                session_id: Some(session_id),
                event: AgentEvent::RawAcpDiagnostic {
                    raw: serde_json::json!({ "message": "after restart" }),
                },
                created_at: now,
            },
        )
        .await
        .unwrap();

        let event_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_events")
            .fetch_one(&pool)
            .await
            .unwrap();
        let session_json: String =
            sqlx::query_scalar("SELECT snapshot_json FROM agent_sessions WHERE id = $1")
                .bind(session_id.to_string())
                .fetch_one(&pool)
                .await
                .unwrap();
        let latest_kinds: Vec<String> = sqlx::query_scalar(
            r#"SELECT event_kind
               FROM agent_events
               WHERE workspace_id = $1
               ORDER BY id DESC
               LIMIT 2"#,
        )
        .bind(workspace_id.to_string())
        .fetch_all(&pool)
        .await
        .unwrap();

        // RawAcpDiagnostic is a high-frequency streaming kind → skipped from the
        // append-only log (see `should_log_event`). Only the two lifecycle events
        // are persisted, newest-by-insert-order first.
        assert_eq!(event_count, 2);
        assert!(session_json.contains("acp-session"));
        assert_eq!(
            latest_kinds,
            vec!["session_created", "connection_status_changed"]
        );
    }

    #[test]
    fn high_frequency_streaming_events_are_not_logged() {
        assert!(!super::should_log_event(&AgentEvent::MessageChunk {
            content: agents::AgentContentBlock::Text {
                text: "hi".to_string(),
            },
        }));
        assert!(super::should_log_event(&AgentEvent::TurnCompleted {
            stop_reason: None,
        }));
    }

    #[test]
    fn acp_notification_mapping_covers_streaming_and_controls() {
        let envelope = AgentEventEnvelope {
            sequence: 1,
            workspace_id: Uuid::new_v4(),
            connection_id: AgentConnectionId::new(),
            session_id: Some(AgentSessionId::new()),
            event: AgentEvent::MessageChunk {
                content: AgentContentBlock::Text {
                    text: "hello".to_string(),
                },
            },
            created_at: now(),
        };

        assert!(matches!(
            super::map_agent_event_to_conversation_event(&envelope, Some(Uuid::new_v4())),
            Some(agents::conversation::ConversationEvent::AssistantTextDelta { .. })
        ));

        let load_failed = AgentEventEnvelope {
            event: AgentEvent::SessionLoadFailed {
                reason: "missing".to_string(),
            },
            ..envelope.clone()
        };
        assert!(matches!(
            super::map_agent_event_to_conversation_event(&load_failed, None),
            Some(agents::conversation::ConversationEvent::AgentBindingLoadFailed { .. })
        ));

        let commands = AgentEventEnvelope {
            event: AgentEvent::AvailableCommands {
                commands: vec![AgentAvailableCommand {
                    name: "compact".to_string(),
                    description: None,
                    input_schema: None,
                }],
            },
            ..envelope
        };
        assert!(matches!(
            super::map_agent_event_to_conversation_event(&commands, None),
            Some(agents::conversation::ConversationEvent::AvailableCommandsUpdated { .. })
        ));
    }

    #[test]
    fn acp_host_request_mapping_covers_permissions_and_terminal() {
        let session_id = AgentSessionId::new();
        let permission_id = AgentPermissionId::new();
        let envelope = AgentEventEnvelope {
            sequence: 1,
            workspace_id: Uuid::new_v4(),
            connection_id: AgentConnectionId::new(),
            session_id: Some(session_id),
            event: AgentEvent::PermissionRequested {
                request: AgentPermissionRequest {
                    id: permission_id,
                    session_id,
                    title: "Run command".to_string(),
                    details: None,
                    options: vec![AgentPermissionOption {
                        id: "allow".to_string(),
                        label: "Allow".to_string(),
                        kind: AgentPermissionOptionKind::AllowOnce,
                        description: None,
                    }],
                },
            },
            created_at: now(),
        };

        assert!(matches!(
            super::map_agent_event_to_conversation_event(&envelope, Some(Uuid::new_v4())),
            Some(agents::conversation::ConversationEvent::PermissionRequested { .. })
        ));

        let terminal = AgentEventEnvelope {
            event: AgentEvent::TerminalOutput {
                output: AgentTerminalOutput {
                    terminal_id: AgentTerminalId::new(),
                    output: "ok".to_string(),
                    truncated: false,
                    exit_status: Some(0),
                },
            },
            ..envelope
        };
        assert!(matches!(
            super::map_agent_event_to_conversation_event(&terminal, Some(Uuid::new_v4())),
            Some(agents::conversation::ConversationEvent::TerminalUpdated { .. })
        ));
    }

    #[test]
    fn failed_prompt_emits_terminal_event_mapping() {
        let envelope = AgentEventEnvelope {
            sequence: 1,
            workspace_id: Uuid::new_v4(),
            connection_id: AgentConnectionId::new(),
            session_id: Some(AgentSessionId::new()),
            event: AgentEvent::Error {
                error: agents::AgentErrorEvent {
                    message: "send failed".to_string(),
                    raw: None,
                },
            },
            created_at: now(),
        };

        assert!(matches!(
            super::map_agent_event_to_conversation_event(&envelope, Some(Uuid::new_v4())),
            Some(agents::conversation::ConversationEvent::TurnFailed { .. })
        ));
    }

    fn now() -> chrono::DateTime<Utc> {
        Utc::now()
    }
}
