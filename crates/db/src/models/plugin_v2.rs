use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use super::plugin::Plugin;

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
        for plugin in Plugin::list(pool).await? {
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

    async fn capture(pool: &SqlitePool, plugin: &Plugin) -> Result<(), sqlx::Error> {
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

fn builtin_mapping(plugin: &Plugin) -> Option<&'static str> {
    if !plugin.builtin {
        return None;
    }
    let id = plugin.id.to_string();
    BUILTIN_MAPPINGS
        .iter()
        .find_map(|(legacy_id, stable_id)| (*legacy_id == id).then_some(*stable_id))
}
