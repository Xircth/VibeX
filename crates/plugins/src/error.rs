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
}
