use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct ConversationImportRecord {
    pub id: Uuid,
    pub source: String,
    pub source_agent: Option<String>,
    pub external_session_id: Option<String>,
    pub bundle_version: Option<String>,
    pub raw_source_path: Option<String>,
    pub imported_conversation_id: Option<Uuid>,
    pub raw_json: String,
    pub imported_at: DateTime<Utc>,
}

pub struct InsertConversationImport<'a> {
    pub id: Uuid,
    pub source: &'a str,
    pub source_agent: Option<&'a str>,
    pub external_session_id: Option<&'a str>,
    pub bundle_version: Option<&'a str>,
    pub raw_source_path: Option<&'a str>,
    pub imported_conversation_id: Option<Uuid>,
    pub raw_json: &'a str,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct ConversationExportRecord {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub bundle_version: String,
    pub destination_path: String,
    pub manifest_json: String,
    pub exported_at: DateTime<Utc>,
}

pub struct InsertConversationExport<'a> {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub bundle_version: &'a str,
    pub destination_path: &'a str,
    pub manifest_json: &'a str,
}

const IMPORT_COLUMNS: &str = r#"id,
    source,
    source_agent,
    external_session_id,
    bundle_version,
    raw_source_path,
    imported_conversation_id,
    raw_json,
    imported_at"#;

const EXPORT_COLUMNS: &str = r#"id,
    conversation_id,
    bundle_version,
    destination_path,
    manifest_json,
    exported_at"#;

impl ConversationImportRecord {
    pub async fn insert(
        pool: &SqlitePool,
        input: InsertConversationImport<'_>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO conversation_imports (
                   id, source, source_agent, external_session_id, bundle_version,
                   raw_source_path, imported_conversation_id, raw_json
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING {IMPORT_COLUMNS}"#
        ))
        .bind(input.id)
        .bind(input.source)
        .bind(input.source_agent)
        .bind(input.external_session_id)
        .bind(input.bundle_version)
        .bind(input.raw_source_path)
        .bind(input.imported_conversation_id)
        .bind(input.raw_json)
        .fetch_one(pool)
        .await
    }

    pub async fn list(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {IMPORT_COLUMNS}
               FROM conversation_imports
               ORDER BY imported_at DESC"#
        ))
        .fetch_all(pool)
        .await
    }
}

impl ConversationExportRecord {
    pub async fn insert(
        pool: &SqlitePool,
        input: InsertConversationExport<'_>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"INSERT INTO conversation_exports (
                   id, conversation_id, bundle_version, destination_path,
                   manifest_json
               )
               VALUES (?, ?, ?, ?, ?)
               RETURNING {EXPORT_COLUMNS}"#
        ))
        .bind(input.id)
        .bind(input.conversation_id)
        .bind(input.bundle_version)
        .bind(input.destination_path)
        .bind(input.manifest_json)
        .fetch_one(pool)
        .await
    }

    pub async fn list_for_conversation(
        pool: &SqlitePool,
        conversation_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            r#"SELECT {EXPORT_COLUMNS}
               FROM conversation_exports
               WHERE conversation_id = ?
               ORDER BY exported_at DESC"#
        ))
        .bind(conversation_id)
        .fetch_all(pool)
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;
    use crate::models::conversation::{ConversationRecord, CreateConversationRecord};

    async fn setup_pool() -> SqlitePool {
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
            .expect("disable foreign keys");
        pool
    }

    #[tokio::test]
    async fn conversation_import_export_records_round_trip() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: Some("Bundle source"),
                initial_prompt: None,
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");

        let import = ConversationImportRecord::insert(
            &pool,
            InsertConversationImport {
                id: Uuid::new_v4(),
                source: "vibex_bundle",
                source_agent: None,
                external_session_id: None,
                bundle_version: Some("1"),
                raw_source_path: Some("C:/tmp/bundle"),
                imported_conversation_id: Some(conversation_id),
                raw_json: r#"{"manifest":true}"#,
            },
        )
        .await
        .expect("insert import");
        assert_eq!(import.imported_conversation_id, Some(conversation_id));

        let export = ConversationExportRecord::insert(
            &pool,
            InsertConversationExport {
                id: Uuid::new_v4(),
                conversation_id,
                bundle_version: "1",
                destination_path: "C:/tmp/export.vibex",
                manifest_json: r#"{"version":"1"}"#,
            },
        )
        .await
        .expect("insert export");
        assert_eq!(export.conversation_id, conversation_id);

        assert_eq!(
            ConversationImportRecord::list(&pool)
                .await
                .expect("imports")
                .len(),
            1
        );
        assert_eq!(
            ConversationExportRecord::list_for_conversation(&pool, conversation_id)
                .await
                .expect("exports")
                .len(),
            1
        );
    }
}
