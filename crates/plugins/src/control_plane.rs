use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, RwLock},
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::{
    ActionId, InvocationKind, PluginAction, PluginActivation, PluginError, PluginPackage,
    PluginSource, PromptBlock, SkillId, ToolId,
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
pub struct ImportConflict {
    pub plugin_id: String,
    pub installed_source: PathBuf,
    pub incoming_source: PathBuf,
}

#[derive(Clone, Debug, PartialEq)]
pub struct InstalledPlugin {
    pub package: PluginPackage,
    pub activation: PluginActivation,
    pub shell_trusted: bool,
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
    pub executable_path: PathBuf,
    #[serde(default)]
    pub installer: String,
    #[serde(default)]
    pub probe: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeConflict {
    pub runtime_id: String,
    pub current_version: String,
    pub target_version: String,
    pub affected_plugins: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImportResult {
    pub disposition: ImportDisposition,
    pub plugin: InstalledPlugin,
}

#[async_trait]
pub trait PluginRegistry: Send + Sync {
    async fn plugin(&self, plugin_id: &str) -> Result<Option<InstalledPlugin>, PluginError>;
    async fn list_plugins(&self) -> Result<Vec<InstalledPlugin>, PluginError>;
    async fn put_plugin(&self, plugin: InstalledPlugin) -> Result<(), PluginError>;
    async fn set_activation(
        &self,
        plugin_id: &str,
        activation: PluginActivation,
    ) -> Result<(), PluginError>;
    async fn delete_plugin(&self, plugin_id: &str) -> Result<(), PluginError>;
    async fn set_shell_trust(&self, plugin_id: &str, trusted: bool) -> Result<(), PluginError>;
    async fn is_shell_trusted(&self, plugin_id: &str) -> Result<bool, PluginError>;
    async fn put_runtime(&self, runtime: RuntimeInstallation) -> Result<(), PluginError>;
    async fn list_runtimes(&self) -> Result<Vec<RuntimeInstallation>, PluginError>;
}

#[derive(Default)]
pub struct InMemoryPluginRegistry {
    plugins: RwLock<BTreeMap<String, InstalledPlugin>>,
    trust: RwLock<BTreeMap<String, bool>>,
    runtimes: RwLock<BTreeMap<String, RuntimeInstallation>>,
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

    async fn put_plugin(&self, plugin: InstalledPlugin) -> Result<(), PluginError> {
        self.plugins
            .write()
            .map_err(lock_error)?
            .insert(plugin.id().to_owned(), plugin);
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
        Ok(())
    }

    async fn delete_plugin(&self, plugin_id: &str) -> Result<(), PluginError> {
        self.plugins.write().map_err(lock_error)?.remove(plugin_id);
        self.trust.write().map_err(lock_error)?.remove(plugin_id);
        Ok(())
    }

    async fn set_shell_trust(&self, plugin_id: &str, trusted: bool) -> Result<(), PluginError> {
        if trusted {
            self.trust
                .write()
                .map_err(lock_error)?
                .insert(plugin_id.to_owned(), true);
        } else {
            self.trust.write().map_err(lock_error)?.remove(plugin_id);
        }
        Ok(())
    }

    async fn is_shell_trusted(&self, plugin_id: &str) -> Result<bool, PluginError> {
        Ok(self
            .trust
            .read()
            .map_err(lock_error)?
            .get(plugin_id)
            .copied()
            .unwrap_or(false))
    }

    async fn put_runtime(&self, runtime: RuntimeInstallation) -> Result<(), PluginError> {
        self.runtimes
            .write()
            .map_err(lock_error)?
            .insert(runtime.id.clone(), runtime);
        Ok(())
    }

    async fn list_runtimes(&self) -> Result<Vec<RuntimeInstallation>, PluginError> {
        Ok(self
            .runtimes
            .read()
            .map_err(lock_error)?
            .values()
            .cloned()
            .collect())
    }
}

pub struct SqlitePluginRegistry {
    pool: SqlitePool,
}

impl SqlitePluginRegistry {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl PluginRegistry for SqlitePluginRegistry {
    async fn plugin(&self, plugin_id: &str) -> Result<Option<InstalledPlugin>, PluginError> {
        let row = sqlx::query(
            "SELECT r.package_json, a.enabled, CASE WHEN t.plugin_id IS NULL THEN 0 ELSE 1 END AS trusted
             FROM plugin_control_registry r
             JOIN plugin_control_activation a ON a.plugin_id = r.plugin_id
             LEFT JOIN plugin_control_shell_trust t ON t.plugin_id = r.plugin_id
             WHERE r.plugin_id = ?",
        )
        .bind(plugin_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(registry_error)?;
        row.map(decode_plugin_row).transpose()
    }

    async fn list_plugins(&self) -> Result<Vec<InstalledPlugin>, PluginError> {
        let rows = sqlx::query(
            "SELECT r.package_json, a.enabled, CASE WHEN t.plugin_id IS NULL THEN 0 ELSE 1 END AS trusted
             FROM plugin_control_registry r
             JOIN plugin_control_activation a ON a.plugin_id = r.plugin_id
             LEFT JOIN plugin_control_shell_trust t ON t.plugin_id = r.plugin_id
             ORDER BY r.name COLLATE NOCASE, r.plugin_id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(registry_error)?;
        rows.into_iter().map(decode_plugin_row).collect()
    }

    async fn put_plugin(&self, plugin: InstalledPlugin) -> Result<(), PluginError> {
        let package_json = serde_json::to_string(&plugin.package).map_err(registry_error)?;
        let mut transaction = self.pool.begin().await.map_err(registry_error)?;
        sqlx::query(
            "INSERT INTO plugin_control_registry
                 (plugin_id, name, version, source_kind, source_path, package_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(plugin_id) DO UPDATE SET
                 name = excluded.name,
                 version = excluded.version,
                 source_kind = excluded.source_kind,
                 source_path = excluded.source_path,
                 package_json = excluded.package_json,
                 updated_at = CURRENT_TIMESTAMP",
        )
        .bind(plugin.id())
        .bind(&plugin.name)
        .bind(&plugin.version)
        .bind(source_kind_key(plugin.source.kind))
        .bind(plugin.source.path.to_string_lossy().as_ref())
        .bind(package_json)
        .execute(&mut *transaction)
        .await
        .map_err(registry_error)?;
        sqlx::query(
            "INSERT INTO plugin_control_activation (plugin_id, enabled, updated_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(plugin_id) DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP",
        )
        .bind(plugin.id())
        .bind(i64::from(plugin.activation == PluginActivation::Enabled))
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
        let result = sqlx::query(
            "UPDATE plugin_control_activation SET enabled = ?, updated_at = CURRENT_TIMESTAMP
             WHERE plugin_id = ?",
        )
        .bind(i64::from(activation == PluginActivation::Enabled))
        .bind(plugin_id)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        if result.rows_affected() == 0 {
            return Err(PluginError::not_found(plugin_id));
        }
        Ok(())
    }

    async fn delete_plugin(&self, plugin_id: &str) -> Result<(), PluginError> {
        sqlx::query("DELETE FROM plugin_control_registry WHERE plugin_id = ?")
            .bind(plugin_id)
            .execute(&self.pool)
            .await
            .map_err(registry_error)?;
        Ok(())
    }

    async fn set_shell_trust(&self, plugin_id: &str, trusted: bool) -> Result<(), PluginError> {
        if trusted {
            sqlx::query(
                "INSERT INTO plugin_control_shell_trust (plugin_id, granted_at)
                 VALUES (?, CURRENT_TIMESTAMP)
                 ON CONFLICT(plugin_id) DO NOTHING",
            )
            .bind(plugin_id)
            .execute(&self.pool)
            .await
            .map_err(registry_error)?;
        } else {
            sqlx::query("DELETE FROM plugin_control_shell_trust WHERE plugin_id = ?")
                .bind(plugin_id)
                .execute(&self.pool)
                .await
                .map_err(registry_error)?;
        }
        Ok(())
    }

    async fn is_shell_trusted(&self, plugin_id: &str) -> Result<bool, PluginError> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM plugin_control_shell_trust WHERE plugin_id = ?",
        )
        .bind(plugin_id)
        .fetch_one(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(count > 0)
    }

    async fn put_runtime(&self, runtime: RuntimeInstallation) -> Result<(), PluginError> {
        sqlx::query(
            "INSERT INTO plugin_control_runtime_inventory
                 (runtime_id, version, executable_path, installer, probe_json, updated_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(runtime_id) DO UPDATE SET
                 version = excluded.version,
                 executable_path = excluded.executable_path,
                 installer = excluded.installer,
                 probe_json = excluded.probe_json,
                 updated_at = CURRENT_TIMESTAMP",
        )
        .bind(runtime.id)
        .bind(runtime.version)
        .bind(runtime.executable_path.to_string_lossy().as_ref())
        .bind(runtime.installer)
        .bind(serde_json::to_string(&runtime.probe).map_err(registry_error)?)
        .execute(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(())
    }

    async fn list_runtimes(&self) -> Result<Vec<RuntimeInstallation>, PluginError> {
        let rows = sqlx::query(
            "SELECT runtime_id, version, executable_path, installer, probe_json
             FROM plugin_control_runtime_inventory ORDER BY runtime_id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(registry_error)?;
        Ok(rows
            .into_iter()
            .map(|row| RuntimeInstallation {
                id: row.get("runtime_id"),
                version: row.get("version"),
                executable_path: PathBuf::from(row.get::<String, _>("executable_path")),
                installer: row.get("installer"),
                probe: serde_json::from_str(row.get::<String, _>("probe_json").as_str())
                    .unwrap_or_default(),
            })
            .collect())
    }
}

pub struct PluginControlPlane {
    registry: Arc<dyn PluginRegistry>,
}

impl PluginControlPlane {
    pub fn new(registry: Arc<dyn PluginRegistry>) -> Self {
        Self { registry }
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
        let trusted = self.registry.is_shell_trusted(package.id.as_str()).await?;
        let disposition = if existing.is_some() {
            ImportDisposition::Replaced
        } else {
            ImportDisposition::Installed
        };
        let plugin = InstalledPlugin {
            package,
            activation: PluginActivation::Disabled,
            shell_trusted: trusted,
        };
        self.registry.put_plugin(plugin.clone()).await?;
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

    pub async fn set_enabled(
        &self,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<InstalledPlugin, PluginError> {
        let activation = if enabled {
            PluginActivation::Enabled
        } else {
            PluginActivation::Disabled
        };
        self.registry.set_activation(plugin_id, activation).await?;
        self.registry
            .plugin(plugin_id)
            .await?
            .ok_or_else(|| PluginError::not_found(plugin_id))
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
        let invocation = plugin
            .invocations
            .iter()
            .find(|invocation| {
                invocation.id == action_id && invocation.kind == InvocationKind::Action
            })
            .ok_or_else(|| PluginError::invocation_unavailable(plugin_id, action_id))?;
        let inventory = self.registry.list_runtimes().await?;
        if plugin.runtimes.iter().any(|required| {
            !inventory.iter().any(|installed| {
                installed.id == required.id
                    && required
                        .version
                        .as_deref()
                        .is_none_or(|version| version == installed.version)
            })
        }) {
            return Err(PluginError::invocation_unavailable(plugin_id, action_id));
        }
        Ok(PluginAction {
            id: ActionId::from_string(invocation.id.clone()),
            label: invocation.label.clone(),
            required_skills: invocation
                .skill
                .iter()
                .cloned()
                .map(SkillId::from_string)
                .collect(),
            required_tools: plugin
                .runtimes
                .iter()
                .map(|runtime| ToolId::from_string(runtime.id.clone()))
                .collect(),
            prompt_blocks: vec![PromptBlock::Text {
                text: invocation.prompt.clone(),
            }],
            artifact_intent: None,
        })
    }

    pub async fn grant_shell_trust(&self, plugin_id: &str) -> Result<(), PluginError> {
        if self.registry.plugin(plugin_id).await?.is_none() {
            return Err(PluginError::not_found(plugin_id));
        }
        self.registry.set_shell_trust(plugin_id, true).await
    }

    pub async fn is_shell_trusted(&self, plugin_id: &str) -> Result<bool, PluginError> {
        self.registry.is_shell_trusted(plugin_id).await
    }

    pub async fn revoke_shell_trust(&self, plugin_id: &str) -> Result<(), PluginError> {
        if self.registry.plugin(plugin_id).await?.is_none() {
            return Err(PluginError::not_found(plugin_id));
        }
        self.registry.set_shell_trust(plugin_id, false).await
    }

    pub async fn uninstall(&self, plugin_id: &str) -> Result<(), PluginError> {
        if self.registry.plugin(plugin_id).await?.is_none() {
            return Err(PluginError::not_found(plugin_id));
        }
        self.registry.delete_plugin(plugin_id).await
    }

    pub async fn runtime_inventory(&self) -> Result<Vec<RuntimeInstallation>, PluginError> {
        self.registry.list_runtimes().await
    }

    pub async fn record_runtime(&self, runtime: RuntimeInstallation) -> Result<(), PluginError> {
        self.registry.put_runtime(runtime).await
    }

    pub async fn preview_runtime_install(
        &self,
        plugin_id: &str,
        runtime_id: &str,
    ) -> Result<Option<RuntimeConflict>, PluginError> {
        let plugin = self
            .registry
            .plugin(plugin_id)
            .await?
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        let contribution = plugin
            .runtimes
            .iter()
            .find(|runtime| runtime.id == runtime_id)
            .ok_or_else(|| PluginError::runtime_not_ready(runtime_id, "not declared by plugin"))?;
        let Some(target_version) = contribution.version.clone() else {
            return Ok(None);
        };
        let installed = self
            .registry
            .list_runtimes()
            .await?
            .into_iter()
            .find(|runtime| runtime.id == runtime_id);
        let Some(installed) = installed.filter(|runtime| runtime.version != target_version) else {
            return Ok(None);
        };
        let mut affected_plugins = self
            .registry
            .list_plugins()
            .await?
            .into_iter()
            .filter(|candidate| candidate.id() != plugin_id)
            .filter(|candidate| {
                candidate.runtimes.iter().any(|runtime| {
                    runtime.id == runtime_id
                        && runtime.version.as_deref() == Some(installed.version.as_str())
                })
            })
            .map(|candidate| candidate.id().to_owned())
            .collect::<Vec<_>>();
        affected_plugins.sort();
        Ok(Some(RuntimeConflict {
            runtime_id: runtime_id.to_owned(),
            current_version: installed.version,
            target_version,
            affected_plugins,
        }))
    }

    #[doc(hidden)]
    pub async fn record_runtime_for_test(
        &self,
        id: &str,
        version: &str,
        executable_path: &str,
    ) -> Result<(), PluginError> {
        self.record_runtime(RuntimeInstallation {
            id: id.to_owned(),
            version: version.to_owned(),
            executable_path: PathBuf::from(executable_path),
            installer: "test".to_owned(),
            probe: Vec::new(),
        })
        .await
    }
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> PluginError {
    PluginError::registry(error.to_string())
}

fn registry_error(error: impl std::fmt::Display) -> PluginError {
    PluginError::registry(error.to_string())
}

fn decode_plugin_row(row: sqlx::sqlite::SqliteRow) -> Result<InstalledPlugin, PluginError> {
    let package =
        serde_json::from_str::<PluginPackage>(row.get("package_json")).map_err(registry_error)?;
    Ok(InstalledPlugin {
        package,
        activation: if row.get::<i64, _>("enabled") == 1 {
            PluginActivation::Enabled
        } else {
            PluginActivation::Disabled
        },
        shell_trusted: row.get::<i64, _>("trusted") == 1,
    })
}

fn source_kind_key(kind: crate::PluginSourceKind) -> &'static str {
    match kind {
        crate::PluginSourceKind::Builtin => "builtin",
        crate::PluginSourceKind::Snapshot => "snapshot",
        crate::PluginSourceKind::DeveloperLink => "developer_link",
        crate::PluginSourceKind::CodexNative => "codex_native",
        crate::PluginSourceKind::ClaudeCodeNative => "claude_code_native",
    }
}
