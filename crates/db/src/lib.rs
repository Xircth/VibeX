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

        let older_hidden: i64 = sqlx::query_scalar("SELECT hidden FROM projects WHERE id = ?")
            .bind(older_project_id)
            .fetch_one(&pool)
            .await
            .expect("older hidden");
        let newer_hidden: i64 = sqlx::query_scalar("SELECT hidden FROM projects WHERE id = ?")
            .bind(newer_project_id)
            .fetch_one(&pool)
            .await
            .expect("newer hidden");
        assert_eq!(
            older_hidden, 1,
            "older duplicate project must be soft-hidden"
        );
        assert_eq!(
            newer_hidden, 0,
            "newest duplicate project must remain visible"
        );
    }
    #[tokio::test]
    async fn projection_single_authority_migration_and_dual_pool_readonly_enforcement() {
        let db = super::DBService::new_in_memory_for_tests()
            .await
            .expect("in-memory dual-pool db");

        // Verify new columns and row-level trigram FTS5 table exist.
        let timeline_cols: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM pragma_table_info('conversation_timeline_rows') ORDER BY cid",
        )
        .fetch_all(db.reader().as_pool())
        .await
        .expect("timeline columns");
        assert!(timeline_cols.iter().any(|c| c == "deleted_sequence"));

        let snapshot_cols: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM pragma_table_info('conversation_projection_snapshots') ORDER BY cid",
        )
        .fetch_all(db.reader().as_pool())
        .await
        .expect("snapshot columns");
        assert!(
            snapshot_cols
                .iter()
                .any(|c| c == "last_allocated_sequence")
        );

        let session_cols: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info('sessions') ORDER BY cid")
                .fetch_all(db.reader().as_pool())
                .await
                .expect("session columns");
        assert!(
            session_cols
                .iter()
                .any(|c| c == "legacy_jsonl_migrated")
        );

        // WritePool succeeds on row-level trigram FTS5 writes; ReadPool sees committed rows.
        sqlx::query(
            "INSERT INTO conversation_fts (conversation_id, row_id, role, text)
             VALUES (?1, ?2, ?3, ?4)",
        )
        .bind("conv-1")
        .bind("turn-1:assistant")
        .bind("assistant")
        .bind("SQLite single authority trigram search verification")
        .execute(db.writer().as_pool())
        .await
        .expect("fts insert on WritePool");

        let matched_row_id: String = sqlx::query_scalar(
            "SELECT row_id FROM conversation_fts WHERE conversation_fts MATCH '\"trigram\"'",
        )
        .fetch_one(db.reader().as_pool())
        .await
        .expect("fts read on ReadPool");
        assert_eq!(matched_row_id, "turn-1:assistant");

        // ReadPool MUST reject write statements with SQLITE_READONLY.
        let readonly_err = sqlx::query(
            "INSERT INTO conversation_fts (conversation_id, row_id, role, text)
             VALUES ('conv-2', 'row-2', 'user', 'must fail')",
        )
        .execute(db.reader().as_pool())
        .await
        .expect_err("ReadPool must reject writes");
        let db_err = readonly_err
            .as_database_error()
            .expect("expected sqlite database error");
        let code = db_err.code().unwrap_or_default();
        assert!(
            code == "8" || db_err.message().to_ascii_lowercase().contains("readonly") || db_err.message().to_ascii_lowercase().contains("read-only"),
            "expected SQLITE_READONLY (code 8), got code={code:?}, msg={}",
            db_err.message()
        );
    }
}

/// Process-wide single-connection write pool (`max_connections(1)`).
///
/// Serializes `BEGIN IMMEDIATE` write transactions in-process so writers never
/// contend on `SQLITE_BUSY` against each other.
#[derive(Clone, Debug)]
pub struct WritePool(Pool<Sqlite>);

impl WritePool {
    pub fn as_pool(&self) -> &Pool<Sqlite> {
        &self.0
    }

