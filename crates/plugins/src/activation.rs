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
    CapabilityBroker, CapabilityGrant, PluginPackage, WorkerActivation, WorkerHost, WorkerHostError,
};

/// Owns candidate-first Worker generations. A candidate is invisible until
/// spawn, handshake, and registration validation all succeed.
#[derive(Default)]
pub struct ActivationManager {
    next_generation: AtomicU64,
    active: RwLock<BTreeMap<String, Arc<WorkerHost>>>,
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

    pub async fn discard(self, reason: &str) -> Result<(), WorkerHostError> {
        self.host.dispose(reason).await
    }
}

impl ActivationLease {
    pub fn activation(&self) -> &WorkerActivation {
        self.host.activation()
    }

    pub async fn invoke(&self, handler: &str, input: Value) -> Result<Value, WorkerHostError> {
        self.host.invoke(handler, input).await
    }
}

impl ActivationManager {
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

    pub async fn prepare_candidate_at(
        &self,
        generation: u64,
        node_executable: &Path,
        package: &PluginPackage,
        grants: &[CapabilityGrant],
        broker: Arc<dyn CapabilityBroker>,
    ) -> Result<PreparedActivation, WorkerHostError> {
        self.next_generation.fetch_max(generation, Ordering::SeqCst);
        let candidate = Arc::new(
            WorkerHost::spawn(node_executable, package, generation, grants, broker).await?,
        );
        Ok(PreparedActivation {
            plugin_id: package.id.as_str().to_owned(),
            host: candidate,
        })
    }

    pub(crate) async fn commit(&self, prepared: PreparedActivation) -> Option<GenerationDrain> {
        let previous = self
            .active
            .write()
            .await
            .insert(prepared.plugin_id, prepared.host);
        previous.map(|previous| {
            let generation = previous.activation().generation;
            let completion = tokio::spawn(async move {
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
                while Arc::strong_count(&previous) > 1 && tokio::time::Instant::now() < deadline {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                let _ = previous.dispose("generation replaced").await;
            });
            GenerationDrain {
                generation,
                completion,
            }
        })
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
        if let Some(previous) = previous {
            previous.dispose("plugin disabled").await?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}
