use std::{
    collections::HashMap,
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::AsyncWriteExt,
    process::Command,
    sync::{Mutex, broadcast},
    time::{Instant, timeout},
};

const ARTIFACT_HANDLE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginToastNotification {
    pub plugin_id: String,
    pub title: String,
    pub message: String,
    pub variant: String,
    pub duration_ms: u64,
}

static PLUGIN_TOAST_TX: OnceLock<broadcast::Sender<PluginToastNotification>> = OnceLock::new();

fn plugin_toast_sender() -> &'static broadcast::Sender<PluginToastNotification> {
    PLUGIN_TOAST_TX.get_or_init(|| {
        let (tx, _) = broadcast::channel(128);
        tx
    })
}

pub fn subscribe_plugin_toasts() -> broadcast::Receiver<PluginToastNotification> {
    plugin_toast_sender().subscribe()
}

struct ArtifactAuthorization {
    plugin_id: String,
    generation: u64,
    request: crate::PluginPreviewRequest,
    expires_at: Instant,
}

struct SpawnedPluginProcess {
    plugin_id: String,
    pid: Option<u32>,
    child: tokio::process::Child,
}

#[async_trait]
pub trait AgentInvocationHandler: Send + Sync {
    fn is_visible_to(&self, caller_plugin_id: &str) -> bool {
        let _ = caller_plugin_id;
        true
    }

    async fn invoke(
        &self,
        caller_plugin_id: &str,
        handler_id: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError>;
}

struct FnAgentInvocationHandler<F> {
    visible_to: Option<std::collections::HashSet<String>>,
    callback: F,
}

#[async_trait]
impl<F, Fut> AgentInvocationHandler for FnAgentInvocationHandler<F>
where
    F: Fn(String, String, Value) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<Value, crate::WorkerHostError>> + Send + 'static,
{
    fn is_visible_to(&self, caller_plugin_id: &str) -> bool {
        self.visible_to
            .as_ref()
            .is_none_or(|allowed| allowed.contains(caller_plugin_id) || allowed.contains("*"))
    }

    async fn invoke(
        &self,
        caller_plugin_id: &str,
        handler_id: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        (self.callback)(caller_plugin_id.to_owned(), handler_id.to_owned(), input).await
    }
}

struct RegisteredAgentHandler {
    handler: Arc<dyn AgentInvocationHandler>,
    allowed_plugins: Option<std::collections::HashSet<String>>,
}

struct PreviewLeaseEntry {
    _lease: crate::ActivationLease,
    expiry_abort: Option<tokio::task::AbortHandle>,
}

pub struct HostCapabilityBroker {
    plugins: Arc<crate::PluginControlPlane>,
    previews: Arc<dyn crate::PluginPreviewHost>,
    provider_presets: Arc<dyn crate::ProviderPresetHost>,
    remote_profiles: Arc<dyn crate::RemoteProfileHost>,
    bind_prompts: Arc<crate::ProviderBindPrompts>,
    conversations: Arc<dyn crate::PluginConversationHost>,
    collaboration: Arc<dyn crate::CollaborationHost>,
    browser: Arc<browser_host::BrowserService>,
    http_client: reqwest::Client,
    settings_saved: std::sync::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    artifacts: Mutex<HashMap<String, ArtifactAuthorization>>,
    preview_leases: Arc<Mutex<HashMap<String, PreviewLeaseEntry>>>,
    spawned_processes: Mutex<HashMap<String, SpawnedPluginProcess>>,
    capability_grants: Mutex<HashMap<String, Vec<crate::HostCapabilityGrant>>>,
    agent_handlers: Mutex<HashMap<String, RegisteredAgentHandler>>,
    workspace_root: std::sync::RwLock<Option<std::path::PathBuf>>,
    plugin_data_root: std::sync::RwLock<Option<std::path::PathBuf>>,
}

impl HostCapabilityBroker {
    pub fn new(
        plugins: Arc<crate::PluginControlPlane>,
        previews: Arc<dyn crate::PluginPreviewHost>,
    ) -> Self {
        Self::with_provider_presets(
            plugins,
            previews,
            Arc::new(crate::UnavailableProviderPresetHost),
        )
    }

    pub fn with_provider_presets(
        plugins: Arc<crate::PluginControlPlane>,
        previews: Arc<dyn crate::PluginPreviewHost>,
        provider_presets: Arc<dyn crate::ProviderPresetHost>,
    ) -> Self {
        Self::with_hosts(
            plugins,
            previews,
            provider_presets,
            Arc::new(crate::UnavailableRemoteProfileHost),
        )
    }

    pub fn with_hosts(
        plugins: Arc<crate::PluginControlPlane>,
        previews: Arc<dyn crate::PluginPreviewHost>,
        provider_presets: Arc<dyn crate::ProviderPresetHost>,
        remote_profiles: Arc<dyn crate::RemoteProfileHost>,
    ) -> Self {
        Self::with_hosts_and_prompts(
            plugins,
            previews,
            provider_presets,
            remote_profiles,
            Arc::new(crate::ProviderBindPrompts::default()),
        )
    }

    pub fn with_hosts_and_prompts(
        plugins: Arc<crate::PluginControlPlane>,
        previews: Arc<dyn crate::PluginPreviewHost>,
        provider_presets: Arc<dyn crate::ProviderPresetHost>,
        remote_profiles: Arc<dyn crate::RemoteProfileHost>,
        bind_prompts: Arc<crate::ProviderBindPrompts>,
    ) -> Self {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let http_client = reqwest::Client::builder()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            plugins,
            previews,
            provider_presets,
            remote_profiles,
            bind_prompts,
            conversations: Arc::new(crate::UnavailablePluginConversationHost),
            collaboration: Arc::new(crate::UnavailableCollaborationHost),
            browser: Arc::new(browser_host::BrowserService::unavailable()),
            http_client,
            settings_saved: std::sync::Mutex::new(None),
            artifacts: Mutex::new(HashMap::new()),
            preview_leases: Arc::new(Mutex::new(HashMap::new())),
            spawned_processes: Mutex::new(HashMap::new()),
            capability_grants: Mutex::new(HashMap::new()),
            agent_handlers: Mutex::new(HashMap::new()),
            workspace_root: std::sync::RwLock::new(None),
            plugin_data_root: std::sync::RwLock::new(None),
        }
    }

    pub fn set_workspace_root(&self, root: impl Into<std::path::PathBuf>) {
        if let Ok(mut guard) = self.workspace_root.write() {
            *guard = Some(root.into());
        }
    }

    pub fn set_plugin_data_root(&self, root: impl Into<std::path::PathBuf>) {
        if let Ok(mut guard) = self.plugin_data_root.write() {
            *guard = Some(root.into());
        }
    }

    pub async fn grant_capability(
        &self,
        plugin_id: impl Into<String>,
        grant: crate::HostCapabilityGrant,
    ) {
        self.capability_grants
            .lock()
            .await
            .entry(plugin_id.into())
            .or_default()
            .push(grant);
    }

    pub async fn set_capability_grants(
        &self,
        plugin_id: impl Into<String>,
        grants: Vec<crate::HostCapabilityGrant>,
    ) {
        self.capability_grants
            .lock()
            .await
            .insert(plugin_id.into(), grants);
    }

    pub async fn register_agent_handler(
        &self,
        handler_id: impl Into<String>,
        handler: Arc<dyn AgentInvocationHandler>,
    ) {
        self.agent_handlers.lock().await.insert(
            handler_id.into(),
            RegisteredAgentHandler {
                handler,
                allowed_plugins: None,
            },
        );
    }

    pub async fn register_scoped_agent_handler<I, S>(
        &self,
        handler_id: impl Into<String>,
        allowed_plugins: I,
        handler: Arc<dyn AgentInvocationHandler>,
    ) where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.agent_handlers.lock().await.insert(
            handler_id.into(),
            RegisteredAgentHandler {
                handler,
                allowed_plugins: Some(allowed_plugins.into_iter().map(Into::into).collect()),
            },
        );
    }

    pub async fn register_agent_handler_fn<F, Fut>(
        &self,
        handler_id: impl Into<String>,
        visible_to: Option<Vec<String>>,
        callback: F,
    ) where
        F: Fn(String, String, Value) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<Value, crate::WorkerHostError>> + Send + 'static,
    {
        let visible_set = visible_to.map(|items| items.into_iter().collect());
        self.agent_handlers.lock().await.insert(
            handler_id.into(),
            RegisteredAgentHandler {
                handler: Arc::new(FnAgentInvocationHandler {
                    visible_to: visible_set.clone(),
                    callback,
                }),
                allowed_plugins: visible_set,
            },
        );
    }

    pub async fn unregister_agent_handler(&self, handler_id: &str) {
        self.agent_handlers.lock().await.remove(handler_id);
    }

    pub async fn publish_event(
        &self,
        topic: &str,
        event_type: &str,
        payload: &Value,
    ) -> Result<u64, crate::WorkerHostError> {
        self.plugins
            .publish_event(topic, event_type, payload)
            .await
            .map_err(|error| broker_error("events_publish_failed", error))
    }

    pub async fn kill_plugin_processes(&self, plugin_id: &str) -> usize {
        let mut processes = self.spawned_processes.lock().await;
        let ids: Vec<String> = processes
            .iter()
            .filter(|(_, proc)| proc.plugin_id == plugin_id)
            .map(|(id, _)| id.clone())
            .collect();
        let mut killed = 0usize;
        for id in ids {
            if let Some(mut proc) = processes.remove(&id) {
                let _ = proc.child.kill().await;
                killed += 1;
            }
        }
        killed
    }

    pub fn with_browser_host(mut self, browser: Arc<browser_host::BrowserService>) -> Self {
        self.browser = browser;
        self
    }

    pub fn with_conversation_host(
        mut self,
        conversations: Arc<dyn crate::PluginConversationHost>,
    ) -> Self {
        self.conversations = conversations;
        self
    }

    pub fn with_collaboration_host(
        mut self,
        collaboration: Arc<dyn crate::CollaborationHost>,
    ) -> Self {
        self.collaboration = collaboration;
        self
    }

    pub fn set_settings_saved_hook(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self
            .settings_saved
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::new(hook));
    }

    pub fn bind_prompts(&self) -> Arc<crate::ProviderBindPrompts> {
        Arc::clone(&self.bind_prompts)
    }

    pub fn resolve_provider_bind(&self, request_id: &str, approved: bool) -> bool {
        self.bind_prompts.answer(request_id, approved)
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
        if let Some(lease_id) = lease_id
            && let Some(entry) = self.preview_leases.lock().await.remove(lease_id)
            && let Some(abort) = entry.expiry_abort
        {
            abort.abort();
        }
        result
    }

    pub async fn renew_preview(
        &self,
        lease_id: &str,
    ) -> Result<crate::PluginPreviewSession, crate::PluginPreviewHostError> {
        let lease = self.previews.renew_preview(lease_id).await?;
        let mut preview_leases = self.preview_leases.lock().await;
        if let Some(entry) = preview_leases.get_mut(&lease.lease_id) {
            let abort = schedule_preview_lease_drop(
                self.preview_leases.clone(),
                lease.lease_id.clone(),
                lease.expires_at_unix_ms,
            );
            if let Some(prev) = entry.expiry_abort.replace(abort) {
                prev.abort();
            }
        }
        Ok(lease)
    }
}

