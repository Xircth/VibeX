//! Storage reads used by the workflow application dispatcher.

use chrono::{DateTime, Utc};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

/// A running workflow step that already dispatched a Turn.
#[derive(FromRow)]
pub struct RunningStepRunRow {
    pub id: Uuid,
    pub run_id: Uuid,
    pub step_id: String,
    pub conversation_id: Uuid,
    pub turn_id: Uuid,
    pub workspace_id: Option<Uuid>,
    pub user_intervened: bool,
}

/// A running workflow step whose child Turn may be blocked on a user answer.
#[derive(FromRow)]
pub struct RunningInteractionRow {
    pub run_id: Uuid,
    pub step_id: String,
    pub child_waiting: bool,
    pub projected_waiting: bool,
}

pub async fn workflow_has_active_runs(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workflow_runs WHERE status IN ('running', 'waiting'))",
    )
    .fetch_one(pool)
    .await
}

pub async fn expired_workflow_run_ids(
    pool: &SqlitePool,
    now: DateTime<Utc>,
) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM workflow_runs
         WHERE status IN ('running', 'waiting') AND deadline_at <= ?
         ORDER BY deadline_at, id LIMIT 32",
    )
    .bind(now)
    .fetch_all(pool)
    .await
}

pub async fn running_agent_step_runs(
    pool: &SqlitePool,
) -> Result<Vec<RunningStepRunRow>, sqlx::Error> {
    sqlx::query_as::<_, RunningStepRunRow>(
        "SELECT id, run_id, step_id, conversation_id, turn_id, workspace_id,
                user_intervened
         FROM workflow_step_runs
         WHERE status = 'running' AND awaiting_input = 0
           AND conversation_id IS NOT NULL AND turn_id IS NOT NULL
         ORDER BY updated_at LIMIT 32",
    )
    .fetch_all(pool)
    .await
}

pub async fn running_workflow_interactions(
    pool: &SqlitePool,
) -> Result<Vec<RunningInteractionRow>, sqlx::Error> {
    sqlx::query_as::<_, RunningInteractionRow>(
        "SELECT step.run_id, step.step_id,
                turn.status = 'blocked' AS child_waiting,
                step.waiting_interaction
         FROM workflow_step_runs step
         JOIN conversation_turns turn ON turn.id = step.turn_id
         WHERE step.status = 'running'
         ORDER BY step.updated_at LIMIT 64",
    )
    .fetch_all(pool)
    .await
}

/// Ordered events of one Turn, used to derive its final assistant text.
pub async fn conversation_turn_events(
    pool: &SqlitePool,
    conversation_id: Uuid,
    turn_id: Uuid,
) -> Result<Vec<(i64, String, String)>, sqlx::Error> {
    sqlx::query_as::<_, (i64, String, String)>(
        "SELECT sequence, event_kind, normalized_json
         FROM conversation_events
         WHERE conversation_id = ? AND turn_id = ?
         ORDER BY sequence",
    )
    .bind(conversation_id)
    .bind(turn_id)
    .fetch_all(pool)
    .await
}
