#![allow(unused_imports)]
#[path = "domains/automation_and_projects.rs"]
mod automation_and_projects;
#[path = "domains/plugins_catalog.rs"]
mod plugins_catalog;
#[path = "domains/plugins_marketplace.rs"]
mod plugins_marketplace;

use std::{collections::HashSet, sync::Arc, time::Duration};

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
use plugins::CapabilityBroker;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(crate) use self::plugins_marketplace::plugin_control_item;
#[allow(unused_imports)]
use self::plugins_marketplace::*;
use crate::{
    PreviewProxyRegistry,
    automation_runtime::HeadlessAutomationRuntime,
    host::events::{HostEventBus, TerminalBridgeRegistry},
    host_runtime::AutomationOwnership,
};

#[derive(Clone)]
pub struct ServerApplicationDomains {
    pub(crate) pool: SqlitePool,
    pub(crate) plugin_updates: Arc<crate::host::plugin_updates::PluginUpdates>,
    pub(crate) plugin_control_plane: Arc<plugins::PluginControlPlane>,
    pub(crate) preview_host: Arc<dyn plugins::PluginPreviewHost>,
    pub(crate) capability_broker: Arc<plugins::HostCapabilityBroker>,
    pub(crate) host_call: Arc<plugins::PluginHostCall>,
    pub(crate) app_surfaces: Arc<plugins::PluginAppSurfaceHost>,
    pub(crate) preview_proxy: PreviewProxyRegistry,
    pub(crate) automation: HeadlessAutomationRuntime,
    pub(crate) automation_ownership: AutomationOwnership,
    pub(crate) pulse_engine: Arc<pulse::PulseEngine>,
    pub(crate) conversations: ConversationContext,
    pub(crate) deployment: Arc<LocalDeployment>,
    pub(crate) runtime_root: std::path::PathBuf,
    pub(crate) worker_runtime: Arc<plugins::PluginWorkerRuntimeProvider>,
    pub(crate) events: Arc<HostEventBus>,
    pub(crate) terminal_bridges: Arc<TerminalBridgeRegistry>,
    pub(crate) agent_management_runtime:
        Arc<services::services::agent_management_runtime::AgentManagementRuntimeState>,
    pub(crate) delegation_broker: Option<Arc<delegation::DelegationBroker>>,
    pub(crate) prompt_enhancement: Arc<Mutex<Option<PromptEnhancementRun>>>,
    pub(crate) rate_limit_recovery: Arc<agents::rate_limit_recovery::UsageLimitRecovery>,
    pub(crate) side_chats:
        Arc<Mutex<std::collections::HashMap<String, crate::host::side_chat::SideChatRun>>>,
}

pub(crate) struct PromptEnhancementRun {
    pub generation: u64,
    pub cancel: CancellationToken,
    pub connection_id: Option<agents::AgentConnectionId>,
    pub session_id: Option<agents::AgentSessionId>,
    pub prompt_id: Option<agents::AgentPromptId>,
}

impl ServerApplicationDomains {
    pub(super) fn automation_store(&self) -> SqliteAutomationStore {
        SqliteAutomationStore::new(self.pool.clone())
    }

    pub(crate) fn db_service(&self) -> &db::DBService {
        self.deployment.db()
    }

    pub(crate) fn writer_pool(&self) -> &SqlitePool {
        self.deployment.db().writer().as_pool()
    }

    pub(crate) fn reader_pool(&self) -> &SqlitePool {
        self.deployment.db().reader().as_pool()
    }

    pub(super) async fn execute_command(
        &self,
        principal: &Principal,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        Box::pin(self.execute_command_inner(principal, command, args)).await
    }

