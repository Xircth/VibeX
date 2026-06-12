use std::sync::Arc;

use agents::{
    AgentConnectionSnapshot, AgentEvent, AgentEventEnvelope, AgentPromptSnapshot,
    AgentPromptStatus, AgentSessionSnapshot, RuntimeEventSink,
    terminal::{AgentTerminalLifecycleEvent, agent_terminal_registry},
};
use db::models::{
    agent_runtime::{
        AgentRuntimeStore, InsertAgentEvent, UpsertAgentConnection, UpsertAgentPendingPermission,
        UpsertAgentPermissionRequest, UpsertAgentPrompt, UpsertAgentSession, json_kind,
    },
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
    let mut agent_events = state.agent_runtime.subscribe_events();

    tauri::async_runtime::spawn(async move {
        loop {
            match agent_events.recv().await {
                Ok(event) => {
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

async fn persist_agent_event(
    pool: &SqlitePool,
    envelope: &AgentEventEnvelope,
) -> Result<(), anyhow::Error> {
    match &envelope.event {
        AgentEvent::ConnectionStatusChanged { snapshot } => {
            persist_connection_snapshot(pool, snapshot).await?;
        }
        AgentEvent::SessionCreated { snapshot } => {
            persist_session_snapshot(pool, envelope.workspace_id, snapshot).await?;
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

    Ok(())
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
        AgentConnectionId, AgentConnectionSnapshot, AgentEvent, AgentEventEnvelope, AgentSessionId,
        AgentSessionSnapshot, AgentType,
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

        assert_eq!(event_count, 3);
        assert!(session_json.contains("acp-session"));
        assert_eq!(latest_kinds, vec!["raw_acp_diagnostic", "session_created"]);
    }
}
