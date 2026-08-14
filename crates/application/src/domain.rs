use std::{str::FromStr, sync::Arc};

use async_trait::async_trait;

use crate::{ApplicationError, Principal};

/// Closed set of non-Conversation product commands supported by remote hosts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DomainCommand {
    PluginActionCatalog,
    PluginControlCatalog,
    PluginProductDetail,
    PluginSaveConfig,
    PluginContributionCatalog,
    PluginResolveFileOpener,
    PluginOpenFilePreview,
    PluginCloseFilePreview,
    PluginControlSetEnabled,
    PluginControlGrantPermissions,
    PluginControlInstallRuntime,
    PluginSurfaceOpen,
    PluginSurfaceInvoke,
    PluginSurfaceRevoke,
    ProjectList,
    ProjectRepositories,
    RepoBranches,
    AgentManagementBar,
    AgentCapabilityCatalog,
    AgentSkillsList,
    UserSystemInfo,
    ArtifactList,
    ArtifactOpenPreview,
    ArtifactClosePreview,
    AutomationList,
    AutomationEngineStatus,
    AutomationCreate,
    AutomationUpdate,
    AutomationSetEnabled,
    AutomationDelete,
    AutomationRunNow,
    AutomationCancelRun,
    AutomationRuns,
    AutomationPreviewNextRuns,
    AutomationTemplates,
    AutomationUnseenFailures,
    AutomationMarkSeen,
    DelegationCancel,
}

impl DomainCommand {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PluginActionCatalog => "plugin_action_catalog",
            Self::PluginControlCatalog => "plugin_control_catalog",
            Self::PluginProductDetail => "plugin_product_detail",
            Self::PluginSaveConfig => "plugin_save_config",
            Self::PluginContributionCatalog => "plugin_contribution_catalog",
            Self::PluginResolveFileOpener => "plugin_resolve_file_opener",
            Self::PluginOpenFilePreview => "plugin_open_file_preview",
            Self::PluginCloseFilePreview => "plugin_close_file_preview",
            Self::PluginControlSetEnabled => "plugin_control_set_enabled",
            Self::PluginControlGrantPermissions => "plugin_control_grant_permissions",
            Self::PluginControlInstallRuntime => "plugin_control_install_runtime",
            Self::PluginSurfaceOpen => "plugin_surface_open",
            Self::PluginSurfaceInvoke => "plugin_surface_invoke",
            Self::PluginSurfaceRevoke => "plugin_surface_revoke",
            Self::ProjectList => "get_projects",
            Self::ProjectRepositories => "get_project_repositories",
            Self::RepoBranches => "get_repo_branches",
            Self::AgentManagementBar => "agent_management_bar",
            Self::AgentCapabilityCatalog => "agent_capability_catalog",
            Self::AgentSkillsList => "list_agent_skills",
            Self::UserSystemInfo => "get_user_system_info",
            Self::ArtifactList => "artifact_list",
            Self::ArtifactOpenPreview => "artifact_open_preview",
            Self::ArtifactClosePreview => "artifact_close_preview",
            Self::AutomationList => "automation_list",
            Self::AutomationEngineStatus => "automation_engine_status",
            Self::AutomationCreate => "automation_create",
            Self::AutomationUpdate => "automation_update",
            Self::AutomationSetEnabled => "automation_set_enabled",
            Self::AutomationDelete => "automation_delete",
            Self::AutomationRunNow => "automation_run_now",
            Self::AutomationCancelRun => "automation_cancel_run",
            Self::AutomationRuns => "automation_runs",
            Self::AutomationPreviewNextRuns => "automation_preview_next_runs",
            Self::AutomationTemplates => "automation_templates",
            Self::AutomationUnseenFailures => "automation_unseen_failures",
            Self::AutomationMarkSeen => "automation_mark_seen",
            Self::DelegationCancel => "delegation_cancel",
        }
    }

    pub const fn required_scope(self) -> &'static str {
        match self {
            Self::PluginActionCatalog
            | Self::PluginControlCatalog
            | Self::PluginProductDetail
            | Self::PluginContributionCatalog
            | Self::PluginResolveFileOpener => "plugin.read",
            Self::ProjectList
            | Self::ProjectRepositories
            | Self::RepoBranches
            | Self::AgentManagementBar
            | Self::AgentCapabilityCatalog
            | Self::AgentSkillsList
            | Self::UserSystemInfo => "application.call",
            Self::ArtifactList => "artifact.read",
            Self::ArtifactOpenPreview
            | Self::ArtifactClosePreview
            | Self::PluginOpenFilePreview
            | Self::PluginCloseFilePreview => "artifact.preview",
            Self::AutomationList
            | Self::AutomationEngineStatus
            | Self::AutomationRuns
            | Self::AutomationPreviewNextRuns
            | Self::AutomationTemplates
            | Self::AutomationUnseenFailures => "automation.read",
            Self::PluginControlSetEnabled
            | Self::PluginSaveConfig
            | Self::PluginControlGrantPermissions
            | Self::PluginControlInstallRuntime => "plugin.write",
            Self::PluginSurfaceOpen | Self::PluginSurfaceInvoke | Self::PluginSurfaceRevoke => {
                "plugin.surface"
            }
            Self::AutomationCreate
            | Self::AutomationUpdate
            | Self::AutomationSetEnabled
            | Self::AutomationDelete
            | Self::AutomationRunNow
            | Self::AutomationCancelRun
            | Self::AutomationMarkSeen => "automation.write",
            Self::DelegationCancel => "delegation.cancel",
        }
    }
}

