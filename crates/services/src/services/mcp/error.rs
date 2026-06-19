//! Error type for the MCP marketplace / hosting service.
//!
//! Sunk out of the `src-tauri` command layer (架构报告 A-1): this logic used to use
//! `AppError` directly, which couples a service to the Tauri shell. The shell maps
//! `McpError` back to `AppError` (variant-preserving) at the command boundary.

#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Internal error: {0}")]
    Internal(String),
}
