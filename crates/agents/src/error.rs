use thiserror::Error;

pub type AgentResult<T> = Result<T, AgentError>;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("unsupported agent: {0}")]
    UnsupportedAgent(String),
    #[error("unsupported platform `{platform}` for agent `{agent}`")]
    UnsupportedPlatform { agent: String, platform: String },
    #[error("invalid distribution: {0}")]
    InvalidDistribution(String),
    #[error("agent connection `{0}` was not found")]
    ConnectionNotFound(String),
    #[error("agent session `{0}` was not found")]
    SessionNotFound(String),
    #[error("agent prompt `{0}` was not found")]
    PromptNotFound(String),
    #[error("agent does not advertise in-flight steering support")]
    SteeringUnsupported,
    #[error("active prompt conflict: expected `{expected}`, active is `{active}`")]
    PromptConflict { expected: String, active: String },
    #[error("agent authentication required: {0}")]
    AuthenticationRequired(String),
    #[error("agent session could not be loaded")]
    SessionLoadFailed(crate::SessionLoadFailureReason),
    #[error("agent runtime error: {0}")]
    Runtime(String),
}

impl AgentError {
    pub fn turn_failure_code(&self) -> Option<&'static str> {
        match self {
            Self::AuthenticationRequired(_) => Some("auth_required"),
            Self::SessionLoadFailed(reason) => Some(match reason {
                crate::SessionLoadFailureReason::ResourceNotFound => "resource_not_found",
                crate::SessionLoadFailureReason::AuthenticationRequired { .. } => "auth_required",
                crate::SessionLoadFailureReason::Unsupported => "session_resume_unsupported",
                crate::SessionLoadFailureReason::Other { .. } => "session_load_failed",
            }),
            _ => None,
        }
    }
}
