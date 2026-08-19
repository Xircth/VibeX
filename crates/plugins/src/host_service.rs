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
        .manifest
        .get("integrations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let object = value.as_object()?;
            if object.get("kind").and_then(Value::as_str) != Some("host.service") {
                return None;
            }
            let handler = object.get("handler")?.as_str()?.to_owned();
            let seconds = object
                .get("intervalSeconds")
                .or_else(|| object.get("schedule"))
                .and_then(|value| {
                    value
                        .as_u64()
                        .or_else(|| value.get("seconds").and_then(Value::as_u64))
                })
                .unwrap_or(30)
                .max(5);
            Some(HostServiceSpec { handler, seconds })
        })
        .take(8)
        .collect()
}
