//! Product commands that Settings, composer, and session extras call on Host.
//! Implementations wrap the same services the desktop used to invoke locally.

mod chat;
pub(crate) mod config;
mod images;
mod instructions;
mod mcp;
mod ops;
pub(crate) mod skills;
mod system;
mod version_control;

use application::{ApplicationError, DomainCommand};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::domains::{ServerApplicationDomains, parse};

pub(crate) fn handles(command: DomainCommand) -> bool {
    matches!(
        command,
        DomainCommand::UpdateConfig
            | DomainCommand::GetSettingsFilePath
            | DomainCommand::GetProfiles
            | DomainCommand::UpdateProfiles
            | DomainCommand::PlayNotificationSound
            | DomainCommand::CheckEditorAvailability
            | DomainCommand::EnhancePrompt
            | DomainCommand::ListPromptEnhancementModels
            | DomainCommand::RefreshPromptEnhancementCatalogs
            | DomainCommand::GetClaudeSettings
            | DomainCommand::UpdateClaudeSettings
            | DomainCommand::GetClaudeSettingsPath
            | DomainCommand::ScanLocalSkills
            | DomainCommand::ReadLocalSkill
            | DomainCommand::SearchSkillMarket
            | DomainCommand::GetMarketSkillDetail
            | DomainCommand::InstallMarketSkill
            | DomainCommand::SetSkillHosting
            | DomainCommand::UninstallSkill
            | DomainCommand::ReadAgentSkill
            | DomainCommand::SaveAgentSkill
            | DomainCommand::DeleteAgentSkill
            | DomainCommand::McpScanLocal
            | DomainCommand::McpListMarketplaces
            | DomainCommand::McpSearchMarketplace
            | DomainCommand::McpGetMarketplaceServerDetail
            | DomainCommand::McpInstallMarketplaceServer
            | DomainCommand::McpUpsertLocalServer
            | DomainCommand::McpUninstallServer
            | DomainCommand::ListInstructions
            | DomainCommand::ListOfficialInstructions
            | DomainCommand::CreateInstruction
            | DomainCommand::UpdateInstruction
            | DomainCommand::DeleteInstruction
            | DomainCommand::InstallOfficialInstruction
            | DomainCommand::GetVersionControlSettings
            | DomainCommand::UpdateVersionControlSettings
            | DomainCommand::DetectGitVersion
            | DomainCommand::TestGitPath
            | DomainCommand::GetGithubCliStatus
            | DomainCommand::OpenGithubCliLogin
            | DomainCommand::LogoutGithubCli
            | DomainCommand::InstallGithubCli
            | DomainCommand::InstallVersionControlTools
            | DomainCommand::GhCliSetup
            | DomainCommand::ListChatChannels
            | DomainCommand::CreateChatChannel
            | DomainCommand::UpdateChatChannel
            | DomainCommand::DeleteChatChannel
            | DomainCommand::ConnectChatChannel
            | DomainCommand::DisconnectChatChannel
            | DomainCommand::TestChatChannel
            | DomainCommand::GetChatChannelHasToken
            | DomainCommand::SaveChatChannelToken
            | DomainCommand::DeleteChatChannelToken
            | DomainCommand::GetChatCommandPrefix
            | DomainCommand::SetChatCommandPrefix
            | DomainCommand::GetChatEventFilter
            | DomainCommand::SetChatEventFilter
            | DomainCommand::GetChatIncludePromptText
            | DomainCommand::SetChatIncludePromptText
            | DomainCommand::ListChatChannelStatuses
            | DomainCommand::ListChatChannelMessageLogs
            | DomainCommand::GetLogSettings
            | DomainCommand::SetLogSettings
            | DomainCommand::GetRecentLogs
            | DomainCommand::GetLogsDir
            | DomainCommand::GetSystemProxySettings
            | DomainCommand::UpdateSystemProxySettings
            | DomainCommand::GetSystemRenderingSettings
            | DomainCommand::UpdateSystemRenderingSettings
            | DomainCommand::UploadImage
            | DomainCommand::UploadImageForTask
            | DomainCommand::UploadImageForWorkspace
            | DomainCommand::WritePastedImageAsset
            | DomainCommand::DeleteImage
            | DomainCommand::GetTaskImages
            | DomainCommand::GetTaskImageMetadata
            | DomainCommand::GetWorkspaceImageMetadata
            | DomainCommand::GitCherryPick
            | DomainCommand::GitCreateBranchAtCommit
            | DomainCommand::GitResetToCommit
            | DomainCommand::GitRevertCommit
            | DomainCommand::GetWorkspacePrComments
            | DomainCommand::InitRepoAtPath
            | DomainCommand::GetReposBatch
            | DomainCommand::GetExecutionProcess
            | DomainCommand::GetExecutionProcessRepoStates
            | DomainCommand::StopExecutionProcess
            | DomainCommand::StopWorkspaceExecution
            | DomainCommand::ResetSessionProcess
            | DomainCommand::StartWorkspaceDevServer
            | DomainCommand::GetFirstUserMessage
            | DomainCommand::RespondToApproval
            | DomainCommand::GetProjectUsageStatistics
            | DomainCommand::ClearLocalAppData
            | DomainCommand::CheckAppRelease
            | DomainCommand::GetWorktreeCleanupStatus
            | DomainCommand::CrashReportsList
            | DomainCommand::CrashReportRead
            | DomainCommand::CrashReportDelete
    )
}

