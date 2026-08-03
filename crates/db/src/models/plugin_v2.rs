use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

const BUILTIN_MAPPINGS: &[(&str, &str)] = &[
    (
        "3f8e2b10-7c44-4c5e-9a11-d2af01000001",
        "vibex.builtin.dashi-ppt",
    ),
    (
        "3f8e2b10-7c44-4c5e-9a11-d2af01000002",
        "vibex.builtin.vibe-motion",
    ),
    (
        "3f8e2b10-7c44-4c5e-9a11-d2af01000003",
        "vibex.builtin.understand-anything",
    ),
];

#[derive(FromRow, Serialize)]
struct LegacyPluginRow {
    id: Uuid,
    name: String,
    skill_name: String,
    console_command: String,
    console_url: Option<String>,
    hook_message: String,
    install_command: String,
    author: Option<String>,
    icon: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    notes: Option<String>,
    install_status: String,
    install_error: Option<String>,
    enabled: bool,
    builtin: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl LegacyPluginRow {
    async fn list(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as(
            "SELECT id, name, skill_name, console_command, console_url, hook_message, \
             install_command, author, icon, expires_at, notes, install_status, install_error, \
             enabled, builtin, created_at, updated_at FROM plugins ORDER BY created_at DESC",
        )
        .fetch_all(pool)
        .await
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyMigrationStatus {
    MigrationRequired,
    MappedBuiltin,
}

impl LegacyMigrationStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::MigrationRequired => "migration_required",
            Self::MappedBuiltin => "mapped_builtin",
        }
    }

