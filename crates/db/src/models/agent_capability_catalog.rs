use sqlx::{FromRow, SqlitePool};

#[derive(Debug, Clone, FromRow)]
pub struct AgentCapabilityCatalogRecord {
    pub agent_type: String,
    pub fingerprint: String,
    pub generation: i64,
    pub controls_json: String,
    pub retrieved_at: String,
    pub refresh_error_code: Option<String>,
}

impl AgentCapabilityCatalogRecord {
    pub async fn find_matching(
        pool: &SqlitePool,
        agent_type: &str,
        fingerprint: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            r#"SELECT agent_type, fingerprint, generation, controls_json,
                      retrieved_at, refresh_error_code
               FROM agent_capability_catalog
               WHERE agent_type = ? AND fingerprint = ?"#,
        )
        .bind(agent_type)
        .bind(fingerprint)
        .fetch_optional(pool)
        .await
    }

    /// Atomic upsert: readers can observe only a complete controls document.
    pub async fn replace(
        pool: &SqlitePool,
        agent_type: &str,
        fingerprint: &str,
        controls_json: &str,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>(
            r#"INSERT INTO agent_capability_catalog (
                    agent_type, fingerprint, generation, controls_json,
                    retrieved_at, refresh_error_code
                ) VALUES (?, ?, 1, ?, datetime('now'), NULL)
                ON CONFLICT(agent_type, fingerprint) DO UPDATE SET
                    generation = agent_capability_catalog.generation + 1,
                    controls_json = excluded.controls_json,
                    retrieved_at = datetime('now'),
                    refresh_error_code = NULL
                RETURNING agent_type, fingerprint, generation, controls_json,
                          retrieved_at, refresh_error_code"#,
        )
        .bind(agent_type)
        .bind(fingerprint)
        .bind(controls_json)
        .fetch_one(pool)
        .await
    }
}

#[cfg(test)]
mod tests {
    use sqlx::SqlitePool;

    use super::AgentCapabilityCatalogRecord;

    #[tokio::test]
    async fn replaces_a_complete_matching_snapshot_without_cross_fingerprint_fallback() {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_capability_catalog (
                agent_type TEXT NOT NULL, fingerprint TEXT NOT NULL,
                generation INTEGER NOT NULL DEFAULT 0, controls_json TEXT NOT NULL,
                retrieved_at TEXT NOT NULL, refresh_error_code TEXT,
                PRIMARY KEY (agent_type, fingerprint)
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        AgentCapabilityCatalogRecord::replace(&pool, "codex", "first", r#"{"options":["a"]}"#)
            .await
            .unwrap();
        let replaced =
            AgentCapabilityCatalogRecord::replace(&pool, "codex", "first", r#"{"options":["b"]}"#)
                .await
                .unwrap();

        assert_eq!(replaced.generation, 2);
        assert_eq!(replaced.controls_json, r#"{"options":["b"]}"#);
        assert!(
            AgentCapabilityCatalogRecord::find_matching(&pool, "codex", "other")
                .await
                .unwrap()
                .is_none()
        );
    }
}
