use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use super::*;
use crate::{
    ActivationLease, CapabilityBroker, PluginActivation, PluginError, PluginPackage,
    WorkerHostError,
};

impl PluginControlPlane {
    pub(super) async fn remember_worker_restore(
        &self,
        node_executable: &Path,
        broker: Arc<dyn crate::CapabilityBroker>,
    ) {
        let mut restore = self.worker_restore.write().await;
        let candidate_root = restore
            .as_ref()
            .map(|restore| restore.candidate_root.clone())
            .unwrap_or_default();
        *restore = Some(WorkerRestore {
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
}
