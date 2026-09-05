use sqlx::{Executor, FromRow, Sqlite, SqlitePool};

/// Stamp for one vendor jsonl file. Unchanged mtime+size means skip parse.
#[derive(Debug, Clone, FromRow)]
pub struct VendorUsageFileRecord {
    pub path: String,
    pub provider: String,
    pub mtime_ms: i64,
    pub size: i64,
    pub scanned_at_ms: i64,
}

/// One vendor session's token breakdown, keyed by the vendor's session id.
#[derive(Debug, Clone, FromRow)]
pub struct VendorUsageSessionRecord {
    pub provider: String,
    pub external_session_id: String,
    pub source_path: String,
    pub timestamp: i64,
    pub model: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub cost: Option<f64>,
    pub summary: Option<String>,
    pub scanned_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct VendorUsageFileUpdate {
    pub path: String,
    pub provider: String,
    pub mtime_ms: i64,
    pub size: i64,
    pub session: Option<VendorUsageSessionRecord>,
}

impl VendorUsageFileRecord {
    pub async fn list<'e, E>(executor: E) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(
            r#"SELECT path, provider, mtime_ms, size, scanned_at_ms
               FROM vendor_usage_files"#,
        )
        .fetch_all(executor)
        .await
    }
}

impl VendorUsageSessionRecord {
    pub async fn list_all<'e, E>(executor: E) -> Result<Vec<Self>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, Self>(
            r#"SELECT provider,
                      external_session_id,
                      source_path,
                      timestamp,
                      model,
                      input_tokens,
                      output_tokens,
                      cache_write_tokens,
                      cache_read_tokens,
                      total_tokens,
                      cost,
                      summary,
                      scanned_at_ms
               FROM vendor_usage_sessions"#,
        )
        .fetch_all(executor)
        .await
    }

    pub async fn count_by_provider<'e, E>(executor: E) -> Result<Vec<(String, i64)>, sqlx::Error>
    where
        E: Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as::<_, (String, i64)>(
            r#"SELECT provider, COUNT(*) FROM vendor_usage_sessions GROUP BY provider"#,
        )
        .fetch_all(executor)
        .await
    }
}

/// Persist one incremental scan: upsert changed files, drop rows for files that
/// vanished from providers that listed successfully.
pub async fn apply_vendor_usage_scan(
    pool: &SqlitePool,
    updates: &[VendorUsageFileUpdate],
    live_paths: &[String],
    successful_providers: &[String],
    now_ms: i64,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    for update in updates {
        sqlx::query("DELETE FROM vendor_usage_sessions WHERE source_path = ?")
            .bind(&update.path)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            r#"INSERT INTO vendor_usage_files (path, provider, mtime_ms, size, scanned_at_ms)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(path) DO UPDATE SET
                   provider = excluded.provider,
                   mtime_ms = excluded.mtime_ms,
                   size = excluded.size,
                   scanned_at_ms = excluded.scanned_at_ms"#,
        )
        .bind(&update.path)
        .bind(&update.provider)
        .bind(update.mtime_ms)
        .bind(update.size)
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;

        if let Some(session) = &update.session {
            sqlx::query(
                r#"INSERT INTO vendor_usage_sessions (
                       provider,
                       external_session_id,
                       source_path,
                       timestamp,
                       model,
                       input_tokens,
                       output_tokens,
                       cache_write_tokens,
                       cache_read_tokens,
                       total_tokens,
                       cost,
                       summary,
                       scanned_at_ms
                   )
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(provider, external_session_id) DO UPDATE SET
                       source_path = excluded.source_path,
                       timestamp = excluded.timestamp,
                       model = excluded.model,
                       input_tokens = excluded.input_tokens,
                       output_tokens = excluded.output_tokens,
                       cache_write_tokens = excluded.cache_write_tokens,
                       cache_read_tokens = excluded.cache_read_tokens,
                       total_tokens = excluded.total_tokens,
                       cost = excluded.cost,
                       summary = excluded.summary,
                       scanned_at_ms = excluded.scanned_at_ms"#,
            )
            .bind(&session.provider)
            .bind(&session.external_session_id)
            .bind(&update.path)
            .bind(session.timestamp)
            .bind(session.model.as_deref())
            .bind(session.input_tokens)
            .bind(session.output_tokens)
            .bind(session.cache_write_tokens)
            .bind(session.cache_read_tokens)
            .bind(session.total_tokens)
            .bind(session.cost)
            .bind(session.summary.as_deref())
            .bind(now_ms)
            .execute(&mut *tx)
            .await?;
        }
    }

    let live: std::collections::HashSet<&str> = live_paths.iter().map(String::as_str).collect();
    if !successful_providers.is_empty() {
        let existing = sqlx::query_as::<_, (String, String)>(
            r#"SELECT path, provider FROM vendor_usage_files"#,
        )
        .fetch_all(&mut *tx)
        .await?;
        for (path, provider) in existing {
            if !successful_providers.iter().any(|item| item == &provider) {
                continue;
            }
            if live.contains(path.as_str()) {
                continue;
            }
            sqlx::query("DELETE FROM vendor_usage_sessions WHERE source_path = ?")
                .bind(&path)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM vendor_usage_files WHERE path = ?")
                .bind(&path)
                .execute(&mut *tx)
                .await?;
        }
    }

    tx.commit().await?;
    Ok(())
}