    fn parse(value: &str) -> Result<Self, sqlx::Error> {
        match value {
            "migration_required" => Ok(Self::MigrationRequired),
            "mapped_builtin" => Ok(Self::MappedBuiltin),
            other => Err(sqlx::Error::Decode(
                format!("unknown legacy plugin migration status `{other}`").into(),
            )),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyPluginEvidence {
    pub legacy_plugin_id: Uuid,
    pub status: LegacyMigrationStatus,
    pub mapped_plugin_id: Option<String>,
    pub original_manifest: serde_json::Value,
    pub captured_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct LegacyEvidenceRow {
    legacy_plugin_id: Uuid,
    migration_status: String,
    mapped_plugin_id: Option<String>,
    original_manifest_json: String,
    captured_at: DateTime<Utc>,
}

impl TryFrom<LegacyEvidenceRow> for LegacyPluginEvidence {
    type Error = sqlx::Error;

    fn try_from(row: LegacyEvidenceRow) -> Result<Self, Self::Error> {
        Ok(Self {
            legacy_plugin_id: row.legacy_plugin_id,
            status: LegacyMigrationStatus::parse(&row.migration_status)?,
            mapped_plugin_id: row.mapped_plugin_id,
            original_manifest: serde_json::from_str(&row.original_manifest_json)
                .map_err(|error| sqlx::Error::Decode(Box::new(error)))?,
            captured_at: row.captured_at,
        })
    }
}

pub struct PluginV1Migration;

impl PluginV1Migration {
    /// Captures each v1 row as immutable evidence. This adapter deliberately
    /// has no process/executor dependency, so an `install_command` cannot be
    /// interpreted or invoked during migration.
    pub async fn migrate_all(pool: &SqlitePool) -> Result<Vec<LegacyPluginEvidence>, sqlx::Error> {
        for plugin in LegacyPluginRow::list(pool).await? {
            Self::capture(pool, &plugin).await?;
        }
        let rows = sqlx::query_as::<_, LegacyEvidenceRow>(
            "SELECT legacy_plugin_id, migration_status, mapped_plugin_id, \
             original_manifest_json, captured_at \
             FROM plugin_legacy_evidence ORDER BY captured_at, legacy_plugin_id",
        )
        .fetch_all(pool)
        .await?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    /// Preserve immutable v1 evidence, then remove every legacy runtime row
    /// and any placeholder v2 membership that was derived from the retired
    /// built-in presets. Product code must only observe real Plugin v2
    /// manifests after this boundary.
    pub async fn retire_all(pool: &SqlitePool) -> Result<Vec<LegacyPluginEvidence>, sqlx::Error> {
        let evidence = Self::migrate_all(pool).await?;
        let mut transaction = pool.begin().await?;
        sqlx::query("DELETE FROM plugin_v2_registry WHERE source = 'legacy_builtin_mapping'")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM plugins")
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(evidence)
    }

    async fn capture(pool: &SqlitePool, plugin: &LegacyPluginRow) -> Result<(), sqlx::Error> {
        let mapped_plugin_id = builtin_mapping(plugin);
        let status = if mapped_plugin_id.is_some() {
            LegacyMigrationStatus::MappedBuiltin
        } else {
            LegacyMigrationStatus::MigrationRequired
        };
        let original_manifest_json =
            serde_json::to_string(plugin).map_err(|error| sqlx::Error::Encode(Box::new(error)))?;
        let captured_at = Utc::now();
        let mut transaction = pool.begin().await?;
        sqlx::query(
            "INSERT OR IGNORE INTO plugin_legacy_evidence \
             (legacy_plugin_id, migration_status, mapped_plugin_id, \
              original_manifest_json, captured_at) VALUES (?,?,?,?,?)",
        )
        .bind(plugin.id)
        .bind(status.as_str())
        .bind(mapped_plugin_id)
        .bind(&original_manifest_json)
        .bind(captured_at)
        .execute(&mut *transaction)
        .await?;

        if let Some(stable_id) = mapped_plugin_id {
            let normalized_manifest = serde_json::json!({
                "$schema": "vibex-plugin/v2",
                "id": stable_id,
                "version": "0.0.0-migration",
                "name": plugin.name,
                "dependencies": [],
                "skills": [],
                "actions": []
            })
            .to_string();
            sqlx::query(
                "INSERT OR IGNORE INTO plugin_v2_registry \
                 (plugin_id, schema_version, name, normalized_manifest_json, source, \
                  membership, legacy_plugin_id, created_at, updated_at) \
                 VALUES (?,2,?,?,'legacy_builtin_mapping','builtin',?,?,?)",
            )
            .bind(stable_id)
            .bind(&plugin.name)
            .bind(normalized_manifest)
            .bind(plugin.id)
            .bind(captured_at)
            .bind(captured_at)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "INSERT OR IGNORE INTO plugin_v2_activation \
                 (plugin_id, enabled, updated_at) VALUES (?,0,?)",
            )
            .bind(stable_id)
            .bind(captured_at)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await
    }
}

fn builtin_mapping(plugin: &LegacyPluginRow) -> Option<&'static str> {
    if !plugin.builtin {
        return None;
    }
    let id = plugin.id.to_string();
    BUILTIN_MAPPINGS
        .iter()
        .find_map(|(legacy_id, stable_id)| (*legacy_id == id).then_some(*stable_id))
}

#[cfg(test)]
mod tests {
    use std::{path::Path, str::FromStr};

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

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

    async fn insert_legacy(
        pool: &SqlitePool,
        id: Uuid,
        name: &str,
        builtin: bool,
        install_command: &str,
    ) {
        let now = Utc::now();
        sqlx::query(
            "INSERT INTO plugins \
             (id,name,skill_name,console_command,hook_message,install_command,install_status, \
              enabled,builtin,created_at,updated_at) \
             VALUES (?,?,?,?,?,?,'pending',1,?,?,?)",
        )
        .bind(id)
        .bind(name)
        .bind("legacy-skill")
        .bind("legacy console")
        .bind("legacy hook")
        .bind(install_command)
        .bind(builtin)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert legacy plugin");
    }

    #[tokio::test]
    async fn migration_never_executes_legacy_install_command() {
        let pool = setup_pool().await;
        let temporary = tempfile::tempdir().expect("temporary directory");
        let marker = temporary.path().join("legacy-command-executed");
        let command = format!("touch {}", marker.display());
        let id = Uuid::new_v4();
        insert_legacy(&pool, id, "Untrusted legacy plugin", false, &command).await;

        let evidence = PluginV1Migration::migrate_all(&pool)
            .await
            .expect("capture legacy evidence");
        let captured = evidence
            .iter()
            .find(|item| item.legacy_plugin_id == id)
            .expect("migration evidence");

        assert_eq!(captured.status, LegacyMigrationStatus::MigrationRequired);
        assert_eq!(captured.original_manifest["install_command"], command);
        assert!(!Path::new(&marker).exists());
    }

    #[tokio::test]
    async fn migration_maps_only_known_builtin_ids() {
        let pool = setup_pool().await;
        let known_id = Uuid::parse_str("3f8e2b10-7c44-4c5e-9a11-d2af01000001").expect("known id");
        insert_legacy(&pool, known_id, "Dashi PPT", true, "must-not-run").await;
        insert_legacy(
            &pool,
            Uuid::new_v4(),
            "Unmapped third-party plugin",
            false,
            "must-not-run",
        )
        .await;

        let evidence = PluginV1Migration::migrate_all(&pool)
            .await
            .expect("migrate legacy rows");
        let mapped = evidence
            .iter()
            .find(|row| row.legacy_plugin_id == known_id)
            .expect("known builtin evidence");
        assert_eq!(mapped.status, LegacyMigrationStatus::MappedBuiltin);
        assert_eq!(
            mapped.mapped_plugin_id.as_deref(),
            Some("vibex.builtin.dashi-ppt")
        );
        assert!(
            evidence
                .iter()
                .any(|row| row.status == LegacyMigrationStatus::MigrationRequired)
        );
    }

    #[tokio::test]
    async fn retirement_preserves_evidence_but_removes_runtime_rows() {
        let pool = setup_pool().await;
        let known_id = Uuid::parse_str("3f8e2b10-7c44-4c5e-9a11-d2af01000003").expect("known id");
        insert_legacy(&pool, known_id, "Understand Anything", true, "must-not-run").await;
        insert_legacy(
            &pool,
            Uuid::new_v4(),
            "User legacy plugin",
            false,
            "must-not-run",
        )
        .await;

        let evidence = PluginV1Migration::retire_all(&pool)
            .await
            .expect("retire legacy plugins");

        assert_eq!(evidence.len(), 2);
        let legacy_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plugins")
            .fetch_one(&pool)
            .await
            .expect("count retired rows");
        assert_eq!(legacy_rows, 0);
        let legacy_registry_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM plugin_v2_registry WHERE source = 'legacy_builtin_mapping'",
        )
        .fetch_one(&pool)
        .await
        .expect("count legacy mapped registry rows");
        assert_eq!(legacy_registry_rows, 0);
    }
}
