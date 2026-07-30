use std::net::SocketAddr;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use server::{HeadlessServer, ServerBootstrapConfig, ServerConfig};
use tempfile::TempDir;
use tower::ServiceExt;

#[tokio::test]
async fn headless_bootstrap_uses_loopback_and_reuses_the_persisted_hash() {
    let data_dir = TempDir::new().expect("data dir");
    let mut first = HeadlessServer::bootstrap(ServerBootstrapConfig::new(data_dir.path()))
        .await
        .expect("first bootstrap");
    assert!(first.runtime().config().listen_addr.ip().is_loopback());
    let token = first
        .take_issued_token()
        .expect("first start issues a token")
        .expose_once();
    drop(first);

    let mut second = HeadlessServer::bootstrap(ServerBootstrapConfig::new(data_dir.path()))
        .await
        .expect("restart");
    assert!(
        second.take_issued_token().is_none(),
        "a restart must load the persisted hash instead of rotating credentials"
    );
    let response = second
        .runtime()
        .router()
        .oneshot(
            Request::builder()
                .uri("/api/v1/capabilities")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
}

#[test]
fn non_loopback_listen_requires_explicit_opt_in() {
    let lan: SocketAddr = "0.0.0.0:3080".parse().expect("address");
    assert!(
        ServerConfig::default()
            .with_listen_addr(lan, false)
            .is_err()
    );
    assert_eq!(
        ServerConfig::default()
            .with_listen_addr(lan, true)
            .expect("explicit LAN opt-in")
            .listen_addr,
        lan
    );
}
