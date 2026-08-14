use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqliteConnection, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationRelationRecord {
    pub id: Uuid,
    pub parent_conversation_id: Uuid,
    pub child_conversation_id: Uuid,
    pub kind: String,
    pub visibility: String,
    pub metadata_json: String,
    pub created_at: DateTime<Utc>,
}

const COLUMNS: &str = r#"id, parent_conversation_id, child_conversation_id,
    kind, visibility, metadata_json, created_at"#;

impl ConversationRelationRecord {
    pub async fn create_on_connection(
        conn: &mut SqliteConnection,
        id: Uuid,
        parent_conversation_id: Uuid,
        child_conversation_id: Uuid,
        kind: &str,
        visibility: &str,
        metadata_json: &str,
    ) -> Result<Self, sqlx::Error> {
        if parent_conversation_id == child_conversation_id
            || Self::is_descendant_on_connection(
                conn,
                child_conversation_id,
                parent_conversation_id,
            )
            .await?
        {
            return Err(sqlx::Error::Protocol(
                "conversation relation would create a cycle".to_string(),
            ));
        }
        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO conversation_relations (
                   id, parent_conversation_id, child_conversation_id,
                   kind, visibility, metadata_json
               ) VALUES (?, ?, ?, ?, ?, ?)
               RETURNING {COLUMNS}"#
        ))
        .bind(id)
        .bind(parent_conversation_id)
        .bind(child_conversation_id)
        .bind(kind)
        .bind(visibility)
        .bind(metadata_json)
        .fetch_one(&mut *conn)
        .await
    }

    async fn is_descendant_on_connection(
        conn: &mut SqliteConnection,
        ancestor: Uuid,
        possible_descendant: Uuid,
    ) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar(
            r#"WITH RECURSIVE descendants(id) AS (
                   SELECT child_conversation_id
                   FROM conversation_relations
                   WHERE parent_conversation_id = ?
                   UNION
                   SELECT relations.child_conversation_id
                   FROM conversation_relations relations
                   JOIN descendants ON relations.parent_conversation_id = descendants.id
               )
               SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?)"#,
        )
        .bind(ancestor)
        .bind(possible_descendant)
        .fetch_one(&mut *conn)
        .await
    }

    pub async fn list_children(
        pool: &SqlitePool,
        parent_conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {COLUMNS} FROM conversation_relations
               WHERE parent_conversation_id = ?
               ORDER BY created_at, id"#
        ))
        .bind(parent_conversation_id)
        .fetch_all(pool)
        .await
    }

    pub async fn find(
        pool: &SqlitePool,
        parent_conversation_id: Uuid,
        child_conversation_id: Uuid,
        kind: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {COLUMNS} FROM conversation_relations
               WHERE parent_conversation_id = ? AND child_conversation_id = ? AND kind = ?"#
        ))
        .bind(parent_conversation_id)
        .bind(child_conversation_id)
        .bind(kind)
        .fetch_optional(pool)
        .await
    }

    pub async fn list_parents(
        pool: &SqlitePool,
        child_conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {COLUMNS} FROM conversation_relations
               WHERE child_conversation_id = ?
               ORDER BY created_at, id"#
        ))
        .bind(child_conversation_id)
        .fetch_all(pool)
        .await
    }

    pub async fn is_descendant(
        pool: &SqlitePool,
        ancestor: Uuid,
        possible_descendant: Uuid,
    ) -> Result<bool, sqlx::Error> {
        let mut conn = pool.acquire().await?;
        Self::is_descendant_on_connection(&mut conn, ancestor, possible_descendant).await
    }
}