impl FromStr for DomainCommand {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        [
            Self::PluginActionCatalog,
            Self::PluginControlCatalog,
            Self::PluginProductDetail,
            Self::PluginSaveConfig,
            Self::PluginContributionCatalog,
            Self::PluginResolveFileOpener,
            Self::PluginOpenFilePreview,
            Self::PluginCloseFilePreview,
            Self::PluginControlSetEnabled,
            Self::PluginControlGrantPermissions,
            Self::PluginControlInstallRuntime,
            Self::PluginSurfaceOpen,
            Self::PluginSurfaceInvoke,
            Self::PluginSurfaceRevoke,
            Self::ProjectList,
            Self::ProjectRepositories,
            Self::RepoBranches,
            Self::AgentManagementBar,
            Self::AgentCapabilityCatalog,
            Self::AgentSkillsList,
            Self::UserSystemInfo,
            Self::ArtifactList,
            Self::ArtifactOpenPreview,
            Self::ArtifactClosePreview,
            Self::AutomationList,
            Self::AutomationEngineStatus,
            Self::AutomationCreate,
            Self::AutomationUpdate,
            Self::AutomationSetEnabled,
            Self::AutomationDelete,
            Self::AutomationRunNow,
            Self::AutomationCancelRun,
            Self::AutomationRuns,
            Self::AutomationPreviewNextRuns,
            Self::AutomationTemplates,
            Self::AutomationUnseenFailures,
            Self::AutomationMarkSeen,
            Self::DelegationCancel,
        ]
        .into_iter()
        .find(|command| command.as_str() == value)
        .ok_or(())
    }
}

#[async_trait]
pub trait ApplicationDomainPort: Send + Sync {
    async fn execute(
        &self,
        principal: &Principal,
        command: DomainCommand,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ApplicationError>;
}

pub(crate) struct UnavailableApplicationDomains;

#[async_trait]
impl ApplicationDomainPort for UnavailableApplicationDomains {
    async fn execute(
        &self,
        _principal: &Principal,
        command: DomainCommand,
        _args: serde_json::Value,
    ) -> Result<serde_json::Value, ApplicationError> {
        Err(ApplicationError::capability_unavailable(format!(
            "{} is not configured",
            command.as_str()
        )))
    }
}

pub(crate) fn unavailable_domains() -> Arc<dyn ApplicationDomainPort> {
    Arc::new(UnavailableApplicationDomains)
}
