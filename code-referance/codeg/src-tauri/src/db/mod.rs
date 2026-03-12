pub mod entities;
pub mod error;
pub mod migration;
pub mod service;

use std::path::Path;
use std::time::Duration;

use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
};
use sea_orm_migration::MigratorTrait;

use error::DbError;
use migration::Migrator;

pub struct AppDatabase {
    pub conn: DatabaseConnection,
}

pub async fn init_database(
    app_data_dir: impl AsRef<Path>,
    app_version: &str,
) -> Result<AppDatabase, DbError> {
    let app_data_dir = app_data_dir.as_ref();
    std::fs::create_dir_all(app_data_dir)?;

    let db_path = app_data_dir.join("codeg.db");
    let db_url = format!(
        "sqlite:{}?mode=rwc",
        urlencoding::encode(&db_path.to_string_lossy())
    );

    let mut opts = ConnectOptions::new(db_url);
    opts.max_connections(5)
        .min_connections(1)
        .connect_timeout(Duration::from_secs(10))
        .idle_timeout(Duration::from_secs(300))
        .sqlx_logging(false);

    let conn = Database::connect(opts).await?;

    // SQLite performance and reliability pragmas
    conn.execute(Statement::from_string(
        DbBackend::Sqlite,
        "PRAGMA journal_mode=WAL;".to_owned(),
    ))
    .await?;
    conn.execute(Statement::from_string(
        DbBackend::Sqlite,
        "PRAGMA busy_timeout=5000;".to_owned(),
    ))
    .await?;
    conn.execute(Statement::from_string(
        DbBackend::Sqlite,
        "PRAGMA synchronous=NORMAL;".to_owned(),
    ))
    .await?;
    conn.execute(Statement::from_string(
        DbBackend::Sqlite,
        "PRAGMA foreign_keys=ON;".to_owned(),
    ))
    .await?;
    conn.execute(Statement::from_string(
        DbBackend::Sqlite,
        "PRAGMA cache_size=-8000;".to_owned(),
    ))
    .await?;

    Migrator::up(&conn, None)
        .await
        .map_err(|e| DbError::Migration(e.to_string()))?;

    service::app_metadata_service::update_app_version(&conn, app_version).await?;

    Ok(AppDatabase { conn })
}
