//! Kanban workbench status is derived from conversation facts, not from the
//! last time a turn started.
//!
//! - **todo**: created, no turns yet
//! - **inprogress**: an in-flight turn, or a viewed terminal turn with queued input
//! - **inreview**: a finished turn that has not been opened in the execution or
//!   monitor area (including failed / interrupted turns, and unviewed turns that
//!   still have queued follow-ups)
//! - **done**: a finished turn that has been viewed, or a user-cancelled turn
//!   with nothing waiting. This is not a conversation terminal; a new turn can
//!   start later.

use db::models::{
    conversation_turn::ConversationTurnRecord,
    session::{Session, SessionStatus},
};
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnPhase {
    None,
    InFlight,
    Completed,
    Failed,
    Interrupted,
    Cancelled,
}

pub fn turn_phase(status: &str) -> TurnPhase {
    match status {
        "pending" | "queued" | "running" | "blocked" => TurnPhase::InFlight,
        "completed" => TurnPhase::Completed,
        "failed" => TurnPhase::Failed,
        "interrupted" => TurnPhase::Interrupted,
        "cancelled" => TurnPhase::Cancelled,
        _ => TurnPhase::Completed,
    }
}

pub fn derive_workbench_status(
    phase: TurnPhase,
    latest_turn_viewed: bool,
    has_queued_input: bool,
) -> SessionStatus {
    match phase {
        TurnPhase::None => SessionStatus::Todo,
        TurnPhase::InFlight => SessionStatus::InProgress,
        TurnPhase::Cancelled => SessionStatus::Done,
        TurnPhase::Completed | TurnPhase::Failed | TurnPhase::Interrupted => {
            if has_queued_input {
                if latest_turn_viewed {
                    SessionStatus::InProgress
                } else {
                    SessionStatus::InReview
                }
            } else if latest_turn_viewed {
                SessionStatus::Done
            } else {
                SessionStatus::InReview
            }
        }
    }
}

pub async fn reconcile(pool: &SqlitePool, conversation_id: Uuid) -> Result<(), sqlx::Error> {
    let mut conn = pool.acquire().await?;
    reconcile_on_connection(&mut conn, conversation_id).await
}

pub async fn reconcile_on_connection(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
) -> Result<(), sqlx::Error> {
    let Some(current) = session_workbench_row(conn, conversation_id).await? else {
        return Ok(());
    };
    if current.status == SessionStatus::Archived {
        return Ok(());
    }

    let latest =
        ConversationTurnRecord::latest_for_conversation_on_connection(conn, conversation_id)
            .await?;
    let phase = latest
        .as_ref()
        .map(|turn| turn_phase(&turn.status))
        .unwrap_or(TurnPhase::None);
    let latest_turn_viewed = match latest.as_ref() {
        Some(turn) => current.last_viewed_turn_id == Some(turn.id),
        None => false,
    };
    let has_queued_input = has_queued_input_on_connection(conn, conversation_id).await?;
    let next = derive_workbench_status(phase, latest_turn_viewed, has_queued_input);
    if next == current.status {
        return Ok(());
    }

    Session::update_status_on_connection(conn, conversation_id, next).await
}

