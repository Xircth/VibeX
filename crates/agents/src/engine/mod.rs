//! First-party native engine driver boundary for flagship agents (`ClaudeNative`, `CodexNative`).
//!
//! Provides direct control-plane access to rate-limit push events, prompt cache TTL
//! synthesis, native steering, session forking, and atomic session+file rewind while
//! keeping long-tail agents on ACP.

pub mod claude;
pub mod claude_events;
pub mod codex;
pub mod codex_protocol;
pub mod descriptor;
pub mod registry;
pub mod stream_router;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, RwLock},
    time::Duration,
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
pub use claude::{ClaudeNativeDriver, ClaudeSidecarClient};
pub use codex::{
    CodexAppServer, CodexAutoCompactionThreadState, CodexNativeDriver, CodexServerCacheKey,
    CodexTurnRecord,
};
pub use descriptor::{
    EngineRuntimePreference, NativeEngineDescriptor, NativeEngineKind, resolve_native_engine_kind,
    resolve_native_engine_kind_with_env,
};
use futures::Stream;
pub use registry::{EngineRegistry, invalidate_engine_caches_for_agent};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
pub use stream_router::{
    MAX_DIAGNOSTIC_PAYLOAD_BYTES, TurnEventRouter, TurnEventStream, TurnRouteFilter,
    format_bounded_diagnostic, prepare_instance_isolation_env,
    prepare_instance_isolation_env_for_keys, truncate_utf8_bytes,
};
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::conversation::ContentBlock;
pub use crate::end_turn_usage::{ModelConsistencyMismatch, check_launch_vs_served_model};

/// Serializes `message` as a single newline-delimited JSON-RPC 2.0 frame and
/// writes it to `writer`, flushing afterwards. Shared by both the Claude
/// sidecar client and the Codex app-server client.
pub(crate) async fn write_jsonrpc_frame(
    writer: &AsyncMutex<Box<dyn AsyncWrite + Unpin + Send>>,
    message: &serde_json::Value,
) -> Result<(), EngineError> {
    let mut encoded = serde_json::to_vec(message)?;
    encoded.push(b'\n');
    let mut guard = writer.lock().await;
    guard.write_all(&encoded).await?;
    guard.flush().await?;
    Ok(())
}

/// Stream of normalized events emitted during a native engine turn or session.
pub type EngineEventStream = Pin<Box<dyn Stream<Item = EngineEvent> + Send>>;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("Native engine binary or runtime not found: {0}")]
    BinaryNotFound(String),

    #[error("Managed toolchain failed while preparing native engine: {0}")]
    Toolchain(#[from] crate::managed_toolchain::ManagedToolchainError),

    #[error("Failed to spawn or communicate with native engine process: {0}")]
    Transport(String),

    #[error("Native engine JSON-RPC error ({code}): {message}")]
    Rpc { code: i64, message: String },

    #[error("Native engine request `{method}` timed out after {timeout_ms}ms")]
    Timeout { method: String, timeout_ms: u64 },

    #[error("Unknown or disconnected native engine handle `{0}`")]
    UnknownHandle(Uuid),

    #[error("Invalid engine request: {0}")]
    InvalidRequest(String),

    #[error("Native engine operation `{0}` is unsupported")]
    Unsupported(String),

    #[error("I/O error in native engine driver: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON serialization error in native engine driver: {0}")]
    Json(#[from] serde_json::Error),
}

/// Authentication material resolved prior to launching a native engine connection.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EngineAuth {
    #[default]
    Ambient,
    ApiKey {
        api_key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_url: Option<String>,
    },
    OAuth {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        oauth_token: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account_email: Option<String>,
    },
}

impl EngineAuth {
    /// Returns `true` strictly when targeting official Anthropic infrastructure
    /// rather than a third-party custom proxy endpoint.
    pub fn is_official_anthropic_session(
        &self,
        env: &HashMap<String, String>,
        config_overrides: &serde_json::Value,
    ) -> bool {
        if config_overrides
            .get("isThirdPartyProxy")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            return false;
        }

