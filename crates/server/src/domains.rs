use std::{collections::HashSet, sync::Arc};

use agents::AgentId;
use application::{ApplicationDomainPort, ApplicationError, DomainCommand, Principal};
use artifacts::{ArtifactRepository, SqliteArtifactRepository};
use async_trait::async_trait;
use automation::{
    AutomationDraft, AutomationDraftInput, AutomationSpec, AutomationTarget,
    BuiltinTemplateCatalog, ClaimedRun, PORTABLE_AUTOMATION_SPEC_VERSION, PluginActionCatalogPort,
    PortableAutomationTarget, PortableTurnLaunchSpec, PortableWorkflowLaunchSpec,
    PortableWorkspaceRef, RunStatus, ScheduleService, ScheduleSpec, SystemClock, TurnLaunchSpec,
    TurnLaunchSpecInput, WORKFLOW_AUTOMATION_SPEC_VERSION, WorkflowAutomationDraft,
    WorkflowLaunchSpec, WorkspaceTarget,
};
use chrono::{DateTime, Utc};
use conversations::{ConversationContext, ConversationSessionService};
use db::models::{
    automation_v2::{AutomationRecord, AutomationRunRecord, SqliteAutomationStore},
    project::Project,
    project_repo::ProjectRepo,
};
use deployment::Deployment;
use local_deployment::LocalDeployment;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{PreviewProxyRegistry, automation_runtime::HeadlessAutomationRuntime};

#[derive(Clone)]
pub struct ServerApplicationDomains {
    pub(crate) pool: SqlitePool,
    pub(crate) plugin_control_plane: Arc<plugins::PluginControlPlane>,
    preview_host: Arc<dyn plugins::PluginPreviewHost>,
    pub(crate) capability_broker: Arc<plugins::HostCapabilityBroker>,
    app_surfaces: Arc<plugins::PluginAppSurfaceHost>,
    preview_proxy: PreviewProxyRegistry,
    automation: HeadlessAutomationRuntime,
    owns_automation_engine: bool,
    pub(crate) conversations: ConversationContext,
    pub(crate) deployment: Arc<LocalDeployment>,
    pub(crate) runtime_root: std::path::PathBuf,
    pub(crate) worker_runtime: Arc<plugins::PluginWorkerRuntimeProvider>,
}

pub struct ServerDomainDependencies {
    pub pool: SqlitePool,
    pub plugin_control_plane: Arc<plugins::PluginControlPlane>,
    pub preview_host: Arc<dyn plugins::PluginPreviewHost>,
    pub capability_broker: Arc<plugins::HostCapabilityBroker>,
    pub app_surfaces: Arc<plugins::PluginAppSurfaceHost>,
    pub preview_proxy: PreviewProxyRegistry,
    pub automation: HeadlessAutomationRuntime,
    pub owns_automation_engine: bool,
    pub conversations: ConversationContext,
    pub deployment: Arc<LocalDeployment>,
    pub runtime_root: std::path::PathBuf,
    pub worker_runtime: Arc<plugins::PluginWorkerRuntimeProvider>,
}

impl ServerApplicationDomains {
    pub fn new(dependencies: ServerDomainDependencies) -> Self {
        let ServerDomainDependencies {
            pool,
            plugin_control_plane,
            preview_host,
            capability_broker,
            app_surfaces,
            preview_proxy,
            automation,
            owns_automation_engine,
            conversations,
            deployment,
            runtime_root,
            worker_runtime,
        } = dependencies;
        Self {
            pool,
            plugin_control_plane,
            preview_host,
            capability_broker,
            app_surfaces,
            preview_proxy,
            automation,
            owns_automation_engine,
            conversations,
            deployment,
            runtime_root,
            worker_runtime,
        }
    }

    fn automation_store(&self) -> SqliteAutomationStore {
        SqliteAutomationStore::new(self.pool.clone())
    }

