use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{Arc, RwLock},
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::{
    ActionId, ActivationManager, CapabilityBroker, CapabilityGrant, ContributionCatalog,
    PluginAction, PluginActivation, PluginError, PluginPackage, PluginSource, PluginSourceKind,
    PromptBlock, ResolvedFileOpener, SkillId, ToolId, WorkerActivation, WorkerHostError,
    contribution::ContributionRegistry,
};

mod audit_event;
mod developer_link;
mod generation;
mod kv_secret;
mod lifecycle;
mod registry;
mod runtime;
mod system_bundle;
mod worker;

pub use registry::{InMemoryPluginRegistry, PluginRegistry, SqlitePluginRegistry};
pub use system_bundle::{
    SYSTEM_BUNDLE_PLUGIN_MANIFESTS, SystemBundlePluginManifest, is_system_bundle_plugin_id,
    resolve_system_bundle_domain_command, system_bundle_plugin_manifest,
    system_bundle_plugin_manifests,
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

#[derive(Clone)]
pub(crate) struct WorkerRestore {
    pub(super) node_executable: PathBuf,
    pub(super) candidate_root: PathBuf,
    pub(super) broker: Arc<dyn CapabilityBroker>,
}

pub struct PluginControlPlane {
    pub(super) registry: Arc<dyn PluginRegistry>,
    pub(super) contributions: ContributionRegistry,
    pub(super) activations: ActivationManager,
    pub(super) official_mcp: Arc<crate::OfficialMcpRuntime>,
    pub(super) host_services: crate::host_service::HostServiceSupervisor,
    pub(super) worker_restore: tokio::sync::RwLock<Option<WorkerRestore>>,
    pub(super) lazy_activation_lock: tokio::sync::Mutex<()>,
    pub(super) catalog_changes: tokio::sync::broadcast::Sender<u64>,
    pub(super) command_handlers: RwLock<BTreeMap<(String, String), Arc<dyn PluginCommandHandler>>>,
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
        if crate::catalog::is_retired_plugin_id(package.id.as_str()) {
            return Err(PluginError::invalid_manifest(format!(
                "plugin '{}' has been retired and its capability is now built into VibeX",
                package.id.as_str()
            )));
        }
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

    /// Returns the locked System Bundle foundation plugin manifests that correspond
    /// 1:1 with the frontend `coreFoundationCatalogData.ts` System Bundle descriptors.
    pub fn system_bundle_manifests(&self) -> &'static [SystemBundlePluginManifest] {
        system_bundle_plugin_manifests()
    }

    /// Looks up a locked System Bundle foundation plugin manifest by `plugin_id`.
    pub fn system_bundle_manifest(
        &self,
        plugin_id: &str,
    ) -> Option<&'static SystemBundlePluginManifest> {
        system_bundle_plugin_manifest(plugin_id)
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
        for retired_id in crate::catalog::RETIRED_PLUGIN_IDS {
            if self.registry.plugin(retired_id).await?.is_some() {
                self.uninstall(retired_id).await?;
            } else {
                let _ = self.registry.delete_plugin(retired_id).await;
            }
        }
        for delisted_id in [
            "vibex.kanban-views",
            "vibex.notes",
            "vibex.prompt-enhancer",
        ] {
            if let Some(installed) = self.registry.plugin(delisted_id).await?
                && matches!(
                    installed.source.kind,
                    PluginSourceKind::Marketplace | PluginSourceKind::Builtin
                )
            {
                self.uninstall(delisted_id).await?;
            }
        }
        Ok(())
    }
}

pub(crate) fn lock_error<T>(error: std::sync::PoisonError<T>) -> PluginError {
    PluginError::registry(error.to_string())
}

pub(crate) fn registry_error(error: impl std::fmt::Display) -> PluginError {
    PluginError::registry(error.to_string())
}

pub(crate) async fn gc_runtime_locks(
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
    Ok(())
}