pub(crate) async fn dispatch(
    domains: &ServerApplicationDomains,
    command: DomainCommand,
    args: Value,
) -> Result<Value, ApplicationError> {
    match command {
        DomainCommand::UpdateConfig => config::update_config(domains, args).await,
        DomainCommand::GetSettingsFilePath => config::settings_file_path(),
        DomainCommand::GetProfiles => config::get_profiles(),
        DomainCommand::UpdateProfiles => config::update_profiles(args).await,
        DomainCommand::PlayNotificationSound => config::play_notification_sound(args).await,
        DomainCommand::CheckEditorAvailability => config::check_editor_availability(args).await,
        DomainCommand::EnhancePrompt => config::enhance_prompt(domains, args).await,
        DomainCommand::ListPromptEnhancementModels
        | DomainCommand::RefreshPromptEnhancementCatalogs => {
            config::list_prompt_enhancement_models(domains).await
        }
        DomainCommand::GetClaudeSettings => config::get_claude_settings().await,
        DomainCommand::UpdateClaudeSettings => config::update_claude_settings(args).await,
        DomainCommand::GetClaudeSettingsPath => config::claude_settings_path_value(),
        DomainCommand::ScanLocalSkills => skills::scan_local(domains).await,
        DomainCommand::ReadLocalSkill => skills::read_local(domains, args).await,
        DomainCommand::SearchSkillMarket => skills::search_market(args).await,
        DomainCommand::GetMarketSkillDetail => skills::market_detail(args).await,
        DomainCommand::InstallMarketSkill => skills::install_market(domains, args).await,
        DomainCommand::SetSkillHosting => skills::set_hosting(domains, args).await,
        DomainCommand::UninstallSkill => skills::uninstall(domains, args).await,
        DomainCommand::ReadAgentSkill => skills::read_agent(domains, args).await,
        DomainCommand::SaveAgentSkill => skills::save_agent(domains, args).await,
        DomainCommand::DeleteAgentSkill => skills::delete_agent(domains, args).await,
        DomainCommand::McpScanLocal => mcp::scan_local(domains).await,
        DomainCommand::McpListMarketplaces => mcp::list_marketplaces().await,
        DomainCommand::McpSearchMarketplace => mcp::search(args).await,
        DomainCommand::McpGetMarketplaceServerDetail => mcp::detail(args).await,
        DomainCommand::McpInstallMarketplaceServer => mcp::install(domains, args).await,
        DomainCommand::McpUpsertLocalServer => mcp::upsert(domains, args).await,
        DomainCommand::McpUninstallServer => mcp::uninstall(domains, args).await,
        DomainCommand::ListInstructions => instructions::list_local(domains, args).await,
        DomainCommand::ListOfficialInstructions => instructions::list_official(),
        DomainCommand::CreateInstruction => instructions::create(domains, args).await,
        DomainCommand::UpdateInstruction => instructions::update(domains, args).await,
        DomainCommand::DeleteInstruction => instructions::delete(domains, args).await,
        DomainCommand::InstallOfficialInstruction => {
            instructions::install_official(domains, args).await
        }
        DomainCommand::GetVersionControlSettings => version_control::get_settings().await,
        DomainCommand::UpdateVersionControlSettings => version_control::update_settings(args).await,
        DomainCommand::DetectGitVersion => version_control::detect_git().await,
        DomainCommand::TestGitPath => version_control::test_git_path(args).await,
        DomainCommand::GetGithubCliStatus => version_control::github_status(args).await,
        DomainCommand::OpenGithubCliLogin => version_control::open_login(args).await,
        DomainCommand::LogoutGithubCli => version_control::logout(args).await,
        DomainCommand::InstallGithubCli => version_control::install_github_cli(args).await,
        DomainCommand::InstallVersionControlTools => version_control::install_tools(args).await,
        DomainCommand::GhCliSetup => version_control::gh_cli_setup(domains, args).await,
        DomainCommand::ListChatChannels => chat::list_channels().await,
        DomainCommand::CreateChatChannel => chat::create_channel(args).await,
        DomainCommand::UpdateChatChannel => chat::update_channel(args).await,
        DomainCommand::DeleteChatChannel => chat::delete_channel(args).await,
        DomainCommand::ConnectChatChannel => chat::connect(args).await,
        DomainCommand::DisconnectChatChannel => chat::disconnect(args).await,
        DomainCommand::TestChatChannel => chat::test_channel(args).await,
        DomainCommand::GetChatChannelHasToken => chat::has_token(args).await,
        DomainCommand::SaveChatChannelToken => chat::save_token(args).await,
        DomainCommand::DeleteChatChannelToken => chat::delete_token(args).await,
        DomainCommand::GetChatCommandPrefix => chat::get_command_prefix().await,
        DomainCommand::SetChatCommandPrefix => chat::set_command_prefix(args).await,
        DomainCommand::GetChatEventFilter => chat::get_event_filter().await,
        DomainCommand::SetChatEventFilter => chat::set_event_filter(args).await,
        DomainCommand::GetChatIncludePromptText => chat::get_include_prompt_text().await,
        DomainCommand::SetChatIncludePromptText => chat::set_include_prompt_text(args).await,
        DomainCommand::ListChatChannelStatuses => chat::list_statuses().await,
        DomainCommand::ListChatChannelMessageLogs => chat::list_message_logs(domains, args).await,
        DomainCommand::GetLogSettings => system::get_log_settings(),
        DomainCommand::SetLogSettings => system::set_log_settings(args),
        DomainCommand::GetRecentLogs => system::get_recent_logs(args).await,
        DomainCommand::GetLogsDir => system::get_logs_dir(),
        DomainCommand::GetSystemProxySettings => system::get_proxy().await,
        DomainCommand::UpdateSystemProxySettings => system::update_proxy(args).await,
        DomainCommand::GetSystemRenderingSettings => system::get_rendering().await,
        DomainCommand::UpdateSystemRenderingSettings => system::update_rendering(args).await,
        DomainCommand::UploadImage => images::upload(domains, args).await,
        DomainCommand::UploadImageForTask => images::upload_for_task(domains, args).await,
        DomainCommand::UploadImageForWorkspace => images::upload_for_workspace(domains, args).await,
        DomainCommand::WritePastedImageAsset => images::write_pasted(args).await,
        DomainCommand::DeleteImage => images::delete(domains, args).await,
        DomainCommand::GetTaskImages => images::task_images(domains, args).await,
        DomainCommand::GetTaskImageMetadata => images::task_metadata(domains, args).await,
        DomainCommand::GetWorkspaceImageMetadata => images::workspace_metadata(domains, args).await,
        DomainCommand::GitCherryPick
        | DomainCommand::GitCreateBranchAtCommit
        | DomainCommand::GitResetToCommit
        | DomainCommand::GitRevertCommit => ops::git_commit_op(domains, command, args).await,
        DomainCommand::GetWorkspacePrComments => ops::workspace_pr_comments(domains, args).await,
        DomainCommand::InitRepoAtPath => ops::init_repo_at_path(domains, args).await,
        DomainCommand::GetReposBatch => ops::repos_batch(domains, args).await,
        DomainCommand::GetExecutionProcess => ops::get_execution_process(domains, args).await,
        DomainCommand::GetExecutionProcessRepoStates => {
            ops::execution_process_repo_states(domains, args).await
        }
        DomainCommand::StopExecutionProcess => ops::stop_execution_process(domains, args).await,
        DomainCommand::StopWorkspaceExecution => ops::stop_workspace_execution(domains, args).await,
        DomainCommand::ResetSessionProcess => ops::reset_session_process(domains, args).await,
        DomainCommand::StartWorkspaceDevServer => ops::start_dev_server(domains, args).await,
        DomainCommand::GetFirstUserMessage => ops::first_user_message(domains, args).await,
        DomainCommand::RespondToApproval => ops::respond_to_approval(domains, args).await,
        DomainCommand::GetProjectUsageStatistics => ops::project_usage(domains, args).await,
        DomainCommand::ClearLocalAppData => system::clear_local_app_data(domains).await,
        DomainCommand::CheckAppRelease => system::check_app_release().await,
        DomainCommand::GetWorktreeCleanupStatus => system::worktree_cleanup(domains, args).await,
        DomainCommand::CrashReportsList => system::crash_reports_list().await,
        DomainCommand::CrashReportRead => system::crash_report_read(args).await,
        DomainCommand::CrashReportDelete => system::crash_report_delete(args).await,
        other => Err(ApplicationError::internal(format!(
            "catalog does not handle {}",
            other.as_str()
        ))),
    }
}

