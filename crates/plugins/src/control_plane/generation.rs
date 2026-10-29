use std::sync::atomic::Ordering;

use super::*;
use crate::{CapabilityGrant, PluginActivation, PluginError, PluginPackage};

impl InMemoryPluginRegistry {
    pub(super) async fn active_generation(
        &self,
        plugin_id: &str,
    ) -> Result<Option<u64>, PluginError> {
        Ok(self
            .published_generations
            .read()
            .map_err(lock_error)?
            .get(plugin_id)
            .copied())
    }

    pub(super) async fn active_contributions(
        &self,
    ) -> Result<Vec<crate::ContributionDescriptor>, PluginError> {
        Ok(self
            .published_contributions
            .read()
            .map_err(lock_error)?
            .values()
            .flatten()
            .cloned()
            .collect())
    }

    pub(super) async fn create_candidate(&self, plugin_id: &str) -> Result<u64, PluginError> {
        let package = self
            .plugins
            .read()
            .map_err(lock_error)?
            .get(plugin_id)
            .map(|plugin| plugin.package.clone())
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        self.prepare_package_candidate(&package).await
    }

    pub(super) async fn prepare_package_candidate(
        &self,
        package: &PluginPackage,
    ) -> Result<u64, PluginError> {
        let generation = self.next_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.candidate_packages
            .write()
            .map_err(lock_error)?
            .insert(generation, package.clone());
        Ok(generation)
    }

    pub(super) async fn publish_candidate(
        &self,
        plugin_id: &str,
        generation: u64,
        package: &PluginPackage,
        contributions: &[crate::ContributionDescriptor],
        grants: &[CapabilityGrant],
    ) -> Result<(), PluginError> {
        let candidate = self
            .candidate_packages
            .write()
            .map_err(lock_error)?
            .remove(&generation)
            .ok_or_else(|| PluginError::registry("candidate package is missing"))?;
        let mut plugins = self.plugins.write().map_err(lock_error)?;
        let installed = plugins
            .get_mut(plugin_id)
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        installed.package = candidate;
        installed.activation = PluginActivation::Enabled;
        self.quarantined
            .write()
            .map_err(lock_error)?
            .remove(plugin_id);
        self.grants
            .write()
            .map_err(lock_error)?
            .insert(plugin_id.to_owned(), grants.to_vec());
        let package_digest = package_digest(package)?;
        installed.package_digest = package_digest.clone();
        let mut locks = self.runtime_locks.write().map_err(lock_error)?;
        let lock_updates: Vec<_> = package
            .runtimes
            .iter()
            .filter_map(|runtime| {
                locks
                    .iter()
                    .find(|((owner, _, runtime_id), _)| {
                        owner == plugin_id && runtime_id == &runtime.id
                    })
                    .map(|(_, artifact)| {
                        (
                            (
                                plugin_id.to_owned(),
                                package_digest.clone(),
                                runtime.id.clone(),
                            ),
                            artifact.clone(),
                        )
                    })
            })
            .collect();
        for (lock_key, artifact) in lock_updates {
            locks.insert(lock_key, artifact);
        }
        self.published_generations
            .write()
            .map_err(lock_error)?
            .insert(plugin_id.to_owned(), generation);
        self.published_contributions
            .write()
            .map_err(lock_error)?
            .insert(plugin_id.to_owned(), contributions.to_vec());
        Ok(())
    }

    pub(super) async fn fail_candidate(
        &self,
        generation: u64,
        _evidence: &str,
    ) -> Result<(), PluginError> {
        self.candidate_packages
            .write()
            .map_err(lock_error)?
            .remove(&generation);
        Ok(())
    }

    pub(super) async fn retire_generation(&self, _generation: u64) -> Result<(), PluginError> {
        Ok(())
    }

    pub(super) async fn retire_draining_generations(
        &self,
        _plugin_id: &str,
    ) -> Result<(), PluginError> {
        Ok(())
    }

    pub(super) async fn retire_published_generation(
        &self,
        plugin_id: &str,
    ) -> Result<(), PluginError> {
        self.published_generations
            .write()
            .map_err(lock_error)?
            .remove(plugin_id);
        self.published_contributions
            .write()
            .map_err(lock_error)?
            .remove(plugin_id);
        Ok(())
    }

