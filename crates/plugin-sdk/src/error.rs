use serde_json::Value;
use thiserror::Error;

#[derive(Clone, Debug, Error)]
#[error("{message}")]
pub struct PluginSdkError {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl PluginSdkError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Value,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Some(details),
        }
    }
}
