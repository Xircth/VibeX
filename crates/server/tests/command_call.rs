use std::str::FromStr;

use application::{ApplicationCore, SqliteConversationRepository};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use db::models::conversation::{ConversationRecord, CreateConversationRecord};
use remote_protocol::{CommandResponse, OperationId};
use server::{ServerConfig, ServerRuntime, ServerToken};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn authenticated_call_uses_the_application_command_registry() {
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
        .expect("focused fixture");
    let workspace_id = Uuid::new_v4();
    ConversationRecord::create(
        &pool,
        Uuid::new_v4(),
        CreateConversationRecord {
            workspace_id,
            task_id: None,
            title: Some("From Application Core"),
            initial_prompt: None,
            status: None,
            executor: Some("agent"),
        },
    )
    .await
    .expect("conversation");

    let operation_id = OperationId::new();
    let core = ApplicationCore::new(SqliteConversationRepository::new(pool));
    let app = ServerRuntime::new(
        ServerConfig::default(),
        ServerToken::new("call-secret"),
        core,
    )
    .router();
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/call/conversation_list")
                .header("authorization", "Bearer call-secret")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "operation_id": operation_id,
                        "args": { "workspaceId": workspace_id }
                    })
                    .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let response: CommandResponse<serde_json::Value> = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("command response");
    assert_eq!(response.operation_id, operation_id);
    assert_eq!(response.data[0]["title"], "From Application Core");
}
