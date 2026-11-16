//! SQLite database health diagnostics and non-blocking WAL checkpoint optimization.
//!
//! # Safety Redlines
//! - [`optimize_wal`] executes **only** `PRAGMA wal_checkpoint(TRUNCATE)`.
//! - **NEVER** execute `VACUUM` here: `VACUUM` rebuilds the entire database file under an
//!   exclusive lock, stalls active `ReadPool` / `WritePool` connections, and requires up to
//!   2x peak disk space on multi-gigabyte event stores.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use ts_rs::TS;

use crate::{DBService, WritePool};

/// Point-in-time SQLite storage, WAL, fragmentation, and conversation row telemetry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct DbHealthReport {
    #[serde(alias = "page_count")]
    pub page_count: i64,
    #[serde(alias = "freelist_count")]
    pub freelist_count: i64,
    #[serde(alias = "fragmentation_ratio")]
    pub fragmentation_ratio: f64,
    #[serde(default, alias = "table_sizes")]
    pub table_sizes: HashMap<String, i64>,
    #[serde(alias = "wal_size_bytes")]
    pub wal_size_bytes: i64,
    #[serde(alias = "total_db_size_bytes")]
    pub total_db_size_bytes: i64,
    #[serde(alias = "conversation_count")]
    pub conversation_count: i64,
    #[serde(alias = "event_count")]
    pub event_count: i64,
    #[serde(alias = "timeline_row_count")]
    pub timeline_row_count: i64,
    #[serde(alias = "folded_event_count")]
    pub folded_event_count: i64,
}

/// Result of running `PRAGMA wal_checkpoint(TRUNCATE)` on the SQLite write pool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct DbOptimizeReport {
    #[serde(alias = "wal_size_before")]
    pub wal_size_before: i64,
    #[serde(alias = "wal_size_after")]
    pub wal_size_after: i64,
    #[serde(alias = "bytes_reclaimed")]
    pub bytes_reclaimed: i64,
}

/// Inspect database health through [`DBService`]'s read-only pool.
pub async fn check_db_service_health(
    db: &DBService,
    db_dir: Option<&Path>,
) -> Result<DbHealthReport, sqlx::Error> {
    check_health(db.reader().as_pool(), db_dir).await
}

/// Collect SQLite page metrics, table byte sizes, WAL size, and conversation entity counts.
///
/// Safe to execute on [`crate::ReadPool`] (`query_only = ON`).
pub async fn check_health(
    pool: &SqlitePool,
    db_dir: Option<&Path>,
) -> Result<DbHealthReport, sqlx::Error> {
    let page_count: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(pool)
        .await
        .unwrap_or(0);
    let freelist_count: i64 = sqlx::query_scalar("PRAGMA freelist_count")
        .fetch_one(pool)
        .await
        .unwrap_or(0);
    let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
        .fetch_one(pool)
        .await
        .unwrap_or(4096);

    let fragmentation_ratio = if page_count > 0 {
        (freelist_count.max(0) as f64) / (page_count as f64)
    } else {
        0.0
    };

    let db_file_path = resolve_db_file_path(pool, db_dir).await;
    let wal_size_bytes = db_file_path
        .as_deref()
        .map(wal_file_size_bytes)
        .unwrap_or(0);
    let main_file_bytes = db_file_path
        .as_deref()
        .and_then(|path| std::fs::metadata(path).ok().map(|m| m.len() as i64))
        .unwrap_or_else(|| page_count.saturating_mul(page_size));
    let total_db_size_bytes = main_file_bytes.saturating_add(wal_size_bytes);

    let table_sizes = collect_table_sizes(pool, page_size).await;

    let conversation_count = count_if_table_exists(
        pool,
        "sessions",
        "SELECT COUNT(*) FROM sessions WHERE deleted_at IS NULL",
    )
    .await?;
    let event_count = count_if_table_exists(
        pool,
        "conversation_events",
        "SELECT COUNT(*) FROM conversation_events",
    )
    .await?;
    let timeline_row_count = count_if_table_exists(
        pool,
        "conversation_timeline_rows",
        "SELECT COUNT(*) FROM conversation_timeline_rows WHERE deleted_sequence IS NULL",
    )
    .await?;
    let folded_event_count = count_if_table_exists(
        pool,
        "conversation_events",
        "SELECT COUNT(*) FROM conversation_events \
         WHERE source = 'folded' \
            OR event_kind LIKE 'folded_%' \
            OR (raw_json IS NOT NULL AND json_valid(raw_json) = 1 \
                AND json_extract(raw_json, '$.folded') = 1)",
    )
    .await?;

    Ok(DbHealthReport {
        page_count,
        freelist_count,
        fragmentation_ratio,
        table_sizes,
        wal_size_bytes,
        total_db_size_bytes,
        conversation_count,
        event_count,
        timeline_row_count,
        folded_event_count,
    })
}

