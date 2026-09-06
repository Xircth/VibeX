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
    provider_presets: Arc<dyn crate::ProviderPresetHost>,
    remote_profiles: Arc<dyn crate::RemoteProfileHost>,
    bind_prompts: Arc<crate::ProviderBindPrompts>,
    conversations: Arc<dyn crate::PluginConversationHost>,
    artifacts: Mutex<HashMap<String, ArtifactAuthorization>>,
    preview_leases: Arc<Mutex<HashMap<String, crate::ActivationLease>>>,
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
            artifacts: Mutex::new(HashMap::new()),
            preview_leases: Arc::new(Mutex::new(HashMap::new())),
        }
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
            "artifact.preview" => self.open_preview(plugin_id, generation, input).await,
            "provider.presets" => {
                self.call_provider_presets(plugin_id, operation, input)
                    .await
            }
            "remote" => self.call_remote(plugin_id, operation, input).await,
            "conversation" => self.call_conversation(plugin_id, operation, input).await,
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