    async fn execute_command_inner(
        &self,
        principal: &Principal,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        // Serialize public lifecycle writes; internal helpers may call each other.
        let _plugin_mutation = if matches!(
            command,
            DomainCommand::PluginSaveConfig
                | DomainCommand::PluginControlSetEnabled
                | DomainCommand::PluginControlImport
                | DomainCommand::PluginMarketplaceInstall
                | DomainCommand::PluginInstall
                | DomainCommand::PluginUpdate
                | DomainCommand::PluginControlUpdate
                | DomainCommand::PluginUninstall
                | DomainCommand::PluginControlUninstall
                | DomainCommand::PluginControlRollback
                | DomainCommand::PluginControlConfigureAgents
                | DomainCommand::PluginControlConfigureMcp
                | DomainCommand::PluginControlInstallRuntime
        ) {
            Some(self.plugin_updates.mutation.lock().await)
        } else {
            None
        };
        match command {
            DomainCommand::PluginActionCatalog => self.plugin_catalog().await,
            DomainCommand::PluginControlCatalog => self.plugin_control_catalog().await,
            DomainCommand::OfficialProductMcpState => self.official_product_mcp_state().await,
            DomainCommand::CollaborationCall => self.collaboration_call(args).await,
            DomainCommand::PluginMcpStatus => self.plugin_mcp_status().await,
            DomainCommand::PluginMcpEnsureRunning => self.plugin_mcp_ensure_running().await,
            DomainCommand::PluginProductDetail => self.plugin_product_detail(args).await,
            DomainCommand::PluginSaveConfig => self.plugin_save_config(args).await,
            DomainCommand::PluginContributionCatalog => self.plugin_contribution_catalog().await,
            DomainCommand::ProviderCatalogList => self.provider_catalog_list(args).await,
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
            DomainCommand::PluginControlImportCli => self.plugin_control_import_cli(args).await,
            DomainCommand::PluginResolveProviderBind => {
                self.plugin_resolve_provider_bind(args).await
            }
            DomainCommand::PluginMarketplaceCatalog => self.plugin_marketplace_catalog(args).await,
            DomainCommand::PluginMarketplaceListing => self.plugin_marketplace_listing(args).await,
            DomainCommand::PluginMarketplaceInstall => self.plugin_marketplace_install(args).await,
            DomainCommand::PluginCheckUpdates => {
                self.check_plugin_updates(
                    args.get("cached").and_then(Value::as_bool).unwrap_or(false),
                )
                .await
            }
            DomainCommand::PluginControlLogs => self.plugin_control_logs(args).await,
            DomainCommand::PluginControlDiagnostics => self.plugin_control_diagnostics(args).await,
            DomainCommand::PluginControlUninstall => self.plugin_control_uninstall(args).await,
            DomainCommand::PluginControlGcRuntimes => self.plugin_control_gc_runtimes(args).await,
            DomainCommand::PluginSurfaceOpen => self.plugin_surface_open(args).await,
            DomainCommand::PluginSurfaceInvoke => self.plugin_surface_invoke(args).await,
            DomainCommand::PluginSurfaceRevoke => self.plugin_surface_revoke(args).await,
            DomainCommand::PluginHostCall => self.plugin_host_call(args).await,
            DomainCommand::PluginInvokeContribution => self.plugin_invoke_contribution(args).await,
            DomainCommand::PluginCommandInvoke => self.plugin_command_invoke(principal, args).await,
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
                Ok(json!({ "active": self.automation_ownership.current() }))
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
            DomainCommand::ConversationRowsSince => self.conversation_rows_since(args).await,
            DomainCommand::ConversationEnsureSessionControls => {
                self.conversation_ensure_session_controls(args).await
            }
            DomainCommand::ConversationTouch => self.conversation_touch(args).await,
            DomainCommand::ConversationTimelinePage => self.conversation_timeline_page(args).await,
            DomainCommand::ConversationTimelineImage => {
                self.conversation_timeline_image(args).await
            }
            DomainCommand::ConversationRebindSession => {
                self.conversation_rebind_session(args).await
            }
            DomainCommand::ConversationPreviewEngineHandoff => {
                self.conversation_preview_engine_handoff(args).await
            }
            DomainCommand::ConversationConfirmEngineHandoff => {
                self.conversation_confirm_engine_handoff(args).await
            }
            DomainCommand::ConversationGoalControl => self.conversation_goal_control(args).await,
            DomainCommand::ConversationStopAsyncTask => {
                self.conversation_stop_async_task(args).await
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
            DomainCommand::ConversationProjects => self.conversation_projects().await,
            DomainCommand::ConversationWorkspaceTree => {
                self.conversation_workspace_tree(args).await
            }
            DomainCommand::ConversationWorkspaceFile => {
                self.conversation_workspace_file(args).await
            }
            DomainCommand::ConversationWorkspaceDiff => {
                self.conversation_workspace_diff(args).await
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
            | DomainCommand::WorkspaceRunArchiveScript => {
                Box::pin(self.product_command(command, args)).await
            }
            DomainCommand::AgentScanLocalHistory => {
                Box::pin(self.surface_command(command, args)).await
            }
            DomainCommand::WorkspaceCreate
            | DomainCommand::WorkspaceUpdate
            | DomainCommand::WorkspaceDelete
            | DomainCommand::WorkspaceInitializationStatus
            | DomainCommand::WorkspaceRetryInitialization
            | DomainCommand::WorkspaceCancelInitialization
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
            | DomainCommand::WorkflowCanvasFocus
            | DomainCommand::AgentListLiveTerminals
            | DomainCommand::AgentPlanUsage
            | DomainCommand::FrontendPreferencesGet
            | DomainCommand::FrontendPreferencesUpdate
            | DomainCommand::ProjectWorktreeSettingsGet
            | DomainCommand::ProjectWorktreeSettingsUpdate
            | DomainCommand::ReadBinaryAsset => Box::pin(self.product_command(command, args)).await,
            DomainCommand::SubscribeDiffStream
            | DomainCommand::SubscribeConversationStream
            | DomainCommand::SubscribeExecutionProcessesStream
            | DomainCommand::SubscribeProjectWorkspacesStream
            | DomainCommand::SubscribeProjectsStream
            | DomainCommand::SubscribeFileTreeStream
            | DomainCommand::SubscribeScratchStream
            | DomainCommand::SubscribeLogStream
            | DomainCommand::SubscribeSlashCommandsStream => {
                Box::pin(self.subscribe_stream(command, args)).await
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
            | DomainCommand::AgentDiscoverLocalHistorySources
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
            | DomainCommand::PiProjectTrustState
            | DomainCommand::PiProjectTrustSet
            | DomainCommand::PiProjectTrustAcknowledge
            | DomainCommand::PiTrustEntries
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
                Box::pin(self.surface_command(command, args)).await
            }
            DomainCommand::DbHealthReport => crate::host::db_health::db_health_report(self).await,
            DomainCommand::DbOptimize => crate::host::db_health::db_optimize(self).await,
            DomainCommand::TriggerEventFolding => {
                crate::host::db_health::trigger_event_folding(self).await
            }
            DomainCommand::ProviderInstancesList => {
                crate::host::provider_instances::list(self, args).await
            }
            DomainCommand::ProviderInstanceCreate => {
                crate::host::provider_instances::create(self, args).await
            }
            DomainCommand::ProviderInstanceUpdate => {
                crate::host::provider_instances::update(self, args).await
            }
            DomainCommand::ProviderInstanceSetDefault => {
                crate::host::provider_instances::set_default(self, args).await
            }
            DomainCommand::ProviderInstanceDelete => {
                crate::host::provider_instances::delete(self, args).await
            }
            DomainCommand::ProviderInstanceTestConnection => {
                crate::host::provider_instances::test_connection(self, args).await
            }
            DomainCommand::ConversationCheckRollbackSafety => {
                crate::host::rewind_and_recovery::check_rollback_safety(self, args).await
            }
            DomainCommand::ConversationRateLimitUpdateAutoResume => {
                crate::host::rewind_and_recovery::update_rate_limit_auto_resume(self, args).await
            }
            DomainCommand::ConversationRateLimitCancelWait => {
                crate::host::rewind_and_recovery::cancel_rate_limit_wait(self, args).await
            }
            DomainCommand::ConversationSideChatSend => {
                Box::pin(crate::host::side_chat::send(self, args)).await
            }
            DomainCommand::ConversationSideChatAbort => {
                crate::host::side_chat::abort(self, args).await
            }
            other if crate::pulse_runtime::is_pulse_domain_command(other) => {
                Box::pin(self.execute_pulse_command(principal, other, args)).await
            }
            other if crate::host::catalog::handles(other) => {
                Box::pin(crate::host::catalog::dispatch(self, other, args)).await
            }
            other => Box::pin(self.host_ops(other, args)).await,
        }
    }

    pub(super) async fn plugin_control_plane(
        &self,
    ) -> Result<&plugins::PluginControlPlane, ApplicationError> {
        Ok(self.plugin_control_plane.as_ref())
    }
}

#[async_trait]
impl ApplicationDomainPort for ServerApplicationDomains {
    async fn execute(
        &self,
        principal: &Principal,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        if crate::pulse_runtime::is_pulse_domain_command(command) {
            return crate::host::events::bind_host_events(
                self.events.clone(),
                Box::pin(self.execute_pulse_command(principal, command, args)),
            )
            .await;
        }
        crate::host::events::bind_host_events(
            self.events.clone(),
            Box::pin(self.execute_command(principal, command, args)),
        )
        .await
    }

    async fn execute_dynamic(
        &self,
        principal: &Principal,
        command_name: &str,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        crate::host::events::bind_host_events(
            self.events.clone(),
            self.invoke_dynamic_plugin_command(principal, command_name, args),
        )
        .await
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
struct PluginInvokeContributionArgs {
    plugin_id: String,
    handler: String,
    #[serde(default)]
    input: Value,
    timeout_seconds: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginEnabledArgs {
    plugin_id: String,
    enabled: bool,
    #[serde(default)]
    quarantine_reason: Option<String>,
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
    #[serde(default, alias = "provider_instance_id")]
    provider_instance_id: Option<String>,
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

pub(crate) fn plugin_error(error: plugins::PluginError) -> ApplicationError {
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

fn plugin_worker_command_error(error: plugins::WorkerHostError) -> ApplicationError {
    match error.code() {
        "plugin_not_found" | "plugin_command_not_found" => {
            ApplicationError::not_found(error.to_string())
        }
        "invalid_plugin_command" => ApplicationError::bad_request(error.to_string()),
        "plugin_not_active" => ApplicationError::conflict(error.to_string()),
        _ => ApplicationError::internal(error.to_string()),
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

pub(crate) fn conversation_error(
    error: conversations::ConversationServiceError,
) -> ApplicationError {
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

pub(crate) fn resolve_bridged_domain_command(
    plugin_id: &str,
    command_name: &str,
) -> Option<DomainCommand> {
    if let Some(canonical) = plugins::resolve_system_bundle_domain_command(plugin_id, command_name)
        && let Ok(domain_cmd) = canonical.parse::<DomainCommand>()
    {
        return Some(domain_cmd);
    }
    if plugins::is_system_bundle_plugin_id(plugin_id) {
        let normalized = command_name.trim().replace(['-', '.'], "_");
        if let Ok(domain_cmd) = normalized.parse::<DomainCommand>() {
            return Some(domain_cmd);
        }
    }
    if plugin_id
        .trim()
        .strip_prefix("dimo.")
        .is_some_and(|slug| slug.ends_with("-enhancer"))
    {
        let normalized = command_name.trim().replace(['-', '.'], "_");
        match normalized.as_str() {
            "enhance" | "enhance_prompt" => return Some(DomainCommand::EnhancePrompt),
            "cancel" | "cancel_enhance" | "cancel_enhance_prompt" | "cancel_prompt_enhancement" => {
                return Some(DomainCommand::CancelEnhancePrompt);
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod plugin_invoke_contribution_args {
    use serde_json::json;

    use super::*;

    #[test]
    fn saved_host_reconnect_payload_is_a_worker_invoke() {
        let args = parse::<PluginInvokeContributionArgs>(json!({
            "pluginId": "dimo.remote-ssh",
            "handler": "provision.ensure",
            "input": { "profile": { "id": "ssh-lab" } },
            "timeoutSeconds": 300
        }))
        .expect("worker invoke args");
        assert_eq!(args.plugin_id, "dimo.remote-ssh");
        assert_eq!(args.handler, "provision.ensure");
        assert_eq!(args.timeout_seconds, Some(300));
        assert_eq!(args.input["profile"]["id"], "ssh-lab");
    }

    #[test]
    fn worker_invoke_args_are_not_an_app_surface_session() {
        let args = json!({
            "pluginId": "dimo.remote-ssh",
            "handler": "provision.ensure",
            "input": { "profile": { "id": "ssh-lab" } },
            "timeoutSeconds": 300
        });
        assert!(parse::<plugins::AppSurfaceInvocation>(args).is_err());
    }

    #[test]
    fn monorepo_official_plugin_matches_default_and_manifest_version_tags() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manifest_dir = temp.path().join(".dimo-plugin");
        std::fs::create_dir_all(&manifest_dir).expect("create manifest dir");
        std::fs::write(manifest_dir.join("plugin.json"), r#"{"version":"2.0.0"}"#)
            .expect("write plugin.json");

        assert!(tag_matches_monorepo_official_plugin(None, temp.path()));
        assert!(tag_matches_monorepo_official_plugin(Some(""), temp.path()));
        assert!(tag_matches_monorepo_official_plugin(
            Some("main"),
            temp.path()
        ));
        assert!(tag_matches_monorepo_official_plugin(
            Some("master"),
            temp.path()
        ));
        assert!(tag_matches_monorepo_official_plugin(
            Some("latest"),
            temp.path()
        ));
        assert!(tag_matches_monorepo_official_plugin(
            Some("2.0.0"),
            temp.path()
        ));
        assert!(tag_matches_monorepo_official_plugin(
            Some("v2.0.0"),
            temp.path()
        ));
        assert!(tag_matches_monorepo_official_plugin(
            Some("1.0.0"),
            temp.path()
        ));
        assert!(!tag_matches_monorepo_official_plugin(
            Some("3.0.0"),
            temp.path()
        ));
    }

    #[tokio::test]
    async fn system_bundle_and_core_domain_commands_resolve_and_route_dynamically() {
        let registry = Arc::new(plugins::InMemoryPluginRegistry::default());
        let control_plane = plugins::PluginControlPlane::new(registry);

        let cases = [
            (
                "dimo.core.workspace-git.project_list",
                DomainCommand::ProjectList,
            ),
            (
                "dimo.core.workspace-git.branches",
                DomainCommand::RepoBranches,
            ),
            ("dimo.core.automation.list", DomainCommand::AutomationList),
            (
                "dimo.core.automation.templates",
                DomainCommand::AutomationTemplates,
            ),
            (
                "dimo.core.session.detail",
                DomainCommand::ConversationDetail,
            ),
            (
                "dimo.core.session.rows_since",
                DomainCommand::ConversationRowsSince,
            ),
            ("dimo.core.skills.list", DomainCommand::AgentSkillsList),
            (
                "dimo.core.agent-runtime.management_bar",
                DomainCommand::AgentManagementBar,
            ),
            (
                "dimo.core.channels.get_webhooks",
                DomainCommand::GetChatEventWebhooks,
            ),
            ("dimo.prompt-enhancer.enhance", DomainCommand::EnhancePrompt),
            (
                "dimo.prompt-enhancer.cancel",
                DomainCommand::CancelEnhancePrompt,
            ),
        ];

        for (qualified, expected) in cases {
            let (plugin_id, command_name) = control_plane
                .resolve_dynamic_command_target(qualified)
                .await
                .expect("resolve dynamic command")
                .unwrap_or_else(|| panic!("expected target for {qualified}"));
            let resolved = resolve_bridged_domain_command(&plugin_id, &command_name)
                .unwrap_or_else(|| panic!("expected DomainCommand for {qualified}"));
            assert_eq!(resolved, expected, "mismatch for {qualified}");
        }
    }
}
