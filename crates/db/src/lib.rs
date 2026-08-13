use std::{str::FromStr, sync::Arc, time::Duration};

use sqlx::{
    Error, Pool, Sqlite,
    sqlite::{
        SqliteConnectOptions, SqliteConnection, SqliteJournalMode, SqlitePoolOptions,
        SqliteSynchronous,
    },
};
use utils::assets::asset_dir;

pub mod models;

async fn run_migrations(pool: &Pool<Sqlite>) -> Result<(), Error> {
    sqlx::migrate!("./migrations").run(pool).await?;
    models::agent_management::legacy_migration::LegacyAgentMigration::run(pool)
        .await
        .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
    models::agent_management::conversation_migration::LegacyConversationAgentMigration::run(pool)
        .await
        .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
    models::plugin_v2::PluginV1Migration::retire_all(pool).await?;
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
}

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
        let database_url = format!(
            "sqlite://{}",
            data_dir.as_ref().join("db.sqlite").to_string_lossy()
        );
        // WAL lets readers (git-status polls, conversation detail) run concurrently
        // with the writer (the ACP event persistence sink, which writes rapidly
        // while an agent streams). DELETE mode serialized every access and caused
        // "database is locked" + pool-acquire timeouts once agents actually run.
        // busy_timeout makes a contended write wait for the lock instead of
        // erroring immediately.
        let options = SqliteConnectOptions::from_str(&database_url)?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(10));
        let pool = SqlitePoolOptions::new()
            .max_connections(20)
            .min_connections(1)
            .acquire_timeout(Duration::from_secs(30))
            .connect_with(options)
            .await?;
        run_migrations(&pool).await?;
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

    async fn create_pool<F>(
        data_dir: impl AsRef<std::path::Path>,
        after_connect: Option<Arc<F>>,
    ) -> Result<Pool<Sqlite>, Error>
    where
        F: for<'a> Fn(
                &'a mut SqliteConnection,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<(), Error>> + Send + 'a>,
            > + Send
            + Sync
            + 'static,
    {
        let database_url = format!(
            "sqlite://{}",
            data_dir.as_ref().join("db.sqlite").to_string_lossy()
        );
        // WAL lets readers (git-status polls, conversation detail) run concurrently
        // with the writer (the ACP event persistence sink, which writes rapidly
        // while an agent streams). DELETE mode serialized every access and caused
        // "database is locked" + pool-acquire timeouts once agents actually run.
        // busy_timeout makes a contended write wait for the lock instead of
        // erroring immediately.
        let options = SqliteConnectOptions::from_str(&database_url)?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(10));
        let pool_options = SqlitePoolOptions::new()
            .max_connections(20)
            .min_connections(1)
            .acquire_timeout(Duration::from_secs(30));

        let pool = if let Some(hook) = after_connect {
            pool_options
                .after_connect(move |conn, _meta| {
                    let hook = hook.clone();
                    Box::pin(async move {
                        hook(conn).await?;
                        Ok(())
                    })
                })
                .connect_with(options)
                .await?
        } else {
            pool_options.connect_with(options).await?
        };

        run_migrations(&pool).await?;
        Ok(pool)
    }
}
