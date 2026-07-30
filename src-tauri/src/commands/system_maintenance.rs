use std::{ffi::OsString, path::PathBuf};

use serde::{Deserialize, Serialize};

use crate::{error::AppError, state::AppState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMaintenanceStatus {
    pub app: AppReleaseStatus,
    pub npm: RuntimeStatus,
    pub tools: Vec<LocalToolStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppReleaseStatus {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub release_url: Option<String>,
    pub repository: Option<String>,
    pub checked: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeStatus {
    pub name: String,
    pub available: bool,
    pub path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalToolStatus {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub group_id: String,
    pub user_visible: bool,
    pub executable: String,
    pub npm_package: String,
    pub installed: bool,
    pub executable_path: Option<String>,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub minimum_supported_version: Option<String>,
    pub supported: bool,
    pub update_available: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallSystemDependenciesResult {
    pub installed_or_updated: Vec<String>,
    pub skipped: Vec<String>,
    pub status: SystemMaintenanceStatus,
}

const DEFAULT_UPDATE_REPOSITORY: &str = "vibex/vibex";

fn npm_program() -> &'static str {
    if cfg!(windows) { "npm.cmd" } else { "npm" }
}

#[tauri::command]
pub async fn get_system_maintenance_status() -> Result<SystemMaintenanceStatus, AppError> {
    system_maintenance_status().await
}

#[tauri::command]
pub async fn check_app_release() -> Result<AppReleaseStatus, AppError> {
    Ok(check_latest_release().await)
}

/// Agent Runtime and ACP lifecycle is owned exclusively by Agent Management.
/// This legacy app-maintenance command intentionally has no Agent packages to
/// mutate, preventing an unpinned second installer from bypassing install
/// locks and integrity checks.
#[tauri::command]
pub async fn install_system_dependencies(
    _state: tauri::State<'_, AppState>,
    _force_update: Option<bool>,
    tool_ids: Option<Vec<String>>,
) -> Result<InstallSystemDependenciesResult, AppError> {
    Ok(InstallSystemDependenciesResult {
        installed_or_updated: Vec::new(),
        skipped: tool_ids.unwrap_or_default(),
        status: system_maintenance_status().await?,
    })
}

async fn system_maintenance_status() -> Result<SystemMaintenanceStatus, AppError> {
    Ok(SystemMaintenanceStatus {
        app: check_latest_release().await,
        npm: runtime_status(npm_program()).await,
        tools: Vec::new(),
    })
}

async fn runtime_status(name: &str) -> RuntimeStatus {
    match utils::shell::resolve_executable_path(name).await {
        Some(path) => RuntimeStatus {
            name: name.to_string(),
            available: true,
            path: Some(path.display().to_string()),
            message: format!("Found {name}"),
        },
        None => RuntimeStatus {
            name: name.to_string(),
            available: false,
            path: None,
            message: format!("{name} not found in PATH"),
        },
    }
}

async fn check_latest_release() -> AppReleaseStatus {
    let current_version = utils::version::APP_VERSION.to_string();
    let repository = update_repository();
    let Some(repository) = repository else {
        return AppReleaseStatus {
            current_version,
            latest_version: None,
            update_available: false,
            release_url: None,
            repository: None,
            checked: false,
            error: Some("No GitHub repository configured for release checks".to_string()),
        };
    };

    let url = format!("https://api.github.com/repos/{repository}/releases/latest");
    let response = match reqwest::Client::new()
        .get(url)
        .header(reqwest::header::USER_AGENT, "VibeX")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return AppReleaseStatus {
                current_version,
                latest_version: None,
                update_available: false,
                release_url: None,
                repository: Some(repository),
                checked: false,
                error: Some(error.to_string()),
            };
        }
    };

    if !response.status().is_success() {
        return AppReleaseStatus {
            current_version,
            latest_version: None,
            update_available: false,
            release_url: None,
            repository: Some(repository),
            checked: false,
            error: Some(format!(
                "GitHub release check returned {}",
                response.status()
            )),
        };
    }

    #[derive(Deserialize)]
    struct GitHubRelease {
        tag_name: String,
        html_url: String,
    }

    let release = match response.json::<GitHubRelease>().await {
        Ok(release) => release,
        Err(error) => {
            return AppReleaseStatus {
                current_version,
                latest_version: None,
                update_available: false,
                release_url: None,
                repository: Some(repository),
                checked: false,
                error: Some(error.to_string()),
            };
        }
    };

    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    AppReleaseStatus {
        update_available: version_is_newer(&latest_version, &current_version),
        current_version,
        latest_version: Some(latest_version),
        release_url: Some(release.html_url),
        repository: Some(repository),
        checked: true,
        error: None,
    }
}

pub(crate) fn update_repository() -> Option<String> {
    std::env::var("VIBEX_UPDATE_REPO")
        .ok()
        .and_then(|value| normalize_github_repo(&value))
        .or_else(git_remote_repository)
        .or_else(|| Some(DEFAULT_UPDATE_REPOSITORY.to_string()))
}

fn git_remote_repository() -> Option<String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .to_path_buf();
    let output = utils::process::new_hidden_std_command(
        "git",
        [
            OsString::from("-C"),
            root.into_os_string(),
            OsString::from("config"),
            OsString::from("--get"),
            OsString::from("remote.origin.url"),
        ],
    )
    .output()
    .ok()?;
    if !output.status.success() {
        return None;
    }
    normalize_github_repo(String::from_utf8_lossy(&output.stdout).trim())
}

fn normalize_github_repo(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_end_matches(".git");
    if let Some(rest) = trimmed.strip_prefix("https://github.com/") {
        return repo_pair(rest);
    }
    if let Some(rest) = trimmed.strip_prefix("http://github.com/") {
        return repo_pair(rest);
    }
    if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        return repo_pair(rest);
    }
    (trimmed.split('/').count() == 2)
        .then(|| repo_pair(trimmed))
        .flatten()
}

fn repo_pair(value: &str) -> Option<String> {
    let mut parts = value.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        None
    } else {
        Some(format!("{owner}/{repo}"))
    }
}

fn version_is_newer(latest: &str, current: &str) -> bool {
    numeric_version_parts(latest) > numeric_version_parts(current)
}

fn numeric_version_parts(value: &str) -> Vec<u64> {
    value
        .trim()
        .trim_start_matches('v')
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_remote_urls() {
        assert_eq!(
            normalize_github_repo("git@github.com:openai/vibex.git").as_deref(),
            Some("openai/vibex")
        );
        assert_eq!(
            normalize_github_repo("https://github.com/openai/vibex.git").as_deref(),
            Some("openai/vibex")
        );
    }

    #[test]
    fn compares_numeric_versions() {
        assert!(version_is_newer("0.10.0", "0.9.9"));
        assert!(!version_is_newer("0.9.9", "0.10.0"));
    }
}
