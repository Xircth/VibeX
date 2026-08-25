use sqlx::{
    SqlitePool,
    migrate::Migrate,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};

const RENAME_VERSION: i64 = 20260824010000;

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

async fn apply_before_rename(pool: &SqlitePool) {
    let migrator = sqlx::migrate!("./migrations");
    let mut connection = pool.acquire().await.expect("connection");
    connection
        .ensure_migrations_table()
        .await
        .expect("migration table");
    for migration in migrator
        .iter()
        .filter(|migration| migration.version < RENAME_VERSION)
    {
        connection
            .apply(migration)
            .await
            .unwrap_or_else(|error| panic!("apply {} failed: {error}", migration.version));
    }
}

async fn apply_rename(pool: &SqlitePool) {
    let migrator = sqlx::migrate!("./migrations");
    let mut connection = pool.acquire().await.expect("connection");
    for migration in migrator
        .iter()
        .filter(|migration| migration.version >= RENAME_VERSION)
    {
        connection
            .apply(migration)
            .await
            .unwrap_or_else(|error| panic!("apply {} failed: {error}", migration.version));
    }
}

async fn seed_gemini_with_children(pool: &SqlitePool) {
    sqlx::query(
        r#"INSERT INTO agent_membership
           (agent_id, source, built_in, retired, enabled, position)
           VALUES ('gemini', 'built_in_profile', 1, 0, 1, 0)"#,
    )
    .execute(pool)
    .await
    .expect("gemini membership");
    sqlx::query(
        r#"INSERT INTO agent_setting (agent_type, enabled, sort_order)
           VALUES ('gemini', 1, 0)"#,
    )
    .execute(pool)
    .await
    .expect("gemini setting");
    sqlx::query(
        r#"INSERT INTO agent_install_lock
           (id, agent_id, registry_version, platform, distribution_kind, resolved_json, created_at)
           VALUES ('lock-gemini', 'gemini', '1.0.0', 'macos-arm64', 'binary', '{}', datetime('now'))"#,
    )
    .execute(pool)
    .await
    .expect("gemini lock");
    sqlx::query(
        r#"INSERT INTO agent_installation
           (agent_id, ownership, lifecycle, current_lock_id, updated_at)
           VALUES ('gemini', 'external', 'ready', 'lock-gemini', datetime('now'))"#,
    )
    .execute(pool)
    .await
    .expect("gemini installation");
    sqlx::query(
        r#"INSERT INTO agent_probe
           (agent_id, lifecycle, authentication, detail_json, probed_at)
           VALUES ('gemini', 'ready', 'logged_in', '{}', datetime('now'))"#,
    )
    .execute(pool)
    .await
    .expect("gemini probe");
}

#[tokio::test]
async fn rename_gemini_membership_that_still_has_child_rows() {
    let pool = connect().await;
    apply_before_rename(&pool).await;
    seed_gemini_with_children(&pool).await;
    apply_rename(&pool).await;

    let memberships: Vec<String> =
        sqlx::query_scalar("SELECT agent_id FROM agent_membership ORDER BY agent_id")
            .fetch_all(&pool)
            .await
            .expect("memberships");
    assert!(memberships.contains(&"antigravity".to_string()));
    assert!(!memberships.contains(&"gemini".to_string()));

    let installation: String = sqlx::query_scalar(
        "SELECT agent_id FROM agent_installation WHERE current_lock_id = 'lock-gemini'",
    )
    .fetch_one(&pool)
    .await
    .expect("installation");
    assert_eq!(installation, "antigravity");

    let probe: String = sqlx::query_scalar("SELECT agent_id FROM agent_probe")
        .fetch_one(&pool)
        .await
        .expect("probe");
    assert_eq!(probe, "antigravity");

    let setting: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_setting WHERE agent_type = 'antigravity'")
            .fetch_one(&pool)
            .await
            .expect("setting");
    assert_eq!(setting, 1);
}

#[tokio::test]
async fn rename_gemini_when_antigravity_already_exists() {
    let pool = connect().await;
    apply_before_rename(&pool).await;
    seed_gemini_with_children(&pool).await;
    sqlx::query(
        r#"INSERT INTO agent_membership
           (agent_id, source, built_in, retired, enabled, position)
           VALUES ('antigravity', 'built_in_profile', 1, 0, 1, 1)"#,
    )
    .execute(&pool)
    .await
    .expect("antigravity membership");
    sqlx::query(
        r#"INSERT INTO agent_setting (agent_type, enabled, sort_order)
           VALUES ('antigravity', 1, 1)"#,
    )
    .execute(&pool)
    .await
    .expect("antigravity setting");
    sqlx::query(
        r#"INSERT INTO agent_installation
           (agent_id, ownership, lifecycle, updated_at)
           VALUES ('antigravity', 'external', 'ready', datetime('now'))"#,
    )
    .execute(&pool)
    .await
    .expect("antigravity installation");

    apply_rename(&pool).await;

    let gemini: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_membership WHERE agent_id = 'gemini'")
            .fetch_one(&pool)
            .await
            .expect("gemini count");
    assert_eq!(gemini, 0);
    let installations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_installation")
        .fetch_one(&pool)
        .await
        .expect("installation count");
    assert_eq!(installations, 1);
    let remaining: String = sqlx::query_scalar("SELECT agent_id FROM agent_installation")
        .fetch_one(&pool)
        .await
        .expect("remaining installation");
    assert_eq!(remaining, "antigravity");
}
