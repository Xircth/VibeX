use db::models::workspace::Workspace;
use deployment::Deployment;
use executors::executors::acp::{AcpTerminalLifecycleEvent, acp_terminal_registry};
use futures::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::state::AppState;

pub mod channels {
    pub const GLOBAL_EVENTS: &str = "global-events";
    pub const ACP_TERMINAL_EVENTS: &str = "acp-terminal-events";
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpTerminalUiEvent {
    Created {
        session_id: Uuid,
        workspace_id: Option<Uuid>,
        command: String,
        cwd: Option<String>,
    },
    Released {
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

pub fn start_acp_terminal_forwarding(app: &AppHandle, state: &AppState) {
    let app_handle = app.clone();
    let pool = state.deployment.db().pool.clone();
    let mut lifecycle_rx = acp_terminal_registry().subscribe_lifecycle();

    tauri::async_runtime::spawn(async move {
        let mut workspace_by_session: std::collections::HashMap<Uuid, Option<Uuid>> =
            std::collections::HashMap::new();

        loop {
            match lifecycle_rx.recv().await {
                Ok(AcpTerminalLifecycleEvent::Created(event)) => {
                    let workspace_id = match event.cwd.as_ref().and_then(|cwd| cwd.to_str()) {
                        Some(path) => Workspace::resolve_container_ref_by_prefix(&pool, path)
                            .await
                            .ok()
                            .map(|info| info.workspace_id),
                        None => None,
                    };

                    workspace_by_session.insert(event.session_id, workspace_id);

                    let payload = AcpTerminalUiEvent::Created {
                        session_id: event.session_id,
                        workspace_id,
                        command: if event.args.is_empty() {
                            event.command
                        } else {
                            format!("{} {}", event.command, event.args.join(" "))
                        },
                        cwd: event.cwd.and_then(|cwd| cwd.to_str().map(str::to_string)),
                    };

                    if app_handle
                        .emit(channels::ACP_TERMINAL_EVENTS, &payload)
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(AcpTerminalLifecycleEvent::Released { session_id }) => {
                    let workspace_id = workspace_by_session.remove(&session_id).flatten();
                    let payload = AcpTerminalUiEvent::Released {
                        session_id,
                        workspace_id,
                    };
                    if app_handle
                        .emit(channels::ACP_TERMINAL_EVENTS, &payload)
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
