use std::{path::Path, str::FromStr};

use sqlx::{
    Error, SqlitePool,
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

pub async fn remap_sqlite_data_dir_paths(
    pool: &SqlitePool,
    old_dir: &Path,
    new_dir: &Path,
) -> Result<(), Error> {
    let old_native = old_dir
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_string();
    let new_native = new_dir
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_string();
    if old_native.is_empty() || old_native == new_native {
        return Ok(());
    }

    let old_slash = old_native.replace('\\', "/");
    let new_slash = new_native.replace('\\', "/");
    let old_backslash = old_native.replace('/', "\\");
    let new_backslash = new_native.replace('/', "\\");

    let targets = [
        ("workspaces", "container_ref"),
        ("workspaces", "agent_working_dir"),
        ("repos", "path"),
        ("projects", "root_path"),
        ("collaboration_space_collection_items", "file_path"),
    ];

    let mut pairs = vec![(old_slash.clone(), new_slash.clone())];
    if old_backslash != old_slash || new_backslash != new_slash {
        pairs.push((old_backslash, new_backslash));
    }

    for (table, column) in targets {
        for (old_base, new_base) in &pairs {
            let exact_sql = format!("UPDATE {table} SET {column} = ?1 WHERE {column} = ?2");
            let _ = sqlx::query(&exact_sql)
                .bind(new_base)
                .bind(old_base)
                .execute(pool)
                .await;

            for sep in ['/', '\\'] {
                let old_prefix = format!("{old_base}{sep}");
                let new_prefix = format!("{new_base}{sep}");
                let prefix_sql = format!(
                    "UPDATE {table} SET {column} = ?1 || substr({column}, length(?2) + 1) \
                     WHERE {column} IS NOT NULL AND substr({column}, 1, length(?2)) = ?2"
                );
                let _ = sqlx::query(&prefix_sql)
                    .bind(&new_prefix)
                    .bind(&old_prefix)
                    .execute(pool)
                    .await;
            }
        }
    }
    Ok(())
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
}
