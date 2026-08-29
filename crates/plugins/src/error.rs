use thiserror::Error;

#[derive(Debug, Error)]
#[error("{message}")]
pub struct PluginError {
    code: &'static str,
    message: String,
}

impl PluginError {
    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub(crate) fn invalid_manifest(message: impl Into<String>) -> Self {
        Self {
            code: "plugin_manifest_invalid",
            message: message.into(),
        }
    }

    pub(crate) fn coded(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn unsupported_major(schema: &str) -> Self {
        Self {
            code: "plugin_manifest_major_unsupported",
            message: format!("unsupported plugin manifest schema `{schema}`"),
        }
    }

    pub(crate) fn platform_unsupported(tool_id: &str, target: &str) -> Self {
        Self {
            code: "tool_platform_unsupported",
            message: format!("tool `{tool_id}` has no distribution for `{target}`"),
        }
    }

    pub(crate) fn version_not_exact(tool_id: &str, version: &str) -> Self {
        Self {
            code: "tool_version_not_exact",
            message: format!("tool `{tool_id}` version `{version}` is not an exact version"),
        }
    }

    pub(crate) fn invalid_distribution(tool_id: &str, reason: &str) -> Self {
        Self {
            code: "tool_distribution_invalid",
            message: format!("tool `{tool_id}` has an invalid distribution: {reason}"),
        }
    }

    pub(crate) fn not_found(plugin_id: &str) -> Self {
        Self {
            code: "plugin_not_found",
            message: format!("plugin `{plugin_id}` is not imported"),
        }
    }

    pub(crate) fn unknown_provider(plugin_id: &str, provider_id: &str) -> Self {
        Self {
            code: "plugin_provider_unknown",
            message: format!(
                "plugin `{plugin_id}` binds unknown provider `{provider_id}`; \
                 providers must reference a declared managed tool"
            ),
        }
    }

    pub(crate) fn io(context: &str, error: impl std::fmt::Display) -> Self {
        Self {
            code: "plugin_io_failed",
            message: format!("{context}: {error}"),
        }
    }

    pub(crate) fn contribution_required(plugin_id: &str) -> Self {
        Self {
            code: "plugin_contribution_required",
            message: format!("plugin `{plugin_id}` must contain at least one valid contribution"),
        }
    }

    pub fn class_unsupported(plugin_id: &str) -> Self {
        Self {
            code: "plugin_class_unsupported",
            message: format!(
                "plugin `{plugin_id}` is Isolated and cannot be installed until sandboxed spawn is published"
            ),
        }
    }

    pub(crate) fn conflict(plugin_id: &str) -> Self {
        Self {
            code: "plugin_id_conflict",
            message: format!("plugin `{plugin_id}` is already installed"),
        }
    }

    pub(crate) fn registry(message: impl Into<String>) -> Self {
        Self {
            code: "plugin_registry_failed",
            message: message.into(),
        }
    }

    pub(crate) fn native_unsupported(ecosystem: &str, operation: &str) -> Self {
        Self {
            code: "native_operation_unsupported",
            message: format!(
                "{ecosystem} adapter cannot reliably perform `{operation}`; use the native manager"
            ),
        }
    }

    pub(crate) fn native_command_failed(
        ecosystem: &str,
        operation: &str,
        reason: impl std::fmt::Display,
    ) -> Self {
        Self {
            code: "native_command_failed",
            message: format!("{ecosystem} official plugin command `{operation}` failed: {reason}"),
        }
    }

    pub(crate) fn native_command_rejected(reason: impl std::fmt::Display) -> Self {
        Self {
            code: "native_command_rejected",
            message: format!("official plugin command rejected: {reason}"),
        }
    }

    pub(crate) fn runtime_not_ready(runtime_id: &str, reason: impl std::fmt::Display) -> Self {
        Self {
            code: "plugin_runtime_not_ready",
            message: format!(
                "Runtime `{runtime_id}` is not ready in the Agent environment: {reason}"
            ),
        }
    }

    pub(crate) fn runtime_install_failed(runtime_id: &str, reason: impl std::fmt::Display) -> Self {
        Self {
            code: "plugin_runtime_install_failed",
            message: format!("failed to install Runtime `{runtime_id}`: {reason}"),
        }
    }

    pub(crate) fn dependency_unsatisfied(message: impl Into<String>) -> Self {
        Self {
            code: "dependency_unsatisfied",
            message: message.into(),
        }
    }

    pub(crate) fn invocation_unavailable(plugin_id: &str, invocation_id: &str) -> Self {
        Self {
            code: "plugin_invocation_unavailable",
            message: format!(
                "plugin invocation `{plugin_id}/{invocation_id}` is unavailable or disabled"
            ),
        }
    }
}
