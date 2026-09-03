use std::{collections::HashMap, sync::Arc};

use agents::{
    AgentEvent,
    conversation::{ConversationEvent, ConversationRowOpBatch, ConversationSessionModes},
    terminal::{AgentTerminalLifecycleEvent, agent_terminal_registry},
};
use conversations::{
    ConversationAgentEventRecorder, IncrementalRowProjector, RecordedConversationBatch,
};
use db::models::{
    conversation::ConversationRecord, conversation_event::ConversationEventRecord,
    session::Session, workspace::Workspace,
};
use futures::StreamExt;
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::{
    sync::Mutex,
    time::{self, Duration, MissedTickBehavior},
};
use uuid::Uuid;

use crate::state::AppState;

pub mod channels {
    pub const GLOBAL_EVENTS: &str = "global-events";
    pub const AGENT_EVENTS: &str = "agent-events";
    pub const CONVERSATION_EVENTS: &str = "conversation-events";
    pub const AGENT_TERMINAL_EVENTS: &str = "agent-terminal-events";
    pub const DESKTOP_SESSION_ATTENTION: &str = "desktop-session-attention";
}

/// Per-conversation cache of live incremental projectors (消灭双投影). Held on
/// `AppState`; fed only through [`emit_conversation_row_ops_after`].
pub type ConversationRowProjectors = Arc<Mutex<HashMap<Uuid, IncrementalRowProjector>>>;