#[async_trait]
impl crate::CapabilityBroker for HostCapabilityBroker {
    fn supports(&self, capability: &str) -> bool {
        matches!(
            capability,
            "runtime.execute"
                | "runtime.lock"
                | "exec"
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
                | "collaboration"
                | "workspace"
                | "browser"
                | "blob"
                | "app"
                | "plugin.self"
                | "provider.presets"
                | "remote"
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
            "runtime.lock" => {
                self.get_runtime_lock(plugin_id, generation, operation, input)
                    .await
            }
            "exec" => self.call_exec(plugin_id, operation, input).await,
            "artifact.preview" => self.open_preview(plugin_id, generation, input).await,
            "provider.presets" => {
                self.call_provider_presets(plugin_id, operation, input)
                    .await
            }
            "remote" => self.call_remote(plugin_id, operation, input).await,
            "conversation" => self.call_conversation(plugin_id, operation, input).await,
            "collaboration" | "workspace" => self
                .collaboration
                .call(plugin_id, capability, operation, input)
                .await
                .map_err(|error| broker_error(error.code(), error)),
            "browser" => browser_host::dispatch(&self.browser, plugin_id, operation, input)
                .await
                .map_err(|error| broker_error(error.code(), error.message())),
            "artifact" if operation == "readText" || operation == "writeText" => Err(broker_error(
                "artifact_not_found",
                "Artifact text is only available on an editor surface session",
            )),
            "blob" => crate::blob_store::dispatch_plugin_blob(plugin_id, operation, &input),
            "log" => Ok(json!({})),
            "plugin.self" => {
                self.call_plugin_self(plugin_id, generation, operation, input)
                    .await
            }
            "storage" | "secrets" | "files" | "network" | "events" | "agent" | "app" => {
                self.call_plugin_data(plugin_id, generation, capability, operation, input)
                    .await
            }
            _ => Err(broker_error(
                "capability_unimplemented",
                format!("{capability}.{operation} is not exposed by the Host capability broker"),
            )),
        }
    }
}

