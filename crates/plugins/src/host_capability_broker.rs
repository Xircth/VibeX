use std::{collections::HashMap, process::Stdio, sync::Arc, time::Duration};

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::{
    io::AsyncWriteExt,
    process::Command,
    sync::Mutex,
    time::{Instant, timeout},
};

const ARTIFACT_HANDLE_TTL: Duration = Duration::from_secs(30);

struct ArtifactAuthorization {
    plugin_id: String,
    generation: u64,
    request: crate::PluginPreviewRequest,
    expires_at: Instant,
}

pub struct HostCapabilityBroker {
    plugins: Arc<crate::PluginControlPlane>,
    previews: Arc<dyn crate::PluginPreviewHost>,
    artifacts: Mutex<HashMap<String, ArtifactAuthorization>>,
    preview_leases: Arc<Mutex<HashMap<String, crate::ActivationLease>>>,
}

impl HostCapabilityBroker {
    pub fn new(
        plugins: Arc<crate::PluginControlPlane>,
        previews: Arc<dyn crate::PluginPreviewHost>,
    ) -> Self {
        Self {
            plugins,
            previews,
            artifacts: Mutex::new(HashMap::new()),
            preview_leases: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Issues a short-lived, one-shot authorization for one concrete Artifact.
    /// The Worker never receives the underlying path and cannot mint a handle.
    pub async fn issue_artifact_handle(
        &self,
        plugin_id: &str,
        generation: u64,
        request: crate::PluginPreviewRequest,
    ) -> Result<String, crate::WorkerHostError> {
        if request.plugin_id != plugin_id {
            return Err(broker_error(
                "artifact_identity_mismatch",
                "Artifact request does not belong to the activated plugin",
            ));
        }
        let handle = uuid::Uuid::new_v4().to_string();
        let now = Instant::now();
        let mut artifacts = self.artifacts.lock().await;
        artifacts.retain(|_, authorization| authorization.expires_at > now);
        artifacts.insert(
            handle.clone(),
            ArtifactAuthorization {
                plugin_id: plugin_id.to_owned(),
                generation,
                request,
                expires_at: now + ARTIFACT_HANDLE_TTL,
            },
        );
        Ok(handle)
    }

    pub async fn revoke_artifact_handle(&self, handle: &str) {
        self.artifacts.lock().await.remove(handle);
    }

    pub async fn close_preview(
        &self,
        file_path: &str,
        lease_id: Option<&str>,
    ) -> Result<(), crate::PluginPreviewHostError> {
        let result = self.previews.close_preview(file_path, lease_id).await;
        if let Some(lease_id) = lease_id {
            self.preview_leases.lock().await.remove(lease_id);
        }
        result
    }
}

#[async_trait]
impl crate::CapabilityBroker for HostCapabilityBroker {
    fn supports(&self, capability: &str) -> bool {
        matches!(
            capability,
            "runtime.execute"
                | "artifact.preview"
                | "artifact"
                | "storage"
                | "secrets"
                | "files"
                | "network"
                | "log"
                | "events"
                | "agent"
                | "conversation"
                | "app"
                | "plugin.self"
        )
    }

    async fn call(
        &self,
        plugin_id: &str,
        generation: u64,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        match capability {
            "runtime.execute" => {
                self.execute_runtime(plugin_id, generation, operation, input)
                    .await
            }
            "artifact.preview" => self.open_preview(plugin_id, generation, input).await,
            "artifact" if operation == "readText" || operation == "writeText" => Err(broker_error(
                "artifact_not_found",
                "Artifact text is only available on an editor surface session",
            )),
            "log" => Ok(json!({})),
            "plugin.self" if operation == "doctor" => Ok(json!({
                "pluginId": plugin_id,
                "generation": generation,
                "diagnostics": [],
                "recentCrashes": [],
            })),
            "storage" | "secrets" | "files" | "network" | "events" | "agent" | "conversation"
            | "app" => self.call_plugin_data(plugin_id, generation, capability, operation, input),
            _ => Err(broker_error(
                "capability_unimplemented",
                format!("{capability}.{operation} is not exposed by the Host capability broker"),
            )),
        }
    }
}

impl HostCapabilityBroker {
    async fn execute_runtime(
        &self,
        plugin_id: &str,
        generation: u64,
        operation: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        let runtime_id = input
            .get("runtimeId")
            .and_then(Value::as_str)
            .ok_or_else(|| broker_error("runtime_identity_missing", "runtimeId is required"))?;
        let runtime = self
            .plugins
            .runtime_for_generation(plugin_id, generation, runtime_id)
            .await
            .map_err(|error| broker_error("runtime_lock_failed", error))?
            .ok_or_else(|| broker_error("runtime_not_locked", "Runtime lock is missing"))?;
        let mut child = Command::new(&runtime.executable_path)
            .arg(operation)
            .arg("--json")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| broker_error("runtime_spawn_failed", error))?;
        let document = serde_json::to_vec(&input)
            .map_err(|error| broker_error("runtime_input_invalid", error))?;
        if document.len() > 1024 * 1024 {
            return Err(broker_error(
                "runtime_input_too_large",
                "Runtime input exceeds 1 MiB",
            ));
        }
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(&document)
                .await
                .map_err(|error| broker_error("runtime_stdin_failed", error))?;
        }
        let output = timeout(Duration::from_secs(120), child.wait_with_output())
            .await
            .map_err(|_| broker_error("runtime_timeout", "Runtime execution timed out"))?
            .map_err(|error| broker_error("runtime_failed", error))?;
        if output.stdout.len() > 4 * 1024 * 1024 || output.stderr.len() > 256 * 1024 {
            return Err(broker_error(
                "runtime_output_too_large",
                "Runtime output exceeds the Host limit",
            ));
        }
        if !output.status.success() {
            return Err(broker_error(
                "runtime_exit_failed",
                String::from_utf8_lossy(&output.stderr),
            ));
        }
        serde_json::from_slice(&output.stdout).or_else(|_| {
            Ok(json!({
                "stdout": String::from_utf8_lossy(&output.stdout),
                "exitCode": output.status.code(),
            }))
        })
    }