/// Publish committed events as frontend row operations in durable sequence order.
/// This is the single realtime path to the frontend (消灭双投影): the frontend consumes
/// `ConversationRowOpBatch` and never folds raw events. It feeds the conversation's
/// cached incremental projector so ops are produced in O(1) amortized (no per-frame
/// re-projection). `after_sequence` seeds a missing projector; once active, the
/// projector's own cursor is authoritative so a later notifier cannot skip or overtake
/// an earlier committed event. Best-effort — a dropped batch is self-healed by the hook's
/// subscribe-time row backfill (`rows_since`) and by a full reload (`conversation_detail`),
/// both of which reproject from the same fold.
pub async fn emit_conversation_row_ops_after(
    app: &AppHandle,
    projectors: &ConversationRowProjectors,
    pool: &SqlitePool,
    conversation_id: Uuid,
    after_sequence: i64,
) {
    // Read the cursor and the durable tail without holding the map across SQLite.
    // Apply still runs under the lock so two notifiers cannot fold out of order;
    // a later load that wins the insert already includes earlier sequences.
    let publish_after = {
        let map = projectors.lock().await;
        map.get(&conversation_id)
            .map(IncrementalRowProjector::last_sequence)
            .unwrap_or(after_sequence)
    };
    let new_records =
        match ConversationEventRecord::events_since(pool, conversation_id, publish_after, 2000)
            .await
        {
            Ok(records) => records,
            Err(error) => {
                tracing::warn!(%conversation_id, %error, "row-op emit: reading events failed");
                return;
            }
        };
    if new_records.is_empty() {
        return;
    }
    let last_sequence = new_records
        .last()
        .map(|record| record.sequence)
        .unwrap_or(publish_after);

    // Session control state (modes / config options) is not a timeline row, so carry
    // the latest of each in the batch rather than on a separate channel. Also detect
    // whether the batch settles a turn — the projector is a pure cache and can be
    // dropped once its turn is terminal.
    let mut session_modes = None;
    let mut session_config_options = None;
    let mut available_commands = None;
    let mut settled = false;
    for record in &new_records {
        if matches!(
            record.event_kind.as_str(),
            "turn_completed" | "turn_failed" | "turn_cancelled" | "turn_interrupted"
        ) {
            settled = true;
        }
        if let Ok(event) = serde_json::from_str::<ConversationEvent>(&record.normalized_json) {
            match event {
                ConversationEvent::SessionModeUpdated { current, modes } => {
                    session_modes = Some(ConversationSessionModes { current, modes });
                }
                ConversationEvent::SessionConfigOptionsUpdated { options } => {
                    session_config_options = Some(options);
                }
                ConversationEvent::AvailableCommandsUpdated { commands } => {
                    available_commands = Some(commands);
                }
                _ => {}
            }
        }
    }

    let queue_changed = new_records
        .iter()
        .any(|record| record.event_kind == "conversation_input");

    let loaded = {
        let map = projectors.lock().await;
        if map.contains_key(&conversation_id) {
            None
        } else {
            drop(map);
            match IncrementalRowProjector::load(pool, conversation_id, publish_after).await {
                Ok(projector) => Some(projector),
                Err(error) => {
                    tracing::warn!(%conversation_id, %error, "row-op emit: projector load failed");
                    return;
                }
            }
        }
    };

    let mut map = projectors.lock().await;
    if let std::collections::hash_map::Entry::Vacant(entry) = map.entry(conversation_id) {
        let projector = match loaded {
            Some(projector) => projector,
            None => {
                match IncrementalRowProjector::load(pool, conversation_id, publish_after).await {
                    Ok(projector) => projector,
                    Err(error) => {
                        tracing::warn!(%conversation_id, %error, "row-op emit: projector load failed");
                        return;
                    }
                }
            }
        };
        entry.insert(projector);
    }
    let mut ops = Vec::new();
    {
        let projector = map.get_mut(&conversation_id).expect("projector present");
        for record in &new_records {
            if record.sequence <= projector.last_sequence() {
                continue;
            }
            match projector.apply(record) {
                Ok(record_ops) => ops.extend(record_ops),
                Err(error) => {
                    tracing::warn!(sequence = record.sequence, %error, "row-op emit: fold failed")
                }
            }
        }
    }

    if !(ops.is_empty()
        && session_modes.is_none()
        && session_config_options.is_none()
        && available_commands.is_none()
        && !queue_changed)
    {
        let batch = ConversationRowOpBatch {
            conversation_id,
            last_sequence,
            ops,
            session_modes,
            session_config_options,
            available_commands,
        };
        if let Err(error) = app.emit(
            &format!("{}:{conversation_id}", channels::CONVERSATION_EVENTS),
            &batch,
        ) {
            tracing::warn!(%conversation_id, %error, "failed to emit conversation row ops");
        }
        if let Err(error) = app.emit(channels::CONVERSATION_EVENTS, &batch) {
            tracing::warn!(%conversation_id, %error, "failed to emit conversation row ops");
        }
    }

    // A settled turn's projector holds the whole folded timeline but is a pure cache —
    // drop it to bound memory. The next committed event reloads it from that event's
    // predecessor sequence. Without this, one projector leaked per conversation ever
    // streamed (the map is only otherwise cleared by `close_conversation`, which the UI
    // never calls). Done under the lock, after emit.
    if settled {
        map.remove(&conversation_id);
    }
    drop(map);

    let workbench_changed = new_records.iter().any(|record| {
        matches!(
            record.event_kind.as_str(),
            "user_turn_queued"
                | "user_turn_started"
                | "turn_blocked"
                | "turn_completed"
                | "turn_failed"
                | "turn_cancelled"
                | "turn_interrupted"
                | "conversation_input"
                | "user_turn_created"
        )
    });
    if workbench_changed {
        if let Ok(Some(session)) = Session::find_by_id(pool, conversation_id).await {
            let _ = app.emit(
                "workspace-sessions-changed",
                WorkspaceSessionsChangedPayload {
                    workspace_id: session.workspace_id,
                    conversation_id,
                },
            );
        }
    }
}

#[derive(Clone, Serialize)]
struct WorkspaceSessionsChangedPayload {
    workspace_id: Uuid,
    conversation_id: Uuid,
}

