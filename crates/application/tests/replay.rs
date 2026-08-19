use std::str::FromStr;

use application::{
    ApplicationCore, ApplicationError, ConversationSubscriptionRegistrar, Principal,
    SqliteConversationRepository,
};
use async_trait::async_trait;
use db::models::conversation_event::{AppendConversationEvent, ConversationEventRecord};
use remote_protocol::{ConversationId, EventCursor, SubscriptionId};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use uuid::Uuid;

struct ReadySubscriptions;

#[async_trait]
impl ConversationSubscriptionRegistrar for ReadySubscriptions {
    async fn register(
        &self,
        _subscription_id: SubscriptionId,
        _conversation_id: ConversationId,
    ) -> Result<(), ApplicationError> {
        Ok(())
    }
}

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
            &ReadySubscriptions,
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
            &ReadySubscriptions,
        )
        .await
        .expect("incremental attach");
    assert_eq!(incremental.replay.len(), 1);
    assert_eq!(incremental.replay[0].kind, "future_kind");

    let mut cursor = EventCursor::after(1);
    assert!(cursor.accept(&incremental.replay[0]));
    assert!(!cursor.accept(&incremental.replay[0]));
}

struct AppendDuringRegistration {
    pool: sqlx::SqlitePool,
}

#[async_trait]
impl ConversationSubscriptionRegistrar for AppendDuringRegistration {
    async fn register(
        &self,
        _subscription_id: SubscriptionId,
        conversation_id: ConversationId,
    ) -> Result<(), ApplicationError> {
        ConversationEventRecord::append(
            &self.pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id: conversation_id.as_uuid(),
                turn_id: None,
                binding_id: None,
                connection_id: None,
                prompt_id: None,
                source: "host",
                event_kind: "turn_started",
                normalized_json: r#"{"kind":"turn_started"}"#,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        Ok(())
    }
}

#[tokio::test]
async fn attach_registers_live_delivery_before_capturing_the_high_water_mark() {
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
    let core = ApplicationCore::new(SqliteConversationRepository::new(pool.clone()));

    let bootstrap = core
        .attach_conversation(
            &Principal::local_desktop(),
            SubscriptionId::new(),
            ConversationId::from_uuid(conversation_id),
            0,
            &AppendDuringRegistration { pool },
        )
        .await
        .expect("attach");

    assert!(bootstrap.ready);
    assert_eq!(bootstrap.high_water_mark, 1);
    assert_eq!(
        bootstrap.snapshot.expect("snapshot").payload["events"][0]["kind"],
        "turn_started"
    );
}

#[tokio::test]
async fn attach_accepts_the_dedicated_remote_scope_without_general_read_access() {
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
        .expect("focused fixture");
    let conversation_id = Uuid::new_v4();
    let core = ApplicationCore::new(SqliteConversationRepository::new(pool));

    let bootstrap = core
        .attach_conversation(
            &Principal::remote("paired-device", ["conversation.attach".to_string()]),
            SubscriptionId::new(),
            ConversationId::from_uuid(conversation_id),
            0,
            &ReadySubscriptions,
        )
        .await
        .expect("dedicated attach scope");

    assert!(bootstrap.ready);
}

#[tokio::test]
async fn attach_skips_event_reload_when_already_caught_up() {
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
        .expect("focused fixture");
    let conversation_id = Uuid::new_v4();
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
            event_kind: "turn_started",
            normalized_json: r#"{"kind":"turn_started"}"#,
            raw_json: None,
            idempotency_key: None,
        },
    )
    .await
    .expect("append event");

    let core = ApplicationCore::new(SqliteConversationRepository::new(pool));
    let bootstrap = core
        .attach_conversation(
            &Principal::local_desktop(),
            SubscriptionId::new(),
            ConversationId::from_uuid(conversation_id),
            1,
            &ReadySubscriptions,
        )
        .await
        .expect("caught-up attach");

    assert!(bootstrap.replay.is_empty());
    assert!(bootstrap.snapshot.is_none());
    assert_eq!(bootstrap.high_water_mark, 1);
}