/// Checkpoint and truncate the SQLite Write-Ahead Log via `PRAGMA wal_checkpoint(TRUNCATE)`.
///
/// Never runs `VACUUM`. Safe to invoke online while [`crate::ReadPool`] readers are active.
pub async fn optimize_wal(
    write_pool: &WritePool,
    db_dir: Option<&Path>,
) -> Result<DbOptimizeReport, sqlx::Error> {
    optimize_wal_on_pool(write_pool.as_pool(), db_dir).await
}

/// Pool-level helper for [`optimize_wal`].
pub async fn optimize_wal_on_pool(
    pool: &SqlitePool,
    db_dir: Option<&Path>,
) -> Result<DbOptimizeReport, sqlx::Error> {
    let db_file_path = resolve_db_file_path(pool, db_dir).await;
    let wal_size_before = db_file_path
        .as_deref()
        .map(wal_file_size_bytes)
        .unwrap_or(0);

    // Execute ONLY `PRAGMA wal_checkpoint(TRUNCATE)` — NEVER `VACUUM`.
    let _checkpoint_row: (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
        .fetch_one(pool)
        .await?;

    let wal_size_after = db_file_path
        .as_deref()
        .map(wal_file_size_bytes)
        .unwrap_or(0);
    let bytes_reclaimed = wal_size_before.saturating_sub(wal_size_after).max(0);

    Ok(DbOptimizeReport {
        wal_size_before,
        wal_size_after,
        bytes_reclaimed,
    })
}

async fn resolve_db_file_path(pool: &SqlitePool, db_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = db_dir {
        let candidate = if dir.is_file() {
            dir.to_path_buf()
        } else {
            dir.join("db.sqlite")
        };
        if candidate.exists() {
            return Some(candidate);
        }
    }

    let file_col: Option<String> =
        sqlx::query_scalar("SELECT file FROM pragma_database_list WHERE name = 'main' LIMIT 1")
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();

    file_col
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !s.starts_with("file:dimo_mem_"))
        .map(PathBuf::from)
        .filter(|p| p.exists())
}

fn wal_file_size_bytes(db_file: &Path) -> i64 {
    let mut os = db_file.as_os_str().to_os_string();
    os.push("-wal");
    let wal_path = PathBuf::from(os);
    std::fs::metadata(wal_path)
        .map(|m| m.len() as i64)
        .unwrap_or(0)
}

async fn table_exists(pool: &SqlitePool, table_name: &str) -> Result<bool, sqlx::Error> {
    let exists: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?)",
    )
    .bind(table_name)
    .fetch_one(pool)
    .await?;
    Ok(exists != 0)
}

async fn count_if_table_exists(
    pool: &SqlitePool,
    table_name: &str,
    query: &str,
) -> Result<i64, sqlx::Error> {
    if !table_exists(pool, table_name).await? {
        return Ok(0);
    }
    sqlx::query_scalar(query).fetch_one(pool).await
}