        let candidate_url = match self {
            EngineAuth::ApiKey {
                base_url: Some(url),
                ..
            } => Some(url.as_str()),
            _ => None,
        }
        .or_else(|| {
            config_overrides
                .get("anthropicBaseUrl")
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            config_overrides
                .get("baseUrl")
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| env.get("ANTHROPIC_BASE_URL").map(String::as_str));

        let Some(raw_url) = candidate_url.map(str::trim).filter(|s| !s.is_empty()) else {
            return true;
        };

        let Ok(parsed) = url::Url::parse(raw_url) else {
            return false;
        };
        let Some(host) = parsed.host_str() else {
            return false;
        };
        let lower = host.to_ascii_lowercase();
        lower == "api.anthropic.com" || lower.ends_with(".anthropic.com")
    }
}

/// Returns `true` when `raw` is empty or holds a pre-turn placeholder session identifier
/// that must never be sent upstream as an existing Claude `session_id` or Codex `threadId`.
pub fn is_placeholder_engine_session_id(raw: &str) -> bool {
    let trimmed = raw.trim();
    trimmed.is_empty()
        || trimmed.starts_with("prepared-")
        || trimmed.starts_with("pending-")
        || trimmed.starts_with("dimo-new-session-")
        || trimmed.starts_with("claude-native-")
        || trimmed.starts_with("codex-native-")
}

/// Model metadata surfaced by native engine `initialize` or `model/list` queries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineModelInfo {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_default: bool,
}

/// Structured plan/todo entry normalized from Claude `TodoWrite` or Codex `turn/plan/updated`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnginePlanEntry {
    pub content: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
}

/// Parameters required to start or bind a native engine connection for a workspace.
#[derive(Debug, Clone, Default)]
pub struct EngineStartSpec {
    pub workspace_id: Uuid,
    pub working_dir: PathBuf,
    pub provider_instance_id: Option<String>,
    pub isolate_profile: bool,
    pub auth: EngineAuth,
    pub model: Option<String>,
    pub config_overrides: serde_json::Value,
    pub env: HashMap<String, String>,
    pub scrubbed_env_keys: Vec<String>,
    pub additional_directories: Vec<PathBuf>,
    pub mcp_servers: serde_json::Value,
}

const AUTH_FINGERPRINT_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "CODEX_ACCESS_TOKEN",
    "CODEX_API_KEY",
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
];

fn feed_length_prefixed(hasher: &mut Sha256, tag: &str, value: &str) {
    hasher.update(tag.as_bytes());
    hasher.update(b":");
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value.as_bytes());
    hasher.update([0xff]);
}

impl EngineStartSpec {
    /// Deterministic SHA-256 hex digest over authentication material, custom endpoints,
    /// and credential environment overrides without retaining or exposing plaintext secrets.
    pub fn auth_fingerprint(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"dimo-engine-auth-v1\0");

        match &self.auth {
            EngineAuth::Ambient => {
                feed_length_prefixed(&mut hasher, "auth.kind", "ambient");
            }
            EngineAuth::ApiKey { api_key, base_url } => {
                feed_length_prefixed(&mut hasher, "auth.kind", "api_key");
                feed_length_prefixed(&mut hasher, "auth.api_key", api_key);
                feed_length_prefixed(
                    &mut hasher,
                    "auth.base_url",
                    base_url.as_deref().unwrap_or(""),
                );
            }
            EngineAuth::OAuth {
                oauth_token,
                account_email,
            } => {
                feed_length_prefixed(&mut hasher, "auth.kind", "oauth");
                feed_length_prefixed(
                    &mut hasher,
                    "auth.oauth_token",
                    oauth_token.as_deref().unwrap_or(""),
                );
                feed_length_prefixed(
                    &mut hasher,
                    "auth.account_email",
                    account_email.as_deref().unwrap_or(""),
                );
            }
        }

        for key in AUTH_FINGERPRINT_ENV_KEYS {
            if let Some(val) = self.env.get(*key) {
                feed_length_prefixed(&mut hasher, key, val);
            }
        }

        for field in [
            "baseUrl",
            "anthropicBaseUrl",
            "openaiBaseUrl",
            "isThirdPartyProxy",
        ] {
            if let Some(val) = self.config_overrides.get(field) {
                feed_length_prefixed(&mut hasher, field, &val.to_string());
            }
        }

