use sqlx::{
    SqlitePool,
    migrate::Migrate,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};

const INJECTION_VERSION: i64 = 20261027020000;

async fn connect() -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(":memory:")
                .create_if_missing(true)
                .foreign_keys(true),
        )
        .await
        .expect("memory database")
}

async fn apply_before(pool: &SqlitePool) {
    let migrator = sqlx::migrate!("./migrations");
    let mut connection = pool.acquire().await.expect("connection");
    connection
        .ensure_migrations_table()
        .await
        .expect("migration table");
    for migration in migrator
        .iter()
        .filter(|migration| migration.version < INJECTION_VERSION)
    {
        connection
            .apply(migration)
            .await
            .unwrap_or_else(|error| panic!("apply {} failed: {error}", migration.version));
    }
}

async fn apply_injection(pool: &SqlitePool) {
    let migrator = sqlx::migrate!("./migrations");
    let mut connection = pool.acquire().await.expect("connection");
    for migration in migrator
        .iter()
        .filter(|migration| migration.version >= INJECTION_VERSION)
    {
        connection
            .apply(migration)
            .await
            .unwrap_or_else(|error| panic!("apply {} failed: {error}", migration.version));
    }
}

#[tokio::test]
async fn prompt_injection_table_is_keyed_by_conversation_and_space() {
    let pool = connect().await;
    apply_before(&pool).await;
    apply_injection(&pool).await;

    sqlx::query(
        r#"INSERT INTO collaboration_space_prompt_injections
           (conversation_id, space_id, acp_session_id, injected_at)
           VALUES ('conv-a', 'space-1', 'acp-1', '2026-01-01T00:00:00Z')"#,
    )
    .execute(&pool)
    .await
    .expect("insert injection");

    let acp: String = sqlx::query_scalar(
        r#"SELECT acp_session_id FROM collaboration_space_prompt_injections
           WHERE conversation_id = 'conv-a' AND space_id = 'space-1'"#,
    )
    .fetch_one(&pool)
    .await
    .expect("read injection");
    assert_eq!(acp, "acp-1");

    sqlx::query(
        r#"INSERT INTO collaboration_space_prompt_injections
           (conversation_id, space_id, acp_session_id, injected_at)
           VALUES ('conv-a', 'space-1', 'acp-2', '2026-01-02T00:00:00Z')
           ON CONFLICT(conversation_id, space_id) DO UPDATE SET
             acp_session_id = excluded.acp_session_id,
             injected_at = excluded.injected_at"#,
    )
    .execute(&pool)
    .await
    .expect("upsert injection");

    let acp: String = sqlx::query_scalar(
        r#"SELECT acp_session_id FROM collaboration_space_prompt_injections
           WHERE conversation_id = 'conv-a' AND space_id = 'space-1'"#,
    )
    .fetch_one(&pool)
    .await
    .expect("read upsert");
    assert_eq!(acp, "acp-2");
}
