use std::str::FromStr;

use application::{
    ApplicationCore, NotificationProjector, Principal, SqliteConversationRepository,
    TerminalNotificationEvidence,
};
use db::models::conversation_event::{AppendConversationEvent, ConversationEventRecord};
use remote_protocol::{ConversationId, NotificationOutcome, NotificationSource, OperationId};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use uuid::Uuid;

#[test]
fn terminal_notification_summary_never_contains_private_detail() {
    let conversation_id =
        ConversationId::parse("0195d6f4-8c37-7b28-a982-6a9e60142f54").expect("conversation id");
    let evidence = TerminalNotificationEvidence {
        source: NotificationSource::Conversation { conversation_id },
        outcome: NotificationOutcome::Failed,
        occurred_at: "2026-07-31T10:00:00Z".to_owned(),
        operation_id: OperationId::parse("0195d6f4-8c37-7b28-a982-6a9e60142f55")
            .expect("operation id"),
        private_detail: Some("authorization=Bearer release-secret".to_owned()),
    };

    let summary = NotificationProjector::project(evidence);
    let encoded = serde_json::to_string(&summary).expect("notification JSON");

    assert_eq!(summary.outcome, NotificationOutcome::Failed);
    assert!(encoded.contains("conversation"));
    assert!(!encoded.contains("release-secret"));
    assert!(!encoded.contains("authorization"));
}

async fn application_fixture() -> (
    ApplicationCore<SqliteConversationRepository>,
    sqlx::SqlitePool,
    Uuid,
) {
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
    (
        ApplicationCore::new(SqliteConversationRepository::new(pool.clone())),
        pool,
        conversation_id,
    )
}

#[tokio::test]
async fn offline_cache_is_read_only_and_preserves_unknown_events() {
    let (core, pool, conversation_id) = application_fixture().await;
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
            event_kind: "future_event",
            normalized_json: r#"{"future_field":"kept"}"#,
            raw_json: None,
            idempotency_key: None,
        },
    )
    .await
    .expect("append event");

    let cache = core
        .offline_conversation_cache(
            &Principal::remote("paired-device", ["offline.read".to_string()]),
            ConversationId::from_uuid(conversation_id),
            0,
        )
        .await
        .expect("offline cache");

    assert!(cache.read_only);
    assert_eq!(cache.confirmed_through, 1);
    assert_eq!(cache.events[0].kind, "future_event");
    assert_eq!(cache.events[0].payload["future_field"], "kept");
}

#[tokio::test]
async fn persisted_terminal_event_projects_a_secret_free_notification() {
    let (core, pool, conversation_id) = application_fixture().await;
    ConversationEventRecord::append(
        &pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: None,
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "runtime",
            event_kind: "turn_failed",
            normalized_json: r#"{"error":"Bearer release-secret","path":"/private/work"}"#,
            raw_json: None,
            idempotency_key: None,
        },
    )
    .await
    .expect("append terminal event");

    let summary = core
        .terminal_notification_summary(
            &Principal::remote("paired-device", ["notification.summary".to_string()]),
            ConversationId::from_uuid(conversation_id),
        )
        .await
        .expect("notification summary");
    let encoded = serde_json::to_string(&summary).expect("notification JSON");

    assert_eq!(summary.outcome, NotificationOutcome::Failed);
    assert!(matches!(
        summary.source,
        NotificationSource::Conversation { conversation_id: id }
            if id == ConversationId::from_uuid(conversation_id)
    ));
    assert!(!encoded.contains("release-secret"));
    assert!(!encoded.contains("/private/work"));
}
