use std::{str::FromStr, sync::Arc};

use async_trait::async_trait;

use crate::{ApplicationError, Principal};

macro_rules! domain_commands {
    ($($variant:ident => $name:literal / $scope:literal),+ $(,)?) => {
        /// Closed set of non-Conversation product commands supported by remote hosts.
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub enum DomainCommand {
            $($variant,)+
        }

        impl DomainCommand {
            pub const ALL: &'static [Self] = &[$(Self::$variant,)+];

            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $name,)+
                }
            }

            pub const fn required_scope(self) -> &'static str {
                match self {
                    $(Self::$variant => $scope,)+
                }
            }
        }

        impl FromStr for DomainCommand {
            type Err = ();

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::ALL
                    .iter()
                    .copied()
                    .find(|command| command.as_str() == value)
                    .ok_or(())
            }
        }
    };
}

domain_commands! {
    PluginActionCatalog => "plugin_action_catalog" / "plugin.read",
    PluginControlCatalog => "plugin_control_catalog" / "plugin.read",
    PluginProductDetail => "plugin_product_detail" / "plugin.read",
    PluginSaveConfig => "plugin_save_config" / "plugin.write",
    PluginContributionCatalog => "plugin_contribution_catalog" / "plugin.read",
    PluginResolveFileOpener => "plugin_resolve_file_opener" / "plugin.read",
    PluginOpenFilePreview => "plugin_open_file_preview" / "artifact.preview",
    PluginCloseFilePreview => "plugin_close_file_preview" / "artifact.preview",
    PluginControlSetEnabled => "plugin_control_set_enabled" / "plugin.write",
    PluginControlGrantPermissions => "plugin_control_grant_permissions" / "plugin.write",
    PluginControlInstallRuntime => "plugin_control_install_runtime" / "plugin.write",
    PluginControlImport => "plugin_control_import" / "plugin.write",
    PluginMarketplaceCatalog => "plugin_marketplace_catalog" / "plugin.read",
    PluginMarketplaceListing => "plugin_marketplace_listing" / "plugin.read",
    PluginMarketplaceInstall => "plugin_marketplace_install" / "plugin.write",
    PluginCheckUpdates => "plugin_check_updates" / "plugin.read",
    PluginControlLogs => "plugin_control_logs" / "plugin.read",
    PluginControlUninstall => "plugin_control_uninstall" / "plugin.write",
    PluginControlGcRuntimes => "plugin_control_gc_runtimes" / "plugin.write",
    PluginSurfaceOpen => "plugin_surface_open" / "plugin.surface",
    PluginSurfaceInvoke => "plugin_surface_invoke" / "plugin.surface",
    PluginSurfaceRevoke => "plugin_surface_revoke" / "plugin.surface",
    ProjectList => "get_projects" / "application.call",
    ProjectGet => "get_project" / "application.call",
    ProjectCreate => "create_project" / "application.call",
    ProjectUpdate => "update_project" / "application.call",
    ProjectDelete => "delete_project" / "application.call",
    ProjectSearchFiles => "search_project_files" / "application.call",
    ProjectRepositories => "get_project_repositories" / "application.call",
    ProjectAddRepository => "add_project_repository" / "application.call",
    ProjectDeleteRepository => "delete_project_repository" / "application.call",
    RepoList => "get_repos" / "application.call",
    RepoGet => "get_repo" / "application.call",
    RepoRegister => "register_repo" / "application.call",
    RepoRecent => "get_recent_repos" / "application.call",
    RepoInit => "init_repo" / "application.call",
    RepoCheckPath => "check_git_repo_path" / "application.call",
    RepoClone => "clone_repo" / "application.call",
    RepoBranches => "get_repo_branches" / "application.call",
    RepoGitStatus => "get_repo_git_status" / "application.call",
    RepoFileDiffs => "get_repo_file_diffs" / "application.call",
    RepoStageFile => "stage_repo_file" / "application.call",
    RepoUnstageFile => "unstage_repo_file" / "application.call",
    RepoRevertFile => "revert_repo_file" / "application.call",
    RepoStageAll => "stage_repo_all" / "application.call",
    RepoRevertAll => "revert_repo_all" / "application.call",
    RepoCommit => "commit_repo_changes" / "application.call",
    RepoGitLog => "get_repo_git_log" / "application.call",
    RepoCheckoutBranch => "checkout_repo_branch" / "application.call",
    RepoCreateBranch => "create_repo_branch" / "application.call",
    RepoDeleteBranch => "delete_repo_branch" / "application.call",
    WorkspaceList => "get_workspaces" / "application.call",
    WorkspaceListByProject => "get_project_workspaces" / "application.call",
    WorkspaceGet => "get_workspace" / "application.call",
    WorkspaceCount => "get_workspace_count" / "application.call",
    WorkspaceRepos => "get_workspace_repos" / "application.call",
    WorkspaceGitStatus => "get_workspace_git_status" / "application.call",
    WorkspaceStageFile => "stage_workspace_file" / "application.call",
    WorkspaceStageAll => "stage_workspace_all" / "application.call",
    WorkspaceUnstageFile => "unstage_workspace_file" / "application.call",
    WorkspaceRevertFile => "revert_workspace_file" / "application.call",
    WorkspaceRevertAll => "revert_workspace_all" / "application.call",
    WorkspaceFileDiffs => "get_workspace_file_diffs" / "application.call",
    WorkspaceCommit => "commit_workspace_changes" / "application.call",
    WorkspaceGitLog => "get_workspace_git_log" / "application.call",
    WorkspaceCommitDetail => "get_workspace_commit_detail" / "application.call",
    WorkspaceCheckoutBranch => "checkout_workspace_branch" / "application.call",
    WorkspaceCreateBranch => "create_workspace_branch" / "application.call",
    WorkspaceDeleteBranch => "delete_workspace_branch" / "application.call",
    SessionList => "get_sessions" / "application.call",
    SessionSummaries => "get_session_summaries" / "application.call",
    SessionGet => "get_session" / "application.call",
    SessionCreate => "create_session" / "application.call",
    SessionCreateProjectRoot => "create_project_root_session" / "application.call",
    SessionCreateProject => "create_project_session" / "application.call",
    SessionEnsureWorkspace => "ensure_project_workspace" / "application.call",
    SessionRename => "rename_session" / "application.call",
    SessionUpdateStatus => "update_session_status" / "application.call",
    SessionMarkViewed => "mark_session_viewed" / "application.call",
    SessionSetPinned => "set_session_pinned" / "application.call",
    SessionDelete => "delete_session" / "application.call",
    FileTree => "get_file_tree" / "application.call",
    FileRead => "read_file_content" / "application.call",
    FileSave => "save_file_content" / "application.call",
    FileDelete => "delete_file" / "application.call",
    FileListChildren => "list_directory_children" / "application.call",
    FileReadTruncated => "read_file_with_truncation" / "application.call",
    FileCopy => "copy_item" / "application.call",
    FileMove => "move_item" / "application.call",
    FileCreateDirectory => "create_directory" / "application.call",
    FileSearchText => "search_workspace_text" / "application.call",
    FileListDirectory => "list_directory" / "application.call",
    FileListGitRepos => "list_git_repos" / "application.call",
    FileAtHead => "get_file_at_head" / "application.call",
    TerminalCreate => "create_terminal" / "application.call",
    TerminalWrite => "write_terminal" / "application.call",
    TerminalResize => "resize_terminal" / "application.call",
    TerminalClose => "close_terminal" / "application.call",
    TerminalAttach => "attach_terminal" / "application.call",
    AgentManagementBar => "agent_management_bar" / "application.call",
    AgentManagementDetail => "agent_management_detail" / "application.call",
    AgentManagementSetEnabled => "agent_management_set_enabled" / "application.call",
    AgentManagementRefresh => "agent_management_refresh" / "application.call",
    AgentCapabilityCatalog => "agent_capability_catalog" / "application.call",
    AgentSkillsList => "list_agent_skills" / "application.call",
    UserSystemInfo => "get_user_system_info" / "application.call",
    ArtifactList => "artifact_list" / "artifact.read",
    ArtifactOpenPreview => "artifact_open_preview" / "artifact.preview",
    ArtifactClosePreview => "artifact_close_preview" / "artifact.preview",
    AutomationList => "automation_list" / "automation.read",
    AutomationEngineStatus => "automation_engine_status" / "automation.read",
    AutomationCreate => "automation_create" / "automation.write",
    AutomationCreateWorkflow => "automation_create_workflow" / "automation.write",
    AutomationUpdate => "automation_update" / "automation.write",
    AutomationSetEnabled => "automation_set_enabled" / "automation.write",
    AutomationDelete => "automation_delete" / "automation.write",
    AutomationRunNow => "automation_run_now" / "automation.write",
    AutomationCancelRun => "automation_cancel_run" / "automation.write",
    AutomationRuns => "automation_runs" / "automation.read",
    AutomationPreviewNextRuns => "automation_preview_next_runs" / "automation.read",
    AutomationTemplates => "automation_templates" / "automation.read",
    AutomationUnseenFailures => "automation_unseen_failures" / "automation.read",
    AutomationMarkSeen => "automation_mark_seen" / "automation.write",
    DelegationCancel => "delegation_cancel" / "delegation.cancel",
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
