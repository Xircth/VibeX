use thiserror::Error;

#[derive(Clone, Debug, Error)]
#[error("{message}")]
pub struct PortError {
    message: String,
}

impl PortError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct ToolRuntimeError {
    code: &'static str,
    message: String,
}

impl ToolRuntimeError {
    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub(crate) fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: "tool_request_invalid",
            message: message.into(),
        }
    }

    pub(crate) fn digest_mismatch(tool_id: &str, expected: &str, actual: &str) -> Self {
        Self {
            code: "tool_digest_mismatch",
            message: format!(
                "tool `{tool_id}` digest mismatch: expected `{expected}`, got `{actual}`"
            ),
        }
    }

    pub(crate) fn cancelled(tool_id: &str, version: &str) -> Self {
        Self {
            code: "tool_install_cancelled",
            message: format!("installation of tool `{tool_id}` version `{version}` was cancelled"),
        }
    }

    pub(crate) fn probe_failed(tool_id: &str, version: &str, error: PortError) -> Self {
        Self {
            code: "tool_probe_failed",
            message: format!("probe failed for tool `{tool_id}` version `{version}`: {error}"),
        }
    }

    pub(crate) fn invalid_lease() -> Self {
        Self {
            code: "tool_lease_invalid",
            message: "tool lease is unknown or already released".to_string(),
        }
    }

    pub(crate) fn port(operation: &str, error: PortError) -> Self {
        Self {
            code: "tool_runtime_io_failed",
            message: format!("{operation}: {error}"),
        }
    }
}
