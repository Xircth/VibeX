use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use serde_json::Value;
use tokio::sync::RwLock;

use crate::{
    CapabilityBroker, CapabilityGrant, PluginPackage, SharedNodeWorkerHost, WorkerActivation,
    WorkerHost, WorkerHostError,
};

/// Owns candidate-first Worker generations. A candidate is invisible until
/// spawn, handshake, and registration validation all succeed.
///
/// Tier-0/Tier-1 plugins (no `entrypoints.worker`) record lightweight
/// activation metadata with zero OS subprocesses. Tier-2 Node plugins share a
/// single on-demand `SharedNodeWorkerHost` OS process.
#[derive(Default)]
pub struct ActivationManager {
    next_generation: AtomicU64,
    active: RwLock<BTreeMap<String, Arc<WorkerHost>>>,
    draining: Arc<RwLock<BTreeMap<String, Vec<Arc<WorkerHost>>>>>,
    shared_node: Arc<SharedNodeWorkerHost>,
}

#[derive(Clone)]
pub struct ActivationLease {
    host: Arc<WorkerHost>,
}

pub struct PreparedActivation {
    plugin_id: String,
    host: Arc<WorkerHost>,
}

pub(crate) struct GenerationDrain {
    pub generation: u64,
    completion: tokio::task::JoinHandle<()>,
}

impl GenerationDrain {
    pub async fn wait(self) {
        let _ = self.completion.await;
    }
}

impl PreparedActivation {
    pub fn activation(&self) -> &WorkerActivation {
        self.host.activation()
    }

    pub async fn pid(&self) -> Option<u32> {
        self.host.pid().await
    }

    pub async fn discard(self, reason: &str) -> Result<(), WorkerHostError> {
        self.host.dispose(reason).await
    }
}

impl ActivationLease {
    pub fn activation(&self) -> &WorkerActivation {
        self.host.activation()
    }

    pub async fn pid(&self) -> Option<u32> {
        self.host.pid().await
    }

    pub fn is_shared_node_process(&self) -> bool {
        self.host.is_shared_node_process()
    }

    pub fn is_lightweight(&self) -> bool {
        self.host.is_lightweight()
    }

    pub async fn is_terminal(&self) -> bool {
        self.host.is_terminal().await
    }

    pub async fn invoke(&self, handler: &str, input: Value) -> Result<Value, WorkerHostError> {
        self.host.invoke(handler, input).await
    }

    pub async fn invoke_slot(&self, handler: &str, input: Value) -> Result<Value, WorkerHostError> {
        self.host.invoke(handler, input).await
    }

    pub async fn invoke_with_timeout(
        &self,
        handler: &str,
        input: Value,
        request_timeout: std::time::Duration,
    ) -> Result<Value, WorkerHostError> {
        self.host
            .invoke_with_timeout(handler, input, request_timeout)
            .await
    }
}

impl ActivationManager {
    pub fn shared_node_host(&self) -> Arc<SharedNodeWorkerHost> {
        Arc::clone(&self.shared_node)
    }

    /// Total OS worker subprocesses currently alive for this manager.
    ///
    /// - 0 when only Tier-0/Tier-1 plugins are active or when all Tier-2
    ///   workers are idle/disabled.
    /// - 1 when one or more Tier-2 Node plugins are active in the shared runner
    ///   (plus any dedicated native/Python worker processes).
    pub async fn active_worker_process_count(&self) -> usize {
        let shared = usize::from(self.shared_node.is_running().await);
        let active_dedicated = self
            .active
            .read()
            .await
            .values()
            .filter(|host| host.is_dedicated_process())
            .count();
        let draining_dedicated = self
            .draining
            .read()
            .await
            .values()
            .flat_map(|list| list.iter())
            .filter(|host| host.is_dedicated_process())
            .count();
        shared + active_dedicated + draining_dedicated
    }

    /// OS PID of the shared Node worker runner, if currently running.
    pub async fn shared_node_worker_pid(&self) -> Option<u32> {
        self.shared_node.pid().await
    }

