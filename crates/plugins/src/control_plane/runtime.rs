use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use sqlx::Row;

use super::*;
use crate::{PluginError, PluginPackage, WorkerHostError};

fn runtime_artifact_key(runtime: &RuntimeInstallation) -> RuntimeArtifactKey {
    (
        runtime.id.clone(),
        runtime.version.clone(),
        runtime.target.clone(),
        runtime.content_digest.clone(),
    )
}

fn decode_runtime_row(
    row: sqlx::sqlite::SqliteRow,
    referenced_plugins: Vec<String>,
) -> Result<RuntimeInstallation, PluginError> {
    Ok(RuntimeInstallation {
        id: row.get("runtime_id"),
        version: row.get("version"),
        target: row.get("target"),
        content_digest: row.get("content_digest"),
        executable_path: PathBuf::from(row.get::<String, _>("absolute_entrypoint")),
        ownership: row.get("ownership"),
        installer: row.get("installer"),
        probe: serde_json::from_str(row.get::<String, _>("probe_evidence_json").as_str())
            .map_err(registry_error)?,
        referenced_plugins,
    })
}

impl InMemoryPluginRegistry {
    pub(super) async fn put_runtime(
        &self,
        plugin_id: &str,
        package_digest: &str,
        mut runtime: RuntimeInstallation,
    ) -> Result<(), PluginError> {
        let key = runtime_artifact_key(&runtime);
        runtime.referenced_plugins = vec![plugin_id.to_owned()];
        // Lock order: runtime_locks then runtimes. list_runtimes and
        // runtime_for_package take the same pair as shared reads.
        let mut locks = self.runtime_locks.write().map_err(lock_error)?;
        let mut runtimes = self.runtimes.write().map_err(lock_error)?;
        runtimes.insert(key.clone(), runtime);
        locks.insert(
            (
                plugin_id.to_owned(),
                package_digest.to_owned(),
                key.0.clone(),
            ),
            key,
        );
        Ok(())
    }

    pub(super) async fn runtime_for_plugin(
        &self,
        plugin_id: &str,
        runtime_id: &str,
    ) -> Result<Option<RuntimeInstallation>, PluginError> {
        let digest = self
            .plugins
            .read()
            .map_err(lock_error)?
            .get(plugin_id)
            .map(|plugin| plugin.package_digest.clone())
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        self.runtime_for_package(plugin_id, &digest, runtime_id)
            .await
    }

    pub(super) async fn runtime_for_package(
        &self,
        plugin_id: &str,
        package_digest: &str,
        runtime_id: &str,
    ) -> Result<Option<RuntimeInstallation>, PluginError> {
        let locks = self.runtime_locks.read().map_err(lock_error)?;
        let Some(key) = locks.get(&(
            plugin_id.to_owned(),
            package_digest.to_owned(),
            runtime_id.to_owned(),
        )) else {
            return Ok(None);
        };
        Ok(self.runtimes.read().map_err(lock_error)?.get(key).cloned())
    }

    pub(super) async fn runtime_for_generation(
        &self,
        plugin_id: &str,
        generation: u64,
        runtime_id: &str,
    ) -> Result<Option<RuntimeInstallation>, PluginError> {
        let package = self
            .candidate_packages
            .read()
            .map_err(lock_error)?
            .get(&generation)
            .cloned();
        let digest = if let Some(package) = package {
            package_digest(&package)?
        } else {
            self.plugins
                .read()
                .map_err(lock_error)?
                .get(plugin_id)
                .filter(|_| {
                    self.published_generations
                        .read()
                        .is_ok_and(|published| published.get(plugin_id) == Some(&generation))
                })
                .map(|plugin| plugin.package_digest.clone())
                .ok_or_else(|| PluginError::registry("activation generation is not published"))?
        };
        self.runtime_for_package(plugin_id, &digest, runtime_id)
            .await
    }

    pub(super) async fn list_runtimes(&self) -> Result<Vec<RuntimeInstallation>, PluginError> {
        let locks = self.runtime_locks.read().map_err(lock_error)?;
        let runtimes = self.runtimes.read().map_err(lock_error)?;
        let mut referenced: BTreeMap<&RuntimeArtifactKey, Vec<String>> = BTreeMap::new();
        for ((plugin_id, _, _), artifact) in locks.iter() {
            referenced
                .entry(artifact)
                .or_default()
                .push(plugin_id.clone());
        }
        Ok(runtimes
            .iter()
            .map(|(key, runtime)| {
                let mut runtime = runtime.clone();
                runtime.referenced_plugins = referenced.get(key).cloned().unwrap_or_default();
                runtime.referenced_plugins.sort();
                runtime
            })
            .collect())
    }

