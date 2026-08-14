use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqliteConnection, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationInputRecord {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub operation_id: Uuid,
    pub payload_digest: String,
    pub payload_json: String,
    pub principal_json: String,
    pub revision: i64,
    pub sort_key: i64,
    pub status: String,
    pub claim_token: Option<Uuid>,
    pub claim_deadline: Option<DateTime<Utc>>,
    pub turn_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CreateConversationInput<'a> {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub operation_id: Uuid,
    pub payload_digest: &'a str,
    pub payload_json: &'a str,
    pub principal_json: &'a str,
    pub sort_key: i64,
}

const INPUT_COLUMNS: &str = r#"id,
    conversation_id,
    operation_id,
    payload_digest,
    payload_json,
    principal_json,
    revision,
    sort_key,
    status,
    claim_token,
    claim_deadline,
    turn_id,
    created_at,
    updated_at"#;

impl ConversationInputRecord {
    pub async fn create(
        pool: &SqlitePool,
        input: CreateConversationInput<'_>,
    ) -> Result<Self, sqlx::Error> {
        let mut conn = pool.acquire().await?;
        Self::create_on_connection(&mut conn, input).await
    }

    pub async fn create_on_connection(
        conn: &mut SqliteConnection,
        input: CreateConversationInput<'_>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO conversation_inputs (
                   id, conversation_id, operation_id, payload_digest,
                   payload_json, principal_json, sort_key
               )
               VALUES (?, ?, ?, ?, ?, ?, ?)
               RETURNING {INPUT_COLUMNS}"#
        ))
        .bind(input.id)
        .bind(input.conversation_id)
        .bind(input.operation_id)
        .bind(input.payload_digest)
        .bind(input.payload_json)
        .bind(input.principal_json)
        .bind(input.sort_key)
        .fetch_one(conn)
        .await
    }

    pub async fn update_payload_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        input_id: Uuid,
        revision: i64,
        payload_digest: &str,
        payload_json: &str,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"UPDATE conversation_inputs
               SET payload_digest = ?, payload_json = ?, revision = ?,
                   updated_at = datetime('now', 'subsec')
               WHERE id = ? AND conversation_id = ?
                 AND status = 'queued' AND revision = ?"#,
        )
        .bind(payload_digest)
        .bind(payload_json)
        .bind(revision)
        .bind(input_id)
        .bind(conversation_id)
        .bind(revision - 1)
        .execute(conn)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn reorder_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        input_id: Uuid,
        revision: i64,
        sort_key: i64,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"UPDATE conversation_inputs
               SET sort_key = ?, revision = ?, updated_at = datetime('now', 'subsec')
               WHERE id = ? AND conversation_id = ?
                 AND status = 'queued' AND revision = ?"#,
        )
        .bind(sort_key)
        .bind(revision)
        .bind(input_id)
        .bind(conversation_id)
        .bind(revision - 1)
        .execute(conn)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn claim_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        input_id: Uuid,
        claim_token: Uuid,
        claim_deadline: DateTime<Utc>,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"UPDATE conversation_inputs
               SET status = 'claimed', claim_token = ?, claim_deadline = ?,
                   updated_at = datetime('now', 'subsec')
               WHERE id = ? AND conversation_id = ? AND status = 'queued'"#,
        )
        .bind(claim_token)
        .bind(claim_deadline)
        .bind(input_id)
        .bind(conversation_id)
        .execute(conn)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn release_claim_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        input_id: Uuid,
        claim_token: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"UPDATE conversation_inputs
               SET status = 'queued', claim_token = NULL, claim_deadline = NULL,
                   updated_at = datetime('now', 'subsec')
               WHERE id = ? AND conversation_id = ?
                 AND status = 'claimed' AND claim_token = ?
                 AND turn_id IS NULL"#,
        )
        .bind(input_id)
        .bind(conversation_id)
        .bind(claim_token)
        .execute(conn)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn dispatch_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        input_id: Uuid,
        claim_token: Uuid,
        turn_id: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"UPDATE conversation_inputs
               SET status = 'dispatched', turn_id = ?, claim_deadline = NULL,
                   updated_at = datetime('now', 'subsec')
               WHERE id = ? AND conversation_id = ?
                 AND status = 'claimed' AND claim_token = ?"#,
        )
        .bind(turn_id)
        .bind(input_id)
        .bind(conversation_id)
        .bind(claim_token)
        .execute(conn)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn cancel_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
        input_id: Uuid,
        revision: i64,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            r#"UPDATE conversation_inputs
               SET status = 'cancelled', revision = ?,
                   updated_at = datetime('now', 'subsec')
               WHERE id = ? AND conversation_id = ?
                 AND status = 'queued' AND revision = ?"#,
        )
        .bind(revision)
        .bind(input_id)
        .bind(conversation_id)
        .bind(revision - 1)
        .execute(conn)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn find_by_id(
        pool: &SqlitePool,
        input_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {INPUT_COLUMNS} FROM conversation_inputs WHERE id = ?"
        ))
        .bind(input_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_id_for_conversation(
        pool: &SqlitePool,
        conversation_id: Uuid,
        input_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {INPUT_COLUMNS}
               FROM conversation_inputs
               WHERE conversation_id = ? AND id = ?"#
        ))
        .bind(conversation_id)
        .bind(input_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_operation(
        pool: &SqlitePool,
        conversation_id: Uuid,
        operation_id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {INPUT_COLUMNS}
               FROM conversation_inputs
               WHERE conversation_id = ? AND operation_id = ?"#
        ))
        .bind(conversation_id)
        .bind(operation_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn list_for_conversation(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {INPUT_COLUMNS}
               FROM conversation_inputs
               WHERE conversation_id = ?
               ORDER BY sort_key ASC, created_at ASC, id ASC"#
        ))
        .bind(conversation_id)
        .fetch_all(pool)
        .await
    }

    pub async fn queued_conversation_ids(pool: &SqlitePool) -> Result<Vec<Uuid>, sqlx::Error> {
        sqlx::query_scalar(
            r#"SELECT DISTINCT conversation_id
               FROM conversation_inputs
               WHERE status = 'queued'
               ORDER BY conversation_id"#,
        )
        .fetch_all(pool)
        .await
    }

    pub async fn next_sort_key(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            r#"SELECT COALESCE(MAX(sort_key), 0) + 1024
               FROM conversation_inputs
               WHERE conversation_id = ?"#,
        )
        .bind(conversation_id)
        .fetch_one(pool)
        .await
    }

    pub async fn next_sort_key_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
    ) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            r#"SELECT COALESCE(MAX(sort_key), 0) + 1024
               FROM conversation_inputs
               WHERE conversation_id = ?"#,
        )
        .bind(conversation_id)
        .fetch_one(conn)
        .await
    }

    pub async fn first_queued_id_on_connection(
        conn: &mut SqliteConnection,
        conversation_id: Uuid,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        sqlx::query_scalar(
            r#"SELECT id
               FROM conversation_inputs
               WHERE conversation_id = ? AND status = 'queued'
               ORDER BY sort_key ASC, created_at ASC, id ASC
               LIMIT 1"#,
        )
        .bind(conversation_id)
        .fetch_optional(conn)
        .await
    }

    pub async fn claim_next(
        pool: &SqlitePool,
        conversation_id: Uuid,
        claim_token: Uuid,
        claim_deadline: DateTime<Utc>,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"UPDATE conversation_inputs
               SET status = 'claimed', claim_token = ?, claim_deadline = ?,
                   updated_at = datetime('now', 'subsec')
               WHERE id = (
                   SELECT id
                   FROM conversation_inputs
                   WHERE conversation_id = ? AND status = 'queued'
                   ORDER BY sort_key ASC, created_at ASC, id ASC
                   LIMIT 1
               )
               AND status = 'queued'
               RETURNING {INPUT_COLUMNS}"#
        ))
        .bind(claim_token)
        .bind(claim_deadline)
        .bind(conversation_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn claim_by_id(
        pool: &SqlitePool,
        input_id: Uuid,
        claim_token: Uuid,
        claim_deadline: DateTime<Utc>,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"UPDATE conversation_inputs
               SET status = 'claimed', claim_token = ?, claim_deadline = ?,
                   updated_at = datetime('now', 'subsec')
               WHERE id = ? AND status = 'queued'
               RETURNING {INPUT_COLUMNS}"#
        ))
        .bind(claim_token)
        .bind(claim_deadline)
        .bind(input_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn list_stale_unsubmitted_claims(
        pool: &SqlitePool,
        now: DateTime<Utc>,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {INPUT_COLUMNS}
               FROM conversation_inputs
               WHERE status = 'claimed' AND turn_id IS NULL
                 AND claim_deadline IS NOT NULL AND claim_deadline <= ?
               ORDER BY claim_deadline ASC, created_at ASC"#
        ))
        .bind(now)
        .fetch_all(pool)
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use chrono::{Duration, Utc};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    use super::{ConversationInputRecord, CreateConversationInput};
    use crate::models::conversation::{ConversationRecord, CreateConversationRecord};

    async fn setup_pool() -> sqlx::SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys for focused model tests");
        pool
    }

    async fn conversation(pool: &sqlx::SqlitePool) -> Uuid {
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");
        conversation_id
    }

    #[tokio::test]
    async fn claim_next_is_ordered_and_exclusive() {
        let pool = setup_pool().await;
        let conversation_id = conversation(&pool).await;
        let later = Uuid::new_v4();
        let earlier = Uuid::new_v4();
        for (id, sort_key) in [(later, 20), (earlier, 10)] {
            ConversationInputRecord::create(
                &pool,
                CreateConversationInput {
                    id,
                    conversation_id,
                    operation_id: Uuid::new_v4(),
                    payload_digest: &format!("digest-{id}"),
                    payload_json: r#"{"text":"hello"}"#,
                    principal_json: r#"{"kind":"local"}"#,
                    sort_key,
                },
            )
            .await
            .expect("create input");
        }

        let claim_token = Uuid::new_v4();
        let claimed = ConversationInputRecord::claim_next(
            &pool,
            conversation_id,
            claim_token,
            Utc::now() + Duration::seconds(30),
        )
        .await
        .expect("claim query")
        .expect("queued input");
        assert_eq!(claimed.id, earlier);
        assert_eq!(claimed.status, "claimed");

        let competing = ConversationInputRecord::claim_by_id(
            &pool,
            earlier,
            Uuid::new_v4(),
            Utc::now() + Duration::seconds(30),
        )
        .await
        .expect("competing claim query");
        assert!(competing.is_none());
    }

    #[tokio::test]
    async fn operation_identity_distinguishes_retry_from_conflict() {
        let pool = setup_pool().await;
        let conversation_id = conversation(&pool).await;
        let operation_id = Uuid::new_v4();
        let created = ConversationInputRecord::create(
            &pool,
            CreateConversationInput {
                id: Uuid::new_v4(),
                conversation_id,
                operation_id,
                payload_digest: "same",
                payload_json: r#"{"text":"hello"}"#,
                principal_json: r#"{"kind":"local"}"#,
                sort_key: 10,
            },
        )
        .await
        .expect("create input");

        let retry =
            ConversationInputRecord::find_by_operation(&pool, conversation_id, operation_id)
                .await
                .expect("find retry")
                .expect("existing input");
        assert_eq!(retry.id, created.id);
        assert_eq!(retry.payload_digest, "same");
    }

    #[tokio::test]
    async fn stale_unsubmitted_claim_is_reported_for_event_sourced_recovery() {
        let pool = setup_pool().await;
        let conversation_id = conversation(&pool).await;
        let input_id = Uuid::new_v4();
        ConversationInputRecord::create(
            &pool,
            CreateConversationInput {
                id: input_id,
                conversation_id,
                operation_id: Uuid::new_v4(),
                payload_digest: "digest",
                payload_json: r#"{"text":"hello"}"#,
                principal_json: r#"{"kind":"local"}"#,
                sort_key: 10,
            },
        )
        .await
        .expect("create input");
        ConversationInputRecord::claim_by_id(
            &pool,
            input_id,
            Uuid::new_v4(),
            Utc::now() - Duration::seconds(1),
        )
        .await
        .expect("claim input")
        .expect("claimed input");

        let stale = ConversationInputRecord::list_stale_unsubmitted_claims(&pool, Utc::now())
            .await
            .expect("list stale claims");
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].id, input_id);
        let record = ConversationInputRecord::find_by_id(&pool, input_id)
            .await
            .expect("load input")
            .expect("input exists");
        assert_eq!(record.status, "claimed");
        assert!(record.claim_token.is_some());
    }
}
