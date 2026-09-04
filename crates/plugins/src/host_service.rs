//! One Worker process serves every `host.service` handler for a plugin.

use std::{collections::HashMap, sync::Mutex, time::Duration};

use serde_json::Value;
use tokio::task::JoinHandle;

use crate::{ActivationLease, PluginPackage};

pub struct HostServiceSupervisor {
    tasks: Mutex<HashMap<String, Vec<JoinHandle<()>>>>,
}

impl Default for HostServiceSupervisor {
    fn default() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
        }
    }
}

impl HostServiceSupervisor {
    pub fn start(&self, plugin_id: &str, lease: ActivationLease, package: &PluginPackage) {
        let services = host_services(package);
        self.stop(plugin_id);
        if services.is_empty() {
            return;
        }
        let handles = services
            .into_iter()
            .map(|service| {
                let lease = lease.clone();
                tokio::spawn(async move {
                    let mut interval = tokio::time::interval(Duration::from_secs(service.seconds));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    let busy = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                    loop {
                        interval.tick().await;
                        if busy.swap(true, std::sync::atomic::Ordering::SeqCst) {
                            continue;
                        }
                        let _ = lease.invoke(&service.handler, Value::Null).await;
                        busy.store(false, std::sync::atomic::Ordering::SeqCst);
                    }
                })
            })
            .collect();
        self.tasks
            .lock()
            .unwrap()
            .insert(plugin_id.to_owned(), handles);
    }

    pub fn stop(&self, plugin_id: &str) {
        if let Some(handles) = self.tasks.lock().unwrap().remove(plugin_id) {
            for handle in handles {
                handle.abort();
            }
        }
    }
}

struct HostServiceSpec {
    handler: String,
    seconds: u64,
}

fn host_services(package: &PluginPackage) -> Vec<HostServiceSpec> {
    package
        .app
        .host_services
        .iter()
        .map(|service| HostServiceSpec {
            handler: service.handler.clone(),
            seconds: service.interval_seconds,
        })
        .take(8)
        .collect()
}
