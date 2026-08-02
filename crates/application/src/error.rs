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

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            envelope: ErrorEnvelope::new(ErrorCode::NotFound, message, false, OperationId::new()),
        }
    }

    pub fn capability_unavailable(message: impl Into<String>) -> Self {
        Self {
            envelope: ErrorEnvelope::new(
                ErrorCode::CapabilityUnavailable,
                message,
                false,
                OperationId::new(),
            ),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            envelope: ErrorEnvelope::new(ErrorCode::BadRequest, message, false, OperationId::new()),
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            envelope: ErrorEnvelope::new(ErrorCode::Conflict, message, false, OperationId::new()),
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
