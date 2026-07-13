//! Cross-project queries backing the attention inbox: sessions whose latest
//! turn ended badly and sessions parked in review. Pending permission /
//! question items come from the shell's in-memory runtime state, not from
//! here — the inbox command merges both sources.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

/// One session enriched with its workspace/project context. `detail` carries a
/// short human-readable hint (turn error preview) when available.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct AttentionSessionRow {
    pub session_id: Uuid,
    pub session_name: Option<String>,
    pub agent_type: Option<String>,
    pub workspace_id: Uuid,
    pub task_id: Uuid,
    pub project_id: Uuid,
    pub project_name: String,
    pub turn_status: Option<String>,
    pub detail: Option<String>,
    pub happened_at: Option<DateTime<Utc>>,
}

const ROW_LIMIT: i64 = 50;

/// Sessions whose most recent turn ended `failed` or `interrupted` and that
/// have not moved on (still todo/inprogress/inreview, workspace not archived).
/// Self-clearing: a retry or follow-up appends a newer turn and the session
/// drops out of this list.
pub async fn failed_last_turns(pool: &SqlitePool) -> Result<Vec<AttentionSessionRow>, sqlx::Error> {
    sqlx::query_as::<_, AttentionSessionRow>(
        r#"SELECT s.id            AS session_id,
                  s.name          AS session_name,
                  s.agent_type    AS agent_type,
                  s.workspace_id  AS workspace_id,
                  w.task_id       AS task_id,
                  w.project_id    AS project_id,
                  p.name          AS project_name,
                  t.status        AS turn_status,
                  t.text_preview  AS detail,
                  COALESCE(t.completed_at, t.started_at) AS happened_at
           FROM conversation_turns t
           JOIN sessions s   ON s.id = t.conversation_id
           JOIN workspaces w ON w.id = s.workspace_id
           JOIN projects p   ON p.id = w.project_id
           WHERE t.status IN ('failed', 'interrupted')
             AND t.ordinal = (
                 SELECT MAX(t2.ordinal)
                 FROM conversation_turns t2
                 WHERE t2.conversation_id = t.conversation_id
             )
             AND s.status IN ('todo', 'inprogress', 'inreview')
             AND w.archived = FALSE
           ORDER BY happened_at DESC
           LIMIT ?"#,
    )
    .bind(ROW_LIMIT)
    .fetch_all(pool)
    .await
}

/// Sessions sitting in `inreview` (agent finished, waiting on a human
/// verdict), newest first. Self-clearing when the user moves them on.
pub async fn sessions_in_review(
    pool: &SqlitePool,
) -> Result<Vec<AttentionSessionRow>, sqlx::Error> {
    sqlx::query_as::<_, AttentionSessionRow>(
        r#"SELECT s.id           AS session_id,
                  s.name         AS session_name,
                  s.agent_type   AS agent_type,
                  s.workspace_id AS workspace_id,
                  w.task_id      AS task_id,
                  w.project_id   AS project_id,
                  p.name         AS project_name,
                  NULL           AS turn_status,
                  NULL           AS detail,
                  s.updated_at   AS happened_at
           FROM sessions s
           JOIN workspaces w ON w.id = s.workspace_id
           JOIN projects p   ON p.id = w.project_id
           WHERE s.status = 'inreview'
             AND w.archived = FALSE
           ORDER BY s.updated_at DESC
           LIMIT ?"#,
    )
    .bind(ROW_LIMIT)
    .fetch_all(pool)
    .await
}

/// Workspace/project context for an ad-hoc set of sessions (the in-memory
/// pending permission/question ids), same row shape as the list queries.
pub async fn session_contexts(
    pool: &SqlitePool,
    session_ids: &[Uuid],
) -> Result<Vec<AttentionSessionRow>, sqlx::Error> {
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    // SQLite has no array binds; the id count is tiny (pending permissions),
    // so an inline placeholder list is fine.
    let placeholders = vec!["?"; session_ids.len()].join(", ");
    let sql = format!(
        r#"SELECT s.id           AS session_id,
                  s.name         AS session_name,
                  s.agent_type   AS agent_type,
                  s.workspace_id AS workspace_id,
                  w.task_id      AS task_id,
                  w.project_id   AS project_id,
                  p.name         AS project_name,
                  NULL           AS turn_status,
                  NULL           AS detail,
                  s.updated_at   AS happened_at
           FROM sessions s
           JOIN workspaces w ON w.id = s.workspace_id
           JOIN projects p   ON p.id = w.project_id
           WHERE s.id IN ({placeholders})"#
    );
    let mut query = sqlx::query_as::<_, AttentionSessionRow>(&sql);
    for id in session_ids {
        query = query.bind(id);
    }
    query.fetch_all(pool).await
}
