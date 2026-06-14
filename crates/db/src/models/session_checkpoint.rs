use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

/// One repo's worktree HEAD recorded before an agent prompt was sent. All repos
/// of a single prompt share the same `ordinal` (the Nth prompt of the session).
#[derive(Debug, Clone, FromRow)]
pub struct SessionCheckpoint {
    pub id: Uuid,
    pub session_id: Uuid,
    pub ordinal: i64,
    pub repo_id: Uuid,
    pub before_head_commit: String,
}

impl SessionCheckpoint {
    /// The ordinal to use for the next prompt's checkpoint (max + 1, or 0).
    pub async fn next_ordinal(pool: &SqlitePool, session_id: Uuid) -> Result<i64, sqlx::Error> {
        let max: Option<i64> =
            sqlx::query_scalar("SELECT MAX(ordinal) FROM session_checkpoints WHERE session_id = ?")
                .bind(session_id)
                .fetch_one(pool)
                .await?;
        Ok(max.map(|value| value + 1).unwrap_or(0))
    }

    pub async fn insert(
        pool: &SqlitePool,
        id: Uuid,
        session_id: Uuid,
        ordinal: i64,
        repo_id: Uuid,
        before_head_commit: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"INSERT INTO session_checkpoints
               (id, session_id, ordinal, repo_id, before_head_commit)
               VALUES (?, ?, ?, ?, ?)"#,
        )
        .bind(id)
        .bind(session_id)
        .bind(ordinal)
        .bind(repo_id)
        .bind(before_head_commit)
        .execute(pool)
        .await?;
        Ok(())
    }

    /// All repo checkpoints recorded at a given ordinal for a session.
    pub async fn find_by_ordinal(
        pool: &SqlitePool,
        session_id: Uuid,
        ordinal: i64,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            r#"SELECT id, session_id, ordinal, repo_id, before_head_commit
               FROM session_checkpoints
               WHERE session_id = ? AND ordinal = ?"#,
        )
        .bind(session_id)
        .bind(ordinal)
        .fetch_all(pool)
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    async fn migrated_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    #[tokio::test]
    async fn checkpoints_round_trip_by_ordinal() {
        let pool = migrated_pool().await;
        let session = Uuid::new_v4();
        let repo = Uuid::new_v4();

        assert_eq!(
            SessionCheckpoint::next_ordinal(&pool, session)
                .await
                .unwrap(),
            0
        );
        SessionCheckpoint::insert(&pool, Uuid::new_v4(), session, 0, repo, "abc123")
            .await
            .unwrap();
        assert_eq!(
            SessionCheckpoint::next_ordinal(&pool, session)
                .await
                .unwrap(),
            1
        );
        SessionCheckpoint::insert(&pool, Uuid::new_v4(), session, 1, repo, "def456")
            .await
            .unwrap();

        let at_zero = SessionCheckpoint::find_by_ordinal(&pool, session, 0)
            .await
            .unwrap();
        assert_eq!(at_zero.len(), 1);
        assert_eq!(at_zero[0].before_head_commit, "abc123");
    }
}