/// Persist coalesced streaming deltas on this interval. Overlay text still
/// reaches the UI on the same flush; 80 ms is ~12 Hz and keeps SQLite's single
/// writer from being the global clock (ADR-0061).
const CONVERSATION_STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(80);

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
        agent_session_id: Uuid,
        workspace_id: Option<Uuid>,
        title: String,
        command: String,
        agent_label: String,
        cwd: Option<String>,
    },
    Exited {
        source: AgentTerminalSource,
        session_id: Uuid,
        workspace_id: Option<Uuid>,
    },
    Released {
        source: AgentTerminalSource,
        session_id: Uuid,
        workspace_id: Option<Uuid>,
    },
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
    let conversation_context = state.conversation_context();
    let mut agent_events = state
        .conversation_agent_events
        .lock()
        .expect("conversation event receiver lock poisoned")
        .take()
        .expect("conversation event forwarding must start exactly once");

    tauri::async_runtime::spawn(async move {
        let mut recorder = ConversationAgentEventRecorder::with_context(conversation_context);
        let mut flush_interval = time::interval(CONVERSATION_STREAM_FLUSH_INTERVAL);
        flush_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = flush_interval.tick() => {
                    match recorder.flush_buffered().await {
                        Ok(batch) => handle_recorded_conversation_batch(
                        &conversation_pool,
                        &app_handle,
                        batch,
                    ).await,
                        Err(error) => tracing::warn!(%error, "Failed to flush conversation events"),
                    }
                }
                received = agent_events.recv() => {
                    match received {
                        Some(event) => {
                            match recorder.record_buffered(&event).await {
                                Ok(batch) => handle_recorded_conversation_batch(
                                    &conversation_pool,
                                    &app_handle,
                                    batch,
                                ).await,
                                Err(error) => {
                                    tracing::warn!(
                                        sequence = event.sequence,
                                        error = %error,
                                        "Failed to persist conversation event"
                                    );
                                }
                            }
                            if should_emit_agent_event(&event.event)
                                && app_handle.emit(channels::AGENT_EVENTS, &event).is_err()
                            {
                                break;
                            }
                        }
                        None => {
                            if let Ok(batch) = recorder.flush_buffered().await {
                                handle_recorded_conversation_batch(
                                    &conversation_pool,
                                    &app_handle,
                                    batch,
                                ).await;
                            }
                            break;
                        }
                    }
                }
            }
        }
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DesktopAttentionKind {
    Permission,
    Question,
    Warning,
    Error,
    Completed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSessionAttention {
    project_id: Uuid,
    workspace_id: Uuid,
    session_id: Uuid,
    turn_id: Option<Uuid>,
    kind: DesktopAttentionKind,
    title: Option<String>,
    message: Option<String>,
}

async fn handle_recorded_conversation_batch(
    pool: &SqlitePool,
    app_handle: &AppHandle,
    batch: RecordedConversationBatch,
) {
    for event in batch.events {
        if let Some((kind, title, message)) = attention_from_event(&event.event)
            && let Err(error) = emit_desktop_session_attention(
                pool,
                app_handle,
                event.conversation_id,
                event.turn_id,
                kind,
                title,
                message,
            )
            .await
        {
            tracing::warn!(
                conversation_id = %event.conversation_id,
                %error,
                "Failed to emit desktop session attention"
            );
        }
    }

    for completion in batch.completions {
        if is_local_user_turn_origin(&completion.origin)
            && let Err(error) = emit_desktop_session_attention(
                pool,
                app_handle,
                completion.conversation_id,
                Some(completion.turn_id),
                DesktopAttentionKind::Completed,
                None,
                None,
            )
            .await
        {
            tracing::warn!(
                conversation_id = %completion.conversation_id,
                turn_id = %completion.turn_id,
                %error,
                "Failed to emit desktop conversation completion"
            );
        }
    }
}

fn is_local_user_turn_origin(origin: &str) -> bool {
    origin == conversations::commit_reminder::LOCAL_USER_ORIGIN
}

fn attention_from_event(
    event: &ConversationEvent,
) -> Option<(DesktopAttentionKind, Option<String>, Option<String>)> {
    match event {
        ConversationEvent::PermissionRequested { request } => Some((
            DesktopAttentionKind::Permission,
            Some(request.request.title.clone()),
            None,
        )),
        ConversationEvent::QuestionRequested { request } => Some((
            DesktopAttentionKind::Question,
            Some(request.prompt.clone()),
            None,
        )),
        ConversationEvent::TurnFailed { error } => Some((
            DesktopAttentionKind::Error,
            Some(error.message.clone()),
            None,
        )),
        ConversationEvent::TurnBlocked { reason } => match reason {
            agents::conversation::TurnBlockedReason::Authentication { message }
            | agents::conversation::TurnBlockedReason::Other { message } => {
                Some((DesktopAttentionKind::Error, Some(message.clone()), None))
            }
            _ => None,
        },
        ConversationEvent::AgentBindingRecoveryFailed { reason } => {
            Some((DesktopAttentionKind::Error, Some(reason.clone()), None))
        }
        ConversationEvent::AgentBindingLoadFailed { reason } => match reason {
            agents::conversation::SessionLoadFailureReason::AuthenticationRequired { message } => {
                Some((DesktopAttentionKind::Error, Some(message.clone()), None))
            }
            agents::conversation::SessionLoadFailureReason::Other { message } => {
                Some((DesktopAttentionKind::Warning, Some(message.clone()), None))
            }
            agents::conversation::SessionLoadFailureReason::ResourceNotFound
            | agents::conversation::SessionLoadFailureReason::Unsupported => {
                Some((DesktopAttentionKind::Warning, None, None))
            }
        },
        ConversationEvent::RawDiagnosticRecorded { label, payload } => {
            diagnostic_attention(label, payload.as_ref())
        }
        _ => None,
    }
}

fn diagnostic_attention(
    label: &str,
    payload: Option<&serde_json::Value>,
) -> Option<(DesktopAttentionKind, Option<String>, Option<String>)> {
    let kind = payload
        .and_then(|value| value.get("kind"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(label);
    match kind {
        "session_config_override_skipped" => Some((
            DesktopAttentionKind::Warning,
            Some("会话配置未应用".into()),
            None,
        )),
        _ => None,
    }
}

async fn emit_desktop_session_attention(
    pool: &SqlitePool,
    app_handle: &AppHandle,
    conversation_id: Uuid,
    turn_id: Option<Uuid>,
    kind: DesktopAttentionKind,
    title: Option<String>,
    message: Option<String>,
) -> Result<(), anyhow::Error> {
    let conversation = ConversationRecord::find_by_id(pool, conversation_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Conversation {conversation_id} not found"))?;
    let workspace = Workspace::find_by_id(pool, conversation.workspace_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Workspace {} not found", conversation.workspace_id))?;
    let payload = DesktopSessionAttention {
        project_id: workspace.project_id,
        workspace_id: workspace.id,
        session_id: conversation_id,
        turn_id,
        kind,
        title,
        message,
    };
    app_handle.emit(channels::DESKTOP_SESSION_ATTENTION, &payload)?;
    Ok(())
}

/// Whether an event is worth forwarding to the live `AGENT_EVENTS` Tauri channel
/// (the agents workbench debug view). High-frequency streaming events (per-token
/// chunks, tool-call updates, terminal output, raw ACP diagnostics) are excluded —
/// the workbench doesn't render them and they would flood the channel while an agent
/// streams. (The former append-only `agent_events` DB log this once gated was retired
/// in 批次D1; `conversation_events` is the single authoritative log.)
fn should_emit_agent_event(event: &AgentEvent) -> bool {
    !matches!(
        event,
        AgentEvent::MessageChunk { .. }
            | AgentEvent::ThoughtChunk { .. }
            | AgentEvent::ToolCallUpdate { .. }
            | AgentEvent::TerminalOutput { .. }
            | AgentEvent::RawAcpDiagnostic { .. }
    )
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
                    let session = Session::find_by_id(&acp_pool, event.session_id.0)
                        .await
                        .ok()
                        .flatten();
                    let workspace_id = session.as_ref().map(|item| item.workspace_id).or({
                        match event.cwd.as_ref().and_then(|cwd| cwd.to_str()) {
                            Some(path) => {
                                match Workspace::resolve_container_ref_by_prefix(&acp_pool, path)
                                    .await
                                {
                                    Ok(info) => Some(info.workspace_id),
                                    Err(error) => {
                                        tracing::warn!(
                                            path,
                                            %error,
                                            "Failed to resolve terminal workspace from cwd"
                                        );
                                        None
                                    }
                                }
                            }
                            None => None,
                        }
                    });

                    workspace_by_session.insert(event.terminal_id.0, workspace_id);

                    let command = if event.args.is_empty() {
                        event.command
                    } else {
                        format!("{} {}", event.command, event.args.join(" "))
                    };
                    let agent_label = session
                        .as_ref()
                        .and_then(|item| {
                            item.agent_id
                                .as_ref()
                                .map(|id| id.as_str().to_string())
                                .or(item.executor.clone())
                        })
                        .unwrap_or_else(|| "Agent".to_string());
                    let payload = AgentTerminalUiEvent::Created {
                        source: AgentTerminalSource::Acp,
                        session_id: event.terminal_id.0,
                        agent_session_id: event.session_id.0,
                        workspace_id,
                        title: terminal_title(AgentTerminalSource::Acp, &command),
                        command,
                        agent_label,
                        cwd: event.cwd.and_then(|cwd| cwd.to_str().map(str::to_string)),
                    };

                    if acp_app_handle
                        .emit(channels::AGENT_TERMINAL_EVENTS, &payload)
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(AgentTerminalLifecycleEvent::Exited { terminal_id, .. }) => {
                    let workspace_id = workspace_by_session.get(&terminal_id.0).copied().flatten();
                    let payload = AgentTerminalUiEvent::Exited {
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
    use agents::{AgentEvent, conversation::ConversationEvent};

    #[test]
    fn automatic_commit_reminder_turn_does_not_emit_a_second_reply_notification() {
        assert!(super::is_local_user_turn_origin("local_user"));
        assert!(!super::is_local_user_turn_origin("user"));
        assert!(!super::is_local_user_turn_origin("commit_reminder"));
        assert!(!super::is_local_user_turn_origin("automation"));
    }

    #[test]
    fn high_frequency_streaming_events_are_not_emitted_to_agent_channel() {
        assert!(!super::should_emit_agent_event(&AgentEvent::MessageChunk {
            content: agents::AgentContentBlock::Text {
                text: "hi".to_string(),
            },
        }));
        assert!(!super::should_emit_agent_event(&AgentEvent::ThoughtChunk {
            content: agents::AgentContentBlock::Text {
                text: "thinking".to_string(),
            },
        }));
        assert!(super::should_emit_agent_event(&AgentEvent::TurnCompleted {
            stop_reason: None,
        }));
    }

    #[test]
    fn chat_notifications_are_sourced_from_normalized_conversation_events() {
        assert_eq!(
            services::services::chat_delivery::conversation_event_key(
                &ConversationEvent::AssistantTextDelta {
                    text: "hi".to_string(),
                    message_id: None,
                }
            ),
            None
        );
        assert_eq!(
            services::services::chat_delivery::conversation_event_key(
                &ConversationEvent::UserTurnCreated {
                    blocks: vec![agents::conversation::ConversationInputBlock::Text {
                        text: "hi".to_string(),
                    }],
                    workflow_refs: Vec::new(),
                }
            ),
            Some("prompt_started")
        );
    }

    #[test]
    fn desktop_attention_fires_for_permission_error_and_warning() {
        use agents::{
            AgentPermissionId, AgentPermissionRequest, AgentSessionId,
            conversation::ConversationPermissionRequest,
        };

        let permission = ConversationEvent::PermissionRequested {
            request: ConversationPermissionRequest {
                permission_id: "p1".into(),
                request: AgentPermissionRequest {
                    id: AgentPermissionId::new(),
                    session_id: AgentSessionId::new(),
                    title: "Edit file".into(),
                    details: None,
                    options: Vec::new(),
                },
            },
        };
        let (kind, title, _) = super::attention_from_event(&permission).expect("permission");
        assert_eq!(kind, super::DesktopAttentionKind::Permission);
        assert_eq!(title.as_deref(), Some("Edit file"));

        let failed = ConversationEvent::TurnFailed {
            error: agents::conversation::ConversationError {
                message: "boom".into(),
                code: None,
                raw: None,
            },
        };
        assert_eq!(
            super::attention_from_event(&failed).map(|(kind, _, _)| kind),
            Some(super::DesktopAttentionKind::Error)
        );

        let skipped = ConversationEvent::RawDiagnosticRecorded {
            label: "diagnostic".into(),
            payload: Some(serde_json::json!({ "kind": "session_config_override_skipped" })),
        };
        assert_eq!(
            super::attention_from_event(&skipped).map(|(kind, _, _)| kind),
            Some(super::DesktopAttentionKind::Warning)
        );

        let ack = ConversationEvent::RawDiagnosticRecorded {
            label: "diagnostic".into(),
            payload: Some(serde_json::json!({ "kind": "user_message_acknowledged" })),
        };
        assert_eq!(super::attention_from_event(&ack), None);

        assert_eq!(
            super::attention_from_event(&ConversationEvent::TurnCompleted { stop_reason: None }),
            None
        );
    }
}
