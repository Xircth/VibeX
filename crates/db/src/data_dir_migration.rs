use std::{
    path::{Path, PathBuf},
    str::FromStr,
};

use serde_json::Value;
use sqlx::{
    Error, Row, SqliteConnection, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};

pub async fn checkpoint_and_remap_data_dir_paths(
    pool: &SqlitePool,
    old_dir: &Path,
    new_dir: &Path,
) -> Result<(), Error> {
    remap_sqlite_data_dir_paths(pool, old_dir, new_dir).await?;
    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(pool)
        .await;
    Ok(())
}

pub async fn remap_sqlite_file_data_dir_paths(
    db_file: &Path,
    old_dir: &Path,
    new_dir: &Path,
) -> Result<(), Error> {
    let options =
        SqliteConnectOptions::from_str(&format!("sqlite://{}", db_file.to_string_lossy()))?
            .create_if_missing(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    let res = remap_sqlite_data_dir_paths(&pool, old_dir, new_dir).await;
    let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool)
        .await;
    pool.close().await;
    res
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DbContentSummary {
    pub conversation_count: i64,
    pub project_count: i64,
}

impl DbContentSummary {
    pub fn has_user_data(&self) -> bool {
        self.conversation_count > 0 || self.project_count > 0
    }
}

/// Inspects an existing `db.sqlite` file without running migrations so startup
/// data-directory adoption can tell a populated database apart from an empty
/// freshly-initialized schema.
pub async fn inspect_sqlite_content_summary(db_file: &Path) -> Option<DbContentSummary> {
    if !db_file.is_file() {
        return None;
    }
    let options = SqliteConnectOptions::new()
        .filename(db_file)
        .create_if_missing(false)
        .read_only(true);
    let pool = match SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
    {
        Ok(pool) => pool,
        Err(_) => {
            // A read-only directory containing an uncheckpointed -wal file can
            // reject normal read-only opens unless opened immutable.
            let immutable = SqliteConnectOptions::new()
                .filename(db_file)
                .create_if_missing(false)
                .read_only(true)
                .immutable(true);
            SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(immutable)
                .await
                .ok()?
        }
    };

    let conversation_count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM conversations")
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
    let project_count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM projects")
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
    pool.close().await;

    Some(DbContentSummary {
        conversation_count,
        project_count,
    })
}

const MANAGED_PATH_TARGETS: &[(&str, &str)] = &[
    ("workspaces", "container_ref"),
    ("workspaces", "agent_working_dir"),
    ("repos", "path"),
    ("projects", "root_path"),
    ("collaboration_space_collection_items", "file_path"),
    ("conversation_agent_bindings", "working_dir"),
    ("agent_connections", "working_dir"),
    ("plugin_packages_v4", "source_path"),
    ("plugin_control_registry", "source_path"),
    ("plugin_runtime_artifacts_v4", "absolute_entrypoint"),
    ("plugin_runtime_locks_v4", "absolute_entrypoint"),
    ("plugin_control_runtime_inventory", "executable_path"),
    ("plugin_v2_dependency_state", "executable_path"),
    ("agent_install_component", "absolute_path"),
    ("agent_config_binding", "absolute_path"),
    ("agent_install_operation", "staging_path"),
    ("agent_setting", "runtime_cli_path"),
    ("agent_setting", "runtime_acp_path"),
    ("workflow_definition_versions", "source_path"),
    ("artifact_revisions", "tool_executable_path"),
];

async fn table_columns(conn: &mut SqliteConnection, table: &str) -> Result<Vec<String>, Error> {
    let sql = format!("PRAGMA table_info({table})");
    let rows = sqlx::query(&sql).fetch_all(conn).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("name").ok())
        .collect())
}

fn table_has_all_columns(columns: &[String], required: &[&str]) -> bool {
    required
        .iter()
        .all(|name| columns.iter().any(|col| col == name))
}

