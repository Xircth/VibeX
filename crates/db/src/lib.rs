use std::{path::Path, sync::Arc, time::Duration};

use sqlx::{
    Error, Pool, Sqlite,
    sqlite::{
        SqliteConnectOptions, SqliteConnection, SqliteJournalMode, SqlitePoolOptions,
        SqliteSynchronous,
    },
};
use utils::assets::asset_dir;

pub mod conversation_repository;
pub mod data_dir_migration;
mod local_data_reset;
pub mod models;
pub mod workflow_queries;

pub use conversation_repository::SqliteConversationRepository;
pub use data_dir_migration::{
    checkpoint_and_remap_data_dir_paths, remap_sqlite_data_dir_paths,
    remap_sqlite_file_data_dir_paths,
};
pub use local_data_reset::{clear_local_database_rows, reset_local_database};

/// The SQLite pool every composition root hands to storage adapters.
pub type DbPool = sqlx::SqlitePool;

async fn run_migrations(pool: &Pool<Sqlite>) -> Result<(), Error> {
    // Keep this call in the DB crate so every composition embeds the same migration set.
    let migrator = sqlx::migrate!("./migrations");
    for migration in migrator.iter() {
        if !migration.migration_type.is_down_migration() {
            let _ = sqlx::query(
                "UPDATE _sqlx_migrations SET checksum = ? WHERE version = ? AND success = 1",
            )
            .bind(migration.checksum.as_ref())
            .bind(migration.version)
            .execute(pool)
            .await;
        }
    }
    migrator.run(pool).await?;
    models::agent_management::legacy_migration::LegacyAgentMigration::run(pool)
        .await
        .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
    models::agent_management::conversation_migration::LegacyConversationAgentMigration::run(pool)
        .await
        .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
    models::plugin_v2::PluginV1Migration::retire_all(pool).await?;
    models::collaboration_identity::MemberIdentityMigration::run(pool)
        .await
        .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
    resolve_legacy_automation_timezones(pool).await?;
    Ok(())
}

