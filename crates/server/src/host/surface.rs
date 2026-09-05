use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::Arc,
};

use agents::{
    AgentConnectionId, AgentContentBlock, AgentId, AgentKind, AgentPermissionId,
    AgentPermissionResponse, AgentPromptId, AgentSessionControlsSnapshot, AgentSessionId,
    AgentTerminalId, CancelAgentPromptInput, ConnectAgentInput, EnsureAgentSessionInput,
    HistoryPathDestination, ImportedAgentMessageRole, LocalHistoryDestination,
    LocalHistoryImportJobSnapshot, OfficialRegistryHttpFetcher, REGISTRY_REFRESH_TIMEOUT,
    RegistryCache, RegistryCacheFreshness, RegistrySnapshotClient, RespondAgentPermissionInput,
    ResumeAgentSessionInput, SendAgentPromptInput, SystemClock,
    conversation::{ConversationEvent, ConversationInputBlock},
    load_configured_history_session, scan_configured_history,
    scan_configured_history_with_progress,
    terminal::agent_terminal_registry,
};
use api_types::{
    AgentOperationKind, AgentOperationReceipt, AgentOperationStatus, UserAgentDefinitionRequest,
};
use application::{ApplicationError, DomainCommand};
use chrono::Utc;
use conversations::ConversationEventAppender;
use db::models::{
    agent_management::{
        AgentMembershipRepository, InstallationOperationRepository, RegistrySnapshotRepository,
        SessionDefaultRecord, SessionDefaultRepository,
    },
    conversation::DbConversationSummary,
    conversation_event::AppendConversationEvent,
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    session::{CreateSession, Session, SessionStatus},
    task::Task,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use services::services::{
    agent_management::AgentManagementApplicationService,
    agent_registry::AgentRegistrySnapshotStore, chat_delivery::save_channel_token,
};
use uuid::Uuid;

use crate::{
    domains::{ServerApplicationDomains, internal_error, parse, serialize},
    install_agent_unattended, weixin_check_qrcode, weixin_get_qrcode,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdArgs {
    agent_id: AgentId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentConnectArgs {
    agent_id: AgentId,
    workspace_id: String,
    working_dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentNewSessionArgs {
    connection_id: String,
    acp_session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentPrepareSessionArgs {
    agent_id: AgentId,
    workspace_id: String,
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSendPromptArgs {
    connection_id: String,
    session_id: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentCancelPromptArgs {
    connection_id: String,
    session_id: String,
    prompt_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRespondPermissionArgs {
    connection_id: String,
    permission_id: String,
    response: AgentPermissionResponse,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentConnectionArgs {
    connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionArgs {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentResumeSessionArgs {
    agent_id: AgentId,
    workspace_id: String,
    session_id: String,
    external_session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentPreparedModeArgs {
    session_id: String,
    mode_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentPreparedConfigArgs {
    session_id: String,
    key: String,
    value: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentListSessionsArgs {
    agent_id: AgentId,
    workspace_id: String,
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentDeleteRemoteSessionArgs {
    agent_id: AgentId,
    workspace_id: String,
    acp_session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentResetCheckpointArgs {
    session_id: String,
    ordinal: i64,
    perform_git_reset: Option<bool>,
    force_when_dirty: Option<bool>,
}

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentEnabledArgs {
    agent_id: AgentId,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentReorderArgs {
    agent_ids: Vec<AgentId>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentInstallVersionArgs {
    agent_id: AgentId,
    #[allow(dead_code)]
    version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionDefaultsArgs {
    agent_id: AgentId,
    defaults: Option<HashMap<String, Value>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionDefaultsView {
    values: BTreeMap<String, Value>,
    stale_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowDebugWorkspaceArgs {
    project_id: Uuid,
    name: String,
    repos: Vec<WorkspaceRepoSpec>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRepoSpec {
    repo_id: Uuid,
    target_branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginPathArgs {
    path: String,
    developer_link: Option<bool>,
    #[allow(dead_code)]
    package_kind: Option<String>,
    plugin_id: Option<String>,
    permission_ids: Option<Vec<String>>,
    all_agents: Option<bool>,
    agents: Option<Vec<String>>,
    source: Option<Value>,
    conflict: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WeixinCheckArgs {
    channel_id: String,
    qrcode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatLanguageArgs {
    language: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatWebhooksArgs {
    webhooks: Value,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderStoreItem {
    id: String,
    name: String,
    agent_id: AgentId,
    api_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    enabled: bool,
}

fn parse_uuid(field: &str, value: &str) -> Result<Uuid, ApplicationError> {
    Uuid::parse_str(value)
        .map_err(|_| ApplicationError::bad_request(format!("{field} is not a valid UUID")))
}

fn parse_connection_id(value: &str) -> Result<AgentConnectionId, ApplicationError> {
    parse_uuid("connection_id", value).map(AgentConnectionId)
}

fn parse_session_id(value: &str) -> Result<AgentSessionId, ApplicationError> {
    parse_uuid("session_id", value).map(AgentSessionId)
}

fn parse_prompt_id(value: &str) -> Result<AgentPromptId, ApplicationError> {
    parse_uuid("prompt_id", value).map(AgentPromptId)
}

fn parse_permission_id(value: &str) -> Result<AgentPermissionId, ApplicationError> {
    parse_uuid("permission_id", value).map(AgentPermissionId)
}

fn text_blocks(text: String) -> Vec<AgentContentBlock> {
    vec![AgentContentBlock::Text { text }]
}

fn provider_store_path() -> PathBuf {
    utils::assets::host_data_dir().join("agent-model-providers.json")
}

impl ServerApplicationDomains {
    pub(crate) async fn surface_command(
        &self,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        match command {
            DomainCommand::AgentConnect => self.agent_connect(args).await,
            DomainCommand::AgentPrepareSession => self.agent_prepare_session(args).await,
            DomainCommand::AgentNewSession => self.agent_new_session(args).await,
            DomainCommand::AgentResumeSession => self.agent_resume_session(args).await,
            DomainCommand::AgentSendPrompt => self.agent_send_prompt(args).await,
            DomainCommand::AgentCancelPrompt => self.agent_cancel_prompt(args).await,
            DomainCommand::AgentDisconnect => self.agent_disconnect(args).await,
            DomainCommand::AgentRespondPermission => self.agent_respond_permission(args).await,
            DomainCommand::AgentRuntimeSnapshot => {
                serialize(self.conversations.agent_runtime.snapshot().await)
            }
            DomainCommand::AgentConnectionSnapshot => self.agent_connection_snapshot(args).await,
            DomainCommand::AgentLoadSession => self.agent_load_session(args).await,
            DomainCommand::AgentListSessionCommands => self.agent_list_session_commands(args).await,
            DomainCommand::AgentDiscardPreparedSession => {
                let args: AgentSessionArgs = parse(args)?;
                self.conversations
                    .agent_runtime
                    .discard_prepared_session(parse_session_id(&args.session_id)?)
                    .await
                    .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
                Ok(Value::Null)
            }
            DomainCommand::AgentSetPreparedSessionMode => {
                let args: AgentPreparedModeArgs = parse(args)?;
                serialize(
                    self.conversations
                        .agent_runtime
                        .set_session_mode(parse_session_id(&args.session_id)?, args.mode_id)
                        .await
                        .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
                )
            }
            DomainCommand::AgentSetPreparedSessionConfig => {
                let args: AgentPreparedConfigArgs = parse(args)?;
                serialize(
                    self.conversations
                        .agent_runtime
                        .set_session_config_option(
                            parse_session_id(&args.session_id)?,
                            args.key,
                            args.value,
                        )
                        .await
                        .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
                )
            }
            DomainCommand::AgentListRemoteSessions => self.agent_list_remote_sessions(args).await,
            DomainCommand::AgentDeleteRemoteSession => self.agent_delete_remote_session(args).await,
            DomainCommand::AgentImportRemoteSession => self.agent_import_remote_session(args).await,
            DomainCommand::AgentResetToCheckpoint => self.agent_reset_to_checkpoint(args).await,
            DomainCommand::AgentListLocalHistory => self.agent_list_local_history(args).await,
            DomainCommand::AgentScanLocalHistory => self.agent_scan_local_history(args).await,
            DomainCommand::AgentImportLocalHistory => self.agent_import_local_history(args).await,
            DomainCommand::AgentImportLocalHistoryBatch => {
                self.agent_import_local_history_batch(args).await
            }
            DomainCommand::AgentLocalHistoryImportSnapshot => serialize(
                local_history_job()
                    .lock()
                    .expect("history job")
                    .snapshot
                    .clone(),
            ),
            DomainCommand::AgentTerminalSnapshot => self.agent_terminal_snapshot(args).await,
            DomainCommand::AgentSessionDefaults => self.agent_session_defaults(args).await,
            DomainCommand::AgentSetSessionDefaults => self.agent_set_session_defaults(args).await,
            DomainCommand::AgentRegistryView => self.agent_registry_view().await,
            DomainCommand::AgentRegistryRefresh => self.agent_registry_refresh().await,
            DomainCommand::AgentRegistryAddAndInstall => {
                self.agent_registry_add_and_install(args).await
            }
            DomainCommand::AgentUserDefinitionAddAndInstall => {
                self.agent_user_definition_add(args).await
            }
            DomainCommand::AgentUserDefinitionDetail => {
                self.agent_user_definition_detail(args).await
            }
            DomainCommand::AgentUserDefinitionUpdate => {
                self.agent_user_definition_update(args).await
            }
            DomainCommand::AgentManagementReorder => self.agent_management_reorder(args).await,
            DomainCommand::AgentManagementInstallVersion
            | DomainCommand::AgentManagementRepair
            | DomainCommand::AgentManagementApplyUpdate => {
                self.agent_management_install(args).await
            }
            DomainCommand::AgentManagementUninstall | DomainCommand::AgentManagementRemove => {
                self.agent_management_remove(args).await
            }
            DomainCommand::AgentManagementRollback => self.agent_management_rollback(args).await,
            DomainCommand::AgentManagementCheckUpdate => {
                super::management::dispatch_check_update(&self.pool, args).await
            }
            DomainCommand::AgentManagementCancelOperation => {
                self.agent_management_cancel_operation(args).await
            }
            DomainCommand::AgentManagementPreflight => {
                super::management::dispatch_preflight(&self.pool, args).await
            }
            DomainCommand::AgentManagementActions => {
                super::management::dispatch_actions(&self.pool, args).await
            }
            DomainCommand::AgentManagementRunAction => {
                super::management::dispatch_run_action(&self.pool, args).await
            }
            DomainCommand::AgentManagementAccountFlow => {
                super::management::dispatch_account_flow(&self.pool, args).await
            }
            DomainCommand::AgentManagementDiscoveryProgress => {
                super::management::dispatch_discovery_progress(&self.pool).await
            }
            DomainCommand::AgentManagementDiagnostics => {
                super::management::dispatch_diagnostics(&self.pool, args).await
            }
            DomainCommand::AgentManagementEnvironmentDiagnostics => {
                super::management::dispatch_environment_diagnostics(&self.pool, args).await
            }
            DomainCommand::AgentManagementClearDiagnostics => {
                super::management::dispatch_clear_diagnostics(&self.pool, args).await
            }
            DomainCommand::AgentManagementMarkDiagnosticsRead => {
                super::management::dispatch_mark_diagnostics_read(&self.pool, args).await
            }
            DomainCommand::AgentManagementEnvironment => self.agent_environment(args).await,
            DomainCommand::AgentManagementEnvironmentWrite => {
                self.agent_environment_write(args).await
            }
            DomainCommand::AgentManagementConfigRead => {
                super::native_commands::dispatch_native_config_read(&self.pool, args).await
            }
            DomainCommand::AgentManagementConfigWrite => {
                super::native_commands::dispatch_native_config_write(&self.pool, args).await
            }
            DomainCommand::AgentManagementConfigFileWrite => {
                super::native_commands::dispatch_native_config_file_write(&self.pool, args).await
            }
            DomainCommand::AgentAuthMode => self.agent_auth_mode(args).await,
            DomainCommand::AgentAuthModeSet => self.agent_auth_mode_set(args).await,
            DomainCommand::AgentModelProviders => {
                super::native_commands::dispatch_model_providers(&self.pool, args).await
            }
            DomainCommand::AgentModelProviderSave => {
                super::native_commands::dispatch_model_provider_save(&self.pool, args).await
            }
            DomainCommand::AgentModelProviderDelete => {
                super::native_commands::dispatch_model_provider_delete(&self.pool, args).await
            }
            DomainCommand::AgentModelProviderBind => {
                super::native_commands::dispatch_model_provider_bind(&self.pool, args).await
            }
            DomainCommand::AgentModelProviderCatalog => {
                super::native_commands::dispatch_model_catalog(
                    &self.pool,
                    "agent_model_provider_catalog",
                    args,
                )
                .await
            }
            DomainCommand::AgentModelProviderProbe => {
                super::native_commands::dispatch_model_provider_probe(&self.pool, args).await
            }
            DomainCommand::CodexModelCatalog => {
                super::native_commands::dispatch_model_catalog(
                    &self.pool,
                    "codex_model_catalog",
                    args,
                )
                .await
            }
            DomainCommand::CursorModelCatalog => {
                super::native_commands::dispatch_model_catalog(
                    &self.pool,
                    "cursor_model_catalog",
                    args,
                )
                .await
            }
            DomainCommand::KimiModelCatalog => {
                super::native_commands::dispatch_model_catalog(
                    &self.pool,
                    "kimi_model_catalog",
                    args,
                )
                .await
            }
            DomainCommand::AgentModelProviderImportPreview => {
                super::native_commands::dispatch_model_provider_import_preview(&self.pool, args)
                    .await
            }
            DomainCommand::AgentModelProviderImport => {
                super::native_commands::dispatch_model_provider_import(&self.pool, args).await
            }
            DomainCommand::CodexModelCatalogConfig => {
                super::native_commands::dispatch_codex_catalog_config(&self.pool).await
            }
            DomainCommand::CodexModelCatalogApply => {
                super::native_commands::dispatch_codex_catalog_apply(&self.pool, args).await
            }
            DomainCommand::CodexRequestDeviceCode => {
                super::native_commands::dispatch_codex_request_device_code().await
            }
            DomainCommand::CodexPollDeviceCode => {
                super::native_commands::dispatch_codex_poll_device_code(&self.pool, args).await
            }
            DomainCommand::CreateWorkflowDebugWorkspace => {
                self.create_workflow_debug_workspace(args).await
            }
            DomainCommand::GetChatEventWebhooks => crate::chat_notify::chat_event_webhooks()
                .await
                .map_err(internal_error),
            DomainCommand::SetChatEventWebhooks => {
                let args: ChatWebhooksArgs = parse(args)?;
                crate::chat_notify::set_chat_event_webhooks(args.webhooks)
                    .await
                    .map_err(internal_error)
            }
            DomainCommand::GetChatMessageLanguage => serialize(
                crate::chat_notify::chat_message_language()
                    .await
                    .map_err(internal_error)?,
            ),
            DomainCommand::SetChatMessageLanguage => {
                let args: ChatLanguageArgs = parse(args)?;
                serialize(
                    crate::chat_notify::set_chat_message_language(args.language)
                        .await
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::WeixinGetQrcode => {
                serialize(weixin_get_qrcode().await.map_err(internal_error)?)
            }
            DomainCommand::WeixinCheckQrcode => self.weixin_check(args).await,
            DomainCommand::PluginWorkflowCatalog => self.plugin_workflow_catalog().await,
            DomainCommand::PluginMarketplaceIndex => self.plugin_marketplace_index().await,
            DomainCommand::PluginInstall => self.plugin_install(args).await,
            DomainCommand::PluginUninstall => self.plugin_control_uninstall(args).await,
            DomainCommand::PluginUpdate | DomainCommand::PluginControlUpdate => {
                self.plugin_control_import(args).await
            }
            DomainCommand::PluginControlPreviewImport => self.plugin_preview_import(args).await,
            DomainCommand::PluginControlRollback => self.plugin_rollback(args).await,
            DomainCommand::PluginControlContributions => self.plugin_contributions(args).await,
            DomainCommand::PluginControlConfigureAgents => self.plugin_configure_agents(args).await,
            DomainCommand::PluginControlConfigureMcp => self.plugin_configure_mcp(args).await,
            DomainCommand::PluginInvokeContribution => self.plugin_surface_invoke(args).await,
            DomainCommand::DshPlugins => {
                super::native_commands::dispatch_dsh_plugins(&self.pool).await
            }
            DomainCommand::GrokPlugins => {
                super::native_commands::dispatch_grok_plugins(&self.pool).await
            }
            DomainCommand::PiPlugins => {
                super::native_commands::dispatch_pi_plugins(&self.pool).await
            }
            DomainCommand::OpenCodePluginList => {
                super::native_commands::dispatch_opencode_plugin_list(&self.pool).await
            }
            DomainCommand::DshPluginAdd => {
                super::native_commands::dispatch_dsh_plugin_add(&self.pool, args).await
            }
            DomainCommand::DshPluginRemove => {
                super::native_commands::dispatch_dsh_plugin_remove(&self.pool, args).await
            }
            DomainCommand::GrokPluginAdd => {
                super::native_commands::dispatch_grok_plugin_add(&self.pool, args).await
            }
            DomainCommand::GrokPluginRemove => {
                super::native_commands::dispatch_grok_plugin_remove(&self.pool, args).await
            }
            DomainCommand::PiPluginAdd => {
                super::native_commands::dispatch_pi_plugin_add(&self.pool, args).await
            }
            DomainCommand::PiPluginRemove => {
                super::native_commands::dispatch_pi_plugin_remove(&self.pool, args).await
            }
            DomainCommand::OpenCodePluginAdd => {
                super::native_commands::dispatch_opencode_plugin_add(&self.pool, args).await
            }
            DomainCommand::OpenCodePluginInstall => {
                super::native_commands::dispatch_opencode_plugin_install(&self.pool, args).await
            }
            DomainCommand::OpenCodePluginUninstall => {
                super::native_commands::dispatch_opencode_plugin_uninstall(&self.pool, args).await
            }
            DomainCommand::DshProviders => {
                super::native_commands::dispatch_dsh_providers(&self.pool).await
            }
            DomainCommand::DshProviderSave => {
                super::native_commands::dispatch_dsh_provider_save(&self.pool, args).await
            }
            DomainCommand::DshProviderDelete => {
                super::native_commands::dispatch_dsh_provider_delete(&self.pool, args).await
            }
            DomainCommand::DshProviderDiscoverModels => {
                super::native_commands::dispatch_dsh_provider_discover(args).await
            }
            DomainCommand::OpenCodeProviderCatalog => {
                super::native_commands::dispatch_opencode_provider_catalog(args).await
            }
            DomainCommand::OpenCodeProviderConnections => {
                super::native_commands::dispatch_opencode_provider_connections(&self.pool).await
            }
            DomainCommand::OpenCodeProviderConnect => {
                self.dispatch_opencode_provider_mutation(
                    super::native_commands::dispatch_opencode_provider_connect(&self.pool, args)
                        .await?,
                )
                .await
            }
            DomainCommand::OpenCodeProviderDisconnect => {
                self.dispatch_opencode_provider_mutation(
                    super::native_commands::dispatch_opencode_provider_disconnect(&self.pool, args)
                        .await?,
                )
                .await
            }
            DomainCommand::OpenCodeProviderImport => {
                self.dispatch_opencode_provider_mutation(
                    super::native_commands::dispatch_opencode_provider_import(&self.pool, args)
                        .await?,
                )
                .await
            }
            DomainCommand::OpenCodeProviderSetEnabled => {
                self.dispatch_opencode_provider_mutation(
                    super::native_commands::dispatch_opencode_provider_set_enabled(
                        &self.pool, args,
                    )
                    .await?,
                )
                .await
            }
            DomainCommand::PiConfiguration => {
                super::native_commands::dispatch_pi_configuration(&self.pool).await
            }
            DomainCommand::PiCredentialsSave => {
                super::native_commands::dispatch_pi_credentials_save(&self.pool, args).await
            }
            DomainCommand::PiRuntimeSave => {
                super::native_commands::dispatch_pi_runtime_save(&self.pool, args).await
            }
            DomainCommand::PiCommandValidate => {
                super::native_commands::dispatch_pi_command_validate(args).await
            }
            other => Err(ApplicationError::not_found(format!(
                "command `{}` is not registered",
                other.as_str()
            ))),
        }
    }

    async fn agent_connect(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentConnectArgs = parse(args)?;
        let workspace_id = parse_uuid("workspace_id", &args.workspace_id)?;
        let workspace = self.require_workspace(workspace_id).await?;
        let _ = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        let working_dir = PathBuf::from(&args.working_dir);
        let additional_directories = self
            .workspace_additional_directories(&workspace, &working_dir)
            .await?;
        let launch = self
            .conversations
            .host
            .launch_settings(&self.pool, &args.agent_id)
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        serialize(
            self.conversations
                .agent_runtime
                .connect(ConnectAgentInput {
                    agent_id: args.agent_id,
                    launch_lock: launch.launch_lock,
                    workspace_id,
                    working_dir,
                    additional_directories,
                    auto_approve_mode: launch.auto_approve_mode,
                    env: launch.env,
                })
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
        )
    }

    async fn agent_prepare_session(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentPrepareSessionArgs = parse(args)?;
        let workspace_id = parse_uuid("workspace_id", &args.workspace_id)?;
        let session_id = parse_session_id(&args.session_id)?;
        let workspace = self.require_workspace(workspace_id).await?;
        let working_dir = self.workspace_working_dir(&workspace).await?;
        let additional_directories = self
            .workspace_additional_directories(&workspace, &working_dir)
            .await?;
        let launch = self
            .conversations
            .host
            .launch_settings(&self.pool, &args.agent_id)
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        serialize(
            self.conversations
                .agent_runtime
                .prepare_session(EnsureAgentSessionInput {
                    agent_id: args.agent_id,
                    launch_lock: launch.launch_lock,
                    workspace_id,
                    working_dir,
                    additional_directories,
                    session_id,
                    acp_session_id: format!("pending-{session_id}"),
                    auto_approve_mode: launch.auto_approve_mode,
                    env: launch.env,
                    preferences: Default::default(),
                })
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
        )
    }

    async fn agent_new_session(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentNewSessionArgs = parse(args)?;
        let connection_id = parse_connection_id(&args.connection_id)?;
        let acp_session_id = args
            .acp_session_id
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        serialize(
            self.conversations
                .agent_runtime
                .new_session(connection_id, acp_session_id)
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
        )
    }

    async fn agent_resume_session(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentResumeSessionArgs = parse(args)?;
        let workspace_id = parse_uuid("workspace_id", &args.workspace_id)?;
        let session_id = parse_session_id(&args.session_id)?;
        let workspace = self.require_workspace(workspace_id).await?;
        let working_dir = self.workspace_working_dir(&workspace).await?;
        let additional_directories = self
            .workspace_additional_directories(&workspace, &working_dir)
            .await?;
        let launch = self
            .conversations
            .host
            .launch_settings(&self.pool, &args.agent_id)
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        serialize(
            self.conversations
                .agent_runtime
                .resume_session(ResumeAgentSessionInput {
                    agent_id: args.agent_id,
                    launch_lock: launch.launch_lock,
                    workspace_id,
                    working_dir,
                    additional_directories,
                    session_id,
                    external_session_id: args.external_session_id,
                    auto_approve_mode: launch.auto_approve_mode,
                    env: launch.env,
                    preferences: Default::default(),
                })
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
        )
    }

    async fn agent_send_prompt(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentSendPromptArgs = parse(args)?;
        serialize(
            self.conversations
                .agent_runtime
                .send_prompt(SendAgentPromptInput {
                    connection_id: parse_connection_id(&args.connection_id)?,
                    session_id: parse_session_id(&args.session_id)?,
                    blocks: text_blocks(args.text),
                    mode_override: None,
                    config_overrides: Vec::new(),
                })
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
        )
    }

    async fn agent_cancel_prompt(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentCancelPromptArgs = parse(args)?;
        self.conversations
            .agent_runtime
            .cancel_prompt(CancelAgentPromptInput {
                connection_id: parse_connection_id(&args.connection_id)?,
                session_id: parse_session_id(&args.session_id)?,
                prompt_id: parse_prompt_id(&args.prompt_id)?,
            })
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        Ok(Value::Null)
    }

    async fn agent_disconnect(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentConnectionArgs = parse(args)?;
        self.conversations
            .agent_runtime
            .disconnect(parse_connection_id(&args.connection_id)?)
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        Ok(Value::Null)
    }

    async fn agent_respond_permission(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentRespondPermissionArgs = parse(args)?;
        self.conversations
            .agent_runtime
            .respond_permission(RespondAgentPermissionInput {
                connection_id: parse_connection_id(&args.connection_id)?,
                permission_id: parse_permission_id(&args.permission_id)?,
                response: args.response,
            })
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        Ok(Value::Null)
    }

    async fn agent_connection_snapshot(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentConnectionArgs = parse(args)?;
        let connection_id = parse_connection_id(&args.connection_id)?;
        let snapshot = self
            .conversations
            .agent_runtime
            .snapshot()
            .await
            .connections
            .into_iter()
            .find(|connection| connection.id == connection_id)
            .ok_or_else(|| ApplicationError::not_found("connection not found"))?;
        serialize(snapshot)
    }

    async fn agent_load_session(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentSessionArgs = parse(args)?;
        let session_id = parse_session_id(&args.session_id)?;
        let snapshot = self
            .conversations
            .agent_runtime
            .snapshot()
            .await
            .sessions
            .into_iter()
            .find(|session| session.id == session_id)
            .ok_or_else(|| ApplicationError::not_found("agent session not found"))?;
        serialize(snapshot)
    }

    async fn agent_list_session_commands(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentSessionArgs = parse(args)?;
        let session_id = parse_session_id(&args.session_id)?;
        let snapshot = self.conversations.agent_runtime.snapshot().await;
        let commands = snapshot
            .events
            .iter()
            .rev()
            .find_map(|envelope| {
                if envelope.session_id != Some(session_id) {
                    return None;
                }
                match &envelope.event {
                    agents::AgentEvent::AvailableCommands { commands } => Some(commands.clone()),
                    _ => None,
                }
            })
            .unwrap_or_default();
        serialize(commands)
    }

    async fn connect_for_workspace(
        &self,
        agent_id: &AgentId,
        workspace_id: &str,
    ) -> Result<(AgentConnectionId, PathBuf), ApplicationError> {
        let workspace_id = parse_uuid("workspace_id", workspace_id)?;
        let workspace = self.require_workspace(workspace_id).await?;
        let working_dir = self.workspace_working_dir(&workspace).await?;
        let additional_directories = self
            .workspace_additional_directories(&workspace, &working_dir)
            .await?;
        let launch = self
            .conversations
            .host
            .launch_settings(&self.pool, agent_id)
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let connection = self
            .conversations
            .agent_runtime
            .connect(ConnectAgentInput {
                agent_id: agent_id.clone(),
                launch_lock: launch.launch_lock,
                workspace_id,
                working_dir: working_dir.clone(),
                additional_directories,
                auto_approve_mode: launch.auto_approve_mode,
                env: launch.env,
            })
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        Ok((connection.id, working_dir))
    }

    async fn agent_list_remote_sessions(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentListSessionsArgs = parse(args)?;
        let (connection_id, cwd) = self
            .connect_for_workspace(&args.agent_id, &args.workspace_id)
            .await?;
        let result = self
            .conversations
            .agent_runtime
            .list_agent_sessions(connection_id, Some(cwd), args.cursor)
            .await;
        let cleanup = self
            .conversations
            .agent_runtime
            .discard_connection(connection_id)
            .await;
        match (result, cleanup) {
            (Ok(page), Ok(())) => serialize(page),
            (Err(error), _) | (_, Err(error)) => {
                Err(ApplicationError::bad_request(error.to_string()))
            }
        }
    }

    async fn agent_delete_remote_session(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentDeleteRemoteSessionArgs = parse(args)?;
        let (connection_id, _cwd) = self
            .connect_for_workspace(&args.agent_id, &args.workspace_id)
            .await?;
        let result = self
            .conversations
            .agent_runtime
            .delete_agent_session(connection_id, args.acp_session_id)
            .await;
        let cleanup = self
            .conversations
            .agent_runtime
            .discard_connection(connection_id)
            .await;
        result
            .and(cleanup)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        Ok(Value::Null)
    }

    async fn agent_import_remote_session(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ImportArgs {
            agent_id: AgentId,
            workspace_id: String,
            acp_session_id: String,
            title: Option<String>,
        }
        let args: ImportArgs = parse(args)?;
        let workspace_id = parse_uuid("workspace_id", &args.workspace_id)?;
        let workspace = self.require_workspace(workspace_id).await?;
        if let Some(existing) = DbConversationSummary::find_by_external_id(
            &self.pool,
            &args.acp_session_id,
            &args.agent_id,
        )
        .await
        .map_err(internal_error)?
        {
            return serialize(self.require_session(existing.id).await?);
        }
        let session = Session::create(
            &self.pool,
            &CreateSession {
                executor: Some(args.agent_id.to_string()),
                agent_id: Some(args.agent_id.clone()),
                task_id: Some(workspace.task_id),
                name: args.title,
                initial_prompt: None,
                status: Some(SessionStatus::Todo),
            },
            Uuid::new_v4(),
            workspace_id,
        )
        .await
        .map_err(internal_error)?;
        Session::update_agent_metadata(
            &self.pool,
            session.id,
            Some(&args.acp_session_id),
            Some(&args.agent_id),
        )
        .await
        .map_err(internal_error)?;
        serialize(self.require_session(session.id).await?)
    }

    async fn agent_reset_to_checkpoint(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentResetCheckpointArgs = parse(args)?;
        let session_id = parse_uuid("session_id", &args.session_id)?;
        self.deployment
            .container()
            .reset_agent_session_to_checkpoint(
                session_id,
                args.ordinal,
                args.perform_git_reset.unwrap_or(true),
                args.force_when_dirty.unwrap_or(false),
            )
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn agent_scan_local_history(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let kind = AgentKind::from_lenient(args.agent_id.as_str()).ok_or_else(|| {
            ApplicationError::bad_request(format!(
                "Agent `{}` does not expose local history",
                args.agent_id
            ))
        })?;
        let configured_env = sqlx::query_scalar::<_, Option<String>>(
            "SELECT env_json FROM agent_setting WHERE agent_type = ?",
        )
        .bind(args.agent_id.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_error)?
        .flatten()
        .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(&raw).ok())
        .unwrap_or_default();
        let bus = crate::host::events::global_host_events();
        let agent_id = args.agent_id.clone();
        let entries = tokio::task::spawn_blocking(move || {
            scan_configured_history_with_progress(kind, &configured_env, |progress| {
                bus.emit("local-history-scan-progress", progress);
            })
        })
        .await
        .map_err(internal_error)?
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let imported = sqlx::query_as::<_, (Option<String>, Option<String>)>(
            r#"SELECT agent_id, external_session_id
               FROM sessions
               WHERE deleted_at IS NULL
                 AND agent_id IS NOT NULL
                 AND external_session_id IS NOT NULL"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(internal_error)?;
        let imported_keys = imported
            .into_iter()
            .filter_map(|(agent, external)| Some((agent?, external?)))
            .collect::<std::collections::BTreeSet<_>>();
        serialize(agents::build_local_history_scan_page(
            entries,
            &imported_keys,
            &[] as &[HistoryPathDestination],
            Vec::<LocalHistoryDestination>::new(),
        ))
        .map(|page| {
            let _ = agent_id;
            page
        })
    }

    async fn agent_list_local_history(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let kind = AgentKind::from_lenient(args.agent_id.as_str()).ok_or_else(|| {
            ApplicationError::bad_request(format!(
                "Agent `{}` does not expose local history",
                args.agent_id
            ))
        })?;
        let entries = scan_configured_history(kind, &HashMap::new())
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        serialize(json!({
            "sessions": entries.into_iter().map(|entry| json!({
                "acpSessionId": entry.external_session_id,
                "cwd": entry.workspace_path.map(|path| path.display().to_string()).unwrap_or_default(),
                "title": entry.title,
                "updatedAt": entry.updated_at.map(|at| at.to_rfc3339()),
                "meta": { "source": "local_history", "messageCount": entry.message_count },
            })).collect::<Vec<_>>(),
            "nextCursor": Value::Null,
            "meta": { "source": "local_history" }
        }))
    }

    async fn agent_import_local_history(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ImportArgs {
            agent_id: AgentId,
            workspace_id: String,
            acp_session_id: String,
            title: Option<String>,
        }
        let args: ImportArgs = parse(args)?;
        let workspace_id = parse_uuid("workspace_id", &args.workspace_id)?;
        let workspace = self.require_workspace(workspace_id).await?;
        let kind = AgentKind::from_lenient(args.agent_id.as_str()).ok_or_else(|| {
            ApplicationError::bad_request(format!(
                "Agent `{}` does not expose local history",
                args.agent_id
            ))
        })?;
        let configured_env = sqlx::query_scalar::<_, Option<String>>(
            "SELECT env_json FROM agent_setting WHERE agent_type = ?",
        )
        .bind(args.agent_id.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_error)?
        .flatten()
        .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(&raw).ok())
        .unwrap_or_default();
        let external_session_id = args.acp_session_id.clone();
        let imported = tokio::task::spawn_blocking(move || {
            load_configured_history_session(kind, &configured_env, &external_session_id)
        })
        .await
        .map_err(internal_error)?
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let title = args
            .title
            .or_else(|| imported.title.clone())
            .or_else(|| Some(args.acp_session_id.clone()));
        let session = Session::create(
            &self.pool,
            &CreateSession {
                executor: Some(args.agent_id.to_string()),
                agent_id: Some(args.agent_id.clone()),
                task_id: Some(workspace.task_id),
                name: title,
                initial_prompt: imported.messages.iter().find_map(|message| {
                    matches!(message.role, ImportedAgentMessageRole::User)
                        .then(|| message.content.trim().to_string())
                        .filter(|value| !value.is_empty())
                }),
                status: Some(SessionStatus::Done),
            },
            Uuid::new_v4(),
            workspace.id,
        )
        .await
        .map_err(internal_error)?;
        DbConversationSummary::bind_external_id(
            &self.pool,
            session.id,
            &args.acp_session_id,
            &args.agent_id,
        )
        .await
        .map_err(internal_error)?;
        append_imported_history_events(&self.pool, session.id, &imported).await?;
        serialize(session)
    }

    async fn agent_import_local_history_batch(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct BatchArgs {
            selections: Vec<agents::LocalHistoryImportSelection>,
        }
        let args: BatchArgs = parse(args)?;
        if args.selections.is_empty() {
            return Err(ApplicationError::bad_request(
                "Select at least one local conversation to import",
            ));
        }
        let snapshot = {
            let mut job = local_history_job().lock().expect("history job");
            if job.running {
                return Err(ApplicationError::conflict(
                    "A local conversation import is already running",
                ));
            }
            job.running = true;
            job.snapshot = LocalHistoryImportJobSnapshot::begin_running();
            job.snapshot.clone()
        };
        let pool = self.pool.clone();
        let selections = args.selections;
        tokio::spawn(async move {
            let total = selections.len() as u32;
            let mut result = agents::LocalHistoryImportResult {
                imported: 0,
                skipped: 0,
                failed: 0,
                conversation_ids: Vec::new(),
                errors: Vec::new(),
            };
            for (index, selection) in selections.iter().enumerate() {
                let progress = agents::LocalHistoryImportProgress::for_selection(
                    index as u32 + 1,
                    total,
                    selection,
                    None,
                    agents::LocalHistoryImportPhase::Loading,
                    &result,
                );
                apply_history_progress(progress);
                match import_one_history_selection(&pool, selection).await {
                    Ok(conversation_id) => {
                        result.imported += 1;
                        result.conversation_ids.push(conversation_id);
                        apply_history_progress(agents::LocalHistoryImportProgress::for_selection(
                            index as u32 + 1,
                            total,
                            selection,
                            None,
                            agents::LocalHistoryImportPhase::Imported,
                            &result,
                        ));
                    }
                    Err(error) => {
                        result.failed += 1;
                        result.errors.push(error.to_string());
                        apply_history_progress(agents::LocalHistoryImportProgress::for_selection(
                            index as u32 + 1,
                            total,
                            selection,
                            None,
                            agents::LocalHistoryImportPhase::Failed,
                            &result,
                        ));
                    }
                }
            }
            let snapshot = {
                let mut job = local_history_job().lock().expect("history job");
                job.running = false;
                job.snapshot.finish(result);
                job.snapshot.clone()
            };
            crate::host::events::global_host_events()
                .emit("local-history-import-progress", snapshot);
        });
        serialize(snapshot)
    }

    async fn agent_terminal_snapshot(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct TerminalArgs {
            terminal_id: String,
        }
        let args: TerminalArgs = parse(args)?;
        let terminal_id = parse_uuid("terminal_id", &args.terminal_id).map(AgentTerminalId)?;
        let snapshot = agent_terminal_registry()
            .snapshot_output(terminal_id)
            .await
            .ok_or_else(|| ApplicationError::not_found("terminal not found"))?;
        serialize(snapshot)
    }

    async fn agent_session_defaults(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let rows = SessionDefaultRepository::new(self.pool.clone())
            .list_for_agent(&args.agent_id)
            .await
            .map_err(internal_error)?;
        let mut requested = BTreeMap::new();
        let mut stale_ids = Vec::new();
        for row in rows {
            match serde_json::from_str(&row.value_json) {
                Ok(value) => {
                    requested.insert(row.option_id, value);
                }
                Err(_) => stale_ids.push(row.option_id),
            }
        }
        let catalog = self
            .agent_capability_catalog(json!({ "agentId": args.agent_id }))
            .await?;
        let options = serde_json::from_value::<AgentSessionControlsSnapshot>(catalog)
            .ok()
            .map(|snapshot| snapshot.config_options);
        let validation = agents::resolve_session_defaults(requested, stale_ids, options.as_deref());
        serialize(AgentSessionDefaultsView {
            values: validation.valid,
            stale_ids: validation.stale_ids,
        })
    }

    async fn agent_set_session_defaults(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: SessionDefaultsArgs = parse_payload(args)?;
        let requested = args
            .defaults
            .unwrap_or_default()
            .into_iter()
            .collect::<BTreeMap<_, _>>();
        let valid = if requested.is_empty() {
            BTreeMap::new()
        } else {
            let catalog = self
                .agent_capability_catalog(json!({ "agentId": args.agent_id }))
                .await?;
            let snapshot = serde_json::from_value::<AgentSessionControlsSnapshot>(catalog)
                .map_err(|_| {
                    ApplicationError::conflict(
                        "Agent capability catalog is unavailable; refresh it before saving defaults",
                    )
                })?;
            let validation = agents::validate_session_defaults(requested, &snapshot.config_options);
            if !validation.stale_ids.is_empty() {
                return Err(ApplicationError::conflict(format!(
                    "Agent session defaults are no longer advertised: {}",
                    validation.stale_ids.join(", ")
                )));
            }
            validation.valid
        };
        let updated_at = chrono::Utc::now().to_rfc3339();
        let defaults = valid
            .into_iter()
            .map(|(option_id, value)| {
                Ok(SessionDefaultRecord {
                    option_id,
                    value_json: serde_json::to_string(&value)
                        .map_err(|error| ApplicationError::internal(error.to_string()))?,
                    updated_at: updated_at.clone(),
                })
            })
            .collect::<Result<Vec<_>, ApplicationError>>()?;
        SessionDefaultRepository::new(self.pool.clone())
            .replace_for_agent(&args.agent_id, &defaults)
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn workspace_additional_directories(
        &self,
        workspace: &db::models::workspace::Workspace,
        working_dir: &Path,
    ) -> Result<Vec<PathBuf>, ApplicationError> {
        let container = self
            .deployment
            .container()
            .ensure_container_exists(workspace)
            .await
            .map_err(internal_error)?;
        let repos = WorkspaceRepo::find_repos_for_workspace(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?;
        Ok(self.conversations.host.resolve_additional_directories(
            workspace,
            &container,
            &repos,
            &working_dir.to_string_lossy(),
        ))
    }

    async fn workspace_working_dir(
        &self,
        workspace: &db::models::workspace::Workspace,
    ) -> Result<PathBuf, ApplicationError> {
        let container = self
            .deployment
            .container()
            .ensure_container_exists(workspace)
            .await
            .map_err(internal_error)?;
        let repos = WorkspaceRepo::find_repos_for_workspace(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?;
        Ok(
            conversations::resolve_workspace_agent_working_dir(workspace, &container, &repos)
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(&container)),
        )
    }

    fn management(&self) -> AgentManagementApplicationService {
        AgentManagementApplicationService::new(self.pool.clone())
    }

    async fn agent_registry_view(&self) -> Result<Value, ApplicationError> {
        serialize(
            self.management()
                .registry_view(RegistryCacheFreshness::Fresh, None)
                .await
                .map_err(internal_error)?,
        )
    }

    async fn agent_registry_refresh(&self) -> Result<Value, ApplicationError> {
        let (freshness, refresh_error) = self.refresh_registry_snapshot(true).await?;
        serialize(
            self.management()
                .registry_view(freshness, refresh_error)
                .await
                .map_err(internal_error)?,
        )
    }

    async fn refresh_registry_snapshot(
        &self,
        force: bool,
    ) -> Result<(RegistryCacheFreshness, Option<String>), ApplicationError> {
        let store =
            AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(self.pool.clone()));
        let mut cache = store
            .load()
            .await
            .map_err(internal_error)?
            .map(RegistryCache::from_snapshot)
            .unwrap_or_default();
        let cached_freshness = cache
            .snapshot()
            .map(|snapshot| {
                if Utc::now().signed_duration_since(snapshot.fetched_at)
                    <= chrono::Duration::hours(24)
                {
                    RegistryCacheFreshness::Fresh
                } else {
                    RegistryCacheFreshness::Stale
                }
            })
            .unwrap_or(RegistryCacheFreshness::Empty);
        if !force && cached_freshness == RegistryCacheFreshness::Fresh {
            return Ok((cached_freshness, None));
        }
        let client = RegistrySnapshotClient::new(
            Arc::new(OfficialRegistryHttpFetcher::default()),
            Arc::new(SystemClock),
        );
        let (freshness, refresh_error, should_save) = match tokio::time::timeout(
            REGISTRY_REFRESH_TIMEOUT,
            client.refresh(&mut cache),
        )
        .await
        {
            Ok(view) => {
                let should_save = view.refresh_error.is_none();
                (view.freshness, view.refresh_error, should_save)
            }
            Err(_) => (
                cached_freshness,
                Some(format!(
                    "Registry refresh timed out after {} seconds",
                    REGISTRY_REFRESH_TIMEOUT.as_secs()
                )),
                false,
            ),
        };
        if should_save {
            if let Some(snapshot) = cache.snapshot() {
                store.save(snapshot).await.map_err(internal_error)?;
            }
        }
        Ok((freshness, refresh_error))
    }

    async fn agent_registry_add_and_install(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let view = self
            .management()
            .add(args.agent_id.clone())
            .await
            .map_err(internal_error)?;
        if let Err(error) =
            install_agent_unattended(&self.pool, &self.runtime_root, args.agent_id.as_str()).await
        {
            tracing::warn!(agent_id = %args.agent_id, %error, "agent install after add failed");
        }
        serialize(view)
    }

    async fn agent_user_definition_add(&self, args: Value) -> Result<Value, ApplicationError> {
        let request: UserAgentDefinitionRequest = parse_payload(args)?;
        let view = self
            .management()
            .add_user_definition(request)
            .await
            .map_err(internal_error)?;
        serialize(view)
    }

    async fn agent_user_definition_detail(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let view = self
            .management()
            .user_definition_view(&args.agent_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found("user agent definition not found"))?;
        serialize(view)
    }

    async fn agent_user_definition_update(&self, args: Value) -> Result<Value, ApplicationError> {
        let request: UserAgentDefinitionRequest = parse_payload(args)?;
        serialize(
            self.management()
                .update_user_definition(request)
                .await
                .map_err(internal_error)?,
        )
    }

    async fn agent_management_reorder(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentReorderArgs = parse(args)?;
        AgentMembershipRepository::new(self.pool.clone())
            .reorder(&args.agent_ids)
            .await
            .map_err(internal_error)?;
        serialize(self.management().list().await.map_err(internal_error)?)
    }

    async fn agent_management_install(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentInstallVersionArgs = parse(args)?;
        install_agent_unattended(&self.pool, &self.runtime_root, args.agent_id.as_str())
            .await
            .map_err(internal_error)?;
        self.agent_management_detail_value(json!({ "agentId": args.agent_id.to_string() }))
            .await
    }

    async fn agent_management_remove(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        sqlx::query("DELETE FROM agent_membership WHERE agent_id = ? AND built_in = 0")
            .bind(args.agent_id.as_str())
            .execute(&self.pool)
            .await
            .map_err(internal_error)?;
        serialize(self.management().list().await.map_err(internal_error)?)
    }

    async fn agent_management_rollback(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let installation = sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>)>(
            r#"SELECT active_operation, current_lock_id, rollback_lock_id
               FROM agent_installation
               WHERE agent_id = ?"#,
        )
        .bind(args.agent_id.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApplicationError::not_found(format!("agent {}", args.agent_id)))?;
        if installation.0.is_some() {
            return Err(ApplicationError::conflict("Agent 已有正在执行的管理操作"));
        }
        if installation.2.is_none() {
            return Err(ApplicationError::bad_request("Agent 没有可回滚的上一版本"));
        }
        let changed = sqlx::query(
            r#"UPDATE agent_installation
               SET current_lock_id = rollback_lock_id,
                   rollback_lock_id = current_lock_id,
                   lifecycle = 'ready',
                   updated_at = CURRENT_TIMESTAMP
               WHERE agent_id = ? AND rollback_lock_id IS NOT NULL"#,
        )
        .bind(args.agent_id.as_str())
        .execute(&self.pool)
        .await
        .map_err(internal_error)?
        .rows_affected();
        if changed == 0 {
            return Err(ApplicationError::conflict("回滚未能应用到安装记录"));
        }
        crate::host::events::global_host_events().emit(
            "agent-management-snapshot-invalidated",
            json!({ "agentId": args.agent_id }),
        );
        self.agent_management_detail_value(json!({ "agentId": args.agent_id.to_string() }))
            .await
    }

    async fn agent_management_cancel_operation(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CancelArgs {
            agent_id: AgentId,
            operation_id: String,
        }
        let args: CancelArgs = parse(args)?;
        let repository = InstallationOperationRepository::new(self.pool.clone());
        let operation = if let Ok(id) = Uuid::parse_str(&args.operation_id) {
            repository.find(id).await.map_err(internal_error)?
        } else {
            None
        };
        let operation = match operation {
            Some(operation) if operation.agent_id == args.agent_id => operation,
            _ => repository
                .active_for_agent(&args.agent_id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| {
                    ApplicationError::not_found(format!(
                        "Agent `{}` 没有可取消的管理操作",
                        args.agent_id
                    ))
                })?,
        };
        let kind = parse_operation_kind(&operation.kind)
            .ok_or_else(|| ApplicationError::conflict("持久化管理操作类型无效"))?;
        let status = if matches!(operation.status.as_str(), "queued" | "running") {
            repository
                .finish(operation.id, "cancelled")
                .await
                .map_err(internal_error)?;
            sqlx::query(
                r#"UPDATE agent_installation
                   SET lifecycle = 'idle',
                       active_operation = NULL,
                       active_operation_id = NULL,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE agent_id = ? AND active_operation_id = ?"#,
            )
            .bind(args.agent_id.as_str())
            .bind(operation.id.to_string())
            .execute(&self.pool)
            .await
            .map_err(internal_error)?;
            AgentOperationStatus::Canceled
        } else {
            match operation.status.as_str() {
                "succeeded" => AgentOperationStatus::Succeeded,
                "failed" => AgentOperationStatus::Failed,
                "cancelled" => AgentOperationStatus::Canceled,
                "interrupted" => AgentOperationStatus::Interrupted,
                _ => AgentOperationStatus::Failed,
            }
        };
        let receipt = AgentOperationReceipt {
            operation_id: operation.id.to_string(),
            agent_id: args.agent_id.clone(),
            kind,
            status,
        };
        crate::host::events::global_host_events().emit(
            "agent-management-event",
            json!({
                "agentId": args.agent_id,
                "operationId": receipt.operation_id,
                "kind": kind,
                "status": status,
            }),
        );
        crate::host::events::global_host_events().emit(
            "agent-management-snapshot-invalidated",
            json!({ "agentId": args.agent_id }),
        );
        serialize(receipt)
    }

    async fn agent_management_detail_value(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let view = self
            .management()
            .list()
            .await
            .map_err(internal_error)?
            .into_iter()
            .find(|view| view.agent_id == args.agent_id)
            .ok_or_else(|| ApplicationError::not_found("agent not found"))?;
        serialize(view)
    }

    async fn agent_environment(&self, args: Value) -> Result<Value, ApplicationError> {
        super::management::dispatch_environment(&self.pool, args).await
    }

    async fn agent_environment_write(&self, args: Value) -> Result<Value, ApplicationError> {
        let (agent_id, view) =
            super::management::dispatch_environment_write(&self.pool, args).await?;
        self.conversations
            .agent_runtime
            .mark_agent_sessions_config_stale(&agent_id, "Agent 环境变量已更改")
            .await;
        Ok(view)
    }

    async fn agent_auth_mode(&self, args: Value) -> Result<Value, ApplicationError> {
        super::management::dispatch_auth_mode(&self.pool, args).await
    }

    async fn agent_auth_mode_set(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AuthModeSetArgs {
            agent_id: AgentId,
        }
        let preview: AuthModeSetArgs = parse(args.clone())?;
        let view = super::management::dispatch_auth_mode_set(&self.pool, args).await?;
        self.conversations
            .agent_runtime
            .mark_agent_sessions_config_stale(&preview.agent_id, "Agent 鉴权模式已更改")
            .await;
        Ok(view)
    }

    async fn dispatch_opencode_provider_mutation(
        &self,
        view: Value,
    ) -> Result<Value, ApplicationError> {
        let agent_id = AgentId::parse("opencode").map_err(internal_error)?;
        self.conversations
            .agent_runtime
            .mark_agent_sessions_config_stale(&agent_id, "OpenCode Provider 已更改")
            .await;
        Ok(view)
    }

    async fn load_provider_store(&self) -> Result<Vec<ProviderStoreItem>, ApplicationError> {
        let path = provider_store_path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let body = tokio::fs::read_to_string(path)
            .await
            .map_err(internal_error)?;
        let parsed: Value = serde_json::from_str(&body).unwrap_or(json!({}));
        let items = parsed.get("providers").cloned().unwrap_or(json!([]));
        serde_json::from_value(items).map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn save_provider_store(
        &self,
        providers: &[ProviderStoreItem],
    ) -> Result<(), ApplicationError> {
        let path = provider_store_path();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(internal_error)?;
        }
        let body = serde_json::to_string_pretty(&json!({ "providers": providers }))
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        tokio::fs::write(path, body).await.map_err(internal_error)
    }

    async fn agent_model_providers(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args).unwrap_or(AgentIdArgs {
            agent_id: AgentId::parse("codex").unwrap_or_else(|_| args_agent_fallback()),
        });
        let providers = self
            .load_provider_store()
            .await?
            .into_iter()
            .filter(|item| item.agent_id == args.agent_id)
            .collect::<Vec<_>>();
        serialize(json!({ "providers": providers }))
    }

    async fn agent_model_provider_save(&self, args: Value) -> Result<Value, ApplicationError> {
        let item: ProviderStoreItem = parse_payload(args)?;
        let mut providers = self.load_provider_store().await?;
        if let Some(existing) = providers.iter_mut().find(|row| row.id == item.id) {
            *existing = item.clone();
        } else {
            providers.push(item.clone());
        }
        self.save_provider_store(&providers).await?;
        self.agent_model_providers(json!({ "agentId": item.agent_id.to_string() }))
            .await
    }

    async fn agent_model_provider_delete(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct DeleteArgs {
            agent_id: AgentId,
            provider_id: String,
        }
        let args: DeleteArgs = parse(args)?;
        let providers = self
            .load_provider_store()
            .await?
            .into_iter()
            .filter(|item| !(item.agent_id == args.agent_id && item.id == args.provider_id))
            .collect::<Vec<_>>();
        self.save_provider_store(&providers).await?;
        self.agent_model_providers(json!({ "agentId": args.agent_id.to_string() }))
            .await
    }

    async fn agent_model_provider_bind(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct BindArgs {
            agent_id: AgentId,
            provider_id: String,
        }
        let args: BindArgs = parse(args)?;
        let mut providers = self.load_provider_store().await?;
        for item in &mut providers {
            if item.agent_id == args.agent_id {
                item.enabled = item.id == args.provider_id;
            }
        }
        self.save_provider_store(&providers).await?;
        self.agent_model_providers(json!({ "agentId": args.agent_id.to_string() }))
            .await
    }

    async fn create_workflow_debug_workspace(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: WorkflowDebugWorkspaceArgs = parse(args)?;
        if args.repos.is_empty() {
            return Err(ApplicationError::bad_request(
                "At least one repository is required",
            ));
        }
        let task = Task::create(
            &self.pool,
            &db::models::task::CreateTask::from_title_description(
                args.project_id,
                args.name.clone(),
                None,
            ),
            Uuid::new_v4(),
        )
        .await
        .map_err(internal_error)?;
        self.create_workspace(json!({
            "taskId": task.id,
            "repos": args.repos,
        }))
        .await
    }

    async fn weixin_check(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: WeixinCheckArgs = parse(args)?;
        let status = weixin_check_qrcode(&args.qrcode)
            .await
            .map_err(internal_error)?;
        if status.status == "confirmed" {
            if let Some(token) = status.bot_token.as_deref() {
                save_channel_token(&args.channel_id, token)
                    .await
                    .map_err(internal_error)?;
            }
        }
        serialize(json!({ "status": status.status }))
    }

    async fn plugin_workflow_catalog(&self) -> Result<Value, ApplicationError> {
        let catalog = self.plugin_catalog().await?;
        let actions = catalog.get("actions").cloned().unwrap_or(json!([]));
        Ok(json!({ "workflows": actions }))
    }

    async fn plugin_marketplace_index(&self) -> Result<Value, ApplicationError> {
        let page = self.plugin_marketplace_catalog(json!({})).await?;
        let listings = page
            .get("official")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .chain(
                page.get("community")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten(),
            )
            .cloned()
            .collect::<Vec<_>>();
        Ok(json!({ "listings": listings }))
    }

    async fn plugin_install(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginPathArgs = parse(args)?;
        if let Some(path) = args
            .source
            .as_ref()
            .and_then(|source| source.get("artifactId").and_then(Value::as_str))
            .map(str::to_string)
            .or(Some(args.path).filter(|path| !path.is_empty()))
        {
            return self
                .plugin_control_import(json!({
                    "path": path,
                    "conflict": args.conflict.unwrap_or_else(|| "reject".to_string()),
                }))
                .await;
        }
        Err(ApplicationError::bad_request(
            "plugin install source is invalid",
        ))
    }

    async fn plugin_preview_import(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginPathArgs = parse(args)?;
        let source = PathBuf::from(&args.path);
        if !source.exists() {
            return Err(ApplicationError::not_found(format!(
                "plugin path {}",
                args.path
            )));
        }
        let source_kind = if args.developer_link.unwrap_or(false) {
            plugins::PluginSourceKind::DeveloperLink
        } else {
            plugins::PluginSourceKind::Snapshot
        };
        let package = plugins::PluginPackage::inspect(&source, source_kind)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let conflict = self
            .plugin_control_plane
            .preview_import(&package)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        serialize(json!({
            "plugin": {
                "id": package.id.as_str(),
                "sourcePath": args.path,
            },
            "conflict": conflict.map(|item| json!({
                "pluginId": item.plugin_id,
                "installedSource": item.installed_source,
                "incomingSource": item.incoming_source,
            })),
        }))
    }

    async fn plugin_rollback(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginPathArgs = parse(args)?;
        let plugin_id = args
            .plugin_id
            .ok_or_else(|| ApplicationError::bad_request("pluginId required"))?;
        let node = self
            .worker_runtime
            .resolve()
            .await
            .map_err(internal_error)?;
        let plugin = self
            .plugin_control_plane
            .rollback_and_activate(
                &node,
                &plugin_id,
                args.permission_ids.as_deref().unwrap_or(&[]),
                self.capability_broker.clone(),
            )
            .await
            .map_err(|error| ApplicationError::internal(format!("{}: {error}", error.code())))?;
        serialize(json!({ "id": plugin.id().to_string() }))
    }

    async fn plugin_contributions(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginPathArgs = parse(args)?;
        let plugin_id = args
            .plugin_id
            .ok_or_else(|| ApplicationError::bad_request("pluginId required"))?;
        let plugin = self
            .plugin_control_plane
            .plugin(&plugin_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| ApplicationError::not_found(plugin_id))?;
        serialize(json!({
            "skills": plugin.skills,
            "mcp": plugin.mcp,
        }))
    }

    async fn plugin_configure_agents(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginPathArgs = parse(args)?;
        let plugin_id = args
            .plugin_id
            .ok_or_else(|| ApplicationError::bad_request("pluginId required"))?;
        let plugin = self
            .plugin_control_plane
            .plugin(&plugin_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| ApplicationError::not_found(plugin_id.clone()))?;
        let known = agents::skills::skill_capable_agent_ids();
        let desired = if args.all_agents.unwrap_or(false) {
            known.clone()
        } else {
            args.agents.unwrap_or_default()
        };
        let memberships = self.management().list().await.map_err(internal_error)?;
        let installed = memberships
            .into_iter()
            .map(|view| view.agent_id.to_string())
            .collect::<Vec<_>>();
        let targets = desired
            .into_iter()
            .filter(|agent| installed.iter().any(|item| item == agent))
            .collect::<Vec<_>>();
        let skill_sources = plugin
            .skills
            .iter()
            .map(|skill| (skill.id.clone(), plugin.source.path.join(&skill.path)))
            .collect::<Vec<_>>();
        let projected =
            agents::skills::project_plugin_skills(&plugin_id, &skill_sources, targets, true)
                .map_err(|error| ApplicationError::internal(error.to_string()))?;
        serialize(json!({ "projections": projected }))
    }

    async fn plugin_configure_mcp(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginPathArgs = parse(args)?;
        let plugin_id = args
            .plugin_id
            .ok_or_else(|| ApplicationError::bad_request("pluginId required"))?;
        let plugin = self
            .plugin_control_plane
            .plugin(&plugin_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| ApplicationError::not_found(plugin_id))?;
        serialize(json!({ "mcp": plugin.mcp }))
    }
}

async fn append_imported_history_events(
    pool: &sqlx::SqlitePool,
    conversation_id: Uuid,
    session: &agents::ImportedAgentSession,
) -> Result<(), ApplicationError> {
    let mut current_turn_id = None;
    for (index, message) in session.messages.iter().enumerate() {
        match message.role {
            ImportedAgentMessageRole::User => {
                let blocks = vec![ConversationInputBlock::Text {
                    text: message.content.clone(),
                }];
                let turn = ConversationTurnRecord::create_pending(
                    pool,
                    Uuid::new_v4(),
                    CreateConversationTurn {
                        conversation_id,
                        prompt_id: None,
                        text_preview: Some(message.content.as_str()),
                        input_blocks_json: &serde_json::to_string(&blocks)
                            .map_err(internal_error)?,
                    },
                )
                .await
                .map_err(internal_error)?;
                append_history_event(
                    pool,
                    conversation_id,
                    Some(turn.id),
                    ConversationEvent::UserTurnCreated {
                        blocks,
                        workflow_refs: Vec::new(),
                    },
                    &format!("import-user-{index}"),
                )
                .await?;
                current_turn_id = Some(turn.id);
            }
            ImportedAgentMessageRole::Assistant => {
                let turn_id = match current_turn_id {
                    Some(turn_id) => turn_id,
                    None => continue,
                };
                append_history_event(
                    pool,
                    conversation_id,
                    Some(turn_id),
                    ConversationEvent::AssistantTextDelta {
                        text: message.content.clone(),
                        message_id: Some(format!("imported-message-{index}")),
                    },
                    &format!("import-assistant-{index}"),
                )
                .await?;
            }
            _ => {}
        }
    }
    Ok(())
}

async fn append_history_event(
    pool: &sqlx::SqlitePool,
    conversation_id: Uuid,
    turn_id: Option<Uuid>,
    event: ConversationEvent,
    idempotency_key: &str,
) -> Result<(), ApplicationError> {
    let event_kind = serde_json::to_value(&event)
        .map_err(internal_error)?
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let normalized_json = serde_json::to_string(&event).map_err(internal_error)?;
    ConversationEventAppender::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id,
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "import",
            event_kind: &event_kind,
            normalized_json: &normalized_json,
            raw_json: None,
            idempotency_key: Some(idempotency_key),
        },
    )
    .await
    .map_err(internal_error)?;
    Ok(())
}

struct LocalHistoryImportRuntime {
    running: bool,
    snapshot: LocalHistoryImportJobSnapshot,
}

fn local_history_job() -> &'static std::sync::Mutex<LocalHistoryImportRuntime> {
    static JOB: std::sync::OnceLock<std::sync::Mutex<LocalHistoryImportRuntime>> =
        std::sync::OnceLock::new();
    JOB.get_or_init(|| {
        std::sync::Mutex::new(LocalHistoryImportRuntime {
            running: false,
            snapshot: LocalHistoryImportJobSnapshot::default(),
        })
    })
}

fn apply_history_progress(progress: agents::LocalHistoryImportProgress) {
    let snapshot = {
        let mut job = local_history_job().lock().expect("history job");
        job.snapshot.apply_progress(progress);
        job.snapshot.clone()
    };
    crate::host::events::global_host_events().emit("local-history-import-progress", snapshot);
}

async fn import_one_history_selection(
    pool: &sqlx::SqlitePool,
    selection: &agents::LocalHistoryImportSelection,
) -> Result<Uuid, ApplicationError> {
    if let Some(existing) = DbConversationSummary::find_by_external_id(
        pool,
        &selection.external_session_id,
        &selection.agent_id,
    )
    .await
    .map_err(internal_error)?
    {
        return Ok(existing.id);
    }
    let kind = AgentKind::from_lenient(selection.agent_id.as_str()).ok_or_else(|| {
        ApplicationError::bad_request(format!(
            "Agent `{}` does not expose local history",
            selection.agent_id
        ))
    })?;
    let configured_env = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(selection.agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?
    .flatten()
    .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(&raw).ok())
    .unwrap_or_default();
    let external_session_id = selection.external_session_id.clone();
    let imported = tokio::task::spawn_blocking(move || {
        load_configured_history_session(kind, &configured_env, &external_session_id)
    })
    .await
    .map_err(internal_error)?
    .map_err(|error| ApplicationError::internal(error.to_string()))?;
    let workspace = Workspace::find_by_id(pool, selection.workspace_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApplicationError::not_found("workspace not found"))?;
    let session = Session::create(
        pool,
        &CreateSession {
            executor: Some(selection.agent_id.to_string()),
            agent_id: Some(selection.agent_id.clone()),
            task_id: Some(workspace.task_id),
            name: imported.title.clone(),
            initial_prompt: None,
            status: Some(SessionStatus::Done),
        },
        Uuid::new_v4(),
        workspace.id,
    )
    .await
    .map_err(internal_error)?;
    DbConversationSummary::bind_external_id(
        pool,
        session.id,
        &selection.external_session_id,
        &selection.agent_id,
    )
    .await
    .map_err(internal_error)?;
    append_imported_history_events(pool, session.id, &imported).await?;
    Ok(session.id)
}

fn parse_payload<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, ApplicationError> {
    if let Some(payload) = args.get("payload") {
        return parse(payload.clone());
    }
    if let Some(request) = args.get("request") {
        return parse(request.clone());
    }
    parse(args)
}

fn args_agent_fallback() -> AgentId {
    AgentId::parse("claude_code").expect("built-in agent id")
}

fn parse_operation_kind(value: &str) -> Option<AgentOperationKind> {
    match value {
        "install" => Some(AgentOperationKind::Install),
        "update" => Some(AgentOperationKind::Update),
        "repair" => Some(AgentOperationKind::Repair),
        "rollback" => Some(AgentOperationKind::Rollback),
        "uninstall" => Some(AgentOperationKind::Uninstall),
        "remove" => Some(AgentOperationKind::Remove),
        "check" => Some(AgentOperationKind::Check),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_defaults_view_uses_values_not_a_raw_map() {
        let view = AgentSessionDefaultsView {
            values: BTreeMap::from([("model".into(), json!("opus"))]),
            stale_ids: vec!["gone".into()],
        };
        let value = serde_json::to_value(view).expect("session defaults view");
        assert_eq!(value["values"]["model"], json!("opus"));
        assert_eq!(value["staleIds"], json!(["gone"]));
        assert!(value.get("model").is_none());
    }
}
