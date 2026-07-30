use std::str::FromStr;

use application::{ApplicationCore, Principal, SqliteConversationRepository};
use db::models::conversation_event::{AppendConversationEvent, ConversationEventRecord};
use remote_protocol::{ConversationId, EventCursor, SubscriptionId};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use uuid::Uuid;

#[tokio::test]
async fn replay_uses_durable_sequence_and_preserves_unknown_events() {
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
        .expect("disable foreign keys for focused fixture");
    let conversation_id = Uuid::new_v4();
    for (kind, body) in [
        ("known", r#"{"kind":"known","text":"A"}"#),
        ("future_kind", r#"{"kind":"future_kind","new_field":"B"}"#),
    ] {
        ConversationEventRecord::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "host",
                event_kind: kind,
                normalized_json: body,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append event");
    }

    let core = ApplicationCore::new(SqliteConversationRepository::new(pool.clone()));
    let snapshot = core
        .attach_conversation(
            &Principal::local_desktop(),
            SubscriptionId::new(),
            ConversationId::from_uuid(conversation_id),
            0,
        )
        .await
        .expect("snapshot attach");
    assert!(snapshot.ready);
    assert_eq!(snapshot.high_water_mark, 2);
    assert_eq!(
        snapshot.snapshot.expect("initial snapshot").payload["events"][1]["kind"],
        "future_kind"
    );

    let incremental = core
        .attach_conversation(
            &Principal::local_desktop(),
            SubscriptionId::new(),
            ConversationId::from_uuid(conversation_id),
            1,
        )
        .await
        .expect("incremental attach");
    assert_eq!(incremental.replay.len(), 1);
    assert_eq!(incremental.replay[0].kind, "future_kind");

    let mut cursor = EventCursor::after(1);
    assert!(cursor.accept(&incremental.replay[0]));
    assert!(!cursor.accept(&incremental.replay[0]));
}
