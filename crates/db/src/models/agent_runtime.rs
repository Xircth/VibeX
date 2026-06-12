use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct AgentConnectionRecord {
    pub id: String,
    pub agent_type: String,
    pub workspace_id: String,
    pub status: String,
    pub working_dir: String,
    pub status_message: Option<String>,
    pub snapshot_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct AgentSessionRecord {
    pub id: String,
    pub connection_id: String,
    pub workspace_id: String,
    pub acp_session_id: String,
    pub status: String,
    pub active_prompt_id: Option<String>,
    pub queued_prompt_ids: String,
    pub snapshot_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct AgentPromptRecord {
    pub id: String,
    pub session_id: String,
    pub status: String,
    pub status_json: String,
    pub text_preview: String,
    pub snapshot_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct AgentEventRecord {
    pub sequence: i64,
    pub workspace_id: String,
    pub connection_id: String,
    pub session_id: Option<String>,
    pub event_kind: String,
    pub event_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct AgentPermissionRecord {
    pub id: String,
    pub session_id: String,
    pub connection_id: String,
    pub status: String,
    pub request_json: String,
    pub response_json: Option<String>,
    pub created_at: String,
    pub responded_at: Option<String>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct AgentPendingPermissionRecord {
    pub id: Uuid,
    pub session_id: Uuid,
    pub request_id: String,
    pub tool_call_json: String,
    pub options_json: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
    pub resolution: Option<String>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct AgentHistoryImportRecord {
    pub id: String,
    pub source_agent: String,
    pub external_session_id: String,
    pub title: Option<String>,
    pub workspace_path: Option<String>,
    pub raw_source_path: Option<String>,
    pub message_count: i64,
    pub raw_json: String,
    pub imported_at: String,
}

pub struct AgentRuntimeStore;

impl AgentRuntimeStore {
    pub async fn upsert_connection(
        pool: &SqlitePool,
        record: UpsertAgentConnection<'_>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"INSERT INTO agent_connections (
                   id, agent_type, workspace_id, status, working_dir,
                   status_message, snapshot_json, created_at, updated_at
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT(id) DO UPDATE SET
                   agent_type = excluded.agent_type,
                   workspace_id = excluded.workspace_id,
                   status = excluded.status,
                   working_dir = excluded.working_dir,
                   status_message = excluded.status_message,
                   snapshot_json = excluded.snapshot_json,
                   updated_at = excluded.updated_at"#,
        )
        .bind(record.id)
        .bind(record.agent_type)
        .bind(record.workspace_id)
        .bind(record.status)
        .bind(record.working_dir)
        .bind(record.status_message)
        .bind(record.snapshot_json)
        .bind(record.created_at)
        .bind(record.updated_at)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn upsert_session(
        pool: &SqlitePool,
        record: UpsertAgentSession<'_>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"INSERT INTO agent_sessions (
                   id, connection_id, workspace_id, acp_session_id, status,
                   active_prompt_id, queued_prompt_ids, snapshot_json,
                   created_at, updated_at
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT(id) DO UPDATE SET
                   connection_id = excluded.connection_id,
                   workspace_id = excluded.workspace_id,
                   acp_session_id = excluded.acp_session_id,
                   status = excluded.status,
                   active_prompt_id = excluded.active_prompt_id,
                   queued_prompt_ids = excluded.queued_prompt_ids,
                   snapshot_json = excluded.snapshot_json,
                   updated_at = excluded.updated_at"#,
        )
        .bind(record.id)
        .bind(record.connection_id)
        .bind(record.workspace_id)
        .bind(record.acp_session_id)
        .bind(record.status)
        .bind(record.active_prompt_id)
        .bind(record.queued_prompt_ids)
        .bind(record.snapshot_json)
        .bind(record.created_at)
        .bind(record.updated_at)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn upsert_prompt(
        pool: &SqlitePool,
        record: UpsertAgentPrompt<'_>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"INSERT INTO agent_prompts (
                   id, session_id, status, status_json, text_preview,
                   snapshot_json, created_at, updated_at
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT(id) DO UPDATE SET
                   session_id = excluded.session_id,
                   status = excluded.status,
                   status_json = excluded.status_json,
                   text_preview = excluded.text_preview,
                   snapshot_json = excluded.snapshot_json,
                   updated_at = excluded.updated_at"#,
        )
        .bind(record.id)
        .bind(record.session_id)
        .bind(record.status)
        .bind(record.status_json)
        .bind(record.text_preview)
        .bind(record.snapshot_json)
        .bind(record.created_at)
        .bind(record.updated_at)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn insert_event(
        pool: &SqlitePool,
        record: InsertAgentEvent<'_>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"INSERT INTO agent_events (
                   sequence, workspace_id, connection_id, session_id,
                   event_kind, event_json, created_at
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
        )
        .bind(record.sequence)
        .bind(record.workspace_id)
        .bind(record.connection_id)
        .bind(record.session_id)
        .bind(record.event_kind)
        .bind(record.event_json)
        .bind(record.created_at)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn upsert_permission_request(
        pool: &SqlitePool,
        record: UpsertAgentPermissionRequest<'_>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"INSERT INTO agent_permissions (
                   id, session_id, connection_id, status, request_json, created_at
               )
               VALUES ($1, $2, $3, 'pending', $4, $5)
               ON CONFLICT(id) DO UPDATE SET
                   session_id = excluded.session_id,
                   connection_id = excluded.connection_id,
                   status = 'pending',
                   request_json = excluded.request_json,
                   response_json = NULL,
                   responded_at = NULL"#,
        )
        .bind(record.id)
        .bind(record.session_id)
        .bind(record.connection_id)
        .bind(record.request_json)
        .bind(record.created_at)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn complete_permission(
        pool: &SqlitePool,
        permission_id: &str,
        response_json: &str,
        responded_at: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE agent_permissions
               SET status = 'responded',
                   response_json = $1,
                   responded_at = $2
               WHERE id = $3"#,
        )
        .bind(response_json)
        .bind(responded_at)
        .bind(permission_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn cancel_pending_permissions_for_session(
        pool: &SqlitePool,
        session_id: &str,
        responded_at: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE agent_permissions
               SET status = 'cancelled',
                   response_json = COALESCE(response_json, '{"kind":"cancelled"}'),
                   responded_at = COALESCE(responded_at, $1)
               WHERE session_id = $2 AND status = 'pending'"#,
        )
        .bind(responded_at)
        .bind(session_id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn upsert_pending_permission(
        pool: &SqlitePool,
        record: UpsertAgentPendingPermission<'_>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"INSERT INTO agent_pending_permissions (
                   id, session_id, request_id, tool_call_json, options_json, created_at
               )
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT(session_id, request_id) DO UPDATE SET
                   tool_call_json = excluded.tool_call_json,
                   options_json = excluded.options_json,
                   resolved_at = NULL,
                   resolution = NULL"#,
        )
        .bind(record.id)
        .bind(record.session_id)
        .bind(record.request_id)
        .bind(record.tool_call_json)
        .bind(record.options_json)
        .bind(record.created_at)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn resolve_pending_permission(
        pool: &SqlitePool,
        id: Uuid,
        resolution: &str,
        resolved_at: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"UPDATE agent_pending_permissions
               SET resolved_at = $1,
                   resolution = $2
               WHERE id = $3"#,
        )
        .bind(resolved_at)
        .bind(resolution)
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn list_pending_permissions_for_session(
        pool: &SqlitePool,
        session_id: Uuid,
    ) -> Result<Vec<AgentPendingPermissionRecord>, sqlx::Error> {
        sqlx::query_as::<_, AgentPendingPermissionRecord>(
            r#"SELECT id, session_id, request_id, tool_call_json, options_json,
                      created_at, resolved_at, resolution
               FROM agent_pending_permissions
               WHERE session_id = $1 AND resolved_at IS NULL
               ORDER BY created_at ASC"#,
        )
        .bind(session_id)
        .fetch_all(pool)
        .await
    }

    pub async fn insert_history_import(
        pool: &SqlitePool,
        record: InsertAgentHistoryImport<'_>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"INSERT INTO agent_history_imports (
                   id, source_agent, external_session_id, title, workspace_path,
                   raw_source_path, message_count, raw_json, imported_at
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"#,
        )
        .bind(record.id)
        .bind(record.source_agent)
        .bind(record.external_session_id)
        .bind(record.title)
        .bind(record.workspace_path)
        .bind(record.raw_source_path)
        .bind(record.message_count)
        .bind(record.raw_json)
        .bind(record.imported_at)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn list_permissions_for_session(
        pool: &SqlitePool,
        session_id: &str,
    ) -> Result<Vec<AgentPermissionRecord>, sqlx::Error> {
        sqlx::query_as::<_, AgentPermissionRecord>(
            r#"SELECT id, session_id, connection_id, status, request_json,
                      response_json, created_at, responded_at
               FROM agent_permissions
               WHERE session_id = $1
               ORDER BY created_at ASC"#,
        )
        .bind(session_id)
        .fetch_all(pool)
        .await
    }

    pub async fn list_events_for_workspace(
        pool: &SqlitePool,
        workspace_id: &str,
        limit: i64,
    ) -> Result<Vec<AgentEventRecord>, sqlx::Error> {
        sqlx::query_as::<_, AgentEventRecord>(
            r#"SELECT sequence, workspace_id, connection_id, session_id,
                      event_kind, event_json, created_at
               FROM agent_events
               WHERE workspace_id = $1
               ORDER BY sequence DESC
               LIMIT $2"#,
        )
        .bind(workspace_id)
        .bind(limit)
        .fetch_all(pool)
        .await
    }
}

pub struct UpsertAgentConnection<'a> {
    pub id: &'a str,
    pub agent_type: &'a str,
    pub workspace_id: &'a str,
    pub status: &'a str,
    pub working_dir: &'a str,
    pub status_message: Option<&'a str>,
    pub snapshot_json: &'a str,
    pub created_at: &'a str,
    pub updated_at: &'a str,
}

pub struct UpsertAgentSession<'a> {
    pub id: &'a str,
    pub connection_id: &'a str,
    pub workspace_id: &'a str,
    pub acp_session_id: &'a str,
    pub status: &'a str,
    pub active_prompt_id: Option<&'a str>,
    pub queued_prompt_ids: &'a str,
    pub snapshot_json: &'a str,
    pub created_at: &'a str,
    pub updated_at: &'a str,
}

pub struct UpsertAgentPrompt<'a> {
    pub id: &'a str,
    pub session_id: &'a str,
    pub status: &'a str,
    pub status_json: &'a str,
    pub text_preview: &'a str,
    pub snapshot_json: &'a str,
    pub created_at: &'a str,
    pub updated_at: &'a str,
}

pub struct InsertAgentEvent<'a> {
    pub sequence: i64,
    pub workspace_id: &'a str,
    pub connection_id: &'a str,
    pub session_id: Option<&'a str>,
    pub event_kind: &'a str,
    pub event_json: &'a str,
    pub created_at: &'a str,
}

pub struct UpsertAgentPermissionRequest<'a> {
    pub id: &'a str,
    pub session_id: &'a str,
    pub connection_id: &'a str,
    pub request_json: &'a str,
    pub created_at: &'a str,
}

pub struct UpsertAgentPendingPermission<'a> {
    pub id: Uuid,
    pub session_id: Uuid,
    pub request_id: &'a str,
    pub tool_call_json: &'a str,
    pub options_json: &'a str,
    pub created_at: &'a str,
}

