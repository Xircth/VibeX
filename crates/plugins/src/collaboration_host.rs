use serde_json::Value;

/// Host collaboration and workspace navigation exposed to plugins.
/// Plugins call `collaboration.*` and `workspace.focusConversation`.
/// The Host owns the records. A plugin id is never a branch.
#[async_trait::async_trait]
pub trait CollaborationHost: Send + Sync {
    async fn call(
        &self,
        plugin_id: &str,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, CollaborationHostError>;
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct CollaborationHostError {
    code: &'static str,
    message: String,
}

impl CollaborationHostError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

pub struct UnavailableCollaborationHost;

#[async_trait::async_trait]
impl CollaborationHost for UnavailableCollaborationHost {
    async fn call(
        &self,
        _plugin_id: &str,
        capability: &str,
        operation: &str,
        _input: Value,
    ) -> Result<Value, CollaborationHostError> {
        Err(CollaborationHostError::new(
            "capability_unimplemented",
            format!("{capability}.{operation} is not available"),
        ))
    }
}
