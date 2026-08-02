use std::str::FromStr;

use application::{ApplicationCore, ListConversations, Principal, SqliteConversationRepository};
use db::models::conversation::{ConversationRecord, CreateConversationRecord};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use uuid::Uuid;

#[tokio::test]
async fn list_conversations_without_tauri() {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite options")
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("memory database");
    sqlx::migrate!("../db/migrations")
        .run(&pool)
        .await
        .expect("migrations");
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .expect("disable foreign keys for focused fixture");

    let workspace_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id,
            task_id: None,
            title: Some("Transport-neutral"),
            initial_prompt: None,
            status: None,
            executor: Some("agent"),
        },
    )
    .await
    .expect("seed conversation");

    let core = ApplicationCore::new(SqliteConversationRepository::new(pool));
    let conversations = core
        .list_conversations(
            &Principal::local_desktop(),
            ListConversations { workspace_id },
        )
        .await
        .expect("list conversations");

    assert_eq!(conversations.len(), 1);
    assert_eq!(conversations[0].id, conversation_id);
    assert_eq!(conversations[0].title.as_deref(), Some("Transport-neutral"));
}