    async fn execute_command(
        &self,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        match command {
            DomainCommand::PluginActionCatalog => self.plugin_catalog().await,
            DomainCommand::PluginControlCatalog => self.plugin_control_catalog().await,
            DomainCommand::PluginProductDetail => self.plugin_product_detail(args).await,
            DomainCommand::PluginSaveConfig => self.plugin_save_config(args).await,
            DomainCommand::PluginContributionCatalog => self.plugin_contribution_catalog().await,
            DomainCommand::PluginResolveFileOpener => self.plugin_resolve_file_opener(args).await,
            DomainCommand::PluginOpenFilePreview => self.plugin_open_file_preview(args).await,
            DomainCommand::PluginCloseFilePreview => self.plugin_close_file_preview(args).await,
            DomainCommand::PluginRenewFilePreview => self.plugin_renew_file_preview(args).await,
            DomainCommand::PluginControlSetEnabled => self.plugin_control_set_enabled(args).await,
            DomainCommand::PluginControlGrantPermissions => {
                self.plugin_control_grant_permissions(args).await
            }
            DomainCommand::PluginControlInstallRuntime => {
                self.plugin_control_install_runtime(args).await
            }
            DomainCommand::PluginControlImport => self.plugin_control_import(args).await,
            DomainCommand::PluginMarketplaceCatalog => self.plugin_marketplace_catalog(args).await,
            DomainCommand::PluginMarketplaceListing => self.plugin_marketplace_listing(args).await,
            DomainCommand::PluginMarketplaceInstall => self.plugin_marketplace_install(args).await,
            DomainCommand::PluginCheckUpdates => self.plugin_check_updates().await,
            DomainCommand::PluginControlLogs => self.plugin_control_logs(args).await,
            DomainCommand::PluginControlUninstall => self.plugin_control_uninstall(args).await,
            DomainCommand::PluginControlGcRuntimes => self.plugin_control_gc_runtimes(args).await,
            DomainCommand::PluginSurfaceOpen => self.plugin_surface_open(args).await,
            DomainCommand::PluginSurfaceInvoke => self.plugin_surface_invoke(args).await,
            DomainCommand::PluginSurfaceRevoke => self.plugin_surface_revoke(args).await,
            DomainCommand::ProjectList => self.project_list().await,
            DomainCommand::ProjectRepositories => self.project_repositories(args).await,
            DomainCommand::RepoBranches => self.repo_branches(args).await,
            DomainCommand::AgentManagementBar => self.agent_management_bar().await,
            DomainCommand::AgentCapabilityCatalog => self.agent_capability_catalog(args).await,
            DomainCommand::AgentCapabilityCatalogFresh => {
                self.agent_capability_catalog_fresh(args).await
            }
            DomainCommand::AgentRefreshCapabilityCatalog => {
                self.agent_refresh_capability_catalog(args).await
            }
            DomainCommand::AgentSkillsList => self.agent_skills(args).await,
            DomainCommand::UserSystemInfo => self.user_system_info().await,
            DomainCommand::ArtifactList => self.artifact_list(args).await,
            DomainCommand::ArtifactOpenPreview => self.open_preview(args).await,
            DomainCommand::ArtifactClosePreview => self.close_preview(args).await,
            DomainCommand::AutomationList => self.automation_list().await,
            DomainCommand::AutomationEngineStatus => {
                Ok(json!({ "active": self.owns_automation_engine }))
            }
            DomainCommand::AutomationCreate => self.automation_create(args).await,
            DomainCommand::AutomationCreateWorkflow => self.automation_create_workflow(args).await,
            DomainCommand::AutomationUpdate => self.automation_update(args).await,
            DomainCommand::AutomationSetEnabled => self.automation_set_enabled(args).await,
            DomainCommand::AutomationDelete => self.automation_delete(args).await,
            DomainCommand::AutomationRunNow => self.automation_run_now(args).await,
            DomainCommand::AutomationCancelRun => self.automation_cancel_run(args).await,
            DomainCommand::AutomationRuns => self.automation_runs(args).await,
            DomainCommand::AutomationPreviewNextRuns => self.automation_preview(args),
            DomainCommand::AutomationTemplates => self.automation_templates(),
            DomainCommand::AutomationUnseenFailures => self.automation_unseen_failures().await,
            DomainCommand::AutomationMarkSeen => self.automation_mark_seen().await,
            DomainCommand::AutomationExportSpec => self.automation_export_spec(args).await,
            DomainCommand::AutomationImportSpec => self.automation_import_spec(args).await,
            DomainCommand::DelegationCancel => self.delegation_cancel(args).await,
            DomainCommand::ConversationDetail => self.conversation_detail(args).await,
            DomainCommand::ConversationEventsSince => self.conversation_events_since(args).await,
            DomainCommand::ConversationEnsureSessionControls => {
                self.conversation_ensure_session_controls(args).await
            }
            DomainCommand::ConversationTimelinePage => self.conversation_timeline_page(args).await,
            DomainCommand::ConversationRebindSession => {
                self.conversation_rebind_session(args).await
            }
            DomainCommand::ConversationTruncateToTurn => {
                self.conversation_truncate_to_turn(args).await
            }
            DomainCommand::ConversationSearch => self.conversation_search_host(args).await,
            DomainCommand::ConversationExportMarkdown => {
                self.conversation_export_text(args, false).await
            }
            DomainCommand::ConversationExportHtml => {
                self.conversation_export_text(args, true).await
            }
            DomainCommand::ConversationExport => self.conversation_export_bundle(args).await,
            DomainCommand::ConversationClose => self.conversation_close_host(args).await,
            DomainCommand::ConversationCheckpointPreview => {
                self.conversation_checkpoint_preview(args).await
            }
            DomainCommand::ConversationImport => self.conversation_import_host(args).await,
            DomainCommand::ConversationFork => self.conversation_fork_host(args).await,
            DomainCommand::WorkspaceContinueConflicts
            | DomainCommand::WorkspaceConflictFile
            | DomainCommand::WorkspaceWriteConflictResolution
            | DomainCommand::WorkspaceShowStash
            | DomainCommand::WorkspaceCreatePr
            | DomainCommand::WorkspaceAttachPr
            | DomainCommand::WorkspaceCreateFromPr
            | DomainCommand::WorkspaceRunSetupScript
            | DomainCommand::WorkspaceRunCleanupScript
            | DomainCommand::WorkspaceRunArchiveScript => self.product_command(command, args).await,
            DomainCommand::AgentScanLocalHistory => self.surface_command(command, args).await,
            DomainCommand::WorkspaceCreate
            | DomainCommand::WorkspaceUpdate
            | DomainCommand::WorkspaceDelete
            | DomainCommand::WorkspaceMarkSeen
            | DomainCommand::WorkspaceChildren
            | DomainCommand::WorkspaceBranchStatus
            | DomainCommand::WorkspaceCommitHistory
            | DomainCommand::WorkspaceCommitGraph
            | DomainCommand::WorkspaceCommitDiffs
            | DomainCommand::WorkspacePush
            | DomainCommand::WorkspacePull
            | DomainCommand::WorkspaceFetch
            | DomainCommand::WorkspaceMerge
            | DomainCommand::WorkspaceRebase
            | DomainCommand::WorkspaceRebaseBack
            | DomainCommand::WorkspaceContinueRebase
            | DomainCommand::WorkspaceAbortConflicts
            | DomainCommand::WorkspaceStash
            | DomainCommand::WorkspaceStashList
            | DomainCommand::WorkspaceStashApply
            | DomainCommand::WorkspaceStashPop
            | DomainCommand::WorkspaceStashDrop
            | DomainCommand::WorkspaceRenameBranch
            | DomainCommand::WorkspaceChangeTargetBranch
            | DomainCommand::AutomationUpdateWorkflow
            | DomainCommand::AttentionInboxList
            | DomainCommand::ScratchGet
            | DomainCommand::ScratchCreate
            | DomainCommand::ScratchUpdate
            | DomainCommand::ScratchDelete
            | DomainCommand::TagList
            | DomainCommand::TagCreate
            | DomainCommand::TagUpdate
            | DomainCommand::TagDelete
            | DomainCommand::TaskGet
            | DomainCommand::TaskCreate
            | DomainCommand::TaskCreateAndStart
            | DomainCommand::TaskUpdate
            | DomainCommand::TaskDelete
            | DomainCommand::RepoUpdate
            | DomainCommand::RepoPush
            | DomainCommand::RepoPull
            | DomainCommand::RepoFetch
            | DomainCommand::RepoRemotes
            | DomainCommand::RepoAddRemote
            | DomainCommand::RepoRemoveRemote
            | DomainCommand::RepoSetRemoteUrl
            | DomainCommand::RepoCommitDetail
            | DomainCommand::RepoCommitDiffs
            | DomainCommand::RepoSearch
            | DomainCommand::RepoIssues
            | DomainCommand::RepoOpenPrs
            | DomainCommand::WorkflowSourceRead
            | DomainCommand::WorkflowSourceWrite
            | DomainCommand::AgentListLiveTerminals
            | DomainCommand::AgentPlanUsage
            | DomainCommand::FrontendPreferencesGet
            | DomainCommand::FrontendPreferencesUpdate
            | DomainCommand::ProjectWorktreeSettingsGet
            | DomainCommand::ProjectWorktreeSettingsUpdate
            | DomainCommand::ReadBinaryAsset => self.product_command(command, args).await,
            DomainCommand::SubscribeDiffStream
            | DomainCommand::SubscribeConversationStream
            | DomainCommand::SubscribeExecutionProcessesStream
            | DomainCommand::SubscribeProjectWorkspacesStream
            | DomainCommand::SubscribeProjectsStream
            | DomainCommand::SubscribeFileTreeStream
            | DomainCommand::SubscribeScratchStream
            | DomainCommand::SubscribeLogStream
            | DomainCommand::SubscribeSlashCommandsStream => {
                self.subscribe_stream(command, args).await
            }
            DomainCommand::AgentConnect
            | DomainCommand::AgentPrepareSession
            | DomainCommand::AgentNewSession
            | DomainCommand::AgentResumeSession
            | DomainCommand::AgentSendPrompt
            | DomainCommand::AgentCancelPrompt
            | DomainCommand::AgentDisconnect
            | DomainCommand::AgentRespondPermission
            | DomainCommand::AgentRuntimeSnapshot
            | DomainCommand::AgentConnectionSnapshot
            | DomainCommand::AgentLoadSession
            | DomainCommand::AgentListSessionCommands
            | DomainCommand::AgentDiscardPreparedSession
            | DomainCommand::AgentSetPreparedSessionMode
            | DomainCommand::AgentSetPreparedSessionConfig
            | DomainCommand::AgentListRemoteSessions
            | DomainCommand::AgentDeleteRemoteSession
            | DomainCommand::AgentImportRemoteSession
            | DomainCommand::AgentResetToCheckpoint
            | DomainCommand::AgentListLocalHistory
            | DomainCommand::AgentImportLocalHistory
            | DomainCommand::AgentImportLocalHistoryBatch
            | DomainCommand::AgentLocalHistoryImportSnapshot
            | DomainCommand::AgentTerminalSnapshot
            | DomainCommand::AgentSessionDefaults
            | DomainCommand::AgentSetSessionDefaults
            | DomainCommand::AgentRegistryView
            | DomainCommand::AgentRegistryRefresh
            | DomainCommand::AgentRegistryAddAndInstall
            | DomainCommand::AgentUserDefinitionAddAndInstall
            | DomainCommand::AgentUserDefinitionDetail
            | DomainCommand::AgentUserDefinitionUpdate
            | DomainCommand::AgentManagementReorder
            | DomainCommand::AgentManagementInstallVersion
            | DomainCommand::AgentManagementRepair
            | DomainCommand::AgentManagementApplyUpdate
            | DomainCommand::AgentManagementUninstall
            | DomainCommand::AgentManagementRemove
            | DomainCommand::AgentManagementRollback
            | DomainCommand::AgentManagementCheckUpdate
            | DomainCommand::AgentManagementCancelOperation
            | DomainCommand::AgentManagementPreflight
            | DomainCommand::AgentManagementActions
            | DomainCommand::AgentManagementRunAction
            | DomainCommand::AgentManagementAccountFlow
            | DomainCommand::AgentManagementDiscoveryProgress
            | DomainCommand::AgentManagementDiagnostics
            | DomainCommand::AgentManagementEnvironmentDiagnostics
            | DomainCommand::AgentManagementClearDiagnostics
            | DomainCommand::AgentManagementMarkDiagnosticsRead
            | DomainCommand::AgentManagementEnvironment
            | DomainCommand::AgentManagementEnvironmentWrite
            | DomainCommand::AgentManagementConfigRead
            | DomainCommand::AgentManagementConfigWrite
            | DomainCommand::AgentManagementConfigFileWrite
            | DomainCommand::AgentAuthMode
            | DomainCommand::AgentAuthModeSet
            | DomainCommand::AgentModelProviders
            | DomainCommand::AgentModelProviderSave
            | DomainCommand::AgentModelProviderDelete
            | DomainCommand::AgentModelProviderBind
            | DomainCommand::AgentModelProviderCatalog
            | DomainCommand::AgentModelProviderProbe
            | DomainCommand::AgentModelProviderImport
            | DomainCommand::AgentModelProviderImportPreview
            | DomainCommand::CodexModelCatalog
            | DomainCommand::CodexModelCatalogApply
            | DomainCommand::CodexModelCatalogConfig
            | DomainCommand::CodexRequestDeviceCode
            | DomainCommand::CodexPollDeviceCode
            | DomainCommand::CursorModelCatalog
            | DomainCommand::KimiModelCatalog
            | DomainCommand::CreateWorkflowDebugWorkspace
            | DomainCommand::GetChatEventWebhooks
            | DomainCommand::SetChatEventWebhooks
            | DomainCommand::GetChatMessageLanguage
            | DomainCommand::SetChatMessageLanguage
            | DomainCommand::WeixinGetQrcode
            | DomainCommand::WeixinCheckQrcode
            | DomainCommand::PluginWorkflowCatalog
            | DomainCommand::PluginMarketplaceIndex
            | DomainCommand::PluginInstall
            | DomainCommand::PluginUninstall
            | DomainCommand::PluginUpdate
            | DomainCommand::PluginControlUpdate
            | DomainCommand::PluginControlPreviewImport
            | DomainCommand::PluginControlRollback
            | DomainCommand::PluginControlContributions
            | DomainCommand::PluginControlConfigureAgents
            | DomainCommand::PluginControlConfigureMcp
            | DomainCommand::PluginInvokeContribution
            | DomainCommand::DshPlugins
            | DomainCommand::DshPluginAdd
            | DomainCommand::DshPluginRemove
            | DomainCommand::DshProviders
            | DomainCommand::DshProviderSave
            | DomainCommand::DshProviderDelete
            | DomainCommand::DshProviderDiscoverModels
            | DomainCommand::GrokPlugins
            | DomainCommand::GrokPluginAdd
            | DomainCommand::GrokPluginRemove
            | DomainCommand::PiPlugins
            | DomainCommand::PiPluginAdd
            | DomainCommand::PiPluginRemove
            | DomainCommand::PiConfiguration
            | DomainCommand::PiCredentialsSave
            | DomainCommand::PiRuntimeSave
            | DomainCommand::PiCommandValidate
            | DomainCommand::OpenCodePluginList
            | DomainCommand::OpenCodePluginAdd
            | DomainCommand::OpenCodePluginInstall
            | DomainCommand::OpenCodePluginUninstall
            | DomainCommand::OpenCodeProviderCatalog
            | DomainCommand::OpenCodeProviderConnect
            | DomainCommand::OpenCodeProviderConnections
            | DomainCommand::OpenCodeProviderDisconnect
            | DomainCommand::OpenCodeProviderImport
            | DomainCommand::OpenCodeProviderSetEnabled => {
                self.surface_command(command, args).await
            }
            other if crate::host::catalog::handles(other) => {
                crate::host::catalog::dispatch(self, other, args).await
            }
            other => self.host_ops(other, args).await,
        }
    }

