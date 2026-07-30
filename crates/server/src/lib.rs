//! Headless VibeX server composition and transport adapters.

mod artifact_sink;
mod auth;
mod automation_runtime;
mod composition;
mod config;
mod delegation_runtime;
mod runtime;
mod token_store;
mod ws;

pub use artifact_sink::ServerArtifactEventSink;
pub use auth::{ServerCredentials, ServerToken, ServerTokenError};
pub use composition::{HeadlessServer, ServerBootstrapConfig, ServerBootstrapError};
pub use config::{ListenPolicyError, ServerConfig};
pub use runtime::ServerRuntime;
pub use token_store::{ProvisionedToken, SqliteTokenHashStore};
