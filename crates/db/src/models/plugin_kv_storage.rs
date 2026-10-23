use serde_json::Value;
use sqlx::SqlitePool;

pub struct PluginKvStorage;

impl PluginKvStorage {
    pub async fn get(
        pool: &SqlitePool,
        plugin_id: &str,
        key: &str,
    ) -> Result<Option<Value>, sqlx::Error> {
        let raw: Option<String> = sqlx::query_scalar(
            "SELECT value_json FROM plugin_kv_storage WHERE plugin_id = ? AND key = ?",
        )
        .bind(plugin_id)
        .bind(key)
        .fetch_optional(pool)
        .await?;

        match raw {
            Some(json_str) => {
                let value = serde_json::from_str(&json_str)
                    .map_err(|err| sqlx::Error::Decode(Box::new(err)))?;
                Ok(Some(value))
            }
            None => Ok(None),
        }
    }

    pub async fn put(
        pool: &SqlitePool,
        plugin_id: &str,
        key: &str,
        value: &Value,
    ) -> Result<(), sqlx::Error> {
        let json_str =
            serde_json::to_string(value).map_err(|err| sqlx::Error::Encode(Box::new(err)))?;
        sqlx::query(
            "INSERT INTO plugin_kv_storage (plugin_id, key, value_json, updated_at)
             VALUES (?, ?, ?, datetime('now', 'subsec'))
             ON CONFLICT(plugin_id, key) DO UPDATE SET
               value_json = excluded.value_json,
               updated_at = excluded.updated_at",
        )
        .bind(plugin_id)
        .bind(key)
        .bind(json_str)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn delete(pool: &SqlitePool, plugin_id: &str, key: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM plugin_kv_storage WHERE plugin_id = ? AND key = ?")
            .bind(plugin_id)
            .bind(key)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn list_keys(
        pool: &SqlitePool,
        plugin_id: &str,
        prefix: Option<&str>,
    ) -> Result<Vec<String>, sqlx::Error> {
        match prefix.filter(|p| !p.is_empty()) {
            Some(prefix) => {
                let pattern = format!(
                    "{}%",
                    prefix
                        .replace('\\', "\\\\")
                        .replace('%', "\\%")
                        .replace('_', "\\_")
                );
                sqlx::query_scalar(
                    "SELECT key FROM plugin_kv_storage
                     WHERE plugin_id = ? AND key LIKE ? ESCAPE '\\'
                     ORDER BY key ASC",
                )
                .bind(plugin_id)
                .bind(pattern)
                .fetch_all(pool)
                .await
            }
            None => {
                sqlx::query_scalar(
                    "SELECT key FROM plugin_kv_storage WHERE plugin_id = ? ORDER BY key ASC",
                )
                .bind(plugin_id)
                .fetch_all(pool)
                .await
            }
        }
    }

    pub async fn clear_plugin(pool: &SqlitePool, plugin_id: &str) -> Result<u64, sqlx::Error> {
        let result = sqlx::query("DELETE FROM plugin_kv_storage WHERE plugin_id = ?")
            .bind(plugin_id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::PluginKvStorage;

    async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    use sqlx::SqlitePool;

    #[tokio::test]
    async fn kv_storage_isolates_namespaces_and_supports_crud() {
        let pool = setup_pool().await;

        assert_eq!(
            PluginKvStorage::get(&pool, "vibex.git", "branch")
                .await
                .unwrap(),
            None
        );

        PluginKvStorage::put(&pool, "vibex.git", "branch", &json!("main"))
            .await
            .unwrap();
        PluginKvStorage::put(&pool, "vibex.git", "branch", &json!("feat/next"))
            .await
            .unwrap();
        PluginKvStorage::put(&pool, "vibex.git", "stash.1", &json!({ "id": 1 }))
            .await
            .unwrap();
        PluginKvStorage::put(&pool, "vibex.other", "branch", &json!("other"))
            .await
            .unwrap();

        assert_eq!(
            PluginKvStorage::get(&pool, "vibex.git", "branch")
                .await
                .unwrap(),
            Some(json!("feat/next"))
        );
        assert_eq!(
            PluginKvStorage::get(&pool, "vibex.other", "branch")
                .await
                .unwrap(),
            Some(json!("other"))
        );

        let all_keys = PluginKvStorage::list_keys(&pool, "vibex.git", None)
            .await
            .unwrap();
        assert_eq!(all_keys, vec!["branch".to_string(), "stash.1".to_string()]);

        let prefixed = PluginKvStorage::list_keys(&pool, "vibex.git", Some("stash."))
            .await
            .unwrap();
        assert_eq!(prefixed, vec!["stash.1".to_string()]);

        PluginKvStorage::delete(&pool, "vibex.git", "branch")
            .await
            .unwrap();
        assert_eq!(
            PluginKvStorage::get(&pool, "vibex.git", "branch")
                .await
                .unwrap(),
            None
        );

        let removed = PluginKvStorage::clear_plugin(&pool, "vibex.git")
            .await
            .unwrap();
        assert_eq!(removed, 1);
        assert!(
            PluginKvStorage::list_keys(&pool, "vibex.git", None)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            PluginKvStorage::get(&pool, "vibex.other", "branch")
                .await
                .unwrap(),
            Some(json!("other"))
        );
    }
}