fn remap_plugin_package_json(raw: &str, old_dir: &Path, new_dir: &Path) -> Option<String> {
    let mut root = serde_json::from_str::<Value>(raw).ok()?;
    let mut changed = false;
    if let Some(Value::String(source_path)) = root
        .get_mut("source")
        .and_then(|source| source.get_mut("path"))
        && let Some(remapped) =
            utils::path::remap_path_string_prefix(source_path, old_dir, new_dir)
        && remapped != *source_path
    {
        *source_path = remapped;
        changed = true;
    }
    if let Some(Value::String(exec_root)) = root.get_mut("executionRoot")
        && let Some(remapped) = utils::path::remap_path_string_prefix(exec_root, old_dir, new_dir)
        && remapped != *exec_root
    {
        *exec_root = remapped;
        changed = true;
    }
    if changed {
        serde_json::to_string(&root).ok()
    } else {
        None
    }
}

pub async fn remap_sqlite_data_dir_paths(
    pool: &SqlitePool,
    old_dir: &Path,
    new_dir: &Path,
) -> Result<(), Error> {
    let old_norm = utils::path::normalize_windows_extended_path_prefix(old_dir);
    let new_norm = utils::path::normalize_windows_extended_path_prefix(new_dir);
    let old_trimmed = old_norm
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_string();
    let new_trimmed = new_norm
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_string();
    if old_trimmed.is_empty()
        || if cfg!(windows) {
            old_trimmed.eq_ignore_ascii_case(&new_trimmed)
        } else {
            old_trimmed == new_trimmed
        }
    {
        return Ok(());
    }

    let mut tx = pool.begin().await?;

    for (table, column) in MANAGED_PATH_TARGETS {
        let cols = table_columns(&mut tx, table).await?;
        if !table_has_all_columns(&cols, &[column]) {
            continue;
        }
        let select_sql = format!(
            "SELECT DISTINCT {column} FROM {table} WHERE {column} IS NOT NULL AND {column} <> ''"
        );
        let values: Vec<String> = sqlx::query_scalar(&select_sql).fetch_all(&mut *tx).await?;
        let update_sql = format!("UPDATE {table} SET {column} = ?1 WHERE {column} = ?2");
        for old_value in values {
            if let Some(new_value) =
                utils::path::remap_path_string_prefix(&old_value, old_dir, new_dir)
                && new_value != old_value
            {
                sqlx::query(&update_sql)
                    .bind(&new_value)
                    .bind(&old_value)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }

    let v4_cols = table_columns(&mut tx, "plugin_packages_v4").await?;
    if table_has_all_columns(
        &v4_cols,
        &["publisher", "plugin_id", "package_digest", "package_json"],
    ) {
        let rows: Vec<(String, String, String, String)> = sqlx::query_as(
            "SELECT publisher, plugin_id, package_digest, package_json FROM plugin_packages_v4",
        )
        .fetch_all(&mut *tx)
        .await?;
        for (publisher, plugin_id, package_digest, package_json) in rows {
            if let Some(updated_json) = remap_plugin_package_json(&package_json, old_dir, new_dir) {
                sqlx::query(
                    "UPDATE plugin_packages_v4 SET package_json = ?1 \
                     WHERE publisher = ?2 AND plugin_id = ?3 AND package_digest = ?4",
                )
                .bind(&updated_json)
                .bind(&publisher)
                .bind(&plugin_id)
                .bind(&package_digest)
                .execute(&mut *tx)
                .await?;
            }
        }
    }

    let legacy_plugin_cols = table_columns(&mut tx, "plugin_control_registry").await?;
    if table_has_all_columns(&legacy_plugin_cols, &["plugin_id", "package_json"]) {
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT plugin_id, package_json FROM plugin_control_registry")
                .fetch_all(&mut *tx)
                .await?;
        for (plugin_id, package_json) in rows {
            if let Some(updated_json) = remap_plugin_package_json(&package_json, old_dir, new_dir) {
                sqlx::query("UPDATE plugin_control_registry SET package_json = ?1 WHERE plugin_id = ?2")
                    .bind(&updated_json)
                    .bind(&plugin_id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }

    tx.commit().await?;
    Ok(())
}

fn infer_old_data_dir_from_plugin_source_path(
    raw_path: &str,
    current_data_dir: &Path,
) -> Option<PathBuf> {
    const SNAPSHOT_MARKERS: &[&str] = &[
        "/plugins/runtimes/plugins/snapshots/",
        "/plugins/snapshots/",
        "/builtin-plugins/",
    ];
    let normalized = utils::path::normalize_windows_extended_path_prefix(Path::new(raw_path));
    let slash = normalized.to_string_lossy().replace('\\', "/");
    let lower_slash = slash.to_ascii_lowercase();

    for marker in SNAPSHOT_MARKERS {
        let Some(idx) = lower_slash.find(marker) else {
            continue;
        };
        if idx == 0 {
            continue;
        }
        let old_base = &slash[..idx];
        let relative = &slash[idx + 1..];
        if relative.is_empty() {
            continue;
        }
        let old_dir = PathBuf::from(old_base);
        if utils::assets::same_data_dir(&old_dir, current_data_dir) {
            continue;
        }
        let candidate = current_data_dir.join(relative);
        if candidate.exists() {
            return Some(old_dir);
        }
    }
    None
}

/// Reconciles paths in `pool` for databases already moved or copied into
/// `data_dir` by an earlier version of Dimo before plugin/runtime/Windows-verbatim
/// remapping existed.
pub async fn reconcile_migrated_data_dir_paths(
    pool: &SqlitePool,
    data_dir: &Path,
) -> Result<Vec<PathBuf>, Error> {
    let mut candidates = Vec::<PathBuf>::new();
    let mut push_candidate = |dir: PathBuf| {
        if utils::assets::same_data_dir(&dir, data_dir) {
            return;
        }
        if !candidates
            .iter()
            .any(|existing| utils::assets::same_data_dir(existing, &dir))
        {
            candidates.push(dir);
        }
    };

    for recorded in utils::assets::read_adopted_legacy_sources(data_dir) {
        push_candidate(recorded);
    }

    let mut conn = pool.acquire().await?;
    let v4_cols = table_columns(&mut conn, "plugin_packages_v4").await?;
    if table_has_all_columns(&v4_cols, &["source_path", "package_json"]) {
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT DISTINCT source_path, package_json FROM plugin_packages_v4")
                .fetch_all(&mut *conn)
                .await?;
        for (source_path, package_json) in rows {
            if let Some(old_dir) = infer_old_data_dir_from_plugin_source_path(&source_path, data_dir)
            {
                push_candidate(old_dir);
            }
            if let Ok(parsed) = serde_json::from_str::<Value>(&package_json) {
                if let Some(src_path) = parsed
                    .get("source")
                    .and_then(|source| source.get("path"))
                    .and_then(Value::as_str)
                    && let Some(old_dir) =
                        infer_old_data_dir_from_plugin_source_path(src_path, data_dir)
                {
                    push_candidate(old_dir);
                }
                if let Some(exec_root) = parsed.get("executionRoot").and_then(Value::as_str)
                    && let Some(old_dir) =
                        infer_old_data_dir_from_plugin_source_path(exec_root, data_dir)
                {
                    push_candidate(old_dir);
                }
            }
        }
    }

    let legacy_cols = table_columns(&mut conn, "plugin_control_registry").await?;
    if table_has_all_columns(&legacy_cols, &["source_path", "package_json"]) {
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT DISTINCT source_path, package_json FROM plugin_control_registry")
                .fetch_all(&mut *conn)
                .await?;
        for (source_path, package_json) in rows {
            if let Some(old_dir) = infer_old_data_dir_from_plugin_source_path(&source_path, data_dir)
            {
                push_candidate(old_dir);
            }
            if let Ok(parsed) = serde_json::from_str::<Value>(&package_json)
                && let Some(src_path) = parsed
                    .get("source")
                    .and_then(|source| source.get("path"))
                    .and_then(Value::as_str)
                && let Some(old_dir) =
                    infer_old_data_dir_from_plugin_source_path(src_path, data_dir)
            {
                push_candidate(old_dir);
            }
        }
    }
    drop(conn);

    for old_dir in &candidates {
        remap_sqlite_data_dir_paths(pool, old_dir, data_dir).await?;
    }

    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn remap_sqlite_file_data_dir_paths_rewrites_managed_paths_and_preserves_external() {
        let temp = tempfile::tempdir().expect("tempdir");
        let old_dir = temp.path().join("old_data");
        let new_dir = temp.path().join("new_data");
        std::fs::create_dir_all(&new_dir).expect("mkdir new_data");

        let db_path = new_dir.join("db.sqlite");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true),
            )
            .await
            .expect("open sqlite");

        sqlx::query(
            "CREATE TABLE workspaces (id TEXT PRIMARY KEY, container_ref TEXT, agent_working_dir TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE repos (id TEXT PRIMARY KEY, path TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE projects (id TEXT PRIMARY KEY, root_path TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE collaboration_space_collection_items (id TEXT PRIMARY KEY, file_path TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let old_wt = format!("{}/worktrees/wt-1", old_dir.to_string_lossy());
        let old_repo = format!("{}\\repos\\repo-1", old_dir.to_string_lossy());
        let external_repo = "D:/external/project".to_string();
        let old_doc = format!("{}/spaces/sp-1/doc.md", old_dir.to_string_lossy());

        sqlx::query(
            "INSERT INTO workspaces (id, container_ref, agent_working_dir) VALUES ('w1', ?1, ?1)",
        )
        .bind(&old_wt)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO repos (id, path) VALUES ('r1', ?1), ('r2', ?2)")
            .bind(&old_repo)
            .bind(&external_repo)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO projects (id, root_path) VALUES ('p1', ?1)")
            .bind(&old_repo)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO collaboration_space_collection_items (id, file_path) VALUES ('c1', ?1)",
        )
        .bind(&old_doc)
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        remap_sqlite_file_data_dir_paths(&db_path, &old_dir, &new_dir)
            .await
            .expect("remap sqlite");

        let check_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(&db_path))
            .await
            .expect("open migrated sqlite");

        let migrated_wt: String =
            sqlx::query_scalar("SELECT container_ref FROM workspaces WHERE id = 'w1'")
                .fetch_one(&check_pool)
                .await
                .unwrap();
        assert!(
            migrated_wt.ends_with("worktrees/wt-1"),
            "unexpected container_ref: {migrated_wt}"
        );
        assert!(!migrated_wt.contains("old_data"));

        let migrated_repo: String = sqlx::query_scalar("SELECT path FROM repos WHERE id = 'r1'")
            .fetch_one(&check_pool)
            .await
            .unwrap();
        assert!(!migrated_repo.contains("old_data"));

        let untouched_external: String =
            sqlx::query_scalar("SELECT path FROM repos WHERE id = 'r2'")
                .fetch_one(&check_pool)
                .await
                .unwrap();
        assert_eq!(untouched_external, external_repo);

        let migrated_doc: String = sqlx::query_scalar(
            "SELECT file_path FROM collaboration_space_collection_items WHERE id = 'c1'",
        )
        .fetch_one(&check_pool)
        .await
        .unwrap();
        assert!(!migrated_doc.contains("old_data"));
        check_pool.close().await;
    }

    #[tokio::test]
    async fn inspect_sqlite_content_summary_distinguishes_populated_empty_and_missing() {
        let temp = tempfile::tempdir().expect("tempdir");
        let missing = temp.path().join("missing.sqlite");
        assert_eq!(inspect_sqlite_content_summary(&missing).await, None);

        let empty_db = temp.path().join("empty.sqlite");
        let empty_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&empty_db)
                    .create_if_missing(true),
            )
            .await
            .expect("open empty sqlite");
        sqlx::query("CREATE TABLE conversations (id TEXT PRIMARY KEY)")
            .execute(&empty_pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE projects (id TEXT PRIMARY KEY)")
            .execute(&empty_pool)
            .await
            .unwrap();
        empty_pool.close().await;

        let empty_summary = inspect_sqlite_content_summary(&empty_db)
            .await
            .expect("empty summary");
        assert!(!empty_summary.has_user_data());
        assert_eq!(empty_summary.conversation_count, 0);
        assert_eq!(empty_summary.project_count, 0);

        let populated_db = temp.path().join("populated.sqlite");
        let pop_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&populated_db)
                    .create_if_missing(true),
            )
            .await
            .expect("open populated sqlite");
        sqlx::query("CREATE TABLE conversations (id TEXT PRIMARY KEY)")
            .execute(&pop_pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE projects (id TEXT PRIMARY KEY)")
            .execute(&pop_pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO conversations (id) VALUES ('c1'), ('c2')")
            .execute(&pop_pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO projects (id) VALUES ('p1')")
            .execute(&pop_pool)
            .await
            .unwrap();
        pop_pool.close().await;

        let pop_summary = inspect_sqlite_content_summary(&populated_db)
            .await
            .expect("populated summary");
        assert!(pop_summary.has_user_data());
        assert_eq!(pop_summary.conversation_count, 2);
        assert_eq!(pop_summary.project_count, 1);
    }

    #[tokio::test]
    async fn remap_sqlite_rewrites_plugin_v4_verbatim_paths_and_runtime_locks() {
        let temp = tempfile::tempdir().expect("tempdir");
        let old_dir = temp.path().join("Local").join("Dimo").join("data");
        let new_dir = temp.path().join("Roaming").join("dimo").join("dimo").join("data");
        std::fs::create_dir_all(&new_dir).expect("mkdir new_dir");

        let db_path = new_dir.join("db.sqlite");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true),
            )
            .await
            .expect("open sqlite");

        sqlx::query(
            "CREATE TABLE plugin_packages_v4 (
                publisher TEXT NOT NULL,
                plugin_id TEXT NOT NULL,
                version TEXT NOT NULL,
                package_digest TEXT NOT NULL,
                source_kind TEXT NOT NULL,
                source_path TEXT NOT NULL,
                manifest_json TEXT NOT NULL,
                package_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (publisher, plugin_id, package_digest)
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE plugin_runtime_artifacts_v4 (
                runtime_id TEXT NOT NULL,
                version TEXT NOT NULL,
                target TEXT NOT NULL,
                content_digest TEXT NOT NULL,
                absolute_entrypoint TEXT NOT NULL,
                PRIMARY KEY (runtime_id, version, target, content_digest)
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE plugin_runtime_locks_v4 (
                plugin_id TEXT NOT NULL,
                package_digest TEXT NOT NULL,
                runtime_id TEXT NOT NULL,
                target TEXT NOT NULL,
                absolute_entrypoint TEXT NOT NULL,
                PRIMARY KEY (plugin_id, package_digest, runtime_id, target)
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        let verbatim_source = format!(
            r"\\?\{}\plugins\runtimes\plugins\snapshots\dimo.browser",
            old_dir.to_string_lossy()
        );
        let verbatim_exec_root = format!(
            r"\\?\{}\plugins\runtimes\plugins\snapshots\dimo.browser",
            old_dir.to_string_lossy()
        );
        let package_json = serde_json::json!({
            "id": "dimo.browser",
            "source": {
                "kind": "marketplace",
                "path": verbatim_source,
            },
            "executionRoot": verbatim_exec_root,
        })
        .to_string();
        let runtime_entry = format!(
            r"{}\plugins\runtimes\node\node.exe",
            old_dir.to_string_lossy()
        );

        sqlx::query(
            "INSERT INTO plugin_packages_v4
             (publisher, plugin_id, version, package_digest, source_kind, source_path, manifest_json, package_json, created_at)
             VALUES ('dimo', 'dimo.browser', '1.0.0', 'd1', 'marketplace', ?1, '{}', ?2, '2026-01-01')",
        )
        .bind(&verbatim_source)
        .bind(&package_json)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO plugin_runtime_artifacts_v4
             (runtime_id, version, target, content_digest, absolute_entrypoint)
             VALUES ('node', '22', 'win32', 'c1', ?1)",
        )
        .bind(&runtime_entry)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO plugin_runtime_locks_v4
             (plugin_id, package_digest, runtime_id, target, absolute_entrypoint)
             VALUES ('dimo.browser', 'd1', 'node', 'win32', ?1)",
        )
        .bind(&runtime_entry)
        .execute(&pool)
        .await
        .unwrap();

        remap_sqlite_data_dir_paths(&pool, &old_dir, &new_dir)
            .await
            .expect("remap sqlite");

        let (remapped_col, remapped_json): (String, String) = sqlx::query_as(
            "SELECT source_path, package_json FROM plugin_packages_v4 WHERE plugin_id = 'dimo.browser'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let expected_snapshot = new_dir
            .join("plugins")
            .join("runtimes")
            .join("plugins")
            .join("snapshots")
            .join("dimo.browser")
            .to_string_lossy()
            .into_owned();
        assert_eq!(remapped_col, expected_snapshot);
        let parsed: Value = serde_json::from_str(&remapped_json).unwrap();
        assert_eq!(parsed["source"]["path"].as_str(), Some(expected_snapshot.as_str()));
        assert_eq!(
            parsed["executionRoot"].as_str(),
            Some(expected_snapshot.as_str())
        );

        let artifact_entry: String =
            sqlx::query_scalar("SELECT absolute_entrypoint FROM plugin_runtime_artifacts_v4")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(artifact_entry.starts_with(&*new_dir.to_string_lossy()));
        assert!(!artifact_entry.contains("Local"));

        let lock_entry: String =
            sqlx::query_scalar("SELECT absolute_entrypoint FROM plugin_runtime_locks_v4")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(lock_entry, artifact_entry);

        pool.close().await;
    }

    #[tokio::test]
    async fn reconcile_migrated_data_dir_paths_heals_via_snapshot_inference_without_marker() {
        let temp = tempfile::tempdir().expect("tempdir");
        let old_dir = temp.path().join("Local").join("Dimo").join("data");
        let new_dir = temp.path().join("Roaming").join("dimo").join("dimo").join("data");
        let live_snapshot = new_dir
            .join("plugins")
            .join("runtimes")
            .join("plugins")
            .join("snapshots")
            .join("dimo.browser");
        std::fs::create_dir_all(&live_snapshot).expect("mkdir live snapshot");

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(new_dir.join("db.sqlite"))
                    .create_if_missing(true),
            )
            .await
            .expect("open sqlite");

        sqlx::query(
            "CREATE TABLE plugin_packages_v4 (
                publisher TEXT NOT NULL,
                plugin_id TEXT NOT NULL,
                version TEXT NOT NULL,
                package_digest TEXT NOT NULL,
                source_kind TEXT NOT NULL,
                source_path TEXT NOT NULL,
                manifest_json TEXT NOT NULL,
                package_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (publisher, plugin_id, package_digest)
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        let stale_source = format!(
            r"\\?\{}\plugins\runtimes\plugins\snapshots\dimo.browser",
            old_dir.to_string_lossy()
        );
        let stale_json = serde_json::json!({
            "id": "dimo.browser",
            "source": {
                "kind": "marketplace",
                "path": stale_source,
            }
        })
        .to_string();
        sqlx::query(
            "INSERT INTO plugin_packages_v4
             (publisher, plugin_id, version, package_digest, source_kind, source_path, manifest_json, package_json, created_at)
             VALUES ('dimo', 'dimo.browser', '1.0.0', 'd1', 'marketplace', ?1, '{}', ?2, '2026-01-01')",
        )
        .bind(&stale_source)
        .bind(&stale_json)
        .execute(&pool)
        .await
        .unwrap();

        let reconciled = reconcile_migrated_data_dir_paths(&pool, &new_dir)
            .await
            .expect("reconcile");
        assert_eq!(reconciled.len(), 1);

        let (healed_col, healed_json): (String, String) = sqlx::query_as(
            "SELECT source_path, package_json FROM plugin_packages_v4 WHERE plugin_id = 'dimo.browser'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let parsed: Value = serde_json::from_str(&healed_json).unwrap();
        assert_eq!(
            Path::new(&healed_col),
            live_snapshot.as_path(),
            "healed column should point at live snapshot"
        );
        assert_eq!(
            Path::new(parsed["source"]["path"].as_str().unwrap()),
            live_snapshot.as_path()
        );

        pool.close().await;
    }
}
