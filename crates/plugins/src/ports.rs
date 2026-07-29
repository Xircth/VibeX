use std::{path::PathBuf, sync::Arc};

use async_trait::async_trait;
use thiserror::Error;

use crate::ResolvedToolDistribution;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedTool {
    pub version: String,
    pub executable_path: PathBuf,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("{message}")]
pub struct PluginRuntimeError {
    code: String,
    message: String,
}

impl PluginRuntimeError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

#[async_trait]
pub trait ToolRuntimePort: Send + Sync {
    async fn ensure(
        &self,
        tool: &ResolvedToolDistribution,
    ) -> Result<ManagedTool, PluginRuntimeError>;
}

pub struct ToolRuntimeAdapter {
    runtime: Arc<tool_runtime::ToolRuntime>,
    leases: tokio::sync::Mutex<Vec<tool_runtime::ToolLease>>,
}

impl ToolRuntimeAdapter {
    pub fn new(runtime: Arc<tool_runtime::ToolRuntime>) -> Self {
        Self {
            runtime,
            leases: tokio::sync::Mutex::new(Vec::new()),
        }
    }

    pub async fn release_all(&self) -> Result<(), PluginRuntimeError> {
        let leases = {
            let mut leases = self.leases.lock().await;
            std::mem::take(&mut *leases)
        };
        for lease in leases {
            self.runtime
                .release(lease)
                .await
                .map_err(map_runtime_error)?;
        }
        Ok(())
    }
}

#[async_trait]
impl ToolRuntimePort for ToolRuntimeAdapter {
    async fn ensure(
        &self,
        tool: &ResolvedToolDistribution,
    ) -> Result<ManagedTool, PluginRuntimeError> {
        let executable_name = if tool.target.contains("windows") {
            format!("{}.exe", tool.id.as_str())
        } else {
            tool.id.as_str().to_owned()
        };
        let request = tool_runtime::ToolRequest {
            tool_id: tool.id.as_str().to_owned(),
            version: tool.version.clone(),
            target: tool.target.clone(),
            url: tool.url.clone(),
            sha256: tool.sha256.clone(),
            executable_name,
            probe_args: tool.probe.clone(),
        };
        let lease = self
            .runtime
            .ensure(&request, &tool_runtime::CancellationToken::new())
            .await
            .map_err(map_runtime_error)?;
        let managed = ManagedTool {
            version: lease.version.clone(),
            executable_path: lease.executable_path.clone(),
        };
        self.leases.lock().await.push(lease);
        Ok(managed)
    }
}

pub(crate) struct UnavailableToolRuntime;

#[async_trait]
impl ToolRuntimePort for UnavailableToolRuntime {
    async fn ensure(
        &self,
        tool: &ResolvedToolDistribution,
    ) -> Result<ManagedTool, PluginRuntimeError> {
        Err(PluginRuntimeError::new(
            "tool_runtime_unavailable",
            format!("tool runtime is not configured for `{}`", tool.id.as_str()),
        ))
    }
}

fn map_runtime_error(error: tool_runtime::ToolRuntimeError) -> PluginRuntimeError {
    PluginRuntimeError::new(error.code(), error.message())
}
