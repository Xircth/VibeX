//! Plugins: "Skill + Web console" integrations (dashi-ppt, vibe-motion, …).
//! A plugin row is a manifest: how to install its agent skill, how to
//! hot-start its local web console, and the hook message prefilled into the
//! session composer when the plugin is activated. Uses runtime sqlx queries
//! (no offline macro cache).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

pub use crate::models::plugin_v2::{
    LegacyMigrationStatus, LegacyPluginEvidence, PluginV1Migration,
};

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Plugin {
    pub id: Uuid,
    pub name: String,
    pub skill_name: String,
    pub console_command: String,
    /// Optional console URL template; supports the `{{port}}` placeholder.
    pub console_url: Option<String>,
    /// Hook template; supports `{{pluginName}}`/`{{skillName}}`/`{{consoleUrl}}`.
    pub hook_message: String,
    pub install_command: String,
    pub author: Option<String>,
    /// Emoji/short text, or a `data:` URL for an uploaded image.
    pub icon: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub notes: Option<String>,
    /// `pending` | `installing` | `installed` | `failed`.
    pub install_status: String,
    pub install_error: Option<String>,
    /// Only enabled plugins show up in the workspace sidebar. Built-in
    /// presets start disabled; enabling one counts as configuring it.
    pub enabled: bool,
    /// Seeded by VibeX itself; cannot be deleted, only disabled.
    pub builtin: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct PluginInput {
    pub name: String,
    pub skill_name: String,
    pub console_command: String,
    pub console_url: Option<String>,
    pub hook_message: String,
    pub install_command: String,
    pub author: Option<String>,
    pub icon: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub notes: Option<String>,
}

impl Plugin {
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        self.expires_at.is_some_and(|expiry| expiry <= now)
    }
}

const PLUGIN_COLS: &str = "id, name, skill_name, console_command, console_url, hook_message, \
    install_command, author, icon, expires_at, notes, install_status, install_error, \
    enabled, builtin, created_at, updated_at";

