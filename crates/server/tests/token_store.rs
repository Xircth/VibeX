use std::str::FromStr;

use application::{ApplicationCore, SqliteConversationRepository};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use server::{ServerConfig, ServerRuntime, ServerToken, SqliteTokenHashStore};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tower::ServiceExt;

#[test]
fn caller_supplied_token_must_meet_the_minimum_strength_boundary() {
    assert!(ServerToken::try_new("too-short").is_err());
    assert!(ServerToken::try_new("a".repeat(64)).is_err());
    assert!(ServerToken::try_new("caller-supplied-token-with-at-least-32-bytes").is_ok());
}

#[test]
fn token_debug_output_is_always_redacted() {
    let plaintext = "debug-secret-with-at-least-32-bytes";
    let rendered = format!("{:?}", ServerToken::new(plaintext));
    assert!(!rendered.contains(plaintext));
    assert_eq!(rendered, "ServerToken([REDACTED])");
}

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

#[tokio::test]
async fn bearer_token_in_a_url_is_never_accepted() {
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
    let plaintext = "url-secret-with-at-least-32-bytes";
    let app = ServerRuntime::new(
        ServerConfig::default(),
        ServerToken::new(plaintext),
        ApplicationCore::new(SqliteConversationRepository::new(pool)),
    )
    .router();

    for uri in [
        format!("/api/v1/capabilities?token={plaintext}"),
        format!("/api/v1/capabilities?access_token={plaintext}"),
    ] {
        let response = app
            .clone()
            .oneshot(Request::get(uri).body(Body::empty()).expect("request"))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
