use std::{
    path::{Path, PathBuf},
    process::Output,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::time::timeout;

use crate::error::AppError;

const SETTINGS_FILE_NAME: &str = "version-control-settings.json";
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

#[derive(Debug, Deserialize)]
struct GitHubUserResponse {
    login: String,
}

fn settings_path() -> PathBuf {
    utils::assets::asset_dir().join(SETTINGS_FILE_NAME)
}

async fn load_settings() -> Result<VersionControlCliSettings, AppError> {
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

    serde_json::from_str(&content).map_err(|error| {
        AppError::Internal(format!(
            "Invalid version control settings {}: {error}",
            path.display()
        ))
    })
}

async fn save_settings(
    settings: &VersionControlCliSettings,
) -> Result<VersionControlCliSettings, AppError> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            AppError::Internal(format!(
                "Failed to create settings directory {}: {error}",
                parent.display()
            ))
        })?;
    }

    let content = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::Internal(format!("Failed to serialize settings: {error}")))?;
    tokio::fs::write(&path, content).await.map_err(|error| {
        AppError::Internal(format!(
            "Failed to write version control settings {}: {error}",
            path.display()
        ))
    })?;
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

fn resolve_gh_path() -> Option<PathBuf> {
    which::which("gh").ok()
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

    let Some(gh_path) = resolve_gh_path() else {
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
pub async fn open_github_cli_login(host: Option<String>) -> Result<(), AppError> {
    let host = host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or(DEFAULT_GITHUB_HOST);

    let command = if host == DEFAULT_GITHUB_HOST {
        "gh auth login --web --git-protocol https".to_string()
    } else {
        format!("gh auth login --web --git-protocol https --hostname {host}")
    };

    spawn_visible_terminal(&command).map_err(|error| {
        AppError::Internal(format!("Failed to open GitHub login terminal: {error}"))
    })
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
