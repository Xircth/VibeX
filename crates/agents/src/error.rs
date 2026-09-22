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
    #[error("ACP session is not bound on this connection")]
    AcpSessionNotBound,
    #[error("{0}")]
    PiProjectTrustRequired(String),
    #[error("{0}")]
    NotInstalled(String),
    #[error("agent runtime error: {0}")]
    Runtime(String),
    /// The ACP child or stdio transport died while the host still had work in flight.
    #[error("agent connection closed: {0}")]
    ConnectionClosed(String),
}

impl AgentError {
    pub fn turn_failure_code(&self) -> Option<&'static str> {
        match self {
            Self::AuthenticationRequired(_) => Some("auth_required"),
            Self::SessionLoadFailed(reason) => Some(reason.code()),
            Self::AcpSessionNotBound => Some("acp_session_not_bound"),
            Self::PiProjectTrustRequired(_) => Some("pi_project_trust_required"),
            Self::NotInstalled(_) => Some("agent_not_installed"),
            Self::ConnectionClosed(_) => Some("connection_closed"),
            _ => None,
        }
    }

    pub fn is_connection_death(&self) -> bool {
        match self {
            Self::ConnectionClosed(_) => true,
            Self::Runtime(message) => {
                let message = message.to_ascii_lowercase();
                message.contains("acp connection failed")
                    || message.contains("command channel closed")
                    || message.contains("acp child")
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AgentError;

    #[test]
    fn unbound_prompt_uses_acp_session_not_bound_code() {
        assert_eq!(
            AgentError::AcpSessionNotBound.turn_failure_code(),
            Some("acp_session_not_bound")
        );
    }

    #[test]
    fn not_installed_is_a_turn_failure_code() {
        assert_eq!(
            AgentError::NotInstalled("Pi is not installed".into()).turn_failure_code(),
            Some("agent_not_installed")
        );
    }

    #[test]
    fn connection_closed_is_a_turn_failure_code() {
        let error =
            AgentError::ConnectionClosed("ACP agent process exited (exit status: 1)".into());
        assert_eq!(error.turn_failure_code(), Some("connection_closed"));
        assert!(error.is_connection_death());
    }

    #[test]
    fn acp_transport_errors_count_as_connection_death() {
        assert!(
            AgentError::Runtime("ACP connection failed: broken pipe".into()).is_connection_death()
        );
        assert!(
            AgentError::Runtime("agent connection command channel closed".into())
                .is_connection_death()
        );
        assert!(
            !AgentError::Runtime("ACP handshake timed out after 5s. No stderr captured.".into())
                .is_connection_death()
        );
    }
}