impl HostCapabilityBroker {
    async fn get_runtime_lock(
        &self,
        plugin_id: &str,
        generation: u64,
        operation: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        if operation != "get" {
            return Err(broker_error(
                "runtime_lock_operation_invalid",
                "runtime.lock only supports get",
            ));
        }
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
        Ok(json!({
            "executablePath": runtime.executable_path,
            "version": runtime.version,
            "target": runtime.target,
            "contentDigest": runtime.content_digest,
        }))
    }

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
        if document.len() > 16 * 1024 * 1024 {
            return Err(broker_error(
                "runtime_input_too_large",
                "Runtime input exceeds 16 MiB",
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
        if output.stdout.len() > 32 * 1024 * 1024 || output.stderr.len() > 1024 * 1024 {
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

    /// `list` and `save` touch only VibeX's own preset store. `bind` changes
    /// which endpoint an agent actually talks to, so it goes through the Host
    /// confirmation the seam contract requires and lands in the plugin audit
    /// either way — a decline is evidence too.
    async fn call_provider_presets(
        &self,
        plugin_id: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        match operation {
            "list" => {
                let agent_id = input.get("agentId").and_then(Value::as_str);
                let presets = self
                    .provider_presets
                    .list(agent_id)
                    .await
                    .map_err(preset_error)?;
                Ok(json!({ "presets": presets }))
            }
            "save" => {
                let draft: crate::ProviderPresetDraft = serde_json::from_value(input)
                    .map_err(|error| broker_error("provider_preset_invalid", error))?;
                if draft.name.trim().is_empty() {
                    return Err(broker_error(
                        "provider_preset_invalid",
                        "name must not be empty",
                    ));
                }
                if draft.agent_id.trim().is_empty() {
                    return Err(broker_error(
                        "provider_preset_invalid",
                        "agentId must not be empty",
                    ));
                }
                let saved = self
                    .provider_presets
                    .save(plugin_id, draft)
                    .await
                    .map_err(preset_error)?;
                self.audit(
                    plugin_id,
                    "provider_preset_saved",
                    json!({ "presetId": saved.id, "agentId": saved.agent_id }),
                )
                .await;
                Ok(serde_json::to_value(saved)
                    .map_err(|error| broker_error("provider_preset_invalid", error))?)
            }
            "bind" => {
                let request: crate::ProviderBindRequest = serde_json::from_value(input)
                    .map_err(|error| broker_error("provider_bind_invalid", error))?;
                if request.agent_id.trim().is_empty() {
                    return Err(broker_error(
                        "provider_bind_invalid",
                        "agentId must not be empty",
                    ));
                }
                let agent_id = request.agent_id.clone();
                let preset_id = request.preset_id.clone();
                let decision = self
                    .provider_presets
                    .bind(plugin_id, request)
                    .await
                    .map_err(preset_error)?;
                let confirmed = decision == crate::ProviderBindDecision::Applied;
                self.audit(
                    plugin_id,
                    "provider_preset_bind",
                    json!({
                        "agentId": agent_id,
                        "presetId": preset_id,
                        "confirmed": confirmed,
                    }),
                )
                .await;
                Ok(json!({ "confirmed": confirmed }))
            }
            _ => Err(broker_error(
                "capability_unimplemented",
                format!("provider.presets.{operation} is not implemented"),
            )),
        }
    }

    async fn call_remote(
        &self,
        plugin_id: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        match operation {
            "profile.list" => {
                let profiles = self.remote_profiles.list().await.map_err(remote_error)?;
                Ok(json!({ "profiles": profiles }))
            }
            "profile.upsert" => {
                let draft: crate::RemoteHostProfileDraft = serde_json::from_value(input)
                    .map_err(|error| broker_error("remote_profile_invalid", error))?;
                if draft.origin.trim().is_empty() {
                    return Err(broker_error(
                        "remote_profile_invalid",
                        "origin must not be empty",
                    ));
                }
                if draft.provision_kind.trim().is_empty() {
                    return Err(broker_error(
                        "remote_profile_invalid",
                        "provisionKind must not be empty",
                    ));
                }
                let saved = self
                    .remote_profiles
                    .upsert(plugin_id, draft)
                    .await
                    .map_err(remote_error)?;
                self.audit(
                    plugin_id,
                    "remote_profile_upserted",
                    json!({ "profileId": saved.id, "provisionKind": saved.provision_kind }),
                )
                .await;
                Ok(serde_json::to_value(saved)
                    .map_err(|error| broker_error("remote_profile_invalid", error))?)
            }
            "profile.forget" => {
                let profile_id = input
                    .get("profileId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        broker_error("remote_profile_invalid", "profileId is required")
                    })?;
                self.remote_profiles
                    .forget(plugin_id, profile_id)
                    .await
                    .map_err(remote_error)?;
                self.audit(
                    plugin_id,
                    "remote_profile_forgotten",
                    json!({ "profileId": profile_id }),
                )
                .await;
                Ok(json!({ "forgotten": true }))
            }
            "connect" => {
                let request: crate::RemoteConnectRequest = serde_json::from_value(input)
                    .map_err(|error| broker_error("remote_connect_failed", error))?;
                let result = self
                    .remote_profiles
                    .connect(plugin_id, request)
                    .await
                    .map_err(remote_error)?;
                self.audit(
                    plugin_id,
                    "remote_connected",
                    json!({ "profileId": result.profile.id, "stoppedHost": result.stopped_host }),
                )
                .await;
                Ok(serde_json::to_value(result)
                    .map_err(|error| broker_error("remote_connect_failed", error))?)
            }
            "disconnect" => {
                self.remote_profiles
                    .disconnect(plugin_id)
                    .await
                    .map_err(remote_error)?;
                self.audit(plugin_id, "remote_disconnected", json!({}))
                    .await;
                Ok(json!({ "disconnected": true }))
            }
            _ => Err(broker_error(
                "capability_unimplemented",
                format!("remote.{operation} is not implemented"),
            )),
        }
    }

    async fn audit(&self, plugin_id: &str, event: &str, evidence: Value) {
        if let Err(error) = self.plugins.record_audit(plugin_id, event, &evidence).await {
            tracing::warn!(%plugin_id, %event, %error, "plugin audit write failed");
        }
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
        let abort = schedule_preview_lease_drop(
            self.preview_leases.clone(),
            lease.lease_id.clone(),
            lease.expires_at_unix_ms,
        );
        if let Some(prev) = self.preview_leases.lock().await.insert(
            lease.lease_id.clone(),
            PreviewLeaseEntry {
                _lease: activation_lease,
                expiry_abort: Some(abort),
            },
        ) && let Some(prev_abort) = prev.expiry_abort
        {
            prev_abort.abort();
        }
        Ok(json!({
            "leaseId": lease.lease_id,
            "port": lease.loopback_port,
            "capabilityToken": lease.capability_token,
            "expiresAtUnixMs": lease.expires_at_unix_ms,
        }))
    }

    async fn call_conversation(
        &self,
        plugin_id: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        match operation {
            "create" => {
                let request: crate::PluginConversationCreate = serde_json::from_value(input)
                    .map_err(|error| broker_error("conversation_invalid", error))?;
                if request.agent_id.trim().is_empty() {
                    return Err(broker_error("conversation_invalid", "agentId is required"));
                }
                let created = self
                    .conversations
                    .create(plugin_id, request)
                    .await
                    .map_err(conversation_error)?;
                self.audit(
                    plugin_id,
                    "conversation_created",
                    json!({ "conversationId": created.summary.id }),
                )
                .await;
                serde_json::to_value(created)
                    .map_err(|error| broker_error("conversation_invalid", error))
            }
            "list" => {
                let conversations = self
                    .conversations
                    .list(plugin_id)
                    .await
                    .map_err(conversation_error)?;
                Ok(json!({ "conversations": conversations }))
            }
            "read.get" | "get" => {
                let conversation_id = required_id(&input, "conversationId")?;
                let view = self
                    .conversations
                    .get(plugin_id, &conversation_id)
                    .await
                    .map_err(conversation_error)?;
                serde_json::to_value(view)
                    .map_err(|error| broker_error("conversation_invalid", error))
            }
            "append.enqueueInput" | "enqueue" => {
                let request: crate::PluginConversationEnqueue = serde_json::from_value(input)
                    .map_err(|error| broker_error("conversation_invalid", error))?;
                if request.conversation_id.trim().is_empty() {
                    return Err(broker_error(
                        "conversation_invalid",
                        "conversationId is required",
                    ));
                }
                if request.text.trim().is_empty() {
                    return Err(broker_error("conversation_invalid", "text is required"));
                }
                let receipt = self
                    .conversations
                    .enqueue(plugin_id, request)
                    .await
                    .map_err(conversation_error)?;
                self.audit(
                    plugin_id,
                    "conversation_enqueued",
                    json!({
                        "conversationId": receipt.conversation_id,
                        "inputId": receipt.input_id,
                    }),
                )
                .await;
                serde_json::to_value(receipt)
                    .map_err(|error| broker_error("conversation_invalid", error))
            }
            "steer" => {
                let request: crate::PluginConversationSteer = serde_json::from_value(input)
                    .map_err(|error| broker_error("conversation_invalid", error))?;
                if request.conversation_id.trim().is_empty()
                    || request.expected_turn_id.trim().is_empty()
                    || request.text.trim().is_empty()
                {
                    return Err(broker_error(
                        "conversation_invalid",
                        "conversationId, expectedTurnId, and text are required",
                    ));
                }
                let receipt = self
                    .conversations
                    .steer(plugin_id, request)
                    .await
                    .map_err(conversation_error)?;
                Ok(receipt)
            }
            "cancel" => {
                let conversation_id = required_id(&input, "conversationId")?;
                self.conversations
                    .cancel(plugin_id, &conversation_id)
                    .await
                    .map_err(conversation_error)?;
                self.audit(
                    plugin_id,
                    "conversation_cancelled",
                    json!({ "conversationId": conversation_id }),
                )
                .await;
                Ok(json!({ "cancelled": true }))
            }
            "cancelInput" => {
                let request: crate::PluginConversationCancelInput =
                    serde_json::from_value(input)
                        .map_err(|error| broker_error("conversation_invalid", error))?;
                self.conversations
                    .cancel_input(plugin_id, request)
                    .await
                    .map_err(conversation_error)
            }
            "listInputs" => {
                let conversation_id = required_id(&input, "conversationId")?;
                self.conversations
                    .list_inputs(plugin_id, &conversation_id)
                    .await
                    .map_err(conversation_error)
            }
            "respondPermission" => {
                let request: crate::PluginConversationPermission = serde_json::from_value(input)
                    .map_err(|error| broker_error("conversation_invalid", error))?;
                self.conversations
                    .respond_permission(plugin_id, request)
                    .await
                    .map_err(conversation_error)?;
                Ok(json!({ "ok": true }))
            }
            "respondQuestion" => {
                let request: crate::PluginConversationQuestion = serde_json::from_value(input)
                    .map_err(|error| broker_error("conversation_invalid", error))?;
                self.conversations
                    .respond_question(plugin_id, request)
                    .await
                    .map_err(conversation_error)?;
                Ok(json!({ "ok": true }))
            }
            "setMode" => {
                let conversation_id = required_id(&input, "conversationId")?;
                let mode_id = required_id(&input, "modeId")?;
                self.conversations
                    .set_mode(plugin_id, &conversation_id, &mode_id)
                    .await
                    .map_err(conversation_error)?;
                Ok(json!({ "ok": true }))
            }
            "setConfigOption" => {
                let conversation_id = required_id(&input, "conversationId")?;
                let key = required_id(&input, "key")?;
                let value = input.get("value").cloned().unwrap_or(Value::Null);
                self.conversations
                    .set_config_option(plugin_id, &conversation_id, &key, value)
                    .await
                    .map_err(conversation_error)?;
                Ok(json!({ "ok": true }))
            }
            "catalog" => self
                .conversations
                .catalog(plugin_id)
                .await
                .map_err(conversation_error),
            "archive" => {
                let conversation_id = required_id(&input, "conversationId")?;
                self.conversations
                    .archive(plugin_id, &conversation_id)
                    .await
                    .map_err(conversation_error)?;
                Ok(json!({ "archived": true }))
            }
            "draft.insert" => {
                let request: crate::PluginConversationDraftInsert =
                    serde_json::from_value(input)
                        .map_err(|error| broker_error("conversation_invalid", error))?;
                if request.token.label.trim().is_empty() || request.token.markdown.trim().is_empty()
                {
                    return Err(broker_error(
                        "conversation_invalid",
                        "token.label and token.markdown are required",
                    ));
                }
                let receipt = self
                    .conversations
                    .insert_draft(plugin_id, request)
                    .await
                    .map_err(conversation_error)?;
                self.audit(
                    plugin_id,
                    "conversation_draft_inserted",
                    json!({ "conversationId": receipt.conversation_id }),
                )
                .await;
                serde_json::to_value(receipt)
                    .map_err(|error| broker_error("conversation_invalid", error))
            }
            "events.since" => {
                let conversation_id = required_id(&input, "conversationId")?;
                let after_sequence = input
                    .get("afterSequence")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let page = self
                    .conversations
                    .events_since(plugin_id, &conversation_id, after_sequence)
                    .await
                    .map_err(conversation_error)?;
                serde_json::to_value(page)
                    .map_err(|error| broker_error("conversation_invalid", error))
            }
            _ => Err(broker_error(
                "capability_unimplemented",
                format!("conversation.{operation} is not implemented"),
            )),
        }
    }

    async fn call_plugin_data(
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
                let value = self
                    .plugins
                    .kv_get(plugin_id, name)
                    .await
                    .map_err(|error| broker_error("kv_storage_failed", error))?;
                Ok(value.unwrap_or(Value::Null))
            }
            "storage.kv.put" => {
                let name = input
                    .get("key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| broker_error("kv_key_missing", "key is required"))?;
                let value = input.get("value").cloned().unwrap_or(Value::Null);
                self.plugins
                    .kv_put(plugin_id, name, &value)
                    .await
                    .map_err(|error| broker_error("kv_storage_failed", error))?;
                Ok(value)
            }
            "storage.kv.delete" => {
                if let Some(name) = input.get("key").and_then(Value::as_str) {
                    self.plugins
                        .kv_delete(plugin_id, name)
                        .await
                        .map_err(|error| broker_error("kv_storage_failed", error))?;
                }
                Ok(json!({}))
            }
            "storage.kv.list" => {
                let prefix = input.get("prefix").and_then(Value::as_str);
                let keys = self
                    .plugins
                    .kv_list_keys(plugin_id, prefix)
                    .await
                    .map_err(|error| broker_error("kv_storage_failed", error))?;
                Ok(Value::Array(keys.into_iter().map(Value::String).collect()))
            }
            "storage.kv.clear" => {
                let removed = self
                    .plugins
                    .kv_clear(plugin_id)
                    .await
                    .map_err(|error| broker_error("kv_storage_failed", error))?;
                Ok(json!({ "removed": removed }))
            }
            "storage.settings.get" => {
                let plugin = self
                    .plugins
                    .plugin(plugin_id)
                    .await
                    .map_err(|error| broker_error("config_schema_invalid", error))?
                    .ok_or_else(|| {
                        broker_error("config_schema_invalid", "plugin is not installed")
                    })?;
                let refreshed =
                    crate::PluginPackage::inspect(&plugin.source.path, plugin.source.kind)
                        .map_err(|error| broker_error("config_schema_invalid", error))?;
                Ok(refreshed.config)
            }
            "storage.settings.put" => {
                let plugin = self
                    .plugins
                    .plugin(plugin_id)
                    .await
                    .map_err(|error| broker_error("config_schema_invalid", error))?
                    .ok_or_else(|| {
                        broker_error("config_schema_invalid", "plugin is not installed")
                    })?;
                plugin
                    .write_config(input.clone())
                    .map_err(|error| broker_error("config_schema_invalid", error))?;
                let hook = self
                    .settings_saved
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone();
                if let Some(hook) = hook {
                    hook();
                }
                Ok(input)
            }
            "secrets.get" | "secrets.put" | "secrets.delete" => {
                self.call_secrets(plugin_id, &key, input).await
            }
            "network.fetch" => execute_network_fetch(&self.http_client, input).await,
            "files.read" | "files.write" | "files.stat" | "files.list" => {
                self.call_files(plugin_id, &key, input).await
            }
            "events.subscribe" | "events.ack" | "events.publish" => {
                self.call_events(plugin_id, &key, input).await
            }
            "agent.invoke" => self.call_agent_invoke(plugin_id, input).await,
            "app.notify.toast" => {
                let title = input
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let message = input
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let variant = input
                    .get("variant")
                    .and_then(Value::as_str)
                    .unwrap_or("info")
                    .to_owned();
                let duration_ms = input
                    .get("durationMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(4_000);
                self.audit(
                    plugin_id,
                    "plugin_toast_notified",
                    json!({
                        "title": title,
                        "message": message,
                        "variant": variant,
                        "durationMs": duration_ms,
                    }),
                )
                .await;
                let _ = plugin_toast_sender().send(PluginToastNotification {
                    plugin_id: plugin_id.to_owned(),
                    title: title.clone(),
                    message: message.clone(),
                    variant: variant.clone(),
                    duration_ms,
                });
                Ok(json!({
                    "notified": true,
                    "title": title,
                    "message": message,
                    "variant": variant,
                    "durationMs": duration_ms,
                }))
            }
            _ => Err(broker_error(
                "capability_unimplemented",
                format!("{key} is not implemented"),
            )),
        }
    }

    async fn call_plugin_self(
        &self,
        plugin_id: &str,
        generation: u64,
        operation: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        match operation {
            "doctor" => {
                let quarantine_reason = self
                    .plugins
                    .quarantine_reason(plugin_id)
                    .await
                    .unwrap_or(None);
                Ok(json!({
                    "pluginId": plugin_id,
                    "generation": generation,
                    "quarantined": quarantine_reason.is_some(),
                    "quarantineReason": quarantine_reason,
                    "diagnostics": [],
                    "recentCrashes": [],
                }))
            }
            "status" => {
                let quarantine_reason = self
                    .plugins
                    .quarantine_reason(plugin_id)
                    .await
                    .unwrap_or(None);
                Ok(json!({
                    "pluginId": plugin_id,
                    "generation": generation,
                    "quarantined": quarantine_reason.is_some(),
                    "quarantineReason": quarantine_reason,
                }))
            }
            "quarantine" => {
                let reason = input
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Quarantined after repeated crashes");
                self.kill_plugin_processes(plugin_id).await;
                self.plugins
                    .quarantine_plugin(plugin_id, reason)
                    .await
                    .map_err(|error| broker_error("plugin_quarantine_failed", error))?;
                Ok(json!({
                    "quarantined": true,
                    "pluginId": plugin_id,
                    "reason": reason,
                }))
            }
            _ => Err(broker_error(
                "capability_unimplemented",
                format!("plugin.self.{operation} is not implemented"),
            )),
        }
    }

    async fn call_exec(
        &self,
        plugin_id: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        match operation {
            "run" => {
                let program = input
                    .get("program")
                    .or_else(|| input.get("command"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| broker_error("exec_invalid_program", "program is required"))?;
                let args: Vec<String> = input
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                let timeout_ms = input
                    .get("timeoutMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(60_000)
                    .clamp(100, 300_000);
                let mut cmd = utils::process::new_hidden_tokio_command(program, &args);
                cmd.stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true);
                if let Some(cwd) = input
                    .get("cwd")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    cmd.current_dir(cwd);
                }
                if let Some(env_map) = input.get("env").and_then(Value::as_object) {
                    for (k, v) in env_map {
                        if let Some(val) = v.as_str() {
                            cmd.env(k, val);
                        }
                    }
                }
                let mut child = cmd
                    .spawn()
                    .map_err(|error| broker_error("exec_spawn_failed", error))?;
                if let Some(stdin_text) = input.get("stdin").and_then(Value::as_str) {
                    if stdin_text.len() > 16 * 1024 * 1024 {
                        return Err(broker_error("exec_stdin_too_large", "stdin exceeds 16 MiB"));
                    }
                    if let Some(mut stdin) = child.stdin.take() {
                        stdin
                            .write_all(stdin_text.as_bytes())
                            .await
                            .map_err(|error| broker_error("exec_stdin_failed", error))?;
                    }
                } else {
                    drop(child.stdin.take());
                }
                let output = timeout(Duration::from_millis(timeout_ms), child.wait_with_output())
                    .await
                    .map_err(|_| broker_error("exec_timeout", "Command execution timed out"))?
                    .map_err(|error| broker_error("exec_failed", error))?;
                if output.stdout.len() > 32 * 1024 * 1024 || output.stderr.len() > 4 * 1024 * 1024 {
                    return Err(broker_error(
                        "exec_output_too_large",
                        "Command output exceeds Host limit",
                    ));
                }
                let exit_code = output.status.code().unwrap_or(-1);
                let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
                let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
                self.audit(
                    plugin_id,
                    "exec_run",
                    json!({ "program": program, "exitCode": exit_code }),
                )
                .await;
                Ok(json!({
                    "exitCode": exit_code,
                    "stdout": stdout,
                    "stderr": stderr,
                    "success": output.status.success(),
                }))
            }
            "spawn" => {
                let program = input
                    .get("program")
                    .or_else(|| input.get("command"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| broker_error("exec_invalid_program", "program is required"))?;
                let args: Vec<String> = input
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                let mut cmd = utils::process::new_hidden_tokio_command(program, &args);
                cmd.stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .kill_on_drop(true);
                if let Some(cwd) = input
                    .get("cwd")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    cmd.current_dir(cwd);
                }
                if let Some(env_map) = input.get("env").and_then(Value::as_object) {
                    for (k, v) in env_map {
                        if let Some(val) = v.as_str() {
                            cmd.env(k, val);
                        }
                    }
                }
                let child = cmd
                    .spawn()
                    .map_err(|error| broker_error("exec_spawn_failed", error))?;
                let pid = child.id();
                let process_id = uuid::Uuid::new_v4().to_string();
                self.spawned_processes.lock().await.insert(
                    process_id.clone(),
                    SpawnedPluginProcess {
                        plugin_id: plugin_id.to_owned(),
                        pid,
                        child,
                    },
                );
                self.audit(
                    plugin_id,
                    "exec_spawn",
                    json!({ "program": program, "processId": process_id, "pid": pid }),
                )
                .await;
                Ok(json!({
                    "processId": process_id,
                    "pid": pid,
                }))
            }
            "kill" => {
                if let Some(process_id) = input
                    .get("processId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    let mut processes = self.spawned_processes.lock().await;
                    let belongs = processes
                        .get(process_id)
                        .is_some_and(|proc| proc.plugin_id == plugin_id);
                    if !belongs {
                        return Err(broker_error(
                            "exec_process_not_found",
                            format!("Process {process_id} is not owned by {plugin_id}"),
                        ));
                    }
                    if let Some(mut proc) = processes.remove(process_id) {
                        let _ = proc.child.kill().await;
                    }
                    self.audit(plugin_id, "exec_kill", json!({ "processId": process_id }))
                        .await;
                    Ok(json!({
                        "killed": true,
                        "processId": process_id,
                    }))
                } else {
                    let count = self.kill_plugin_processes(plugin_id).await;
                    Ok(json!({
                        "killed": count > 0,
                        "killedCount": count,
                    }))
                }
            }
            "status" => {
                let process_id = input
                    .get("processId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| broker_error("exec_process_missing", "processId is required"))?;
                let mut processes = self.spawned_processes.lock().await;
                let Some(proc) = processes.get_mut(process_id) else {
                    return Ok(json!({
                        "processId": process_id,
                        "running": false,
                        "exitCode": Value::Null,
                    }));
                };
                if proc.plugin_id != plugin_id {
                    return Err(broker_error(
                        "exec_process_not_found",
                        format!("Process {process_id} is not owned by {plugin_id}"),
                    ));
                }
                match proc.child.try_wait() {
                    Ok(Some(status)) => {
                        let exit_code = status.code();
                        let pid = proc.pid;
                        processes.remove(process_id);
                        Ok(json!({
                            "processId": process_id,
                            "pid": pid,
                            "running": false,
                            "exitCode": exit_code,
                        }))
                    }
                    Ok(None) => Ok(json!({
                        "processId": process_id,
                        "pid": proc.pid,
                        "running": true,
                        "exitCode": Value::Null,
                    })),
                    Err(error) => Err(broker_error("exec_status_failed", error)),
                }
            }
            _ => Err(broker_error(
                "capability_unimplemented",
                format!("exec.{operation} is not implemented"),
            )),
        }
    }

    async fn effective_grants_for_plugin(
        &self,
        plugin_id: &str,
    ) -> Vec<crate::HostCapabilityGrant> {
        let mut grants = self
            .capability_grants
            .lock()
            .await
            .get(plugin_id)
            .cloned()
            .unwrap_or_default();
        if let Ok(persisted) = self.plugins.capability_grants(plugin_id).await {
            grants.extend(persisted.into_iter().map(crate::HostCapabilityGrant::from));
        }
        if let Ok(Some(installed)) = self.plugins.plugin(plugin_id).await {
            for permission in &installed.package.permissions {
                grants.push(
                    crate::HostCapabilityGrant::new(
                        permission.capability.clone(),
                        permission.scope.clone(),
                    )
                    .with_trust_tier(permission.trust_tier.clone()),
                );
            }
        }
        grants
    }

    async fn call_secrets(
        &self,
        plugin_id: &str,
        key: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        let grants = self.effective_grants_for_plugin(plugin_id).await;
        let max_request_bytes = grants
            .iter()
            .filter(|grant| capability_matches(&grant.capability, key, "secrets"))
            .map(|grant| grant.effective_limits().max_request_bytes)
            .min()
            .unwrap_or_else(|| crate::GrantLimits::default().max_request_bytes);
        let request_bytes = serde_json::to_vec(&input)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        if request_bytes > max_request_bytes {
            return Err(broker_error(
                "secrets_limit_exceeded",
                format!(
                    "Secret request size ({request_bytes} bytes) exceeds limit ({max_request_bytes} bytes)"
                ),
            ));
        }

        let secret_key = input
            .get("key")
            .or_else(|| input.get("secretKey"))
            .or_else(|| input.get("secret_key"))
            .or_else(|| input.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| broker_error("secret_key_missing", "secret key is required"))?;

        match key {
            "secrets.get" => {
                let value = self
                    .plugins
                    .secret_get(plugin_id, secret_key)
                    .await
                    .map_err(|error| broker_error("secrets_storage_failed", error))?;
                let present = value.is_some();
                // NEVER write the secret plaintext value into HostAuditEntry!
                self.audit(
                    plugin_id,
                    "plugin_secret_get",
                    json!({
                        "secretKey": secret_key,
                        "present": present,
                        "status": "ok",
                    }),
                )
                .await;
                Ok(json!({
                    "present": present,
                    "value": value,
                }))
            }
            "secrets.put" => {
                let secret_value = input
                    .get("value")
                    .or_else(|| input.get("secret"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        broker_error("secret_value_missing", "secret value string is required")
                    })?;
                if secret_value.len() > max_request_bytes {
                    return Err(broker_error(
                        "secrets_limit_exceeded",
                        format!(
                            "Secret value size ({} bytes) exceeds limit ({max_request_bytes} bytes)",
                            secret_value.len()
                        ),
                    ));
                }
                self.plugins
                    .secret_put(plugin_id, secret_key, secret_value)
                    .await
                    .map_err(|error| broker_error("secrets_storage_failed", error))?;
                // NEVER write the secret plaintext value into HostAuditEntry!
                self.audit(
                    plugin_id,
                    "plugin_secret_put",
                    json!({
                        "secretKey": secret_key,
                        "present": true,
                        "status": "ok",
                    }),
                )
                .await;
                Ok(json!({
                    "present": true,
                }))
            }
            "secrets.delete" => {
                let deleted = self
                    .plugins
                    .secret_delete(plugin_id, secret_key)
                    .await
                    .map_err(|error| broker_error("secrets_storage_failed", error))?;
                self.audit(
                    plugin_id,
                    "plugin_secret_delete",
                    json!({
                        "secretKey": secret_key,
                        "deleted": deleted,
                        "status": "ok",
                    }),
                )
                .await;
                Ok(json!({
                    "present": false,
                    "deleted": deleted,
                }))
            }
            _ => Err(broker_error(
                "capability_unimplemented",
                format!("{key} is not implemented"),
            )),
        }
    }

    async fn authorized_file_roots_and_limits(
        &self,
        plugin_id: &str,
        operation_key: &str,
    ) -> Result<(Vec<std::path::PathBuf>, crate::GrantLimits), crate::WorkerHostError> {
        let grants = self.effective_grants_for_plugin(plugin_id).await;
        let matching: Vec<&crate::HostCapabilityGrant> = grants
            .iter()
            .filter(|grant| capability_matches(&grant.capability, operation_key, "files"))
            .collect();
        if matching.is_empty() {
            return Err(broker_error(
                "files_root_denied",
                "File roots are bound to workspace and plugin-data sessions",
            ));
        }

        let default_workspace_root = self
            .workspace_root
            .read()
            .ok()
            .and_then(|guard| guard.clone());
        let default_plugin_data_root = self
            .plugin_data_root
            .read()
            .ok()
            .and_then(|guard| guard.clone());

        let mut candidate_roots = Vec::new();
        let mut limits = crate::GrantLimits::default();
        let mut has_custom_limit = false;

        for grant in matching {
            let grant_limits = grant.effective_limits();
            if !has_custom_limit || grant_limits.max_request_bytes < limits.max_request_bytes {
                limits = grant_limits;
                has_custom_limit = true;
            }
            collect_grant_roots(
                plugin_id,
                &grant.scope,
                default_workspace_root.as_deref(),
                default_plugin_data_root.as_deref(),
                &mut candidate_roots,
            );
        }

        let mut canonical_roots = Vec::new();
        for root in candidate_roots {
            if let Ok(canonical) = std::fs::canonicalize(&root)
                && !canonical_roots.contains(&canonical)
            {
                canonical_roots.push(canonical);
            }
        }

        if canonical_roots.is_empty() {
            return Err(broker_error(
                "files_root_denied",
                "File roots are bound to workspace and plugin-data sessions",
            ));
        }

        Ok((canonical_roots, limits))
    }

    async fn call_files(
        &self,
        plugin_id: &str,
        key: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        use base64::Engine as _;

        let (authorized_roots, limits) = self
            .authorized_file_roots_and_limits(plugin_id, key)
            .await?;

        let raw_request_len = serde_json::to_vec(&input)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        if raw_request_len > limits.max_request_bytes {
            return Err(broker_error(
                "files_limit_exceeded",
                format!(
                    "File request payload ({raw_request_len} bytes) exceeds max_request_bytes ({} bytes)",
                    limits.max_request_bytes
                ),
            ));
        }

        let requested_path = input
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or(".");
        let preferred_root = select_preferred_root(
            plugin_id,
            &input,
            &authorized_roots,
            self.workspace_root
                .read()
                .ok()
                .and_then(|g| g.clone())
                .as_deref(),
            self.plugin_data_root
                .read()
                .ok()
                .and_then(|g| g.clone())
                .as_deref(),
        );

        match key {
            "files.read" => {
                let target = resolve_authorized_file_path(
                    requested_path,
                    preferred_root.as_deref(),
                    &authorized_roots,
                    false,
                    false,
                )?;
                let metadata = tokio::fs::metadata(&target)
                    .await
                    .map_err(|error| broker_error("files_io_error", error))?;
                if !metadata.is_file() {
                    return Err(broker_error(
                        "files_not_a_file",
                        format!("`{}` is not a regular file", target.display()),
                    ));
                }
                if metadata.len() > (limits.max_request_bytes as u64) {
                    return Err(broker_error(
                        "files_limit_exceeded",
                        format!(
                            "File size ({} bytes) exceeds max_request_bytes ({} bytes)",
                            metadata.len(),
                            limits.max_request_bytes
                        ),
                    ));
                }
                let bytes = tokio::fs::read(&target)
                    .await
                    .map_err(|error| broker_error("files_io_error", error))?;
                if bytes.len() > limits.max_request_bytes {
                    return Err(broker_error(
                        "files_limit_exceeded",
                        format!(
                            "File size ({} bytes) exceeds max_request_bytes ({} bytes)",
                            bytes.len(),
                            limits.max_request_bytes
                        ),
                    ));
                }
                let encoding = input
                    .get("encoding")
                    .and_then(Value::as_str)
                    .unwrap_or("utf8")
                    .trim()
                    .to_ascii_lowercase();
                let content = match encoding.as_str() {
                    "base64" => base64::engine::general_purpose::STANDARD.encode(&bytes),
                    "utf8" | "utf-8" | "text" => String::from_utf8(bytes.clone())
                        .map_err(|error| broker_error("files_invalid_utf8", error))?,
                    other => {
                        return Err(broker_error(
                            "files_invalid_encoding",
                            format!("Unsupported file encoding `{other}`"),
                        ));
                    }
                };
                Ok(json!({
                    "path": target.to_string_lossy(),
                    "content": content,
                    "encoding": if encoding == "base64" { "base64" } else { "utf8" },
                    "size": bytes.len(),
                }))
            }
            "files.write" => {
                let encoding = input
                    .get("encoding")
                    .and_then(Value::as_str)
                    .unwrap_or("utf8")
                    .trim()
                    .to_ascii_lowercase();
                let raw_content = input
                    .get("content")
                    .or_else(|| input.get("data"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| broker_error("files_content_missing", "content is required"))?;
                let bytes = match encoding.as_str() {
                    "base64" => base64::engine::general_purpose::STANDARD
                        .decode(raw_content)
                        .map_err(|error| broker_error("files_invalid_base64", error))?,
                    "utf8" | "utf-8" | "text" => raw_content.as_bytes().to_vec(),
                    other => {
                        return Err(broker_error(
                            "files_invalid_encoding",
                            format!("Unsupported file encoding `{other}`"),
                        ));
                    }
                };
                if bytes.len() > limits.max_request_bytes {
                    return Err(broker_error(
                        "files_limit_exceeded",
                        format!(
                            "Write payload ({} bytes) exceeds max_request_bytes ({} bytes)",
                            bytes.len(),
                            limits.max_request_bytes
                        ),
                    ));
                }
                let create_dirs = input
                    .get("createDirs")
                    .or_else(|| input.get("create_dirs"))
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let target = resolve_authorized_file_path(
                    requested_path,
                    preferred_root.as_deref(),
                    &authorized_roots,
                    true,
                    create_dirs,
                )?;
                let parent = target.parent().ok_or_else(|| {
                    broker_error("files_root_denied", "Target file must have a valid parent")
                })?;
                let temp_name =
                    format!(".vibex-tmp-{}-{}", std::process::id(), uuid::Uuid::new_v4());
                let temp_path = parent.join(temp_name);
                let write_result = async {
                    let mut file = tokio::fs::File::create(&temp_path).await?;
                    file.write_all(&bytes).await?;
                    file.flush().await?;
                    drop(file);
                    tokio::fs::rename(&temp_path, &target).await
                }
                .await;
                if let Err(error) = write_result {
                    let _ = tokio::fs::remove_file(&temp_path).await;
                    return Err(broker_error("files_io_error", error));
                }
                Ok(json!({
                    "path": target.to_string_lossy(),
                    "bytesWritten": bytes.len(),
                    "size": bytes.len(),
                }))
            }
            "files.stat" => {
                let target = resolve_authorized_file_path(
                    requested_path,
                    preferred_root.as_deref(),
                    &authorized_roots,
                    false,
                    false,
                )?;
                let metadata = tokio::fs::metadata(&target)
                    .await
                    .map_err(|error| broker_error("files_io_error", error))?;
                let modified_at_ms = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or(0);
                Ok(json!({
                    "exists": true,
                    "path": target.to_string_lossy(),
                    "size": metadata.len(),
                    "is_file": metadata.is_file(),
                    "isFile": metadata.is_file(),
                    "is_dir": metadata.is_dir(),
                    "isDir": metadata.is_dir(),
                    "modified_at_ms": modified_at_ms,
                    "modifiedAtMs": modified_at_ms,
                }))
            }
            "files.list" => {
                let target = resolve_authorized_file_path(
                    requested_path,
                    preferred_root.as_deref(),
                    &authorized_roots,
                    false,
                    false,
                )?;
                let metadata = tokio::fs::metadata(&target)
                    .await
                    .map_err(|error| broker_error("files_io_error", error))?;
                if !metadata.is_dir() {
                    return Err(broker_error(
                        "files_not_a_directory",
                        format!("`{}` is not a directory", target.display()),
                    ));
                }
                let mut read_dir = tokio::fs::read_dir(&target)
                    .await
                    .map_err(|error| broker_error("files_io_error", error))?;
                let mut entries = Vec::new();
                while let Some(entry) = read_dir
                    .next_entry()
                    .await
                    .map_err(|error| broker_error("files_io_error", error))?
                {
                    let entry_path = entry.path();
                    let Ok(canonical_entry) = std::fs::canonicalize(&entry_path) else {
                        continue;
                    };
                    if !authorized_roots
                        .iter()
                        .any(|root| canonical_entry.starts_with(root))
                    {
                        continue;
                    }
                    let Ok(entry_meta) = tokio::fs::metadata(&canonical_entry).await else {
                        continue;
                    };
                    let modified_at_ms = entry_meta
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|duration| duration.as_millis() as u64)
                        .unwrap_or(0);
                    let name = entry.file_name().to_string_lossy().into_owned();
                    entries.push(json!({
                        "name": name,
                        "path": canonical_entry.to_string_lossy(),
                        "size": entry_meta.len(),
                        "is_file": entry_meta.is_file(),
                        "isFile": entry_meta.is_file(),
                        "is_dir": entry_meta.is_dir(),
                        "isDir": entry_meta.is_dir(),
                        "modified_at_ms": modified_at_ms,
                        "modifiedAtMs": modified_at_ms,
                    }));
                }
                entries.sort_by(|left, right| {
                    left["name"]
                        .as_str()
                        .unwrap_or_default()
                        .cmp(right["name"].as_str().unwrap_or_default())
                });
                Ok(json!({
                    "path": target.to_string_lossy(),
                    "entries": entries,
                }))
            }
            _ => Err(broker_error(
                "capability_unimplemented",
                format!("{key} is not implemented"),
            )),
        }
    }

    async fn call_events(
        &self,
        plugin_id: &str,
        key: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        match key {
            "events.subscribe" => {
                let topic = input
                    .get("topic")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                let event_type = input
                    .get("eventType")
                    .or_else(|| input.get("event_type"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                let since_cursor = input
                    .get("cursor")
                    .or_else(|| input.get("sinceCursor"))
                    .or_else(|| input.get("since_cursor"))
                    .and_then(Value::as_u64);
                let limit = input
                    .get("limit")
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                    .unwrap_or(100);
                let batch = self
                    .plugins
                    .events_subscribe(plugin_id, topic, event_type, since_cursor, limit)
                    .await
                    .map_err(|error| broker_error("events_subscribe_failed", error))?;
                Ok(json!({
                    "cursor": batch.cursor,
                    "ackedCursor": batch.acked_cursor,
                    "acked_cursor": batch.acked_cursor,
                    "events": batch.events,
                }))
            }
            "events.ack" => {
                let cursor = input
                    .get("cursor")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| broker_error("events_cursor_missing", "cursor is required"))?;
                let subscription_key = input
                    .get("subscriptionKey")
                    .or_else(|| input.get("subscription_key"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        let topic = input.get("topic").and_then(Value::as_str);
                        let event_type = input
                            .get("eventType")
                            .or_else(|| input.get("event_type"))
                            .and_then(Value::as_str);
                        crate::control_plane::event_subscription_key(topic, event_type)
                    });
                let acked = self
                    .plugins
                    .events_ack(plugin_id, &subscription_key, cursor)
                    .await
                    .map_err(|error| broker_error("events_ack_failed", error))?;
                Ok(json!({
                    "cursor": acked,
                    "ackedCursor": acked,
                    "acked_cursor": acked,
                }))
            }
            "events.publish" => {
                let topic = input
                    .get("topic")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("default");
                let event_type = input
                    .get("eventType")
                    .or_else(|| input.get("event_type"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("message");
                let payload = input.get("payload").cloned().unwrap_or(Value::Null);
                let cursor = self.publish_event(topic, event_type, &payload).await?;
                Ok(json!({
                    "cursor": cursor,
                }))
            }
            _ => Err(broker_error(
                "capability_unimplemented",
                format!("{key} is not implemented"),
            )),
        }
    }

    async fn call_agent_invoke(
        &self,
        plugin_id: &str,
        input: Value,
    ) -> Result<Value, crate::WorkerHostError> {
        let grants = self.effective_grants_for_plugin(plugin_id).await;
        let agent_grants: Vec<&crate::HostCapabilityGrant> = grants
            .iter()
            .filter(|grant| capability_matches(&grant.capability, "agent.invoke", "agent"))
            .collect();
        if agent_grants.is_empty() {
            return Err(broker_error(
                "permission_denied",
                format!("Plugin `{plugin_id}` is not granted `agent.invoke` capability"),
            ));
        }

        let max_request_bytes = agent_grants
            .iter()
            .map(|grant| grant.effective_limits().max_request_bytes)
            .min()
            .unwrap_or_else(|| crate::GrantLimits::default().max_request_bytes);
        let raw_request_len = serde_json::to_vec(&input)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        if raw_request_len > max_request_bytes {
            return Err(broker_error(
                "agent_invoke_limit_exceeded",
                format!(
                    "agent.invoke payload ({raw_request_len} bytes) exceeds limit ({max_request_bytes} bytes)"
                ),
            ));
        }

        let handler_id = input
            .get("handler")
            .or_else(|| input.get("handlerId"))
            .or_else(|| input.get("handler_id"))
            .or_else(|| input.get("command"))
            .or_else(|| input.get("target"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| broker_error("handler_not_visible", "handler is required"))?
            .to_owned();

        if !agent_grants
            .iter()
            .any(|grant| grant_allows_agent_handler(&grant.scope, &handler_id))
        {
            return Err(broker_error(
                "permission_denied",
                format!("Plugin `{plugin_id}` is not authorized to invoke handler `{handler_id}`"),
            ));
        }

        let payload = input
            .get("input")
            .or_else(|| input.get("params"))
            .or_else(|| input.get("payload"))
            .or_else(|| input.get("args"))
            .cloned()
            .unwrap_or_else(|| input.clone());

        let registered = {
            let handlers = self.agent_handlers.lock().await;
            handlers.get(&handler_id).map(|entry| {
                let allowed_by_scope = entry
                    .allowed_plugins
                    .as_ref()
                    .is_none_or(|allowed| allowed.contains(plugin_id) || allowed.contains("*"));
                let visible = allowed_by_scope && entry.handler.is_visible_to(plugin_id);
                (entry.handler.clone(), visible)
            })
        };

        if let Some((handler, visible)) = registered {
            if !visible {
                return Err(broker_error(
                    "handler_not_visible",
                    format!("Handler `{handler_id}` is not visible to `{plugin_id}`"),
                ));
            }
            let output = handler.invoke(plugin_id, &handler_id, payload).await?;
            self.audit(
                plugin_id,
                "plugin_agent_invoke",
                json!({
                    "handler": handler_id,
                    "status": "ok",
                }),
            )
            .await;
            return Ok(output);
        }

        if let Ok(Some((target_plugin_id, command_name))) = self
            .plugins
            .resolve_dynamic_command_target(&handler_id)
            .await
            && (target_plugin_id == plugin_id
                || self
                    .plugins
                    .has_command_handler(&target_plugin_id, &command_name))
        {
            let output = self
                .plugins
                .invoke_plugin_command(&target_plugin_id, &command_name, payload)
                .await?;
            self.audit(
                plugin_id,
                "plugin_agent_invoke",
                json!({
                    "handler": handler_id,
                    "targetPluginId": target_plugin_id,
                    "command": command_name,
                    "status": "ok",
                }),
            )
            .await;
            return Ok(output);
        }

        Err(broker_error(
            "handler_not_visible",
            format!("Cross-plugin handler `{handler_id}` is not registered or not visible"),
        ))
    }
}

fn capability_matches(granted: &str, requested_key: &str, domain: &str) -> bool {
    let granted = granted.trim();
    granted == "*"
        || granted == domain
        || granted == format!("{domain}.*")
        || granted == requested_key
        || (domain == "files"
            && matches!(
                granted,
                "files.rw" | "files.readwrite" | "workspace.files" | "storage.files"
            ))
        || (domain == "files"
            && requested_key != "files.write"
            && matches!(granted, "files.read" | "files.ro" | "files.readonly"))
}

fn grant_allows_agent_handler(scope: &Value, handler_id: &str) -> bool {
    let Some(obj) = scope.as_object() else {
        return true;
    };
    if let Some(single) = obj.get("handler").and_then(Value::as_str) {
        return single == "*" || single == handler_id;
    }
    if let Some(list) = obj
        .get("handlers")
        .or_else(|| obj.get("allowed_handlers"))
        .or_else(|| obj.get("allowedHandlers"))
        .and_then(Value::as_array)
    {
        return list.iter().filter_map(Value::as_str).any(|pattern| {
            pattern == "*"
                || pattern == handler_id
                || pattern
                    .strip_suffix(".*")
                    .is_some_and(|prefix| handler_id.starts_with(&format!("{prefix}.")))
        });
    }
    true
}

fn collect_grant_roots(
    plugin_id: &str,
    scope: &Value,
    default_workspace_root: Option<&std::path::Path>,
    default_plugin_data_root: Option<&std::path::Path>,
    out: &mut Vec<std::path::PathBuf>,
) {
    match scope {
        Value::String(path_str) => {
            let trimmed = path_str.trim();
            if trimmed == "workspace" || trimmed == "workspace_root" {
                if let Some(ws) = default_workspace_root {
                    out.push(ws.to_path_buf());
                }
            } else if trimmed == "plugin_data" || trimmed == "plugin_data_dir" {
                if let Some(data_root) = default_plugin_data_root {
                    let plugin_dir = data_root.join(plugin_id);
                    let _ = std::fs::create_dir_all(&plugin_dir);
                    out.push(plugin_dir);
                }
            } else if !trimmed.is_empty() {
                out.push(std::path::PathBuf::from(trimmed));
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_grant_roots(
                    plugin_id,
                    item,
                    default_workspace_root,
                    default_plugin_data_root,
                    out,
                );
            }
        }
        Value::Object(map) => {
            for key in ["workspace_root", "workspaceRoot", "workspace"] {
                match map.get(key) {
                    Some(Value::String(path)) if !path.trim().is_empty() => {
                        out.push(std::path::PathBuf::from(path.trim()));
                    }
                    Some(Value::Bool(true)) => {
                        if let Some(ws) = default_workspace_root {
                            out.push(ws.to_path_buf());
                        }
                    }
                    _ => {}
                }
            }
            for key in ["plugin_data_dir", "pluginDataDir", "plugin_data", "dataDir"] {
                match map.get(key) {
                    Some(Value::String(path)) if !path.trim().is_empty() => {
                        let dir = std::path::PathBuf::from(path.trim());
                        let _ = std::fs::create_dir_all(&dir);
                        out.push(dir);
                    }
                    Some(Value::Bool(true)) => {
                        if let Some(data_root) = default_plugin_data_root {
                            let plugin_dir = data_root.join(plugin_id);
                            let _ = std::fs::create_dir_all(&plugin_dir);
                            out.push(plugin_dir);
                        }
                    }
                    _ => {}
                }
            }
            if let Some(Value::String(root)) = map.get("root")
                && !root.trim().is_empty()
            {
                out.push(std::path::PathBuf::from(root.trim()));
            }
            for key in ["roots", "allowed_roots", "allowedRoots", "paths"] {
                if let Some(Value::Array(roots)) = map.get(key) {
                    for item in roots {
                        if let Some(path) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                            out.push(std::path::PathBuf::from(path));
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

fn select_preferred_root(
    plugin_id: &str,
    input: &Value,
    authorized_roots: &[std::path::PathBuf],
    default_workspace_root: Option<&std::path::Path>,
    default_plugin_data_root: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    let scope_hint = input
        .get("root")
        .or_else(|| input.get("scope"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let candidate = match scope_hint {
        "workspace" | "workspace_root" | "workspaceRoot" => {
            default_workspace_root.map(std::path::Path::to_path_buf)
        }
        "plugin_data" | "plugin_data_dir" | "pluginDataDir" => {
            default_plugin_data_root.map(|root| root.join(plugin_id))
        }
        other => Some(std::path::PathBuf::from(other)),
    }?;
    let canonical = std::fs::canonicalize(candidate).ok()?;
    authorized_roots
        .iter()
        .find(|authorized| canonical.starts_with(*authorized))
        .map(|_| canonical)
}

fn resolve_authorized_file_path(
    requested_path: &str,
    preferred_root: Option<&std::path::Path>,
    authorized_roots: &[std::path::PathBuf],
    for_write: bool,
    create_dirs: bool,
) -> Result<std::path::PathBuf, crate::WorkerHostError> {
    use std::path::{Component, Path};

    let raw_path = Path::new(requested_path);
    for component in raw_path.components() {
        if matches!(component, Component::ParentDir) {
            return Err(broker_error(
                "files_root_denied",
                "Path traversal (`..`) is not permitted outside authorized roots",
            ));
        }
    }

    let roots_to_try: Vec<&std::path::PathBuf> = if let Some(preferred) = preferred_root {
        authorized_roots
            .iter()
            .filter(|root| preferred.starts_with(*root))
            .collect()
    } else {
        authorized_roots.iter().collect()
    };

    if raw_path.is_absolute() {
        return verify_candidate_under_roots(raw_path, &roots_to_try, for_write, create_dirs);
    }

    let base_root = preferred_root
        .or_else(|| authorized_roots.first().map(std::path::PathBuf::as_path))
        .ok_or_else(|| {
            broker_error(
                "files_root_denied",
                "No authorized file root is configured for this plugin",
            )
        })?;
    let joined = if requested_path.is_empty() || requested_path == "." {
        base_root.to_path_buf()
    } else {
        base_root.join(raw_path)
    };
    verify_candidate_under_roots(&joined, &roots_to_try, for_write, create_dirs)
}

fn verify_candidate_under_roots(
    candidate: &std::path::Path,
    authorized_roots: &[&std::path::PathBuf],
    for_write: bool,
    create_dirs: bool,
) -> Result<std::path::PathBuf, crate::WorkerHostError> {
    let mut existing_ancestor = candidate;
    while !existing_ancestor.exists() {
        existing_ancestor = existing_ancestor.parent().ok_or_else(|| {
            broker_error("files_root_denied", "Target path has no existing ancestor")
        })?;
    }
    let canonical_ancestor = std::fs::canonicalize(existing_ancestor)
        .map_err(|error| broker_error("files_root_denied", error))?;
    if !authorized_roots
        .iter()
        .any(|root| canonical_ancestor.starts_with(root))
    {
        return Err(broker_error(
            "files_root_denied",
            "Target path escapes the plugin's authorized file roots",
        ));
    }

    if for_write {
        let parent = candidate.parent().ok_or_else(|| {
            broker_error(
                "files_root_denied",
                "Write path must have a parent directory",
            )
        })?;
        if !parent.exists() {
            if create_dirs {
                std::fs::create_dir_all(parent)
                    .map_err(|error| broker_error("files_io_error", error))?;
            } else {
                return Err(broker_error(
                    "files_parent_not_found",
                    format!("Parent directory `{}` does not exist", parent.display()),
                ));
            }
        }
        let canonical_parent = std::fs::canonicalize(parent)
            .map_err(|error| broker_error("files_root_denied", error))?;
        if !authorized_roots
            .iter()
            .any(|root| canonical_parent.starts_with(root))
        {
            return Err(broker_error(
                "files_root_denied",
                "Target parent directory escapes the plugin's authorized file roots",
            ));
        }
        let file_name = candidate.file_name().ok_or_else(|| {
            broker_error(
                "files_invalid_path",
                "Write target must include a file name",
            )
        })?;
        let resolved = canonical_parent.join(file_name);
        if resolved.exists() {
            let canonical_existing = std::fs::canonicalize(&resolved)
                .map_err(|error| broker_error("files_root_denied", error))?;
            if !authorized_roots
                .iter()
                .any(|root| canonical_existing.starts_with(root))
            {
                return Err(broker_error(
                    "files_root_denied",
                    "Target symlink escapes the plugin's authorized file roots",
                ));
            }
            return Ok(canonical_existing);
        }
        Ok(resolved)
    } else {
        if !candidate.exists() {
            return Err(broker_error(
                "files_not_found",
                format!("File or directory `{}` does not exist", candidate.display()),
            ));
        }
        let canonical_target = std::fs::canonicalize(candidate)
            .map_err(|error| broker_error("files_root_denied", error))?;
        if !authorized_roots
            .iter()
            .any(|root| canonical_target.starts_with(root))
        {
            return Err(broker_error(
                "files_root_denied",
                "Target path escapes the plugin's authorized file roots",
            ));
        }
        Ok(canonical_target)
    }
}

async fn execute_network_fetch(
    client: &reqwest::Client,
    input: Value,
) -> Result<Value, crate::WorkerHostError> {
    use base64::Engine as _;
    let url = input
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| broker_error("network_invalid_url", "url is required"))?;
    let parsed_url =
        url::Url::parse(url).map_err(|error| broker_error("network_invalid_url", error))?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err(broker_error(
            "network_invalid_url",
            "only http and https URLs are supported",
        ));
    }
    let method_str = input
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .trim()
        .to_ascii_uppercase();
    let method = reqwest::Method::from_bytes(method_str.as_bytes())
        .map_err(|error| broker_error("network_invalid_method", error))?;
    let timeout_ms = input
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(30_000)
        .clamp(100, 120_000);
    let mut request = client
        .request(method, parsed_url)
        .timeout(Duration::from_millis(timeout_ms));
    if let Some(headers) = input.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            if let Some(value_str) = value.as_str() {
                request = request.header(name.as_str(), value_str);
            }
        }
    }
    if let Some(body) = input.get("body") {
        match body {
            Value::Null => {}
            Value::String(text) => {
                request = request.body(text.clone());
            }
            other => {
                request = request
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .body(other.to_string());
            }
        }
    }
    let response = request
        .send()
        .await
        .map_err(|error| broker_error("network_request_failed", error))?;
    let status = response.status().as_u16();
    let ok = response.status().is_success();
    let status_text = response
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_owned();
    let mut response_headers = serde_json::Map::new();
    for (name, value) in response.headers() {
        if let Ok(value_str) = value.to_str() {
            response_headers.insert(
                name.as_str().to_owned(),
                Value::String(value_str.to_owned()),
            );
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| broker_error("network_request_failed", error))?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(broker_error(
            "network_response_too_large",
            "Network response exceeds 32 MiB limit",
        ));
    }
    let body = String::from_utf8_lossy(&bytes).into_owned();
    let body_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(json!({
        "status": status,
        "ok": ok,
        "statusText": status_text,
        "headers": response_headers,
        "body": body,
        "bodyText": body,
        "bodyBase64": body_base64,
    }))
}

fn schedule_preview_lease_drop(
    preview_leases: std::sync::Arc<Mutex<HashMap<String, PreviewLeaseEntry>>>,
    lease_id: String,
    expires_at_unix_ms: u64,
) -> tokio::task::AbortHandle {
    let delay = Duration::from_millis(expires_at_unix_ms.saturating_sub(unix_time_millis()));
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        preview_leases.lock().await.remove(&lease_id);
    })
    .abort_handle()
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

/// Keeps the seam's own code instead of flattening every failure into one
/// broker code, so a plugin can tell a missing preset from a broken store.
fn preset_error(error: crate::ProviderPresetError) -> crate::WorkerHostError {
    crate::WorkerHostError::broker(error.code().as_str(), error)
}

fn conversation_error(error: crate::PluginConversationError) -> crate::WorkerHostError {
    crate::WorkerHostError::broker(error.code().as_str(), error)
}

fn required_id(input: &Value, field: &str) -> Result<String, crate::WorkerHostError> {
    let value = input
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| broker_error("conversation_invalid", format!("{field} is required")))?;
    Ok(value.to_owned())
}

fn remote_error(error: crate::RemoteProfileError) -> crate::WorkerHostError {
    crate::WorkerHostError::broker(error.code().as_str(), error)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    use super::HostCapabilityBroker;
    use crate::{
        CapabilityBroker, ExternalProcessPreviewHost, PluginControlPlane, SqlitePluginRegistry,
    };

    async fn sqlite_broker() -> HostCapabilityBroker {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(":memory:"))
            .await
            .expect("memory sqlite pool");
        let control_plane = Arc::new(PluginControlPlane::new(Arc::new(
            SqlitePluginRegistry::new(pool),
        )));
        let previews = Arc::new(ExternalProcessPreviewHost::new(control_plane.clone()));
        HostCapabilityBroker::new(control_plane, previews)
    }

    #[tokio::test]
    async fn storage_kv_persists_to_sqlite_and_isolates_plugins() {
        let broker = sqlite_broker().await;

        let missing = broker
            .call(
                "vibex.git",
                1,
                "storage",
                "kv.get",
                json!({ "key": "branch" }),
            )
            .await
            .expect("kv.get missing");
        assert_eq!(missing, serde_json::Value::Null);

        let stored = broker
            .call(
                "vibex.git",
                1,
                "storage",
                "kv.put",
                json!({ "key": "branch", "value": { "name": "main", "dirty": false } }),
            )
            .await
            .expect("kv.put");
        assert_eq!(stored, json!({ "name": "main", "dirty": false }));

        broker
            .call(
                "vibex.git",
                1,
                "storage",
                "kv.put",
                json!({ "key": "stash.0", "value": "wip" }),
            )
            .await
            .expect("kv.put stash");

        broker
            .call(
                "vibex.other",
                1,
                "storage",
                "kv.put",
                json!({ "key": "branch", "value": "other-branch" }),
            )
            .await
            .expect("kv.put other");

        let read_back = broker
            .call(
                "vibex.git",
                1,
                "storage",
                "kv.get",
                json!({ "key": "branch" }),
            )
            .await
            .expect("kv.get");
        assert_eq!(read_back, json!({ "name": "main", "dirty": false }));

        let listed = broker
            .call(
                "vibex.git",
                1,
                "storage",
                "kv.list",
                json!({ "prefix": "stash." }),
            )
            .await
            .expect("kv.list prefix");
        assert_eq!(listed, json!(["stash.0"]));

        broker
            .call(
                "vibex.git",
                1,
                "storage",
                "kv.delete",
                json!({ "key": "branch" }),
            )
            .await
            .expect("kv.delete");
        let after_delete = broker
            .call(
                "vibex.git",
                1,
                "storage",
                "kv.get",
                json!({ "key": "branch" }),
            )
            .await
            .expect("kv.get after delete");
        assert_eq!(after_delete, serde_json::Value::Null);

        let other_intact = broker
            .call(
                "vibex.other",
                1,
                "storage",
                "kv.get",
                json!({ "key": "branch" }),
            )
            .await
            .expect("other plugin kv intact");
        assert_eq!(other_intact, json!("other-branch"));
    }

    #[tokio::test]
    async fn network_fetch_executes_http_requests_through_host() {
        let broker = sqlite_broker().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let mut buf = [0u8; 512];
            let _ = stream.read(&mut buf).await;
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 15\r\nconnection: close\r\n\r\n{\"hello\":\"ok!\"}",
                )
                .await
                .expect("write");
            let _ = stream.shutdown().await;
        });

        let response = broker
            .call(
                "vibex.git",
                1,
                "network",
                "fetch",
                json!({
                    "url": format!("http://{addr}/test"),
                    "method": "POST",
                    "headers": { "x-plugin": "vibex.git" },
                    "body": { "ping": true }
                }),
            )
            .await
            .expect("network.fetch");

        assert_eq!(response["status"], 200);
        assert_eq!(response["ok"], true);
        assert_eq!(response["body"], "{\"hello\":\"ok!\"}");
        assert_eq!(response["bodyText"], "{\"hello\":\"ok!\"}");
        assert!(response["bodyBase64"].as_str().is_some());
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn exec_run_and_notify_toast_execute_through_host_broker() {
        let broker = sqlite_broker().await;

        let toast = broker
            .call(
                "vibex.git",
                1,
                "app",
                "notify.toast",
                json!({
                    "title": "Git Ready",
                    "message": "Repository initialized",
                    "variant": "success"
                }),
            )
            .await
            .expect("app.notify.toast");
        assert_eq!(toast["notified"], true);
        assert_eq!(toast["title"], "Git Ready");

        let (program, args) = if cfg!(windows) {
            ("cmd", vec!["/C", "echo", "hello-exec"])
        } else {
            ("sh", vec!["-c", "echo hello-exec"])
        };

        let exec_res = broker
            .call(
                "vibex.git",
                1,
                "exec",
                "run",
                json!({
                    "program": program,
                    "args": args,
                }),
            )
            .await
            .expect("exec.run");
        assert_eq!(exec_res["success"], true);
        assert!(
            exec_res["stdout"]
                .as_str()
                .unwrap_or_default()
                .contains("hello-exec")
        );
    }

    #[tokio::test]
    async fn files_capabilities_enforce_roots_prevent_traversal_and_respect_limits() {
        use base64::Engine as _;

        let broker = sqlite_broker().await;
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace_dir = temp.path().join("workspace");
        let outside_dir = temp.path().join("outside");
        std::fs::create_dir_all(&workspace_dir).expect("create workspace");
        std::fs::create_dir_all(&outside_dir).expect("create outside");
        let outside_file = outside_dir.join("secret.txt");
        std::fs::write(&outside_file, "classified").expect("write outside");

        // Without any grant, files.* must fail closed with files_root_denied
        let denied = broker
            .call(
                "vibex.files-test",
                1,
                "files",
                "read",
                json!({ "path": "notes.txt" }),
            )
            .await
            .expect_err("ungranted plugin must be denied");
        assert_eq!(denied.code(), "files_root_denied");

        broker
            .grant_capability(
                "vibex.files-test",
                crate::HostCapabilityGrant::new(
                    "files.*",
                    json!({
                        "workspace_root": workspace_dir.to_string_lossy(),
                        "max_request_bytes": 256,
                    }),
                ),
            )
            .await;

        // 1. Atomic write with automatic parent directory creation
        let write_res = broker
            .call(
                "vibex.files-test",
                1,
                "files",
                "write",
                json!({
                    "path": "nested/dir/hello.txt",
                    "content": "hello world",
                    "encoding": "utf8",
                }),
            )
            .await
            .expect("files.write utf8");
        assert_eq!(write_res["bytesWritten"], 11);

        // 2. Read back as utf8 and base64
        let read_utf8 = broker
            .call(
                "vibex.files-test",
                1,
                "files",
                "read",
                json!({
                    "path": "nested/dir/hello.txt",
                    "encoding": "utf8",
                }),
            )
            .await
            .expect("files.read utf8");
        assert_eq!(read_utf8["content"], "hello world");
        assert_eq!(read_utf8["size"], 11);

        let read_b64 = broker
            .call(
                "vibex.files-test",
                1,
                "files",
                "read",
                json!({
                    "path": "nested/dir/hello.txt",
                    "encoding": "base64",
                }),
            )
            .await
            .expect("files.read base64");
        assert_eq!(
            read_b64["content"],
            base64::engine::general_purpose::STANDARD.encode(b"hello world")
        );

        // 3. Stat file and directory
        let stat_res = broker
            .call(
                "vibex.files-test",
                1,
                "files",
                "stat",
                json!({ "path": "nested/dir/hello.txt" }),
            )
            .await
            .expect("files.stat");
        assert_eq!(stat_res["size"], 11);
        assert_eq!(stat_res["is_file"], true);
        assert_eq!(stat_res["is_dir"], false);
        assert!(stat_res["modified_at_ms"].as_u64().unwrap_or(0) > 0);

        // 4. List directory
        let list_res = broker
            .call(
                "vibex.files-test",
                1,
                "files",
                "list",
                json!({ "path": "nested/dir" }),
            )
            .await
            .expect("files.list");
        let entries = list_res["entries"].as_array().expect("entries array");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "hello.txt");
        assert_eq!(entries[0]["is_file"], true);

        // 5. Reject `..` path traversal
        let traversal_err = broker
            .call(
                "vibex.files-test",
                1,
                "files",
                "read",
                json!({ "path": "../outside/secret.txt" }),
            )
            .await
            .expect_err("path traversal must be blocked");
        assert_eq!(traversal_err.code(), "files_root_denied");

        // 6. Reject absolute path outside authorized root
        let outside_err = broker
            .call(
                "vibex.files-test",
                1,
                "files",
                "read",
                json!({ "path": outside_file.to_string_lossy() }),
            )
            .await
            .expect_err("outside root must be blocked");
        assert_eq!(outside_err.code(), "files_root_denied");

        // 7. Enforce GrantLimits.max_request_bytes
        let oversized = "x".repeat(512);
        let limit_err = broker
            .call(
                "vibex.files-test",
                1,
                "files",
                "write",
                json!({
                    "path": "nested/oversized.txt",
                    "content": oversized,
                }),
            )
            .await
            .expect_err("oversized write must be rejected");
        assert_eq!(limit_err.code(), "files_limit_exceeded");
    }

    #[tokio::test]
    async fn secrets_capabilities_isolate_namespaces_persist_and_redact_audit_logs() {
        let broker = sqlite_broker().await;
        let super_secret = "sk-live-998877665544332211-top-secret-value";

        // Initially absent
        let initial = broker
            .call(
                "vibex.plugin-a",
                1,
                "secrets",
                "get",
                json!({ "key": "openai_api_key" }),
            )
            .await
            .expect("secrets.get initial");
        assert_eq!(initial, json!({ "present": false, "value": null }));

        // Store secret for plugin-a
        let put_res = broker
            .call(
                "vibex.plugin-a",
                1,
                "secrets",
                "put",
                json!({
                    "key": "openai_api_key",
                    "value": super_secret,
                }),
            )
            .await
            .expect("secrets.put");
        assert_eq!(put_res, json!({ "present": true }));

        // Read back from plugin-a
        let get_a = broker
            .call(
                "vibex.plugin-a",
                1,
                "secrets",
                "get",
                json!({ "key": "openai_api_key" }),
            )
            .await
            .expect("secrets.get plugin-a");
        assert_eq!(
            get_a,
            json!({
                "present": true,
                "value": super_secret,
            })
        );

        // Cross-plugin isolation: plugin-b cannot read plugin-a's secret
        let get_b = broker
            .call(
                "vibex.plugin-b",
                1,
                "secrets",
                "get",
                json!({ "key": "openai_api_key" }),
            )
            .await
            .expect("secrets.get plugin-b");
        assert_eq!(get_b, json!({ "present": false, "value": null }));

        // Verify audit logs recorded the secret key and outcome, but NEVER the plaintext secret value
        let audits = broker
            .plugins
            .audit_events("vibex.plugin-a")
            .await
            .expect("list audit");
        assert!(!audits.is_empty());
        for entry in &audits {
            let serialized = serde_json::to_string(&entry.evidence).expect("serialize evidence");
            assert!(
                !serialized.contains(super_secret),
                "Audit entry leaked plaintext secret: {serialized}"
            );
            assert_eq!(entry.evidence["secretKey"], "openai_api_key");
        }

        // Delete secret
        let delete_res = broker
            .call(
                "vibex.plugin-a",
                1,
                "secrets",
                "delete",
                json!({ "key": "openai_api_key" }),
            )
            .await
            .expect("secrets.delete");
        assert_eq!(delete_res, json!({ "present": false, "deleted": true }));

        let after_delete = broker
            .call(
                "vibex.plugin-a",
                1,
                "secrets",
                "get",
                json!({ "key": "openai_api_key" }),
            )
            .await
            .expect("secrets.get after delete");
        assert_eq!(after_delete, json!({ "present": false, "value": null }));
    }

    #[tokio::test]
    async fn events_subscribe_and_ack_track_monotonic_cursors_and_topic_filters() {
        let broker = sqlite_broker().await;

        let initial = broker
            .call("vibex.git", 1, "events", "subscribe", json!({}))
            .await
            .expect("initial subscribe");
        assert_eq!(initial["cursor"], 0);
        assert_eq!(initial["events"], json!([]));

        let c1 = broker
            .publish_event("git", "branch.changed", &json!({ "branch": "main" }))
            .await
            .expect("publish 1");
        let c2 = broker
            .publish_event("workspace", "file.saved", &json!({ "path": "src/lib.rs" }))
            .await
            .expect("publish 2");
        let c3 = broker
            .publish_event("git", "commit.created", &json!({ "sha": "abc1234" }))
            .await
            .expect("publish 3");
        assert_eq!((c1, c2, c3), (1, 2, 3));

        // Filter by topic = "git"
        let git_batch = broker
            .call(
                "vibex.git",
                1,
                "events",
                "subscribe",
                json!({ "topic": "git" }),
            )
            .await
            .expect("subscribe git topic");
        assert_eq!(git_batch["cursor"], 3);
        let events = git_batch["events"].as_array().expect("events array");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["cursor"], 1);
        assert_eq!(events[0]["eventType"], "branch.changed");
        assert_eq!(events[1]["cursor"], 3);
        assert_eq!(events[1]["eventType"], "commit.created");

        // Ack cursor 1 on topic "git"
        let ack_res = broker
            .call(
                "vibex.git",
                1,
                "events",
                "ack",
                json!({ "topic": "git", "cursor": 1 }),
            )
            .await
            .expect("ack cursor 1");
        assert_eq!(ack_res["cursor"], 1);

        // Subsequent subscribe for topic "git" without explicit cursor resumes after acked cursor 1
        let next_batch = broker
            .call(
                "vibex.git",
                1,
                "events",
                "subscribe",
                json!({ "topic": "git" }),
            )
            .await
            .expect("subscribe after ack");
        let next_events = next_batch["events"].as_array().expect("next events");
        assert_eq!(next_events.len(), 1);
        assert_eq!(next_events[0]["cursor"], 3);
        assert_eq!(next_batch["ackedCursor"], 1);
    }

    #[tokio::test]
    async fn agent_invoke_enforces_grants_visibility_and_dispatches_handlers() {
        let broker = sqlite_broker().await;

        broker
            .register_agent_handler_fn(
                "code.summarize",
                Some(vec!["vibex.authorized".to_owned()]),
                |caller, handler_id, input| async move {
                    Ok(json!({
                        "caller": caller,
                        "handler": handler_id,
                        "echo": input,
                    }))
                },
            )
            .await;

        // 1. Plugin without `agent.invoke` grant gets permission_denied
        let ungranted = broker
            .call(
                "vibex.authorized",
                1,
                "agent",
                "invoke",
                json!({
                    "handler": "code.summarize",
                    "input": { "file": "main.rs" },
                }),
            )
            .await
            .expect_err("missing grant must fail");
        assert_eq!(ungranted.code(), "permission_denied");

        // Grant `agent.invoke` to both `vibex.authorized` and `vibex.other`
        for plugin_id in ["vibex.authorized", "vibex.other"] {
            broker
                .grant_capability(
                    plugin_id,
                    crate::HostCapabilityGrant::new(
                        "agent.invoke",
                        json!({ "handlers": ["code.*"] }),
                    ),
                )
                .await;
        }

        // 2. Authorized + visible plugin succeeds
        let ok_res = broker
            .call(
                "vibex.authorized",
                1,
                "agent",
                "invoke",
                json!({
                    "handler": "code.summarize",
                    "input": { "file": "main.rs" },
                }),
            )
            .await
            .expect("authorized agent.invoke");
        assert_eq!(ok_res["caller"], "vibex.authorized");
        assert_eq!(ok_res["handler"], "code.summarize");
        assert_eq!(ok_res["echo"], json!({ "file": "main.rs" }));

        // 3. Granted plugin that is not in handler's visibility list gets handler_not_visible
        let invisible = broker
            .call(
                "vibex.other",
                1,
                "agent",
                "invoke",
                json!({
                    "handler": "code.summarize",
                    "input": { "file": "main.rs" },
                }),
            )
            .await
            .expect_err("invisible handler must fail");
        assert_eq!(invisible.code(), "handler_not_visible");
    }

    #[tokio::test]
    async fn dynamic_plugin_command_router_validates_active_generation_and_dispatches_handler() {
        let control_plane = Arc::new(PluginControlPlane::new(Arc::new(
            crate::InMemoryPluginRegistry::default(),
        )));
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("README.md"), "# Dynamic Command Test").expect("readme");
        let mut package = crate::PluginPackage::for_test(
            "vibex.dynamic-test",
            "Dynamic Command Test",
            "1.0.0",
            crate::PluginSourceKind::Snapshot,
            temp.path(),
        );
        package.invocations.push(crate::InvocationDefinition {
            id: "ping".to_owned(),
            label: "Ping".to_owned(),
            prompt: "Ping".to_owned(),
            skill: None,
            required_skills: Vec::new(),
            required_runtimes: Vec::new(),
            handler: Some("ping".to_owned()),
            artifact_intent: None,
            kind: crate::InvocationKind::Command,
        });
        control_plane
            .import(package, crate::ConflictDecision::Replace)
            .await
            .expect("import plugin");

        control_plane
            .register_command_fn(
                "vibex.dynamic-test",
                "ping",
                |plugin_id, command, input| async move {
                    Ok(json!({
                        "pluginId": plugin_id,
                        "command": command,
                        "pong": input,
                    }))
                },
            )
            .expect("register command handler");

        // While disabled / no active generation, invoking must fail with plugin_not_active
        let inactive_err = control_plane
            .invoke_plugin_command("vibex.dynamic-test", "ping", json!({ "seq": 1 }))
            .await
            .expect_err("inactive plugin command must fail");
        assert_eq!(inactive_err.code(), "plugin_not_active");

        // Enable plugin so it publishes an active generation
        control_plane
            .set_enabled("vibex.dynamic-test", true)
            .await
            .expect("enable plugin");

        // Resolve `<plugin_id>.<command_name>` dynamically
        let resolved = control_plane
            .resolve_dynamic_command_target("vibex.dynamic-test.ping")
            .await
            .expect("resolve dynamic command")
            .expect("matched target");
        assert_eq!(
            resolved,
            ("vibex.dynamic-test".to_owned(), "ping".to_owned())
        );

        let result = control_plane
            .invoke_plugin_command(&resolved.0, &resolved.1, json!({ "seq": 42 }))
            .await
            .expect("invoke active plugin command");
        assert_eq!(
            result,
            json!({
                "pluginId": "vibex.dynamic-test",
                "command": "ping",
                "pong": { "seq": 42 },
            })
        );
    }

    #[tokio::test]
    async fn dynamic_plugin_command_router_forwards_to_active_worker_slot() {
        let Some(node) = std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
                .find(|candidate| candidate.is_file())
        }) else {
            return;
        };
        let control_plane = Arc::new(PluginControlPlane::new(Arc::new(
            crate::InMemoryPluginRegistry::default(),
        )));
        let previews = Arc::new(ExternalProcessPreviewHost::new(control_plane.clone()));
        let broker = Arc::new(HostCapabilityBroker::new(control_plane.clone(), previews));
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            temp.path().join("worker.mjs"),
            r#"import{createInterface}from'node:readline';for await(const l of createInterface({input:process.stdin})){const m=JSON.parse(l);const result=m.method==='initialize'?{protocolVersion:'1.1',sdkVersion:'1.0.0',registrations:['rpc.echo'],requestedFeatures:[]}:m.method==='activate'?{handlers:['rpc.echo']}:m.method==='invoke'?{slotHandled:true,handler:m.params?.handler,echo:m.params?.input}:null;console.log(JSON.stringify({id:m.id,ok:true,result}));}"#,
        )
        .expect("write worker.mjs");

        let mut package = crate::PluginPackage::for_test(
            "vibex.worker-rpc",
            "Worker RPC Test",
            "1.0.0",
            crate::PluginSourceKind::DeveloperLink,
            temp.path(),
        );
        package.entrypoints.worker = Some("worker.mjs".to_owned());
        package.invocations.push(crate::InvocationDefinition {
            id: "rpc.echo".to_owned(),
            label: "Echo".to_owned(),
            prompt: "Echo".to_owned(),
            skill: None,
            required_skills: Vec::new(),
            required_runtimes: Vec::new(),
            handler: Some("rpc.echo".to_owned()),
            artifact_intent: None,
            kind: crate::InvocationKind::Command,
        });

        control_plane
            .import(package, crate::ConflictDecision::Replace)
            .await
            .expect("import worker plugin");
        control_plane
            .activate_and_enable(&node, "vibex.worker-rpc", &[], broker.clone())
            .await
            .expect("activate worker plugin");

        let resolved = control_plane
            .resolve_dynamic_command_target("vibex.worker-rpc.rpc.echo")
            .await
            .expect("resolve worker command")
            .expect("matched worker target");
        assert_eq!(
            resolved,
            ("vibex.worker-rpc".to_owned(), "rpc.echo".to_owned())
        );

        let response = control_plane
            .invoke_plugin_command(&resolved.0, &resolved.1, json!({ "hello": "worker" }))
            .await
            .expect("invoke worker slot command");
        assert_eq!(response["slotHandled"], true);
        assert_eq!(response["handler"], "rpc.echo");
        assert_eq!(response["echo"], json!({ "hello": "worker" }));

        control_plane
            .deactivate_worker("vibex.worker-rpc")
            .await
            .expect("deactivate worker");
    }
}
