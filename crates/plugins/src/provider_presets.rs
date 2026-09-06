use std::{collections::HashMap, sync::Mutex, time::Duration};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// A prompt left unanswered this long is treated as a decline.
pub const PROVIDER_BIND_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(180);

/// Shared parking lot for `provider.presets.bind` confirmation. Desktop and
/// headless Hosts use the same map so a bound App can answer a prompt that a
/// Worker on the Host parked.
#[derive(Default)]
pub struct ProviderBindPrompts {
    waiting: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl ProviderBindPrompts {
    pub fn park(&self, request_id: String) -> oneshot::Receiver<bool> {
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().unwrap().insert(request_id, tx);
        rx
    }

    pub fn answer(&self, request_id: &str, approved: bool) -> bool {
        let Some(sender) = self.waiting.lock().unwrap().remove(request_id) else {
            return false;
        };
        sender.send(approved).is_ok()
    }

    pub fn abandon(&self, request_id: &str) {
        self.waiting.lock().unwrap().remove(request_id);
    }
}

/// One saved model-provider preset, as a plugin is allowed to see it.
///
/// The API key is deliberately reduced to `has_api_key`. Full Trust means a
/// determined plugin could read the store off disk, but the broker still
/// refuses to be the thing that hands secrets out — a plugin that only wants
/// to list or re-point presets never needs the key, and keeping it out of the
/// response keeps it out of plugin logs and crash dumps.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreset {
    pub id: String,
    pub name: String,
    pub agent_id: String,
    pub api_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub has_api_key: bool,
    pub bound: bool,
}

/// A preset a plugin wants to create or overwrite.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPresetDraft {
    /// Absent creates a preset; present overwrites that preset in place.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub agent_id: String,
    pub api_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// A binding change. `preset_id: None` unbinds the agent.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBindRequest {
    pub agent_id: String,
    #[serde(default)]
    pub preset_id: Option<String>,
    /// Shown to the user in the confirmation prompt so they can tell why a
    /// plugin is asking. Free text from the plugin; treat it as untrusted.
    #[serde(default)]
    pub reason: Option<String>,
}

/// What the Host did with a bind request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderBindDecision {
    Applied,
    Declined,
}

/// Failure modes a plugin is expected to branch on. Keeping this a closed enum
/// rather than free-form strings is what lets the broker forward the code
/// verbatim to the Worker without leaking allocations.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderPresetErrorCode {
    /// This Host has no preset store wired up.
    Unavailable,
    /// The named agent is not installed or not known to the store.
    UnknownAgent,
    /// The referenced preset does not exist.
    PresetNotFound,
    /// The draft or bind request was rejected by the store's own validation.
    Rejected,
    /// Reading or writing the store failed.
    StoreFailed,
}

impl ProviderPresetErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "provider_presets_unavailable",
            Self::UnknownAgent => "provider_agent_unknown",
            Self::PresetNotFound => "provider_preset_not_found",
            Self::Rejected => "provider_preset_rejected",
            Self::StoreFailed => "provider_preset_store_failed",
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ProviderPresetError {
    code: ProviderPresetErrorCode,
    message: String,
}

impl ProviderPresetError {
    pub fn new(code: ProviderPresetErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> ProviderPresetErrorCode {
        self.code
    }
}

/// Host seam for model-provider presets (ADR-0063, opened to plugins by
/// ADR-0069).
///
/// `bind` is the only mutating call that changes what an agent actually talks
/// to, so implementations **must** obtain explicit user confirmation before
/// applying it and return [`ProviderBindDecision::Declined`] when the user says
/// no. `list` and `save` only touch VibeX's own preset store and need no
/// prompt.
#[async_trait]
pub trait ProviderPresetHost: Send + Sync {
    async fn list(
        &self,
        agent_id: Option<&str>,
    ) -> Result<Vec<ProviderPreset>, ProviderPresetError>;

    async fn save(
        &self,
        plugin_id: &str,
        draft: ProviderPresetDraft,
    ) -> Result<ProviderPreset, ProviderPresetError>;

    async fn bind(
        &self,
        plugin_id: &str,
        request: ProviderBindRequest,
    ) -> Result<ProviderBindDecision, ProviderPresetError>;
}

/// Stand-in used by composition paths that have no provider store wired up
/// (the headless server today). Every call fails with a code the SDK can
/// distinguish from a user decline.
pub struct UnavailableProviderPresetHost;

#[async_trait]
impl ProviderPresetHost for UnavailableProviderPresetHost {
    async fn list(
        &self,
        _agent_id: Option<&str>,
    ) -> Result<Vec<ProviderPreset>, ProviderPresetError> {
        Err(unavailable())
    }

    async fn save(
        &self,
        _plugin_id: &str,
        _draft: ProviderPresetDraft,
    ) -> Result<ProviderPreset, ProviderPresetError> {
        Err(unavailable())
    }

    async fn bind(
        &self,
        _plugin_id: &str,
        _request: ProviderBindRequest,
    ) -> Result<ProviderBindDecision, ProviderPresetError> {
        Err(unavailable())
    }
}

fn unavailable() -> ProviderPresetError {
    ProviderPresetError::new(
        ProviderPresetErrorCode::Unavailable,
        "This Host has no model-provider preset store",
    )
}
