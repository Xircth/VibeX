use remote_protocol::{ErrorCode, ErrorEnvelope, OperationId};

#[derive(Debug, thiserror::Error)]
#[error("{envelope:?}")]
pub struct ApplicationError {
    envelope: ErrorEnvelope,
}

impl ApplicationError {
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self {
            envelope: ErrorEnvelope::new(ErrorCode::Forbidden, message, false, OperationId::new()),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            envelope: ErrorEnvelope::new(ErrorCode::Internal, message, true, OperationId::new()),
        }
    }

    pub fn envelope(&self) -> &ErrorEnvelope {
        &self.envelope
    }

    pub fn into_envelope(self) -> ErrorEnvelope {
        self.envelope
    }
}
