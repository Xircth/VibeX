use std::str::FromStr;

use application::{ApplicationCore, SqliteConversationRepository};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use server::{ServerConfig, ServerRuntime, ServerToken, SqliteTokenHashStore};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tower::ServiceExt;

#[tokio::test]
async fn token_store_persists_only_a_hash() {
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

    let plaintext = "this-token-must-never-be-persisted";
    let provisioned = SqliteTokenHashStore::new(pool.clone())
        .provision(Some(ServerToken::new(plaintext)))
        .await
        .expect("provision token");
    let stored: Vec<u8> =
        sqlx::query_scalar("SELECT token_hash FROM server_access_tokens WHERE revoked_at IS NULL")
            .fetch_one(&pool)
            .await
            .expect("stored hash");
    assert_eq!(stored.len(), 32);
    assert_ne!(stored, plaintext.as_bytes());

    let core = ApplicationCore::new(SqliteConversationRepository::new(pool));
    let app =
        ServerRuntime::from_credentials(ServerConfig::default(), provisioned.credentials, core)
            .router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/capabilities")
                .header("authorization", format!("Bearer {plaintext}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
}