async fn collect_table_sizes(pool: &SqlitePool, page_size: i64) -> HashMap<String, i64> {
    // Prefer SQLite's built-in `dbstat` virtual table when compiled into libsqlite3.
    if let Ok(rows) = sqlx::query(
        "SELECT name, CAST(SUM(pgsize) AS INTEGER) AS total_bytes \
         FROM dbstat \
         WHERE name NOT LIKE 'sqlite_%' \
         GROUP BY name",
    )
    .fetch_all(pool)
    .await
        && !rows.is_empty()
    {
        let mut sizes = HashMap::with_capacity(rows.len());
        for row in rows {
            if let (Ok(name), Ok(bytes)) = (
                row.try_get::<String, _>("name"),
                row.try_get::<i64, _>("total_bytes"),
            ) {
                sizes.insert(name, bytes.max(0));
            }
        }
        if !sizes.is_empty() {
            return sizes;
        }
    }

    // Fallback when `SQLITE_ENABLE_DBSTAT_VTAB` is disabled: estimate payload bytes on key tables.
    let mut fallback = HashMap::new();
    let tracked_tables: &[(&str, &str)] = &[
        (
            "conversation_events",
            "SELECT COALESCE(SUM(LENGTH(normalized_json) + COALESCE(LENGTH(raw_json), 0) + 128), 0) FROM conversation_events",
        ),
        (
            "conversation_timeline_rows",
            "SELECT COALESCE(SUM(byte_len + 96), 0) FROM conversation_timeline_rows",
        ),
        (
            "conversation_projection_snapshots",
            "SELECT COALESCE(SUM(LENGTH(fold_json) + COALESCE(LENGTH(session_stats_json), 0) + 96), 0) FROM conversation_projection_snapshots",
        ),
        ("sessions", "SELECT COUNT(*) * 512 FROM sessions"),
        (
            "conversation_turns",
            "SELECT COUNT(*) * 384 FROM conversation_turns",
        ),
    ];

    for (table, sql) in tracked_tables {
        if table_exists(pool, table).await.unwrap_or(false)
            && let Ok(bytes) = sqlx::query_scalar::<_, i64>(sql).fetch_one(pool).await
        {
            fallback.insert((*table).to_string(), bytes.max(page_size.min(bytes)));
        }
    }
    fallback
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_check_and_wal_optimize_work_on_disk_backed_db_service() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = DBService::new_at(dir.path())
            .await
            .expect("open disk DBService");

        let project_id = uuid::Uuid::new_v4();
        let task_id = uuid::Uuid::new_v4();
        let conv_id = uuid::Uuid::new_v4();
        let ws_id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO projects (id, name, root_path, hidden) VALUES (?, 'Health Project', ?, 0)")
            .bind(project_id)
            .bind(dir.path().to_string_lossy().to_string())
            .execute(db.writer().as_pool())
            .await
            .expect("insert project");
        sqlx::query("INSERT INTO tasks (id, project_id, title, status) VALUES (?, ?, 'Health Task', 'todo')")
            .bind(task_id)
            .bind(project_id)
            .execute(db.writer().as_pool())
            .await
            .expect("insert task");
        sqlx::query("INSERT INTO workspaces (id, project_id, task_id, branch, use_worktree) VALUES (?, ?, ?, 'main', 0)")
            .bind(ws_id)
            .bind(project_id)
            .bind(task_id)
            .execute(db.writer().as_pool())
            .await
            .expect("insert workspace");
        sqlx::query(
            "INSERT INTO sessions (id, workspace_id, name, status, created_at, updated_at) \
             VALUES (?, ?, 'Health Test', 'todo', datetime('now'), datetime('now'))",
        )
        .bind(conv_id)
        .bind(ws_id)
        .execute(db.writer().as_pool())
        .await
        .expect("insert session");

        // Insert one regular event and one folded event.
        for (seq, source, raw_json) in [
            (1_i64, "acp", None),
            (2_i64, "acp", Some(r#"{"folded":true,"event_count":8}"#)),
        ] {
            sqlx::query(
                "INSERT INTO conversation_events \
                 (id, conversation_id, sequence, source, event_kind, event_version, normalized_json, raw_json) \
                 VALUES (?, ?, ?, ?, 'assistant_text_delta', 1, ?, ?)",
            )
            .bind(uuid::Uuid::new_v4())
            .bind(conv_id)
            .bind(seq)
            .bind(source)
            .bind(r#"{"kind":"assistant_text_delta","text":"chunk"}"#)
            .bind(raw_json)
            .execute(db.writer().as_pool())
            .await
            .expect("insert event");
        }

        let report = check_db_service_health(&db, Some(dir.path()))
            .await
            .expect("check_health");
        assert!(report.page_count > 0);
        assert!(report.total_db_size_bytes > 0);
        assert_eq!(report.conversation_count, 1);
        assert_eq!(report.event_count, 2);
        assert_eq!(report.folded_event_count, 1);
        assert!((0.0..=1.0).contains(&report.fragmentation_ratio));

        let json = serde_json::to_value(&report).expect("serialize health report");
        assert_eq!(json["conversationCount"], 1);
        assert_eq!(json["foldedEventCount"], 1);

        let opt = optimize_wal(db.writer(), Some(dir.path()))
            .await
            .expect("optimize_wal");
        assert_eq!(opt.wal_size_after, 0);
        assert!(opt.bytes_reclaimed >= 0);
    }
}