fn unwrap_named<T: DeserializeOwned>(args: Value, keys: &[&str]) -> Result<T, ApplicationError> {
    for key in keys {
        if let Some(value) = args.get(*key).cloned().filter(|value| !value.is_null()) {
            return parse(value);
        }
    }
    parse(args)
}

async fn saved_agent_environment(
    pool: &sqlx::SqlitePool,
    agent_type: Option<&str>,
) -> Result<std::collections::HashMap<String, String>, ApplicationError> {
    let documents = if let Some(agent_type) = agent_type {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT env_json FROM agent_setting WHERE agent_type = ?",
        )
        .bind(agent_type)
        .fetch_all(pool)
        .await
        .map_err(crate::domains::internal_error)?
    } else {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT env_json FROM agent_setting WHERE env_json IS NOT NULL",
        )
        .fetch_all(pool)
        .await
        .map_err(crate::domains::internal_error)?
    };
    let mut merged = std::collections::HashMap::new();
    for document in documents.into_iter().flatten() {
        let values: std::collections::HashMap<String, String> =
            serde_json::from_str(&document).map_err(crate::domains::internal_error)?;
        for (key, value) in values {
            if (key.ends_with("_HOME") || key.ends_with("_DIR") || key.starts_with("XDG_"))
                && !value.trim().is_empty()
            {
                merged.insert(key, value);
            }
        }
    }
    Ok(merged)
}