impl Plugin {
    pub async fn create(
        pool: &SqlitePool,
        id: Uuid,
        input: &PluginInput,
    ) -> Result<Self, sqlx::Error> {
        let now = Utc::now();
        sqlx::query(
            "INSERT INTO plugins \
             (id, name, skill_name, console_command, console_url, hook_message, \
              install_command, author, icon, expires_at, notes, install_status, \
              enabled, builtin, created_at, updated_at) \
             VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',1,0,?,?)",
        )
        .bind(id)
        .bind(&input.name)
        .bind(&input.skill_name)
        .bind(&input.console_command)
        .bind(&input.console_url)
        .bind(&input.hook_message)
        .bind(&input.install_command)
        .bind(&input.author)
        .bind(&input.icon)
        .bind(input.expires_at)
        .bind(&input.notes)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;
        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn list(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {PLUGIN_COLS} FROM plugins ORDER BY created_at DESC"
        ))
        .fetch_all(pool)
        .await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!("SELECT {PLUGIN_COLS} FROM plugins WHERE id = ?"))
            .bind(id)
            .fetch_optional(pool)
            .await
    }

    pub async fn update(
        pool: &SqlitePool,
        id: Uuid,
        input: &PluginInput,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query(
            "UPDATE plugins SET name=?, skill_name=?, console_command=?, console_url=?, \
             hook_message=?, install_command=?, author=?, icon=?, expires_at=?, notes=?, \
             updated_at=? WHERE id=?",
        )
        .bind(&input.name)
        .bind(&input.skill_name)
        .bind(&input.console_command)
        .bind(&input.console_url)
        .bind(&input.hook_message)
        .bind(&input.install_command)
        .bind(&input.author)
        .bind(&input.icon)
        .bind(input.expires_at)
        .bind(&input.notes)
        .bind(Utc::now())
        .bind(id)
        .execute(pool)
        .await?;
        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Seed a built-in preset: inserted disabled exactly once; an existing
    /// row (possibly edited by the user) is left untouched.
    pub async fn insert_builtin_if_missing(
        pool: &SqlitePool,
        id: Uuid,
        input: &PluginInput,
    ) -> Result<bool, sqlx::Error> {
        let now = Utc::now();
        let result = sqlx::query(
            "INSERT OR IGNORE INTO plugins \
             (id, name, skill_name, console_command, console_url, hook_message, \
              install_command, author, icon, expires_at, notes, install_status, \
              enabled, builtin, created_at, updated_at) \
             VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',0,1,?,?)",
        )
        .bind(id)
        .bind(&input.name)
        .bind(&input.skill_name)
        .bind(&input.console_command)
        .bind(&input.console_url)
        .bind(&input.hook_message)
        .bind(&input.install_command)
        .bind(&input.author)
        .bind(&input.icon)
        .bind(input.expires_at)
        .bind(&input.notes)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn set_enabled(
        pool: &SqlitePool,
        id: Uuid,
        enabled: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?")
            .bind(enabled)
            .bind(Utc::now())
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_install_status(
        pool: &SqlitePool,
        id: Uuid,
        status: &str,
        error: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE plugins SET install_status = ?, install_error = ?, updated_at = ? \
             WHERE id = ?",
        )
        .bind(status)
        .bind(error)
        .bind(Utc::now())
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM plugins WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::{path::Path, str::FromStr};

    use chrono::Duration;
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

    fn input(name: &str, expires_at: Option<DateTime<Utc>>) -> PluginInput {
        PluginInput {
            name: name.to_string(),
            skill_name: "dashi-ppt".to_string(),
            console_command: "npx dashi-ppt-skill@latest serve --port {{port}}".to_string(),
            console_url: Some("http://127.0.0.1:{{port}}/".to_string()),
            hook_message: "你正在使用 {{skillName}}，控制台：{{consoleUrl}}".to_string(),
            install_command: "npx skills add chuspeeism/dashi-ppt-skill".to_string(),
            author: Some("chuspeeism".to_string()),
            icon: Some("📊".to_string()),
            expires_at,
            notes: None,
        }
    }

    #[tokio::test]
    async fn crud_roundtrip_and_install_status() {
        let pool = setup_pool().await;
        let plugin = Plugin::create(&pool, Uuid::new_v4(), &input("Dashi PPT", None))
            .await
            .expect("create");
        assert_eq!(plugin.install_status, "pending");
        assert!(!plugin.is_expired(Utc::now()));
        // User-created plugins are enabled, non-builtin.
        assert!(plugin.enabled);
        assert!(!plugin.builtin);

        // Timestamps round-trip through TEXT storage and expiry comparison works.
        let expired_input = input("Expired", Some(Utc::now() - Duration::days(1)));
        let expired = Plugin::create(&pool, Uuid::new_v4(), &expired_input)
            .await
            .expect("create expired");
        assert!(expired.is_expired(Utc::now()));

        Plugin::set_install_status(&pool, plugin.id, "failed", Some("npx missing"))
            .await
            .expect("set status");
        let reloaded = Plugin::find_by_id(&pool, plugin.id)
            .await
            .expect("find")
            .expect("exists");
        assert_eq!(reloaded.install_status, "failed");
        assert_eq!(reloaded.install_error.as_deref(), Some("npx missing"));

        let mut updated_input = input("Dashi PPT v2", None);
        updated_input.console_url = None;
        let updated = Plugin::update(&pool, plugin.id, &updated_input)
            .await
            .expect("update");
        assert_eq!(updated.name, "Dashi PPT v2");
        assert_eq!(updated.console_url, None);
        // Editing the manifest must not clobber the install bookkeeping.
        assert_eq!(updated.install_status, "failed");

        let listed = Plugin::list(&pool).await.expect("list");
        assert_eq!(listed.len(), 2);

        Plugin::delete(&pool, plugin.id).await.expect("delete");
        assert!(
            Plugin::find_by_id(&pool, plugin.id)
                .await
                .expect("find after delete")
                .is_none()
        );
    }

    #[tokio::test]
    async fn builtin_seed_is_disabled_once_and_toggleable() {
        let pool = setup_pool().await;
        let id = Uuid::new_v4();

        assert!(
            Plugin::insert_builtin_if_missing(&pool, id, &input("Builtin", None))
                .await
                .expect("seed")
        );
        let seeded = Plugin::find_by_id(&pool, id)
            .await
            .expect("find")
            .expect("exists");
        assert!(seeded.builtin);
        assert!(!seeded.enabled);

        // Re-seeding never clobbers the row (e.g. after the user edited it).
        Plugin::set_enabled(&pool, id, true).await.expect("enable");
        assert!(
            !Plugin::insert_builtin_if_missing(&pool, id, &input("Builtin v2", None))
                .await
                .expect("re-seed")
        );
        let kept = Plugin::find_by_id(&pool, id)
            .await
            .expect("find")
            .expect("exists");
        assert_eq!(kept.name, "Builtin");
        assert!(kept.enabled);
    }

    #[tokio::test]
    async fn plugin_v1_migration_never_executes_command() {
        let pool = setup_pool().await;
        let temporary = tempfile::tempdir().expect("temporary directory");
        let marker = temporary.path().join("legacy-command-executed");
        let mut legacy = input("Untrusted legacy plugin", None);
        legacy.install_command = format!("touch {}", marker.display());
        let plugin = Plugin::create(&pool, Uuid::new_v4(), &legacy)
            .await
            .expect("create legacy plugin");

        let migrated = PluginV1Migration::migrate_all(&pool)
            .await
            .expect("capture legacy evidence");
        let evidence = migrated
            .iter()
            .find(|evidence| evidence.legacy_plugin_id == plugin.id)
            .expect("migration evidence for plugin");

        assert_eq!(evidence.status, LegacyMigrationStatus::MigrationRequired);
        assert_eq!(
            evidence.original_manifest["install_command"],
            legacy.install_command
        );
        assert!(!Path::new(&marker).exists());
    }

    #[tokio::test]
    async fn plugin_v1_migration_maps_only_known_builtin_ids() {
        let pool = setup_pool().await;
        let known_id =
            Uuid::parse_str("3f8e2b10-7c44-4c5e-9a11-d2af01000001").expect("known builtin id");
        Plugin::insert_builtin_if_missing(&pool, known_id, &input("Dashi PPT", None))
            .await
            .expect("seed known builtin");
        Plugin::create(
            &pool,
            Uuid::new_v4(),
            &input("Unmapped third-party plugin", None),
        )
        .await
        .expect("create third-party plugin");

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

        let enabled: bool =
            sqlx::query_scalar("SELECT enabled FROM plugin_v2_activation WHERE plugin_id = ?")
                .bind("vibex.builtin.dashi-ppt")
                .fetch_one(&pool)
                .await
                .expect("mapped builtin activation");
        assert!(!enabled, "mapped builtins must require explicit enable");
    }
}
