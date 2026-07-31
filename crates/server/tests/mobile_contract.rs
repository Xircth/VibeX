use std::str::FromStr;

use application::{ApplicationCore, SqliteConversationRepository};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use db::models::conversation_event::{AppendConversationEvent, ConversationEventRecord};
use remote_protocol::{NotificationOutcome, OfflineConversationCache, TerminalNotificationSummary};
use server::{ServerConfig, ServerRuntime, ServerToken};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tower::ServiceExt;
use uuid::Uuid;

const TOKEN: &str = "mobile-contract-token-with-at-least-32-bytes";

async fn fixture() -> (axum::Router, sqlx::SqlitePool, Uuid) {
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
    let conversation_id = Uuid::new_v4();
    let core = ApplicationCore::new(SqliteConversationRepository::new(pool.clone()));
    let app = ServerRuntime::new(ServerConfig::default(), ServerToken::new(TOKEN), core).router();
    (app, pool, conversation_id)
}

async fn append(pool: &sqlx::SqlitePool, conversation_id: Uuid, kind: &str, body: &str) {
    ConversationEventRecord::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: None,
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "runtime",
            event_kind: kind,
            normalized_json: body,
            raw_json: None,
            idempotency_key: None,
        },
    )
    .await
    .expect("append event");
}

#[tokio::test]
async fn advertised_offline_and_notification_capabilities_have_public_http_seams() {
    let (app, pool, conversation_id) = fixture().await;
    append(
        &pool,
        conversation_id,
        "future_event",
        r#"{"future_field":"kept"}"#,
    )
    .await;
    append(
        &pool,
        conversation_id,
        "turn_completed",
        r#"{"private":"Bearer release-secret"}"#,
    )
    .await;

    let offline = app
        .clone()
        .oneshot(
            Request::get(format!(
                "/api/v1/conversations/{conversation_id}/offline?after_sequence=0"
            ))
            .header("authorization", format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .expect("offline request"),
        )
        .await
        .expect("offline response");
    assert_eq!(offline.status(), StatusCode::OK);
    let offline: OfflineConversationCache = json_body(offline).await;
    assert!(offline.read_only);
    assert_eq!(offline.events[0].kind, "future_event");

    let notification = app
        .oneshot(
            Request::get(format!(
                "/api/v1/conversations/{conversation_id}/notification-summary"
            ))
            .header("authorization", format!("Bearer {TOKEN}"))
            .body(Body::empty())
            .expect("notification request"),
        )
        .await
        .expect("notification response");
    assert_eq!(notification.status(), StatusCode::OK);
    let bytes = to_bytes(notification.into_body(), usize::MAX)
        .await
        .expect("notification body");
    let summary: TerminalNotificationSummary =
        serde_json::from_slice(&bytes).expect("notification JSON");
    assert_eq!(summary.outcome, NotificationOutcome::Completed);
    let encoded = String::from_utf8(bytes.to_vec()).expect("UTF-8 notification");
    assert!(!encoded.contains("release-secret"));
}

async fn json_body<T: serde::de::DeserializeOwned>(response: axum::response::Response) -> T {
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body");
    serde_json::from_slice(&bytes).expect("JSON response")
}
