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
    #[error("agent runtime error: {0}")]
    Runtime(String),
}
