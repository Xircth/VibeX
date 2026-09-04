use std::{
    str::FromStr,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use application::{ApplicationCore, SqliteConversationRepository};
use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    extract::Request,
    http::{Request as HttpRequest, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures::{StreamExt, stream};
use server::{ServerConfig, ServerRuntime, ServerToken};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tower::ServiceExt;
use uuid::Uuid;

const CAPABILITY: &str = "preview-capability-with-entropy";

async fn runtime() -> ServerRuntime<SqliteConversationRepository> {
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
    ServerRuntime::new(
        ServerConfig::default(),
        ServerToken::new("main-server-token-with-at-least-32-bytes"),
        ApplicationCore::new(SqliteConversationRepository::new(pool)),
    )
}

fn future_expiry() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_millis() as u64
        + 60_000
}

async fn request_get(app: Router, uri: &str) -> Response {
    app.oneshot(
        HttpRequest::builder()
            .uri(uri)
            .body(Body::empty())
            .expect("request"),
    )
    .await
    .expect("response")
}

#[tokio::test]
async fn preview_proxy_rejects_missing_wrong_expired_and_unknown_capabilities() {
    let runtime = runtime().await;
    let registry = runtime.preview_proxy_registry();
    let lease = Uuid::new_v4();
    registry
        .register(lease, 40555, CAPABILITY, future_expiry())
        .await
        .expect("registration");
    let app = runtime.router();

    assert_eq!(
        request_get(app.clone(), &format!("/api/v1/previews/{lease}"))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request_get(
            app.clone(),
            &format!("/api/v1/previews/{lease}?cap=wrong-capability-value")
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request_get(
            app.clone(),
            &format!("/api/v1/previews/{}?cap={CAPABILITY}", Uuid::new_v4())
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );

    let expired = Uuid::new_v4();
    registry
        .register(expired, 40555, CAPABILITY, 1)
        .await
        .expect("expired registration");
    assert_eq!(
        request_get(app, &format!("/api/v1/previews/{expired}?cap={CAPABILITY}"),)
            .await
            .status(),
        StatusCode::GONE
    );
}

#[tokio::test]
async fn renewing_a_preview_registration_extends_its_expiry() {
    let runtime = runtime().await;
    let registry = runtime.preview_proxy_registry();
    let lease = Uuid::new_v4();
    registry
        .register(lease, 40555, CAPABILITY, 1)
        .await
        .expect("registration");
    registry.renew(lease, future_expiry()).await.expect("renew");
    let app = runtime.router();
    assert_eq!(
        request_get(app, &format!("/api/v1/previews/{lease}?cap={CAPABILITY}"))
            .await
            .status(),
        StatusCode::BAD_GATEWAY
    );
}

#[tokio::test]
async fn revoked_preview_capability_cannot_be_replayed() {
    let runtime = runtime().await;
    let registry = runtime.preview_proxy_registry();
    let lease = Uuid::new_v4();
    registry
        .register(lease, 40555, CAPABILITY, future_expiry())
        .await
        .expect("registration");
    registry.revoke(lease).await;

    let replay = request_get(
        runtime.router(),
        &format!("/api/v1/previews/{lease}?cap={CAPABILITY}"),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn preview_proxy_rejects_unknown_ports_and_ssrf_paths() {
    let runtime = runtime().await;
    let registry = runtime.preview_proxy_registry();
    let closed = std::net::TcpListener::bind("127.0.0.1:0").expect("closed port");
    let port = closed.local_addr().expect("port").port();
    drop(closed);
    let lease = Uuid::new_v4();
    registry
        .register(lease, port, CAPABILITY, future_expiry())
        .await
        .expect("registration");
    let app = runtime.router();

    assert_eq!(
        request_get(
            app.clone(),
            &format!("/api/v1/previews/{lease}?cap={CAPABILITY}")
        )
        .await
        .status(),
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(
        request_get(
            app,
            &format!("/api/v1/previews/{lease}/http:%2F%2F169.254.169.254?cap={CAPABILITY}")
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn preview_proxy_rejects_upstream_redirects_instead_of_following_them() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let port = listener.local_addr().expect("upstream port").port();
    let upstream = Router::new().route(
        "/",
        get(|| async {
            (
                StatusCode::FOUND,
                [(header::LOCATION, "http://169.254.169.254/latest/meta-data")],
            )
        }),
    );
    let upstream = tokio::spawn(async move { axum::serve(listener, upstream).await });
    let runtime = runtime().await;
    let registry = runtime.preview_proxy_registry();
    let lease = Uuid::new_v4();
    registry
        .register(lease, port, CAPABILITY, future_expiry())
        .await
        .expect("registration");

    let response = request_get(
        runtime.router(),
        &format!("/api/v1/previews/{lease}?cap={CAPABILITY}"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    upstream.abort();
}

#[tokio::test]
async fn proxy_does_not_forward_cap_or_server_credentials_and_rewrites_html_and_sse() {
    let observed = Arc::new(Mutex::new(Vec::<(String, bool, bool, bool)>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let port = listener.local_addr().expect("upstream port").port();
    let observed_for_handler = observed.clone();
    let upstream = Router::new().fallback(get(move |request: Request| {
        let observed = observed_for_handler.clone();
        async move {
            let path = request.uri().path().to_string();
            observed.lock().expect("observations").push((
                request.uri().to_string(),
                request.headers().contains_key(header::AUTHORIZATION),
                request.headers().contains_key(header::COOKIE),
                request.headers().contains_key(header::ORIGIN),
            ));
            if path == "/events" {
                (
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    format!("data: http://127.0.0.1:{port}/slides/1\n\n"),
                )
                    .into_response()
            } else {
                (
                    [(header::CONTENT_TYPE, "text/html")],
                    "<html><head></head><body>preview</body></html>",
                )
                    .into_response()
            }
        }
    }));
    let upstream = tokio::spawn(async move { axum::serve(listener, upstream).await });

    let runtime = runtime().await;
    let registry = runtime.preview_proxy_registry();
    let lease = Uuid::new_v4();
    registry
        .register(lease, port, CAPABILITY, future_expiry())
        .await
        .expect("registration");
    let app = runtime.router();
    let html = request_get(
        app.clone(),
        &format!("/api/v1/previews/{lease}/index.html?cap={CAPABILITY}"),
    )
    .await;
    assert_eq!(html.status(), StatusCode::OK);
    let html = String::from_utf8(
        to_bytes(html.into_body(), usize::MAX)
            .await
            .expect("html body")
            .to_vec(),
    )
    .expect("html");
    assert!(html.contains(&format!(
        r#"<base href="/api/v1/previews/{lease}/c/{CAPABILITY}/">"#
    )));
    assert!(!html.contains("main-server-token"));

    let events = request_get(
        app,
        &format!("/api/v1/previews/{lease}/c/{CAPABILITY}/events"),
    )
    .await;
    let events = String::from_utf8(
        to_bytes(events.into_body(), usize::MAX)
            .await
            .expect("sse body")
            .to_vec(),
    )
    .expect("sse");
    assert!(events.contains(&format!("/api/v1/previews/{lease}/c/{CAPABILITY}/slides/1")));

    let observed = observed.lock().expect("observations");
    assert_eq!(observed.len(), 2);
    for (uri, authorization, cookie, origin) in observed.iter() {
        assert!(!uri.contains("cap="));
        assert!(!authorization);
        assert!(!cookie);
        assert!(!origin);
    }
    upstream.abort();
}

#[tokio::test]
async fn sse_proxy_yields_events_without_waiting_for_the_upstream_to_close() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let port = listener.local_addr().expect("upstream port").port();
    let upstream = Router::new().route(
        "/events",
        get(move || async move {
            let first = stream::once(async move {
                Ok::<_, std::convert::Infallible>(Bytes::from(format!(
                    "data: http://127.0.0.1:{port}/slides/1\n\n"
                )))
            });
            let never_ends = stream::pending::<Result<Bytes, std::convert::Infallible>>();
            Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from_stream(first.chain(never_ends)))
                .expect("SSE response")
        }),
    );
    let upstream = tokio::spawn(async move { axum::serve(listener, upstream).await });

    let runtime = runtime().await;
    let registry = runtime.preview_proxy_registry();
    let lease = Uuid::new_v4();
    registry
        .register(lease, port, CAPABILITY, future_expiry())
        .await
        .expect("registration");
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        request_get(
            runtime.router(),
            &format!("/api/v1/previews/{lease}/c/{CAPABILITY}/events"),
        ),
    )
    .await
    .expect("proxy must return before the SSE source closes");
    let mut body = response.into_body().into_data_stream();
    let first = tokio::time::timeout(std::time::Duration::from_secs(1), body.next())
        .await
        .expect("first SSE frame")
        .expect("stream item")
        .expect("stream bytes");
    let first = String::from_utf8(first.to_vec()).expect("UTF-8 SSE");
    assert!(first.contains(&format!("/api/v1/previews/{lease}/c/{CAPABILITY}/slides/1")));
    upstream.abort();
}