pub async fn mark_latest_turn_viewed(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<(), sqlx::Error> {
    let mut conn = pool.acquire().await?;
    mark_latest_turn_viewed_on_connection(&mut conn, conversation_id).await?;
    reconcile_on_connection(&mut conn, conversation_id).await
}

pub async fn mark_latest_turn_viewed_on_connection(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"UPDATE sessions
           SET last_viewed_turn_id = (
               SELECT id
               FROM conversation_turns
               WHERE conversation_id = sessions.id
               ORDER BY ordinal DESC
               LIMIT 1
           )
           WHERE id = ?
             AND deleted_at IS NULL
             AND status != 'archived'"#,
    )
    .bind(conversation_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn apply_manual_status(
    pool: &SqlitePool,
    conversation_id: Uuid,
    status: SessionStatus,
) -> Result<(), sqlx::Error> {
    let mut conn = pool.acquire().await?;
    match status {
        SessionStatus::Done => {
            mark_latest_turn_viewed_on_connection(&mut conn, conversation_id).await?;
        }
        SessionStatus::InReview => {
            sqlx::query(
                r#"UPDATE sessions
                   SET last_viewed_turn_id = NULL
                   WHERE id = ?
                     AND deleted_at IS NULL
                     AND status != 'archived'"#,
            )
            .bind(conversation_id)
            .execute(&mut *conn)
            .await?;
        }
        SessionStatus::Archived | SessionStatus::Todo | SessionStatus::InProgress => {}
    }
    Session::update_status_on_connection(&mut conn, conversation_id, status).await
}

struct SessionWorkbenchRow {
    status: SessionStatus,
    last_viewed_turn_id: Option<Uuid>,
}

async fn session_workbench_row(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
) -> Result<Option<SessionWorkbenchRow>, sqlx::Error> {
    sqlx::query_as::<_, (SessionStatus, Option<Uuid>)>(
        r#"SELECT status, last_viewed_turn_id
           FROM sessions
           WHERE id = ? AND deleted_at IS NULL"#,
    )
    .bind(conversation_id)
    .fetch_optional(&mut *conn)
    .await
    .map(|row| {
        row.map(|(status, last_viewed_turn_id)| SessionWorkbenchRow {
            status,
            last_viewed_turn_id,
        })
    })
}

async fn has_queued_input_on_connection(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
) -> Result<bool, sqlx::Error> {
    let exists: i64 = sqlx::query_scalar(
        r#"SELECT EXISTS(
               SELECT 1
               FROM conversation_inputs
               WHERE conversation_id = ? AND status = 'queued'
           )"#,
    )
    .bind(conversation_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(exists != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_turns_are_todo() {
        assert_eq!(
            derive_workbench_status(TurnPhase::None, false, false),
            SessionStatus::Todo
        );
    }

    #[test]
    fn in_flight_turns_are_in_progress() {
        assert_eq!(
            derive_workbench_status(TurnPhase::InFlight, false, false),
            SessionStatus::InProgress
        );
        assert_eq!(
            derive_workbench_status(TurnPhase::InFlight, true, true),
            SessionStatus::InProgress
        );
    }

    #[test]
    fn unviewed_completed_turns_are_in_review() {
        assert_eq!(
            derive_workbench_status(TurnPhase::Completed, false, false),
            SessionStatus::InReview
        );
    }

    #[test]
    fn viewed_completed_turns_are_done() {
        assert_eq!(
            derive_workbench_status(TurnPhase::Completed, true, false),
            SessionStatus::Done
        );
    }

    #[test]
    fn user_cancelled_turns_are_done() {
        assert_eq!(
            derive_workbench_status(TurnPhase::Cancelled, false, false),
            SessionStatus::Done
        );
        assert_eq!(
            derive_workbench_status(TurnPhase::Cancelled, false, true),
            SessionStatus::Done
        );
    }

    #[test]
    fn failed_or_interrupted_turns_wait_for_review() {
        assert_eq!(
            derive_workbench_status(TurnPhase::Failed, false, false),
            SessionStatus::InReview
        );
        assert_eq!(
            derive_workbench_status(TurnPhase::Interrupted, false, false),
            SessionStatus::InReview
        );
    }

    #[test]
    fn viewed_failed_or_interrupted_turns_are_done() {
        assert_eq!(
            derive_workbench_status(TurnPhase::Failed, true, false),
            SessionStatus::Done
        );
        assert_eq!(
            derive_workbench_status(TurnPhase::Interrupted, true, false),
            SessionStatus::Done
        );
    }

    #[test]
    fn queued_follow_up_stays_in_review_until_viewed_then_runs() {
        assert_eq!(
            derive_workbench_status(TurnPhase::Completed, false, true),
            SessionStatus::InReview
        );
        assert_eq!(
            derive_workbench_status(TurnPhase::Completed, true, true),
            SessionStatus::InProgress
        );
        assert_eq!(
            derive_workbench_status(TurnPhase::Failed, true, true),
            SessionStatus::InProgress
        );
    }
}
