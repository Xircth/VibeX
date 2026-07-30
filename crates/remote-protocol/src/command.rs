use serde::{Deserialize, Serialize};

use crate::OperationId;

/// Successful command envelope. Errors use [`crate::ErrorEnvelope`] with the
/// same operation id.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CommandResponse<T> {
    pub operation_id: OperationId,
    pub data: T,
}

impl<T> CommandResponse<T> {
    pub const fn new(operation_id: OperationId, data: T) -> Self {
        Self { operation_id, data }
    }
}
