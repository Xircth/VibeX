use std::{str::FromStr, sync::Arc, time::Duration};

use sqlx::{
    Error, Pool, Sqlite,
    migrate::MigrateError,
    sqlite::{SqliteConnectOptions, SqliteConnection, SqliteJournalMode, SqlitePoolOptions},
};
use utils::assets::asset_dir;

pub mod models;

fn auto_fix_migration_checksum_mismatch_enabled(
    strict_override: Option<std::ffi::OsString>,
) -> bool {
    cfg!(windows) && strict_override.is_none()
}

fn should_auto_fix_migration_checksum_mismatch() -> bool {
    auto_fix_migration_checksum_mismatch_enabled(std::env::var_os("VIBE_ULTRA_STRICT_MIGRATIONS"))
}

async fn run_migrations(pool: &Pool<Sqlite>) -> Result<(), Error> {
    use std::collections::HashSet;

    let migrator = sqlx::migrate!("./migrations");
    let mut processed_versions: HashSet<i64> = HashSet::new();

    loop {
        match migrator.run(pool).await {
            Ok(()) => return Ok(()),
            Err(MigrateError::VersionMismatch(version)) => {
                if !should_auto_fix_migration_checksum_mismatch() {
                    // Keep strict checksum handling unless Windows local recovery is explicitly enabled.
                    return Err(sqlx::Error::Migrate(Box::new(
                        MigrateError::VersionMismatch(version),
                    )));
                }

                // Guard against infinite loop
                if !processed_versions.insert(version) {
                    return Err(sqlx::Error::Migrate(Box::new(
                        MigrateError::VersionMismatch(version),
                    )));
                }

                // On Windows dev machines, line ending drift or local recovery can leave an
                // applied migration with a different checksum than the current file contents.
                // Update the stored checksum and retry the migrator.
                tracing::warn!(
                    "Migration version {} has checksum mismatch, updating stored checksum",
                    version
                );

                // Find the migration with the mismatched version and get its current checksum
                if let Some(migration) = migrator.iter().find(|m| m.version == version) {
                    // Update the checksum in _sqlx_migrations to match the current file
                    sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
                        .bind(&*migration.checksum)
                        .bind(version)
                        .execute(pool)
                        .await?;
                } else {
                    // Migration not found in current set, can't fix
                    return Err(sqlx::Error::Migrate(Box::new(
                        MigrateError::VersionMismatch(version),
                    )));
                }
            }
            Err(e) => return Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::auto_fix_migration_checksum_mismatch_enabled;

    #[test]
    fn strict_migrations_env_disables_auto_fix() {
        assert!(!auto_fix_migration_checksum_mismatch_enabled(Some(
            "1".into()
        )));
    }
}

#[derive(Clone)]
pub struct DBService {
    pub pool: Pool<Sqlite>,
}

impl DBService {
    pub async fn new() -> Result<DBService, Error> {
        let database_url = format!(
            "sqlite://{}",
            asset_dir().join("db.sqlite").to_string_lossy()
        );
        let options = SqliteConnectOptions::from_str(&database_url)?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Delete);
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
        let pool = Self::create_pool(Some(Arc::new(after_connect))).await?;
        Ok(DBService { pool })
    }

    async fn create_pool<F>(after_connect: Option<Arc<F>>) -> Result<Pool<Sqlite>, Error>
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
            asset_dir().join("db.sqlite").to_string_lossy()
        );
        let options = SqliteConnectOptions::from_str(&database_url)?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Delete);
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
