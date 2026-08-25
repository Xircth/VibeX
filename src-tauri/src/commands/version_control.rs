use std::{
    path::{Path, PathBuf},
    process::Output,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use services::services::settings_store::{read_section, write_section};
use tokio::time::timeout;

use crate::error::AppError;

const SETTINGS_FILE_NAME: &str = "version-control-settings.json";
const SETTINGS_SECTION: &str = "version_control";
const DEFAULT_GITHUB_HOST: &str = "github.com";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VersionControlCliSettings {
    pub git_custom_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitVersionStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubCliStatus {
    pub gh_installed: bool,
    pub gh_path: Option<String>,
    pub authenticated: bool,
    pub username: Option<String>,
    pub host: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionControlInstallResult {
    pub git: GitVersionStatus,
    pub github: GitHubCliStatus,
    pub identity_configured: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubUserResponse {
    login: String,
}

fn settings_path() -> PathBuf {
    utils::assets::asset_dir().join(SETTINGS_FILE_NAME)
}

async fn load_settings() -> Result<VersionControlCliSettings, AppError> {
    let unified_path = utils::assets::settings_path();
    if let Some(settings) = read_section(&unified_path, SETTINGS_SECTION)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
    {
        return Ok(settings);
    }

    let path = settings_path();
    if !path.exists() {
        return Ok(VersionControlCliSettings::default());
    }
    let content = tokio::fs::read_to_string(&path).await.map_err(|error| {
        AppError::Internal(format!(
            "Failed to read version control settings {}: {error}",
            path.display()
        ))
    })?;

    let settings = serde_json::from_str(&content).map_err(|error| {
        AppError::Internal(format!(
            "Invalid version control settings {}: {error}",
            path.display()
        ))
    })?;
    write_section(&unified_path, SETTINGS_SECTION, &settings)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(settings)
}

async fn save_settings(
    settings: &VersionControlCliSettings,
) -> Result<VersionControlCliSettings, AppError> {
    write_section(&utils::assets::settings_path(), SETTINGS_SECTION, settings)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(settings.clone())
}

fn command_detail(output: &Output) -> String {
    utils::process::command_output_detail(output)
        .unwrap_or_else(|| format!("process exited with status {}", output.status))
}

async fn run_hidden_command(program: &Path, args: &[&str]) -> Result<Output, AppError> {
    let mut command = utils::process::new_hidden_tokio_command(program, args);
    command.kill_on_drop(true);

    match timeout(Duration::from_secs(15), command.output()).await {
        Ok(result) => result.map_err(|error| {
            AppError::Internal(format!(
                "Failed to run {}: {error}",
                program.to_string_lossy()
            ))
        }),
        Err(_) => Err(AppError::Internal(format!(
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
            message: Some(command_detail(&output)),
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
        .or_else(|| which::which("git").ok())
        .unwrap_or_else(|| PathBuf::from("git"))
}

async fn resolve_gh_path() -> Option<PathBuf> {
    let resolved = utils::shell::resolve_executable_path("gh").await;
    let managed = super::github_cli_installer::managed_executable_path();
    match resolved {
        Some(path)
            if cfg!(windows)
                && matches!(
                    path.extension().and_then(|extension| extension.to_str()),
                    Some("cmd" | "bat")
                )
                && managed.is_file() =>
        {
            Some(managed)
        }
        Some(path) => Some(path),
        None => None,
    }
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
        return Err(command_detail(&output));
    }

    let user: GitHubUserResponse = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Failed to parse GitHub user response: {error}"))?;
    Ok(user.login)
}

#[tauri::command]
pub async fn get_version_control_settings() -> Result<VersionControlCliSettings, AppError> {
    load_settings().await
}

#[tauri::command]
pub async fn update_version_control_settings(
    settings: VersionControlCliSettings,
) -> Result<VersionControlCliSettings, AppError> {
    if let Some(path) = settings.git_custom_path.as_deref()
        && path.trim().is_empty()
    {
        return save_settings(&VersionControlCliSettings::default()).await;
    }

    save_settings(&settings).await
}

#[tauri::command]
pub async fn detect_git_version() -> Result<GitVersionStatus, AppError> {
    let settings = load_settings().await?;
    Ok(run_git_version(resolve_git_path(&settings)).await)
}

#[tauri::command]
pub async fn test_git_path(path: String) -> Result<GitVersionStatus, AppError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("Git path cannot be empty".to_string()));
    }

    Ok(run_git_version(PathBuf::from(trimmed)).await)
}

#[tauri::command]
pub async fn get_github_cli_status(host: Option<String>) -> Result<GitHubCliStatus, AppError> {
    let host = host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or(DEFAULT_GITHUB_HOST)
        .to_string();

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

#[tauri::command]
pub async fn install_github_cli(host: Option<String>) -> Result<GitHubCliStatus, AppError> {
    if resolve_gh_path().await.is_none() {
        super::github_cli_installer::install()
            .await
            .map_err(AppError::Internal)?;
    }

    get_github_cli_status(host).await
}

#[tauri::command]
pub async fn install_version_control_tools(
    user_name: String,
    user_email: String,
) -> Result<VersionControlInstallResult, AppError> {
    let user_name = user_name.trim();
    let user_email = user_email.trim();
    if user_name.is_empty() || user_email.is_empty() || !user_email.contains('@') {
        return Err(AppError::BadRequest(
            "A Git user name and email are required.".to_string(),
        ));
    }

    let mut identity_configured = false;
    let mut error = None;

    if let Err(install_error) = ensure_git_installed().await {
        error = Some(install_error);
    }

    let git = detect_git_version().await?;
    if git.installed
        && let Some(git_path) = git.path.as_deref().filter(|path| !path.is_empty())
    {
        match super::git_cli_installer::configure_identity(
            Path::new(git_path),
            user_name,
            user_email,
        )
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
        && let Err(install_error) = super::github_cli_installer::install().await
    {
        error = Some(install_error);
    }

    let github = get_github_cli_status(None).await?;
    if error.is_none() && !github.gh_installed {
        error = Some(
            github
                .message
                .clone()
                .unwrap_or_else(|| "GitHub CLI is not installed.".to_string()),
        );
    }

    Ok(VersionControlInstallResult {
        git,
        github,
        identity_configured,
        error,
    })
}

async fn ensure_git_installed() -> Result<(), String> {
    let settings = load_settings().await.map_err(|error| error.to_string())?;
    if run_git_version(resolve_git_path(&settings)).await.installed {
        return Ok(());
    }

    let executable = super::git_cli_installer::install().await?;
    let mut settings = load_settings().await.map_err(|error| error.to_string())?;
    settings.git_custom_path = Some(executable.display().to_string());
    save_settings(&settings)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn open_github_cli_login(host: Option<String>) -> Result<(), AppError> {
    let gh_path = resolve_gh_path()
        .await
        .ok_or_else(|| AppError::BadRequest("GitHub CLI is not installed.".to_string()))?;
    let gh_command = quote_terminal_program(&gh_path);
    let host = host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or(DEFAULT_GITHUB_HOST);

    let command = if host == DEFAULT_GITHUB_HOST {
        format!("{gh_command} auth login --web --git-protocol https")
    } else {
        format!(
            "{gh_command} auth login --web --git-protocol https --hostname {}",
            quote_terminal_argument(host)
        )
    };

    spawn_visible_terminal(&command).map_err(|error| {
        AppError::Internal(format!("Failed to open GitHub login terminal: {error}"))
    })
}

fn quote_terminal_program(path: &Path) -> String {
    quote_terminal_argument(&path.to_string_lossy())
}

#[cfg(windows)]
fn quote_terminal_argument(value: &str) -> String {
    format!("\"{}\"", value.replace('%', "%%").replace('"', "\"\""))
}

#[cfg(not(windows))]
fn quote_terminal_argument(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[tauri::command]
pub async fn logout_github_cli(
    host: Option<String>,
    username: Option<String>,
) -> Result<GitHubCliStatus, AppError> {
    let host = host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or(DEFAULT_GITHUB_HOST)
        .to_string();

    let gh_path = resolve_gh_path()
        .await
        .ok_or_else(|| AppError::BadRequest("GitHub CLI is not installed.".to_string()))?;

    let mut args = vec!["auth".to_string(), "logout".to_string()];
    args.push("--hostname".to_string());
    args.push(host.clone());
    if let Some(username) = username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.push("--user".to_string());
        args.push(username.to_string());
    }

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut command = utils::process::new_hidden_tokio_command(&gh_path, arg_refs);
    command.env("GH_PROMPT_DISABLED", "1");
    command.kill_on_drop(true);
    let output = match timeout(Duration::from_secs(15), command.output()).await {
        Ok(result) => result.map_err(|error| {
            AppError::Internal(format!("Failed to run gh auth logout: {error}"))
        })?,
        Err(_) => {
            return Err(AppError::Internal(
                "gh auth logout timed out; run it manually in a terminal.".to_string(),
            ));
        }
    };

    if !output.status.success() {
        return Err(AppError::BadRequest(format!(
            "GitHub CLI logout failed: {}",
            command_detail(&output)
        )));
    }

    get_github_cli_status(Some(host)).await
}

#[cfg(target_os = "windows")]
fn spawn_visible_terminal(command: &str) -> std::io::Result<()> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", "cmd", "/K", command])
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn spawn_visible_terminal(command: &str) -> std::io::Result<()> {
    let script = format!(
        "tell application \"Terminal\" to do script \"{}\"",
        command.replace('\\', "\\\\").replace('"', "\\\"")
    );
    std::process::Command::new("osascript")
        .args(["-e", &script])
        .spawn()
        .map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_visible_terminal(command: &str) -> std::io::Result<()> {
    let run = format!("{command}; exec $SHELL");
    for terminal in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
        if which::which(terminal).is_ok()
            && std::process::Command::new(terminal)
                .args(["-e", "sh", "-lc", &run])
                .spawn()
                .map(|_| ())
                .is_ok()
        {
            return Ok(());
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "no supported terminal emulator found",
    ))
}
