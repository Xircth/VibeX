//! Error type for the per-agent model-provider config service.
//!
//! Sunk out of the `src-tauri` command layer (架构报告 A-1). The shell maps
//! `ProviderConfigError` back to `AppError` (variant-preserving) at the command
//! boundary.

#[derive(Debug, thiserror::Error)]
pub enum ProviderConfigError {
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Internal error: {0}")]
    Internal(String),
}
