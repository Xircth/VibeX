//! Headless VibeX server composition and transport adapters.

mod artifact_sink;
mod auth;
mod automation_runtime;
mod chat_inbound;
mod weixin_ilink;
mod composition;
mod config;
mod delegation_runtime;
mod domains;
mod host_core;
mod preview_proxy;
mod product_mcp;
mod runtime;
mod token_store;
mod update;
mod ws;

pub use artifact_sink::ServerArtifactEventSink;
pub use auth::{
    AuthClock, AuthStoreError, AuthenticatedCredential, CredentialKind, ServerAuth,
    ServerCredentials, ServerToken, ServerTokenError, SqliteServerAuth, SystemAuthClock,
};
pub use automation_runtime::HeadlessAutomationRuntime;
pub use chat_inbound::{
    chat_channel_connection_states, post_event_webhooks, start_chat_inbound,
};
pub use weixin_ilink::{WeixinQrcodeInfo, WeixinQrcodeStatus, weixin_check_qrcode, weixin_get_qrcode};
pub use composition::{HeadlessServer, ServerBootstrapConfig, ServerBootstrapError};
pub use config::{ListenPolicyError, ServerConfig};
pub use domains::{ServerApplicationDomains, ServerDomainDependencies};
pub use host_core::host_application_core;
pub use preview_proxy::{
    PreviewProxyRegistry, PreviewRegistrationError, start_loopback_preview_proxy,
};
pub use product_mcp::{ProductMcpSessionLookup, start_product_mcp_gateway};
pub use runtime::ServerRuntime;
pub use token_store::{ProvisionedToken, SqliteTokenHashStore};
pub use update::{HostUpgradeError, HostUpgradePlan, apply_host_upgrade, plan_host_upgrade};