        let digest = hasher.finalize();
        let mut hex = String::with_capacity(64);
        for byte in digest {
            use std::fmt::Write as _;
            let _ = write!(&mut hex, "{byte:02x}");
        }
        hex
    }

    /// Returns `true` when this launch targets a non-official custom `base_url` / proxy.
    pub fn uses_custom_base_url(&self, kind: NativeEngineKind) -> bool {
        match kind {
            NativeEngineKind::ClaudeNative => {
                !self
                    .auth
                    .is_official_anthropic_session(&self.env, &self.config_overrides)
            }
            NativeEngineKind::CodexNative => {
                if self
                    .config_overrides
                    .get("isThirdPartyProxy")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    return true;
                }
                let candidate = match &self.auth {
                    EngineAuth::ApiKey {
                        base_url: Some(url),
                        ..
                    } => Some(url.as_str()),
                    _ => None,
                }
                .or_else(|| {
                    self.config_overrides
                        .get("openaiBaseUrl")
                        .and_then(serde_json::Value::as_str)
                })
                .or_else(|| {
                    self.config_overrides
                        .get("baseUrl")
                        .and_then(serde_json::Value::as_str)
                })
                .or_else(|| self.env.get("OPENAI_BASE_URL").map(String::as_str));

                let Some(raw_url) = candidate.map(str::trim).filter(|s| !s.is_empty()) else {
                    return false;
                };
                let Ok(parsed) = url::Url::parse(raw_url) else {
                    return true;
                };
                let Some(host) = parsed.host_str() else {
                    return true;
                };
                let lower = host.to_ascii_lowercase();
                !(lower == "api.openai.com"
                    || lower.ends_with(".openai.com")
                    || lower == "chatgpt.com"
                    || lower.ends_with(".chatgpt.com"))
            }
        }
    }

    fn resolve_home_dir(&self) -> Option<PathBuf> {
        resolve_home_dir_from_env(&self.env)
    }

    /// Resolves the effective `CODEX_HOME` directory visible to a `CodexNativeDriver` session.
    pub fn effective_codex_home(&self) -> Option<PathBuf> {
        if let Some(explicit) = self
            .env
            .get("CODEX_HOME")
            .map(String::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(PathBuf::from(explicit));
        }
        if self.isolate_profile
            && let Some(instance_id) = self
                .provider_instance_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        {
            let root_base = self
                .env
                .get("DIMO_PROVIDER_INSTANCES_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| std::env::temp_dir().join("dimo-provider-instances"));
            return Some(
                root_base
                    .join(stream_router::sanitize_instance_dir_segment(instance_id))
                    .join("codex-home"),
            );
        }
        self.resolve_home_dir().map(|home| home.join(".codex"))
    }

    /// Resolves the effective `~/.claude` (or `CLAUDE_CONFIG_DIR`) directory visible to
    /// a `ClaudeNativeDriver` session.
    pub fn effective_claude_config_dir(&self) -> Option<PathBuf> {
        if let Some(explicit) = self
            .env
            .get("CLAUDE_CONFIG_DIR")
            .map(String::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(PathBuf::from(explicit));
        }
        if self.isolate_profile
            && let Some(instance_id) = self
                .provider_instance_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        {
            let root_base = self
                .env
                .get("DIMO_PROVIDER_INSTANCES_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|| std::env::temp_dir().join("dimo-provider-instances"));
            return Some(
                root_base
                    .join(stream_router::sanitize_instance_dir_segment(instance_id))
                    .join("claude-config"),
            );
        }
        self.resolve_home_dir().map(|home| home.join(".claude"))
    }

    /// Deterministic SHA-256 hex digest over native Codex configuration/catalog/auth files
    /// (`config.toml`, `auth.json`, `dimo-model-catalog.json`, or `model_catalog_json` target)
    /// so `CodexAppServer` pooling invalidates automatically when native files change.
    pub fn native_codex_config_fingerprint(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"dimo-codex-native-config-v1\0");
        if let Some(codex_home) = self.effective_codex_home() {
            feed_length_prefixed(&mut hasher, "codex_home", &codex_home.to_string_lossy());
            let config_path = codex_home.join("config.toml");
            let config_bytes = std::fs::read(&config_path).ok();
            hash_optional_file_bytes(&mut hasher, "config.toml", config_bytes.as_deref());
            let auth_bytes = std::fs::read(codex_home.join("auth.json")).ok();
            hash_optional_file_bytes(&mut hasher, "auth.json", auth_bytes.as_deref());
            let dimo_catalog = std::fs::read(codex_home.join("dimo-model-catalog.json")).ok();
            hash_optional_file_bytes(
                &mut hasher,
                "dimo-model-catalog.json",
                dimo_catalog.as_deref(),
            );
            if let Some(catalog_rel) = config_bytes
                .as_deref()
                .and_then(|raw| std::str::from_utf8(raw).ok())
                .and_then(|text| text.parse::<toml::Table>().ok())
                .and_then(|table| {
                    table
                        .get("model_catalog_json")
                        .and_then(toml::Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && *s != "dimo-model-catalog.json")
                        .map(str::to_string)
                })
            {
                let catalog_path = PathBuf::from(&catalog_rel);
                let resolved = if catalog_path.is_absolute() {
                    catalog_path
                } else {
                    codex_home.join(catalog_path)
                };
                let extra_bytes = std::fs::read(&resolved).ok();
                hash_optional_file_bytes(&mut hasher, "custom_catalog", extra_bytes.as_deref());
            }
        }
        let digest = hasher.finalize();
        let mut hex = String::with_capacity(64);
        for byte in digest {
            use std::fmt::Write as _;
            let _ = write!(&mut hex, "{byte:02x}");
        }
        hex
    }
}

