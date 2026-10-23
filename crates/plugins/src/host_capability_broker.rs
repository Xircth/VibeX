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

pub struct HostCapabilityBroker {
    plugins: Arc<crate::PluginControlPlane>,
    previews: Arc<dyn crate::PluginPreviewHost>,
    provider_presets: Arc<dyn crate::ProviderPresetHost>,
    remote_profiles: Arc<dyn crate::RemoteProfileHost>,
    bind_prompts: Arc<crate::ProviderBindPrompts>,
    conversations: Arc<dyn crate::PluginConversationHost>,
    browser: Arc<browser_host::BrowserService>,
    artifacts: Mutex<HashMap<String, ArtifactAuthorization>>,
    preview_leases: Arc<Mutex<HashMap<String, crate::ActivationLease>>>,
    spawned_processes: Mutex<HashMap<String, SpawnedPluginProcess>>,
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
        Self {
            plugins,
            previews,
            provider_presets,
            remote_profiles,
            bind_prompts,
            conversations: Arc::new(crate::UnavailablePluginConversationHost),
            browser: Arc::new(browser_host::BrowserService::unavailable()),
            artifacts: Mutex::new(HashMap::new()),
            preview_leases: Arc::new(Mutex::new(HashMap::new())),
            spawned_processes: Mutex::new(HashMap::new()),
        }
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
        if let Some(lease_id) = lease_id {
            self.preview_leases.lock().await.remove(lease_id);
        }
        result
    }

    pub async fn renew_preview(
        &self,
        lease_id: &str,
    ) -> Result<crate::PluginPreviewSession, crate::PluginPreviewHostError> {
        let lease = self.previews.renew_preview(lease_id).await?;
        if self
            .preview_leases
            .lock()
            .await
            .contains_key(&lease.lease_id)
        {
            schedule_preview_lease_drop(
                self.preview_leases.clone(),
                lease.lease_id.clone(),
                lease.expires_at_unix_ms,
            );
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
        self.preview_leases
            .lock()
            .await
            .insert(lease.lease_id.clone(), activation_lease);
        schedule_preview_lease_drop(
            self.preview_leases.clone(),
            lease.lease_id.clone(),
            lease.expires_at_unix_ms,
        );
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
                Ok(input)
            }
            "secrets.get" => Ok(json!({ "present": false })),
            "secrets.put" | "secrets.delete" => Ok(json!({ "present": false })),
            "network.fetch" => execute_network_fetch(input).await,
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
}

async fn execute_network_fetch(input: Value) -> Result<Value, crate::WorkerHostError> {
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
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| broker_error("network_request_failed", error))?;
    let mut request = client.request(method, parsed_url);
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
    preview_leases: std::sync::Arc<Mutex<HashMap<String, crate::ActivationLease>>>,
    lease_id: String,
    expires_at_unix_ms: u64,
) {
    let delay = Duration::from_millis(expires_at_unix_ms.saturating_sub(unix_time_millis()));
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        preview_leases.lock().await.remove(&lease_id);
    });
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
}
