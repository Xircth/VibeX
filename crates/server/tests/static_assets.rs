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
async fn missing_static_root_serves_a_host_listen_page() {
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
    let app = ServerRuntime::new(
        ServerConfig::default(),
        ServerToken::new("static-test-token-with-at-least-32-bytes"),
        ApplicationCore::new(SqliteConversationRepository::new(pool)),
    )
    .router();

    let response = app
        .oneshot(
            Request::builder()
                .uri("/")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let text = String::from_utf8(body.to_vec()).expect("html");
    assert!(text.contains("VibeX Host"));
    assert!(text.contains("配对邀请"));
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

#[cfg(unix)]
#[tokio::test]
async fn static_assets_never_follow_a_symlink_outside_the_root() {
    use std::os::unix::fs::symlink;

    let root = TempDir::new().expect("static root");
    let outside = TempDir::new().expect("outside root");
    std::fs::write(root.path().join("index.html"), "<main>safe shell</main>").expect("index");
    std::fs::write(outside.path().join("secret.txt"), "must-not-leak").expect("secret");
    symlink(
        outside.path().join("secret.txt"),
        root.path().join("secret.txt"),
    )
    .expect("symlink");

    let response = runtime(root.path())
        .await
        .router()
        .oneshot(
            Request::get("/secret.txt")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    assert_ne!(body, "must-not-leak");
}