pub(crate) fn resolve_home_dir_from_env(env: &HashMap<String, String>) -> Option<PathBuf> {
    ["USERPROFILE", "HOME"]
        .into_iter()
        .find_map(|key| {
            env.get(key)
                .map(String::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| {
            ["USERPROFILE", "HOME"].into_iter().find_map(|key| {
                std::env::var_os(key)
                    .filter(|v| !v.is_empty())
                    .map(PathBuf::from)
            })
        })
        .or_else(dirs::home_dir)
}

fn hash_optional_file_bytes(hasher: &mut Sha256, tag: &str, bytes: Option<&[u8]>) {
    hasher.update(tag.as_bytes());
    match bytes {
        Some(content) => {
            hasher.update(b":present:");
            hasher.update((content.len() as u64).to_le_bytes());
            hasher.update(content);
        }
        None => {
            hasher.update(b":absent");
        }
    }
    hasher.update([0xff]);
}

/// Handle to a live native engine session managed by a [`NativeEngineDriver`].
#[derive(Debug, Clone)]
pub struct EngineHandle {
    pub connection_id: Uuid,
    pub engine_id: String,
    pub engine_kind: Option<NativeEngineKind>,
    pub workspace_id: Uuid,
    pub working_dir: PathBuf,
    pub official_session: bool,
    external_session_id: Arc<RwLock<Option<String>>>,
}

impl EngineHandle {
    pub fn new(
        connection_id: Uuid,
        engine_kind: NativeEngineKind,
        workspace_id: Uuid,
        working_dir: PathBuf,
        official_session: bool,
        initial_session_id: Option<String>,
    ) -> Self {
        Self {
            connection_id,
            engine_id: engine_kind.engine_id().to_string(),
            engine_kind: Some(engine_kind),
            workspace_id,
            working_dir,
            official_session,
            external_session_id: Arc::new(RwLock::new(initial_session_id)),
        }
    }

    pub fn for_engine(
        connection_id: Uuid,
        engine_id: impl Into<String>,
        workspace_id: Uuid,
        working_dir: PathBuf,
        official_session: bool,
        initial_session_id: Option<String>,
    ) -> Self {
        let engine_id = engine_id.into();
        let engine_kind = match engine_id.as_str() {
            "claude-native" => Some(NativeEngineKind::ClaudeNative),
            "codex-native" => Some(NativeEngineKind::CodexNative),
            _ => None,
        };
        Self {
            connection_id,
            engine_id,
            engine_kind,
            workspace_id,
            working_dir,
            official_session,
            external_session_id: Arc::new(RwLock::new(initial_session_id)),
        }
    }

    pub fn external_session_id(&self) -> Option<String> {
        self.external_session_id
            .read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    pub fn set_external_session_id(&self, session_id: Option<String>) {
        if let Ok(mut guard) = self.external_session_id.write() {
            *guard = session_id;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptMode {
    #[default]
    Normal,
    Steer,
    Compact,
}

#[derive(Debug, Clone, Default)]
pub struct EnginePromptRequest {
    pub prompt_id: Uuid,
    pub blocks: Vec<ContentBlock>,
    pub session_id: Option<String>,
    pub mode: PromptMode,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub mcp_servers: Option<serde_json::Value>,
    pub additional_directories: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct EngineSteerRequest {
    pub steering_id: Uuid,
    pub expected_prompt_id: Option<Uuid>,
    pub session_id: Option<String>,
    pub blocks: Vec<ContentBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum EngineSteerReceipt {
    Accepted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        delivery_mode: String,
    },
    Rejected {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Default)]
pub struct EngineForkRequest {
    pub source_session_id: Option<String>,
    pub new_session_id: Option<String>,
    pub checkpoint_point: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineForkReceipt {
    pub source_session_id: String,
    pub forked_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_point: Option<String>,
}

#[derive(Debug, Clone)]
pub struct EnginePermissionDecision {
    pub permission_id: String,
    pub approved: bool,
    pub option_id: Option<String>,
    pub updated_input: Option<serde_json::Value>,
    pub message: Option<String>,
    pub interrupt: bool,
}

/// Target point for atomic engine + Git rewind (Phase 1.4).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCheckpoint {
    pub turn_ordinal: i32,
    pub git_ref: Option<String>,
    pub commit_oid: Option<String>,
    /// Engine-native rollback cursor (`beforeTurnId` on Codex, `resumeSessionAt` UUID on Claude).
    pub external_session_point: Option<String>,
    pub session_id: Option<String>,
}

/// Live rate-limit telemetry normalized from `account/rateLimits/updated` (Codex)
/// or `SDKRateLimitInfo` (Claude).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineRateLimits {
    pub requests_remaining: Option<i64>,
    pub tokens_remaining: Option<i64>,
    pub reset_at: Option<DateTime<Utc>>,
    pub credits_remaining: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utilization: Option<f64>,
}

/// Prompt cache telemetry synthesized strictly for official Anthropic sessions.
/// Raw token counts stay `None` when omitted by commercial SDK policy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCacheStatus {
    pub prompt_cache_ttl_remaining: Option<Duration>,
    pub prompt_cache_expires_at: Option<DateTime<Utc>>,
    pub cache_creation_input_tokens: Option<i64>,
    pub cache_read_input_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_ttl_tier: Option<String>,
}

/// Normalized event stream emitted by both `CodexNativeDriver` and `ClaudeNativeDriver`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EngineEvent {
    SessionInitialized {
        session_id: Option<String>,
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        slash_commands: Vec<String>,
    },
    TurnStarted {
        prompt_id: Option<String>,
        turn_id: Option<String>,
        session_id: Option<String>,
    },
    AssistantTextDelta {
        prompt_id: Option<String>,
        session_id: Option<String>,
        message_id: Option<String>,
        text: String,
    },
    ThinkingDelta {
        prompt_id: Option<String>,
        session_id: Option<String>,
        message_id: Option<String>,
        thinking: String,
    },
    AssistantMessage {
        prompt_id: Option<String>,
        session_id: Option<String>,
        message_id: Option<String>,
        text: String,
    },
    ToolCall {
        prompt_id: Option<String>,
        session_id: Option<String>,
        parent_tool_use_id: Option<String>,
        tool_use_id: Option<String>,
        tool_name: String,
        input: serde_json::Value,
    },
    ToolResult {
        prompt_id: Option<String>,
        session_id: Option<String>,
        parent_tool_use_id: Option<String>,
        tool_use_id: Option<String>,
        is_error: bool,
        content: serde_json::Value,
    },
    TerminalOutputDelta {
        prompt_id: Option<String>,
        session_id: Option<String>,
        call_id: Option<String>,
        delta: String,
    },
    PermissionRequested {
        permission_id: String,
        prompt_id: Option<String>,
        session_id: Option<String>,
        tool_name: String,
        input: serde_json::Value,
        decision_reason: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        options: Vec<crate::permissions::AgentPermissionOption>,
    },
    PermissionResolved {
        permission_id: String,
        prompt_id: Option<String>,
        session_id: Option<String>,
        behavior: String,
    },
    QuestionRequested {
        request_id: String,
        prompt_id: Option<String>,
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
        questions: serde_json::Value,
    },
    PlanUpdated {
        prompt_id: Option<String>,
        session_id: Option<String>,
        entries: Vec<EnginePlanEntry>,
    },
    UsageUpdated {
        prompt_id: Option<String>,
        session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_read_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_write_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context_window: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    SubagentSpawned {
        prompt_id: Option<String>,
        session_id: Option<String>,
        subagent_id: String,
        parent_tool_use_id: Option<String>,
        subagent_type: Option<String>,
        description: Option<String>,
    },
    SubagentUpdated {
        prompt_id: Option<String>,
        session_id: Option<String>,
        subagent_id: String,
        text_delta: String,
    },
    SubagentCompleted {
        prompt_id: Option<String>,
        session_id: Option<String>,
        subagent_id: String,
        status: String,
        summary: Option<String>,
    },
    HookEvent {
        prompt_id: Option<String>,
        session_id: Option<String>,
        hook_name: String,
        payload: serde_json::Value,
    },
    PromptSteered {
        prompt_id: Option<String>,
        session_id: Option<String>,
    },
    RateLimitsUpdated {
        session_id: Option<String>,
        rate_limits: EngineRateLimits,
    },
    CacheStatusUpdated {
        session_id: Option<String>,
        cache_status: EngineCacheStatus,
    },
    AutoCompactionChanged {
        session_id: Option<String>,
        in_progress: bool,
    },
    SessionForked {
        source_session_id: String,
        session_id: String,
        checkpoint_point: Option<String>,
    },
    SessionReverted {
        session_id: String,
        checkpoint_point: Option<String>,
    },
    TurnCompleted {
        prompt_id: Option<String>,
        turn_id: Option<String>,
        session_id: Option<String>,
        stop_reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        served_model: Option<String>,
    },
    TurnInterrupted {
        prompt_id: Option<String>,
        session_id: Option<String>,
        reason: String,
    },
    TurnError {
        prompt_id: Option<String>,
        session_id: Option<String>,
        message: String,
    },
}

/// Protocol-neutral selectable choice for session control dropdowns (mode / effort).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSelectChoice {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Engine-declared session mode options and canonical default / YOLO mode identifiers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineModeSpec {
    pub modes: Vec<EngineSelectChoice>,
    pub default_mode_id: String,
    pub yolo_mode_id: String,
}

/// Engine-declared reasoning effort selector specification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineEffortSpec {
    pub choices: Vec<EngineSelectChoice>,
    pub default_value: String,
}

/// Engine-declared slash command advertised before session initialization pushes runtime commands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineCommandSpec {
    pub name: String,
    pub description: String,
}

/// Full capability & control-plane specification advertised by a [`NativeEngineDriver`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineCapabilities {
    pub engine_id: String,
    pub supports_native_steer: bool,
    pub supports_native_revert: bool,
    pub supports_native_fork: bool,
    pub supports_rate_limit_push: bool,
    pub supports_prompt_cache_ttl: bool,
    pub records_idle_compaction_activity: bool,
    pub modes: EngineModeSpec,
    pub effort: Option<EngineEffortSpec>,
    pub default_commands: Vec<EngineCommandSpec>,
}

/// Normalized UI classification & optional vendor metadata for a native tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineToolClassification {
    pub semantic_kind: String,
    pub title: String,
    pub meta: Option<Value>,
}

