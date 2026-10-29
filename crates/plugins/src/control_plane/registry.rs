use std::{
    collections::BTreeMap,
    sync::{RwLock, atomic::AtomicU64},
};

use async_trait::async_trait;
use sqlx::{Row, SqlitePool};

use super::*;
use crate::{CapabilityGrant, PluginActivation, PluginError, PluginPackage};

#[derive(Default)]
pub struct InMemoryPluginRegistry {
    pub(super) plugins: RwLock<BTreeMap<String, InstalledPlugin>>,
    pub(super) rollback_packages: RwLock<BTreeMap<String, InstalledPlugin>>,
    pub(super) runtimes: RwLock<BTreeMap<RuntimeArtifactKey, RuntimeInstallation>>,
    pub(super) runtime_locks: RwLock<BTreeMap<(String, String, String), RuntimeArtifactKey>>,
    pub(super) next_generation: AtomicU64,
    pub(super) published_generations: RwLock<BTreeMap<String, u64>>,
    pub(super) candidate_packages: RwLock<BTreeMap<u64, PluginPackage>>,
    pub(super) grants: RwLock<BTreeMap<String, Vec<crate::CapabilityGrant>>>,
    pub(super) published_contributions:
        RwLock<BTreeMap<String, Vec<crate::ContributionDescriptor>>>,
    pub(super) audit: RwLock<Vec<(String, PluginAuditEvent)>>,
    pub(super) kv_store: RwLock<BTreeMap<(String, String), serde_json::Value>>,
    pub(super) secrets_store: RwLock<BTreeMap<(String, String), String>>,
    pub(super) next_event_cursor: AtomicU64,
    pub(super) events_log: RwLock<Vec<PluginBusEvent>>,
    pub(super) event_offsets: RwLock<BTreeMap<(String, String), u64>>,
    pub(super) quarantined: RwLock<BTreeMap<String, String>>,
}

impl InMemoryPluginRegistry {
    pub(super) async fn plugin(
        &self,
        plugin_id: &str,
    ) -> Result<Option<InstalledPlugin>, PluginError> {
        Ok(self
            .plugins
            .read()
            .map_err(lock_error)?
            .get(plugin_id)
            .cloned())
    }

    pub(super) async fn list_plugins(&self) -> Result<Vec<InstalledPlugin>, PluginError> {
        Ok(self
            .plugins
            .read()
            .map_err(lock_error)?
            .values()
            .cloned()
            .collect())
    }

    pub(super) async fn rollback_package(
        &self,
        plugin_id: &str,
    ) -> Result<Option<InstalledPlugin>, PluginError> {
        Ok(self
            .rollback_packages
            .read()
            .map_err(lock_error)?
            .get(plugin_id)
            .cloned())
    }

    pub(super) async fn put_plugin(&self, plugin: InstalledPlugin) -> Result<(), PluginError> {
        let plugin_id = plugin.id().to_owned();
        let previous = self
            .plugins
            .write()
            .map_err(lock_error)?
            .insert(plugin_id.clone(), plugin.clone());
        if let Some(previous) =
            previous.filter(|previous| previous.package_digest != plugin.package_digest)
        {
            self.rollback_packages
                .write()
                .map_err(lock_error)?
                .insert(plugin_id, previous);
        }
        Ok(())
    }

    pub(super) async fn set_activation(
        &self,
        plugin_id: &str,
        activation: PluginActivation,
    ) -> Result<(), PluginError> {
        let mut plugins = self.plugins.write().map_err(lock_error)?;
        let plugin = plugins
            .get_mut(plugin_id)
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        plugin.activation = activation;
        if activation == PluginActivation::Enabled {
            self.quarantined
                .write()
                .map_err(lock_error)?
                .remove(plugin_id);
        }
        if activation == PluginActivation::Disabled {
            self.published_generations
                .write()
                .map_err(lock_error)?
                .remove(plugin_id);
            self.published_contributions
                .write()
                .map_err(lock_error)?
                .remove(plugin_id);
        }
        Ok(())
    }

