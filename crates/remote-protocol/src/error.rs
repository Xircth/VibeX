use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::OperationId;

/// Stable machine-readable error classes shared by every transport adapter.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ErrorCode {
    BadRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    CapabilityUnavailable,
    Internal,
}

/// Transport-stable error shape. Adapter-specific errors must be normalized
/// into this envelope before crossing the application boundary.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize, TS)]
pub struct ErrorEnvelope {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub operation_id: OperationId,
    #[serde(default)]
    pub details: Option<serde_json::Value>,
}

impl ErrorEnvelope {
    pub fn new(
        code: ErrorCode,
        message: impl Into<String>,
        retryable: bool,
        operation_id: OperationId,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            operation_id,
            details: None,
        }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }
}
