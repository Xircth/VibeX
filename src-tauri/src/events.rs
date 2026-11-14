use agents::{
    AgentEvent,
    conversation::{ConversationEvent, ConversationRowOpBatch},
    terminal::{AgentTerminalLifecycleEvent, agent_terminal_registry},
};
use conversations::{
    ConversationAgentEventRecorder, ConversationEventSink, RecordedConversationBatch,
    WorkspaceSessionsChanged,
};
use db::models::{
    conversation::ConversationRecord, session::Session, workspace::Workspace,
};
use futures::StreamExt;
use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, EventTarget};
use tokio::time::{self, Duration, MissedTickBehavior};
use uuid::Uuid;

use crate::state::AppState;

pub mod channels {
    pub const GLOBAL_EVENTS: &str = "global-events";
    pub const AGENT_EVENTS: &str = "agent-events";
    pub const CONVERSATION_EVENTS: &str = "conversation-events";
    pub const AGENT_TERMINAL_EVENTS: &str = "agent-terminal-events";
    pub const DESKTOP_SESSION_ATTENTION: &str = "desktop-session-attention";
}

/// Desktop transport adapter for the shared [`conversations::ConversationLivePipeline`].
///
/// Row-op batches are published on the local desktop Host Event Bus; the existing
/// [`start_host_event_forwarding`] pump mirrors each registered channel onto Tauri
/// windows (ADR-0078 keeps one Host push surface for both transports), so there is
/// no second, Tauri-only emit path to drift.
pub struct TauriEventSink;

impl ConversationEventSink for TauriEventSink {
    fn emit_conversation_batch(&self, conversation_id: Uuid, batch: &ConversationRowOpBatch) {
        crate::host_bus::bus().emit(
            format!("{}:{conversation_id}", channels::CONVERSATION_EVENTS),
            batch,
        );
    }

    fn emit_global_batch(&self, batch: &ConversationRowOpBatch) {
        crate::host_bus::bus().emit(channels::CONVERSATION_EVENTS, batch);
    }

