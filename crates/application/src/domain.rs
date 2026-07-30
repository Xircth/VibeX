use std::{str::FromStr, sync::Arc};

use async_trait::async_trait;

use crate::{ApplicationError, Principal};

/// Closed set of non-Conversation product commands supported by remote hosts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DomainCommand {
    PluginActionCatalog,
    PluginLegacyMigrationList,
    ProjectList,
    ProjectRepositories,
    RepoBranches,
    AgentManagementBar,
    AgentCapabilityCatalog,
    UserSystemInfo,
    OfficeCliInstall,
    OfficeCliCancelInstall,
    OfficePluginSetEnabled,
    ArtifactList,
    ArtifactOpenPreview,
    ArtifactClosePreview,
    AutomationList,
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
            Self::PluginLegacyMigrationList => "plugin_legacy_migration_list",
            Self::ProjectList => "get_projects",
            Self::ProjectRepositories => "get_project_repositories",
            Self::RepoBranches => "get_repo_branches",
            Self::AgentManagementBar => "agent_management_bar",
            Self::AgentCapabilityCatalog => "agent_capability_catalog",
            Self::UserSystemInfo => "get_user_system_info",
            Self::OfficeCliInstall => "officecli_install",
            Self::OfficeCliCancelInstall => "officecli_cancel_install",
            Self::OfficePluginSetEnabled => "office_plugin_set_enabled",
            Self::ArtifactList => "artifact_list",
            Self::ArtifactOpenPreview => "artifact_open_preview",
            Self::ArtifactClosePreview => "artifact_close_preview",
            Self::AutomationList => "automation_list",
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
            Self::PluginActionCatalog | Self::PluginLegacyMigrationList => "plugin.read",
            Self::ProjectList
            | Self::ProjectRepositories
            | Self::RepoBranches
            | Self::AgentManagementBar
            | Self::AgentCapabilityCatalog
            | Self::UserSystemInfo => "application.call",
            Self::ArtifactList => "artifact.read",
            Self::ArtifactOpenPreview | Self::ArtifactClosePreview => "artifact.preview",
            Self::AutomationList
            | Self::AutomationRuns
            | Self::AutomationPreviewNextRuns
            | Self::AutomationTemplates
            | Self::AutomationUnseenFailures => "automation.read",
            Self::OfficeCliInstall
            | Self::OfficeCliCancelInstall
            | Self::OfficePluginSetEnabled => "plugin.write",
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
            Self::PluginLegacyMigrationList,
            Self::ProjectList,
            Self::ProjectRepositories,
            Self::RepoBranches,
            Self::AgentManagementBar,
            Self::AgentCapabilityCatalog,
            Self::UserSystemInfo,
            Self::OfficeCliInstall,
            Self::OfficeCliCancelInstall,
            Self::OfficePluginSetEnabled,
            Self::ArtifactList,
            Self::ArtifactOpenPreview,
            Self::ArtifactClosePreview,
            Self::AutomationList,
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