    pub(super) async fn delete_plugin(&self, plugin_id: &str) -> Result<(), PluginError> {
        self.plugins.write().map_err(lock_error)?.remove(plugin_id);
        self.published_generations
            .write()
            .map_err(lock_error)?
            .remove(plugin_id);
        self.published_contributions
            .write()
            .map_err(lock_error)?
            .remove(plugin_id);
        self.grants.write().map_err(lock_error)?.remove(plugin_id);
        self.kv_store
            .write()
            .map_err(lock_error)?
            .retain(|(owner, _), _| owner != plugin_id);
        self.quarantined
            .write()
            .map_err(lock_error)?
            .remove(plugin_id);
        self.rollback_packages
            .write()
            .map_err(lock_error)?
            .remove(plugin_id);
        self.runtime_locks
            .write()
            .map_err(lock_error)?
            .retain(|(owner, _, _), _| owner != plugin_id);
        self.secrets_store
            .write()
            .map_err(lock_error)?
            .retain(|(owner, _), _| owner != plugin_id);
        self.event_offsets
            .write()
            .map_err(lock_error)?
            .retain(|(owner, _), _| owner != plugin_id);
        Ok(())
    }
}

pub struct SqlitePluginRegistry {
    pub(super) pool: SqlitePool,
    pub(super) kv_table_ready: tokio::sync::OnceCell<()>,
    pub(super) kv_table_initialized: std::sync::atomic::AtomicBool,
}

