use std::str::FromStr;

use application::{ApplicationCore, SqliteConversationRepository};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use server::{ServerConfig, ServerRuntime, ServerToken};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tempfile::TempDir;
use tower::ServiceExt;

async fn runtime(root: &std::path::Path) -> ServerRuntime<SqliteConversationRepository> {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::from_str("sqlite::memory:")
                .expect("sqlite options")
                .foreign_keys(false),
        )
        .await
        .expect("memory database");
    sqlx::migrate!("../db/migrations")
        .run(&pool)
        .await
        .expect("migrations");
    ServerRuntime::new(
        ServerConfig::default().with_static_root(root),
        ServerToken::new("static-test-token-with-at-least-32-bytes"),
        ApplicationCore::new(SqliteConversationRepository::new(pool)),
    )
}

#[tokio::test]
async fn production_assets_and_spa_routes_share_the_static_root() {
    let root = TempDir::new().expect("static root");
    std::fs::write(root.path().join("index.html"), "<main>VibeX</main>").expect("index");
    std::fs::write(root.path().join("app.js"), "export const ready = true;").expect("asset");
    let app = runtime(root.path()).await.router();

    for (path, expected_type, expected_body) in [
        ("/", "text/html; charset=utf-8", "<main>VibeX</main>"),
        (
            "/app.js",
            "text/javascript; charset=utf-8",
            "export const ready = true;",
        ),
        (
            "/settings/automations",
            "text/html; charset=utf-8",
            "<main>VibeX</main>",
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).expect("type"),
            expected_type
        );
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
            expected_body
        );
    }

    let unknown_api = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/not-registered")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(unknown_api.status(), StatusCode::NOT_FOUND);
}
