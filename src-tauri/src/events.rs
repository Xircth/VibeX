use db::models::workspace::Workspace;
use deployment::Deployment;
use executors::executors::{
    acp::{AcpTerminalLifecycleEvent, acp_terminal_registry},
    codex::{
        CodexTerminalLifecycleEvent, codex_terminal_registry, terminal::terminal_display_name,
    },
};
use futures::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::state::AppState;

pub mod channels {
    pub const GLOBAL_EVENTS: &str = "global-events";
    pub const AGENT_TERMINAL_EVENTS: &str = "agent-terminal-events";
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTerminalSource {
    Acp,
    Codex,
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

fn terminal_title(source: AgentTerminalSource, command: &str) -> String {
    let name = terminal_display_name(command).unwrap_or("Terminal");
    match source {
        AgentTerminalSource::Acp => format!("ACP {name}"),
        AgentTerminalSource::Codex => format!("Codex {name}"),
    }
}

pub fn start_agent_terminal_forwarding(app: &AppHandle, state: &AppState) {
    let acp_app_handle = app.clone();
    let codex_app_handle = app.clone();
    let pool = state.deployment.db().pool.clone();
    let acp_pool = pool.clone();
    let mut acp_lifecycle_rx = acp_terminal_registry().subscribe_lifecycle();
    let mut codex_lifecycle_rx = codex_terminal_registry().subscribe_lifecycle();

    tauri::async_runtime::spawn(async move {
        let mut workspace_by_session: std::collections::HashMap<Uuid, Option<Uuid>> =
            std::collections::HashMap::new();

        loop {
            match acp_lifecycle_rx.recv().await {
                Ok(AcpTerminalLifecycleEvent::Created(event)) => {
                    let workspace_id = match event.cwd.as_ref().and_then(|cwd| cwd.to_str()) {
                        Some(path) => Workspace::resolve_container_ref_by_prefix(&acp_pool, path)
                            .await
                            .ok()
                            .map(|info| info.workspace_id),
                        None => None,
                    };

                    workspace_by_session.insert(event.session_id, workspace_id);

                    let command = if event.args.is_empty() {
                        event.command
                    } else {
                        format!("{} {}", event.command, event.args.join(" "))
                    };
                    let payload = AgentTerminalUiEvent::Created {
                        source: AgentTerminalSource::Acp,
                        session_id: event.session_id,
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
                Ok(AcpTerminalLifecycleEvent::Released { session_id }) => {
                    let workspace_id = workspace_by_session.remove(&session_id).flatten();
                    let payload = AgentTerminalUiEvent::Released {
                        source: AgentTerminalSource::Acp,
                        session_id,
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

    tauri::async_runtime::spawn(async move {
        let mut workspace_by_session: std::collections::HashMap<Uuid, Option<Uuid>> =
            std::collections::HashMap::new();

        loop {
            match codex_lifecycle_rx.recv().await {
                Ok(CodexTerminalLifecycleEvent::Created(event)) => {
                    let workspace_id = match event.cwd.to_str() {
                        Some(path) => Workspace::resolve_container_ref_by_prefix(&pool, path)
                            .await
                            .ok()
                            .map(|info| info.workspace_id),
                        None => None,
                    };

                    workspace_by_session.insert(event.session_id, workspace_id);

                    let payload = AgentTerminalUiEvent::Created {
                        source: AgentTerminalSource::Codex,
                        session_id: event.session_id,
                        workspace_id,
                        title: terminal_title(AgentTerminalSource::Codex, &event.command),
                        command: event.command,
                        cwd: event.cwd.to_str().map(str::to_string),
                    };

                    if codex_app_handle
                        .emit(channels::AGENT_TERMINAL_EVENTS, &payload)
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(CodexTerminalLifecycleEvent::Released { session_id }) => {
                    let workspace_id = workspace_by_session.remove(&session_id).flatten();
                    let payload = AgentTerminalUiEvent::Released {
                        source: AgentTerminalSource::Codex,
                        session_id,
                        workspace_id,
                    };
                    if codex_app_handle
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