    async fn open_preview(
        &self,
        plugin_id: &str,
        generation: u64,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        let handle = input
            .get("artifactHandle")
            .and_then(Value::as_str)
            .ok_or_else(|| broker_error("artifact_handle_missing", "artifactHandle is required"))?;
        let provider_id = input
            .get("providerId")
            .and_then(Value::as_str)
            .ok_or_else(|| broker_error("provider_missing", "providerId is required"))?;
        // Consume before validation so a guessed or replayed handle never gets a
        // second chance after crossing the Worker boundary.
        let authorization =
            self.artifacts.lock().await.remove(handle).ok_or_else(|| {
                broker_error("artifact_handle_invalid", "Artifact handle is invalid")
            })?;
        if authorization.expires_at <= Instant::now() {
            return Err(broker_error(
                "artifact_handle_expired",
                "Artifact handle has expired",
            ));
        }
        if authorization.plugin_id != plugin_id || authorization.generation != generation {
            return Err(broker_error(
                "artifact_handle_scope_mismatch",
                "Artifact handle does not belong to this activation generation",
            ));
        }
        if authorization.request.provider_id != provider_id {
            return Err(broker_error(
                "artifact_provider_mismatch",
                "Artifact handle does not authorize this preview provider",
            ));
        }
        let lease = self
            .previews
            .open_preview(authorization.request)
            .await
            .map_err(|error| broker_error("preview_failed", error))?;
        let activation_lease = self
            .plugins
            .activation_lease(plugin_id)
            .await
            .filter(|active| active.activation().generation == generation)
            .ok_or_else(|| {
                broker_error("generation_stale", "Preview generation is no longer active")
            })?;
        self.preview_leases
            .lock()
            .await
            .insert(lease.lease_id.clone(), activation_lease);
        let preview_leases = self.preview_leases.clone();
        let lease_id = lease.lease_id.clone();
        let delay =
            Duration::from_millis(lease.expires_at_unix_ms.saturating_sub(unix_time_millis()));
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            preview_leases.lock().await.remove(&lease_id);
        });
        Ok(json!({
            "leaseId": lease.lease_id,
            "port": lease.loopback_port,
            "capabilityToken": lease.capability_token,
            "expiresAtUnixMs": lease.expires_at_unix_ms,
        }))
    }

    fn call_plugin_data(
        &self,
        plugin_id: &str,
        _generation: u64,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        let key = format!("{capability}.{operation}");
        match key.as_str() {
            "storage.kv.get" => {
                let name = input
                    .get("key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| broker_error("kv_key_missing", "key is required"))?;
                Ok(plugin_kv(plugin_id).get(name).unwrap_or(Value::Null))
            }
            "storage.kv.put" => {
                let name = input
                    .get("key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| broker_error("kv_key_missing", "key is required"))?;
                let value = input.get("value").cloned().unwrap_or(Value::Null);
                plugin_kv(plugin_id).insert(name.to_owned(), value.clone());
                Ok(value)
            }
            "storage.kv.delete" => {
                if let Some(name) = input.get("key").and_then(Value::as_str) {
                    plugin_kv(plugin_id).remove(name);
                }
                Ok(json!({}))
            }
            "storage.kv.list" => Ok(Value::Array(
                plugin_kv(plugin_id)
                    .keys()
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            )),
            "storage.settings.get" | "storage.settings.put" => Ok(input),
            "secrets.get" => Ok(json!({ "present": false })),
            "secrets.put" | "secrets.delete" => Ok(json!({ "present": false })),
            "network.fetch" => Err(broker_error(
                "network_denied",
                "Use the language runtime for Full Trust network access; Isolated packages require v5 grant",
            )),
            "files.read" | "files.write" | "files.stat" | "files.list" => Err(broker_error(
                "files_root_denied",
                "File roots are bound to workspace and plugin-data sessions",
            )),
            "events.subscribe" => Ok(json!({ "cursor": 0 })),
            "events.ack" => Ok(json!({})),
            "agent.invoke" => Err(broker_error(
                "handler_not_visible",
                "Cross-plugin handlers are not visible",
            )),
            "conversation.read.get" | "conversation.append.enqueueInput" => Err(broker_error(
                "conversation_scope_denied",
                "No conversation is bound to this Worker",
            )),
            "app.notify.toast" => Ok(json!({})),
            _ => Err(broker_error(
                "capability_unimplemented",
                format!("{key} is not implemented"),
            )),
        }
    }
}

fn plugin_kv(plugin_id: &str) -> PluginKv {
    PluginKv {
        plugin_id: plugin_id.to_owned(),
    }
}

struct PluginKv {
    plugin_id: String,
}

impl PluginKv {
    fn store() -> std::sync::MutexGuard<'static, std::collections::HashMap<String, Value>> {
        use std::{
            collections::HashMap,
            sync::{Mutex, OnceLock},
        };
        static STORE: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
        STORE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
    }

    fn namespaced(&self, key: &str) -> String {
        format!("{}::{key}", self.plugin_id)
    }

    fn get(&self, key: &str) -> Option<Value> {
        Self::store().get(&self.namespaced(key)).cloned()
    }

    fn insert(&self, key: String, value: Value) {
        Self::store().insert(self.namespaced(&key), value);
    }

    fn remove(&self, key: &str) {
        Self::store().remove(&self.namespaced(key));
    }

    fn keys(&self) -> Vec<String> {
        let prefix = format!("{}::", self.plugin_id);
        Self::store()
            .keys()
            .filter_map(|key| key.strip_prefix(&prefix).map(str::to_owned))
            .collect()
    }
}

fn unix_time_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn broker_error(code: &'static str, message: impl std::fmt::Display) -> crate::WorkerHostError {
    crate::WorkerHostError::broker(code, message)
}
