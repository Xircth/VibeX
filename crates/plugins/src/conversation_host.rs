use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Plugin-facing Conversation capability. This is the same Application Core
/// control plane the workspace session panel uses: create, submit, steer,
/// cancel, permission, question, and timeline. A plugin may only touch
/// Conversations it created or that the Host granted.
#[async_trait::async_trait]
pub trait PluginConversationHost: Send + Sync {
    async fn create(
        &self,
        plugin_id: &str,
        request: PluginConversationCreate,
    ) -> Result<PluginConversationView, PluginConversationError>;

    async fn list(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<PluginConversationSummary>, PluginConversationError>;

    async fn get(
        &self,
        plugin_id: &str,
        conversation_id: &str,
    ) -> Result<PluginConversationView, PluginConversationError>;

    async fn enqueue(
        &self,
        plugin_id: &str,
        request: PluginConversationEnqueue,
    ) -> Result<PluginConversationInputReceipt, PluginConversationError>;

    async fn steer(
        &self,
        plugin_id: &str,
        request: PluginConversationSteer,
    ) -> Result<Value, PluginConversationError> {
        let _ = (plugin_id, request);
        Err(unavailable())
    }

    async fn cancel(
        &self,
        plugin_id: &str,
        conversation_id: &str,
    ) -> Result<(), PluginConversationError>;

    async fn cancel_input(
        &self,
        plugin_id: &str,
        request: PluginConversationCancelInput,
    ) -> Result<Value, PluginConversationError> {
        let _ = (plugin_id, request);
        Err(unavailable())
    }

    async fn list_inputs(
        &self,
        plugin_id: &str,
        conversation_id: &str,
    ) -> Result<Value, PluginConversationError> {
        let _ = (plugin_id, conversation_id);
        Err(unavailable())
    }

    async fn respond_permission(
        &self,
        plugin_id: &str,
        request: PluginConversationPermission,
    ) -> Result<(), PluginConversationError> {
        let _ = (plugin_id, request);
        Err(unavailable())
    }

    async fn respond_question(
        &self,
        plugin_id: &str,
        request: PluginConversationQuestion,
    ) -> Result<(), PluginConversationError> {
        let _ = (plugin_id, request);
        Err(unavailable())
    }

    async fn set_mode(
        &self,
        plugin_id: &str,
        conversation_id: &str,
        mode_id: &str,
    ) -> Result<(), PluginConversationError> {
        let _ = (plugin_id, conversation_id, mode_id);
        Err(unavailable())
    }

    async fn set_config_option(
        &self,
        plugin_id: &str,
        conversation_id: &str,
        key: &str,
        value: Value,
    ) -> Result<(), PluginConversationError> {
        let _ = (plugin_id, conversation_id, key, value);
        Err(unavailable())
    }

    async fn events_since(
        &self,
        plugin_id: &str,
        conversation_id: &str,
        after_sequence: i64,
    ) -> Result<PluginConversationEventPage, PluginConversationError>;

    async fn catalog(&self, plugin_id: &str) -> Result<Value, PluginConversationError> {
        let _ = plugin_id;
        Err(unavailable())
    }

    async fn archive(
        &self,
        plugin_id: &str,
        conversation_id: &str,
    ) -> Result<(), PluginConversationError> {
        let _ = (plugin_id, conversation_id);
        Err(unavailable())
    }

    /// Host-only: allow this plugin to use an existing Conversation (MCP
    /// session injection). Plugins cannot grant themselves access.
    async fn grant(
        &self,
        plugin_id: &str,
        conversation_id: &str,
    ) -> Result<(), PluginConversationError>;
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConversationCreate {
    /// Omit to create inside the plugin's own scratch workspace.
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub agent_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConversationEnqueue {
    pub conversation_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    #[serde(default)]
    pub mode_override: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConversationSteer {
    pub conversation_id: String,
    pub expected_turn_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConversationCancelInput {
    pub conversation_id: String,
    pub input_id: String,
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConversationPermission {
    pub conversation_id: String,
    pub permission_id: String,
    pub response: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConversationQuestion {
    pub conversation_id: String,
    pub question_id: String,
    pub response: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConversationSummary {
    pub id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConversationView {
    #[serde(flatten)]
    pub summary: PluginConversationSummary,
    pub sequence: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<PluginConversationTurn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inputs: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConversationTurn {
    pub turn_id: String,
    pub status: String,
    pub last_sequence: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConversationInputReceipt {
    pub input_id: String,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConversationEventPage {
    pub conversation_id: String,
    pub after_sequence: i64,
    pub last_sequence: i64,
    pub rows: Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginConversationErrorCode {
    Unavailable,
    ScopeDenied,
    Invalid,
    NotFound,
    Failed,
}

impl PluginConversationErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "conversation_unavailable",
            Self::ScopeDenied => "conversation_scope_denied",
            Self::Invalid => "conversation_invalid",
            Self::NotFound => "conversation_not_found",
            Self::Failed => "conversation_failed",
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct PluginConversationError {
    code: PluginConversationErrorCode,
    message: String,
}

impl PluginConversationError {
    pub fn new(code: PluginConversationErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> PluginConversationErrorCode {
        self.code
    }
}

pub struct UnavailablePluginConversationHost;

#[async_trait::async_trait]
impl PluginConversationHost for UnavailablePluginConversationHost {
    async fn create(
        &self,
        _plugin_id: &str,
        _request: PluginConversationCreate,
    ) -> Result<PluginConversationView, PluginConversationError> {
        Err(unavailable())
    }

    async fn list(
        &self,
        _plugin_id: &str,
    ) -> Result<Vec<PluginConversationSummary>, PluginConversationError> {
        Err(unavailable())
    }

    async fn get(
        &self,
        _plugin_id: &str,
        _conversation_id: &str,
    ) -> Result<PluginConversationView, PluginConversationError> {
        Err(unavailable())
    }

    async fn enqueue(
        &self,
        _plugin_id: &str,
        _request: PluginConversationEnqueue,
    ) -> Result<PluginConversationInputReceipt, PluginConversationError> {
        Err(unavailable())
    }

    async fn cancel(
        &self,
        _plugin_id: &str,
        _conversation_id: &str,
    ) -> Result<(), PluginConversationError> {
        Err(unavailable())
    }

    async fn events_since(
        &self,
        _plugin_id: &str,
        _conversation_id: &str,
        _after_sequence: i64,
    ) -> Result<PluginConversationEventPage, PluginConversationError> {
        Err(unavailable())
    }

    async fn grant(
        &self,
        _plugin_id: &str,
        _conversation_id: &str,
    ) -> Result<(), PluginConversationError> {
        Err(unavailable())
    }
}

pub(crate) fn unavailable() -> PluginConversationError {
    PluginConversationError::new(
        PluginConversationErrorCode::Unavailable,
        "This Host has no Conversation capability for plugins",
    )
}