pub struct InsertAgentHistoryImport<'a> {
    pub id: &'a str,
    pub source_agent: &'a str,
    pub external_session_id: &'a str,
    pub title: Option<&'a str>,
    pub workspace_path: Option<&'a str>,
    pub raw_source_path: Option<&'a str>,
    pub message_count: i64,
    pub raw_json: &'a str,
    pub imported_at: &'a str,
}

pub fn json_kind(value: &Value) -> &str {
    value
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
}

#[cfg(test)]
mod tests {
    use sqlx::SqlitePool;

    use super::*;

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.expect("memory db");
        sqlx::query(include_str!(
            "../../migrations/20260611000000_create_agent_runtime_tables.sql"
        ))
        .execute(&pool)
        .await
        .expect("create agent runtime tables");
        sqlx::query(r#"CREATE TABLE sessions (id BLOB PRIMARY KEY)"#)
            .execute(&pool)
            .await
            .expect("create sessions table");
        sqlx::query(include_str!(
            "../../migrations/20260313000000_create_agent_settings.sql"
        ))
        .execute(&pool)
        .await
        .expect("create agent settings table");
        sqlx::query(include_str!(
            "../../migrations/20260613000000_agent_session_core_foundation.sql"
        ))
        .execute(&pool)
        .await
        .expect("create phase 1 foundation tables");
        pool
    }