    pub fn into_inner(self) -> Pool<Sqlite> {
        self.0
    }

    pub async fn acquire(&self) -> Result<sqlx::pool::PoolConnection<Sqlite>, Error> {
        self.0.acquire().await
    }

    pub fn from_pool_for_tests(pool: Pool<Sqlite>) -> Self {
        Self(pool)
    }
}

/// Concurrent read-only pool (`max_connections(4)`, `.read_only(true)` / `query_only = ON`).
///
/// Any accidental `INSERT` / `UPDATE` / `DELETE` executed on [`ReadPool`] fails
/// immediately with `SQLITE_READONLY`.
#[derive(Clone, Debug)]
pub struct ReadPool(Pool<Sqlite>);

impl ReadPool {
    pub fn as_pool(&self) -> &Pool<Sqlite> {
        &self.0
    }

    pub fn into_inner(self) -> Pool<Sqlite> {
        self.0
    }

    pub async fn acquire(&self) -> Result<sqlx::pool::PoolConnection<Sqlite>, Error> {
        self.0.acquire().await
    }

    pub fn from_pool_for_tests(pool: Pool<Sqlite>) -> Self {
        Self(pool)
    }
}

fn sqlite_write_connect_options(database_path: &Path) -> SqliteConnectOptions {
    // WAL lets readers (git-status polls, conversation detail) run concurrently
    // with the single writer connection (`WritePool(1)`).
    // Use a filesystem path rather than interpolating `sqlite://{native path}`:
    // Windows paths contain `:` and `\`, which URL parsers treat as a host.
    SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(10))
        .pragma("cache_size", "-4000")
        .pragma("temp_store", "MEMORY")
        .pragma("journal_size_limit", "134217728")
}

fn sqlite_read_connect_options(database_path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(database_path)
        .read_only(true)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10))
        .pragma("cache_size", "-4000")
        .pragma("temp_store", "MEMORY")
        .pragma("query_only", "ON")
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
    pub writer: WritePool,
    pub reader: ReadPool,
}

impl DBService {
    pub fn writer(&self) -> &WritePool {
        &self.writer
    }

    pub fn reader(&self) -> &ReadPool {
        &self.reader
    }

    pub fn pool(&self) -> &Pool<Sqlite> {
        &self.pool
    }

    /// Wrap an existing test pool into a `DBService` handle when a unit test constructs
    /// its own isolated SQLite schema.
    pub fn from_pool_for_tests(pool: Pool<Sqlite>) -> Self {
        Self {
            writer: WritePool(pool.clone()),
            reader: ReadPool(pool.clone()),
            pool,
        }
    }

    /// Create an isolated shared-memory `DBService` with full migrations, `WritePool(1)`,
    /// and a `ReadPool(4)` enforcing `query_only = ON` (`SQLITE_READONLY` on writes).
    pub async fn new_in_memory_for_tests() -> Result<DBService, Error> {
        use std::str::FromStr;

        let uri = format!(
            "sqlite:file:vibex_mem_{}?mode=memory&cache=shared",
            uuid::Uuid::new_v4().simple()
        );
        let write_options = SqliteConnectOptions::from_str(&uri)?
            .create_if_missing(true)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(10))
            .pragma("cache_size", "-4000")
            .pragma("temp_store", "MEMORY");
        let writer_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .min_connections(1)
            .idle_timeout(None)
            .max_lifetime(None)
            .acquire_timeout(Duration::from_secs(30))
            .connect_with(write_options)
            .await?;
        run_migrations(&writer_pool).await?;