/// Shared baseline tool classification for native engines (`mcp__<server>__<tool>`,
/// shell, edit, read, search, fetch, plan, subagent).
pub fn classify_standard_tool_call(raw_name: &str, input: &Value) -> EngineToolClassification {
    if let Some(mcp_rest) = raw_name.strip_prefix("mcp__") {
        let mut parts = mcp_rest.splitn(2, "__");
        let server = parts.next().unwrap_or("");
        let tool = parts.next().unwrap_or(mcp_rest);
        let mut meta = Map::new();
        meta.insert(
            "mcp".to_string(),
            json!({
                "server": server,
                "tool": tool,
            }),
        );
        let title = if server.is_empty() {
            tool.to_string()
        } else {
            format!("{server} / {tool}")
        };
        return EngineToolClassification {
            semantic_kind: "other".to_string(),
            title,
            meta: Some(Value::Object(meta)),
        };
    }

    let (semantic_kind, title) = match raw_name {
        "Bash" | "commandExecution" | "shell" | "exec_command" => {
            let cmd = input
                .get("command")
                .and_then(|v| {
                    v.as_str().map(str::to_string).or_else(|| {
                        v.as_array().map(|arr| {
                            arr.iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                    })
                })
                .or_else(|| input.get("description").and_then(Value::as_str).map(str::to_string))
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| raw_name.to_string());
            ("execute".to_string(), cmd)
        }
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" | "fileChange" | "apply_patch" => {
            let path = input
                .get("file_path")
                .or_else(|| input.get("notebook_path"))
                .or_else(|| input.get("path"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    input
                        .get("changes")
                        .and_then(Value::as_array)
                        .and_then(|arr| arr.first())
                        .and_then(|c| c.get("path").or_else(|| c.get("filePath")))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            let title = match path {
                Some(p) if !p.is_empty() => format!("{raw_name} {p}"),
                _ => raw_name.to_string(),
            };
            ("edit".to_string(), title)
        }
        "Read" | "imageView" => {
            let path = input
                .get("file_path")
                .or_else(|| input.get("path"))
                .and_then(Value::as_str);
            let title = match path {
                Some(p) if !p.is_empty() => format!("Read {p}"),
                _ => raw_name.to_string(),
            };
            ("read".to_string(), title)
        }
        "Grep" | "Glob" | "ToolSearch" => {
            let pattern = input
                .get("pattern")
                .or_else(|| input.get("query"))
                .and_then(Value::as_str);
            let title = match pattern {
                Some(p) if !p.is_empty() => format!("{raw_name} {p}"),
                _ => raw_name.to_string(),
            };
            ("search".to_string(), title)
        }
        "WebFetch" | "WebSearch" | "webSearch" => {
            let target = input
                .get("url")
                .or_else(|| input.get("query"))
                .and_then(Value::as_str);
            let title = match target {
                Some(t) if !t.is_empty() => format!("{raw_name} {t}"),
                _ => raw_name.to_string(),
            };
            ("fetch".to_string(), title)
        }
        "TodoWrite" => ("think".to_string(), "Update Plan".to_string()),
        "Task" | "Agent" | "collabAgentToolCall" => {
            let desc = input
                .get("description")
                .or_else(|| input.get("prompt"))
                .and_then(Value::as_str)
                .map(|s| s.chars().take(80).collect::<String>())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "Subagent".to_string());
            ("other".to_string(), desc)
        }
        _ => ("other".to_string(), raw_name.to_string()),
    };

    EngineToolClassification {
        semantic_kind,
        title,
        meta: None,
    }
}

#[async_trait]
pub trait NativeEngineDriver: Send + Sync + 'static {
    /// Stable identifier of the native engine (`"claude-native"`, `"codex-native"`, etc.).
    fn engine_id(&self) -> &str;

    /// Optional typed legacy engine kind for built-in flagship profiles.
    fn kind(&self) -> Option<NativeEngineKind> {
        None
    }

    /// Static legacy capability descriptor when backed by a built-in [`NativeEngineKind`].
    fn descriptor(&self) -> Option<NativeEngineDescriptor> {
        self.kind().map(NativeEngineDescriptor::for_kind)
    }

    /// Returns `true` when this driver handles the given agent kind or profile identifier.
    fn supports_agent(&self, agent_kind_or_id: &str) -> bool;

    /// Full capability & control-plane specification advertised to the runtime runner.
    fn capabilities(&self) -> EngineCapabilities;

    /// Normalizes a requested or preferred session mode string to one of this driver's mode IDs.
    fn normalize_mode(&self, raw: &str) -> Option<String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        let mode_spec = self.capabilities().modes;
        if trimmed == "yolo" {
            return Some(mode_spec.yolo_mode_id);
        }
        mode_spec
            .modes
            .into_iter()
            .find(|choice| choice.id == trimmed)
            .map(|choice| choice.id)
    }

    /// Resolves authentication material from sanitized launch environment variables.
    fn resolve_auth(&self, _env: &HashMap<String, String>) -> EngineAuth {
        EngineAuth::Ambient
    }

    /// Applies engine-specific launch environment preparation and parent-env scrubbing.
    fn prepare_launch_env(
        &self,
        _locked_program: &Path,
        _snapshot_env: &HashMap<String, String>,
        _launch_env: &mut HashMap<String, String>,
        _scrubbed_keys: &mut Vec<String>,
    ) {
    }

    /// Optional `(env_var_key, dir_name)` pair used for per-instance profile isolation.
    fn profile_isolation_dir(&self) -> Option<(&'static str, &'static str)> {
        None
    }

    /// Returns `true` when `spec` routes traffic through a third-party proxy / custom base URL.
    fn uses_custom_base_url(&self, _spec: &EngineStartSpec) -> bool {
        false
    }

    /// Resolves the engine's native default model from local configuration when `DIMO_DEFAULT_MODEL` is unset.
    fn resolve_default_model(&self, _env: &HashMap<String, String>) -> Option<String> {
        None
    }

    /// Returns configured alias targets (e.g. `sonnet -> <provider-model>`) for model consistency validation.
    fn model_aliases(&self, _env: &HashMap<String, String>) -> HashMap<String, String> {
        HashMap::new()
    }

    /// Returns `true` when `model_id` is compatible with this engine given `env`
    /// (allowing custom/proxy endpoints while filtering stale foreign models across agent handoffs).
    fn accepts_model_id(&self, _model_id: &str, _env: &HashMap<String, String>) -> bool {
        true
    }

    /// Classifies a tool invocation into semantic kind, display title, and optional vendor metadata.
    fn classify_tool_call(
        &self,
        raw_name: &str,
        input: &Value,
        _parent_tool_use_id: Option<&str>,
    ) -> EngineToolClassification {
        classify_standard_tool_call(raw_name, input)
    }

    /// Encodes elicitation question answers into the payload format expected by `respond_question`.
    fn encode_question_answers(
        &self,
        entries: &[(String, Vec<String>)],
        question_keys: &[(String, String)],
    ) -> Value {
        let mut out = Map::new();
        for (raw_key, labels) in entries {
            let matched = question_keys
                .iter()
                .find(|(qid, qtext)| qid == raw_key || qtext == raw_key);
            let key = matched
                .map(|(qid, _)| qid.clone())
                .unwrap_or_else(|| raw_key.clone());
            out.insert(key, json!({ "answers": labels }));
        }
        Value::Object(out)
    }

    /// Invalidates cached driver-level processes/connections after external config edits,
    /// returning the number of evicted entries.
    async fn invalidate_caches(&self) -> usize {
        0
    }

    /// Starts or binds a native engine process/connection for `spec`.
    async fn start(&self, spec: EngineStartSpec) -> Result<EngineHandle, EngineError>;

    /// Dispatches a prompt and returns the normalized live event stream for this turn.
    async fn send_prompt(
        &self,
        handle: &EngineHandle,
        request: EnginePromptRequest,
    ) -> Result<EngineEventStream, EngineError>;

    /// Injects mid-turn guidance into an active turn (`turn/steer` / `prompt/steer`).
    async fn steer(
        &self,
        handle: &EngineHandle,
        request: EngineSteerRequest,
    ) -> Result<EngineSteerReceipt, EngineError>;

    /// Interrupts the currently active turn.
    async fn interrupt(&self, handle: &EngineHandle) -> Result<(), EngineError>;

    /// Forks the active session at an optional checkpoint cursor.
    async fn fork_session(
        &self,
        _handle: &EngineHandle,
        _request: EngineForkRequest,
    ) -> Result<EngineForkReceipt, EngineError> {
        Err(EngineError::Unsupported("fork_session".to_string()))
    }

    /// Atomically rewinds the engine's conversation state to `checkpoint`.
    async fn revert_to(
        &self,
        handle: &EngineHandle,
        checkpoint: EngineCheckpoint,
    ) -> Result<(), EngineError>;

    /// Responds to a pending tool permission request (`canUseTool` / approval).
    async fn respond_permission(
        &self,
        _handle: &EngineHandle,
        _decision: EnginePermissionDecision,
    ) -> Result<(), EngineError> {
        Ok(())
    }

    /// Responds to a pending structured user-question request (`AskUserQuestion` / `requestUserInput`).
    async fn respond_question(
        &self,
        _handle: &EngineHandle,
        _request_id: &str,
        _answers: serde_json::Value,
        _cancelled: bool,
    ) -> Result<(), EngineError> {
        Ok(())
    }

    /// Lists available models discovered from the native engine runtime.
    async fn list_models(&self, _handle: &EngineHandle) -> Result<Vec<EngineModelInfo>, EngineError> {
        Ok(Vec::new())
    }

    /// Returns the most recently observed rate-limit snapshot for `handle`.
    fn rate_limits(&self, handle: &EngineHandle) -> Option<EngineRateLimits>;

    /// Returns the most recently observed prompt cache status for `handle`.
    fn cache_status(&self, handle: &EngineHandle) -> Option<EngineCacheStatus>;

    /// Gracefully shuts down `handle` and releases associated resources.
    async fn shutdown(&self, handle: EngineHandle) -> Result<(), EngineError>;
}