    #[tokio::test]
    async fn stores_connection_session_prompt_event_and_permission() {
        let pool = setup_pool().await;

        AgentRuntimeStore::upsert_connection(
            &pool,
            UpsertAgentConnection {
                id: "connection-1",
                agent_type: "codex",
                workspace_id: "workspace-1",
                status: "ready",
                working_dir: "C:/work",
                status_message: None,
                snapshot_json: "{}",
                created_at: "2026-06-11T00:00:00Z",
                updated_at: "2026-06-11T00:00:00Z",
            },
        )
        .await
        .unwrap();
        AgentRuntimeStore::upsert_session(
            &pool,
            UpsertAgentSession {
                id: "session-1",
                connection_id: "connection-1",
                workspace_id: "workspace-1",
                acp_session_id: "external-session",
                status: "ready",
                active_prompt_id: None,
                queued_prompt_ids: "[]",
                snapshot_json: "{}",
                created_at: "2026-06-11T00:00:00Z",
                updated_at: "2026-06-11T00:00:00Z",
            },
        )
        .await
        .unwrap();
        AgentRuntimeStore::upsert_prompt(
            &pool,
            UpsertAgentPrompt {
                id: "prompt-1",
                session_id: "session-1",
                status: "running",
                status_json: r#"{"kind":"running"}"#,
                text_preview: "hello",
                snapshot_json: "{}",
                created_at: "2026-06-11T00:00:00Z",
                updated_at: "2026-06-11T00:00:00Z",
            },
        )
        .await
        .unwrap();
        AgentRuntimeStore::insert_event(
            &pool,
            InsertAgentEvent {
                sequence: 1,
                workspace_id: "workspace-1",
                connection_id: "connection-1",
                session_id: Some("session-1"),
                event_kind: "prompt_started",
                event_json: "{}",
                created_at: "2026-06-11T00:00:00Z",
            },
        )
        .await
        .unwrap();
        AgentRuntimeStore::upsert_permission_request(
            &pool,
            UpsertAgentPermissionRequest {
                id: "permission-1",
                session_id: "session-1",
                connection_id: "connection-1",
                request_json: "{}",
                created_at: "2026-06-11T00:00:00Z",
            },
        )
        .await
        .unwrap();

        let rows = AgentRuntimeStore::list_permissions_for_session(&pool, "session-1")
            .await
            .unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "pending");
    }

    #[tokio::test]
    async fn stores_and_resolves_product_session_pending_permissions() {
        let pool = setup_pool().await;
        let session_id = Uuid::new_v4();
        let permission_id = Uuid::new_v4();

        sqlx::query("INSERT INTO sessions (id) VALUES ($1)")
            .bind(session_id)
            .execute(&pool)
            .await
            .expect("seed product session");

        AgentRuntimeStore::upsert_pending_permission(
            &pool,
            UpsertAgentPendingPermission {
                id: permission_id,
                session_id,
                request_id: "permission-request-1",
                tool_call_json: r#"{"name":"write_file"}"#,
                options_json: r#"[{"id":"allow","label":"Allow"}]"#,
                created_at: "2026-06-13T00:00:00Z",
            },
        )
        .await
        .unwrap();

        let rows = AgentRuntimeStore::list_pending_permissions_for_session(&pool, session_id)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].request_id, "permission-request-1");

        AgentRuntimeStore::resolve_pending_permission(
            &pool,
            permission_id,
            r#"{"kind":"selected","option_id":"allow"}"#,
            "2026-06-13T00:01:00Z",
        )
        .await
        .unwrap();

        let rows = AgentRuntimeStore::list_pending_permissions_for_session(&pool, session_id)
            .await
            .unwrap();
        assert!(rows.is_empty());
    }
}
