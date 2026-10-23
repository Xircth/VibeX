use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::{
    ActionId, ActivationLease, ActivationManager, CapabilityBroker, CapabilityGrant,
    ContributionCatalog, PluginAction, PluginActivation, PluginError, PluginPackage, PluginSource,
    PromptBlock, ResolvedFileOpener, SkillId, ToolId, WorkerActivation, WorkerHostError,
    contribution::{ContributionRegistry, descriptors_for_package},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConflictDecision {
    Reject,
    KeepInstalled,
    Replace,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImportDisposition {
    Installed,
    KeptInstalled,
    Replaced,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PluginAuditEvent {
    pub event: String,
    pub evidence: serde_json::Value,
}

pub type HostAuditEntry = PluginAuditEvent;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBusEvent {
    pub cursor: u64,
    pub topic: String,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEventSubscriptionBatch {
    pub cursor: u64,
    pub acked_cursor: u64,
    pub events: Vec<PluginBusEvent>,
}

#[async_trait]
pub trait PluginCommandHandler: Send + Sync {
    async fn handle(
        &self,
        plugin_id: &str,
        command_name: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, WorkerHostError>;
}

struct FnPluginCommandHandler<F>(F);

#[async_trait]
impl<F, Fut> PluginCommandHandler for FnPluginCommandHandler<F>
where
    F: Fn(String, String, serde_json::Value) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<serde_json::Value, WorkerHostError>> + Send + 'static,
{
    async fn handle(
        &self,
        plugin_id: &str,
        command_name: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, WorkerHostError> {
        (self.0)(plugin_id.to_owned(), command_name.to_owned(), input).await
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImportConflict {
    pub plugin_id: String,
    pub installed_source: PathBuf,
    pub incoming_source: PathBuf,
}

pub struct BundledPluginActivation {
    pub node_executable: PathBuf,
    pub broker: Arc<dyn crate::CapabilityBroker>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct InstalledPlugin {
    pub package: PluginPackage,
    pub activation: PluginActivation,
    pub package_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivationRecoveryFailure {
    pub plugin_id: String,
    pub code: String,
    pub message: String,
}

impl InstalledPlugin {
    pub fn id(&self) -> &str {
        self.package.id.as_str()
    }

    pub fn source(&self) -> &PluginSource {
        &self.package.source
    }
}

impl std::ops::Deref for InstalledPlugin {
    type Target = PluginPackage;

    fn deref(&self) -> &Self::Target {
        &self.package
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallation {
    pub id: String,
    pub version: String,
    #[serde(default = "external_runtime_target")]
    pub target: String,
    #[serde(default)]
    pub content_digest: String,
    pub executable_path: PathBuf,
    #[serde(default = "external_runtime_ownership")]
    pub ownership: String,
    #[serde(default)]
    pub installer: String,
    #[serde(default)]
    pub probe: Vec<String>,
    #[serde(default)]
    pub referenced_plugins: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImportResult {
    pub disposition: ImportDisposition,
    pub plugin: InstalledPlugin,
}

/// Builds the compatibility grant projection for a full-trust package.
///
/// Installation is the trust decision. Every declared Host API is available to
/// the candidate without a second consent flow; persisted grants are retained
/// only so older hosts and diagnostics can read the same package record.
pub fn candidate_capability_grants(
    package: &PluginPackage,
    _published_grants: &[CapabilityGrant],
    _selected_permission_ids: &[String],
) -> Result<Vec<CapabilityGrant>, PluginError> {
    Ok(package
        .permissions
        .iter()
        .map(|permission| CapabilityGrant {
            capability: permission.capability.clone(),
            scope: permission.scope.clone(),
            trust_tier: permission.trust_tier.clone(),
        })
        .collect())
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

#[derive(Default)]
pub struct InMemoryPluginRegistry {
    plugins: RwLock<BTreeMap<String, InstalledPlugin>>,
    rollback_packages: RwLock<BTreeMap<String, InstalledPlugin>>,
    runtimes: RwLock<BTreeMap<RuntimeArtifactKey, RuntimeInstallation>>,
    runtime_locks: RwLock<BTreeMap<(String, String, String), RuntimeArtifactKey>>,
    next_generation: AtomicU64,
    published_generations: RwLock<BTreeMap<String, u64>>,
    candidate_packages: RwLock<BTreeMap<u64, PluginPackage>>,
    grants: RwLock<BTreeMap<String, Vec<crate::CapabilityGrant>>>,
    published_contributions: RwLock<BTreeMap<String, Vec<crate::ContributionDescriptor>>>,
    audit: RwLock<Vec<(String, PluginAuditEvent)>>,
    kv_store: RwLock<BTreeMap<(String, String), serde_json::Value>>,
    secrets_store: RwLock<BTreeMap<(String, String), String>>,
    next_event_cursor: AtomicU64,
    events_log: RwLock<Vec<PluginBusEvent>>,
    event_offsets: RwLock<BTreeMap<(String, String), u64>>,
    quarantined: RwLock<BTreeMap<String, String>>,
}

#[async_trait]
impl PluginRegistry for InMemoryPluginRegistry {
    async fn plugin(&self, plugin_id: &str) -> Result<Option<InstalledPlugin>, PluginError> {
        Ok(self
            .plugins
            .read()
            .map_err(lock_error)?
            .get(plugin_id)
            .cloned())
    }

    async fn list_plugins(&self) -> Result<Vec<InstalledPlugin>, PluginError> {
        Ok(self
            .plugins
            .read()
            .map_err(lock_error)?
            .values()
            .cloned()
            .collect())
    }

    async fn rollback_package(
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

    async fn put_plugin(&self, plugin: InstalledPlugin) -> Result<(), PluginError> {
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

    async fn set_activation(
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

    async fn delete_plugin(&self, plugin_id: &str) -> Result<(), PluginError> {
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

    async fn put_runtime(
        &self,
        plugin_id: &str,
        package_digest: &str,
        mut runtime: RuntimeInstallation,
    ) -> Result<(), PluginError> {
        let key = runtime_artifact_key(&runtime);
        runtime.referenced_plugins = vec![plugin_id.to_owned()];
        self.runtimes
            .write()
            .map_err(lock_error)?
            .insert(key.clone(), runtime);
        self.runtime_locks.write().map_err(lock_error)?.insert(
            (
                plugin_id.to_owned(),
                package_digest.to_owned(),
                key.0.clone(),
            ),
            key,
        );
        Ok(())
    }

    async fn runtime_for_plugin(
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

    async fn runtime_for_package(
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

    async fn runtime_for_generation(
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

    async fn list_runtimes(&self) -> Result<Vec<RuntimeInstallation>, PluginError> {
        let locks = self.runtime_locks.read().map_err(lock_error)?;
        let mut runtimes = self.runtimes.read().map_err(lock_error)?.clone();
        for (key, runtime) in &mut runtimes {
            runtime.referenced_plugins = locks
                .iter()
                .filter(|(_, artifact)| *artifact == key)
                .map(|((plugin_id, _, _), _)| plugin_id.clone())
                .collect();
            runtime.referenced_plugins.sort();
        }
        Ok(runtimes.into_values().collect())
    }

    async fn active_generation(&self, plugin_id: &str) -> Result<Option<u64>, PluginError> {
        Ok(self
            .published_generations
            .read()
            .map_err(lock_error)?
            .get(plugin_id)
            .copied())
    }

    async fn active_contributions(
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

    async fn create_candidate(&self, plugin_id: &str) -> Result<u64, PluginError> {
        let package = self
            .plugins
            .read()
            .map_err(lock_error)?
            .get(plugin_id)
            .map(|plugin| plugin.package.clone())
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        self.prepare_package_candidate(&package).await
    }

    async fn prepare_package_candidate(&self, package: &PluginPackage) -> Result<u64, PluginError> {
        let generation = self.next_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.candidate_packages
            .write()
            .map_err(lock_error)?
            .insert(generation, package.clone());
        Ok(generation)
    }

    async fn publish_candidate(
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
        let previous_locks = self.runtime_locks.read().map_err(lock_error)?.clone();
        let mut locks = self.runtime_locks.write().map_err(lock_error)?;
        for runtime in &package.runtimes {
            if let Some((_, artifact)) = previous_locks
                .iter()
                .find(|((owner, _, runtime_id), _)| owner == plugin_id && runtime_id == &runtime.id)
            {
                locks.insert(
                    (
                        plugin_id.to_owned(),
                        package_digest.clone(),
                        runtime.id.clone(),
                    ),
                    artifact.clone(),
                );
            }
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

    async fn fail_candidate(&self, generation: u64, _evidence: &str) -> Result<(), PluginError> {
        self.candidate_packages
            .write()
            .map_err(lock_error)?
            .remove(&generation);
        Ok(())
    }

    async fn retire_generation(&self, _generation: u64) -> Result<(), PluginError> {
        Ok(())
    }

    async fn retire_draining_generations(&self, _plugin_id: &str) -> Result<(), PluginError> {
        Ok(())
    }

    async fn retire_published_generation(&self, plugin_id: &str) -> Result<(), PluginError> {
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

    async fn replace_declared_grants(
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

    async fn capability_grants(
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

    async fn record_audit(
        &self,
        plugin_id: &str,
        event: &str,
        evidence: &serde_json::Value,
    ) -> Result<(), PluginError> {
        self.audit.write().map_err(lock_error)?.push((
            plugin_id.to_owned(),
            PluginAuditEvent {
                event: event.to_owned(),
                evidence: evidence.clone(),
            },
        ));
        Ok(())
    }

    async fn list_audit(&self, plugin_id: &str) -> Result<Vec<PluginAuditEvent>, PluginError> {
        Ok(self
            .audit
            .read()
            .map_err(lock_error)?
            .iter()
            .filter(|(id, _)| id == plugin_id)
            .map(|(_, event)| event.clone())
            .collect())
    }

    async fn delete_unreferenced_runtime_artifacts(
        &self,
    ) -> Result<Vec<RuntimeInstallation>, PluginError> {
        let mut runtimes = self.runtimes.write().map_err(lock_error)?;
        let locks = self.runtime_locks.read().map_err(lock_error)?;
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

    async fn kv_get(
        &self,
        plugin_id: &str,
        key: &str,
    ) -> Result<Option<serde_json::Value>, PluginError> {
        Ok(self
            .kv_store
            .read()
            .map_err(lock_error)?
            .get(&(plugin_id.to_owned(), key.to_owned()))
            .cloned())
    }

    async fn kv_put(
        &self,
        plugin_id: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), PluginError> {
        self.kv_store
            .write()
            .map_err(lock_error)?
            .insert((plugin_id.to_owned(), key.to_owned()), value.clone());
        Ok(())
    }

    async fn kv_delete(&self, plugin_id: &str, key: &str) -> Result<(), PluginError> {
        self.kv_store
            .write()
            .map_err(lock_error)?
            .remove(&(plugin_id.to_owned(), key.to_owned()));
        Ok(())
    }

    async fn kv_list_keys(
        &self,
        plugin_id: &str,
        prefix: Option<&str>,
    ) -> Result<Vec<String>, PluginError> {
        let prefix = prefix.unwrap_or("");
        Ok(self
            .kv_store
            .read()
            .map_err(lock_error)?
            .keys()
            .filter(|(owner, key)| owner == plugin_id && key.starts_with(prefix))
            .map(|(_, key)| key.clone())
            .collect())
    }

    async fn kv_clear(&self, plugin_id: &str) -> Result<u64, PluginError> {
        let mut store = self.kv_store.write().map_err(lock_error)?;
        let before = store.len();
        store.retain(|(owner, _), _| owner != plugin_id);
        Ok((before.saturating_sub(store.len())) as u64)
    }

    async fn secret_get(
        &self,
        plugin_id: &str,
        secret_key: &str,
    ) -> Result<Option<String>, PluginError> {
        let stored = self
            .secrets_store
            .read()
            .map_err(lock_error)?
            .get(&(plugin_id.to_owned(), secret_key.to_owned()))
            .cloned();
        stored
            .map(|ciphertext| decrypt_plugin_secret(plugin_id, secret_key, &ciphertext))
            .transpose()
    }

    async fn secret_put(
        &self,
        plugin_id: &str,
        secret_key: &str,
        value: &str,
    ) -> Result<(), PluginError> {
        let ciphertext = encrypt_plugin_secret(plugin_id, secret_key, value)?;
        self.secrets_store
            .write()
            .map_err(lock_error)?
            .insert((plugin_id.to_owned(), secret_key.to_owned()), ciphertext);
        Ok(())
    }

    async fn secret_delete(&self, plugin_id: &str, secret_key: &str) -> Result<bool, PluginError> {
        Ok(self
            .secrets_store
            .write()
            .map_err(lock_error)?
            .remove(&(plugin_id.to_owned(), secret_key.to_owned()))
            .is_some())
    }

    async fn publish_event(
        &self,
        topic: &str,
        event_type: &str,
        payload: &serde_json::Value,
    ) -> Result<u64, PluginError> {
        let cursor = self.next_event_cursor.fetch_add(1, Ordering::SeqCst) + 1;
        let event = PluginBusEvent {
            cursor,
            topic: topic.to_owned(),
            event_type: event_type.to_owned(),
            payload: payload.clone(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .to_string(),
        };
        self.events_log.write().map_err(lock_error)?.push(event);
        Ok(cursor)
    }

    async fn events_subscribe(
        &self,
        plugin_id: &str,
        topic: Option<&str>,
        event_type: Option<&str>,
        since_cursor: Option<u64>,
        limit: usize,
    ) -> Result<PluginEventSubscriptionBatch, PluginError> {
        let subscription_key = event_subscription_key(topic, event_type);
        let acked_cursor = self
            .event_offsets
            .read()
            .map_err(lock_error)?
            .get(&(plugin_id.to_owned(), subscription_key))
            .copied()
            .unwrap_or(0);
        let floor_cursor = since_cursor.unwrap_or(acked_cursor);
        let max_items = limit.clamp(1, 500);
        let events_log = self.events_log.read().map_err(lock_error)?;
        let latest_cursor = events_log.last().map(|event| event.cursor).unwrap_or(0);
        let events: Vec<PluginBusEvent> = events_log
            .iter()
            .filter(|event| {
                event.cursor > floor_cursor
                    && topic
                        .filter(|value| !value.is_empty())
                        .is_none_or(|wanted| event.topic == wanted)
                    && event_type
                        .filter(|value| !value.is_empty())
                        .is_none_or(|wanted| event.event_type == wanted)
            })
            .take(max_items)
            .cloned()
            .collect();
        let cursor = events
            .last()
            .map(|event| event.cursor)
            .unwrap_or_else(|| floor_cursor.max(latest_cursor));
        Ok(PluginEventSubscriptionBatch {
            cursor,
            acked_cursor,
            events,
        })
    }

    async fn events_ack(
        &self,
        plugin_id: &str,
        subscription_key: &str,
        cursor: u64,
    ) -> Result<u64, PluginError> {
        let key = if subscription_key.trim().is_empty() {
            "*:*".to_owned()
        } else {
            subscription_key.trim().to_owned()
        };
        let mut offsets = self.event_offsets.write().map_err(lock_error)?;
        let entry = offsets.entry((plugin_id.to_owned(), key)).or_insert(0);
        if cursor > *entry {
            *entry = cursor;
        }
        Ok(*entry)
    }

    async fn quarantine_plugin(&self, plugin_id: &str, reason: &str) -> Result<(), PluginError> {
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

    async fn quarantine_reason(&self, plugin_id: &str) -> Result<Option<String>, PluginError> {
        Ok(self
            .quarantined
            .read()
            .map_err(lock_error)?
            .get(plugin_id)
            .cloned())
    }
}

pub struct SqlitePluginRegistry {
    pool: SqlitePool,
    kv_table_ready: tokio::sync::OnceCell<()>,
    kv_table_initialized: std::sync::atomic::AtomicBool,
}

impl SqlitePluginRegistry {
    pub fn new(pool: SqlitePool) -> Self {
        Self {
            pool,
            kv_table_ready: tokio::sync::OnceCell::new(),
            kv_table_initialized: std::sync::atomic::AtomicBool::new(false),
        }
    }

    async fn ensure_kv_table(&self) -> Result<(), PluginError> {
        if self
            .kv_table_initialized
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(());
        }
        self.kv_table_ready
            .get_or_try_init(|| async {
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS plugin_kv_storage (
                        plugin_id  TEXT NOT NULL,
                        key        TEXT NOT NULL,
                        value_json TEXT NOT NULL,
                        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                        PRIMARY KEY (plugin_id, key)
                    )",
                )
                .execute(&self.pool)
                .await
                .map_err(registry_error)?;
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS plugin_secrets_storage (
                        plugin_id      TEXT NOT NULL,
                        secret_key     TEXT NOT NULL,
                        ciphertext_b64 TEXT NOT NULL,
                        updated_at     TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                        PRIMARY KEY (plugin_id, secret_key)
                    )",
                )
                .execute(&self.pool)
                .await
                .map_err(registry_error)?;
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS plugin_events_log (
                        cursor       INTEGER PRIMARY KEY AUTOINCREMENT,
                        topic        TEXT NOT NULL,
                        event_type   TEXT NOT NULL,
                        payload_json TEXT NOT NULL,
                        created_at   TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
                    )",
                )
                .execute(&self.pool)
                .await
                .map_err(registry_error)?;
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS plugin_event_subscriptions (
                        plugin_id        TEXT NOT NULL,
                        subscription_key TEXT NOT NULL,
                        acked_cursor     INTEGER NOT NULL DEFAULT 0,
                        updated_at       TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
                        PRIMARY KEY (plugin_id, subscription_key)
                    )",
                )
                .execute(&self.pool)
                .await
                .map_err(registry_error)?;
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS plugin_installations_v4 (
                        plugin_id              TEXT PRIMARY KEY,
                        publisher              TEXT NOT NULL,
                        current_package_digest TEXT NOT NULL,
                        rollback_package_digest TEXT,
                        data_retention         TEXT NOT NULL DEFAULT 'retain'
                            CHECK (data_retention IN ('retain','delete_on_uninstall')),
                        installed_at           TEXT NOT NULL,
                        updated_at             TEXT NOT NULL
                    )",
                )
                .execute(&self.pool)
                .await
                .map_err(registry_error)?;
                sqlx::query(
                    "CREATE TABLE IF NOT EXISTS plugin_audit_v4 (
                        sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
                        plugin_id     TEXT,
                        publisher     TEXT,
                        operation_id  TEXT,
                        event         TEXT NOT NULL,
                        evidence_json TEXT NOT NULL,
                        created_at    TEXT NOT NULL
                    )",
                )
                .execute(&self.pool)
                .await
                .map_err(registry_error)?;
                let _ = sqlx::query(
                    "ALTER TABLE plugin_activation_intents_v4
                     ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1))",
                )
                .execute(&self.pool)
                .await;
                let _ = sqlx::query(
                    "ALTER TABLE plugin_activation_intents_v4
                     ADD COLUMN quarantine_reason TEXT",
                )
                .execute(&self.pool)
                .await;
                self.kv_table_initialized
                    .store(true, std::sync::atomic::Ordering::Release);
                Ok(())
            })
            .await
            .copied()
    }
}

#[async_trait]
impl PluginRegistry for SqlitePluginRegistry {
    async fn plugin(&self, plugin_id: &str) -> Result<Option<InstalledPlugin>, PluginError> {
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

    async fn list_plugins(&self) -> Result<Vec<InstalledPlugin>, PluginError> {
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
        rows.into_iter().map(decode_plugin_row).collect()
    }

    async fn rollback_package(
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

    async fn put_plugin(&self, plugin: InstalledPlugin) -> Result<(), PluginError> {
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

    async fn set_activation(
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

    async fn delete_plugin(&self, plugin_id: &str) -> Result<(), PluginError> {
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

    async fn put_runtime(
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

    async fn runtime_for_plugin(
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

    async fn runtime_for_package(
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

    async fn runtime_for_generation(
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

    async fn list_runtimes(&self) -> Result<Vec<RuntimeInstallation>, PluginError> {
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

    async fn active_generation(&self, plugin_id: &str) -> Result<Option<u64>, PluginError> {
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

    async fn active_contributions(
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
        declarations
            .into_iter()
            .map(|value| serde_json::from_str(&value).map_err(registry_error))
            .collect()
    }

    async fn create_candidate(&self, plugin_id: &str) -> Result<u64, PluginError> {
        let package = self
            .plugin(plugin_id)
            .await?
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        self.prepare_package_candidate(&package.package).await
    }

    async fn prepare_package_candidate(&self, package: &PluginPackage) -> Result<u64, PluginError> {
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

    async fn publish_candidate(
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

    async fn fail_candidate(&self, generation: u64, evidence: &str) -> Result<(), PluginError> {
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

    async fn retire_generation(&self, generation: u64) -> Result<(), PluginError> {
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

    async fn retire_draining_generations(&self, plugin_id: &str) -> Result<(), PluginError> {
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

    async fn retire_published_generation(&self, plugin_id: &str) -> Result<(), PluginError> {
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

    async fn replace_declared_grants(
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

    async fn capability_grants(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<crate::CapabilityGrant>, PluginError> {
        let _ = plugin_id;
        Ok(Vec::new())
    }

    async fn record_audit(
        &self,
        plugin_id: &str,
        event: &str,
        evidence: &serde_json::Value,
    ) -> Result<(), PluginError> {
        self.ensure_kv_table().await?;
        let evidence_json = serde_json::to_string(evidence).map_err(registry_error)?;
        // A bind refusal is evidence even when the install row is gone or
        // never existed — joining on installations would silently drop it.
        sqlx::query(
            "INSERT INTO plugin_audit_v4
                 (plugin_id, publisher, operation_id, event, evidence_json, created_at)
             VALUES (
                 ?,
                 COALESCE((SELECT publisher FROM plugin_installations_v4 WHERE plugin_id = ?), ''),
                 NULL,
                 ?,
                 ?,
                 datetime('now','subsec')
             )",
        )
        .bind(plugin_id)
        .bind(plugin_id)
        .bind(event)
        .bind(evidence_json)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(())
    }

    async fn list_audit(&self, plugin_id: &str) -> Result<Vec<PluginAuditEvent>, PluginError> {
        self.ensure_kv_table().await?;
        let rows = sqlx::query(
            "SELECT event, evidence_json FROM plugin_audit_v4
             WHERE plugin_id = ? ORDER BY sequence",
        )
        .bind(plugin_id)
        .fetch_all(&self.pool)
        .await
        .map_err(registry_error)?;
        rows.into_iter()
            .map(|row| {
                let event: String = row.try_get("event").map_err(registry_error)?;
                let evidence_json: String = row.try_get("evidence_json").map_err(registry_error)?;
                let evidence = serde_json::from_str(&evidence_json).map_err(registry_error)?;
                Ok(PluginAuditEvent { event, evidence })
            })
            .collect()
    }

    async fn delete_unreferenced_runtime_artifacts(
        &self,
    ) -> Result<Vec<RuntimeInstallation>, PluginError> {
        let inventory = self.list_runtimes().await?;
        let orphans: Vec<RuntimeInstallation> = inventory
            .into_iter()
            .filter(|runtime| runtime.referenced_plugins.is_empty())
            .collect();
        let mut transaction = self.pool.begin().await.map_err(registry_error)?;
        gc_runtime_locks(&mut transaction).await?;
        transaction.commit().await.map_err(registry_error)?;
        Ok(orphans)
    }

    async fn kv_get(
        &self,
        plugin_id: &str,
        key: &str,
    ) -> Result<Option<serde_json::Value>, PluginError> {
        self.ensure_kv_table().await?;
        let raw: Option<String> = sqlx::query_scalar(
            "SELECT value_json FROM plugin_kv_storage WHERE plugin_id = ? AND key = ?",
        )
        .bind(plugin_id)
        .bind(key)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?;
        raw.map(|json_str| serde_json::from_str(&json_str).map_err(registry_error))
            .transpose()
    }

    async fn kv_put(
        &self,
        plugin_id: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), PluginError> {
        self.ensure_kv_table().await?;
        let json_str = serde_json::to_string(value).map_err(registry_error)?;
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
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(())
    }

    async fn kv_delete(&self, plugin_id: &str, key: &str) -> Result<(), PluginError> {
        self.ensure_kv_table().await?;
        sqlx::query("DELETE FROM plugin_kv_storage WHERE plugin_id = ? AND key = ?")
            .bind(plugin_id)
            .bind(key)
            .execute(&self.pool)
            .await
            .map_err(registry_error)?;
        Ok(())
    }

    async fn kv_list_keys(
        &self,
        plugin_id: &str,
        prefix: Option<&str>,
    ) -> Result<Vec<String>, PluginError> {
        self.ensure_kv_table().await?;
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
                .fetch_all(&self.pool)
                .await
                .map_err(registry_error)
            }
            None => sqlx::query_scalar(
                "SELECT key FROM plugin_kv_storage WHERE plugin_id = ? ORDER BY key ASC",
            )
            .bind(plugin_id)
            .fetch_all(&self.pool)
            .await
            .map_err(registry_error),
        }
    }

    async fn kv_clear(&self, plugin_id: &str) -> Result<u64, PluginError> {
        self.ensure_kv_table().await?;
        let result = sqlx::query("DELETE FROM plugin_kv_storage WHERE plugin_id = ?")
            .bind(plugin_id)
            .execute(&self.pool)
            .await
            .map_err(registry_error)?;
        Ok(result.rows_affected())
    }

    async fn secret_get(
        &self,
        plugin_id: &str,
        secret_key: &str,
    ) -> Result<Option<String>, PluginError> {
        self.ensure_kv_table().await?;
        let ciphertext: Option<String> = sqlx::query_scalar(
            "SELECT ciphertext_b64 FROM plugin_secrets_storage
             WHERE plugin_id = ? AND secret_key = ?",
        )
        .bind(plugin_id)
        .bind(secret_key)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?;
        ciphertext
            .map(|value| decrypt_plugin_secret(plugin_id, secret_key, &value))
            .transpose()
    }

    async fn secret_put(
        &self,
        plugin_id: &str,
        secret_key: &str,
        value: &str,
    ) -> Result<(), PluginError> {
        self.ensure_kv_table().await?;
        let ciphertext = encrypt_plugin_secret(plugin_id, secret_key, value)?;
        sqlx::query(
            "INSERT INTO plugin_secrets_storage (plugin_id, secret_key, ciphertext_b64, updated_at)
             VALUES (?, ?, ?, datetime('now', 'subsec'))
             ON CONFLICT(plugin_id, secret_key) DO UPDATE SET
               ciphertext_b64 = excluded.ciphertext_b64,
               updated_at = excluded.updated_at",
        )
        .bind(plugin_id)
        .bind(secret_key)
        .bind(ciphertext)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(())
    }

    async fn secret_delete(&self, plugin_id: &str, secret_key: &str) -> Result<bool, PluginError> {
        self.ensure_kv_table().await?;
        let result = sqlx::query(
            "DELETE FROM plugin_secrets_storage WHERE plugin_id = ? AND secret_key = ?",
        )
        .bind(plugin_id)
        .bind(secret_key)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(result.rows_affected() > 0)
    }

    async fn publish_event(
        &self,
        topic: &str,
        event_type: &str,
        payload: &serde_json::Value,
    ) -> Result<u64, PluginError> {
        self.ensure_kv_table().await?;
        let payload_json = serde_json::to_string(payload).map_err(registry_error)?;
        let result = sqlx::query(
            "INSERT INTO plugin_events_log (topic, event_type, payload_json, created_at)
             VALUES (?, ?, ?, datetime('now', 'subsec'))",
        )
        .bind(topic)
        .bind(event_type)
        .bind(payload_json)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        u64::try_from(result.last_insert_rowid()).map_err(registry_error)
    }

    async fn events_subscribe(
        &self,
        plugin_id: &str,
        topic: Option<&str>,
        event_type: Option<&str>,
        since_cursor: Option<u64>,
        limit: usize,
    ) -> Result<PluginEventSubscriptionBatch, PluginError> {
        self.ensure_kv_table().await?;
        let subscription_key = event_subscription_key(topic, event_type);
        let acked_cursor = sqlx::query_scalar::<_, i64>(
            "SELECT acked_cursor FROM plugin_event_subscriptions
             WHERE plugin_id = ? AND subscription_key = ?",
        )
        .bind(plugin_id)
        .bind(&subscription_key)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or(0);
        let floor_cursor = since_cursor.unwrap_or(acked_cursor);
        let max_items = i64::try_from(limit.clamp(1, 500)).unwrap_or(100);
        let latest_cursor =
            sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(cursor) FROM plugin_events_log")
                .fetch_one(&self.pool)
                .await
                .map_err(registry_error)?
                .and_then(|value| u64::try_from(value).ok())
                .unwrap_or(0);
        let topic_filter = topic.filter(|value| !value.is_empty());
        let type_filter = event_type.filter(|value| !value.is_empty());
        let rows = sqlx::query(
            "SELECT cursor, topic, event_type, payload_json, created_at
             FROM plugin_events_log
             WHERE cursor > ?
               AND (? IS NULL OR topic = ?)
               AND (? IS NULL OR event_type = ?)
             ORDER BY cursor ASC
             LIMIT ?",
        )
        .bind(i64::try_from(floor_cursor).unwrap_or(i64::MAX))
        .bind(topic_filter)
        .bind(topic_filter)
        .bind(type_filter)
        .bind(type_filter)
        .bind(max_items)
        .fetch_all(&self.pool)
        .await
        .map_err(registry_error)?;
        let mut events = Vec::with_capacity(rows.len());
        for row in rows {
            let cursor_i64: i64 = row.try_get("cursor").map_err(registry_error)?;
            let cursor = u64::try_from(cursor_i64).map_err(registry_error)?;
            let topic: String = row.try_get("topic").map_err(registry_error)?;
            let event_type: String = row.try_get("event_type").map_err(registry_error)?;
            let payload_json: String = row.try_get("payload_json").map_err(registry_error)?;
            let payload = serde_json::from_str(&payload_json).map_err(registry_error)?;
            let created_at: String = row.try_get("created_at").map_err(registry_error)?;
            events.push(PluginBusEvent {
                cursor,
                topic,
                event_type,
                payload,
                created_at,
            });
        }
        let cursor = events
            .last()
            .map(|event| event.cursor)
            .unwrap_or_else(|| floor_cursor.max(latest_cursor));
        Ok(PluginEventSubscriptionBatch {
            cursor,
            acked_cursor,
            events,
        })
    }

    async fn events_ack(
        &self,
        plugin_id: &str,
        subscription_key: &str,
        cursor: u64,
    ) -> Result<u64, PluginError> {
        self.ensure_kv_table().await?;
        let key = if subscription_key.trim().is_empty() {
            "*:*".to_owned()
        } else {
            subscription_key.trim().to_owned()
        };
        let cursor_i64 = i64::try_from(cursor).map_err(registry_error)?;
        sqlx::query(
            "INSERT INTO plugin_event_subscriptions
                 (plugin_id, subscription_key, acked_cursor, updated_at)
             VALUES (?, ?, ?, datetime('now', 'subsec'))
             ON CONFLICT(plugin_id, subscription_key) DO UPDATE SET
                 acked_cursor = CASE
                     WHEN excluded.acked_cursor > plugin_event_subscriptions.acked_cursor
                     THEN excluded.acked_cursor
                     ELSE plugin_event_subscriptions.acked_cursor
                 END,
                 updated_at = excluded.updated_at",
        )
        .bind(plugin_id)
        .bind(&key)
        .bind(cursor_i64)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        let saved = sqlx::query_scalar::<_, i64>(
            "SELECT acked_cursor FROM plugin_event_subscriptions
             WHERE plugin_id = ? AND subscription_key = ?",
        )
        .bind(plugin_id)
        .bind(&key)
        .fetch_one(&self.pool)
        .await
        .map_err(registry_error)?;
        u64::try_from(saved).map_err(registry_error)
    }

    async fn quarantine_plugin(&self, plugin_id: &str, reason: &str) -> Result<(), PluginError> {
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

    async fn quarantine_reason(&self, plugin_id: &str) -> Result<Option<String>, PluginError> {
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

#[derive(Clone)]
struct WorkerRestore {
    node_executable: PathBuf,
    candidate_root: PathBuf,
    broker: Arc<dyn CapabilityBroker>,
}

pub struct PluginControlPlane {
    registry: Arc<dyn PluginRegistry>,
    contributions: ContributionRegistry,
    activations: ActivationManager,
    official_mcp: Arc<crate::OfficialMcpRuntime>,
    host_services: crate::host_service::HostServiceSupervisor,
    worker_restore: tokio::sync::RwLock<Option<WorkerRestore>>,
    lazy_activation_lock: tokio::sync::Mutex<()>,
    catalog_changes: tokio::sync::broadcast::Sender<u64>,
    command_handlers: RwLock<BTreeMap<(String, String), Arc<dyn PluginCommandHandler>>>,
}

impl PluginControlPlane {
    pub fn new(registry: Arc<dyn PluginRegistry>) -> Self {
        Self {
            registry,
            contributions: ContributionRegistry::default(),
            activations: ActivationManager::default(),
            official_mcp: Arc::new(crate::OfficialMcpRuntime::default()),
            host_services: crate::host_service::HostServiceSupervisor::default(),
            worker_restore: tokio::sync::RwLock::new(None),
            lazy_activation_lock: tokio::sync::Mutex::new(()),
            catalog_changes: tokio::sync::broadcast::channel(16).0,
            command_handlers: RwLock::new(BTreeMap::new()),
        }
    }

    /// Fires with the new catalog generation whenever the live contribution set
    /// changes. UI contributions must appear and disappear with activation
    /// (ADR-0069 principle 4), including when the CLI drives the change.
    pub fn subscribe_catalog_changes(&self) -> tokio::sync::broadcast::Receiver<u64> {
        self.catalog_changes.subscribe()
    }

    pub fn official_product_mcp_gate(&self) -> Arc<crate::OfficialMcpRuntime> {
        self.official_mcp.clone()
    }

    pub async fn install_bundled_official_plugins(
        &self,
        data_root: &Path,
        _activation: Option<BundledPluginActivation>,
    ) -> Result<Vec<PathBuf>, PluginError> {
        let roots = utils::assets::existing_official_plugin_roots(data_root);
        self.migrate_builtin_memberships(&roots).await?;
        Ok(roots)
    }

    /// Bootstraps all monorepo official and built-in capability plugins from
    /// `plugins/*` offline (zero network calls), respecting topological
    /// `dependencies.kind=plugin` ordering when `enable_by_default` is true.
    pub async fn bootstrap_monorepo_plugins(
        &self,
        enable_by_default: bool,
    ) -> Result<Vec<InstalledPlugin>, PluginError> {
        let roots = crate::official_catalog::discover_monorepo_plugin_roots();
        let mut imported_ids = BTreeSet::new();
        for root in &roots {
            let package = crate::PluginPackage::inspect(root, crate::PluginSourceKind::Snapshot)?;
            let id = package.id.as_str().to_owned();
            self.import(package, ConflictDecision::KeepInstalled)
                .await?;
            imported_ids.insert(id);
        }
        if enable_by_default {
            let order = self.topological_activation_order().await?;
            for plugin_id in order {
                if !imported_ids.contains(&plugin_id) {
                    continue;
                }
                if let Some(plugin) = self.plugin(&plugin_id).await?
                    && plugin.activation != PluginActivation::Enabled
                {
                    if plugin.entrypoints.worker.is_none() {
                        self.set_enabled(&plugin_id, true).await?;
                    } else if plugin.runtimes.is_empty() {
                        self.enable_deferred_worker(&plugin_id).await?;
                    }
                }
            }
        }
        self.catalog().await
    }

    async fn enable_deferred_worker(&self, plugin_id: &str) -> Result<(), PluginError> {
        let plugin = self
            .registry
            .plugin(plugin_id)
            .await?
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        self.require_plugin_dependencies(&plugin.package).await?;
        let generation = self.registry.create_candidate(plugin_id).await?;
        let grants = candidate_capability_grants(&plugin.package, &[], &[])?;
        let contributions = descriptors_for_package(&plugin.package, generation);
        if let Err(error) = self
            .registry
            .publish_candidate(
                plugin_id,
                generation,
                &plugin.package,
                &contributions,
                &grants,
            )
            .await
        {
            let _ = self
                .registry
                .fail_candidate(generation, error.message())
                .await;
            return Err(error);
        }
        self.refresh_live_projections().await
    }

    /// Replaces already-installed official packages when the Host embed changed.
    /// Does not register plugins the user has not installed.
    pub async fn refresh_installed_bundled_plugins(
        &self,
        roots: &[PathBuf],
        activation: Option<&BundledPluginActivation>,
    ) -> Result<(), PluginError> {
        for builtin_root in roots {
            let mut builtin =
                crate::PluginPackage::inspect(builtin_root, crate::PluginSourceKind::Builtin)?;
            let Some(installed) = self.plugin(builtin.id.as_str()).await? else {
                continue;
            };
            if installed.source.kind == crate::PluginSourceKind::DeveloperLink {
                continue;
            }
            let incoming_digest = crate::package_content_digest(builtin_root)?;
            if installed.package_digest == incoming_digest {
                continue;
            }
            if installed.config_schema.is_some() {
                builtin.write_adopted_config(installed.config.clone())?;
                builtin =
                    crate::PluginPackage::inspect(builtin_root, crate::PluginSourceKind::Builtin)?;
            }
            builtin.source.kind = installed.source.kind;
            builtin.source.origin = installed.source.origin.clone();
            builtin.source.git_ref = installed.source.git_ref.clone();
            builtin.source.git_sha = installed.source.git_sha.clone();
            builtin.source.locked = installed.source.locked;
            builtin.source.show_tree = installed.source.show_tree;
            if installed.activation == PluginActivation::Enabled {
                let Some(activation) = activation else {
                    tracing::warn!(
                        plugin_id = %builtin.id.as_str(),
                        "official plugin package changed; Worker will update once the Runtime is ready"
                    );
                    continue;
                };
                let grants = crate::candidate_capability_grants(&builtin, &[], &[])?;
                self.update_and_activate(
                    &activation.node_executable,
                    builtin,
                    &grants,
                    activation.broker.clone(),
                )
                .await
                .map_err(|error| PluginError::registry(format!("{}: {error}", error.code())))?;
            } else {
                self.import(builtin, ConflictDecision::Replace).await?;
            }
        }
        Ok(())
    }

    pub async fn migrate_builtin_memberships(&self, roots: &[PathBuf]) -> Result<(), PluginError> {
        let catalog = self.catalog().await?;
        for plugin in catalog {
            if plugin.source.kind != crate::PluginSourceKind::Builtin {
                continue;
            }
            let mut package = plugin.package.clone();
            package.source.kind = crate::PluginSourceKind::Marketplace;
            package.source.origin = Some(crate::marketplace_listing_url(
                package.publisher.as_deref().unwrap_or("vibex"),
                package.id.as_str(),
            ));
            package.source.git_ref = Some(package.version.clone());
            package.source.locked = true;
            if let Some(root) = roots.iter().find(|root| {
                root.join(".vibex-plugin/plugin.json").is_file()
                    && crate::PluginPackage::inspect(root, crate::PluginSourceKind::Marketplace)
                        .ok()
                        .is_some_and(|candidate| candidate.id.as_str() == package.id.as_str())
            }) {
                package.source.path = root.clone();
            }
            let migrated = InstalledPlugin {
                package,
                activation: plugin.activation,
                package_digest: plugin.package_digest,
            };
            self.registry.put_plugin(migrated).await?;
        }
        Ok(())
    }

    pub async fn reconcile_bundled_plugins(
        &self,
        roots: &[PathBuf],
        activation: Option<&BundledPluginActivation>,
    ) -> Result<(), PluginError> {
        let mut successes = 0usize;
        let mut first_failure = None;
        for builtin_root in roots {
            match self
                .reconcile_one_bundled_plugin(builtin_root, activation)
                .await
            {
                Ok(()) => successes += 1,
                Err(error) => {
                    tracing::error!(
                        root = %builtin_root.display(),
                        error = %error,
                        "official plugin could not be registered in the Host catalog"
                    );
                    if first_failure.is_none() {
                        first_failure = Some(error);
                    }
                }
            }
        }
        self.retire_replaced_builtins().await?;
        if successes == 0
            && let Some(error) = first_failure
        {
            return Err(error);
        }
        Ok(())
    }

    async fn reconcile_one_bundled_plugin(
        &self,
        builtin_root: &Path,
        activation: Option<&BundledPluginActivation>,
    ) -> Result<(), PluginError> {
        let mut builtin =
            crate::PluginPackage::inspect(builtin_root, crate::PluginSourceKind::Builtin)?;
        let installed = self.plugin(builtin.id.as_str()).await?;
        match installed {
            None => {
                self.import(builtin, ConflictDecision::Reject).await?;
            }
            Some(installed)
                if installed.package_digest != crate::package_content_digest(builtin_root)? =>
            {
                if installed.config_schema.is_some() {
                    builtin.write_adopted_config(installed.config.clone())?;
                    builtin = crate::PluginPackage::inspect(
                        builtin_root,
                        crate::PluginSourceKind::Builtin,
                    )?;
                }
                if installed.activation == crate::PluginActivation::Enabled {
                    let Some(activation) = activation else {
                        return Ok(());
                    };
                    let grants = crate::candidate_capability_grants(&builtin, &[], &[])?;
                    self.update_and_activate(
                        &activation.node_executable,
                        builtin,
                        &grants,
                        activation.broker.clone(),
                    )
                    .await
                    .map_err(|error| PluginError::registry(format!("{}: {error}", error.code())))?;
                } else {
                    self.import(builtin, ConflictDecision::Replace).await?;
                }
            }
            Some(_) => {}
        }
        Ok(())
    }

    pub async fn sync_official_product_mcp_gate(&self) -> Result<(), PluginError> {
        self.refresh_live_projections().await
    }

    async fn plugin_is_live(&self, plugin_id: &str) -> Result<bool, PluginError> {
        Ok(self.registry.active_generation(plugin_id).await?.is_some())
    }

    async fn refresh_live_projections(&self) -> Result<(), PluginError> {
        let plugins = self.registry.list_plugins().await?;
        let mut live = Vec::new();
        for plugin in plugins {
            if plugin.activation == PluginActivation::Enabled
                && self.plugin_is_live(plugin.id()).await?
            {
                live.push(plugin);
            }
        }
        self.official_mcp.sync_from_plugins(&live);
        let catalog = self
            .contributions
            .publish(self.registry.active_contributions().await?)?;
        let _ = self.catalog_changes.send(catalog.generation);
        Ok(())
    }

    pub fn watch_worker_crashes(self: &std::sync::Arc<Self>) {
        let plane = std::sync::Arc::clone(self);
        tokio::spawn(async move {
            let mut crashes = crate::subscribe_worker_crashes();
            loop {
                match crashes.recv().await {
                    Ok(plugin_id) => {
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        let recent_crashes = crate::recent_plugin_crashes(&plugin_id)
                            .into_iter()
                            .filter(|crash| now_ms.saturating_sub(crash.at_unix_ms) <= 60_000)
                            .count();
                        if recent_crashes >= 3 {
                            if let Err(error) = plane
                                .quarantine_plugin(
                                    &plugin_id,
                                    "Quarantined after repeated worker crashes",
                                )
                                .await
                            {
                                tracing::warn!(
                                    plugin_id = %plugin_id,
                                    %error,
                                    "failed to quarantine plugin after repeated Worker crashes"
                                );
                            }
                        } else {
                            plane.host_services.stop(&plugin_id);
                            let _ = plane.activations.deactivate(&plugin_id).await;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    /// Reverse of publishing a generation: stop host.service, dispose Worker,
    /// then drop contribution descriptors. Enable intent is unchanged.
    pub async fn withdraw_live_generation(&self, plugin_id: &str) -> Result<(), PluginError> {
        if !self.plugin_is_live(plugin_id).await? {
            self.host_services.stop(plugin_id);
            let _ = self.activations.deactivate(plugin_id).await;
            return Ok(());
        }
        self.host_services.stop(plugin_id);
        self.activations
            .deactivate(plugin_id)
            .await
            .map_err(|error| PluginError::registry(error.to_string()))?;
        self.registry.retire_published_generation(plugin_id).await
    }

    async fn live_dependents(&self, plugin_id: &str) -> Result<Vec<String>, PluginError> {
        let mut dependents = Vec::new();
        for plugin in self.registry.list_plugins().await? {
            if plugin.activation != PluginActivation::Enabled {
                continue;
            }
            if !self.plugin_is_live(plugin.id()).await? {
                continue;
            }
            let required = plugin_dependencies(&plugin.package)
                .into_iter()
                .any(|dep| dep.required && dep.id == plugin_id);
            if required {
                dependents.push(plugin.id().to_owned());
            }
        }
        Ok(dependents)
    }

    async fn withdraw_with_dependents(&self, plugin_id: &str) -> Result<(), PluginError> {
        let mut stack = vec![plugin_id.to_owned()];
        let mut order = Vec::new();
        let mut visited = BTreeSet::new();
        while let Some(id) = stack.pop() {
            if !visited.insert(id.clone()) {
                continue;
            }
            order.push(id.clone());
            stack.extend(self.live_dependents(&id).await?);
        }
        for id in order.into_iter().rev() {
            self.withdraw_live_generation(&id).await?;
        }
        Ok(())
    }

    async fn remount_if_ready(&self, plugin_id: &str) -> Result<bool, PluginError> {
        let Some(plugin) = self.registry.plugin(plugin_id).await? else {
            return Ok(false);
        };
        if plugin.activation != PluginActivation::Enabled {
            return Ok(false);
        }
        if self.plugin_is_live(plugin_id).await? {
            return Ok(false);
        }
        if self
            .require_plugin_dependencies(&plugin.package)
            .await
            .is_err()
        {
            return Ok(false);
        }
        if plugin.entrypoints.worker.is_some() {
            let restore = self.worker_restore.read().await.clone();
            let Some(restore) = restore else {
                return Ok(false);
            };
            let grants = candidate_capability_grants(&plugin.package, &[], &[])?;
            self.publish_live_generation(
                plugin_id,
                Some((
                    restore.node_executable.as_path(),
                    grants.as_slice(),
                    restore.broker.clone(),
                )),
            )
            .await
            .map_err(|error| PluginError::registry(error.to_string()))?;
            return Ok(true);
        }
        self.publish_live_generation(plugin_id, None)
            .await
            .map_err(|error| PluginError::registry(error.to_string()))?;
        Ok(true)
    }

    async fn reconcile_enabled(&self) -> Result<(), PluginError> {
        let plugins = self.registry.list_plugins().await?;
        for _ in 0..plugins.len().saturating_add(1) {
            let mut progressed = false;
            for plugin in &plugins {
                if self.remount_if_ready(plugin.id()).await? {
                    progressed = true;
                }
            }
            if !progressed {
                break;
            }
        }
        Ok(())
    }

    async fn publish_live_generation(
        &self,
        plugin_id: &str,
        worker: Option<(
            &std::path::Path,
            &[CapabilityGrant],
            Arc<dyn CapabilityBroker>,
        )>,
    ) -> Result<(), WorkerHostError> {
        let plugin = self
            .registry
            .plugin(plugin_id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?
            .ok_or_else(|| WorkerHostError::external("plugin_not_found", plugin_id))?;
        self.ensure_plugin_dependencies(&plugin.package).await?;
        if plugin.entrypoints.worker.is_some() {
            self.ensure_runtime_readiness(plugin_id, &plugin.package)
                .await?;
        }
        let generation = self
            .registry
            .create_candidate(plugin_id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?;
        let grants = worker
            .as_ref()
            .map(|(_, grants, _)| grants.to_vec())
            .unwrap_or_default();
        let candidate = if let Some((node_executable, _, broker)) = worker {
            match self
                .activations
                .prepare_candidate_at(
                    generation,
                    node_executable,
                    &plugin.package,
                    &grants,
                    broker,
                )
                .await
            {
                Ok(candidate) => Some(candidate),
                Err(error) => {
                    let _ = self
                        .registry
                        .fail_candidate(generation, &error.to_string())
                        .await;
                    return Err(error);
                }
            }
        } else if plugin.entrypoints.worker.is_some() {
            return Err(WorkerHostError::external(
                "plugin_registry_failed",
                "Worker plugins must be enabled through candidate activation",
            ));
        } else {
            Some(self.activations.prepare_lightweight_candidate_at(
                generation,
                &plugin.package,
                &grants,
                Arc::new(crate::DenyCapabilityBroker),
            )?)
        };
        let contributions = descriptors_for_package(&plugin.package, generation);
        if let Err(error) = self
            .registry
            .publish_candidate(
                plugin_id,
                generation,
                &plugin.package,
                &contributions,
                &grants,
            )
            .await
        {
            if let Some(candidate) = candidate {
                let _ = candidate.discard("activation persistence failed").await;
            }
            let _ = self
                .registry
                .fail_candidate(generation, error.message())
                .await;
            return Err(WorkerHostError::external("plugin_registry_failed", error));
        }
        if let Some(candidate) = candidate {
            let drain = self.activations.commit(candidate).await;
            self.retire_after_drain(plugin_id.to_owned(), drain);
        }
        if let Some(lease) = self.activations.lease(plugin_id).await {
            self.host_services.start(plugin_id, lease, &plugin.package);
        }
        Ok(())
    }

    fn retire_after_drain(
        &self,
        plugin_id: String,
        drain: Option<crate::activation::GenerationDrain>,
    ) {
        let registry = self.registry.clone();
        tokio::spawn(async move {
            if let Some(drain) = drain {
                let generation = drain.generation;
                drain.wait().await;
                let _ = registry.retire_generation(generation).await;
            } else {
                // A restored Host has no old process lease to drain.
                let _ = registry.retire_draining_generations(&plugin_id).await;
            }
        });
    }

    async fn ensure_runtime_readiness(
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
    async fn runtime_unready_reason(
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

    /// The generation currently serving this plugin, if any.
    pub async fn active_generation(&self, plugin_id: &str) -> Option<u64> {
        self.registry
            .active_generation(plugin_id)
            .await
            .ok()
            .flatten()
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

    pub async fn preview_import(
        &self,
        package: &PluginPackage,
    ) -> Result<Option<ImportConflict>, PluginError> {
        Ok(self
            .registry
            .plugin(package.id.as_str())
            .await?
            .map(|installed| ImportConflict {
                plugin_id: package.id.as_str().to_owned(),
                installed_source: installed.source.path.clone(),
                incoming_source: package.source.path.clone(),
            }))
    }

    pub async fn import(
        &self,
        package: PluginPackage,
        decision: ConflictDecision,
    ) -> Result<ImportResult, PluginError> {
        let existing = self.registry.plugin(package.id.as_str()).await?;
        if let Some(ref installed) = existing {
            if package_publisher(&installed.package) != package_publisher(&package) {
                return Err(PluginError::conflict(package.id.as_str()));
            }
            match decision {
                ConflictDecision::Reject => return Err(PluginError::conflict(package.id.as_str())),
                ConflictDecision::KeepInstalled => {
                    return Ok(ImportResult {
                        disposition: ImportDisposition::KeptInstalled,
                        plugin: installed.clone(),
                    });
                }
                ConflictDecision::Replace => {}
            }
        }
        let disposition = if existing.is_some() {
            ImportDisposition::Replaced
        } else {
            ImportDisposition::Installed
        };
        let package_digest = package_digest(&package)?;
        let plugin = InstalledPlugin {
            package,
            activation: PluginActivation::Disabled,
            package_digest,
        };
        self.registry.put_plugin(plugin.clone()).await?;
        let _ = self
            .registry
            .record_audit(
                plugin.id(),
                match disposition {
                    ImportDisposition::Installed => "install",
                    ImportDisposition::Replaced => "update",
                    ImportDisposition::KeptInstalled => "install_kept",
                },
                &serde_json::json!({
                    "packageDigest": plugin.package_digest,
                    "sourceKind": source_kind_key(plugin.source.kind),
                    "origin": plugin.source.origin,
                    "gitRef": plugin.source.git_ref,
                    "gitSha": plugin.source.git_sha,
                    "locked": plugin.source.locked,
                }),
            )
            .await;
        Ok(ImportResult {
            disposition,
            plugin,
        })
    }

    pub async fn plugin(&self, plugin_id: &str) -> Result<Option<InstalledPlugin>, PluginError> {
        self.registry.plugin(plugin_id).await
    }

    pub async fn catalog(&self) -> Result<Vec<InstalledPlugin>, PluginError> {
        self.registry.list_plugins().await
    }

    pub async fn import_queued_developer_links(&self) -> Result<Vec<String>, PluginError> {
        let Some(home) = dirs::home_dir() else {
            return Ok(Vec::new());
        };
        let file = home.join(".vibex").join("imports").join("links.jsonl");
        let Ok(text) = std::fs::read_to_string(&file) else {
            return Ok(Vec::new());
        };
        let mut remaining = Vec::new();
        let mut imported = Vec::new();
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                remaining.push(trimmed.to_owned());
                continue;
            };
            let Some(path) = entry.get("path").and_then(serde_json::Value::as_str) else {
                remaining.push(trimmed.to_owned());
                continue;
            };
            match crate::PluginPackage::inspect(
                Path::new(path),
                crate::PluginSourceKind::DeveloperLink,
            ) {
                Ok(package) => match self.import(package, ConflictDecision::Replace).await {
                    Ok(result) => imported.push(result.plugin.id().to_owned()),
                    Err(error) => {
                        tracing::warn!(path, error = %error, "queued linked Plugin import failed");
                        remaining.push(trimmed.to_owned());
                    }
                },
                Err(error) => {
                    tracing::warn!(path, error = %error, "queued linked Plugin is invalid");
                    remaining.push(trimmed.to_owned());
                }
            }
        }
        let body = if remaining.is_empty() {
            String::new()
        } else {
            format!("{}\n", remaining.join("\n"))
        };
        if let Err(error) = std::fs::write(&file, body) {
            tracing::warn!(
                path = %file.display(),
                error = %error,
                "could not rewrite queued linked Plugin inbox"
            );
        }
        Ok(imported)
    }

    pub async fn configure_developer_link_runtime(
        &self,
        node_executable: PathBuf,
        candidate_root: PathBuf,
        broker: Arc<dyn crate::CapabilityBroker>,
    ) {
        *self.worker_restore.write().await = Some(WorkerRestore {
            node_executable,
            candidate_root,
            broker,
        });
    }

    async fn remember_worker_restore(
        &self,
        node_executable: &Path,
        broker: Arc<dyn crate::CapabilityBroker>,
    ) {
        let candidate_root = self
            .worker_restore
            .read()
            .await
            .as_ref()
            .map(|restore| restore.candidate_root.clone())
            .unwrap_or_default();
        *self.worker_restore.write().await = Some(WorkerRestore {
            node_executable: node_executable.to_path_buf(),
            candidate_root,
            broker,
        });
    }

    pub fn spawn_developer_link_refresh(
        this: Arc<Self>,
        node_executable: PathBuf,
        candidate_root: PathBuf,
        broker: Arc<dyn crate::CapabilityBroker>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            this.configure_developer_link_runtime(node_executable, candidate_root, broker)
                .await;
            crate::link_watch::run_developer_link_watch(this).await;
        })
    }

    async fn activate_discovered_user_plugin(
        &self,
        package: &PluginPackage,
        plugin_id: &str,
        has_worker: bool,
    ) {
        if has_worker {
            let restore = self.worker_restore.read().await.clone();
            if let Some(restore) = restore {
                let grants = candidate_capability_grants(package, &[], &[]).unwrap_or_default();
                let _ = self
                    .activate_and_enable(
                        &restore.node_executable,
                        plugin_id,
                        &grants,
                        restore.broker,
                    )
                    .await;
            }
        } else {
            let _ = self.set_enabled(plugin_id, true).await;
        }
    }

    /// Scans a user plugins directory (e.g. `~/.vibex/plugins`) for subdirectories containing
    /// `.vibex-plugin/plugin.json` or root `plugin.json`, automatically importing, enabling,
    /// hot-reloading, and reconciling deleted user plugins.
    pub async fn discover_user_plugins_in(&self, dir: &Path) -> Result<Vec<String>, PluginError> {
        let installed = self.registry.list_plugins().await?;
        let installed_by_id: std::collections::HashMap<&str, &InstalledPlugin> = installed
            .iter()
            .map(|plugin| (plugin.id(), plugin))
            .collect();
        let mut discovered = Vec::new();

        let canonical_dir = dir.canonicalize().ok();
        for plugin in &installed {
            let parent_matches = plugin.source.path.parent() == Some(dir)
                || (canonical_dir.is_some()
                    && plugin.source.path.parent() == canonical_dir.as_deref());
            if plugin.source.kind == crate::PluginSourceKind::DeveloperLink
                && parent_matches
                && !plugin.source.path.is_dir()
                && self.uninstall(plugin.id()).await.is_ok()
            {
                discovered.push(plugin.id().to_owned());
            }
        }

        let Ok(entries) = std::fs::read_dir(dir) else {
            return Ok(discovered);
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir()
                || (!path.join(".vibex-plugin").join("plugin.json").is_file()
                    && !path.join("plugin.json").is_file())
            {
                continue;
            }
            let Ok(package) =
                crate::PluginPackage::inspect(&path, crate::PluginSourceKind::DeveloperLink)
            else {
                continue;
            };
            let plugin_id = package.id.as_str().to_owned();
            let has_worker = package.entrypoints.worker.is_some();

            if let Some(existing) = installed_by_id.get(plugin_id.as_str()) {
                let Ok(digest) = crate::package_content_digest(&path) else {
                    continue;
                };
                if digest == existing.package_digest {
                    continue;
                }
                let was_quarantined = self
                    .quarantine_reason(&plugin_id)
                    .await
                    .ok()
                    .flatten()
                    .is_some();
                if self
                    .import(package.clone(), ConflictDecision::Replace)
                    .await
                    .is_ok()
                {
                    if existing.activation == PluginActivation::Enabled || was_quarantined {
                        self.activate_discovered_user_plugin(&package, &plugin_id, has_worker)
                            .await;
                    }
                    discovered.push(plugin_id);
                }
                continue;
            }

            if self
                .import(package.clone(), ConflictDecision::KeepInstalled)
                .await
                .is_ok()
            {
                self.activate_discovered_user_plugin(&package, &plugin_id, has_worker)
                    .await;
                discovered.push(plugin_id);
            }
        }
        Ok(discovered)
    }

    pub async fn refresh_developer_links(&self) -> Result<Vec<String>, PluginError> {
        let mut changed = Vec::new();
        if let Some(user_dir) = crate::link_watch::user_plugins_dir()
            && let Ok(discovered) = self.discover_user_plugins_in(&user_dir).await
        {
            changed.extend(discovered);
        }
        for plugin in self.registry.list_plugins().await? {
            if plugin.source.kind != crate::PluginSourceKind::DeveloperLink {
                continue;
            }
            if !plugin.source.path.is_dir() {
                tracing::warn!(
                    plugin_id = %plugin.id(),
                    path = %plugin.source.path.display(),
                    "linked Plugin source is missing"
                );
                continue;
            }
            let incoming = match crate::PluginPackage::inspect(
                &plugin.source.path,
                crate::PluginSourceKind::DeveloperLink,
            ) {
                Ok(mut package) => {
                    package.source.origin = plugin.source.origin.clone();
                    package.source.git_ref = plugin.source.git_ref.clone();
                    package.source.git_sha = plugin.source.git_sha.clone();
                    package.source.locked = plugin.source.locked;
                    package
                }
                Err(error) => {
                    tracing::warn!(
                        plugin_id = %plugin.id(),
                        error = %error,
                        "linked Plugin source failed inspection"
                    );
                    continue;
                }
            };
            if incoming.id != plugin.package.id
                || package_publisher(&incoming) != package_publisher(&plugin.package)
            {
                tracing::warn!(
                    plugin_id = %plugin.id(),
                    "linked Plugin identity changed; keeping the installed package"
                );
                continue;
            }
            let digest = match crate::package_content_digest(&plugin.source.path) {
                Ok(digest) => digest,
                Err(error) => {
                    tracing::warn!(
                        plugin_id = %plugin.id(),
                        error = %error,
                        "linked Plugin digest could not be computed"
                    );
                    continue;
                }
            };
            if digest == plugin.package_digest {
                continue;
            }
            if plugin.activation == PluginActivation::Enabled {
                let restore = self.worker_restore.read().await.clone();
                if let Some(restore) =
                    restore.filter(|restore| !restore.candidate_root.as_os_str().is_empty())
                {
                    let mut package = incoming;
                    if let Err(error) =
                        package.freeze_execution_root(&restore.candidate_root, &digest)
                    {
                        tracing::warn!(
                            plugin_id = %plugin.id(),
                            error = %error,
                            "linked Plugin candidate could not be frozen"
                        );
                        continue;
                    }
                    let grants = candidate_capability_grants(&package, &[], &[])?;
                    match self
                        .update_and_activate(
                            &restore.node_executable,
                            package,
                            &grants,
                            restore.broker,
                        )
                        .await
                    {
                        Ok(_) => changed.push(plugin.id().to_owned()),
                        Err(error) => tracing::warn!(
                            plugin_id = %plugin.id(),
                            code = %error.code(),
                            error = %error,
                            "linked Plugin candidate failed to publish; previous generation remains"
                        ),
                    }
                    continue;
                }
            }
            match self.import(incoming, ConflictDecision::Replace).await {
                Ok(_) => {
                    if plugin.activation == PluginActivation::Enabled
                        && plugin.entrypoints.worker.is_none()
                        && let Err(error) = self.set_enabled(plugin.id(), true).await
                    {
                        tracing::warn!(
                            plugin_id = %plugin.id(),
                            error = %error,
                            "linked Plugin was updated but could not be re-enabled"
                        );
                    }
                    changed.push(plugin.id().to_owned());
                }
                Err(error) => tracing::warn!(
                    plugin_id = %plugin.id(),
                    error = %error,
                    "linked Plugin source could not be imported"
                ),
            }
        }
        Ok(changed)
    }

    pub async fn rollback_available(&self, plugin_id: &str) -> Result<bool, PluginError> {
        Ok(self.registry.rollback_package(plugin_id).await?.is_some())
    }

    pub async fn contributions(&self) -> Result<ContributionCatalog, PluginError> {
        self.contributions
            .publish(self.registry.active_contributions().await?)
    }

    pub async fn list_provider_catalog(
        &self,
        agent_id: &str,
    ) -> Result<crate::ProviderCatalogListView, PluginError> {
        let catalog = self.contributions().await?;
        let plugins = self.catalog().await?;
        let mut inputs = Vec::new();
        for plugin in &plugins {
            if plugin.activation != crate::PluginActivation::Enabled {
                continue;
            }
            for contribution in &plugin.app.provider_catalogs {
                inputs.push(crate::CatalogListInput {
                    plugin_id: plugin.id(),
                    plugin_label: plugin.name.as_str(),
                    contribution,
                });
            }
        }
        Ok(crate::aggregate_provider_catalogs(
            agent_id,
            catalog.generation,
            &inputs,
        ))
    }

    pub async fn resolve_file_opener(
        &self,
        extension: Option<&str>,
        media_type: Option<&str>,
    ) -> Result<Option<ResolvedFileOpener>, PluginError> {
        self.contributions
            .publish(self.registry.active_contributions().await?)?;
        self.contributions
            .resolve_file_opener(None, extension, media_type)
    }

    pub async fn resolve_file_opener_for_file(
        &self,
        file_name: Option<&str>,
        extension: Option<&str>,
        media_type: Option<&str>,
    ) -> Result<Option<ResolvedFileOpener>, PluginError> {
        self.contributions
            .publish(self.registry.active_contributions().await?)?;
        self.contributions
            .resolve_file_opener(file_name, extension, media_type)
    }

    pub async fn set_enabled(
        &self,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<InstalledPlugin, PluginError> {
        if enabled {
            let plugin = self
                .registry
                .plugin(plugin_id)
                .await?
                .ok_or_else(|| PluginError::not_found(plugin_id))?;
            if plugin.entrypoints.worker.is_some() {
                return Err(PluginError::registry(
                    "Worker plugins must be enabled through candidate activation",
                ));
            }
            self.require_plugin_dependencies(&plugin.package).await?;
            self.publish_live_generation(plugin_id, None)
                .await
                .map_err(|error| PluginError::registry(format!("{}: {error}", error.code())))?;
            self.reconcile_enabled().await?;
        } else {
            self.withdraw_with_dependents(plugin_id).await?;
            self.registry
                .set_activation(plugin_id, PluginActivation::Disabled)
                .await?;
        }
        self.refresh_live_projections().await?;
        self.registry
            .plugin(plugin_id)
            .await?
            .ok_or_else(|| PluginError::not_found(plugin_id))
    }

    pub async fn activate_candidate(
        &self,
        node_executable: &std::path::Path,
        plugin_id: &str,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<WorkerActivation, WorkerHostError> {
        let package = self
            .registry
            .plugin(plugin_id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?
            .ok_or_else(|| WorkerHostError::external("plugin_not_found", plugin_id))?
            .package;
        self.activations
            .activate_candidate(node_executable, &package, grants, broker)
            .await
    }

    pub async fn activate_and_enable(
        &self,
        node_executable: &std::path::Path,
        plugin_id: &str,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<InstalledPlugin, WorkerHostError> {
        let plugin = self
            .registry
            .plugin(plugin_id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?
            .ok_or_else(|| WorkerHostError::external("plugin_not_found", plugin_id))?;
        self.ensure_plugin_dependencies(&plugin.package).await?;
        let active_matches = match self.activations.lease(plugin_id).await {
            Some(lease) => {
                !lease.is_terminal().await
                    && lease.activation().package_digest == plugin.package_digest
            }
            None => false,
        };
        if active_matches && self.plugin_is_live(plugin_id).await.unwrap_or(false) {
            return Ok(plugin);
        }
        self.remember_worker_restore(node_executable, broker.clone())
            .await;
        let worker =
            plugin
                .entrypoints
                .worker
                .is_some()
                .then_some((node_executable, grants, broker));
        self.publish_live_generation(plugin_id, worker).await?;
        self.reconcile_enabled()
            .await
            .map_err(|error| WorkerHostError::external(error.code(), error))?;
        self.refresh_live_projections()
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?;
        self.registry
            .plugin(plugin_id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?
            .ok_or_else(|| WorkerHostError::external("plugin_not_found", plugin_id))
    }

    pub async fn update_and_activate(
        &self,
        node_executable: &std::path::Path,
        package: PluginPackage,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<InstalledPlugin, WorkerHostError> {
        let plugin_id = package.id.as_str().to_owned();
        let installed = self
            .registry
            .plugin(&plugin_id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?
            .ok_or_else(|| WorkerHostError::external("plugin_not_found", &plugin_id))?;
        if package_publisher(&installed.package) != package_publisher(&package) {
            return Err(WorkerHostError::external(
                "plugin_id_conflict",
                "candidate publisher does not own the installed plugin identity",
            ));
        }
        self.remember_worker_restore(node_executable, broker.clone())
            .await;
        self.ensure_plugin_dependencies(&package).await?;
        self.ensure_runtime_readiness(&plugin_id, &package).await?;
        let generation = self
            .registry
            .prepare_package_candidate(&package)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?;
        let candidate = if package.entrypoints.worker.is_some() {
            match self
                .activations
                .prepare_candidate_at(generation, node_executable, &package, grants, broker)
                .await
            {
                Ok(candidate) => Some(candidate),
                Err(error) => {
                    let _ = self
                        .registry
                        .fail_candidate(generation, &error.to_string())
                        .await;
                    return Err(error);
                }
            }
        } else {
            Some(
                self.activations
                    .prepare_lightweight_candidate_at(generation, &package, grants, broker)?,
            )
        };
        let contributions = descriptors_for_package(&package, generation);
        if let Err(error) = self
            .registry
            .publish_candidate(&plugin_id, generation, &package, &contributions, grants)
            .await
        {
            if let Some(candidate) = candidate {
                let _ = candidate.discard("candidate publication failed").await;
            }
            let _ = self
                .registry
                .fail_candidate(generation, error.message())
                .await;
            return Err(WorkerHostError::external("plugin_registry_failed", error));
        }
        if let Some(candidate) = candidate {
            let drain = self.activations.commit(candidate).await;
            self.retire_after_drain(plugin_id.clone(), drain);
        }
        if let Some(lease) = self.activations.lease(&plugin_id).await
            && let Ok(Some(installed)) = self.registry.plugin(&plugin_id).await
        {
            self.host_services
                .start(&plugin_id, lease, &installed.package);
        }
        let plugin = self
            .registry
            .plugin(&plugin_id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?
            .ok_or_else(|| WorkerHostError::external("plugin_not_found", plugin_id))?;
        let plugins = self
            .registry
            .list_plugins()
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?;
        self.official_mcp.sync_from_plugins(&plugins);
        self.reconcile_enabled()
            .await
            .map_err(|error| WorkerHostError::external(error.code(), error))?;
        self.refresh_live_projections()
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?;
        Ok(plugin)
    }

    pub async fn rollback_and_activate(
        &self,
        node_executable: &std::path::Path,
        plugin_id: &str,
        selected_permission_ids: &[String],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<InstalledPlugin, WorkerHostError> {
        let rollback = self
            .registry
            .rollback_package(plugin_id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?
            .ok_or_else(|| {
                WorkerHostError::external(
                    "plugin_rollback_unavailable",
                    "No verified rollback package is retained for this plugin",
                )
            })?;
        let published_grants = self
            .registry
            .capability_grants(plugin_id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?;
        let grants = candidate_capability_grants(
            &rollback.package,
            &published_grants,
            selected_permission_ids,
        )
        .map_err(|error| WorkerHostError::external("plugin_permission_consent_required", error))?;
        self.update_and_activate(node_executable, rollback.package, &grants, broker)
            .await
    }

    /// Returns `true` if a Worker process is currently spawned and holding an active lease,
    /// without triggering on-demand Worker activation.
    pub async fn is_worker_running(&self, plugin_id: &str) -> bool {
        self.activations
            .lease(plugin_id)
            .await
            .is_some_and(|lease| !lease.is_lightweight())
    }

    /// Total OS worker subprocesses currently alive for this control plane.
    pub async fn active_worker_process_count(&self) -> usize {
        self.activations.active_worker_process_count().await
    }

    /// OS PID of the shared Node worker runner, if currently running.
    pub async fn shared_node_worker_pid(&self) -> Option<u32> {
        self.activations.shared_node_worker_pid().await
    }

    /// Stops Workers that have not been invoked recently.
    ///
    /// Plugins with `host.service` tasks stay up because those intervals cannot
    /// run after the process exits. The plugin remains enabled, so the next
    /// `activation_lease` starts the Worker again.
    pub async fn recycle_idle_workers(&self, max_idle: std::time::Duration) {
        for plugin_id in self.activations.running_plugin_ids().await {
            let plugin = match self.registry.plugin(&plugin_id).await {
                Ok(Some(plugin)) => plugin,
                Ok(None) => continue,
                Err(error) => {
                    tracing::warn!(
                        plugin_id = %plugin_id,
                        %error,
                        "skipping idle recycle; plugin record unavailable"
                    );
                    continue;
                }
            };
            if plugin.package.entrypoints.worker.is_none()
                || !plugin.package.app.host_services.is_empty()
            {
                continue;
            }
            let Some(idle) = self.activations.idle_elapsed(&plugin_id).await else {
                continue;
            };
            if idle < max_idle {
                continue;
            }
            self.host_services.stop(&plugin_id);
            match self.activations.deactivate(&plugin_id).await {
                Ok(true) => tracing::info!(
                    plugin_id = %plugin_id,
                    idle_secs = idle.as_secs(),
                    "recycled idle plugin worker"
                ),
                Ok(false) => {}
                Err(error) => tracing::warn!(
                    plugin_id = %plugin_id,
                    %error,
                    "idle plugin worker recycle failed"
                ),
            }
        }
    }

    pub async fn activation_lease(&self, plugin_id: &str) -> Option<ActivationLease> {
        if let Some(lease) = self.activations.lease(plugin_id).await
            && !lease.is_terminal().await
        {
            return Some(lease);
        }
        let _guard = self.lazy_activation_lock.lock().await;
        if let Some(lease) = self.activations.lease(plugin_id).await
            && !lease.is_terminal().await
        {
            return Some(lease);
        }
        let restore = self.worker_restore.read().await.clone()?;
        let plugin = self.registry.plugin(plugin_id).await.ok().flatten()?;
        if plugin.activation != PluginActivation::Enabled || plugin.entrypoints.worker.is_none() {
            return None;
        }
        let generation = self
            .registry
            .active_generation(plugin_id)
            .await
            .ok()
            .flatten()?;
        if let Err(error) = self.ensure_plugin_dependencies(&plugin.package).await {
            tracing::warn!(
                plugin_id = %plugin_id,
                code = %error.code(),
                %error,
                "on-demand plugin Worker activation skipped due to unsatisfied dependencies"
            );
            return None;
        }
        if let Err(error) = self
            .ensure_runtime_readiness(plugin_id, &plugin.package)
            .await
        {
            tracing::warn!(
                plugin_id = %plugin_id,
                code = %error.code(),
                %error,
                "on-demand plugin Worker activation skipped due to unready runtime"
            );
            return None;
        }
        let grants = candidate_capability_grants(&plugin.package, &[], &[]).ok()?;
        let candidate = match self
            .activations
            .prepare_candidate_at(
                generation,
                &restore.node_executable,
                &plugin.package,
                &grants,
                restore.broker,
            )
            .await
        {
            Ok(candidate) => candidate,
            Err(error) => {
                tracing::warn!(
                    plugin_id = %plugin_id,
                    code = %error.code(),
                    %error,
                    "on-demand plugin Worker activation failed"
                );
                return None;
            }
        };
        let drain = self.activations.commit(candidate).await;
        self.retire_after_drain(plugin_id.to_owned(), drain);
        let lease = self.activations.lease(plugin_id).await?;
        self.host_services
            .start(plugin_id, lease.clone(), &plugin.package);
        Some(lease)
    }

    /// Restores enabled Worker generations after a Host restart. Grants remain
    /// package-digest scoped; third-party packages fail closed if consent is
    /// incomplete, while bundled packages are granted from their declaration.
    ///
    /// Workers without background `host.service` tasks defer OS process creation
    /// until their first `activation_lease` request unless
    /// `VIBEX_EAGER_PLUGIN_WORKERS=1` is set.
    pub async fn recover_enabled_workers(
        &self,
        node_executable: &std::path::Path,
        candidate_root: &std::path::Path,
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<Vec<ActivationRecoveryFailure>, PluginError> {
        self.configure_developer_link_runtime(
            node_executable.to_path_buf(),
            candidate_root.to_path_buf(),
            broker.clone(),
        )
        .await;
        let eager_workers =
            std::env::var_os("VIBEX_EAGER_PLUGIN_WORKERS").is_some_and(|value| value == "1");
        let mut failures = Vec::new();
        for plugin in self.registry.list_plugins().await? {
            if plugin.activation != PluginActivation::Enabled {
                continue;
            }
            if plugin.entrypoints.worker.is_none() {
                if let Some(generation) = self.registry.active_generation(plugin.id()).await?
                    && let Ok(grants) = candidate_capability_grants(&plugin.package, &[], &[])
                    && let Ok(candidate) = self.activations.prepare_lightweight_candidate_at(
                        generation,
                        &plugin.package,
                        &grants,
                        broker.clone(),
                    )
                {
                    let drain = self.activations.commit(candidate).await;
                    self.retire_after_drain(plugin.id().to_owned(), drain);
                }
                continue;
            }
            if !plugin.package.content_root().is_dir()
                && plugin.source.kind == crate::PluginSourceKind::DeveloperLink
            {
                let repaired = async {
                    let mut package = PluginPackage::inspect(
                        &plugin.source.path,
                        crate::PluginSourceKind::DeveloperLink,
                    )
                    .map_err(|error| WorkerHostError::external("plugin_source_invalid", error))?;
                    if package.id != plugin.package.id
                        || package_publisher(&package) != package_publisher(&plugin.package)
                    {
                        return Err(WorkerHostError::external(
                            "plugin_identity_changed",
                            "linked Plugin source no longer matches the installed identity",
                        ));
                    }
                    let digest =
                        crate::package_content_digest(&plugin.source.path).map_err(|error| {
                            WorkerHostError::external("plugin_source_invalid", error)
                        })?;
                    package
                        .freeze_execution_root(candidate_root, &digest)
                        .map_err(|error| {
                            WorkerHostError::external("plugin_candidate_restore_failed", error)
                        })?;
                    let grants =
                        candidate_capability_grants(&package, &[], &[]).map_err(|error| {
                            WorkerHostError::external("plugin_permission_invalid", error)
                        })?;
                    self.update_and_activate(node_executable, package, &grants, broker.clone())
                        .await?;
                    Ok::<(), WorkerHostError>(())
                }
                .await;
                if let Err(error) = repaired {
                    failures.push(ActivationRecoveryFailure {
                        plugin_id: plugin.id().to_owned(),
                        code: error.code().to_owned(),
                        message: error.to_string(),
                    });
                }
                continue;
            }
            let grants = candidate_capability_grants(&plugin.package, &[], &[])?;
            let generation = match self.registry.active_generation(plugin.id()).await? {
                Some(generation) => generation,
                None => continue,
            };
            let restored = async {
                self.ensure_plugin_dependencies(&plugin.package).await?;
                self.ensure_runtime_readiness(plugin.id(), &plugin.package)
                    .await?;
                if eager_workers || !plugin.package.app.host_services.is_empty() {
                    let candidate = self
                        .activations
                        .prepare_candidate_at(
                            generation,
                            node_executable,
                            &plugin.package,
                            &grants,
                            broker.clone(),
                        )
                        .await?;
                    let drain = self.activations.commit(candidate).await;
                    self.retire_after_drain(plugin.id().to_owned(), drain);
                    if let Some(lease) = self.activations.lease(plugin.id()).await {
                        self.host_services
                            .start(plugin.id(), lease, &plugin.package);
                    }
                }
                Ok::<(), WorkerHostError>(())
            }
            .await;
            if let Err(error) = restored {
                failures.push(ActivationRecoveryFailure {
                    plugin_id: plugin.id().to_owned(),
                    code: error.code().to_owned(),
                    message: error.to_string(),
                });
            }
        }
        let _ = self.reconcile_enabled().await;
        let _ = self.refresh_live_projections().await;
        Ok(failures)
    }

    pub async fn deactivate_worker(&self, plugin_id: &str) -> Result<bool, WorkerHostError> {
        self.host_services.stop(plugin_id);
        self.activations.deactivate(plugin_id).await
    }

    pub async fn resolve_action(
        &self,
        plugin_id: &str,
        action_id: &str,
    ) -> Result<PluginAction, PluginError> {
        let plugin = self
            .registry
            .plugin(plugin_id)
            .await?
            .filter(|plugin| plugin.activation == PluginActivation::Enabled)
            .ok_or_else(|| PluginError::invocation_unavailable(plugin_id, action_id))?;
        if !self.plugin_is_live(plugin_id).await? {
            return Err(PluginError::invocation_unavailable(plugin_id, action_id));
        }
        let invocation = plugin
            .invocations
            .iter()
            .find(|invocation| invocation.id == action_id)
            .ok_or_else(|| PluginError::invocation_unavailable(plugin_id, action_id))?;
        let required_runtime_ids = if invocation.required_runtimes.is_empty() {
            plugin
                .runtimes
                .iter()
                .map(|runtime| runtime.id.clone())
                .collect::<Vec<_>>()
        } else {
            invocation.required_runtimes.clone()
        };
        let mut runtime_paths = Vec::new();
        for runtime_id in &required_runtime_ids {
            let required = plugin
                .runtimes
                .iter()
                .find(|runtime| &runtime.id == runtime_id)
                .ok_or_else(|| PluginError::invocation_unavailable(plugin_id, action_id))?;
            let installed = self
                .registry
                .runtime_for_plugin(plugin_id, &required.id)
                .await?
                .filter(|installed| {
                    required
                        .version
                        .as_deref()
                        .is_none_or(|version| version == installed.version)
                        && (required.target == "external" || required.target == installed.target)
                        && (required.content_digest.is_empty()
                            || required.content_digest == installed.content_digest)
                });
            let installed = installed
                .ok_or_else(|| PluginError::invocation_unavailable(plugin_id, action_id))?;
            runtime_paths.push((required.id.clone(), installed.executable_path));
        }
        let required_skills = if invocation.required_skills.is_empty() {
            invocation.skill.iter().cloned().collect::<Vec<_>>()
        } else {
            invocation.required_skills.clone()
        };
        let mut prompt_blocks = vec![PromptBlock::Text {
            text: invocation.prompt.clone(),
        }];
        let skill_paths = required_skills
            .iter()
            .filter_map(|skill_id| {
                plugin
                    .skills
                    .iter()
                    .find(|skill| &skill.id == skill_id)
                    .map(|skill| {
                        format!(
                            "{}/{}",
                            plugin.content_root().display(),
                            skill.path.trim_start_matches('/')
                        )
                    })
            })
            .collect::<Vec<_>>();
        if !skill_paths.is_empty() || !runtime_paths.is_empty() {
            let mut context =
                vec!["VibeX has resolved this workflow to verified local resources:".to_owned()];
            context.extend(
                skill_paths
                    .iter()
                    .map(|path| format!("- Read and follow the Skill at `{path}`.")),
            );
            context.extend(runtime_paths.iter().map(|(id, path)| {
                format!(
                    "- Use the locked `{id}` executable at `{}`; do not install, update, or substitute another binary.",
                    path.display()
                )
            }));
            prompt_blocks.push(PromptBlock::Text {
                text: context.join("\n"),
            });
        }
        Ok(PluginAction {
            id: ActionId::from_string(invocation.id.clone()),
            label: invocation.label.clone(),
            required_skills: required_skills
                .into_iter()
                .map(SkillId::from_string)
                .collect(),
            required_tools: required_runtime_ids
                .into_iter()
                .map(ToolId::from_string)
                .collect(),
            prompt_blocks,
            artifact_intent: invocation.artifact_intent.clone(),
        })
    }

    pub async fn uninstall(&self, plugin_id: &str) -> Result<(), PluginError> {
        let plugin = self
            .registry
            .plugin(plugin_id)
            .await?
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        if plugin.source.kind == crate::PluginSourceKind::DeveloperLink {
            Self::forget_queued_developer_link(&plugin.source.path);
        }
        let evidence = serde_json::json!({
            "packageDigest": plugin.package_digest,
            "sourceKind": source_kind_key(plugin.source.kind),
            "origin": plugin.source.origin,
            "gitRef": plugin.source.git_ref,
            "gitSha": plugin.source.git_sha,
            "locked": plugin.source.locked,
            "sourcePathPreserved": plugin.source.kind == crate::PluginSourceKind::DeveloperLink,
        });
        let _ = self
            .registry
            .record_audit(plugin_id, "uninstall", &evidence)
            .await;
        self.withdraw_with_dependents(plugin_id).await?;
        self.registry
            .set_activation(plugin_id, PluginActivation::Disabled)
            .await
            .ok();
        self.registry.delete_plugin(plugin_id).await?;
        self.refresh_live_projections().await
    }

    pub fn forget_queued_developer_link(source: &Path) {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let file = home.join(".vibex").join("imports").join("links.jsonl");
        let Ok(text) = std::fs::read_to_string(&file) else {
            return;
        };
        let wanted = source.to_string_lossy();
        let remaining: Vec<String> = text
            .lines()
            .filter(|line| {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    return false;
                }
                serde_json::from_str::<serde_json::Value>(trimmed)
                    .ok()
                    .and_then(|entry| {
                        entry
                            .get("path")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                    })
                    .is_none_or(|path| path != wanted)
            })
            .map(str::to_owned)
            .collect();
        let body = if remaining.is_empty() {
            String::new()
        } else {
            format!("{}\n", remaining.join("\n"))
        };
        let _ = std::fs::write(file, body);
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

    pub async fn record_audit(
        &self,
        plugin_id: &str,
        event: &str,
        evidence: &serde_json::Value,
    ) -> Result<(), PluginError> {
        self.registry.record_audit(plugin_id, event, evidence).await
    }

    pub async fn audit_events(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<PluginAuditEvent>, PluginError> {
        self.registry.list_audit(plugin_id).await
    }

    pub async fn kv_get(
        &self,
        plugin_id: &str,
        key: &str,
    ) -> Result<Option<serde_json::Value>, PluginError> {
        self.registry.kv_get(plugin_id, key).await
    }

    pub async fn kv_put(
        &self,
        plugin_id: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), PluginError> {
        self.registry.kv_put(plugin_id, key, value).await
    }

    pub async fn kv_delete(&self, plugin_id: &str, key: &str) -> Result<(), PluginError> {
        self.registry.kv_delete(plugin_id, key).await
    }

    pub async fn kv_list_keys(
        &self,
        plugin_id: &str,
        prefix: Option<&str>,
    ) -> Result<Vec<String>, PluginError> {
        self.registry.kv_list_keys(plugin_id, prefix).await
    }

    pub async fn kv_clear(&self, plugin_id: &str) -> Result<u64, PluginError> {
        self.registry.kv_clear(plugin_id).await
    }

    pub async fn secret_get(
        &self,
        plugin_id: &str,
        secret_key: &str,
    ) -> Result<Option<String>, PluginError> {
        self.registry.secret_get(plugin_id, secret_key).await
    }

    pub async fn secret_put(
        &self,
        plugin_id: &str,
        secret_key: &str,
        value: &str,
    ) -> Result<(), PluginError> {
        self.registry.secret_put(plugin_id, secret_key, value).await
    }

    pub async fn secret_delete(
        &self,
        plugin_id: &str,
        secret_key: &str,
    ) -> Result<bool, PluginError> {
        self.registry.secret_delete(plugin_id, secret_key).await
    }

    pub async fn publish_event(
        &self,
        topic: &str,
        event_type: &str,
        payload: &serde_json::Value,
    ) -> Result<u64, PluginError> {
        self.registry
            .publish_event(topic, event_type, payload)
            .await
    }

    pub async fn events_subscribe(
        &self,
        plugin_id: &str,
        topic: Option<&str>,
        event_type: Option<&str>,
        since_cursor: Option<u64>,
        limit: usize,
    ) -> Result<PluginEventSubscriptionBatch, PluginError> {
        self.registry
            .events_subscribe(plugin_id, topic, event_type, since_cursor, limit)
            .await
    }

    pub async fn events_ack(
        &self,
        plugin_id: &str,
        subscription_key: &str,
        cursor: u64,
    ) -> Result<u64, PluginError> {
        self.registry
            .events_ack(plugin_id, subscription_key, cursor)
            .await
    }

    pub fn register_command_handler(
        &self,
        plugin_id: impl Into<String>,
        command_name: impl Into<String>,
        handler: Arc<dyn PluginCommandHandler>,
    ) -> Result<(), PluginError> {
        self.command_handlers
            .write()
            .map_err(lock_error)?
            .insert((plugin_id.into(), command_name.into()), handler);
        Ok(())
    }

    pub fn register_command_fn<F, Fut>(
        &self,
        plugin_id: impl Into<String>,
        command_name: impl Into<String>,
        handler: F,
    ) -> Result<(), PluginError>
    where
        F: Fn(String, String, serde_json::Value) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<serde_json::Value, WorkerHostError>>
            + Send
            + 'static,
    {
        self.register_command_handler(
            plugin_id,
            command_name,
            Arc::new(FnPluginCommandHandler(handler)),
        )
    }

    pub fn unregister_command_handlers(&self, plugin_id: &str) -> Result<(), PluginError> {
        self.command_handlers
            .write()
            .map_err(lock_error)?
            .retain(|(owner, _), _| owner != plugin_id);
        Ok(())
    }

    pub fn has_command_handler(&self, plugin_id: &str, command_name: &str) -> bool {
        self.command_handlers.read().ok().is_some_and(|handlers| {
            handlers.contains_key(&(plugin_id.to_owned(), command_name.to_owned()))
                || handlers.contains_key(&(plugin_id.to_owned(), "*".to_owned()))
        })
    }

    /// Resolves a dynamic command identifier (`<plugin_id>.<command_name>` or
    /// `<plugin_id>:<command_name>`) against the installed plugin catalog.
    pub async fn resolve_dynamic_command_target(
        &self,
        qualified_command: &str,
    ) -> Result<Option<(String, String)>, PluginError> {
        let trimmed = qualified_command.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        if let Some((plugin_id, command_name)) = trimmed.split_once(':') {
            let plugin_id = plugin_id.trim();
            let command_name = command_name.trim();
            if !plugin_id.is_empty() && !command_name.is_empty() {
                return Ok(Some((plugin_id.to_owned(), command_name.to_owned())));
            }
        }
        let mut candidate_ids: BTreeSet<String> = self
            .registry
            .list_plugins()
            .await?
            .into_iter()
            .map(|plugin| plugin.id().to_owned())
            .collect();
        if let Ok(handlers) = self.command_handlers.read() {
            for (plugin_id, _) in handlers.keys() {
                candidate_ids.insert(plugin_id.clone());
            }
        }
        let mut best_match: Option<(String, String)> = None;
        for plugin_id in candidate_ids {
            if let Some(rest) = trimmed.strip_prefix(&plugin_id)
                && let Some(command_name) = rest.strip_prefix('.')
                && !command_name.is_empty()
            {
                let replace = best_match
                    .as_ref()
                    .is_none_or(|(current_id, _)| plugin_id.len() > current_id.len());
                if replace {
                    best_match = Some((plugin_id, command_name.to_owned()));
                }
            }
        }
        Ok(best_match)
    }

    /// Routes a dynamic plugin RPC command after verifying the target plugin is
    /// in an active generation. Dispatches to a registered Rust
    /// `PluginCommandHandler` if present, or forwards to the plugin's active
    /// Worker slot (Tier 2 `SharedNodeWorkerHost` or Tier 3 Dedicated/Sidecar).
    pub async fn invoke_plugin_command(
        &self,
        plugin_id: &str,
        command_name: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, WorkerHostError> {
        let plugin_id = plugin_id.trim();
        let command_name = command_name.trim();
        if plugin_id.is_empty() || command_name.is_empty() {
            return Err(WorkerHostError::external(
                "invalid_plugin_command",
                "pluginId and command are required",
            ));
        }
        let plugin = self
            .registry
            .plugin(plugin_id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?
            .ok_or_else(|| {
                WorkerHostError::external(
                    "plugin_not_found",
                    format!("Plugin `{plugin_id}` is not installed"),
                )
            })?;
        let is_live = self
            .plugin_is_live(plugin_id)
            .await
            .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?;
        if plugin.activation != PluginActivation::Enabled || !is_live {
            return Err(WorkerHostError::external(
                "plugin_not_active",
                format!("Plugin `{plugin_id}` does not have an active generation"),
            ));
        }

        let rust_handler = self.command_handlers.read().ok().and_then(|handlers| {
            handlers
                .get(&(plugin_id.to_owned(), command_name.to_owned()))
                .cloned()
                .or_else(|| {
                    handlers
                        .get(&(plugin_id.to_owned(), "*".to_owned()))
                        .cloned()
                })
        });
        if let Some(handler) = rust_handler {
            return handler.handle(plugin_id, command_name, input).await;
        }

        if let Some(lease) = self.activation_lease(plugin_id).await
            && !lease.is_lightweight()
        {
            return lease
                .invoke_with_timeout(command_name, input, std::time::Duration::from_secs(30))
                .await;
        }

        Err(WorkerHostError::external(
            "plugin_command_not_found",
            format!("Plugin `{plugin_id}` does not expose command `{command_name}`"),
        ))
    }

    pub async fn quarantine_plugin(
        &self,
        plugin_id: &str,
        reason: &str,
    ) -> Result<(), PluginError> {
        let _ = self.withdraw_with_dependents(plugin_id).await;
        self.registry.quarantine_plugin(plugin_id, reason).await?;
        let _ = self
            .registry
            .record_audit(
                plugin_id,
                "quarantined",
                &serde_json::json!({ "reason": reason }),
            )
            .await;
        self.refresh_live_projections().await
    }

    pub async fn quarantine_reason(&self, plugin_id: &str) -> Result<Option<String>, PluginError> {
        self.registry.quarantine_reason(plugin_id).await
    }

    /// Display name for a plugin, for Host prompts that must tell the user who
    /// is asking. Falls back to `None` so callers show the id rather than an
    /// empty string.
    pub async fn installed_plugin_name(&self, plugin_id: &str) -> Option<String> {
        self.catalog()
            .await
            .ok()?
            .into_iter()
            .find(|installed| installed.id() == plugin_id)
            .map(|installed| installed.package.name.clone())
    }

    /// Builtins whose identity was replaced. The old id stays in the install
    /// table until this runs, so the catalog would show two products for one
    /// capability.
    pub const REPLACED_BUILTIN_PLUGINS: &'static [(&'static str, &'static str)] =
        crate::catalog::REPLACED_PLUGIN_IDS;

    pub async fn retire_replaced_builtins(&self) -> Result<(), PluginError> {
        for (retired_id, successor_id) in Self::REPLACED_BUILTIN_PLUGINS {
            let Some(retired) = self.registry.plugin(retired_id).await? else {
                continue;
            };
            let Some(successor) = self.registry.plugin(successor_id).await? else {
                continue;
            };
            if successor.package.config_schema.is_some() {
                successor
                    .package
                    .write_adopted_config(retired.config.clone())?;
                let mut refreshed = successor.clone();
                refreshed.package.config =
                    successor.package.adopt_installed_config(&retired.config)?;
                self.registry.put_plugin(refreshed).await?;
            }
            if retired.activation == PluginActivation::Enabled
                && successor.activation != PluginActivation::Enabled
            {
                self.set_enabled(successor_id, true).await?;
            }
            self.uninstall(retired_id).await?;
        }
        Ok(())
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

    async fn ensure_plugin_dependencies(
        &self,
        package: &PluginPackage,
    ) -> Result<(), WorkerHostError> {
        for dependency in plugin_dependencies(package) {
            if !dependency.required {
                continue;
            }
            let installed = self
                .registry
                .plugin(&dependency.id)
                .await
                .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?;
            let Some(installed) = installed else {
                let publisher = dependency.publisher.as_deref().unwrap_or("local");
                return Err(WorkerHostError::external(
                    "dependency_unsatisfied",
                    format!(
                        "required plugin `{}/{}` is not installed",
                        publisher, dependency.id
                    ),
                ));
            };
            if let Some(ref expected_publisher) = dependency.publisher
                && package_publisher(&installed.package) != expected_publisher
            {
                return Err(WorkerHostError::external(
                    "dependency_unsatisfied",
                    format!(
                        "required plugin `{}` is not published by `{}`",
                        dependency.id, expected_publisher
                    ),
                ));
            }
            if installed.activation != PluginActivation::Enabled
                || !self
                    .plugin_is_live(&dependency.id)
                    .await
                    .map_err(|error| WorkerHostError::external("plugin_registry_failed", error))?
            {
                return Err(WorkerHostError::external(
                    "dependency_unsatisfied",
                    format!("required plugin `{}` is not ready", dependency.id),
                ));
            }
            if let Ok(requirement) = semver::VersionReq::parse(&dependency.version_range)
                && let Ok(version) = semver::Version::parse(&installed.version)
                && !requirement.matches(&version)
            {
                return Err(WorkerHostError::external(
                    "dependency_unsatisfied",
                    format!(
                        "plugin `{}` {} does not satisfy {}",
                        dependency.id, installed.version, dependency.version_range
                    ),
                ));
            }
        }
        Ok(())
    }

    /// Computes the topological activation order of all installed plugins based
    /// on declared `dependencies.kind=plugin` edges.
    pub async fn topological_activation_order(&self) -> Result<Vec<String>, PluginError> {
        let plugins = self.registry.list_plugins().await?;
        let mut by_id = BTreeMap::new();
        for plugin in &plugins {
            by_id.insert(plugin.id().to_owned(), plugin);
        }
        let mut visited = BTreeSet::new();
        let mut visiting = BTreeSet::new();
        let mut order = Vec::with_capacity(plugins.len());

        fn visit(
            id: &str,
            by_id: &BTreeMap<String, &InstalledPlugin>,
            visited: &mut BTreeSet<String>,
            visiting: &mut BTreeSet<String>,
            order: &mut Vec<String>,
        ) -> Result<(), PluginError> {
            if visited.contains(id) {
                return Ok(());
            }
            if !visiting.insert(id.to_owned()) {
                return Err(PluginError::dependency_unsatisfied(format!(
                    "cyclic plugin dependency involving `{id}`"
                )));
            }
            if let Some(plugin) = by_id.get(id) {
                for dep in plugin.package.plugin_dependencies() {
                    if by_id.contains_key(&dep.id) {
                        visit(&dep.id, by_id, visited, visiting, order)?;
                    }
                }
            }
            visiting.remove(id);
            visited.insert(id.to_owned());
            order.push(id.to_owned());
            Ok(())
        }

        for id in by_id.keys() {
            visit(id, &by_id, &mut visited, &mut visiting, &mut order)?;
        }
        Ok(order)
    }

    /// Returns all installed plugins that transitively depend on `plugin_id`.
    pub async fn dependent_plugins(&self, plugin_id: &str) -> Result<Vec<String>, PluginError> {
        let plugins = self.registry.list_plugins().await?;
        let mut dependents = Vec::new();
        let mut queue = std::collections::VecDeque::from([plugin_id.to_owned()]);
        let mut seen = BTreeSet::from([plugin_id.to_owned()]);
        while let Some(current) = queue.pop_front() {
            for plugin in &plugins {
                let id = plugin.id().to_owned();
                if seen.contains(&id) {
                    continue;
                }
                if plugin
                    .package
                    .plugin_dependencies()
                    .iter()
                    .any(|dep| dep.required && dep.id == current)
                {
                    seen.insert(id.clone());
                    dependents.push(id.clone());
                    queue.push_back(id);
                }
            }
        }
        Ok(dependents)
    }

    async fn require_plugin_dependencies(
        &self,
        package: &PluginPackage,
    ) -> Result<(), PluginError> {
        self.ensure_plugin_dependencies(package)
            .await
            .map_err(|error| {
                if error.code() == "dependency_unsatisfied" {
                    PluginError::dependency_unsatisfied(error.to_string())
                } else {
                    PluginError::registry(error.to_string())
                }
            })
    }

    pub async fn grant_permissions(
        &self,
        plugin_id: &str,
        _permission_ids: &[String],
    ) -> Result<(), PluginError> {
        let plugin = self
            .registry
            .plugin(plugin_id)
            .await?
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        self.registry
            .replace_declared_grants(plugin_id, &plugin.permissions)
            .await
    }

    pub async fn grant_declared_permissions(&self, plugin_id: &str) -> Result<(), PluginError> {
        let plugin = self
            .registry
            .plugin(plugin_id)
            .await?
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        self.grant_permissions(
            plugin_id,
            &plugin
                .permissions
                .iter()
                .map(|permission| permission.id.clone())
                .collect::<Vec<_>>(),
        )
        .await
    }

    pub async fn capability_grants(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<crate::CapabilityGrant>, PluginError> {
        self.registry.capability_grants(plugin_id).await
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

fn lock_error<T>(error: std::sync::PoisonError<T>) -> PluginError {
    PluginError::registry(error.to_string())
}

fn registry_error(error: impl std::fmt::Display) -> PluginError {
    PluginError::registry(error.to_string())
}

async fn gc_runtime_locks(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<(), PluginError> {
    sqlx::query(
        "DELETE FROM plugin_runtime_locks_v4
         WHERE NOT EXISTS (
           SELECT 1 FROM plugin_installations_v4 i
           WHERE i.plugin_id = plugin_runtime_locks_v4.plugin_id
             AND (i.current_package_digest = plugin_runtime_locks_v4.package_digest
               OR i.rollback_package_digest = plugin_runtime_locks_v4.package_digest)
         )",
    )
    .execute(&mut **transaction)
    .await
    .map_err(registry_error)?;
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
    .execute(&mut **transaction)
    .await
    .map_err(registry_error)?;
    Ok(())
}

fn external_runtime_target() -> String {
    "external".to_owned()
}

fn external_runtime_ownership() -> String {
    "external".to_owned()
}

type RuntimeArtifactKey = (String, String, String, String);

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

fn package_digest(package: &PluginPackage) -> Result<String, PluginError> {
    crate::package_content_digest(package.content_root())
}

fn decode_plugin_row(row: sqlx::sqlite::SqliteRow) -> Result<InstalledPlugin, PluginError> {
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

fn source_kind_key(kind: crate::PluginSourceKind) -> &'static str {
    match kind {
        crate::PluginSourceKind::Builtin => "builtin",
        crate::PluginSourceKind::Snapshot => "snapshot",
        crate::PluginSourceKind::Marketplace => "marketplace",
        crate::PluginSourceKind::DeveloperLink => "developer_link",
        crate::PluginSourceKind::CodexNative => "codex_native",
        crate::PluginSourceKind::ClaudeCodeNative => "claude_code_native",
    }
}

fn contribution_kind_key(kind: crate::ContributionKind) -> &'static str {
    kind.key()
}

fn package_publisher(package: &PluginPackage) -> &str {
    package.publisher.as_deref().unwrap_or("legacy.local")
}

fn plugin_dependencies(package: &PluginPackage) -> Vec<crate::PluginDependency> {
    package.plugin_dependencies()
}

pub(crate) fn event_subscription_key(topic: Option<&str>, event_type: Option<&str>) -> String {
    let topic_part = topic
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("*");
    let type_part = event_type
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("*");
    format!("{topic_part}:{type_part}")
}

fn secret_stream_byte(plugin_id: &str, secret_key: &str, nonce: &[u8], counter: usize) -> u8 {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"vibex.plugin_secrets.v1:");
    hasher.update(plugin_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(secret_key.as_bytes());
    hasher.update([0u8]);
    hasher.update(nonce);
    hasher.update((counter / 32).to_le_bytes());
    let digest = hasher.finalize();
    digest[counter % 32]
}

fn secret_auth_tag(plugin_id: &str, secret_key: &str, nonce: &[u8], ciphertext: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"vibex.plugin_secrets.mac.v1:");
    hasher.update(plugin_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(secret_key.as_bytes());
    hasher.update([0u8]);
    hasher.update(nonce);
    hasher.update(ciphertext);
    hasher.finalize().into()
}

fn encrypt_plugin_secret(
    plugin_id: &str,
    secret_key: &str,
    plaintext: &str,
) -> Result<String, PluginError> {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    let mut nonce_hasher = Sha256::new();
    nonce_hasher.update(uuid::Uuid::new_v4().as_bytes());
    nonce_hasher.update(plugin_id.as_bytes());
    nonce_hasher.update(secret_key.as_bytes());
    let nonce_full = nonce_hasher.finalize();
    let nonce = &nonce_full[..16];
    let plain_bytes = plaintext.as_bytes();
    let mut cipher_bytes = Vec::with_capacity(plain_bytes.len());
    for (idx, byte) in plain_bytes.iter().enumerate() {
        cipher_bytes.push(*byte ^ secret_stream_byte(plugin_id, secret_key, nonce, idx));
    }
    let tag = secret_auth_tag(plugin_id, secret_key, nonce, &cipher_bytes);
    let mut envelope = Vec::with_capacity(1 + 16 + 32 + cipher_bytes.len());
    envelope.push(1u8);
    envelope.extend_from_slice(nonce);
    envelope.extend_from_slice(&tag);
    envelope.extend_from_slice(&cipher_bytes);
    Ok(base64::engine::general_purpose::STANDARD.encode(envelope))
}

fn decrypt_plugin_secret(
    plugin_id: &str,
    secret_key: &str,
    encoded: &str,
) -> Result<String, PluginError> {
    use base64::Engine as _;
    let envelope = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(registry_error)?;
    if envelope.len() < 1 + 16 + 32 || envelope[0] != 1u8 {
        return Err(PluginError::registry("invalid plugin secret envelope"));
    }
    let nonce = &envelope[1..17];
    let tag = &envelope[17..49];
    let cipher_bytes = &envelope[49..];
    let expected_tag = secret_auth_tag(plugin_id, secret_key, nonce, cipher_bytes);
    if tag != expected_tag.as_slice() {
        return Err(PluginError::registry(
            "plugin secret authentication tag mismatch",
        ));
    }
    let mut plain_bytes = Vec::with_capacity(cipher_bytes.len());
    for (idx, byte) in cipher_bytes.iter().enumerate() {
        plain_bytes.push(*byte ^ secret_stream_byte(plugin_id, secret_key, nonce, idx));
    }
    String::from_utf8(plain_bytes).map_err(registry_error)
}
