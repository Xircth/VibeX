use std::{
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};

use application::{ApplicationCore, SqliteConversationRepository};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures::StreamExt;
use remote_protocol::{
    CreatePairingRequest, DeviceCredential, DevicePermissionPreset, ErrorCode, ErrorEnvelope,
    PairingChallenge, RedeemPairingRequest, ServerCapabilities, SubscriptionServerMessage,
};
use server::{
    AuthClock, PreviewProxyRegistry, ServerConfig, ServerRuntime, ServerToken, SqliteServerAuth,
    SqliteTokenHashStore,
};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue},
};
use tower::ServiceExt;

async fn test_app() -> axum::Router {
    test_app_with_clock(Arc::new(TestClock::new(1_800_000_000))).await
}

struct TestClock(AtomicI64);

impl TestClock {
    const fn new(now: i64) -> Self {
        Self(AtomicI64::new(now))
    }

    fn advance(&self, seconds: i64) {
        self.0.fetch_add(seconds, Ordering::SeqCst);
    }
}

impl AuthClock for TestClock {
    fn unix_seconds(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

async fn test_app_with_clock(clock: Arc<TestClock>) -> axum::Router {
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
    SqliteTokenHashStore::new(pool.clone())
        .provision(Some(ServerToken::new(
            "pairing-admin-token-with-at-least-32-bytes",
        )))
        .await
        .expect("provision master token");
    let core = ApplicationCore::new(SqliteConversationRepository::new(pool.clone()));
    ServerRuntime::from_auth_with_preview_proxy(
        ServerConfig::default(),
        Arc::new(SqliteServerAuth::with_clock(pool, clock)),
        core,
        PreviewProxyRegistry::default(),
    )
    .router()
}

#[tokio::test]
async fn expired_pairing_returns_a_stable_reason() {
    let clock = Arc::new(TestClock::new(1_800_000_000));
    let app = test_app_with_clock(clock.clone()).await;
    let create = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/pairings")
                .header(
                    "authorization",
                    "Bearer pairing-admin-token-with-at-least-32-bytes",
                )
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&CreatePairingRequest {
                        preset: None,
                        requested_scopes: vec!["conversation.read".to_owned()],
                    })
                    .expect("pairing request"),
                ))
                .expect("request"),
        )
        .await
        .expect("create pairing response");
    let challenge: PairingChallenge = json_body(create).await;
    clock.advance(5 * 60 + 1);

    let expired = app
        .oneshot(
            Request::post("/api/v1/auth/pairings/redeem")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&RedeemPairingRequest {
                        pairing_token: challenge.pairing_token,
                        device_name: "expired-device".to_owned(),
                    })
                    .expect("redeem request"),
                ))
                .expect("request"),
        )
        .await
        .expect("expired response");
    assert_eq!(expired.status(), StatusCode::CONFLICT);
    let error: ErrorEnvelope = json_body(expired).await;
    assert_eq!(error.code, ErrorCode::Conflict);
    assert_eq!(
        error.details.expect("stable pairing detail")["reason"],
        "pairing_expired"
    );
}

#[tokio::test]
async fn revoking_a_device_invalidates_http_and_an_existing_websocket() {
    let app = test_app().await;
    let create = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/pairings")
                .header(
                    "authorization",
                    "Bearer pairing-admin-token-with-at-least-32-bytes",
                )
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&CreatePairingRequest {
                        preset: None,
                        requested_scopes: vec![
                            "conversation.read".to_owned(),
                            "conversation.attach".to_owned(),
                            "notification.summary".to_owned(),
                            "offline.read".to_owned(),
                        ],
                    })
                    .expect("pairing request"),
                ))
                .expect("request"),
        )
        .await
        .expect("create pairing response");
    let challenge: PairingChallenge = json_body(create).await;
    let redeemed = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/pairings/redeem")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&RedeemPairingRequest {
                        pairing_token: challenge.pairing_token,
                        device_name: "revoked-device".to_owned(),
                    })
                    .expect("redeem request"),
                ))
                .expect("request"),
        )
        .await
        .expect("redeem response");
    let device: DeviceCredential = json_body(redeemed).await;

    let capabilities = app
        .clone()
        .oneshot(
            Request::get("/api/v1/capabilities")
                .header("authorization", format!("Bearer {}", device.access_token))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("capabilities response");
    assert_eq!(capabilities.status(), StatusCode::OK);
    let capabilities: ServerCapabilities = json_body(capabilities).await;
    assert!(
        capabilities
            .capabilities
            .iter()
            .any(|capability| capability.as_str() == "conversation.read")
    );
    assert!(
        capabilities
            .capabilities
            .iter()
            .all(|capability| capability.as_str() != "conversation.write")
    );
    assert!(
        capabilities
            .capabilities
            .iter()
            .any(|capability| capability.as_str() == "notification.summary")
    );
    assert!(
        capabilities
            .capabilities
            .iter()
            .any(|capability| capability.as_str() == "offline.read")
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let server_app = app.clone();
    let server = tokio::spawn(async move { axum::serve(listener, server_app).await });
    let mut request = format!("ws://{address}/api/v1/ws")
        .into_client_request()
        .expect("WebSocket request");
    let encoded = URL_SAFE_NO_PAD.encode(&device.access_token);
    request.headers_mut().insert(
        "sec-websocket-protocol",
        HeaderValue::from_str(&format!("vibex.v1, vibex.token.{encoded}"))
            .expect("WebSocket protocol"),
    );
    let (mut socket, _) = connect_async(request).await.expect("device WebSocket");

    let revoked = app
        .clone()
        .oneshot(
            Request::delete(format!("/api/v1/auth/devices/{}", device.device_id))
                .header(
                    "authorization",
                    "Bearer pairing-admin-token-with-at-least-32-bytes",
                )
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("revoke response");
    assert_eq!(revoked.status(), StatusCode::OK);

    let rejected = app
        .oneshot(
            Request::get("/api/v1/capabilities")
                .header("authorization", format!("Bearer {}", device.access_token))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("rejected response");
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);

    let frame = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
        .await
        .expect("revocation propagated to WebSocket")
        .expect("WebSocket frame")
        .expect("valid frame");
    let message: SubscriptionServerMessage =
        serde_json::from_slice(&frame.into_data()).expect("protocol error message");
    assert!(matches!(
        message,
        SubscriptionServerMessage::Error { error }
            if error.code == ErrorCode::Unauthorized
    ));
    server.abort();
}

async fn json_body<T: serde::de::DeserializeOwned>(response: axum::response::Response) -> T {
    serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body"),
    )
    .expect("response JSON")
}

#[tokio::test]
async fn pairing_token_can_be_redeemed_exactly_once() {
    let app = test_app().await;
    let create = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/pairings")
                .header(
                    "authorization",
                    "Bearer pairing-admin-token-with-at-least-32-bytes",
                )
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&CreatePairingRequest {
                        preset: None,
                        requested_scopes: vec!["conversation.read".to_owned()],
                    })
                    .expect("pairing request"),
                ))
                .expect("request"),
        )
        .await
        .expect("create pairing response");
    assert_eq!(create.status(), StatusCode::CREATED);
    let challenge: PairingChallenge = json_body(create).await;
    assert!(remote_protocol::is_connection_code(
        &challenge.pairing_token
    ));

    let redeem_request = RedeemPairingRequest {
        pairing_token: challenge.pairing_token,
        device_name: "release-smoke-device".to_owned(),
    };
    let redeemed = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/pairings/redeem")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&redeem_request).expect("redeem request"),
                ))
                .expect("request"),
        )
        .await
        .expect("redeem response");
    assert_eq!(redeemed.status(), StatusCode::CREATED);
    let device: DeviceCredential = json_body(redeemed).await;
    assert_eq!(device.scopes, vec!["conversation.read"]);
    assert!(!device.access_token.is_empty());

    let replay = app
        .oneshot(
            Request::post("/api/v1/auth/pairings/redeem")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&redeem_request).expect("redeem replay"),
                ))
                .expect("request"),
        )
        .await
        .expect("replay response");
    assert_eq!(replay.status(), StatusCode::CONFLICT);
    let error: ErrorEnvelope = json_body(replay).await;
    assert_eq!(error.code, ErrorCode::Conflict);
}