async fn resolve_legacy_automation_timezones(pool: &Pool<Sqlite>) -> Result<(), Error> {
    let timezone = iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string());
    let mut transaction = pool.begin().await?;
    sqlx::query(
        "UPDATE automations
         SET timezone = ?
         WHERE id IN (
             SELECT automation_id
             FROM automation_legacy_evidence
             WHERE json_extract(evidence_json, '$.timezone_resolution')
                   = 'legacy_local_pending'
         )",
    )
    .bind(&timezone)
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        "UPDATE automation_legacy_evidence
         SET evidence_json = json_set(
             evidence_json,
             '$.timezone_resolution', 'resolved',
             '$.resolved_timezone', ?
         )
         WHERE json_extract(evidence_json, '$.timezone_resolution')
               = 'legacy_local_pending'",
    )
    .bind(&timezone)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use chrono::Utc;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    use super::{resolve_legacy_automation_timezones, run_migrations};

    #[tokio::test]
    async fn published_migration_versions_remain_in_the_manifest() {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory database");
        run_migrations(&pool).await.expect("initial migrations");

        let versions: Vec<i64> = sqlx::query_scalar(
            "SELECT version FROM _sqlx_migrations \
             WHERE version IN (20260730010000, 20260730020000, 20260730030000, 20260731100000) \
             ORDER BY version",
        )
        .fetch_all(&pool)
        .await
        .expect("published migration versions");

        assert_eq!(
            versions,
            [
                20260730010000,
                20260730020000,
                20260730030000,
                20260731100000,
            ]
        );
    }

    #[tokio::test]
    async fn startup_migrations_capture_legacy_plugin_evidence() {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory database");
        run_migrations(&pool).await.expect("initial migrations");
        let now = Utc::now();
        sqlx::query(
            "INSERT INTO plugins \
             (id,name,skill_name,console_command,hook_message,install_command,install_status, \
              enabled,builtin,created_at,updated_at) \
             VALUES (?,?,?,?,?,?,'pending',1,0,?,?)",
        )
        .bind(Uuid::new_v4())
        .bind("Legacy")
        .bind("legacy-skill")
        .bind("legacy console")
        .bind("legacy hook")
        .bind("touch must-not-run")
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert legacy row");

        run_migrations(&pool).await.expect("application restart");

        let evidence_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plugin_legacy_evidence")
            .fetch_one(&pool)
            .await
            .expect("evidence count");
        assert_eq!(evidence_count, 1);
    }

    #[tokio::test]
    async fn legacy_builtin_office_adopts_canonical_publisher() {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory database");
        run_migrations(&pool).await.expect("initial migrations");

        sqlx::query(
            "INSERT INTO plugin_packages_v4
                (publisher, plugin_id, version, package_digest, source_kind, source_path,
                 manifest_json, package_json, created_at)
             VALUES ('legacy.local', 'vibex.office', '2.0.0', 'legacy:office', 'builtin',
                     '/tmp/office', '{}', '{\"id\":\"vibex.office\"}', datetime('now'))",
        )
        .execute(&pool)
        .await
        .expect("legacy package");
        sqlx::query(
            "INSERT INTO plugin_installations_v4
                (plugin_id, publisher, current_package_digest, installed_at, updated_at)
             VALUES ('vibex.office', 'legacy.local', 'legacy:office',
                     datetime('now'), datetime('now'))",
        )
        .execute(&pool)
        .await
        .expect("legacy installation");

        sqlx::raw_sql(include_str!(
            "../migrations/20260814030000_adopt_builtin_office_publisher.sql"
        ))
        .execute(&pool)
        .await
        .expect("publisher adoption");

        let publisher: String = sqlx::query_scalar(
            "SELECT publisher FROM plugin_installations_v4 WHERE plugin_id = 'vibex.office'",
        )
        .fetch_one(&pool)
        .await
        .expect("installation publisher");
        let package_publisher: String = sqlx::query_scalar(
            "SELECT json_extract(package_json, '$.publisher')
             FROM plugin_packages_v4
             WHERE publisher = 'vibex' AND plugin_id = 'vibex.office'",
        )
        .fetch_one(&pool)
        .await
        .expect("package publisher");
        let legacy_packages: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM plugin_packages_v4
             WHERE publisher = 'legacy.local' AND plugin_id = 'vibex.office'",
        )
        .fetch_one(&pool)
        .await
        .expect("legacy package count");

        assert_eq!(publisher, "vibex");
        assert_eq!(package_publisher, "vibex");
        assert_eq!(legacy_packages, 0);
    }

    #[tokio::test]
    async fn legacy_automation_timezone_is_resolved_exactly_once() {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory database");
        run_migrations(&pool).await.expect("initial migrations");
        let store = crate::models::automation_v2::SqliteAutomationStore::new(pool.clone());
        let draft = automation::BuiltinTemplateCatalog::all().remove(0).draft;
        let record = store.create(draft, Utc::now()).await.expect("automation");
        sqlx::query(
            "INSERT INTO automation_legacy_evidence
             (automation_id,evidence_json,captured_at)
             VALUES (?,json_object('timezone_resolution','legacy_local_pending'),?)",
        )
        .bind(record.id)
        .bind(Utc::now())
        .execute(&pool)
        .await
        .expect("pending evidence");

        resolve_legacy_automation_timezones(&pool)
            .await
            .expect("first resolution");
        let evidence: String = sqlx::query_scalar(
            "SELECT evidence_json FROM automation_legacy_evidence WHERE automation_id = ?",
        )
        .bind(record.id)
        .fetch_one(&pool)
        .await
        .expect("resolved evidence");
        assert!(evidence.contains(r#""timezone_resolution":"resolved""#));

        sqlx::query("UPDATE automations SET timezone = 'Etc/GMT+1' WHERE id = ?")
            .bind(record.id)
            .execute(&pool)
            .await
            .expect("simulate moved data directory");
        resolve_legacy_automation_timezones(&pool)
            .await
            .expect("second startup");
        let timezone: String = sqlx::query_scalar("SELECT timezone FROM automations WHERE id = ?")
            .bind(record.id)
            .fetch_one(&pool)
            .await
            .expect("timezone");
        assert_eq!(timezone, "Etc/GMT+1");
    }

    #[tokio::test]
    async fn artifact_revision_migration_preserves_file_reference_evidence() {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory database");
        run_migrations(&pool).await.expect("initial migrations");

        let columns: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM pragma_table_info('artifact_revisions') ORDER BY cid",
        )
        .fetch_all(&pool)
        .await
        .expect("artifact columns");
        for required in [
            "conversation_id",
            "turn_id",
            "workspace_id",
            "relative_path",
            "content_hash",
            "revision",
            "plugin_id",
            "plugin_version",
            "provider_id",
            "tool_lock_id",
            "tool_executable_path",
        ] {
            assert!(columns.iter().any(|column| column == required));
        }
        assert!(!columns.iter().any(|column| column == "content_bytes"));

        let outbox_columns: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM pragma_table_info('artifact_event_outbox') ORDER BY cid",
        )
        .fetch_all(&pool)
        .await
        .expect("artifact outbox columns");
        assert_eq!(
            outbox_columns,
            ["artifact_id", "revision", "event_json", "delivered"]
        );
        let preview_outbox_columns: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM pragma_table_info('artifact_preview_event_outbox') ORDER BY cid",
        )
        .fetch_all(&pool)
        .await
        .expect("artifact preview outbox columns");
        assert_eq!(
            preview_outbox_columns,
            ["event_key", "conversation_id", "event_json", "delivered"]
        );
        let preview_foreign_keys: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT \"table\", \"from\", on_delete \
             FROM pragma_foreign_key_list('artifact_preview_event_outbox')",
        )
        .fetch_all(&pool)
        .await
        .expect("artifact preview outbox foreign keys");
        assert!(preview_foreign_keys.iter().any(|(table, from, on_delete)| {
            table == "sessions" && from == "conversation_id" && on_delete == "CASCADE"
        }));
    }

    #[test]
    fn embedded_migrations_match_migration_files() {
        // Regression: a migration file added without rebuilding the crate was
        // missing from the embedded set (no build.rs rerun-if-changed).
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut on_disk: Vec<i64> = std::fs::read_dir(&dir)
            .expect("migrations dir")
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                if !name.ends_with(".sql") {
                    return None;
                }
                name.split('_').next()?.parse().ok()
            })
            .collect();
        on_disk.sort_unstable();
        on_disk.dedup();
        let mut embedded: Vec<i64> = sqlx::migrate!("./migrations")
            .iter()
            .map(|migration| migration.version)
            .collect();
        embedded.sort_unstable();
        embedded.dedup();
        assert_eq!(embedded, on_disk);
        assert!(embedded.contains(&20261024100000));
        assert!(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("build.rs")
                .exists()
        );
    }

    #[tokio::test]
    async fn member_session_config_columns_exist_after_migration() {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        run_migrations(&pool).await.unwrap();
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info('collaboration_members')")
                .fetch_all(&pool)
                .await
                .unwrap();
        for column in ["mode_id", "config_values", "persona_prompt"] {
            assert!(columns.iter().any(|c| c == column), "missing {column}");
        }
    }

    #[tokio::test]
    async fn duplicate_project_repo_paths_are_deduplicated_during_root_path_migration() {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory database");

        let migrator = sqlx::migrate!("./migrations");
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
                version BIGINT PRIMARY KEY,
                description TEXT NOT NULL,
                installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                success BOOLEAN NOT NULL,
                checksum BLOB NOT NULL,
                execution_time BIGINT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create _sqlx_migrations");

        for migration in migrator.iter() {
            if migration.migration_type.is_down_migration() || migration.version < 20260918010000 {
                continue;
            }
            sqlx::query(
                "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
                 VALUES (?, ?, 1, ?, 1)",
            )
            .bind(migration.version)
            .bind(migration.description.as_ref())
            .bind(migration.checksum.as_ref())
            .execute(&pool)
            .await
            .expect("pre-mark post-target migration");
        }
        migrator.run(&pool).await.expect("run pre-migrations");
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version >= 20260918010000")
            .execute(&pool)
            .await
            .expect("unmark target and later migrations");

        let repo_id = Uuid::new_v4();
        let older_project_id = Uuid::new_v4();
        let newer_project_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO repos (id, path, name, display_name, created_at, updated_at)
             VALUES (?, '/workspace/dup-repo', 'dup-repo', 'Dup Repo', '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
        )
        .bind(repo_id)
        .execute(&pool)
        .await
        .expect("insert repo");

        sqlx::query(
            "INSERT INTO projects (id, name, created_at, updated_at)
             VALUES (?, 'Older Dup', '2026-01-01 00:00:00', '2026-01-01 00:00:00'),
                    (?, 'Newer Dup', '2026-01-02 00:00:00', '2026-01-02 00:00:00')",
        )
        .bind(older_project_id)
        .bind(newer_project_id)
        .execute(&pool)
        .await
        .expect("insert duplicate projects");

        sqlx::query(
            "INSERT INTO project_repos (id, project_id, repo_id)
             VALUES (?, ?, ?), (?, ?, ?)",
        )
        .bind(Uuid::new_v4())
        .bind(older_project_id)
        .bind(repo_id)
        .bind(Uuid::new_v4())
        .bind(newer_project_id)
        .bind(repo_id)
        .execute(&pool)
        .await
        .expect("link duplicate projects to same repo");

        run_migrations(&pool)
            .await
            .expect("migrations should deduplicate duplicate root_path rows");

        let older_hidden: i64 =
            sqlx::query_scalar("SELECT hidden FROM projects WHERE id = ?")
                .bind(older_project_id)
                .fetch_one(&pool)
                .await
                .expect("older hidden");
        let newer_hidden: i64 =
            sqlx::query_scalar("SELECT hidden FROM projects WHERE id = ?")
                .bind(newer_project_id)
                .fetch_one(&pool)
                .await
                .expect("newer hidden");
        assert_eq!(older_hidden, 1, "older duplicate project must be soft-hidden");
        assert_eq!(newer_hidden, 0, "newest duplicate project must remain visible");
    }
}

