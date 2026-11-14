use api_types::AgentId;
use db::models::{
    conversation::{
        BindingStatus, ConversationAgentBindingRecord as Binding, ConversationRecord,
        CreateConversationRecord,
    },
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use uuid::Uuid;

async fn pool() -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .in_memory(true)
                .foreign_keys(false),
        )
        .await
        .unwrap()
}

async fn conversation(pool: &SqlitePool) -> Uuid {
    let id = Uuid::new_v4();
    ConversationRecord::create(
        pool,
        id,
        CreateConversationRecord {
            workspace_id: Uuid::new_v4(),
            task_id: None,
            title: None,
            initial_prompt: None,
            status: None,
            executor: Some("codex"),
        },
    )
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn migration_uses_the_latest_generation_as_a_rebind_barrier() {
    let pool = pool().await;
    let mut migrator = sqlx::migrate!("./migrations");
    migrator.migrations = std::borrow::Cow::Owned(
        migrator
            .iter()
            .filter(|m| m.version < 20261113010000)
            .cloned()
            .collect(),
    );
    migrator.run(&pool).await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    let id = conversation(&pool).await;
    let old = Uuid::new_v4();
    let barrier = Uuid::new_v4();
    sqlx::query(
        "UPDATE sessions SET agent_id = 'codex', external_session_id = 'abandoned' WHERE id = ?",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    for (binding, native, status) in [
        (old, Some("abandoned"), "ready"),
        (barrier, None, "recovering"),
    ] {
        sqlx::query("INSERT INTO conversation_agent_bindings (id, conversation_id, agent_type, agent_id, working_dir, acp_session_id, status) VALUES (?, ?, 'codex', 'codex', '/work', ?, ?)")
            .bind(binding).bind(id).bind(native).bind(status).execute(&pool).await.unwrap();
    }
    sqlx::raw_sql(include_str!(
        "../migrations/20261113010000_conversation_binding_generations.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    // Stage C columns are part of the binding record shape selected by
    // BINDING_COLUMNS, so the manually-applied Stage A schema needs them too.
    sqlx::raw_sql(include_str!(
        "../migrations/20261113030000_conversation_continuation_keys.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let active = Binding::active_for_conversation(&pool, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(active.id, barrier);
    assert!(!active.resume_allowed);
    assert_eq!(active.invalidated_reason.as_deref(), Some("legacy_rebind"));
    let next = Binding::link_native_session(
        &pool,
        id,
        &AgentId::parse("codex").unwrap(),
        "/work",
        "abandoned",
        "new-connection",
    )
    .await
    .unwrap();
    assert_ne!(next.id, old);
    assert_ne!(next.id, barrier);
}

#[tokio::test]
async fn ownership_native_identity_and_turn_attribution_survive_activation_changes() {
    let pool = pool().await;
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    let first = conversation(&pool).await;
    let other = conversation(&pool).await;
    let agent = AgentId::parse("codex").unwrap();
    let a = Binding::link_native_session(&pool, first, &agent, "/work", "native-a", "connection-a")
        .await
        .unwrap();
    assert!(Binding::activate(&pool, other, a.id).await.is_err());
    assert!(
        Binding::bind_acp_session(&pool, a.id, "overwritten", None, BindingStatus::Ready)
            .await
            .is_err()
    );
    let turn = ConversationTurnRecord::create_pending(
        &pool,
        Uuid::new_v4(),
        CreateConversationTurn {
            conversation_id: first,
            prompt_id: None,
            text_preview: Some("question"),
            input_blocks_json: "[]",
        },
    )
    .await
    .unwrap();
    assert_eq!(turn.agent_binding_id, Some(a.id));
    let b = Binding::link_native_session(&pool, first, &agent, "/work", "native-b", "connection-b")
        .await
        .unwrap();
    assert_ne!(a.id, b.id);
    let previous_turn = ConversationTurnRecord::find_by_id(&pool, turn.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(previous_turn.agent_binding_id, Some(a.id));
    let bindings = Binding::list_for_conversation(&pool, first).await.unwrap();
    assert_eq!(bindings[0].acp_session_id.as_deref(), Some("native-a"));
    assert_eq!(
        Binding::active_for_conversation(&pool, first)
            .await
            .unwrap()
            .unwrap()
            .id,
        b.id
    );
}

#[tokio::test]
async fn preparing_a_generation_keeps_the_selected_binding_until_explicit_activation() {
    let pool = pool().await;
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    let id = conversation(&pool).await;
    let agent = AgentId::parse("codex").unwrap();
    let original =
        Binding::link_native_session(&pool, id, &agent, "/work", "original", "old-connection")
            .await
            .unwrap();
    let candidate = Binding::prepare_native_session(
        &pool,
        id,
        &agent,
        "/work",
        "candidate",
        "candidate-connection",
    )
    .await
    .unwrap();
    assert_ne!(original.id, candidate.id);
    assert_eq!(
        Binding::active_for_conversation(&pool, id)
            .await
            .unwrap()
            .unwrap()
            .id,
        original.id
    );
    Binding::activate(&pool, id, candidate.id).await.unwrap();
    assert_eq!(
        Binding::active_for_conversation(&pool, id)
            .await
            .unwrap()
            .unwrap()
            .id,
        candidate.id
    );
}