#[tokio::test]
async fn concurrent_pairing_redemption_has_one_winner() {
    let temporary = tempfile::tempdir().expect("temporary database");
    let options = SqliteConnectOptions::new()
        .filename(temporary.path().join("pairing.sqlite"))
        .create_if_missing(true)
        .foreign_keys(false)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .expect("multi-connection database");
    sqlx::migrate!("../db/migrations")
        .run(&pool)
        .await
        .expect("migrations");
    SqliteTokenHashStore::new(pool.clone())
        .provision(Some(ServerToken::new(
            "pairing-admin-token-with-at-least-32-bytes",
        )))
        .await
        .expect("provision master token");
    let core = ApplicationCore::new(SqliteConversationRepository::new(pool.clone()));
    let app = ServerRuntime::from_sqlite_auth(ServerConfig::default(), pool.clone(), core).router();
    let create = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/pairings")
                .header(
                    "authorization",
                    "Bearer pairing-admin-token-with-at-least-32-bytes",
                )
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&CreatePairingRequest {
                        preset: None,
                        requested_scopes: vec!["conversation.read".to_owned()],
                    })
                    .expect("pairing request"),
                ))
                .expect("request"),
        )
        .await
        .expect("create pairing response");
    let challenge: PairingChallenge = json_body(create).await;
    let redeem = RedeemPairingRequest {
        pairing_token: challenge.pairing_token,
        device_name: "concurrent-device".to_owned(),
    };
    let request = || {
        Request::post("/api/v1/auth/pairings/redeem")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&redeem).expect("redeem request"),
            ))
            .expect("request")
    };

    let (first, second) = tokio::join!(
        app.clone().oneshot(request()),
        app.clone().oneshot(request())
    );
    let mut statuses = [
        first.expect("first response").status(),
        second.expect("second response").status(),
    ];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::CREATED, StatusCode::CONFLICT]);
    let credentials: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM server_device_credentials")
        .fetch_one(&pool)
        .await
        .expect("credential count");
    assert_eq!(credentials, 1);
    let audit_events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM server_auth_audit_events")
        .fetch_one(&pool)
        .await
        .expect("audit count");
    assert_eq!(audit_events, 2, "pairing creation and one redemption");
}

#[tokio::test]
async fn companion_preset_expands_to_the_companion_scope_set() {
    let app = test_app().await;
    let create = app
        .oneshot(
            Request::post("/api/v1/auth/pairings")
                .header(
                    "authorization",
                    "Bearer pairing-admin-token-with-at-least-32-bytes",
                )
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&CreatePairingRequest {
                        preset: Some(DevicePermissionPreset::Companion),
                        requested_scopes: Vec::new(),
                    })
                    .expect("pairing request"),
                ))
                .expect("request"),
        )
        .await
        .expect("create pairing response");
    assert_eq!(create.status(), StatusCode::CREATED);
    let challenge: PairingChallenge = json_body(create).await;
    let expected = DevicePermissionPreset::Companion
        .scopes()
        .iter()
        .map(|scope| (*scope).to_owned())
        .collect::<std::collections::BTreeSet<_>>();
    let actual = challenge
        .requested_scopes
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(actual, expected);
}
