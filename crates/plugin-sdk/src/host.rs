use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::PluginSdkError;

#[async_trait]
pub trait HostTransport: Send + Sync {
    async fn call(
        &self,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, PluginSdkError>;
}

#[derive(Clone)]
pub struct HostClient {
    transport: Arc<dyn HostTransport>,
}

impl HostClient {
    pub fn new(transport: Arc<dyn HostTransport>) -> Self {
        Self { transport }
    }

    pub fn stdio() -> Self {
        Self::new(Arc::new(UnimplementedHost))
    }

    pub async fn call(
        &self,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, PluginSdkError> {
        self.transport.call(capability, operation, input).await
    }
}

pub struct UnimplementedHost;

#[async_trait]
impl HostTransport for UnimplementedHost {
    async fn call(
        &self,
        capability: &str,
        operation: &str,
        _input: Value,
    ) -> Result<Value, PluginSdkError> {
        Err(PluginSdkError::new(
            "capability_unimplemented",
            format!("{capability}.{operation} has no host transport"),
        ))
    }
}