    pub(super) async fn delete_unreferenced_runtime_artifacts(
        &self,
    ) -> Result<Vec<RuntimeInstallation>, PluginError> {
        let locks = self.runtime_locks.read().map_err(lock_error)?;
        let mut runtimes = self.runtimes.write().map_err(lock_error)?;
        let referenced: BTreeSet<RuntimeArtifactKey> = locks.values().cloned().collect();
        let mut removed = Vec::new();
        runtimes.retain(|key, runtime| {
            if referenced.contains(key) {
                true
            } else {
                removed.push(runtime.clone());
                false
            }
        });
        Ok(removed)
    }
}

impl SqlitePluginRegistry {
    pub(super) async fn put_runtime(
        &self,
        plugin_id: &str,
        package_digest: &str,
        runtime: RuntimeInstallation,
    ) -> Result<(), PluginError> {
        let mut transaction = self.pool.begin().await.map_err(registry_error)?;
        let probe_json = serde_json::to_string(&runtime.probe).map_err(registry_error)?;
        sqlx::query(
            "INSERT INTO plugin_runtime_artifacts_v4
                 (runtime_id, version, target, content_digest, absolute_entrypoint,
                  ownership, installer, probe_evidence_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','subsec'))
             ON CONFLICT(runtime_id, version, target, content_digest) DO UPDATE SET
                 absolute_entrypoint = excluded.absolute_entrypoint,
                 probe_evidence_json = excluded.probe_evidence_json",
        )
        .bind(&runtime.id)
        .bind(&runtime.version)
        .bind(&runtime.target)
        .bind(&runtime.content_digest)
        .bind(runtime.executable_path.to_string_lossy().as_ref())
        .bind(&runtime.ownership)
        .bind(&runtime.installer)
        .bind(&probe_json)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;
        sqlx::query(
            "INSERT INTO plugin_runtime_locks_v4
                 (plugin_id, package_digest, runtime_id, version, target, content_digest,
                  absolute_entrypoint, ownership, probe_evidence_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(plugin_id, package_digest, runtime_id, target) DO UPDATE SET
                 version = excluded.version,
                 content_digest = excluded.content_digest,
                 absolute_entrypoint = excluded.absolute_entrypoint,
                 ownership = excluded.ownership,
                 probe_evidence_json = excluded.probe_evidence_json",
        )
        .bind(plugin_id)
        .bind(package_digest)
        .bind(&runtime.id)
        .bind(&runtime.version)
        .bind(&runtime.target)
        .bind(&runtime.content_digest)
        .bind(runtime.executable_path.to_string_lossy().as_ref())
        .bind(&runtime.ownership)
        .bind(probe_json)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;
        transaction.commit().await.map_err(registry_error)
    }

    pub(super) async fn runtime_for_plugin(
        &self,
        plugin_id: &str,
        runtime_id: &str,
    ) -> Result<Option<RuntimeInstallation>, PluginError> {
        let row = sqlx::query(
            "SELECT a.runtime_id, a.version, a.target, a.content_digest,
                    a.absolute_entrypoint, a.ownership, a.installer, a.probe_evidence_json
             FROM plugin_installations_v4 i
             JOIN plugin_runtime_locks_v4 l
               ON l.plugin_id = i.plugin_id AND l.package_digest = i.current_package_digest
             JOIN plugin_runtime_artifacts_v4 a
               ON a.runtime_id = l.runtime_id AND a.version = l.version
              AND a.target = l.target AND a.content_digest = l.content_digest
             WHERE i.plugin_id = ? AND l.runtime_id = ?",
        )
        .bind(plugin_id)
        .bind(runtime_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?;
        row.map(|row| decode_runtime_row(row, vec![plugin_id.to_owned()]))
            .transpose()
    }

    pub(super) async fn runtime_for_package(
        &self,
        plugin_id: &str,
        package_digest: &str,
        runtime_id: &str,
    ) -> Result<Option<RuntimeInstallation>, PluginError> {
        let row = sqlx::query(
            "SELECT a.runtime_id, a.version, a.target, a.content_digest,
                    a.absolute_entrypoint, a.ownership, a.installer, a.probe_evidence_json
             FROM plugin_runtime_locks_v4 l
             JOIN plugin_runtime_artifacts_v4 a
               ON a.runtime_id = l.runtime_id AND a.version = l.version
              AND a.target = l.target AND a.content_digest = l.content_digest
             WHERE l.plugin_id = ? AND l.package_digest = ? AND l.runtime_id = ?",
        )
        .bind(plugin_id)
        .bind(package_digest)
        .bind(runtime_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?;
        row.map(|row| decode_runtime_row(row, vec![plugin_id.to_owned()]))
            .transpose()
    }

    pub(super) async fn runtime_for_generation(
        &self,
        plugin_id: &str,
        generation: u64,
        runtime_id: &str,
    ) -> Result<Option<RuntimeInstallation>, PluginError> {
        let row = sqlx::query(
            "SELECT a.runtime_id, a.version, a.target, a.content_digest,
                    a.absolute_entrypoint, a.ownership, a.installer, a.probe_evidence_json
             FROM plugin_generations_v4 g
             JOIN plugin_runtime_locks_v4 l
               ON l.plugin_id = g.plugin_id AND l.package_digest = g.package_digest
             JOIN plugin_runtime_artifacts_v4 a
               ON a.runtime_id = l.runtime_id AND a.version = l.version
              AND a.target = l.target AND a.content_digest = l.content_digest
             WHERE g.plugin_id = ? AND g.generation_id = ? AND l.runtime_id = ?",
        )
        .bind(plugin_id)
        .bind(generation as i64)
        .bind(runtime_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?;
        row.map(|row| decode_runtime_row(row, vec![plugin_id.to_owned()]))
            .transpose()
    }

    pub(super) async fn list_runtimes(&self) -> Result<Vec<RuntimeInstallation>, PluginError> {
        let rows = sqlx::query(
            "SELECT a.runtime_id, a.version, a.target, a.content_digest,
                    a.absolute_entrypoint, a.ownership, a.installer, a.probe_evidence_json,
                    COALESCE(group_concat(DISTINCT l.plugin_id), '') AS referenced_plugins
             FROM plugin_runtime_artifacts_v4 a
             LEFT JOIN plugin_runtime_locks_v4 l
               ON a.runtime_id = l.runtime_id AND a.version = l.version
              AND a.target = l.target AND a.content_digest = l.content_digest
             GROUP BY a.runtime_id, a.version, a.target, a.content_digest,
                      a.absolute_entrypoint, a.ownership, a.installer, a.probe_evidence_json
             ORDER BY a.runtime_id, a.version, a.target, a.content_digest",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(registry_error)?;
        rows.into_iter()
            .map(|row| {
                let refs = row
                    .get::<String, _>("referenced_plugins")
                    .split(',')
                    .filter(|item| !item.is_empty())
                    .map(str::to_owned)
                    .collect();
                decode_runtime_row(row, refs)
            })
            .collect()
    }

    pub(super) async fn delete_unreferenced_runtime_artifacts(
        &self,
    ) -> Result<Vec<RuntimeInstallation>, PluginError> {
        let mut transaction = self.pool.begin().await.map_err(registry_error)?;
        gc_runtime_locks(&mut transaction).await?;
        transaction.commit().await.map_err(registry_error)?;
        let inventory = self.list_runtimes().await?;
        let orphans: Vec<RuntimeInstallation> = inventory
            .into_iter()
            .filter(|runtime| runtime.referenced_plugins.is_empty())
            .collect();
        sqlx::query(
            "DELETE FROM plugin_runtime_artifacts_v4
             WHERE NOT EXISTS (
               SELECT 1 FROM plugin_runtime_locks_v4 l
               WHERE l.runtime_id = plugin_runtime_artifacts_v4.runtime_id
                 AND l.version = plugin_runtime_artifacts_v4.version
                 AND l.target = plugin_runtime_artifacts_v4.target
                 AND l.content_digest = plugin_runtime_artifacts_v4.content_digest
             )",
        )
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(orphans)
    }
}

impl PluginControlPlane {
    pub(super) async fn ensure_runtime_readiness(
        &self,
        plugin_id: &str,
        package: &PluginPackage,
    ) -> Result<(), WorkerHostError> {
        for declared in &package.runtimes {
            if let Some(reason) = self.runtime_unready_reason(plugin_id, declared).await? {
                return Err(WorkerHostError::external("runtime_not_ready", reason));
            }
        }
        Ok(())
    }

    /// Why this runtime cannot be used yet, or `None` when it is ready.
    pub(super) async fn runtime_unready_reason(
        &self,
        plugin_id: &str,
        declared: &crate::RuntimeContribution,
    ) -> Result<Option<String>, WorkerHostError> {
        let locked = self
            .registry
            .runtime_for_plugin(plugin_id, &declared.id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?;
        let Some(locked) = locked else {
            return Ok(Some(format!(
                "Runtime {} has no installation lock",
                declared.id
            )));
        };
        if declared
            .version
            .as_deref()
            .is_some_and(|version| version != locked.version)
            || (!declared.target.is_empty() && declared.target != locked.target)
            || (!declared.content_digest.is_empty()
                && declared.content_digest != locked.content_digest)
            || !locked.executable_path.is_absolute()
        {
            return Ok(Some(format!(
                "Runtime {} lock does not match the candidate",
                declared.id
            )));
        }
        Ok(None)
    }

    /// Runtime ids this plugin declares but cannot use. Diagnostics read this
    /// so the panel can explain an enabled plugin that never serves anything.
    pub async fn missing_runtimes(
        &self,
        installed: &InstalledPlugin,
    ) -> Result<Vec<String>, WorkerHostError> {
        let plugin_id = installed.id().to_owned();
        let mut missing = Vec::new();
        for declared in &installed.package.runtimes {
            if self
                .runtime_unready_reason(&plugin_id, declared)
                .await?
                .is_some()
            {
                missing.push(declared.id.clone());
            }
        }
        Ok(missing)
    }

    pub async fn reclaim_unreferenced_runtimes(
        &self,
        runtime_root: &Path,
    ) -> Result<Vec<String>, PluginError> {
        let orphans = self
            .registry
            .delete_unreferenced_runtime_artifacts()
            .await?;
        let mut reclaimed = Vec::new();
        let root = runtime_root
            .canonicalize()
            .unwrap_or_else(|_| runtime_root.to_path_buf());
        for runtime in orphans {
            if runtime.ownership != "managed" {
                continue;
            }
            let path = runtime.executable_path.clone();
            if let Ok(canonical) = path.canonicalize()
                && canonical.starts_with(&root)
            {
                let dir = canonical.parent().unwrap_or(canonical.as_path());
                let _ = std::fs::remove_dir_all(dir);
            }
            reclaimed.push(format!(
                "{}@{} ({})",
                runtime.id, runtime.version, runtime.content_digest
            ));
        }
        Ok(reclaimed)
    }

    pub async fn runtime_inventory(&self) -> Result<Vec<RuntimeInstallation>, PluginError> {
        self.registry.list_runtimes().await
    }

    pub async fn runtime_for_plugin(
        &self,
        plugin_id: &str,
        runtime_id: &str,
    ) -> Result<Option<RuntimeInstallation>, PluginError> {
        self.registry
            .runtime_for_plugin(plugin_id, runtime_id)
            .await
    }

    pub async fn runtime_for_package(
        &self,
        plugin_id: &str,
        package_digest: &str,
        runtime_id: &str,
    ) -> Result<Option<RuntimeInstallation>, PluginError> {
        self.registry
            .runtime_for_package(plugin_id, package_digest, runtime_id)
            .await
    }

    pub async fn runtime_for_generation(
        &self,
        plugin_id: &str,
        generation: u64,
        runtime_id: &str,
    ) -> Result<Option<RuntimeInstallation>, PluginError> {
        self.registry
            .runtime_for_generation(plugin_id, generation, runtime_id)
            .await
    }

    pub async fn validate_runtime_readiness(&self, plugin_id: &str) -> Result<(), WorkerHostError> {
        let plugin = self
            .registry
            .plugin(plugin_id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?
            .ok_or_else(|| WorkerHostError::external("plugin_not_found", plugin_id))?;
        self.ensure_runtime_readiness(plugin_id, &plugin.package)
            .await
    }

    pub async fn record_runtime(
        &self,
        plugin_id: &str,
        runtime: RuntimeInstallation,
    ) -> Result<(), PluginError> {
        let plugin = self
            .registry
            .plugin(plugin_id)
            .await?
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        self.registry
            .put_runtime(plugin_id, &plugin.package_digest, runtime)
            .await
    }

    pub async fn record_runtime_for_package(
        &self,
        plugin_id: &str,
        package_digest: &str,
        runtime: RuntimeInstallation,
    ) -> Result<(), PluginError> {
        if self.registry.plugin(plugin_id).await?.is_none() {
            return Err(PluginError::not_found(plugin_id));
        }
        self.registry
            .put_runtime(plugin_id, package_digest, runtime)
            .await
    }

    #[doc(hidden)]
    pub async fn record_runtime_for_test(
        &self,
        plugin_id: &str,
        id: &str,
        version: &str,
        executable_path: &str,
    ) -> Result<(), PluginError> {
        self.record_runtime(
            plugin_id,
            RuntimeInstallation {
                id: id.to_owned(),
                version: version.to_owned(),
                target: "test-target".to_owned(),
                content_digest: format!("sha256:{id}-{version}"),
                executable_path: PathBuf::from(executable_path),
                ownership: "managed".to_owned(),
                installer: "test".to_owned(),
                probe: Vec::new(),
                referenced_plugins: vec![plugin_id.to_owned()],
            },
        )
        .await
    }
}