fn sqlite_connect_options(database_path: &Path) -> SqliteConnectOptions {
    // WAL lets readers (git-status polls, conversation detail) run concurrently
    // with the writer (the ACP event persistence sink, which writes rapidly
    // while an agent streams). DELETE mode serialized every access and caused
    // "database is locked" + pool-acquire timeouts once agents actually run.
    // busy_timeout makes a contended write wait for the lock instead of
    // erroring immediately. cache_size=-4000 is 4 MiB per connection. That is
    // small enough for an idle desktop process and not zero, which would force
    // every page read back to disk. Temporary tables stay on the default store.
    //
    // Use a filesystem path rather than interpolating `sqlite://{native path}`.
    // Windows paths contain `:` and `\`, which URL parsers treat as a host.
    SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(10))
        .pragma("cache_size", "-4000")
}

type AfterConnectHook = Arc<
    dyn for<'a> Fn(
            &'a mut SqliteConnection,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), Error>> + Send + 'a>,
        > + Send
        + Sync,
>;

#[derive(Clone)]
pub struct DBService {
    pub pool: Pool<Sqlite>,
}

impl DBService {
    pub async fn new() -> Result<DBService, Error> {
        Self::new_at(asset_dir()).await
    }

    /// Open the canonical VibeX database beneath an explicit data directory.
    ///
    /// Headless and desktop composition roots use this same initializer so
    /// migrations and SQLite concurrency settings cannot drift by host.
    pub async fn new_at(data_dir: impl AsRef<std::path::Path>) -> Result<DBService, Error> {
        std::fs::create_dir_all(data_dir.as_ref()).map_err(Error::Io)?;
        let pool = Self::create_pool(data_dir.as_ref(), None).await?;
        Ok(DBService { pool })
    }

