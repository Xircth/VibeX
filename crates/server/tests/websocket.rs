use std::{str::FromStr, time::Duration};

use application::{ApplicationCore, SqliteConversationRepository};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use db::models::conversation_event::{AppendConversationEvent, ConversationEventRecord};
use futures::{SinkExt, StreamExt};
use remote_protocol::{
    ConversationId, SubscriptionClientMessage, SubscriptionId, SubscriptionRequest,
    SubscriptionResource, SubscriptionServerMessage,
};
use server::{ServerConfig, ServerRuntime, ServerToken};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};
use uuid::Uuid;

async fn append(pool: &SqlitePool, conversation_id: Uuid, kind: &str) {
    let normalized_json = format!(r#"{{"kind":"{kind}"}}"#);
    ConversationEventRecord::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: None,
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "host",
            event_kind: kind,
            normalized_json: &normalized_json,
            raw_json: None,
            idempotency_key: None,
        },
    )
    .await
    .expect("append event");
}

async fn next_server_message(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> SubscriptionServerMessage {
    let frame = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("websocket message timeout")
        .expect("websocket open")
        .expect("valid websocket frame");
    serde_json::from_slice(&frame.into_data()).expect("server message")
}

async fn connect(
    address: std::net::SocketAddr,
    token: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let mut request = format!("ws://{address}/api/v1/ws")
        .into_client_request()
        .expect("request");
    let encoded = URL_SAFE_NO_PAD.encode(token);
    request.headers_mut().insert(
        "sec-websocket-protocol",
        HeaderValue::from_str(&format!("vibex.v1, vibex.token.{encoded}")).expect("protocol"),
    );
    let (socket, response) = connect_async(request).await.expect("websocket connect");
    assert_eq!(
        response
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok()),
        Some("vibex.v1")
    );
    socket
}

#[tokio::test]
async fn websocket_attach_ready_replay_and_reconnect() {
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
        .expect("focused event fixture");
    let conversation_id = Uuid::new_v4();
    append(&pool, conversation_id, "turn_started").await;
    append(&pool, conversation_id, "content_delta").await;

    let core = ApplicationCore::new(SqliteConversationRepository::new(pool.clone()));
    let app = ServerRuntime::new(
        ServerConfig::default(),
        ServerToken::new("websocket-secret"),
        core,
    )
    .router();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let server = tokio::spawn(async move { axum::serve(listener, app).await });

    let subscription_id = SubscriptionId::new();
    let mut socket = connect(address, "websocket-secret").await;
    socket
        .send(Message::Text(
            serde_json::to_string(&SubscriptionClientMessage::Attach {
                request: SubscriptionRequest {
                    subscription_id,
                    resource: SubscriptionResource::Conversation {
                        conversation_id: ConversationId::from_uuid(conversation_id),
                        after_sequence: 0,
                    },
                },
            })
            .expect("attach")
            .into(),
        ))
        .await
        .expect("send attach");

    assert!(matches!(
        next_server_message(&mut socket).await,
        SubscriptionServerMessage::Ready {
            subscription_id: ready
        } if ready == subscription_id
    ));
    assert!(matches!(
        next_server_message(&mut socket).await,
        SubscriptionServerMessage::Snapshot {
            subscription_id: snapshot_id,
            snapshot
        } if snapshot_id == subscription_id && snapshot.through_sequence == 2
    ));
    assert!(matches!(
        next_server_message(&mut socket).await,
        SubscriptionServerMessage::Live {
            subscription_id: live_id,
            high_water_mark: 2
        } if live_id == subscription_id
    ));

    append(&pool, conversation_id, "permission_requested").await;
    assert!(matches!(
        next_server_message(&mut socket).await,
        SubscriptionServerMessage::Event {
            subscription_id: event_id,
            event
        } if event_id == subscription_id
            && event.sequence == 3
            && event.kind == "permission_requested"
    ));
    socket.close(None).await.expect("close first socket");
    append(&pool, conversation_id, "turn_completed").await;

    let reconnect_id = SubscriptionId::new();
    let mut socket = connect(address, "websocket-secret").await;
    socket
        .send(Message::Text(
            serde_json::to_string(&SubscriptionClientMessage::Attach {
                request: SubscriptionRequest {
                    subscription_id: reconnect_id,
                    resource: SubscriptionResource::Conversation {
                        conversation_id: ConversationId::from_uuid(conversation_id),
                        after_sequence: 3,
                    },
                },
            })
            .expect("reattach")
            .into(),
        ))
        .await
        .expect("send reattach");
    assert!(matches!(
        next_server_message(&mut socket).await,
        SubscriptionServerMessage::Ready { subscription_id } if subscription_id == reconnect_id
    ));
    assert!(matches!(
        next_server_message(&mut socket).await,
        SubscriptionServerMessage::Event {
            subscription_id,
            event
        } if subscription_id == reconnect_id
            && event.sequence == 4
            && event.kind == "turn_completed"
    ));
    assert!(matches!(
        next_server_message(&mut socket).await,
        SubscriptionServerMessage::Live {
            subscription_id,
            high_water_mark: 4
        } if subscription_id == reconnect_id
    ));

    server.abort();
}
