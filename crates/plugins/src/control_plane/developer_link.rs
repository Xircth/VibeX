use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use super::*;
use crate::{PluginActivation, PluginError};

impl PluginControlPlane {
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

    pub(super) async fn activate_discovered_user_plugin(
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
                if existing.activation == PluginActivation::Enabled {
                    let restore = self.worker_restore.read().await.clone();
                    if let Some(restore) =
                        restore.filter(|restore| !restore.candidate_root.as_os_str().is_empty())
                    {
                        let mut candidate = package.clone();
                        if candidate
                            .freeze_execution_root(&restore.candidate_root, &digest)
                            .is_err()
                        {
                            continue;
                        }
                        let Ok(grants) = candidate_capability_grants(&candidate, &[], &[]) else {
                            continue;
                        };
                        if self
                            .update_and_activate(
                                &restore.node_executable,
                                candidate,
                                &grants,
                                restore.broker,
                            )
                            .await
                            .is_ok()
                        {
                            discovered.push(plugin_id);
                        }
                        continue;
                    }
                }
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

            let mut candidate = package.clone();
            if has_worker
                && let Ok(digest) = crate::package_content_digest(&path)
                && let Some(restore) = self
                    .worker_restore
                    .read()
                    .await
                    .clone()
                    .filter(|restore| !restore.candidate_root.as_os_str().is_empty())
            {
                let _ = candidate.freeze_execution_root(&restore.candidate_root, &digest);
            }
            if self
                .import(candidate.clone(), ConflictDecision::KeepInstalled)
                .await
                .is_ok()
            {
                self.activate_discovered_user_plugin(&candidate, &plugin_id, has_worker)
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

    pub async fn install_bundled_official_plugins(
        &self,
        data_root: &Path,
        _activation: Option<BundledPluginActivation>,
    ) -> Result<Vec<PathBuf>, PluginError> {
        let roots = utils::assets::existing_official_plugin_roots(data_root);
        self.retire_replaced_builtins().await?;
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
        self.retire_replaced_builtins().await?;
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

    pub(super) async fn reconcile_one_bundled_plugin(
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
}
