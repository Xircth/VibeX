use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("failed to spawn terminal: {0}")]
    SpawnFailed(String),
    #[error("terminal not found: {0}")]
    NotFound(String),
    #[error("terminal write error: {0}")]
    WriteFailed(String),
    #[error("terminal resize error: {0}")]
    ResizeFailed(String),
}

impl Serialize for TerminalError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
