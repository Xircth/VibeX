use std::sync::Arc;

use application::{
    AdapterCapabilities, ApplicationCore, CommandRegistry, SqliteConversationRepository,
};
use conversations::ConversationContext;
use plugins::PluginControlPlane;
use sqlx::SqlitePool;

use crate::{
    HeadlessAutomationRuntime, PreviewProxyRegistry,
    host::events::{HostEventBus, TerminalBridgeRegistry},
    host_core::host_application_core,
};

/// Live Automation Engine ownership. Desktop reads the process lease registry;
/// headless Server snapshots the acquire result.
#[derive(Clone)]
pub struct AutomationOwnership {
    check: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl AutomationOwnership {
    pub fn fixed(value: bool) -> Self {
        Self {
            check: Arc::new(move || value),
        }
    }

    pub fn from_fn(check: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self {
            check: Arc::new(check),
        }
    }

    pub fn current(&self) -> bool {
        (self.check)()
    }
}

/// Long-lived Host seam shared by desktop AppState and Headless Server.
#[derive(Clone)]
pub struct HostRuntime {
    pub core: Arc<ApplicationCore<SqliteConversationRepository>>,
    pub commands: CommandRegistry<SqliteConversationRepository>,
    pub events: Arc<HostEventBus>,
    pub terminal_bridges: Arc<TerminalBridgeRegistry>,
    pub preview_proxy: PreviewProxyRegistry,
    pub adapter: AdapterCapabilities,
    pub automation_ownership: AutomationOwnership,
}

pub struct HostRuntimeParts {
    pub pool: SqlitePool,
    pub conversations: ConversationContext,
    pub plugin_control_plane: Arc<PluginControlPlane>,
    pub companion_memory: Option<Arc<delegation::InMemoryCompanionFeatures>>,
    pub preview_host: Arc<dyn plugins::PluginPreviewHost>,
    pub capability_broker: Arc<plugins::HostCapabilityBroker>,
    pub app_surfaces: Arc<plugins::PluginAppSurfaceHost>,
    pub preview_proxy: PreviewProxyRegistry,
    pub automation: HeadlessAutomationRuntime,
    pub automation_ownership: AutomationOwnership,
    pub deployment: Arc<local_deployment::LocalDeployment>,
    pub runtime_root: std::path::PathBuf,
    pub worker_runtime: Arc<plugins::PluginWorkerRuntimeProvider>,
    pub adapter: AdapterCapabilities,
    pub events: Option<Arc<HostEventBus>>,
    pub terminal_bridges: Option<Arc<TerminalBridgeRegistry>>,
}

impl HostRuntime {
    pub fn build(parts: HostRuntimeParts) -> Self {
        let events = parts
            .events
            .unwrap_or_else(|| Arc::new(HostEventBus::new()));
        let terminal_bridges = parts
            .terminal_bridges
            .unwrap_or_else(|| Arc::new(TerminalBridgeRegistry::new()));
        let core = host_application_core(
            parts.pool,
            parts.conversations,
            parts.plugin_control_plane,
            parts.companion_memory,
            parts.preview_host,
            parts.capability_broker,
            parts.app_surfaces,
            parts.preview_proxy.clone(),
            parts.automation,
            parts.automation_ownership.clone(),
            parts.deployment,
            parts.runtime_root,
            parts.worker_runtime,
            events.clone(),
            terminal_bridges.clone(),
        );
        let core = Arc::new(core);
        Self {
            commands: CommandRegistry::from_core(core.clone()),
            core,
            events,
            terminal_bridges,
            preview_proxy: parts.preview_proxy,
            adapter: parts.adapter,
            automation_ownership: parts.automation_ownership,
        }
    }

    pub fn capability_scopes(&self) -> Vec<&'static str> {
        application::DomainCommand::derived_capability_scopes(self.adapter)
    }
}
