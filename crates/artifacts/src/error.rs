use thiserror::Error;

#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("{message}")]
pub struct PortError {
    message: String,
}

impl PortError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ArtifactServiceError {
    #[error("artifact path is outside its allowed scope: {0}")]
    PathOutsideScope(String),
    #[error("artifact `{0}` was not found")]
    ArtifactNotFound(uuid::Uuid),
    #[error("preview provider `{0}` is not registered")]
    ProviderNotFound(String),
    #[error("preview provider `{0}` is already registered")]
    DuplicateProvider(String),
    #[error("verified tool installation `{0}` is not available")]
    ToolUnresolved(String),
    #[error("preview lease `{0}` was not found")]
    PreviewLeaseNotFound(uuid::Uuid),
    #[error("preview process limit reached")]
    ProcessLimitReached,
    #[error("preview provider failed: {0}")]
    Preview(String),
    #[error("artifact adapter failed: {0}")]
    Port(#[from] PortError),
}
