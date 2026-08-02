use std::path::Path;

use db::DBService;
use sqlx::{
    migrate::Migrate,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};

const LEGACY_CUTOFF: i64 = 20260730100000;
const LEGACY_SERVER_TOKEN_CUTOFF: i64 = 20260730120000;

async fn create_sanitized_legacy_database(data_dir: &Path, marker: &Path) {
    let database = data_dir.join("db.sqlite");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(database)
                .create_if_missing(true)
                .foreign_keys(false),
        )
        .await
        .expect("legacy database");
    let migrator = sqlx::migrate!("./migrations");
    {
        let mut connection = pool.acquire().await.expect("legacy connection");
        connection
            .ensure_migrations_table()
            .await
            .expect("migration table");
        for migration in migrator
            .iter()
            .filter(|migration| migration.version <= LEGACY_CUTOFF)
        {
            connection
                .apply(migration)
                .await
                .expect("apply historical migration");
        }
    }

    let fixture = include_str!("fixtures/agent_k_sanitized_legacy.sql")
        .replace("__MIGRATION_MARKER__", &marker.display().to_string());
    sqlx::raw_sql(&fixture)
        .execute(&pool)
        .await
        .expect("sanitized legacy fixture");
    {
        let mut connection = pool.acquire().await.expect("legacy token connection");
        for migration in migrator.iter().filter(|migration| {
            migration.version > LEGACY_CUTOFF && migration.version <= LEGACY_SERVER_TOKEN_CUTOFF
        }) {
            connection
                .apply(migration)
                .await
                .expect("apply pre-device-auth migration");
        }
    }
    sqlx::raw_sql(include_str!("fixtures/agent_k_sanitized_legacy_token.sql"))
        .execute(&pool)
        .await
        .expect("sanitized legacy token fixture");
    pool.close().await;
}

#[tokio::test]
async fn sanitized_legacy_database_migrates_without_executing_or_relaunching() {
    let temporary = tempfile::tempdir().expect("temporary data directory");
    let marker = temporary.path().join("legacy-install-command-ran");
    create_sanitized_legacy_database(temporary.path(), &marker).await;

    let database = DBService::new_at(temporary.path())
        .await
        .expect("production migration path");
    assert!(
        !marker.exists(),
        "legacy install_command must remain evidence"
    );

    let plugin: (String, Option<String>, String) = sqlx::query_as(
        "SELECT migration_status, mapped_plugin_id, original_manifest_json
         FROM plugin_legacy_evidence
         WHERE legacy_plugin_id = X'11111111111141118111111111111111'",
    )
    .fetch_one(&database.pool)
    .await
    .expect("plugin evidence");
    assert_eq!(plugin.0, "migration_required");
    assert_eq!(plugin.1, None);
    assert!(
        plugin.2.contains("legacy-install-command-ran"),
        "the original command is retained as evidence"
    );

    let automation: (bool, String, String, Option<String>) = sqlx::query_as(
        "SELECT enabled, isolation, legacy_migration_status, next_run_at
         FROM automations
         WHERE id = X'22222222222242228222222222222222'",
    )
    .fetch_one(&database.pool)
    .await
    .expect("migrated automation");
    assert!(!automation.0);
    assert_eq!(automation.1, "shared_in_root");
    assert_eq!(automation.2, "migration_required");
    assert_eq!(automation.3, None);

    let run: (String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT status, stop_reason, finished_at
         FROM automation_runs
         WHERE id = X'44444444444444448444444444444444'",
    )
    .fetch_one(&database.pool)
    .await
    .expect("recovered run");
    assert_eq!(run.0, "interrupted");
    assert_eq!(run.1.as_deref(), Some("host_restarted"));
    assert!(run.2.is_some());
    let permanently_running: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM automation_runs WHERE status = 'running'")
            .fetch_one(&database.pool)
            .await
            .expect("running count");
    assert_eq!(permanently_running, 0);

    let server_token: (String, String) = sqlx::query_as(
        "SELECT hex(token_hash), scopes_json
         FROM server_access_tokens
         WHERE id = 'sanitized-server-token'",
    )
    .fetch_one(&database.pool)
    .await
    .expect("migrated server token");
    assert_eq!(
        server_token.0,
        "5555555555555555555555555555555555555555555555555555555555555555"
    );
    assert!(server_token.1.contains("\"device.pair\""));
    assert!(server_token.1.contains("\"offline.read\""));
    assert!(!server_token.1.contains("plaintext"));
    database.pool.close().await;

    let restarted = DBService::new_at(temporary.path())
        .await
        .expect("idempotent restart");
    let plugin_evidence: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plugin_legacy_evidence")
        .fetch_one(&restarted.pool)
        .await
        .expect("plugin evidence count");
    let automation_runs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM automation_runs")
        .fetch_one(&restarted.pool)
        .await
        .expect("automation run count");
    assert_eq!(plugin_evidence, 1);
    assert_eq!(automation_runs, 1, "Interrupted work must not be resent");
}