impl SqlitePluginRegistry {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            kv_table_ready: tokio::sync::OnceCell::new(),
            kv_table_initialized: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

impl SqlitePluginRegistry {
    pub(super) async fn plugin(
        &self,
        plugin_id: &str,
    ) -> Result<Option<InstalledPlugin>, PluginError> {
        let row = sqlx::query(
            "SELECT p.package_json, i.current_package_digest, a.enabled
             FROM plugin_installations_v4 i
             JOIN plugin_packages_v4 p
               ON p.publisher = i.publisher
              AND p.plugin_id = i.plugin_id
              AND p.package_digest = i.current_package_digest
             JOIN plugin_activation_intents_v4 a ON a.plugin_id = i.plugin_id
             WHERE i.plugin_id = ?",
        )
        .bind(plugin_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?;
        row.map(decode_plugin_row).transpose()
    }

    pub(super) async fn list_plugins(&self) -> Result<Vec<InstalledPlugin>, PluginError> {
        let rows = sqlx::query(
            "SELECT p.package_json, i.current_package_digest, a.enabled
             FROM plugin_installations_v4 i
             JOIN plugin_packages_v4 p
               ON p.publisher = i.publisher
              AND p.plugin_id = i.plugin_id
              AND p.package_digest = i.current_package_digest
             JOIN plugin_activation_intents_v4 a ON a.plugin_id = i.plugin_id
             ORDER BY p.plugin_id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(registry_error)?;
        let plugins: Vec<InstalledPlugin> = rows
            .into_iter()
            .map(decode_plugin_row)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(plugins
            .into_iter()
            .filter(|plugin| !crate::catalog::is_retired_plugin_id(plugin.id()))
            .collect())
    }

    pub(super) async fn rollback_package(
        &self,
        plugin_id: &str,
    ) -> Result<Option<InstalledPlugin>, PluginError> {
        let row = sqlx::query(
            "SELECT p.package_json, i.rollback_package_digest AS current_package_digest,
                    a.enabled
             FROM plugin_installations_v4 i
             JOIN plugin_packages_v4 p
               ON p.publisher = i.publisher
              AND p.plugin_id = i.plugin_id
              AND p.package_digest = i.rollback_package_digest
             JOIN plugin_activation_intents_v4 a ON a.plugin_id = i.plugin_id
             WHERE i.plugin_id = ? AND i.rollback_package_digest IS NOT NULL",
        )
        .bind(plugin_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?;
        row.map(decode_plugin_row).transpose()
    }

    pub(super) async fn put_plugin(&self, plugin: InstalledPlugin) -> Result<(), PluginError> {
        let package_json = serde_json::to_string(&plugin.package).map_err(registry_error)?;
        let package_digest = plugin.package_digest.clone();
        let publisher = package_publisher(&plugin.package);
        let manifest_json =
            serde_json::to_string(&plugin.package.manifest).map_err(registry_error)?;
        let mut transaction = self.pool.begin().await.map_err(registry_error)?;
        sqlx::query(
            "INSERT INTO plugin_packages_v4
                 (publisher, plugin_id, version, package_digest, source_kind, source_path,
                  manifest_json, package_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','subsec'))
             ON CONFLICT(publisher, plugin_id, package_digest) DO UPDATE SET
                 version = excluded.version,
                 source_kind = excluded.source_kind,
                 source_path = excluded.source_path,
                 manifest_json = excluded.manifest_json,
                 package_json = excluded.package_json",
        )
        .bind(publisher)
        .bind(plugin.id())
        .bind(&plugin.version)
        .bind(&package_digest)
        .bind(source_kind_key(plugin.source.kind))
        .bind(plugin.source.path.to_string_lossy().as_ref())
        .bind(manifest_json)
        .bind(&package_json)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;
        sqlx::query(
            "INSERT INTO plugin_installations_v4
                 (plugin_id, publisher, current_package_digest, rollback_package_digest,
                  installed_at, updated_at)
             VALUES (?, ?, ?, NULL, datetime('now','subsec'), datetime('now','subsec'))
             ON CONFLICT(plugin_id) DO UPDATE SET
                 publisher = excluded.publisher,
                 rollback_package_digest = CASE
                     WHEN plugin_installations_v4.current_package_digest <> excluded.current_package_digest
                     THEN plugin_installations_v4.current_package_digest
                     ELSE plugin_installations_v4.rollback_package_digest
                 END,
                 current_package_digest = excluded.current_package_digest,
                 updated_at = datetime('now','subsec')",
        )
        .bind(plugin.id())
        .bind(publisher)
        .bind(&package_digest)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;
        sqlx::query(
            "INSERT INTO plugin_activation_intents_v4
                 (plugin_id, enabled, target_digest, updated_at)
             VALUES (?, ?, ?, datetime('now','subsec'))
             ON CONFLICT(plugin_id) DO UPDATE SET
                 enabled = excluded.enabled,
                 target_digest = excluded.target_digest,
                 updated_at = datetime('now','subsec')",
        )
        .bind(plugin.id())
        .bind(i64::from(plugin.activation == PluginActivation::Enabled))
        .bind(&package_digest)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;

        transaction.commit().await.map_err(registry_error)
    }

    pub(super) async fn set_activation(
        &self,
        plugin_id: &str,
        activation: PluginActivation,
    ) -> Result<(), PluginError> {
        self.ensure_kv_table().await?;
        let result = if activation == PluginActivation::Enabled {
            sqlx::query(
                "UPDATE plugin_activation_intents_v4
                 SET enabled = 1, quarantined = 0, quarantine_reason = NULL, updated_at = datetime('now','subsec')
                 WHERE plugin_id = ?",
            )
            .bind(plugin_id)
            .execute(&self.pool)
            .await
            .map_err(registry_error)?
        } else {
            sqlx::query(
                "UPDATE plugin_activation_intents_v4 SET enabled = 0, updated_at = datetime('now','subsec')
                 WHERE plugin_id = ?",
            )
            .bind(plugin_id)
            .execute(&self.pool)
            .await
            .map_err(registry_error)?
        };
        if result.rows_affected() == 0 {
            return Err(PluginError::not_found(plugin_id));
        }
        if activation == PluginActivation::Disabled {
            sqlx::query(
                "UPDATE plugin_generations_v4 SET state = 'retired'
                 WHERE plugin_id = ? AND state IN ('active','active_degraded','draining')",
            )
            .bind(plugin_id)
            .execute(&self.pool)
            .await
            .map_err(registry_error)?;
        }
        Ok(())
    }

    pub(super) async fn delete_plugin(&self, plugin_id: &str) -> Result<(), PluginError> {
        self.ensure_kv_table().await?;
        let mut transaction = self.pool.begin().await.map_err(registry_error)?;
        for statement in [
            "DELETE FROM plugin_contributions_v4 WHERE plugin_id = ?",
            "DELETE FROM plugin_generations_v4 WHERE plugin_id = ?",
            "DELETE FROM plugin_activation_intents_v4 WHERE plugin_id = ?",
            "DELETE FROM plugin_runtime_locks_v4 WHERE plugin_id = ?",
            "DELETE FROM plugin_packages_v4 WHERE plugin_id = ?",
            "DELETE FROM plugin_kv_storage WHERE plugin_id = ?",
            "DELETE FROM plugin_secrets_storage WHERE plugin_id = ?",
            "DELETE FROM plugin_event_subscriptions WHERE plugin_id = ?",
            "DELETE FROM plugin_installations_v4 WHERE plugin_id = ?",
        ] {
            sqlx::query(statement)
                .bind(plugin_id)
                .execute(&mut *transaction)
                .await
                .map_err(registry_error)?;
        }
        gc_runtime_locks(&mut transaction).await?;
        transaction.commit().await.map_err(registry_error)?;
        Ok(())
    }
}

pub(crate) fn decode_plugin_row(
    row: sqlx::sqlite::SqliteRow,
) -> Result<InstalledPlugin, PluginError> {
    let package =
        serde_json::from_str::<PluginPackage>(row.get("package_json")).map_err(registry_error)?;
    Ok(InstalledPlugin {
        package,
        package_digest: row.get("current_package_digest"),
        activation: if row.get::<i64, _>("enabled") == 1 {
            PluginActivation::Enabled
        } else {
            PluginActivation::Disabled
        },
    })
}

#[async_trait]
pub trait PluginRegistry: Send + Sync {
    async fn plugin(&self, plugin_id: &str) -> Result<Option<InstalledPlugin>, PluginError>;
    async fn list_plugins(&self) -> Result<Vec<InstalledPlugin>, PluginError>;
    async fn rollback_package(
        &self,
        plugin_id: &str,
    ) -> Result<Option<InstalledPlugin>, PluginError>;
    async fn put_plugin(&self, plugin: InstalledPlugin) -> Result<(), PluginError>;
    async fn set_activation(
        &self,
        plugin_id: &str,
        activation: PluginActivation,
    ) -> Result<(), PluginError>;
    async fn delete_plugin(&self, plugin_id: &str) -> Result<(), PluginError>;
    async fn put_runtime(
        &self,
        plugin_id: &str,
        package_digest: &str,
        runtime: RuntimeInstallation,
    ) -> Result<(), PluginError>;
    async fn runtime_for_plugin(
        &self,
        plugin_id: &str,
        runtime_id: &str,
    ) -> Result<Option<RuntimeInstallation>, PluginError>;
    async fn runtime_for_package(
        &self,
        plugin_id: &str,
        package_digest: &str,
        runtime_id: &str,
    ) -> Result<Option<RuntimeInstallation>, PluginError>;
    async fn runtime_for_generation(
        &self,
        plugin_id: &str,
        generation: u64,
        runtime_id: &str,
    ) -> Result<Option<RuntimeInstallation>, PluginError>;
    async fn list_runtimes(&self) -> Result<Vec<RuntimeInstallation>, PluginError>;
    async fn active_generation(&self, plugin_id: &str) -> Result<Option<u64>, PluginError>;
    async fn active_contributions(&self)
    -> Result<Vec<crate::ContributionDescriptor>, PluginError>;
    async fn create_candidate(&self, plugin_id: &str) -> Result<u64, PluginError>;
    async fn prepare_package_candidate(&self, package: &PluginPackage) -> Result<u64, PluginError>;
    async fn publish_candidate(
        &self,
        plugin_id: &str,
        generation: u64,
        package: &PluginPackage,
        contributions: &[crate::ContributionDescriptor],
        grants: &[CapabilityGrant],
    ) -> Result<(), PluginError>;
    async fn fail_candidate(&self, generation: u64, evidence: &str) -> Result<(), PluginError>;
    async fn retire_generation(&self, generation: u64) -> Result<(), PluginError>;
    async fn retire_draining_generations(&self, plugin_id: &str) -> Result<(), PluginError>;
    /// Drop the live generation without changing enable intent.
    async fn retire_published_generation(&self, plugin_id: &str) -> Result<(), PluginError>;
    async fn replace_declared_grants(
        &self,
        plugin_id: &str,
        permissions: &[crate::CapabilityRequest],
    ) -> Result<(), PluginError>;
    async fn capability_grants(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<crate::CapabilityGrant>, PluginError>;
    async fn record_audit(
        &self,
        plugin_id: &str,
        event: &str,
        evidence: &serde_json::Value,
    ) -> Result<(), PluginError>;
    async fn list_audit(&self, plugin_id: &str) -> Result<Vec<PluginAuditEvent>, PluginError>;
    async fn delete_unreferenced_runtime_artifacts(
        &self,
    ) -> Result<Vec<RuntimeInstallation>, PluginError>;
    async fn kv_get(
        &self,
        plugin_id: &str,
        key: &str,
    ) -> Result<Option<serde_json::Value>, PluginError>;
    async fn kv_put(
        &self,
        plugin_id: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), PluginError>;
    async fn kv_delete(&self, plugin_id: &str, key: &str) -> Result<(), PluginError>;
    async fn kv_list_keys(
        &self,
        plugin_id: &str,
        prefix: Option<&str>,
    ) -> Result<Vec<String>, PluginError>;
    async fn kv_clear(&self, plugin_id: &str) -> Result<u64, PluginError>;
    async fn secret_get(
        &self,
        plugin_id: &str,
        secret_key: &str,
    ) -> Result<Option<String>, PluginError> {
        let _ = (plugin_id, secret_key);
        Ok(None)
    }
    async fn secret_put(
        &self,
        plugin_id: &str,
        secret_key: &str,
        value: &str,
    ) -> Result<(), PluginError> {
        let _ = (plugin_id, secret_key, value);
        Ok(())
    }
    async fn secret_delete(&self, plugin_id: &str, secret_key: &str) -> Result<bool, PluginError> {
        let _ = (plugin_id, secret_key);
        Ok(false)
    }
    async fn publish_event(
        &self,
        topic: &str,
        event_type: &str,
        payload: &serde_json::Value,
    ) -> Result<u64, PluginError> {
        let _ = (topic, event_type, payload);
        Ok(0)
    }
    async fn events_subscribe(
        &self,
        plugin_id: &str,
        topic: Option<&str>,
        event_type: Option<&str>,
        since_cursor: Option<u64>,
        limit: usize,
    ) -> Result<PluginEventSubscriptionBatch, PluginError> {
        let _ = (plugin_id, topic, event_type, since_cursor, limit);
        Ok(PluginEventSubscriptionBatch {
            cursor: 0,
            acked_cursor: 0,
            events: Vec::new(),
        })
    }
    async fn events_ack(
        &self,
        plugin_id: &str,
        subscription_key: &str,
        cursor: u64,
    ) -> Result<u64, PluginError> {
        let _ = (plugin_id, subscription_key);
        Ok(cursor)
    }
    async fn quarantine_plugin(&self, plugin_id: &str, reason: &str) -> Result<(), PluginError>;
    async fn quarantine_reason(&self, plugin_id: &str) -> Result<Option<String>, PluginError>;
}

macro_rules! impl_plugin_registry {
    ($ty:ty) => {
        #[async_trait]
        impl PluginRegistry for $ty {
            async fn plugin(
                &self,
                plugin_id: &str,
            ) -> Result<Option<InstalledPlugin>, PluginError> {
                <$ty>::plugin(self, plugin_id).await
            }
            async fn list_plugins(&self) -> Result<Vec<InstalledPlugin>, PluginError> {
                <$ty>::list_plugins(self).await
            }
            async fn rollback_package(
                &self,
                plugin_id: &str,
            ) -> Result<Option<InstalledPlugin>, PluginError> {
                <$ty>::rollback_package(self, plugin_id).await
            }
            async fn put_plugin(&self, plugin: InstalledPlugin) -> Result<(), PluginError> {
                <$ty>::put_plugin(self, plugin).await
            }
            async fn set_activation(
                &self,
                plugin_id: &str,
                activation: PluginActivation,
            ) -> Result<(), PluginError> {
                <$ty>::set_activation(self, plugin_id, activation).await
            }
            async fn delete_plugin(&self, plugin_id: &str) -> Result<(), PluginError> {
                <$ty>::delete_plugin(self, plugin_id).await
            }
            async fn put_runtime(
                &self,
                plugin_id: &str,
                package_digest: &str,
                runtime: RuntimeInstallation,
            ) -> Result<(), PluginError> {
                <$ty>::put_runtime(self, plugin_id, package_digest, runtime).await
            }
            async fn runtime_for_plugin(
                &self,
                plugin_id: &str,
                runtime_id: &str,
            ) -> Result<Option<RuntimeInstallation>, PluginError> {
                <$ty>::runtime_for_plugin(self, plugin_id, runtime_id).await
            }
            async fn runtime_for_package(
                &self,
                plugin_id: &str,
                package_digest: &str,
                runtime_id: &str,
            ) -> Result<Option<RuntimeInstallation>, PluginError> {
                <$ty>::runtime_for_package(self, plugin_id, package_digest, runtime_id).await
            }
            async fn runtime_for_generation(
                &self,
                plugin_id: &str,
                generation: u64,
                runtime_id: &str,
            ) -> Result<Option<RuntimeInstallation>, PluginError> {
                <$ty>::runtime_for_generation(self, plugin_id, generation, runtime_id).await
            }
            async fn list_runtimes(&self) -> Result<Vec<RuntimeInstallation>, PluginError> {
                <$ty>::list_runtimes(self).await
            }
            async fn active_generation(&self, plugin_id: &str) -> Result<Option<u64>, PluginError> {
                <$ty>::active_generation(self, plugin_id).await
            }
            async fn active_contributions(
                &self,
            ) -> Result<Vec<crate::ContributionDescriptor>, PluginError> {
                <$ty>::active_contributions(self).await
            }
            async fn create_candidate(&self, plugin_id: &str) -> Result<u64, PluginError> {
                <$ty>::create_candidate(self, plugin_id).await
            }
            async fn prepare_package_candidate(
                &self,
                package: &PluginPackage,
            ) -> Result<u64, PluginError> {
                <$ty>::prepare_package_candidate(self, package).await
            }
            async fn publish_candidate(
                &self,
                plugin_id: &str,
                generation: u64,
                package: &PluginPackage,
                contributions: &[crate::ContributionDescriptor],
                grants: &[CapabilityGrant],
            ) -> Result<(), PluginError> {
                <$ty>::publish_candidate(
                    self,
                    plugin_id,
                    generation,
                    package,
                    contributions,
                    grants,
                )
                .await
            }
            async fn fail_candidate(
                &self,
                generation: u64,
                evidence: &str,
            ) -> Result<(), PluginError> {
                <$ty>::fail_candidate(self, generation, evidence).await
            }
            async fn retire_generation(&self, generation: u64) -> Result<(), PluginError> {
                <$ty>::retire_generation(self, generation).await
            }
            async fn retire_draining_generations(
                &self,
                plugin_id: &str,
            ) -> Result<(), PluginError> {
                <$ty>::retire_draining_generations(self, plugin_id).await
            }
            async fn retire_published_generation(
                &self,
                plugin_id: &str,
            ) -> Result<(), PluginError> {
                <$ty>::retire_published_generation(self, plugin_id).await
            }
            async fn replace_declared_grants(
                &self,
                plugin_id: &str,
                permissions: &[crate::CapabilityRequest],
            ) -> Result<(), PluginError> {
                <$ty>::replace_declared_grants(self, plugin_id, permissions).await
            }
            async fn capability_grants(
                &self,
                plugin_id: &str,
            ) -> Result<Vec<crate::CapabilityGrant>, PluginError> {
                <$ty>::capability_grants(self, plugin_id).await
            }
            async fn record_audit(
                &self,
                plugin_id: &str,
                event: &str,
                evidence: &serde_json::Value,
            ) -> Result<(), PluginError> {
                <$ty>::record_audit(self, plugin_id, event, evidence).await
            }
            async fn list_audit(
                &self,
                plugin_id: &str,
            ) -> Result<Vec<PluginAuditEvent>, PluginError> {
                <$ty>::list_audit(self, plugin_id).await
            }
            async fn delete_unreferenced_runtime_artifacts(
                &self,
            ) -> Result<Vec<RuntimeInstallation>, PluginError> {
                <$ty>::delete_unreferenced_runtime_artifacts(self).await
            }
            async fn kv_get(
                &self,
                plugin_id: &str,
                key: &str,
            ) -> Result<Option<serde_json::Value>, PluginError> {
                <$ty>::kv_get(self, plugin_id, key).await
            }
            async fn kv_put(
                &self,
                plugin_id: &str,
                key: &str,
                value: &serde_json::Value,
            ) -> Result<(), PluginError> {
                <$ty>::kv_put(self, plugin_id, key, value).await
            }
            async fn kv_delete(&self, plugin_id: &str, key: &str) -> Result<(), PluginError> {
                <$ty>::kv_delete(self, plugin_id, key).await
            }
            async fn kv_list_keys(
                &self,
                plugin_id: &str,
                prefix: Option<&str>,
            ) -> Result<Vec<String>, PluginError> {
                <$ty>::kv_list_keys(self, plugin_id, prefix).await
            }
            async fn kv_clear(&self, plugin_id: &str) -> Result<u64, PluginError> {
                <$ty>::kv_clear(self, plugin_id).await
            }
            async fn secret_get(
                &self,
                plugin_id: &str,
                secret_key: &str,
            ) -> Result<Option<String>, PluginError> {
                <$ty>::secret_get(self, plugin_id, secret_key).await
            }
            async fn secret_put(
                &self,
                plugin_id: &str,
                secret_key: &str,
                value: &str,
            ) -> Result<(), PluginError> {
                <$ty>::secret_put(self, plugin_id, secret_key, value).await
            }
            async fn secret_delete(
                &self,
                plugin_id: &str,
                secret_key: &str,
            ) -> Result<bool, PluginError> {
                <$ty>::secret_delete(self, plugin_id, secret_key).await
            }
            async fn publish_event(
                &self,
                topic: &str,
                event_type: &str,
                payload: &serde_json::Value,
            ) -> Result<u64, PluginError> {
                <$ty>::publish_event(self, topic, event_type, payload).await
            }
            async fn events_subscribe(
                &self,
                plugin_id: &str,
                topic: Option<&str>,
                event_type: Option<&str>,
                since_cursor: Option<u64>,
                limit: usize,
            ) -> Result<PluginEventSubscriptionBatch, PluginError> {
                <$ty>::events_subscribe(self, plugin_id, topic, event_type, since_cursor, limit)
                    .await
            }
            async fn events_ack(
                &self,
                plugin_id: &str,
                subscription_key: &str,
                cursor: u64,
            ) -> Result<u64, PluginError> {
                <$ty>::events_ack(self, plugin_id, subscription_key, cursor).await
            }
            async fn quarantine_plugin(
                &self,
                plugin_id: &str,
                reason: &str,
            ) -> Result<(), PluginError> {
                <$ty>::quarantine_plugin(self, plugin_id, reason).await
            }
            async fn quarantine_reason(
                &self,
                plugin_id: &str,
            ) -> Result<Option<String>, PluginError> {
                <$ty>::quarantine_reason(self, plugin_id).await
            }
        }
    };
}

impl_plugin_registry!(InMemoryPluginRegistry);
impl_plugin_registry!(SqlitePluginRegistry);