    pub async fn activate_candidate(
        &self,
        node_executable: &Path,
        package: &PluginPackage,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<WorkerActivation, WorkerHostError> {
        let prepared = self
            .prepare_candidate(node_executable, package, grants, broker)
            .await?;
        let activation = prepared.activation().clone();
        let _ = self.commit(prepared).await;
        Ok(activation)
    }

    pub async fn prepare_candidate(
        &self,
        node_executable: &Path,
        package: &PluginPackage,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<PreparedActivation, WorkerHostError> {
        let generation = self
            .next_generation
            .fetch_add(1, Ordering::SeqCst)
            .saturating_add(1);
        self.prepare_candidate_at(generation, node_executable, package, grants, broker)
            .await
    }

    pub fn prepare_lightweight_candidate_at(
        &self,
        generation: u64,
        package: &PluginPackage,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<PreparedActivation, WorkerHostError> {
        self.next_generation.fetch_max(generation, Ordering::SeqCst);
        let candidate = Arc::new(WorkerHost::spawn_lightweight(
            package, generation, grants, broker,
        )?);
        Ok(PreparedActivation {
            plugin_id: package.id.as_str().to_owned(),
            host: candidate,
        })
    }

    pub async fn prepare_candidate_at(
        &self,
        generation: u64,
        node_executable: &Path,
        package: &PluginPackage,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<PreparedActivation, WorkerHostError> {
        self.next_generation.fetch_max(generation, Ordering::SeqCst);
        let candidate = if package.entrypoints.worker.is_none() {
            Arc::new(WorkerHost::spawn_lightweight(
                package, generation, grants, broker,
            )?)
        } else {
            let runtime = package
                .entrypoints
                .worker_runtime
                .as_deref()
                .unwrap_or("node");
            if runtime == "node" {
                Arc::new(
                    WorkerHost::spawn_in_shared_node(
                        Arc::clone(&self.shared_node),
                        node_executable,
                        package,
                        generation,
                        grants,
                        broker,
                    )
                    .await?,
                )
            } else {
                Arc::new(
                    WorkerHost::spawn(node_executable, package, generation, grants, broker).await?,
                )
            }
        };
        Ok(PreparedActivation {
            plugin_id: package.id.as_str().to_owned(),
            host: candidate,
        })
    }

    pub(crate) async fn commit(&self, prepared: PreparedActivation) -> Option<GenerationDrain> {
        let plugin_id = prepared.plugin_id;
        let previous = self
            .active
            .write()
            .await
            .insert(plugin_id.clone(), prepared.host);
        if let Some(previous) = previous {
            let generation = previous.activation().generation;
            self.draining
                .write()
                .await
                .entry(plugin_id.clone())
                .or_default()
                .push(Arc::clone(&previous));
            let draining_map = Arc::clone(&self.draining);
            let completion = tokio::spawn(async move {
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
                // 2 strong refs exist while draining_map + this task hold `previous`;
                // external ActivationLeases make strong_count > 2.
                while Arc::strong_count(&previous) > 2 && tokio::time::Instant::now() < deadline {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                let _ = previous.dispose("generation replaced").await;
                let mut map = draining_map.write().await;
                if let Some(list) = map.get_mut(&plugin_id) {
                    list.retain(|item| item.activation().generation != generation);
                    if list.is_empty() {
                        map.remove(&plugin_id);
                    }
                }
            });
            Some(GenerationDrain {
                generation,
                completion,
            })
        } else {
            None
        }
    }

    pub async fn running_plugin_ids(&self) -> Vec<String> {
        self.active.read().await.keys().cloned().collect()
    }

    pub async fn idle_elapsed(&self, plugin_id: &str) -> Option<std::time::Duration> {
        self.active
            .read()
            .await
            .get(plugin_id)
            .map(|host| host.idle_elapsed())
    }

    pub async fn lease(&self, plugin_id: &str) -> Option<ActivationLease> {
        self.active
            .read()
            .await
            .get(plugin_id)
            .cloned()
            .map(|host| ActivationLease { host })
    }

    pub async fn deactivate(&self, plugin_id: &str) -> Result<bool, WorkerHostError> {
        let previous = self.active.write().await.remove(plugin_id);
        let draining = self
            .draining
            .write()
            .await
            .remove(plugin_id)
            .unwrap_or_default();
        for old in draining {
            let _ = old.dispose("plugin disabled").await;
        }
        if let Some(previous) = previous {
            previous.dispose("plugin disabled").await?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}