    pub(super) async fn replace_declared_grants(
        &self,
        plugin_id: &str,
        permissions: &[crate::CapabilityRequest],
    ) -> Result<(), PluginError> {
        self.grants.write().map_err(lock_error)?.insert(
            plugin_id.to_owned(),
            permissions
                .iter()
                .map(|permission| crate::CapabilityGrant {
                    capability: permission.capability.clone(),
                    scope: permission.scope.clone(),
                    trust_tier: permission.trust_tier.clone(),
                })
                .collect(),
        );
        Ok(())
    }

    pub(super) async fn capability_grants(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<crate::CapabilityGrant>, PluginError> {
        Ok(self
            .grants
            .read()
            .map_err(lock_error)?
            .get(plugin_id)
            .cloned()
            .unwrap_or_default())
    }

    pub(super) async fn quarantine_plugin(
        &self,
        plugin_id: &str,
        reason: &str,
    ) -> Result<(), PluginError> {
        {
            let mut plugins = self.plugins.write().map_err(lock_error)?;
            if let Some(plugin) = plugins.get_mut(plugin_id) {
                plugin.activation = PluginActivation::Disabled;
            }
        }
        self.published_generations
            .write()
            .map_err(lock_error)?
            .remove(plugin_id);
        self.published_contributions
            .write()
            .map_err(lock_error)?
            .remove(plugin_id);
        self.quarantined
            .write()
            .map_err(lock_error)?
            .insert(plugin_id.to_owned(), reason.to_owned());
        Ok(())
    }

    pub(super) async fn quarantine_reason(
        &self,
        plugin_id: &str,
    ) -> Result<Option<String>, PluginError> {
        Ok(self
            .quarantined
            .read()
            .map_err(lock_error)?
            .get(plugin_id)
            .cloned())
    }
}

impl SqlitePluginRegistry {
    pub(super) async fn active_generation(
        &self,
        plugin_id: &str,
    ) -> Result<Option<u64>, PluginError> {
        let generation = sqlx::query_scalar::<_, i64>(
            "SELECT generation_id FROM plugin_generations_v4
             WHERE plugin_id = ? AND state IN ('active','active_degraded')
             ORDER BY generation_id DESC LIMIT 1",
        )
        .bind(plugin_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?;
        generation
            .map(|value| u64::try_from(value).map_err(registry_error))
            .transpose()
    }

    pub(super) async fn active_contributions(
        &self,
    ) -> Result<Vec<crate::ContributionDescriptor>, PluginError> {
        let declarations = sqlx::query_scalar::<_, String>(
            "SELECT c.declaration_json
             FROM plugin_contributions_v4 c
             JOIN plugin_generations_v4 g ON g.generation_id = c.generation_id
             WHERE g.state IN ('active','active_degraded')
             ORDER BY c.plugin_id, c.kind, c.contribution_id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(registry_error)?;
        let descriptors: Vec<crate::ContributionDescriptor> = declarations
            .into_iter()
            .map(|value| serde_json::from_str(&value).map_err(registry_error))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(descriptors
            .into_iter()
            .filter(|descriptor| !crate::catalog::is_retired_plugin_id(&descriptor.plugin_id))
            .collect())
    }

    pub(super) async fn create_candidate(&self, plugin_id: &str) -> Result<u64, PluginError> {
        let package = self
            .plugin(plugin_id)
            .await?
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        self.prepare_package_candidate(&package.package).await
    }

    pub(super) async fn prepare_package_candidate(
        &self,
        package: &PluginPackage,
    ) -> Result<u64, PluginError> {
        let package_json = serde_json::to_string(package).map_err(registry_error)?;
        let digest = package_digest(package)?;
        let publisher = package_publisher(package);
        let manifest_json = serde_json::to_string(&package.manifest).map_err(registry_error)?;
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
        .bind(package.id.as_str())
        .bind(&package.version)
        .bind(&digest)
        .bind(source_kind_key(package.source.kind))
        .bind(package.source.path.to_string_lossy().as_ref())
        .bind(manifest_json)
        .bind(package_json)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;
        let result = sqlx::query(
            "INSERT INTO plugin_generations_v4
                 (plugin_id, package_digest, state, evidence_json, created_at, published_at)
             VALUES (?, ?, 'candidate', '{}', datetime('now','subsec'), NULL)",
        )
        .bind(package.id.as_str())
        .bind(&digest)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;
        transaction.commit().await.map_err(registry_error)?;
        u64::try_from(result.last_insert_rowid()).map_err(registry_error)
    }

    pub(super) async fn publish_candidate(
        &self,
        plugin_id: &str,
        generation: u64,
        package: &PluginPackage,
        contributions: &[crate::ContributionDescriptor],
        grants: &[CapabilityGrant],
    ) -> Result<(), PluginError> {
        self.ensure_kv_table().await?;
        let generation = i64::try_from(generation).map_err(registry_error)?;
        let mut transaction = self.pool.begin().await.map_err(registry_error)?;
        let candidate: Option<String> = sqlx::query_scalar(
            "SELECT package_digest FROM plugin_generations_v4
             WHERE generation_id = ? AND plugin_id = ? AND state = 'candidate'",
        )
        .bind(generation)
        .bind(plugin_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(registry_error)?;
        let candidate = candidate.ok_or_else(|| {
            PluginError::registry("candidate generation is missing or no longer publishable")
        })?;
        sqlx::query(
            "UPDATE plugin_generations_v4 SET state = 'draining'
             WHERE plugin_id = ? AND state IN ('active','active_degraded')",
        )
        .bind(plugin_id)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;
        sqlx::query(
            "UPDATE plugin_generations_v4
             SET state = 'active', published_at = datetime('now','subsec')
             WHERE generation_id = ?",
        )
        .bind(generation)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;
        sqlx::query(
            "UPDATE plugin_activation_intents_v4
             SET enabled = 1, quarantined = 0, quarantine_reason = NULL,
                 target_digest = ?, updated_at = datetime('now','subsec')
             WHERE plugin_id = ?",
        )
        .bind(&candidate)
        .bind(plugin_id)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;
        sqlx::query(
            "UPDATE plugin_installations_v4
             SET rollback_package_digest = CASE
                     WHEN current_package_digest <> ? THEN current_package_digest
                     ELSE rollback_package_digest
                 END,
                 current_package_digest = ?, updated_at = datetime('now','subsec')
             WHERE plugin_id = ?",
        )
        .bind(&candidate)
        .bind(&candidate)
        .bind(plugin_id)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;
        for contribution in contributions {
            sqlx::query(
                "INSERT INTO plugin_contributions_v4
                     (generation_id, plugin_id, kind, contribution_id, declaration_json, readiness)
                 VALUES (?, ?, ?, ?, ?, 'ready')",
            )
            .bind(generation)
            .bind(plugin_id)
            .bind(contribution_kind_key(contribution.kind))
            .bind(&contribution.id)
            .bind(serde_json::to_string(contribution).map_err(registry_error)?)
            .execute(&mut *transaction)
            .await
            .map_err(registry_error)?;
        }
        let _ = (grants, plugin_id);
        // Runtime downloads/probes happen before publication. The publish
        // transaction binds an already verified artifact to the candidate
        // digest, so consumers never observe a generation without its exact
        // Runtime lock.
        for runtime in &package.runtimes {
            sqlx::query(
                "INSERT INTO plugin_runtime_locks_v4
                    (plugin_id, package_digest, runtime_id, version, target, content_digest,
                     absolute_entrypoint, ownership, probe_evidence_json)
                 SELECT ?, ?, runtime_id, version, target, content_digest,
                        absolute_entrypoint, ownership, probe_evidence_json
                 FROM plugin_runtime_locks_v4
                 WHERE plugin_id = ? AND runtime_id = ?
                   AND (? IS NULL OR version = ?)
                   AND (? = '' OR target = ?)
                   AND (? = '' OR content_digest = ?)
                 ORDER BY rowid DESC LIMIT 1
                 ON CONFLICT(plugin_id, package_digest, runtime_id, target) DO NOTHING",
            )
            .bind(plugin_id)
            .bind(&candidate)
            .bind(plugin_id)
            .bind(&runtime.id)
            .bind(runtime.version.as_deref())
            .bind(runtime.version.as_deref())
            .bind(&runtime.target)
            .bind(&runtime.target)
            .bind(&runtime.content_digest)
            .bind(&runtime.content_digest)
            .execute(&mut *transaction)
            .await
            .map_err(registry_error)?;
            let exact_lock_exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM plugin_runtime_locks_v4
                 WHERE plugin_id = ? AND package_digest = ? AND runtime_id = ?
                   AND (? IS NULL OR version = ?)
                   AND (? = '' OR target = ?)
                   AND (? = '' OR content_digest = ?)",
            )
            .bind(plugin_id)
            .bind(&candidate)
            .bind(&runtime.id)
            .bind(runtime.version.as_deref())
            .bind(runtime.version.as_deref())
            .bind(&runtime.target)
            .bind(&runtime.target)
            .bind(&runtime.content_digest)
            .bind(&runtime.content_digest)
            .fetch_one(&mut *transaction)
            .await
            .map_err(registry_error)?;
            if exact_lock_exists != 1 {
                return Err(PluginError::registry(format!(
                    "candidate Runtime lock for `{}` is missing or does not match its exact version, target, and digest",
                    runtime.id
                )));
            }
        }
        transaction.commit().await.map_err(registry_error)
    }

    pub(super) async fn fail_candidate(
        &self,
        generation: u64,
        evidence: &str,
    ) -> Result<(), PluginError> {
        sqlx::query(
            "UPDATE plugin_generations_v4
             SET state = 'failed', evidence_json = ?
             WHERE generation_id = ? AND state = 'candidate'",
        )
        .bind(serde_json::json!({ "error": evidence }).to_string())
        .bind(i64::try_from(generation).map_err(registry_error)?)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(())
    }

    pub(super) async fn retire_generation(&self, generation: u64) -> Result<(), PluginError> {
        let mut transaction = self.pool.begin().await.map_err(registry_error)?;
        sqlx::query(
            "UPDATE plugin_generations_v4 SET state = 'retired'
             WHERE generation_id = ? AND state = 'draining'",
        )
        .bind(i64::try_from(generation).map_err(registry_error)?)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;
        gc_runtime_locks(&mut transaction).await?;
        transaction.commit().await.map_err(registry_error)
    }

    pub(super) async fn retire_draining_generations(
        &self,
        plugin_id: &str,
    ) -> Result<(), PluginError> {
        let mut transaction = self.pool.begin().await.map_err(registry_error)?;
        sqlx::query(
            "UPDATE plugin_generations_v4 SET state = 'retired'
             WHERE plugin_id = ? AND state = 'draining'",
        )
        .bind(plugin_id)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;
        gc_runtime_locks(&mut transaction).await?;
        transaction.commit().await.map_err(registry_error)
    }

    pub(super) async fn retire_published_generation(
        &self,
        plugin_id: &str,
    ) -> Result<(), PluginError> {
        sqlx::query(
            "UPDATE plugin_generations_v4 SET state = 'retired'
             WHERE plugin_id = ? AND state IN ('active','active_degraded','draining')",
        )
        .bind(plugin_id)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(())
    }

    pub(super) async fn replace_declared_grants(
        &self,
        plugin_id: &str,
        permissions: &[crate::CapabilityRequest],
    ) -> Result<(), PluginError> {
        let _ = permissions;
        let _ = self
            .plugin(plugin_id)
            .await?
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        Ok(())
    }

    pub(super) async fn capability_grants(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<crate::CapabilityGrant>, PluginError> {
        let _ = plugin_id;
        Ok(Vec::new())
    }

    pub(super) async fn quarantine_plugin(
        &self,
        plugin_id: &str,
        reason: &str,
    ) -> Result<(), PluginError> {
        self.ensure_kv_table().await?;
        let result = sqlx::query(
            "UPDATE plugin_activation_intents_v4
             SET enabled = 0, quarantined = 1, quarantine_reason = ?,
                 updated_at = datetime('now','subsec')
             WHERE plugin_id = ?",
        )
        .bind(reason)
        .bind(plugin_id)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        if result.rows_affected() == 0 {
            return Err(PluginError::not_found(plugin_id));
        }
        sqlx::query(
            "UPDATE plugin_generations_v4 SET state = 'retired'
             WHERE plugin_id = ? AND state IN ('active','active_degraded','draining')",
        )
        .bind(plugin_id)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(())
    }

    pub(super) async fn quarantine_reason(
        &self,
        plugin_id: &str,
    ) -> Result<Option<String>, PluginError> {
        self.ensure_kv_table().await?;
        let row: Option<(i64, Option<String>)> = sqlx::query_as(
            "SELECT quarantined, quarantine_reason
             FROM plugin_activation_intents_v4
             WHERE plugin_id = ?",
        )
        .bind(plugin_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?;
        match row {
            Some((quarantined, reason)) if quarantined != 0 => {
                Ok(Some(reason.unwrap_or_else(|| {
                    "Quarantined after repeated crashes".to_owned()
                })))
            }
            _ => Ok(None),
        }
    }
}