    pub(crate) async fn plugin_catalog(&self) -> Result<Value, ApplicationError> {
        let control_plane = self.plugin_control_plane().await?;
        let inventory = control_plane
            .runtime_inventory()
            .await
            .map_err(internal_error)?;
        let actions = control_plane
            .catalog()
            .await
            .map_err(internal_error)?
            .into_iter()
            .filter(|plugin| plugin.activation == plugins::PluginActivation::Enabled)
            .filter(|plugin| {
                plugin.runtimes.iter().all(|required| {
                    inventory.iter().any(|installed| {
                        installed.id == required.id
                            && required
                                .version
                                .as_deref()
                                .is_none_or(|version| version == installed.version)
                    })
                })
            })
            .flat_map(|plugin| {
                let plugin_id = plugin.id().to_owned();
                let required_tools = plugin
                    .runtimes
                    .iter()
                    .map(|runtime| runtime.id.clone())
                    .collect::<Vec<_>>();
                plugin
                    .package
                    .invocations
                    .into_iter()
                    .filter_map(move |invocation| {
                        (invocation.kind == plugins::InvocationKind::Action).then(|| {
                            json!({
                                "pluginId": plugin_id,
                                "actionId": invocation.id,
                                "label": invocation.label,
                                "requiredSkills": if invocation.required_skills.is_empty() {
                                    invocation.skill.into_iter().collect::<Vec<_>>()
                                } else {
                                    invocation.required_skills
                                },
                                "requiredTools": required_tools,
                                "promptBlocks": [{ "type": "text", "text": invocation.prompt }],
                                "artifactIntent": null,
                            })
                        })
                    })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "actions": actions }))
    }

    async fn plugin_control_catalog(&self) -> Result<Value, ApplicationError> {
        let control_plane = self.plugin_control_plane().await?;
        let plugins = control_plane.catalog().await.map_err(internal_error)?;
        let runtimes = control_plane
            .runtime_inventory()
            .await
            .map_err(internal_error)?;
        let plugin_values = plugins.iter().map(plugin_control_item).collect::<Vec<_>>();
        let runtime_values = runtimes
            .into_iter()
            .map(|runtime| {
                json!({
                    "id": runtime.id,
                    "version": runtime.version,
                    "target": runtime.target,
                    "contentDigest": runtime.content_digest,
                    // Remote catalog readers receive runtime identity/evidence,
                    // never a Host filesystem capability or absolute path.
                    "executablePath": "",
                    "ownership": runtime.ownership,
                    "installer": runtime.installer,
                    "probe": runtime.probe,
                    "referencedPlugins": runtime.referenced_plugins,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "plugins": plugin_values, "runtimes": runtime_values }))
    }

    async fn plugin_product_detail(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginIdentityArgs = parse(args)?;
        let plugin = self
            .plugin_control_plane()
            .await?
            .plugin(&args.plugin_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("plugin {}", args.plugin_id)))?;
        serialize(plugin.product_detail().map_err(internal_error)?)
    }

    async fn plugin_save_config(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginConfigArgs = parse(args)?;
        let plugin = self
            .plugin_control_plane()
            .await?
            .plugin(&args.plugin_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("plugin {}", args.plugin_id)))?;
        plugin.write_config(args.config).map_err(internal_error)?;
        self.plugin_control_plane()
            .await?
            .sync_official_product_mcp_gate()
            .await
            .map_err(internal_error)?;
        let refreshed = plugins::PluginPackage::inspect(&plugin.source.path, plugin.source.kind)
            .map_err(internal_error)?;
        serialize(refreshed.product_detail().map_err(internal_error)?)
    }

    async fn plugin_contribution_catalog(&self) -> Result<Value, ApplicationError> {
        let catalog = self
            .plugin_control_plane()
            .await?
            .contributions()
            .await
            .map_err(internal_error)?;
        serialize(catalog)
    }

    async fn plugin_resolve_file_opener(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: ResolveFileOpenerArgs = parse(args)?;
        serialize(
            self.plugin_control_plane()
                .await?
                .resolve_file_opener(args.extension.as_deref(), args.media_type.as_deref())
                .await
                .map_err(internal_error)?,
        )
    }

    async fn plugin_control_set_enabled(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginEnabledArgs = parse(args)?;
        let control_plane = self.plugin_control_plane().await?;
        if args.enabled {
            let plugin = control_plane
                .plugin(&args.plugin_id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| ApplicationError::not_found(format!("plugin {}", args.plugin_id)))?;
            self.ensure_plugin_runtimes(&plugin).await?;
            let grants = plugins::candidate_capability_grants(&plugin.package, &[], &[])
                .map_err(plugin_error)?;
            control_plane
                .validate_runtime_readiness(&args.plugin_id)
                .await
                .map_err(|error| ApplicationError::conflict(error.to_string()))?;
            control_plane
                .activate_and_enable(
                    &self
                        .worker_runtime
                        .resolve()
                        .await
                        .map_err(internal_error)?,
                    &args.plugin_id,
                    &grants,
                    self.capability_broker.clone(),
                )
                .await
                .map_err(|error| ApplicationError::conflict(error.to_string()))?;
        } else {
            control_plane
                .set_enabled(&args.plugin_id, false)
                .await
                .map_err(internal_error)?;
        }
        let plugin = control_plane
            .plugin(&args.plugin_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("plugin {}", args.plugin_id)))?;
        Ok(plugin_control_item(&plugin))
    }

    async fn plugin_control_grant_permissions(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: PluginGrantPermissionsArgs = parse(args)?;
        let control_plane = self.plugin_control_plane().await?;
        control_plane
            .grant_permissions(&args.plugin_id, &args.permission_ids)
            .await
            .map_err(internal_error)?;
        serialize(
            control_plane
                .capability_grants(&args.plugin_id)
                .await
                .map_err(internal_error)?,
        )
    }

    async fn plugin_control_install_runtime(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginRuntimeArgs = parse(args)?;
        let control_plane = self.plugin_control_plane().await?;
        let plugin = control_plane
            .plugin(&args.plugin_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("plugin {}", args.plugin_id)))?;
        let runtime = plugin
            .runtimes
            .iter()
            .find(|runtime| runtime.id == args.runtime_id)
            .ok_or_else(|| ApplicationError::not_found(format!("runtime {}", args.runtime_id)))?;
        let installation = self.install_declared_runtime(&plugin, runtime).await?;
        serialize(installation)
    }

    async fn ensure_plugin_runtimes(
        &self,
        plugin: &plugins::InstalledPlugin,
    ) -> Result<(), ApplicationError> {
        for runtime in &plugin.runtimes {
            let ready = self
                .plugin_control_plane
                .runtime_for_plugin(plugin.id(), &runtime.id)
                .await
                .map_err(plugin_error)?
                .is_some_and(|locked| runtime_lock_matches(runtime, &locked));
            if !ready {
                self.install_declared_runtime(plugin, runtime).await?;
            }
        }
        Ok(())
    }

    async fn install_declared_runtime(
        &self,
        plugin: &plugins::InstalledPlugin,
        runtime: &plugins::RuntimeContribution,
    ) -> Result<plugins::RuntimeInstallation, ApplicationError> {
        if let Some(existing) = self
            .plugin_control_plane
            .runtime_inventory()
            .await
            .map_err(plugin_error)?
            .into_iter()
            .find(|locked| runtime_lock_matches(runtime, locked))
        {
            self.plugin_control_plane
                .record_runtime(plugin.id(), existing.clone())
                .await
                .map_err(plugin_error)?;
            return Ok(existing);
        }
        let host = plugins::ContentAddressedRuntimeHost::new(self.runtime_root.clone(), runtime)
            .map_err(plugin_error)?;
        let installation = plugins::GlobalRuntimeInstaller::new(&host)
            .install(plugin.id(), runtime)
            .await
            .map_err(plugin_error)?;
        self.plugin_control_plane
            .record_runtime(plugin.id(), installation.clone())
            .await
            .map_err(plugin_error)?;
        Ok(installation)
    }

    pub(crate) async fn plugin_control_import(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PluginImportArgs {
            path: String,
            #[serde(default)]
            conflict: Option<String>,
            #[serde(default)]
            conflict_decision: Option<String>,
            #[serde(default)]
            developer_link: bool,
            #[serde(default)]
            origin: Option<String>,
            #[serde(default)]
            git_ref: Option<String>,
            #[serde(default)]
            git_sha: Option<String>,
            #[serde(default)]
            locked: bool,
            #[serde(default)]
            show_tree: Option<bool>,
        }
        let args: PluginImportArgs = parse(args)?;
        let source = std::path::PathBuf::from(&args.path);
        if !source.exists() {
            return Err(ApplicationError::not_found(format!(
                "plugin path {}",
                args.path
            )));
        }
        if args.developer_link && source.is_file() {
            return Err(ApplicationError::bad_request(
                "linked development install requires a Plugin directory",
            ));
        }
        let decision = match args
            .conflict
            .as_deref()
            .or(args.conflict_decision.as_deref())
        {
            Some("keep") => plugins::ConflictDecision::KeepInstalled,
            Some("replace") => plugins::ConflictDecision::Replace,
            _ => plugins::ConflictDecision::Reject,
        };
        let source_kind = if args.developer_link {
            plugins::PluginSourceKind::DeveloperLink
        } else if plugins::origin_kind(args.origin.as_deref()) == Some("marketplace") {
            plugins::PluginSourceKind::Marketplace
        } else {
            plugins::PluginSourceKind::Snapshot
        };
        let mut package = if args.developer_link {
            plugins::PluginPackage::inspect(&source, source_kind).map_err(plugin_error)?
        } else {
            let storage = self.runtime_root.join("plugins/snapshots");
            plugins::PluginPackage::materialize(&source, &storage, source_kind)
                .map_err(plugin_error)?
        };
        package.source.kind = source_kind;
        package.source.origin = args.origin;
        package.source.git_ref = args.git_ref;
        package.source.git_sha = args.git_sha;
        package.source.locked = args.locked;
        package.source.show_tree = args.show_tree.or(package.source.show_tree);
        let installed = self
            .plugin_control_plane
            .plugin(package.id.as_str())
            .await
            .map_err(plugin_error)?;
        let replacing_enabled = decision == plugins::ConflictDecision::Replace
            && installed
                .as_ref()
                .is_some_and(|plugin| plugin.activation == plugins::PluginActivation::Enabled);
        if replacing_enabled {
            let grants =
                plugins::candidate_capability_grants(&package, &[], &[]).map_err(plugin_error)?;
            let node = self
                .worker_runtime
                .resolve()
                .await
                .map_err(internal_error)?;
            return self
                .plugin_control_plane
                .update_and_activate(&node, package, &grants, self.capability_broker.clone())
                .await
                .map(|plugin| plugin_control_item(&plugin))
                .map_err(|error| ApplicationError::conflict(format!("{}: {error}", error.code())));
        }
        let imported = self
            .plugin_control_plane
            .import(package, decision)
            .await
            .map_err(plugin_error)?;
        Ok(plugin_control_item(&imported.plugin))
    }

    pub(crate) async fn plugin_marketplace_catalog(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CatalogArgs {
            query: Option<String>,
        }
        let args: CatalogArgs = parse(args).unwrap_or(CatalogArgs { query: None });
        let mut page = plugins::fetch_catalog(args.query.as_deref())
            .await
            .unwrap_or_default();
        if let Ok(roots) = utils::assets::materialize_builtin_plugins(&self.runtime_root) {
            plugins::merge_offline_official(&mut page, roots);
        } else {
            page.official = plugins::collapse_replaced_official(page.official);
            plugins::prepare_marketplace_page(&mut page);
        }
        serde_json::to_value(page).map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn plugin_marketplace_listing(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ListingArgs {
            owner: String,
            plugin_name: String,
        }
        let args: ListingArgs = parse(args)?;
        let mut listing = plugins::fetch_listing(&args.owner, &args.plugin_name)
            .await
            .ok();
        if let Ok(roots) = utils::assets::materialize_builtin_plugins(&self.runtime_root) {
            for root in roots {
                if let Ok(package) =
                    plugins::PluginPackage::inspect(&root, plugins::PluginSourceKind::Marketplace)
                {
                    if package.id.as_str() == args.plugin_name
                        || package.id.as_str() == format!("{}.{}", args.owner, args.plugin_name)
                    {
                        let snapshot = listing
                            .take()
                            .unwrap_or_else(|| plugins::listing_from_package(&package, true));
                        return serde_json::to_value(plugins::detail_from_package(
                            &package, snapshot,
                        ))
                        .map_err(|error| ApplicationError::internal(error.to_string()));
                    }
                }
            }
        }
        let listing = listing.ok_or_else(|| {
            ApplicationError::not_found(format!("{}/{}", args.owner, args.plugin_name))
        })?;
        serde_json::to_value(plugins::CatalogPluginDetail {
            summary: listing.summary.clone(),
            readme: listing.readme.clone().unwrap_or_default(),
            contents: Vec::new(),
            listing,
        })
        .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn plugin_marketplace_install(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct InstallArgs {
            owner: String,
            plugin_name: String,
            tag: Option<String>,
            conflict: Option<String>,
        }
        let args: InstallArgs = parse(args)?;
        let decision = match args.conflict.as_deref() {
            Some("keep") => plugins::ConflictDecision::KeepInstalled,
            Some("replace") => plugins::ConflictDecision::Replace,
            _ => plugins::ConflictDecision::Reject,
        };
        if let Ok(listing) =
            plugins::fetch_artifact(&args.owner, &args.plugin_name, args.tag.as_deref()).await
            && let Some(url) = listing.download_url.clone()
            && !url.starts_with("builtin://")
            && !url.starts_with("offline://")
        {
            let archive = download_marketplace_archive(&url).await?;
            return self
                .plugin_control_import(json!({
                    "path": archive.to_string_lossy(),
                    "developerLink": false,
                    "conflictDecision": args.conflict.unwrap_or_else(|| "reject".into()),
                    "origin": plugins::marketplace_listing_url(&args.owner, &args.plugin_name),
                    "gitRef": listing.tag,
                    "locked": true,
                    "showTree": listing.show_tree,
                }))
                .await;
        }
        let roots = utils::assets::materialize_builtin_plugins(&self.runtime_root)
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let root = roots
            .into_iter()
            .find(|root| {
                plugins::PluginPackage::inspect(root, plugins::PluginSourceKind::Marketplace)
                    .ok()
                    .is_some_and(|package| {
                        package.id.as_str() == args.plugin_name
                            || package.id.as_str() == format!("{}.{}", args.owner, args.plugin_name)
                    })
            })
            .ok_or_else(|| {
                ApplicationError::not_found(format!("{}/{}", args.owner, args.plugin_name))
            })?;
        let mut package =
            plugins::PluginPackage::inspect(&root, plugins::PluginSourceKind::Marketplace)
                .map_err(plugin_error)?;
        package.source.origin = Some(plugins::marketplace_listing_url(
            &args.owner,
            &args.plugin_name,
        ));
        package.source.git_ref = args.tag.or(Some(package.version.clone()));
        package.source.locked = true;
        let imported = self
            .plugin_control_plane
            .import(package, decision)
            .await
            .map_err(plugin_error)?;
        Ok(plugin_control_item(&imported.plugin))
    }

    async fn plugin_check_updates(&self) -> Result<Value, ApplicationError> {
        let catalog = self
            .plugin_control_plane
            .catalog()
            .await
            .map_err(plugin_error)?;
        let updates = plugins::check_installed_updates(
            &catalog
                .iter()
                .map(|plugin| plugins::InstalledOrigin {
                    plugin_id: plugin.id().to_owned(),
                    version: plugin.version.clone(),
                    kind: plugin.source.kind,
                    origin: plugin.source.origin.clone(),
                    git_ref: plugin.source.git_ref.clone(),
                })
                .collect::<Vec<_>>(),
        )
        .await;
        serde_json::to_value(updates).map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn plugin_control_logs(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct LogsArgs {
            plugin_id: String,
            #[serde(default)]
            after: u64,
        }
        let args: LogsArgs = parse(args)?;
        let lines = plugins::recent_plugin_logs(&args.plugin_id, args.after);
        serde_json::to_value(json!({ "lines": lines }))
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    pub(crate) async fn plugin_control_uninstall(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PluginUninstallArgs {
            plugin_id: String,
            #[serde(default)]
            retain_data: Option<bool>,
        }
        let args: PluginUninstallArgs = parse(args)?;
        let retain_data = args.retain_data.unwrap_or(true);
        let plugin = self
            .plugin_control_plane
            .plugin(&args.plugin_id)
            .await
            .map_err(plugin_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("plugin {}", args.plugin_id)))?;
        let snapshot = matches!(
            plugin.source.kind,
            plugins::PluginSourceKind::Snapshot | plugins::PluginSourceKind::Marketplace
        )
        .then(|| plugin.source.path.clone());
        self.plugin_control_plane
            .uninstall(&args.plugin_id)
            .await
            .map_err(plugin_error)?;
        if !retain_data && let Some(source) = snapshot {
            remove_managed_plugin_snapshot(&self.runtime_root, &source)?;
        }
        let reclaimed = self
            .plugin_control_plane
            .reclaim_unreferenced_runtimes(&self.runtime_root)
            .await
            .unwrap_or_default();
        Ok(json!({
            "removed": true,
            "pluginId": args.plugin_id,
            "dataRetention": if retain_data { "retained" } else { "deleted" },
            "reclaimedRuntimes": reclaimed,
        }))
    }

    async fn plugin_control_gc_runtimes(&self, _args: Value) -> Result<Value, ApplicationError> {
        let reclaimed = self
            .plugin_control_plane
            .reclaim_unreferenced_runtimes(&self.runtime_root)
            .await
            .map_err(plugin_error)?;
        Ok(json!({ "reclaimed": reclaimed }))
    }

    async fn plugin_surface_open(&self, args: Value) -> Result<Value, ApplicationError> {
        let request: plugins::AppSurfaceOpenRequest = parse(args)?;
        if let Some(path) = request.artifact_path.as_deref() {
            let path = path
                .to_str()
                .ok_or_else(|| ApplicationError::bad_request("artifact path is invalid"))?;
            self.ensure_registered_repo_file(path).await?;
        }
        serialize(
            self.app_surfaces
                .open(request)
                .await
                .map_err(app_surface_error)?,
        )
    }

    pub(crate) async fn plugin_surface_invoke(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        self.app_surfaces
            .invoke(parse(args)?)
            .await
            .map_err(app_surface_error)
    }

    async fn plugin_surface_revoke(&self, args: Value) -> Result<Value, ApplicationError> {
        let identity: plugins::AppSurfaceIdentity = parse(args)?;
        self.app_surfaces
            .revoke(&identity)
            .await
            .map_err(app_surface_error)?;
        Ok(Value::Null)
    }

    async fn plugin_open_file_preview(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginFilePreviewArgs = parse(args)?;
        self.ensure_registered_repo_file(&args.file_path).await?;
        let extension = std::path::Path::new(&args.file_path)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        let control_plane = self.plugin_control_plane().await?;
        let Some(resolved) = control_plane
            .resolve_file_opener(extension.as_deref(), None)
            .await
            .map_err(internal_error)?
        else {
            return Ok(Value::Null);
        };
        let catalog = control_plane
            .contributions()
            .await
            .map_err(internal_error)?;
        let opener = catalog.items.iter().find(|item| {
            item.plugin_id == resolved.plugin_id
                && item.id == resolved.contribution_id
                && item.kind == plugins::ContributionKind::FileOpener
        });
        let preview = catalog
            .items
            .iter()
            .find(|item| {
                item.plugin_id == resolved.plugin_id
                    && item.id == resolved.handler
                    && item.kind == plugins::ContributionKind::PreviewProvider
            })
            .ok_or_else(|| ApplicationError::internal("resolved preview provider disappeared"))?;
        let media_type = opener
            .and_then(|item| item.metadata.get("mediaTypes"))
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream")
            .to_owned();
        let provider_id = preview.id.clone();
        let plugin = control_plane
            .plugin(&resolved.plugin_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::internal("resolved preview plugin disappeared"))?;
        let result = plugins::PluginArtifactPreviewService::new(
            self.plugin_control_plane.clone(),
            self.capability_broker.clone(),
        )
        .open(plugins::PluginPreviewRequest {
            file_path: args.file_path,
            media_type,
            plugin_id: resolved.plugin_id.clone(),
            plugin_version: plugin.version.clone(),
            provider_id: provider_id.clone(),
            generation: 0,
            package_digest: String::new(),
        })
        .await
        .map_err(|error| error.to_string());
        match result {
            Ok(lease) => {
                let lease_id = Uuid::parse_str(&lease.lease_id).map_err(internal_error)?;
                self.preview_proxy
                    .register(
                        lease_id,
                        lease.loopback_port,
                        &lease.capability_token,
                        lease.expires_at_unix_ms,
                    )
                    .await
                    .map_err(internal_error)?;
                Ok(json!({
                    "pluginId": resolved.plugin_id,
                    "providerId": provider_id,
                    "generation": resolved.generation,
                    "leaseId": lease_id,
                    "capabilityToken": lease.capability_token,
                    "expiresAtUnixMs": lease.expires_at_unix_ms,
                    "port": lease.loopback_port,
                    "errorCode": Value::Null,
                    "errorMessage": Value::Null,
                }))
            }
            Err(error) => Ok(json!({
                "pluginId": resolved.plugin_id,
                "providerId": provider_id,
                "generation": resolved.generation,
                "leaseId": Value::Null,
                "capabilityToken": Value::Null,
                "expiresAtUnixMs": Value::Null,
                "port": Value::Null,
                "errorCode": "PREVIEW_WORKER_FAILED",
                "errorMessage": error,
            })),
        }
    }

    async fn ensure_registered_repo_file(&self, file_path: &str) -> Result<(), ApplicationError> {
        let requested = tokio::fs::canonicalize(file_path)
            .await
            .map_err(|_| ApplicationError::not_found("preview file was not found"))?;
        if !requested.is_file() {
            return Err(ApplicationError::bad_request(
                "preview target must be a regular file",
            ));
        }
        let roots = sqlx::query_scalar::<_, String>("SELECT path FROM repos")
            .fetch_all(&self.pool)
            .await
            .map_err(internal_error)?;
        for root in roots {
            let Ok(root) = tokio::fs::canonicalize(root).await else {
                continue;
            };
            if requested != root && requested.starts_with(root) {
                return Ok(());
            }
        }
        Err(ApplicationError::forbidden(
            "preview file is outside every registered repository",
        ))
    }

    async fn plugin_close_file_preview(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginFilePreviewArgs = parse(args)?;
        if let Some(lease_id) = args.lease_id {
            self.preview_proxy.revoke(lease_id).await;
        }
        let lease_id = args.lease_id.map(|value| value.to_string());
        self.preview_host
            .close_preview(&args.file_path, lease_id.as_deref())
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn plugin_renew_file_preview(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginFilePreviewRenewArgs = parse(args)?;
        let lease = self
            .preview_host
            .renew_preview(&args.lease_id.to_string())
            .await
            .map_err(internal_error)?;
        self.preview_proxy
            .renew(args.lease_id, lease.expires_at_unix_ms)
            .await
            .map_err(internal_error)?;
        Ok(json!({
            "leaseId": lease.lease_id,
            "expiresAtUnixMs": lease.expires_at_unix_ms,
        }))
    }

    async fn project_list(&self) -> Result<Value, ApplicationError> {
        serialize(
            Project::find_all(&self.pool)
                .await
                .map_err(internal_error)?,
        )
    }

    async fn project_repositories(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: IdArgs = parse(args)?;
        serialize(
            ProjectRepo::find_repos_for_project(&self.pool, args.id)
                .await
                .map_err(internal_error)?,
        )
    }

    async fn repo_branches(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: RepoIdArgs = parse(args)?;
        let repo = self
            .deployment
            .repo()
            .get_by_id(&self.pool, args.repo_id)
            .await
            .map_err(internal_error)?;
        let git = self.deployment.git().clone();
        let repo_path = repo.path.clone();
        let branches = tokio::task::spawn_blocking(move || git.get_all_branches(&repo_path))
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .map_err(internal_error)?;
        serialize(branches)
    }

    async fn agent_management_bar(&self) -> Result<Value, ApplicationError> {
        serialize(
            services::services::agent_management::AgentManagementApplicationService::new(
                self.pool.clone(),
            )
            .list()
            .await
            .map_err(internal_error)?,
        )
    }

    pub(crate) async fn agent_capability_catalog(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let agent_id = AgentId::parse(args.agent_id).map_err(internal_error)?;
        serialize(
            conversations::read_matching_open_capability_catalog(&self.pool, &agent_id)
                .await
                .map_err(conversation_error)?,
        )
    }

    async fn agent_capability_catalog_fresh(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let agent_id = AgentId::parse(args.agent_id).map_err(internal_error)?;
        serialize(
            conversations::capability_catalog_is_fresh(&self.pool, &agent_id)
                .await
                .map_err(conversation_error)?,
        )
    }

    async fn agent_refresh_capability_catalog(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let agent_id = AgentId::parse(args.agent_id).map_err(internal_error)?;
        serialize(
            conversations::refresh_open_capability_catalog(
                &self.pool,
                &self.conversations.agent_runtime,
                &agent_id,
            )
            .await
            .map_err(conversation_error)?,
        )
    }

    async fn agent_skills(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentSkillsArgs = parse(args)?;
        crate::host::catalog::skills::list_agent_skills(self, args.agent_type, args.workspace_path)
            .await
    }

    async fn user_system_info(&self) -> Result<Value, ApplicationError> {
        crate::host::catalog::config::user_system_info(self).await
    }

    async fn artifact_list(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: ArtifactListArgs = parse(args)?;
        let ids = if let Some(conversation_id) = args.conversation_id {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM artifact_revisions WHERE conversation_id = ? \
                 GROUP BY id ORDER BY MAX(updated_at_unix_ms) DESC LIMIT ?",
            )
            .bind(conversation_id)
            .bind(args.limit.unwrap_or(100).clamp(1, 200))
            .fetch_all(&self.pool)
            .await
            .map_err(internal_error)?
        } else {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM artifact_revisions GROUP BY id \
                 ORDER BY MAX(updated_at_unix_ms) DESC LIMIT ?",
            )
            .bind(args.limit.unwrap_or(100).clamp(1, 200))
            .fetch_all(&self.pool)
            .await
            .map_err(internal_error)?
        };
        let repository = SqliteArtifactRepository::new(self.pool.clone());
        let mut artifacts = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(artifact) = repository.find(id).await.map_err(internal_error)? {
                artifacts.push(serde_json::to_value(artifact).map_err(internal_error)?);
            }
        }
        Ok(Value::Array(artifacts))
    }

    async fn open_preview(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: ArtifactIdArgs = parse(args)?;
        let artifact = SqliteArtifactRepository::new(self.pool.clone())
            .find(args.artifact_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("artifact {}", args.artifact_id)))?;
        let file_path = tokio::fs::canonicalize(artifact.scope_root.join(&artifact.relative_path))
            .await
            .map_err(internal_error)?;
        let provider_id = artifact.producer.provider_id.clone();
        let lease = plugins::PluginArtifactPreviewService::new(
            self.plugin_control_plane.clone(),
            self.capability_broker.clone(),
        )
        .open(plugins::PluginPreviewRequest {
            file_path: file_path.to_string_lossy().into_owned(),
            media_type: artifact.media_type,
            plugin_id: artifact.producer.plugin_id,
            plugin_version: artifact.producer.plugin_version,
            provider_id: provider_id.clone(),
            generation: 0,
            package_digest: String::new(),
        })
        .await
        .map_err(internal_error)?;
        let lease_id = Uuid::parse_str(&lease.lease_id).map_err(internal_error)?;
        self.preview_proxy
            .register(
                lease_id,
                lease.loopback_port,
                &lease.capability_token,
                lease.expires_at_unix_ms,
            )
            .await
            .map_err(internal_error)?;
        Ok(json!({
            "leaseId": lease_id,
            "artifactId": args.artifact_id,
            "providerId": provider_id,
            "loopbackPort": lease.loopback_port,
            "capabilityToken": lease.capability_token,
            "expiresAtUnixMs": lease.expires_at_unix_ms,
            "docxFallbackSupported": false,
        }))
    }

    async fn close_preview(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: LeaseIdArgs = parse(args)?;
        self.preview_proxy.revoke(args.lease_id).await;
        plugins::PluginArtifactPreviewService::new(
            self.plugin_control_plane.clone(),
            self.capability_broker.clone(),
        )
        .close("", Some(&args.lease_id.to_string()))
        .await
        .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn automation_list(&self) -> Result<Value, ApplicationError> {
        let records = self
            .automation_store()
            .list()
            .await
            .map_err(internal_error)?;
        serialize(records.into_iter().map(automation_view).collect::<Vec<_>>())
    }

    pub(crate) async fn automation_create(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AutomationInputArgs = parse(args)?;
        let draft = self.normalize_draft(args.input).await?;
        let record = self
            .automation_store()
            .create(draft, Utc::now())
            .await
            .map_err(internal_error)?;
        serialize(automation_view(record))
    }

    async fn automation_create_workflow(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: WorkflowAutomationInputArgs = parse(args)?;
        let mut draft = args.input;
        draft.launch.workspace.root_folder =
            ProjectRepo::find_repos_for_project(&self.pool, draft.launch.workspace.project_id)
                .await
                .map_err(internal_error)?
                .into_iter()
                .next()
                .map(|repo| repo.path.to_string_lossy().to_string())
                .ok_or_else(|| ApplicationError::bad_request("project has no repository"))?;
        draft.launch.workspace.branch = draft
            .launch
            .workspace
            .branch
            .map(|branch| branch.trim().to_string())
            .filter(|branch| !branch.is_empty());
        draft
            .launch
            .validate()
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let record = self
            .automation_store()
            .create_workflow(draft, Utc::now())
            .await
            .map_err(internal_error)?;
        serialize(automation_view(record))
    }

    pub(crate) async fn automation_update(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AutomationUpdateArgs = parse(args)?;
        let draft = self.normalize_draft(args.input).await?;
        let record = self
            .automation_store()
            .update(args.id, draft, Utc::now())
            .await
            .map_err(store_error)?;
        serialize(automation_view(record))
    }

    async fn automation_set_enabled(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AutomationEnabledArgs = parse(args)?;
        self.automation_store()
            .set_enabled(args.id, args.enabled, Utc::now())
            .await
            .map_err(store_error)?;
        Ok(Value::Null)
    }

    async fn automation_delete(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: IdArgs = parse(args)?;
        self.automation_store()
            .delete(args.id)
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn automation_run_now(&self, args: Value) -> Result<Value, ApplicationError> {
        if !self.owns_automation_engine {
            return Err(ApplicationError::conflict(
                "this host does not own the Automation Engine lease",
            ));
        }
        let args: IdArgs = parse(args)?;
        let run = self
            .automation_store()
            .run_now(args.id, Utc::now())
            .await
            .map_err(store_error)?;
        let view = automation_run_view(run.clone());
        if run.snapshot.status == RunStatus::Running {
            let runtime = self.automation.clone();
            tokio::spawn(async move {
                runtime
                    .execute_claimed(ClaimedRun {
                        run_id: run.snapshot.run_id,
                        automation_id: run.snapshot.automation_id,
                        scheduled_for: run.started_at,
                        next_run_at: None,
                    })
                    .await;
            });
        }
        serialize(view)
    }

    async fn automation_cancel_run(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: RunIdArgs = parse(args)?;
        let store = self.automation_store();
        if !store
            .request_cancel(args.run_id)
            .await
            .map_err(internal_error)?
        {
            return Err(ApplicationError::conflict("automation run is not running"));
        }
        if let Some(run) = store.run(args.run_id).await.map_err(internal_error)? {
            if let Some(conversation_id) = run.snapshot.conversation_id {
                ConversationSessionService::new(self.conversations.clone())
                    .cancel_turn(
                        conversation_id,
                        Some("automation run cancelled".to_string()),
                    )
                    .await
                    .map_err(internal_error)?;
            }
            if let Some(workflow_run_id) = run.workflow_run_id {
                application::WorkflowExecutionPort::cancel(
                    &application::WorkflowStoreExecutionPort::with_conversations(
                        self.pool.clone(),
                        self.conversations.clone(),
                    ),
                    Uuid::new_v4(),
                    application::CancelWorkflowRequest {
                        run_id: workflow_run_id,
                        reason: Some("automation run cancelled".to_string()),
                    },
                )
                .await?;
            }
        }
        self.automation
            .reconcile_running_turns()
            .await
            .map_err(ApplicationError::internal)?;
        Ok(Value::Null)
    }

    async fn automation_runs(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AutomationRunsArgs = parse(args)?;
        let runs = self
            .automation_store()
            .runs(args.automation_id, args.limit.unwrap_or(20))
            .await
            .map_err(internal_error)?;
        serialize(
            runs.into_iter()
                .map(automation_run_view)
                .collect::<Vec<_>>(),
        )
    }

    fn automation_preview(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PreviewRunsArgs = parse(args)?;
        let values = ScheduleService::new(SystemClock)
            .preview(
                &ScheduleSpec::Schedule {
                    cron: args.cron,
                    timezone: args.timezone,
                },
                args.count.unwrap_or(5),
            )
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        serialize(values)
    }

    fn automation_templates(&self) -> Result<Value, ApplicationError> {
        serialize(
            BuiltinTemplateCatalog::all()
                .into_iter()
                .map(|template| json!({ "id": template.id, "draft": template.draft }))
                .collect::<Vec<_>>(),
        )
    }

    async fn automation_unseen_failures(&self) -> Result<Value, ApplicationError> {
        Ok(json!(
            self.automation_store()
                .unseen_failure_count()
                .await
                .map_err(internal_error)?
        ))
    }

    async fn automation_mark_seen(&self) -> Result<Value, ApplicationError> {
        self.automation_store()
            .mark_all_seen()
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn automation_export_spec(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: IdArgs = parse(args)?;
        let record = self
            .automation_store()
            .find(args.id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found("Automation not found"))?;
        let target = match record.target {
            AutomationTarget::Turn(spec) => {
                PortableAutomationTarget::Turn(PortableTurnLaunchSpec {
                    prompt_blocks: spec.prompt_blocks,
                    display_text: spec.display_text,
                    agent: spec.agent,
                    mode_id: spec.mode_id,
                    config_values: spec.config_values,
                    plugin_actions: spec.plugin_actions,
                    skills: spec.skills,
                    workspace: self.portable_workspace(&spec.workspace).await?,
                    label_snapshot: spec.label_snapshot,
                })
            }
            AutomationTarget::Workflow(spec) => {
                let version = workflows::WorkflowStore::new(self.pool.clone())
                    .version(spec.definition_version_id)
                    .await
                    .map_err(|error| ApplicationError::internal(error.to_string()))?;
                let source_path = version.source_path.ok_or_else(|| {
                    ApplicationError::conflict(
                        "Workflow version has no portable source identity; publish it from Studio first",
                    )
                })?;
                PortableAutomationTarget::Workflow(PortableWorkflowLaunchSpec {
                    source_path,
                    version_digest: version.digest,
                    input: spec.input,
                    policy_override: spec.policy_override,
                    workspace: self.portable_workspace(&spec.workspace).await?,
                })
            }
        };
        let spec = AutomationSpec {
            format_version: PORTABLE_AUTOMATION_SPEC_VERSION,
            name: record.name,
            trigger: record.trigger,
            target,
        };
        spec.validate()
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        serialize(
            serde_json::to_string_pretty(&spec)
                .map_err(|error| ApplicationError::internal(error.to_string()))?,
        )
    }

    async fn automation_import_spec(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AutomationImportArgs = parse(args)?;
        let spec: AutomationSpec = serde_json::from_str(&args.json).map_err(|error| {
            ApplicationError::bad_request(format!("Invalid Automation JSON: {error}"))
        })?;
        spec.validate()
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let record = match spec.target {
            PortableAutomationTarget::Turn(launch) => {
                let workspace = self.resolve_portable_workspace(&launch.workspace).await?;
                let draft = AutomationDraft {
                    name: spec.name,
                    enabled: false,
                    trigger: spec.trigger,
                    launch: AutomationDraftInput(TurnLaunchSpecInput {
                        prompt_blocks: launch.prompt_blocks,
                        display_text: launch.display_text,
                        agent: launch.agent,
                        mode_id: launch.mode_id,
                        config_values: launch.config_values,
                        plugin_actions: launch.plugin_actions,
                        skills: launch.skills,
                        workspace,
                        label_snapshot: launch.label_snapshot,
                    }),
                };
                self.automation_store()
                    .create(draft, Utc::now())
                    .await
                    .map_err(internal_error)?
            }
            PortableAutomationTarget::Workflow(launch) => {
                let workspace = self.resolve_portable_workspace(&launch.workspace).await?;
                let version = workflows::WorkflowStore::new(self.pool.clone())
                    .version_by_source_digest(&launch.source_path, &launch.version_digest)
                    .await
                    .map_err(|error| ApplicationError::conflict(error.to_string()))?;
                self.automation_store()
                    .create_workflow(
                        WorkflowAutomationDraft {
                            name: spec.name,
                            enabled: false,
                            trigger: spec.trigger,
                            launch: WorkflowLaunchSpec {
                                spec_version: WORKFLOW_AUTOMATION_SPEC_VERSION,
                                definition_version_id: version.id,
                                input: launch.input,
                                policy_override: launch.policy_override,
                                workspace,
                            },
                        },
                        Utc::now(),
                    )
                    .await
                    .map_err(internal_error)?
            }
        };
        serialize(automation_view(record))
    }

    async fn portable_workspace(
        &self,
        workspace: &WorkspaceTarget,
    ) -> Result<PortableWorkspaceRef, ApplicationError> {
        let project = Project::find_by_id(&self.pool, workspace.project_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found("Automation project not found"))?;
        let root_folder_name = std::path::Path::new(&workspace.root_folder)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| ApplicationError::conflict("Automation workspace root is not portable"))?
            .to_string();
        Ok(PortableWorkspaceRef {
            project_name: project.name,
            root_folder_name,
            branch: workspace.branch.clone(),
            isolation: workspace.isolation.clone(),
        })
    }

    async fn resolve_portable_workspace(
        &self,
        reference: &PortableWorkspaceRef,
    ) -> Result<WorkspaceTarget, ApplicationError> {
        let projects = Project::find_all(&self.pool)
            .await
            .map_err(internal_error)?;
        let matches = projects
            .into_iter()
            .filter(|project| project.name == reference.project_name)
            .collect::<Vec<_>>();
        let [project] = matches.as_slice() else {
            return Err(ApplicationError::conflict(format!(
                "Project `{}` is missing or ambiguous",
                reference.project_name
            )));
        };
        let repos = ProjectRepo::find_repos_for_project(&self.pool, project.id)
            .await
            .map_err(internal_error)?;
        let roots = repos
            .into_iter()
            .filter(|repo| {
                repo.name == reference.root_folder_name
                    || std::path::Path::new(&repo.path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        == Some(reference.root_folder_name.as_str())
            })
            .collect::<Vec<_>>();
        let [repo] = roots.as_slice() else {
            return Err(ApplicationError::conflict(format!(
                "Workspace root `{}` is missing or ambiguous in project `{}`",
                reference.root_folder_name, reference.project_name
            )));
        };
        Ok(WorkspaceTarget {
            project_id: project.id,
            root_folder: repo.path.to_string_lossy().into_owned(),
            branch: reference.branch.clone(),
            isolation: reference.isolation.clone(),
        })
    }

    async fn delegation_cancel(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: DelegationCancelArgs = parse(args)?;
        ConversationSessionService::new(self.conversations.clone())
            .cancel_turn(
                args.child_conversation_id,
                Some("delegation cancelled remotely".to_string()),
            )
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn normalize_draft(
        &self,
        input: AutomationDraftRequest,
    ) -> Result<AutomationDraft, ApplicationError> {
        let mut launch = input.launch.0;
        launch.workspace.root_folder =
            ProjectRepo::find_repos_for_project(&self.pool, launch.workspace.project_id)
                .await
                .map_err(internal_error)?
                .into_iter()
                .next()
                .map(|repo| repo.path.to_string_lossy().to_string())
                .ok_or_else(|| ApplicationError::bad_request("project has no repository"))?;
        launch.workspace.branch = launch
            .workspace
            .branch
            .map(|branch| branch.trim().to_string())
            .filter(|branch| !branch.is_empty());
        let draft = AutomationDraft {
            name: input.name,
            enabled: input.enabled,
            trigger: input.trigger,
            launch: AutomationDraftInput(launch),
        };
        let action_catalog = self.unified_action_catalog().await?;
        TurnLaunchSpec::from_automation_draft(draft.launch.clone())
            .and_then(|spec| spec.validate_plugin_actions(&action_catalog))
            .map_err(|error| ApplicationError::bad_request(format!("{}: {error}", error.code())))?;
        Ok(draft)
    }

    async fn unified_action_catalog(&self) -> Result<UnifiedActionCatalog, ApplicationError> {
        let control_plane = self.plugin_control_plane().await?;
        let actions = control_plane
            .catalog()
            .await
            .map_err(internal_error)?
            .into_iter()
            .filter(|plugin| plugin.activation == plugins::PluginActivation::Enabled)
            .flat_map(|plugin| {
                let plugin_id = plugin.id().to_owned();
                plugin
                    .package
                    .invocations
                    .into_iter()
                    .filter(|invocation| invocation.kind == plugins::InvocationKind::Action)
                    .map(move |invocation| (plugin_id.clone(), invocation.id))
            })
            .collect();
        Ok(UnifiedActionCatalog { actions })
    }

    async fn plugin_control_plane(&self) -> Result<&plugins::PluginControlPlane, ApplicationError> {
        Ok(self.plugin_control_plane.as_ref())
    }
}

#[async_trait]
impl ApplicationDomainPort for ServerApplicationDomains {
    async fn execute(
        &self,
        _principal: &Principal,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        self.execute_command(command, args).await
    }
}

struct UnifiedActionCatalog {
    actions: HashSet<(String, String)>,
}

impl PluginActionCatalogPort for UnifiedActionCatalog {
    fn contains(&self, reference: &automation::PluginActionRef) -> bool {
        self.actions.contains(&(
            reference.plugin_id.as_str().to_owned(),
            reference.action.id.as_str().to_owned(),
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginEnabledArgs {
    plugin_id: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginIdentityArgs {
    plugin_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginConfigArgs {
    plugin_id: String,
    config: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginGrantPermissionsArgs {
    plugin_id: String,
    permission_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginRuntimeArgs {
    plugin_id: String,
    runtime_id: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveFileOpenerArgs {
    extension: Option<String>,
    media_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilePreviewArgs {
    file_path: String,
    #[serde(default)]
    lease_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilePreviewRenewArgs {
    lease_id: Uuid,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactListArgs {
    conversation_id: Option<Uuid>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactIdArgs {
    artifact_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseIdArgs {
    lease_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationDraftRequest {
    name: String,
    enabled: bool,
    trigger: ScheduleSpec,
    launch: AutomationDraftInput,
}

#[derive(Deserialize)]
struct AutomationInputArgs {
    input: AutomationDraftRequest,
}

#[derive(Deserialize)]
struct WorkflowAutomationInputArgs {
    input: WorkflowAutomationDraft,
}

#[derive(Deserialize)]
struct AutomationUpdateArgs {
    id: Uuid,
    input: AutomationDraftRequest,
}

#[derive(Deserialize)]
struct AutomationEnabledArgs {
    id: Uuid,
    enabled: bool,
}

#[derive(Deserialize)]
struct AutomationImportArgs {
    json: String,
}

#[derive(Deserialize)]
struct IdArgs {
    id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoIdArgs {
    repo_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdArgs {
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSkillsArgs {
    agent_type: String,
    workspace_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunIdArgs {
    run_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationRunsArgs {
    automation_id: Uuid,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct PreviewRunsArgs {
    cron: String,
    timezone: String,
    count: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DelegationCancelArgs {
    child_conversation_id: Uuid,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationView {
    id: Uuid,
    name: String,
    enabled: bool,
    spec_version: u16,
    trigger: ScheduleSpec,
    next_run_at: Option<DateTime<Utc>>,
    target: AutomationTarget,
    launch: Option<TurnLaunchSpec>,
    migration_required: bool,
    unseen_failure_count: i64,
    last_run_status: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationRunView {
    id: Uuid,
    automation_id: Uuid,
    trigger: String,
    scheduled_for: Option<DateTime<Utc>>,
    status: &'static str,
    cancellation_requested: bool,
    conversation_id: Option<Uuid>,
    turn_id: Option<Uuid>,
    workspace_id: Option<Uuid>,
    workflow_run_id: Option<Uuid>,
    stop_reason: Option<String>,
    summary: Option<String>,
    error: Option<String>,
    seen: bool,
    started_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
}

fn automation_view(record: AutomationRecord) -> AutomationView {
    let launch = match &record.target {
        AutomationTarget::Turn(spec) => Some(spec.clone()),
        AutomationTarget::Workflow(_) => None,
    };
    AutomationView {
        id: record.id,
        name: record.name,
        enabled: record.enabled,
        spec_version: record.spec_version,
        trigger: record.trigger,
        next_run_at: record.next_run_at,
        target: record.target,
        launch,
        migration_required: record.legacy_migration_status == "migration_required",
        unseen_failure_count: record.unseen_failure_count,
        last_run_status: record.last_run_status,
        created_at: record.created_at,
        updated_at: record.updated_at,
    }
}

fn plugin_control_item(plugin: &plugins::InstalledPlugin) -> Value {
    let formats = plugin
        .formats
        .iter()
        .map(|format| match format {
            plugins::PackageFormat::VibeX => "vibex",
            plugins::PackageFormat::Codex => "codex",
            plugins::PackageFormat::ClaudeCode => "claude_code",
        })
        .collect::<Vec<_>>();
    let source_kind = match plugin.source.kind {
        plugins::PluginSourceKind::Builtin => "builtin",
        plugins::PluginSourceKind::Snapshot => "snapshot",
        plugins::PluginSourceKind::Marketplace => "marketplace",
        plugins::PluginSourceKind::DeveloperLink => "developer_link",
        plugins::PluginSourceKind::CodexNative => "codex_native",
        plugins::PluginSourceKind::ClaudeCodeNative => "claude_code_native",
    };
    let invocations = plugin
        .invocations
        .iter()
        .map(|invocation| {
            json!({
                "id": invocation.id,
                "label": invocation.label,
                "prompt": invocation.prompt,
                "kind": match invocation.kind {
                    plugins::InvocationKind::Action => "action",
                    plugins::InvocationKind::Command => "command",
                }
            })
        })
        .collect::<Vec<_>>();
    let runtimes = plugin
        .runtimes
        .iter()
        .map(|runtime| {
            json!({
                "id": runtime.id,
                "command": runtime.command,
                "version": runtime.version,
                "target": runtime.target,
                "contentDigest": runtime.content_digest,
                "installer": match runtime.install {
                    plugins::RuntimeInstall::Existing => "existing",
                    plugins::RuntimeInstall::Binary { .. } => "binary",
                    plugins::RuntimeInstall::Archive { .. } => "archive",
                    plugins::RuntimeInstall::Npm { .. } => "npm",
                    plugins::RuntimeInstall::Pipx { .. } => "pipx",
                    plugins::RuntimeInstall::Cargo { .. } => "cargo",
                },
                "installCommand": Value::Null,
            })
        })
        .collect::<Vec<_>>();
    let mcp_servers = plugin
        .mcp
        .as_object()
        .map(|servers| servers.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let app_contributions = plugin
        .app
        .file_openers
        .iter()
        .map(|opener| {
            json!({
                "id": opener.id,
                "kind": "file_opener",
                "label": opener.label,
                "metadata": {
                    "extensions": opener.extensions,
                    "mediaTypes": opener.media_types,
                    "priority": opener.priority,
                    "handler": opener.handler,
                },
            })
        })
        .chain(plugin.app.preview_providers.iter().map(|provider| {
            json!({
                "id": provider.id,
                "kind": "preview_provider",
                "label": provider.id,
                "metadata": {
                    "mediaTypes": provider.media_types,
                    "runtime": provider.runtime,
                    "maxConcurrentPreviews": provider.max_concurrent_previews,
                    "handler": provider.handler,
                },
            })
        }))
        .chain(plugin.app.surfaces.iter().map(|surface| {
            json!({
                "id": surface.id,
                "kind": "app_surface",
                "label": surface.label,
                "metadata": {
                    "slot": surface.slot,
                    "appEntrypoint": surface.app_entrypoint,
                    "route": surface.route,
                    "handler": surface.handler,
                    "allowedMethods": surface.allowed_methods,
                    "minHeight": surface.min_height,
                },
            })
        }))
        .collect::<Vec<_>>();
    json!({
        "id": plugin.id(),
        "publisher": plugin.publisher,
        "packageDigest": plugin.package_digest,
        "updatePackageDigest": Value::Null,
        "name": plugin.name,
        "version": plugin.version,
        "description": plugin.description,
        "enabled": plugin.activation == plugins::PluginActivation::Enabled,
        "builtin": plugin.source.kind == plugins::PluginSourceKind::Builtin,
        "sourceKind": source_kind,
        // Package contents are exposed through the contribution API; the
        // server filesystem layout is not part of the Remote contract.
        "sourcePath": "",
        "formats": formats,
        "skills": plugin.skills,
        "runtimes": runtimes,
        "warnings": plugin.warnings,
        "permissions": plugin.permissions,
        "permissionDelta": [],
        "mcpCount": mcp_servers.len(),
        "mcpServers": mcp_servers,
        "invocationCount": invocations.len(),
        "invocations": invocations,
        "appContributions": app_contributions,
        "nativeManaged": false,
        "enableSupported": true,
        "updateSupported": plugins::source_allows_remote_update(
            plugin.source.kind,
            plugin.source.origin.as_deref(),
        ),
        "rollbackSupported": false,
        "uninstallSupported": plugin.source.kind != plugins::PluginSourceKind::Builtin,
        "sourceOrigin": plugin.source.origin,
        "sourceRef": plugin.source.git_ref,
        "sourceSha": plugin.source.git_sha,
        "sourceLocked": plugin.source.locked,
        "sourceShowTree": plugin.source.show_tree,
    })
}

async fn download_marketplace_archive(url: &str) -> Result<std::path::PathBuf, ApplicationError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    if !response.status().is_success() {
        return Err(ApplicationError::not_found(url.to_owned()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    let suffix = plugins::marketplace_archive_suffix(url);
    let path =
        std::env::temp_dir().join(format!("vibex-market-{}.{}", uuid::Uuid::new_v4(), suffix));
    std::fs::write(&path, bytes).map_err(|error| ApplicationError::internal(error.to_string()))?;
    Ok(path)
}

fn remove_managed_plugin_snapshot(
    runtime_root: &std::path::Path,
    source: &std::path::Path,
) -> Result<(), ApplicationError> {
    let root = runtime_root
        .join("plugins/snapshots")
        .canonicalize()
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    let source = source
        .canonicalize()
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    if source.parent() != Some(root.as_path()) {
        return Err(ApplicationError::bad_request(
            "plugin snapshot is outside the managed snapshot directory",
        ));
    }
    std::fs::remove_dir_all(&source)
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    Ok(())
}

fn automation_run_view(run: AutomationRunRecord) -> AutomationRunView {
    AutomationRunView {
        id: run.snapshot.run_id,
        automation_id: run.snapshot.automation_id,
        trigger: run.trigger,
        scheduled_for: run.scheduled_for,
        status: match run.snapshot.status {
            RunStatus::Running => "running",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Interrupted => "interrupted",
            RunStatus::Skipped => "skipped",
        },
        cancellation_requested: run.snapshot.cancellation_requested,
        conversation_id: run.snapshot.conversation_id,
        turn_id: run.snapshot.turn_id,
        workspace_id: run.snapshot.workspace_id,
        workflow_run_id: run.workflow_run_id,
        stop_reason: run.stop_reason,
        summary: run.summary,
        error: run.snapshot.error,
        seen: run.seen,
        started_at: run.started_at,
        finished_at: run.finished_at,
    }
}

pub(crate) fn parse<T: DeserializeOwned>(value: Value) -> Result<T, ApplicationError> {
    application::decode_command_args(value).map_err(ApplicationError::bad_request)
}

pub(crate) fn serialize(value: impl Serialize) -> Result<Value, ApplicationError> {
    serde_json::to_value(value).map_err(internal_error)
}

pub(crate) fn internal_error(error: impl std::fmt::Display) -> ApplicationError {
    ApplicationError::internal(error.to_string())
}

fn runtime_lock_matches(
    declared: &plugins::RuntimeContribution,
    locked: &plugins::RuntimeInstallation,
) -> bool {
    declared
        .version
        .as_deref()
        .is_none_or(|version| version == locked.version)
        && (declared.target.is_empty() || declared.target == locked.target)
        && (declared.content_digest.is_empty() || declared.content_digest == locked.content_digest)
        && locked.executable_path.is_absolute()
        && locked.executable_path.is_file()
}

fn plugin_error(error: plugins::PluginError) -> ApplicationError {
    match error.code() {
        "plugin_not_found" => ApplicationError::not_found(error.message()),
        "plugin_manifest_invalid" | "plugin_manifest_major_unsupported" => {
            ApplicationError::bad_request(error.message())
        }
        "plugin_runtime_not_ready"
        | "plugin_id_conflict"
        | "plugin_registry_failed"
        | "native_operation_unsupported" => ApplicationError::conflict(error.message()),
        "tool_platform_unsupported" => ApplicationError::capability_unavailable(error.message()),
        _ => ApplicationError::internal(error.message()),
    }
}

fn app_surface_error(error: plugins::AppSurfaceError) -> ApplicationError {
    match error.kind() {
        plugins::AppSurfaceErrorKind::NotFound => ApplicationError::not_found(error.to_string()),
        plugins::AppSurfaceErrorKind::BadRequest => {
            ApplicationError::bad_request(error.to_string())
        }
        plugins::AppSurfaceErrorKind::Conflict => ApplicationError::conflict(error.to_string()),
        plugins::AppSurfaceErrorKind::Internal => internal_error(error),
    }
}

fn store_error(error: sqlx::Error) -> ApplicationError {
    match error {
        sqlx::Error::RowNotFound => ApplicationError::not_found("record not found"),
        other => internal_error(other),
    }
}

fn conversation_error(error: conversations::ConversationServiceError) -> ApplicationError {
    match error {
        conversations::ConversationServiceError::NotFound(message) => {
            ApplicationError::not_found(message)
        }
        conversations::ConversationServiceError::BadRequest(message) => {
            ApplicationError::bad_request(message)
        }
        conversations::ConversationServiceError::Conflict(message) => {
            ApplicationError::conflict(message)
        }
        conversations::ConversationServiceError::AuthenticationRequired(message)
        | conversations::ConversationServiceError::SessionUnavailable { message, .. } => {
            ApplicationError::bad_request(message)
        }
        conversations::ConversationServiceError::Internal(message) => {
            ApplicationError::internal(message)
        }
    }
}
