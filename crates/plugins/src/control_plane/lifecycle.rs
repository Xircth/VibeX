use std::sync::Arc;

use super::*;
use crate::{
    CapabilityBroker, CapabilityGrant, PluginActivation, PluginError, PluginPackage,
    WorkerHostError, contribution::descriptors_for_package,
};

impl PluginControlPlane {
    pub(super) async fn enable_deferred_worker(&self, plugin_id: &str) -> Result<(), PluginError> {
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

    pub async fn sync_official_product_mcp_gate(&self) -> Result<(), PluginError> {
        self.refresh_live_projections().await
    }

    pub(super) async fn plugin_is_live(&self, plugin_id: &str) -> Result<bool, PluginError> {
        Ok(self.registry.active_generation(plugin_id).await?.is_some())
    }

    pub(super) async fn refresh_live_projections(&self) -> Result<(), PluginError> {
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

    pub(super) async fn live_dependents(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<String>, PluginError> {
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

    pub(super) async fn withdraw_with_dependents(
        &self,
        plugin_id: &str,
    ) -> Result<(), PluginError> {
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

    pub(super) async fn remount_if_ready(&self, plugin_id: &str) -> Result<bool, PluginError> {
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

    pub(super) async fn reconcile_enabled(&self) -> Result<(), PluginError> {
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

    pub(super) async fn publish_live_generation(
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

    pub(super) fn retire_after_drain(
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

    /// The generation currently serving this plugin, if any.
    pub async fn active_generation(&self, plugin_id: &str) -> Option<u64> {
        self.registry
            .active_generation(plugin_id)
            .await
            .ok()
            .flatten()
    }

    pub(super) async fn ensure_plugin_dependencies(
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

    pub(super) async fn require_plugin_dependencies(
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

    pub async fn rollback_available(&self, plugin_id: &str) -> Result<bool, PluginError> {
        Ok(self.registry.rollback_package(plugin_id).await?.is_some())
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
            crate::clear_plugin_crashes(plugin_id);
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
        crate::clear_plugin_crashes(plugin_id);
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
}
