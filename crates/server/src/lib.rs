//! Headless VibeX server composition and transport adapters.

mod agent_install;
mod artifact_sink;
mod auth;
mod automation_runtime;
mod chat_inbound;
mod chat_notify;
mod cli;
mod composition;
mod config;
mod delegation_runtime;
mod domains;
mod host_core;
mod host_ops;
mod host_token;
mod preview_proxy;
mod product_mcp;
mod runtime;
mod token_store;
mod update;
mod weixin_ilink;
mod ws;

pub use agent_install::{AgentCatalogEntry, AgentCatalogGroup, run_agents_command};
pub use artifact_sink::ServerArtifactEventSink;
pub use auth::{
    AuthClock, AuthStoreError, AuthenticatedCredential, CredentialKind, PairedDeviceRecord,
    ServerAuth, ServerCredentials, ServerToken, ServerTokenError, SqliteServerAuth,
    SystemAuthClock,
};
pub use automation_runtime::HeadlessAutomationRuntime;
pub use chat_inbound::{
    chat_channel_connection_states, connect_chat_channel, disconnect_chat_channel,
    post_event_webhooks, start_chat_inbound,
};
pub use chat_notify::{ChatDeliveryPublisher, notify_conversation_event};
pub use cli::{
    AgentsCommand, LaunchCommand, ParseError, ParsedArgs, ServerLaunch, parse_args, usage,
};
pub use composition::{HeadlessServer, ServerBootstrapConfig, ServerBootstrapError};
pub use config::{ListenPolicyError, ServerConfig};
pub use domains::{ServerApplicationDomains, ServerDomainDependencies};
pub use host_core::host_application_core;
pub use host_token::{
    HOST_TOKEN_FILE, host_token_path, issue_host_token, read_host_token, resolve_console_token,
    write_host_token,
};
pub use preview_proxy::{
    PreviewProxyRegistry, PreviewRegistrationError, start_loopback_preview_proxy,
};
pub use product_mcp::{ProductMcpSessionLookup, start_product_mcp_gateway};
pub use runtime::ServerRuntime;
pub use token_store::{ProvisionedToken, SqliteTokenHashStore};
pub use update::{HostUpgradeError, HostUpgradePlan, apply_host_upgrade, plan_host_upgrade};
pub use weixin_ilink::{
    WeixinQrcodeInfo, WeixinQrcodeStatus, weixin_check_qrcode, weixin_get_qrcode,
};
