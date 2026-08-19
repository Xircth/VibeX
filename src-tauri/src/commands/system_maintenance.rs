use std::{ffi::OsString, path::PathBuf, time::Duration};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppReleaseStatus {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub release_url: Option<String>,
    pub repository: Option<String>,
    pub checked: bool,
    pub error: Option<String>,
    pub body: Option<String>,
    pub published_at: Option<String>,
    pub checked_at: String,
}

const DEFAULT_UPDATE_REPOSITORY: &str = "Xircth/VibeX";
const RELEASE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);

#[tauri::command]
pub async fn check_app_release() -> Result<AppReleaseStatus, AppError> {
    Ok(check_latest_release().await)
}

fn checked_at_now() -> String {
    Utc::now().to_rfc3339()
}

fn empty_status(
    current_version: String,
    repository: Option<String>,
    error: Option<String>,
) -> AppReleaseStatus {
    AppReleaseStatus {
        current_version,
        latest_version: None,
        update_available: false,
        release_url: None,
        repository,
        checked: false,
        error,
        body: None,
        published_at: None,
        checked_at: checked_at_now(),
    }
}

async fn check_latest_release() -> AppReleaseStatus {
    let current_version = utils::version::APP_VERSION.to_string();
    let repository = update_repository();
    let Some(repository) = repository else {
        return empty_status(
            current_version,
            None,
            Some("No GitHub repository configured for release checks".to_string()),
        );
    };

    let url = format!("https://api.github.com/repos/{repository}/releases/latest");
    let client = match reqwest::Client::builder()
        .timeout(RELEASE_CHECK_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return empty_status(current_version, Some(repository), Some(error.to_string()));
        }
    };
    let response = match client
        .get(url)
        .header(reqwest::header::USER_AGENT, "VibeX")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return empty_status(current_version, Some(repository), Some(error.to_string()));
        }
    };

    if !response.status().is_success() {
        return empty_status(
            current_version,
            Some(repository),
            Some(format!(
                "GitHub release check returned {}",
                response.status()
            )),
        );
    }

    #[derive(Deserialize)]
    struct GitHubRelease {
        tag_name: String,
        html_url: String,
        body: Option<String>,
        published_at: Option<String>,
    }

    let release = match response.json::<GitHubRelease>().await {
        Ok(release) => release,
        Err(error) => {
            return empty_status(current_version, Some(repository), Some(error.to_string()));
        }
    };

    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    let body = release
        .body
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    AppReleaseStatus {
        update_available: version_is_newer(&latest_version, &current_version),
        current_version,
        latest_version: Some(latest_version),
        release_url: Some(release.html_url),
        repository: Some(repository),
        checked: true,
        error: None,
        body,
        published_at: release.published_at,
        checked_at: checked_at_now(),
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

    #[test]
    fn default_repository_matches_signed_updater_feed() {
        assert_eq!(DEFAULT_UPDATE_REPOSITORY, "Xircth/VibeX");
    }

    #[test]
    fn parses_release_notes_and_published_at() {
        let release: GitHubReleaseFixture = serde_json::from_value(serde_json::json!({
            "tag_name": "v0.1.3",
            "html_url": "https://github.com/Xircth/VibeX/releases/tag/v0.1.3",
            "body": "## English\n\nNotes\n",
            "published_at": "2026-08-16T00:00:00Z"
        }))
        .expect("github release json");

        assert_eq!(release.tag_name, "v0.1.3");
        assert!(release.html_url.contains("Xircth/VibeX"));
        assert_eq!(release.body.as_deref(), Some("## English\n\nNotes\n"));
        assert_eq!(
            release.published_at.as_deref(),
            Some("2026-08-16T00:00:00Z")
        );
    }

    #[derive(Deserialize)]
    struct GitHubReleaseFixture {
        tag_name: String,
        html_url: String,
        body: Option<String>,
        published_at: Option<String>,
    }
}