    fn emit_workspaces_sessions_changed(&self, payload: WorkspaceSessionsChanged) {
        crate::host_bus::bus().emit("workspace-sessions-changed", payload);
    }
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

pub(crate) fn is_local_desktop_event_target(target: &EventTarget) -> bool {
    match target {
        EventTarget::WebviewWindow { label }
        | EventTarget::Webview { label }
        | EventTarget::Window { label }
        | EventTarget::AnyLabel { label } => crate::host_windows::is_local_desktop_window(label),
        _ => false,
    }
}

fn emit_to_local_desktop<S: Serialize + Clone>(
    app: &AppHandle,
    event: &str,
    payload: S,
) -> Result<(), tauri::Error> {
    app.emit_filter(event, payload, is_local_desktop_event_target)
}

/// Forward Host Event Bus channels onto Tauri so desktop `listen` matches
/// the single Host push surface (ADR-0078). Local Host events stay on local
/// App windows; a Server-bound Host window listens through its own remote pump.
pub fn start_host_event_forwarding(app: &AppHandle) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut rx = crate::host_bus::bus().subscribe();
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if !server::HostEventBus::channel_allowed(&event.channel) {
                        continue;
                    }
                    if emit_to_local_desktop(&app_handle, &event.channel, event.payload).is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
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
                    if emit_to_local_desktop(&app_handle, channels::GLOBAL_EVENTS, &msg).is_err() {
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
        use futures::FutureExt as _;

        loop {
            let mut recorder =
                ConversationAgentEventRecorder::with_context(conversation_context.clone());
            let mut flush_interval = time::interval(CONVERSATION_STREAM_FLUSH_INTERVAL);
            flush_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

            let step = std::panic::AssertUnwindSafe(async {
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
                                    {
                                        crate::host_bus::bus()
                                            .emit(channels::AGENT_EVENTS, &event);
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
            })
            .catch_unwind()
            .await;

            match step {
                Ok(()) => break,
                Err(_) => {
                    tracing::error!(
                        "Desktop agent event forwarding worker panicked; respawning to keep receiver alive"
                    );
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
        ConversationEvent::TurnBlocked {
            reason:
                agents::conversation::TurnBlockedReason::Authentication { message }
                | agents::conversation::TurnBlockedReason::Other { message },
        } => Some((DesktopAttentionKind::Error, Some(message.clone()), None)),
        ConversationEvent::TurnBlocked { .. } => None,
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
            | agents::conversation::SessionLoadFailureReason::Unsupported
            | agents::conversation::SessionLoadFailureReason::SessionArchived { .. }
            | agents::conversation::SessionLoadFailureReason::SessionBusy
            | agents::conversation::SessionLoadFailureReason::SessionUnavailable => {
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
    _app_handle: &AppHandle,
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
    crate::host_bus::bus().emit(channels::DESKTOP_SESSION_ATTENTION, &payload);
    Ok(())
}

/// Whether an event is worth forwarding to the live `AGENT_EVENTS` Tauri channel
/// (the agents workbench). High-frequency or bulky transcript events are excluded.
/// The workbench does not render them; the conversation row-op stream is the
/// transcript. Tool calls carry image bytes and previews, so they stay on the
/// conversation log and off this channel. Persistence runs before this filter.
fn should_emit_agent_event(event: &AgentEvent) -> bool {
    !matches!(
        event,
        AgentEvent::MessageChunk { .. }
            | AgentEvent::ThoughtChunk { .. }
            | AgentEvent::ToolCall { .. }
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

pub fn start_agent_terminal_forwarding(_app: &AppHandle, state: &AppState) {
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

                    crate::host_bus::bus().emit(channels::AGENT_TERMINAL_EVENTS, &payload);
                }
                Ok(AgentTerminalLifecycleEvent::Exited { terminal_id, .. }) => {
                    let workspace_id = workspace_by_session.get(&terminal_id.0).copied().flatten();
                    let payload = AgentTerminalUiEvent::Exited {
                        source: AgentTerminalSource::Acp,
                        session_id: terminal_id.0,
                        workspace_id,
                    };
                    crate::host_bus::bus().emit(channels::AGENT_TERMINAL_EVENTS, &payload);
                }
                Ok(AgentTerminalLifecycleEvent::Released { terminal_id }) => {
                    let workspace_id = workspace_by_session.remove(&terminal_id.0).flatten();
                    let payload = AgentTerminalUiEvent::Released {
                        source: AgentTerminalSource::Acp,
                        session_id: terminal_id.0,
                        workspace_id,
                    };
                    crate::host_bus::bus().emit(channels::AGENT_TERMINAL_EVENTS, &payload);
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
        assert!(!super::should_emit_agent_event(&AgentEvent::ToolCall {
            tool_call: agents::AgentToolCall {
                id: "tool-1".to_string(),
                title: "read".to_string(),
                status: None,
                content: None,
                kind: None,
                input_preview: None,
                meta: None,
                images: Vec::new(),
            },
        }));
        assert!(super::should_emit_agent_event(&AgentEvent::TurnCompleted {
            stop_reason: None,
        }));
        assert!(super::should_emit_agent_event(
            &AgentEvent::SessionBindReady {
                acp_session_id: "acp-1".to_string(),
            }
        ));
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
            error: agents::conversation::ConversationError::new("boom", None, None),
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

    #[test]
    fn local_host_events_do_not_target_server_bound_windows() {
        use tauri::EventTarget;

        assert!(super::is_local_desktop_event_target(
            &EventTarget::webview_window("main")
        ));
        assert!(super::is_local_desktop_event_target(
            &EventTarget::webview_window("app-local-1")
        ));
        assert!(super::is_local_desktop_event_target(
            &EventTarget::webview_window("settings")
        ));
        assert!(!super::is_local_desktop_event_target(
            &EventTarget::webview_window("host-abc")
        ));
        assert!(!super::is_local_desktop_event_target(
            &EventTarget::webview_window("settings-host-abc")
        ));
    }

    #[tokio::test]
    async fn desktop_publisher_previous_sequence_tracks_last_emitted_sequence_across_empty_records()
    {
        use std::{str::FromStr, sync::Arc};

        use agents::conversation::{ConversationInputBlock, ConversationRowOpBatch};
        use conversations::ConversationRowProjectors;
        use db::models::{
            conversation_event::{AppendConversationEvent, ConversationEventRecord},
            conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
        };
        use server::HostEventBus;
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        use uuid::Uuid;

        crate::host_bus::install(Arc::new(HostEventBus::new()));
        let bus = crate::host_bus::bus();
        let mut rx = bus.subscribe();

        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite memory options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect sqlite memory pool");
        sqlx::migrate!("../crates/db/migrations")
            .run(&pool)
            .await
            .expect("migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable fk");

        // Drive the shared pipeline through the desktop transport sink: this is the
        // same code path the headless server runs, differing only in the sink.
        let pipeline = conversations::ConversationLivePipeline::new(
            pool.clone(),
            ConversationRowProjectors::default(),
            Arc::new(super::TauriEventSink),
        );

        let conversation_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        ConversationTurnRecord::create_pending(
            &pool,
            turn_id,
            CreateConversationTurn {
                conversation_id,
                prompt_id: None,
                text_preview: Some("hello"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create pending turn");
        let channel = format!("{}:{conversation_id}", super::channels::CONVERSATION_EVENTS);

        let json1 = serde_json::to_string(&ConversationEvent::UserTurnCreated {
            blocks: vec![ConversationInputBlock::Text {
                text: "hello".to_string(),
            }],
            workflow_refs: Vec::new(),
        })
        .expect("serialize event");
        let rec1 = ConversationEventRecord::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "acp",
                event_kind: "user_turn_created",
                normalized_json: &json1,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append seq 1");

        pipeline.publish(&rec1).await;

        let mut first_batches = Vec::new();
        while let Ok(evt) = rx.try_recv() {
            if evt.channel == channel {
                let batch: ConversationRowOpBatch =
                    serde_json::from_value(evt.payload).expect("decode batch");
                first_batches.push(batch);
            }
        }
        assert_eq!(first_batches.len(), 1);
        assert_eq!(first_batches[0].previous_sequence, Some(0));
        assert_eq!(first_batches[0].last_sequence, 1);

        let json2 = serde_json::to_string(&ConversationEvent::RawDiagnosticRecorded {
            label: "user_message_acknowledged".to_string(),
            payload: None,
        })
        .expect("serialize event");
        let rec2 = ConversationEventRecord::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "acp",
                event_kind: "raw_diagnostic_recorded",
                normalized_json: &json2,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append seq 2");

        pipeline.publish(&rec2).await;
        while let Ok(evt) = rx.try_recv() {
            assert_ne!(evt.channel, channel, "empty ops record must not emit batch");
        }

        let unpersisted = ConversationEventRecord {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            sequence: 2,
            source: "acp".to_string(),
            event_kind: "assistant_text_delta".to_string(),
            event_version: 1,
            normalized_json: serde_json::to_string(&ConversationEvent::AssistantTextDelta {
                text: "streaming chunk".to_string(),
                message_id: None,
            })
            .expect("serialize delta"),
            raw_json: None,
            idempotency_key: None,
            created_at: chrono::Utc::now(),
        };
        pipeline.publish_unpersisted(&unpersisted).await;

        let mut unpersisted_batches = Vec::new();
        while let Ok(evt) = rx.try_recv() {
            if evt.channel == channel {
                let batch: ConversationRowOpBatch =
                    serde_json::from_value(evt.payload).expect("decode batch");
                unpersisted_batches.push(batch);
            }
        }
        assert_eq!(unpersisted_batches.len(), 1);
        assert_eq!(
            unpersisted_batches[0].previous_sequence,
            Some(unpersisted_batches[0].last_sequence)
        );
        assert_eq!(unpersisted_batches[0].last_sequence, 1);

        let json3 = serde_json::to_string(&ConversationEvent::TurnCompleted { stop_reason: None })
            .expect("serialize event");
        let rec3 = ConversationEventRecord::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "acp",
                event_kind: "turn_completed",
                normalized_json: &json3,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append seq 3");

        pipeline.publish(&rec3).await;

        let mut final_batches = Vec::new();
        while let Ok(evt) = rx.try_recv() {
            if evt.channel == channel {
                let batch: ConversationRowOpBatch =
                    serde_json::from_value(evt.payload).expect("decode batch");
                final_batches.push(batch);
            }
        }
        assert_eq!(final_batches.len(), 1);
        assert_eq!(
            final_batches[0].previous_sequence,
            Some(first_batches[0].last_sequence)
        );
        assert_eq!(final_batches[0].last_sequence, 3);
    }
}