        let read_options = SqliteConnectOptions::from_str(&uri)?
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(10))
            .pragma("cache_size", "-4000")
            .pragma("temp_store", "MEMORY")
            .pragma("query_only", "ON");
        let reader_pool = SqlitePoolOptions::new()
            .max_connections(4)
            .min_connections(1)
            .idle_timeout(None)
            .max_lifetime(None)
            .acquire_timeout(Duration::from_secs(30))
            .connect_with(read_options)
            .await?;

        Ok(DBService {
            pool: writer_pool.clone(),
            writer: WritePool(writer_pool),
            reader: ReadPool(reader_pool),
        })
    }

    pub async fn new() -> Result<DBService, Error> {
        Self::new_at(asset_dir()).await
    }

    /// Open the canonical VibeX database beneath an explicit data directory.
    ///
    /// Headless and desktop composition roots use this same initializer so
    /// migrations and SQLite concurrency settings cannot drift by host.
    pub async fn new_at(data_dir: impl AsRef<std::path::Path>) -> Result<DBService, Error> {
        std::fs::create_dir_all(data_dir.as_ref()).map_err(Error::Io)?;
        Self::create_pools(data_dir.as_ref(), None::<fn(ReadPool) -> AfterConnectHook>).await
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
        let hook: AfterConnectHook = Arc::new(after_connect);
        Self::create_pools(&asset_dir(), Some(move |_reader| hook)).await
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
        let hook: AfterConnectHook = Arc::new(after_connect);
        Self::create_pools(data_dir.as_ref(), Some(move |_reader| hook)).await
    }

    /// Open `WritePool(1)` + `ReadPool(4)` at `data_dir` and build the writer-only
    /// `after_connect` hook from the freshly initialized [`ReadPool`], eliminating any
    /// hidden third pool inside update hooks.
    pub async fn new_at_with_reader_hook<MakeHook, F>(
        data_dir: impl AsRef<std::path::Path>,
        make_hook: MakeHook,
    ) -> Result<DBService, Error>
    where
        MakeHook: FnOnce(ReadPool) -> F,
        F: for<'a> Fn(
                &'a mut SqliteConnection,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<(), Error>> + Send + 'a>,
            > + Send
            + Sync
            + 'static,
    {
        std::fs::create_dir_all(data_dir.as_ref()).map_err(Error::Io)?;
        Self::create_pools(
            data_dir.as_ref(),
            Some(move |reader| Arc::new(make_hook(reader)) as AfterConnectHook),
        )
        .await
    }

    async fn create_pools<MakeHook>(
        data_dir: &Path,
        make_hook: Option<MakeHook>,
    ) -> Result<DBService, Error>
    where
        MakeHook: FnOnce(ReadPool) -> AfterConnectHook,
    {
        let db_path = data_dir.join("db.sqlite");
        let write_options = sqlite_write_connect_options(&db_path);
        let read_options = sqlite_read_connect_options(&db_path);

        // Run migrations on an unhooked single connection first so `db.sqlite` exists
        // in WAL mode with the latest schema before opening `ReadPool(.read_only(true))`
        // or attaching update hooks to `WritePool`.
        let migration_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .min_connections(1)
            .acquire_timeout(Duration::from_secs(30))
            .connect_with(write_options.clone())
            .await?;
        run_migrations(&migration_pool).await?;
        migration_pool.close().await;

        let reader_pool = SqlitePoolOptions::new()
            .max_connections(4)
            .min_connections(1)
            .idle_timeout(Duration::from_secs(30))
            .acquire_timeout(Duration::from_secs(30))
            .connect_with(read_options)
            .await?;
        let reader = ReadPool(reader_pool);

        let mut writer_builder = SqlitePoolOptions::new()
            .max_connections(1)
            .min_connections(1)
            .idle_timeout(Duration::from_secs(30))
            .acquire_timeout(Duration::from_secs(30));

        if let Some(make_hook) = make_hook {
            let hook = make_hook(reader.clone());
            writer_builder = writer_builder.after_connect(move |conn, _meta| {
                let hook = hook.clone();
                Box::pin(async move {
                    hook(conn).await?;
                    Ok(())
                })
            });
        }

        let writer_pool = writer_builder.connect_with(write_options).await?;
        let writer = WritePool(writer_pool.clone());

        Ok(DBService {
            pool: writer_pool,
            writer,
            reader,
        })
    }
}
