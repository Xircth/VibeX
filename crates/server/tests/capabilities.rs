use std::str::FromStr;

use application::{ApplicationCore, SqliteConversationRepository};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use remote_protocol::{ErrorCode, ErrorEnvelope, ServerCapabilities};
use server::{ServerConfig, ServerRuntime, ServerToken};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tower::ServiceExt;

async fn test_runtime(token: &str) -> ServerRuntime<SqliteConversationRepository> {
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
    let core = ApplicationCore::new(SqliteConversationRepository::new(pool));
    ServerRuntime::new(ServerConfig::default(), ServerToken::new(token), core)
}

#[tokio::test]
async fn capabilities_require_auth() {
    let runtime = test_runtime("correct horse battery staple").await;
    let app = runtime.router();

    let missing = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/capabilities")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
    let error: ErrorEnvelope = serde_json::from_slice(
        &to_bytes(missing.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("stable error envelope");
    assert_eq!(error.code, ErrorCode::Unauthorized);

    let wrong = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/capabilities")
                .header("authorization", "Bearer definitely-wrong")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);

    let authorized = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/capabilities")
                .header("authorization", "Bearer correct horse battery staple")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(authorized.status(), StatusCode::OK);
    let capabilities: ServerCapabilities = serde_json::from_slice(
        &to_bytes(authorized.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("capabilities");
    assert_eq!(
        capabilities.protocol_version,
        remote_protocol::PROTOCOL_VERSION
    );
    assert_eq!(capabilities.server_version, env!("CARGO_PKG_VERSION"));
    assert!(!capabilities.minimum_client_version.is_empty());
}

#[tokio::test]
async fn incompatible_protocol_major_uses_the_stable_error_envelope() {
    let app = test_runtime("correct horse battery staple").await.router();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/capabilities")
                .header("authorization", "Bearer correct horse battery staple")
                .header("x-vibex-protocol-version", "2.0")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::CONFLICT);
    let error: ErrorEnvelope = serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body"),
    )
    .expect("stable error envelope");
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(
        error.details.expect("compatibility details")["supported_protocol"],
        remote_protocol::PROTOCOL_VERSION
    );
}
