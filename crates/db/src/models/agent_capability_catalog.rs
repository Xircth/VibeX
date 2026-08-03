use chrono::{DateTime, Duration, Utc};
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
    pub fn is_stale_at(&self, now: DateTime<Utc>, ttl: Duration) -> bool {
        DateTime::parse_from_rfc3339(&self.retrieved_at)
            .map(|retrieved| now.signed_duration_since(retrieved.with_timezone(&Utc)) > ttl)
            .unwrap_or(true)
    }

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
                ) VALUES (?, ?, 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)
                ON CONFLICT(agent_type, fingerprint) DO UPDATE SET
                    generation = agent_capability_catalog.generation + 1,
                    controls_json = excluded.controls_json,
                    retrieved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
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

    /// Commit a probe only if the catalog generation observed before the probe
    /// is still current. This prevents a slower, older probe from overwriting
    /// a newer result for the same runtime/config fingerprint.
    pub async fn replace_if_generation(
        pool: &SqlitePool,
        agent_type: &str,
        fingerprint: &str,
        controls_json: &str,
        expected_generation: Option<i64>,
    ) -> Result<Option<Self>, sqlx::Error> {
        match expected_generation {
            Some(expected) => {
                sqlx::query_as::<_, Self>(
                    r#"INSERT INTO agent_capability_catalog (
                            agent_type, fingerprint, generation, controls_json,
                            retrieved_at, refresh_error_code
                        ) VALUES (?, ?, 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)
                        ON CONFLICT(agent_type, fingerprint) DO UPDATE SET
                            generation = agent_capability_catalog.generation + 1,
                            controls_json = excluded.controls_json,
                            retrieved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                            refresh_error_code = NULL
                        WHERE agent_capability_catalog.generation = ?
                        RETURNING agent_type, fingerprint, generation, controls_json,
                                  retrieved_at, refresh_error_code"#,
                )
                .bind(agent_type)
                .bind(fingerprint)
                .bind(controls_json)
                .bind(expected)
                .fetch_optional(pool)
                .await
            }
            None => {
                sqlx::query_as::<_, Self>(
                    r#"INSERT INTO agent_capability_catalog (
                            agent_type, fingerprint, generation, controls_json,
                            retrieved_at, refresh_error_code
                        ) VALUES (?, ?, 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)
                        ON CONFLICT(agent_type, fingerprint) DO NOTHING
                        RETURNING agent_type, fingerprint, generation, controls_json,
                                  retrieved_at, refresh_error_code"#,
                )
                .bind(agent_type)
                .bind(fingerprint)
                .bind(controls_json)
                .fetch_optional(pool)
                .await
            }
        }
    }

    pub async fn record_refresh_error_if_generation(
        pool: &SqlitePool,
        agent_type: &str,
        fingerprint: &str,
        expected_generation: i64,
        error_code: &str,
    ) -> Result<bool, sqlx::Error> {
        Ok(sqlx::query(
            r#"UPDATE agent_capability_catalog
               SET refresh_error_code = ?
               WHERE agent_type = ? AND fingerprint = ? AND generation = ?"#,
        )
        .bind(error_code)
        .bind(agent_type)
        .bind(fingerprint)
        .bind(expected_generation)
        .execute(pool)
        .await?
        .rows_affected()
            == 1)
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
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

    #[tokio::test]
    async fn freshly_replaced_catalog_is_fresh() {
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

        let first = AgentCapabilityCatalogRecord::replace_if_generation(
            &pool,
            "codex",
            "current-runtime",
            r#"{"modes":[],"config_options":[]}"#,
            None,
        )
        .await
        .unwrap()
        .expect("a first refresh should commit the catalog");
        let catalog = AgentCapabilityCatalogRecord::replace_if_generation(
            &pool,
            "codex",
            "current-runtime",
            r#"{"modes":[],"config_options":[]}"#,
            Some(first.generation),
        )
        .await
        .unwrap()
        .expect("a current refresh should replace the catalog");

        assert!(!catalog.is_stale_at(Utc::now(), Duration::minutes(10)));
    }

    #[tokio::test]
    async fn late_refresh_cannot_overwrite_a_newer_generation() {
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
        AgentCapabilityCatalogRecord::replace(&pool, "codex", "same", r#"{"model":"old"}"#)
            .await
            .unwrap();

        let winner = AgentCapabilityCatalogRecord::replace_if_generation(
            &pool,
            "codex",
            "same",
            r#"{"model":"new"}"#,
            Some(1),
        )
        .await
        .unwrap();
        let late = AgentCapabilityCatalogRecord::replace_if_generation(
            &pool,
            "codex",
            "same",
            r#"{"model":"late-old"}"#,
            Some(1),
        )
        .await
        .unwrap();

        assert_eq!(winner.unwrap().generation, 2);
        assert!(late.is_none());
        assert_eq!(
            AgentCapabilityCatalogRecord::find_matching(&pool, "codex", "same")
                .await
                .unwrap()
                .unwrap()
                .controls_json,
            r#"{"model":"new"}"#
        );
    }

    #[test]
    fn ttl_marks_old_or_malformed_catalogs_stale() {
        let now = Utc::now();
        let mut record = AgentCapabilityCatalogRecord {
            agent_type: "codex".to_string(),
            fingerprint: "same".to_string(),
            generation: 1,
            controls_json: "{}".to_string(),
            retrieved_at: (now - Duration::minutes(5)).to_rfc3339(),
            refresh_error_code: None,
        };
        assert!(!record.is_stale_at(now, Duration::minutes(10)));
        record.retrieved_at = (now - Duration::minutes(11)).to_rfc3339();
        assert!(record.is_stale_at(now, Duration::minutes(10)));
        record.retrieved_at = "not-a-date".to_string();
        assert!(record.is_stale_at(now, Duration::minutes(10)));
    }
}
