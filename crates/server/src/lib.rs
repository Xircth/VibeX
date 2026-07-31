//! Headless VibeX server composition and transport adapters.

mod artifact_sink;
mod auth;
mod automation_runtime;
mod composition;
mod config;
mod delegation_runtime;
mod domains;
mod preview_proxy;
mod runtime;
mod token_store;
mod ws;

pub use artifact_sink::ServerArtifactEventSink;
pub use auth::{
    AuthClock, AuthStoreError, AuthenticatedCredential, CredentialKind, ServerAuth,
    ServerCredentials, ServerToken, ServerTokenError, SqliteServerAuth, SystemAuthClock,
};
pub use composition::{HeadlessServer, ServerBootstrapConfig, ServerBootstrapError};
pub use config::{ListenPolicyError, ServerConfig};
pub use preview_proxy::{PreviewProxyRegistry, PreviewRegistrationError};
pub use runtime::ServerRuntime;
pub use token_store::{ProvisionedToken, SqliteTokenHashStore};