pub(crate) fn external_runtime_target() -> String {
    "external".to_owned()
}

pub(crate) fn external_runtime_ownership() -> String {
    "external".to_owned()
}

pub(crate) type RuntimeArtifactKey = (String, String, String, String);

pub(crate) fn package_digest(package: &PluginPackage) -> Result<String, PluginError> {
    crate::package_content_digest(package.content_root())
}

pub(crate) fn source_kind_key(kind: crate::PluginSourceKind) -> &'static str {
    match kind {
        crate::PluginSourceKind::Builtin => "builtin",
        crate::PluginSourceKind::Snapshot => "snapshot",
        crate::PluginSourceKind::Marketplace => "marketplace",
        crate::PluginSourceKind::DeveloperLink => "developer_link",
        crate::PluginSourceKind::CodexNative => "codex_native",
        crate::PluginSourceKind::ClaudeCodeNative => "claude_code_native",
    }
}

pub(crate) fn contribution_kind_key(kind: crate::ContributionKind) -> &'static str {
    kind.key()
}

pub(crate) fn package_publisher(package: &PluginPackage) -> &str {
    package.publisher.as_deref().unwrap_or("legacy.local")
}

pub(crate) fn plugin_dependencies(package: &PluginPackage) -> Vec<crate::PluginDependency> {
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

#[cfg(test)]
mod behavior_snapshot;

#[cfg(test)]
mod system_bundle_command_tests {

    use std::sync::Arc;

    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn control_plane_exposes_locked_system_bundle_manifests_and_routes_commands() {
        let registry = Arc::new(InMemoryPluginRegistry::default());
        let plane = PluginControlPlane::new(registry);

        let manifests = plane.system_bundle_manifests();
        assert!(manifests.len() >= 18);
        for manifest in manifests {
            assert_eq!(manifest.bundle, "system");
            assert!(manifest.locked);
            assert!(!manifest.commands.is_empty());
            assert!(is_system_bundle_plugin_id(manifest.id));
        }

        assert_eq!(
            resolve_system_bundle_domain_command("vibex.core.workspace-git", "project_list"),
            Some("get_projects")
        );
        assert_eq!(
            resolve_system_bundle_domain_command("vibex.core.workspace-git", "branches"),
            Some("get_repo_branches")
        );
        assert_eq!(
            resolve_system_bundle_domain_command("vibex.core.automation", "list"),
            Some("automation_list")
        );
        assert_eq!(
            resolve_system_bundle_domain_command("vibex.core.session", "detail"),
            Some("conversation_detail")
        );
        assert_eq!(
            resolve_system_bundle_domain_command("vibex.core.skills", "list"),
            Some("list_agent_skills")
        );
        assert_eq!(
            resolve_system_bundle_domain_command("vibex.core.agent-runtime", "management_bar"),
            Some("agent_management_bar")
        );
        assert_eq!(
            resolve_system_bundle_domain_command("vibex.core.channels", "get_webhooks"),
            Some("get_chat_event_webhooks")
        );

        let resolved = plane
            .resolve_dynamic_command_target("vibex.core.workspace-git.project_list")
            .await
            .expect("resolve");
        assert_eq!(
            resolved,
            Some((
                "vibex.core.workspace-git".to_owned(),
                "project_list".to_owned()
            ))
        );

        plane
            .register_command_fn(
                "vibex.core.workspace-git",
                "project_list",
                |plugin_id, command, input| async move {
                    Ok(json!({
                        "pluginId": plugin_id,
                        "command": command,
                        "canonical": resolve_system_bundle_domain_command(&plugin_id, &command),
                        "input": input,
                    }))
                },
            )
            .expect("register handler");

        let response = plane
            .invoke_plugin_command("vibex.core.workspace-git", "project_list", json!({}))
            .await
            .expect("invoke system bundle command");
        assert_eq!(response["pluginId"], json!("vibex.core.workspace-git"));
        assert_eq!(response["canonical"], json!("get_projects"));
    }
}
