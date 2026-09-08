use std::{
    path::{Path, PathBuf},
    process::Output,
    time::Duration,
};

use application::ApplicationError;
use db::models::{
    execution_process::ExecutionProcessRunReason,
    session::{CreateSession, Session, SessionStatus},
};
use deployment::Deployment;
use executors::actions::script::ScriptContext;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::{
    container_actions,
    settings_store::{read_section, write_section},
};
use tokio::time::timeout;
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

const SETTINGS_FILE_NAME: &str = "version-control-settings.json";
const SETTINGS_SECTION: &str = "version_control";
const DEFAULT_GITHUB_HOST: &str = "github.com";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct VersionControlCliSettings {
    git_custom_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitVersionStatus {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GitHubCliStatus {
    gh_installed: bool,
    gh_path: Option<String>,
    authenticated: bool,
    username: Option<String>,
    host: String,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct VersionControlInstallResult {
    git: GitVersionStatus,
    github: GitHubCliStatus,
    identity_configured: bool,
    error: Option<String>,
}

#[derive(Deserialize)]
struct GitHubUserResponse {
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsArgs {
    settings: Option<VersionControlCliSettings>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostArgs {
    host: Option<String>,
    username: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallToolsArgs {
    user_name: String,
    user_email: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceIdArgs {
    workspace_id: uuid::Uuid,
}

fn settings_path() -> PathBuf {
    utils::assets::asset_dir().join(SETTINGS_FILE_NAME)
}

async fn load_settings() -> Result<VersionControlCliSettings, ApplicationError> {
    let unified_path = utils::assets::settings_path();
    if let Some(settings) = read_section(&unified_path, SETTINGS_SECTION)
        .await
        .map_err(internal_error)?
    {
        return Ok(settings);
    }
    let path = settings_path();
    if !path.exists() {
        return Ok(VersionControlCliSettings::default());
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(internal_error)?;
    let settings = serde_json::from_str(&content).map_err(internal_error)?;
    write_section(&unified_path, SETTINGS_SECTION, &settings)
        .await
        .map_err(internal_error)?;
    Ok(settings)
}

async fn save_settings(
    settings: &VersionControlCliSettings,
) -> Result<VersionControlCliSettings, ApplicationError> {
    write_section(&utils::assets::settings_path(), SETTINGS_SECTION, settings)
        .await
        .map_err(internal_error)?;
    Ok(settings.clone())
}

async fn run_hidden_command(program: &Path, args: &[&str]) -> Result<Output, ApplicationError> {
    let mut command = utils::process::new_hidden_tokio_command(program, args);
    command.kill_on_drop(true);
    match timeout(Duration::from_secs(15), command.output()).await {
        Ok(result) => result.map_err(internal_error),
        Err(_) => Err(ApplicationError::internal(format!(
            "{} timed out",
            program.to_string_lossy()
        ))),
    }
}

async fn run_git_version(path: PathBuf) -> GitVersionStatus {
    let output = match run_hidden_command(&path, &["--version"]).await {
        Ok(output) => output,
        Err(error) => {
            return GitVersionStatus {
                installed: false,
                version: None,
                path: Some(path.display().to_string()),
                message: Some(error.to_string()),
            };
        }
    };
    if !output.status.success() {
        return GitVersionStatus {
            installed: false,
            version: None,
            path: Some(path.display().to_string()),
            message: Some(format!("process exited with status {}", output.status)),
        };
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = stdout
        .trim()
        .strip_prefix("git version ")
        .unwrap_or(stdout.trim())
        .to_string();
    GitVersionStatus {
        installed: true,
        version: (!version.is_empty()).then_some(version),
        path: Some(path.display().to_string()),
        message: None,
    }
}

fn resolve_git_path(settings: &VersionControlCliSettings) -> PathBuf {
    settings
        .git_custom_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(super::git_cli_install::find_managed_executable)
        .or_else(|| which::which("git").ok())
        .unwrap_or_else(|| PathBuf::from("git"))
}

async fn resolve_gh_path() -> Option<PathBuf> {
    let managed = super::github_cli_install::managed_executable_path();
    if managed.is_file() {
        return Some(managed);
    }
    which::which("gh").ok()
}

fn host_from_args(args: &HostArgs) -> String {
    args.host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or(DEFAULT_GITHUB_HOST)
        .to_string()
}

async fn github_api_user(gh_path: &Path, host: &str) -> Result<String, String> {
    let mut args = vec!["api", "user"];
    if host != DEFAULT_GITHUB_HOST {
        args.push("--hostname");
        args.push(host);
    }
    let output = run_hidden_command(gh_path, &args)
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("process exited with status {}", output.status));
    }
    let user: GitHubUserResponse = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Failed to parse GitHub user response: {error}"))?;
    Ok(user.login)
}

async fn github_status_for(host: String) -> Result<GitHubCliStatus, ApplicationError> {
    let Some(gh_path) = resolve_gh_path().await else {
        return Ok(GitHubCliStatus {
            gh_installed: false,
            gh_path: None,
            authenticated: false,
            username: None,
            host,
            message: Some("GitHub CLI is not installed or not on PATH.".to_string()),
        });
    };
    match github_api_user(&gh_path, &host).await {
        Ok(username) => Ok(GitHubCliStatus {
            gh_installed: true,
            gh_path: Some(gh_path.display().to_string()),
            authenticated: true,
            username: Some(username),
            host,
            message: None,
        }),
        Err(message) => Ok(GitHubCliStatus {
            gh_installed: true,
            gh_path: Some(gh_path.display().to_string()),
            authenticated: false,
            username: None,
            host,
            message: Some(message),
        }),
    }
}

pub(super) async fn get_settings() -> Result<Value, ApplicationError> {
    serialize(load_settings().await?)
}

pub(super) async fn update_settings(args: Value) -> Result<Value, ApplicationError> {
    let args: SettingsArgs = parse(args)?;
    let settings = args.settings.unwrap_or_default();
    if settings
        .git_custom_path
        .as_deref()
        .is_some_and(|path| path.trim().is_empty())
    {
        return serialize(save_settings(&VersionControlCliSettings::default()).await?);
    }
    serialize(save_settings(&settings).await?)
}

pub(super) async fn detect_git() -> Result<Value, ApplicationError> {
    let settings = load_settings().await?;
    serialize(run_git_version(resolve_git_path(&settings)).await)
}

pub(super) async fn test_git_path(args: Value) -> Result<Value, ApplicationError> {
    let args: PathArgs = parse(args)?;
    let trimmed = args.path.trim();
    if trimmed.is_empty() {
        return Err(ApplicationError::bad_request("Git path cannot be empty"));
    }
    serialize(run_git_version(PathBuf::from(trimmed)).await)
}

pub(super) async fn github_status(args: Value) -> Result<Value, ApplicationError> {
    let args: HostArgs = parse(args).unwrap_or(HostArgs {
        host: None,
        username: None,
    });
    serialize(github_status_for(host_from_args(&args)).await?)
}

pub(super) async fn open_login(_args: Value) -> Result<Value, ApplicationError> {
    let _ = resolve_gh_path()
        .await
        .ok_or_else(|| ApplicationError::bad_request("GitHub CLI is not installed."))?;
    Err(ApplicationError::bad_request(
        "GitHub login requires an interactive Host terminal.",
    ))
}

pub(super) async fn logout(args: Value) -> Result<Value, ApplicationError> {
    let args: HostArgs = parse(args).unwrap_or(HostArgs {
        host: None,
        username: None,
    });
    let host = host_from_args(&args);
    let gh_path = resolve_gh_path()
        .await
        .ok_or_else(|| ApplicationError::bad_request("GitHub CLI is not installed."))?;
    let mut command_args = vec!["auth".to_string(), "logout".to_string()];
    command_args.push("--hostname".to_string());
    command_args.push(host.clone());
    if let Some(username) = args
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command_args.push("--user".to_string());
        command_args.push(username.to_string());
    }
    let arg_refs: Vec<&str> = command_args.iter().map(String::as_str).collect();
    let _ = run_hidden_command(&gh_path, &arg_refs).await;
    serialize(github_status_for(host).await?)
}

pub(super) async fn install_github_cli(args: Value) -> Result<Value, ApplicationError> {
    if resolve_gh_path().await.is_none() {
        super::github_cli_install::install().await?;
    }
    github_status(args).await
}

pub(super) async fn install_tools(args: Value) -> Result<Value, ApplicationError> {
    let args: InstallToolsArgs = parse(args)?;
    let user_name = args.user_name.trim();
    let user_email = args.user_email.trim();
    if user_name.is_empty() || user_email.is_empty() || !user_email.contains('@') {
        return Err(ApplicationError::bad_request(
            "A Git user name and email are required.",
        ));
    }
    let mut identity_configured = false;
    let mut error = None;
    if let Err(install_error) = ensure_git_installed().await {
        error = Some(install_error);
    }
    let git = run_git_version(resolve_git_path(&load_settings().await?)).await;
    if git.installed
        && let Some(git_path) = git.path.as_deref().filter(|path| !path.is_empty())
    {
        match super::git_cli_install::configure_identity(Path::new(git_path), user_name, user_email)
            .await
        {
            Ok(()) => identity_configured = true,
            Err(identity_error) => {
                error.get_or_insert(identity_error);
            }
        }
    }
    if error.is_none()
        && resolve_gh_path().await.is_none()
        && let Err(install_error) = super::github_cli_install::install().await
    {
        error = Some(install_error.envelope().message.clone());
    }
    let github = github_status_for(DEFAULT_GITHUB_HOST.to_string()).await?;
    if error.is_none() && !github.gh_installed {
        error = Some(
            github
                .message
                .clone()
                .unwrap_or_else(|| "GitHub CLI is not installed.".to_string()),
        );
    }
    serialize(VersionControlInstallResult {
        git,
        github,
        identity_configured,
        error,
    })
}

async fn ensure_git_installed() -> Result<(), String> {
    let settings = load_settings()
        .await
        .map_err(|error| error.envelope().message.clone())?;
    if run_git_version(resolve_git_path(&settings)).await.installed {
        return Ok(());
    }
    let executable = super::git_cli_install::install().await?;
    let mut settings = load_settings()
        .await
        .map_err(|error| error.envelope().message.clone())?;
    settings.git_custom_path = Some(executable.display().to_string());
    save_settings(&settings)
        .await
        .map_err(|error| error.envelope().message.clone())?;
    Ok(())
}

pub(super) async fn gh_cli_setup(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: WorkspaceIdArgs = parse(args)?;
    let workspace = domains.require_workspace(args.workspace_id).await?;
    if resolve_gh_path().await.is_none() {
        super::github_cli_install::install().await?;
    }
    let Some(gh) = resolve_gh_path().await else {
        return serialize(serde_json::json!({
            "process": Value::Null,
            "error": { "type": "cli_missing" },
        }));
    };
    let quoted = format!("\"{}\"", gh.display().to_string().replace('"', "\\\""));
    let action = container_actions::script_action(
        format!(
            "export GH_PROMPT_DISABLED=1\n{quoted} auth login --web --git-protocol https --skip-ssh-key\n"
        ),
        ScriptContext::ToolInstallScript,
        None,
        None,
    );
    domains
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await
        .map_err(internal_error)?;
    let session = match Session::find_latest_by_workspace_id(&domains.pool, workspace.id)
        .await
        .map_err(internal_error)?
    {
        Some(session) => session,
        None => Session::create(
            &domains.pool,
            &CreateSession {
                executor: Some("gh-cli".to_string()),
                agent_id: None,
                task_id: None,
                name: None,
                initial_prompt: None,
                status: Some(SessionStatus::Todo),
            },
            Uuid::new_v4(),
            workspace.id,
        )
        .await
        .map_err(internal_error)?,
    };
    let process = domains
        .deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &action,
            &ExecutionProcessRunReason::SetupScript,
        )
        .await
        .map_err(internal_error)?;
    serialize(serde_json::json!({
        "process": process,
        "error": Value::Null,
    }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn resolve_git_path_prefers_custom_path() {
        let settings = VersionControlCliSettings {
            git_custom_path: Some("/opt/custom/git".to_string()),
        };
        assert_eq!(
            resolve_git_path(&settings),
            PathBuf::from("/opt/custom/git")
        );
    }

    #[test]
    fn resolve_git_path_ignores_blank_custom_path() {
        let settings = VersionControlCliSettings {
            git_custom_path: Some("   ".to_string()),
        };
        assert_ne!(resolve_git_path(&settings), PathBuf::from("   "));
    }

    #[tokio::test]
    async fn install_tools_requires_a_name_and_email() {
        let error = install_tools(json!({
            "userName": "Ada",
            "userEmail": "not-an-email",
        }))
        .await
        .expect_err("invalid identity");
        assert_eq!(
            error.envelope().message,
            "A Git user name and email are required."
        );
    }
}