    /// Create a lazy secondary handle to an already-migrated SQLite database
    /// (for example, inside `after_connect` update-hook callbacks) without
    /// opening a connection at startup or running `run_migrations` a second time.
    pub fn new_lazy_at(data_dir: impl AsRef<std::path::Path>) -> Result<DBService, Error> {
        std::fs::create_dir_all(data_dir.as_ref()).map_err(Error::Io)?;
        let options = sqlite_connect_options(&data_dir.as_ref().join("db.sqlite"));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .min_connections(0)
            .idle_timeout(Duration::from_secs(30))
            .acquire_timeout(Duration::from_secs(30))
            .connect_lazy_with(options);
        Ok(DBService { pool })
    }

    pub async fn new_with_after_connect<F>(after_connect: F) -> Result<DBService, Error>
    where
        F: for<'a> Fn(
                &'a mut SqliteConnection,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<(), Error>> + Send + 'a>,
            > + Send
            + Sync
            + 'static,
    {
        let pool = Self::create_pool(asset_dir(), Some(Arc::new(after_connect))).await?;
        Ok(DBService { pool })
    }

    pub async fn new_at_with_after_connect<F>(
        data_dir: impl AsRef<std::path::Path>,
        after_connect: F,
    ) -> Result<DBService, Error>
    where
        F: for<'a> Fn(
                &'a mut SqliteConnection,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<(), Error>> + Send + 'a>,
            > + Send
            + Sync
            + 'static,
    {
        std::fs::create_dir_all(data_dir.as_ref()).map_err(Error::Io)?;
        let pool = Self::create_pool(data_dir.as_ref(), Some(Arc::new(after_connect))).await?;
        Ok(DBService { pool })
    }

    async fn create_pool(
        data_dir: impl AsRef<std::path::Path>,
        after_connect: Option<AfterConnectHook>,
    ) -> Result<Pool<Sqlite>, Error> {
        let options = sqlite_connect_options(&data_dir.as_ref().join("db.sqlite"));
        let pool_options = SqlitePoolOptions::new()
            .max_connections(3)
            .min_connections(1)
            .idle_timeout(Duration::from_secs(30))
            .acquire_timeout(Duration::from_secs(30));

        if let Some(hook) = after_connect {
            let migration_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .min_connections(1)
                .acquire_timeout(Duration::from_secs(30))
                .connect_with(options.clone())
                .await?;
            run_migrations(&migration_pool).await?;
            migration_pool.close().await;

            let pool = pool_options
                .after_connect(move |conn, _meta| {
                    let hook = hook.clone();
                    Box::pin(async move {
                        hook(conn).await?;
                        Ok(())
                    })
                })
                .connect_with(options)
                .await?;
            Ok(pool)
        } else {
            let pool = pool_options.connect_with(options).await?;
            run_migrations(&pool).await?;
            Ok(pool)
        }
    }
}
