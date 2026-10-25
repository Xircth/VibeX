use sqlx::{
    SqlitePool,
    migrate::Migrate,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};

const LEAD_VERSION: i64 = 20261027010000;

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
        .filter(|migration| migration.version < LEAD_VERSION)
    {
        connection
            .apply(migration)
            .await
            .unwrap_or_else(|error| panic!("apply {} failed: {error}", migration.version));
    }
}

async fn apply_lead(pool: &SqlitePool) {
    let migrator = sqlx::migrate!("./migrations");
    let mut connection = pool.acquire().await.expect("connection");
    for migration in migrator
        .iter()
        .filter(|migration| migration.version >= LEAD_VERSION)
    {
        connection
            .apply(migration)
            .await
            .unwrap_or_else(|error| panic!("apply {} failed: {error}", migration.version));
    }
}

#[tokio::test]
async fn old_spaces_keep_working_after_lead_and_hop_migration() {
    let pool = connect().await;
    apply_before(&pool).await;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .expect("disable foreign keys");
    sqlx::query(
        r#"INSERT INTO collaboration_spaces (id, workspace_id, name, created_at)
           VALUES ('space-old', '11111111-1111-1111-1111-111111111111', '旧群', '2026-01-01T00:00:00Z')"#,
    )
    .execute(&pool)
    .await
    .expect("seed old space");
    sqlx::query(
        r#"INSERT INTO collaboration_space_messages
           (id, space_id, seq, envelope_json, created_at, origin)
           VALUES ('msg-old', 'space-old', 1, '{"content":"hello"}', '2026-01-01T00:00:00Z', 'user')"#,
    )
    .execute(&pool)
    .await
    .expect("seed old message");

    apply_lead(&pool).await;

    let lead: Option<String> = sqlx::query_scalar(
        "SELECT lead_member_id FROM collaboration_spaces WHERE id = 'space-old'",
    )
    .fetch_one(&pool)
    .await
    .expect("lead column");
    assert!(lead.is_none());

    let (root_id, hop, origin): (Option<String>, i64, String) = sqlx::query_as(
        "SELECT root_id, hop, origin FROM collaboration_space_messages WHERE id = 'msg-old'",
    )
    .fetch_one(&pool)
    .await
    .expect("hop columns");
    assert_eq!(root_id.as_deref(), Some("msg-old"));
    assert_eq!(hop, 0);
    assert_eq!(origin, "user");

    sqlx::query(
        r#"INSERT INTO collaboration_space_messages
           (id, space_id, seq, envelope_json, created_at, origin, root_id, hop)
           VALUES ('msg-system', 'space-old', 2, '{"content":"cap"}', '2026-01-01T00:00:01Z', 'system', 'msg-system', 0)"#,
    )
    .execute(&pool)
    .await
    .expect("system origin accepted");
}
