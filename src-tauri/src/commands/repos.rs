use std::path::PathBuf;

use db::models::{
    project::SearchResult,
    repo::{Repo, UpdateRepo},
};
use git::{self, GitBranch, GitRemote};
use reqwest::header::{ACCEPT, USER_AGENT};
use serde::Deserialize;
use services::services::{
    file_search::SearchMode,
    git_host::{GitHostProvider, GitHostService, GitHubIssueInfo, OpenPrInfo},
};
use uuid::Uuid;

use crate::{
    commands::projects::{OpenEditorRequest, OpenEditorResponse},
    error::AppError,
    state::AppState,
};

/// Helper: resolve repo path from repo_id
async fn resolve_repo_path(state: &AppState, repo_id: Uuid) -> Result<PathBuf, AppError> {
    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;
    Ok(PathBuf::from(&repo.path))
}

#[derive(Debug, Clone)]
struct GitHubRemoteSpec {
    host: String,
    owner: String,
    repo: String,
}

#[derive(Debug, Deserialize)]
struct GitHubApiIssueUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GitHubApiIssueLabel {
    name: String,
    color: String,
}

#[derive(Debug, Deserialize)]
struct GitHubApiIssue {
    number: i64,
    title: String,
    html_url: String,
    state: String,
    created_at: String,
    user: GitHubApiIssueUser,
    #[serde(default)]
    labels: Vec<GitHubApiIssueLabel>,
    #[serde(default)]
    comments: i64,
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct GitHubApiPrRef {
    #[serde(rename = "ref")]
    branch: String,
}

#[derive(Debug, Deserialize)]
struct GitHubApiPr {
    number: i64,
    html_url: String,
    title: String,
    head: GitHubApiPrRef,
    base: GitHubApiPrRef,
}

fn parse_github_remote_spec(remote_url: &str) -> Option<GitHubRemoteSpec> {
    let trimmed = remote_url.trim().trim_end_matches('/');

    let (host, path_part) = if let Some(rest) = trimmed.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        (host.to_string(), path.to_string())
    } else if let Some(rest) = trimmed.strip_prefix("ssh://") {
        let rest = rest.strip_prefix("git@").unwrap_or(rest);
        let (host, path) = rest.split_once('/')?;
        (host.to_string(), path.to_string())
    } else if let Some(rest) = trimmed.strip_prefix("https://") {
        let (host, path) = rest.split_once('/')?;
        (host.to_string(), path.to_string())
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        let (host, path) = rest.split_once('/')?;
        (host.to_string(), path.to_string())
    } else {
        return None;
    };

    let host_lower = host.to_ascii_lowercase();
    if !host_lower.contains("github.com") && !host_lower.contains("github.") {
        return None;
    }

    let segments: Vec<&str> = path_part.trim_matches('/').split('/').collect();
    if segments.len() < 2 {
        return None;
    }

    let owner = segments[segments.len() - 2];
    let repo = segments[segments.len() - 1].trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() {
        return None;
    }

    Some(GitHubRemoteSpec {
        host,
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

fn github_api_base(host: &str) -> String {
    if host.eq_ignore_ascii_case("github.com") {
        "https://api.github.com".to_string()
    } else {
        format!("https://{host}/api/v3")
    }
}

fn github_token_from_env() -> Option<String> {
    std::env::var("GH_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("GITHUB_TOKEN")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
}

fn summarize_github_api_error_body(body: &str) -> String {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(body)
        && let Some(message) = json.get("message").and_then(|v| v.as_str())
    {
        return message.to_string();
    }

    let compact = body.replace('\n', " ").trim().to_string();
    if compact.is_empty() {
        return "Unknown API error".to_string();
    }

    compact.chars().take(200).collect()
}

async fn request_github_json<T: for<'de> Deserialize<'de>>(
    spec: &GitHubRemoteSpec,
    path_and_query: &str,
) -> Result<T, AppError> {
    let url = format!(
        "{}/{}",
        github_api_base(&spec.host),
        path_and_query.trim_start_matches('/')
    );

    let client = reqwest::Client::new();
    let mut request = client
        .get(url)
        .header(USER_AGENT, "VibeX/1.0")
        .header(ACCEPT, "application/vnd.github+json");

    if let Some(token) = github_token_from_env() {
        request = request.bearer_auth(token);
    }

    let response = request
        .send()
        .await
        .map_err(|e| AppError::BadRequest(format!("GitHub API request failed: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = summarize_github_api_error_body(&body);
        return Err(AppError::BadRequest(format!(
            "GitHub API returned {status}: {detail}"
        )));
    }

    response
        .json::<T>()
        .await
        .map_err(|e| AppError::BadRequest(format!("Failed to parse GitHub API response: {e}")))
}

async fn list_open_prs_via_github_api(
    spec: &GitHubRemoteSpec,
) -> Result<Vec<OpenPrInfo>, AppError> {
    let api_prs: Vec<GitHubApiPr> = request_github_json(
        spec,
        &format!(
            "repos/{}/{}/pulls?state=open&per_page=100",
            spec.owner, spec.repo
        ),
    )
    .await?;

    Ok(api_prs
        .into_iter()
        .map(|pr| OpenPrInfo {
            number: pr.number,
            url: pr.html_url,
            title: pr.title,
            head_branch: pr.head.branch,
            base_branch: pr.base.branch,
        })
        .collect())
}

async fn list_issues_via_github_api(
    spec: &GitHubRemoteSpec,
    issue_state: &str,
) -> Result<Vec<GitHubIssueInfo>, AppError> {
    let api_issues: Vec<GitHubApiIssue> = request_github_json(
        spec,
        &format!(
            "repos/{}/{}/issues?state={}&per_page=100",
            spec.owner, spec.repo, issue_state
        ),
    )
    .await?;

    let mut issues = Vec::new();
    for issue in api_issues {
        if issue.pull_request.is_some() {
            continue;
        }

        let value = serde_json::json!({
            "number": issue.number,
            "title": issue.title,
            "url": issue.html_url,
            "state": issue.state,
            "created_at": issue.created_at,
            "author": { "login": issue.user.login },
            "labels": issue.labels.into_iter().map(|label| {
                serde_json::json!({
                    "name": label.name,
                    "color": label.color
                })
            }).collect::<Vec<_>>(),
            "comments_count": issue.comments
        });

        let parsed = serde_json::from_value::<GitHubIssueInfo>(value).map_err(|e| {
            AppError::BadRequest(format!("Failed to parse GitHub issue payload: {e}"))
        })?;
        issues.push(parsed);
    }

    Ok(issues)
}

#[tauri::command]
pub async fn get_repos(state: tauri::State<'_, AppState>) -> Result<Vec<Repo>, AppError> {
    let repos = Repo::list_all(&state.deployment.db().pool).await?;
    Ok(repos)
}

#[tauri::command]
pub async fn register_repo(
    state: tauri::State<'_, AppState>,
    path: String,
    display_name: Option<String>,
) -> Result<Repo, AppError> {
    let repo = state
        .deployment
        .repo()
        .register(&state.deployment.db().pool, &path, display_name.as_deref())
        .await?;
    Ok(repo)
}

#[tauri::command]
pub async fn get_recent_repos(state: tauri::State<'_, AppState>) -> Result<Vec<Repo>, AppError> {
    let repos = Repo::list_by_recent_workspace_usage(&state.deployment.db().pool).await?;
    Ok(repos)
}

#[tauri::command]
pub async fn init_repo(
    state: tauri::State<'_, AppState>,
    parent_path: String,
    folder_name: String,
) -> Result<Repo, AppError> {
    let repo = state
        .deployment
        .repo()
        .init_repo(
            &state.deployment.db().pool,
            state.deployment.git(),
            &parent_path,
            &folder_name,
        )
        .await?;
    Ok(repo)
}

#[tauri::command]
pub async fn check_git_repo_path(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<bool, AppError> {
    let is_git_repo = state.deployment.repo().is_git_repo_path(&path)?;
    Ok(is_git_repo)
}

/// Clone a git repository into `target_path`, then register it as a VibeX repo.
/// Cloning runs on a blocking thread (libgit2). Credentials use the SSH agent /
/// default key; public HTTPS clones need no token.
#[tauri::command]
pub async fn clone_repo(
    state: tauri::State<'_, AppState>,
    clone_url: String,
    target_path: String,
    display_name: Option<String>,
) -> Result<Repo, AppError> {
    let url = clone_url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::BadRequest("clone URL 不能为空".to_string()));
    }
    let target = PathBuf::from(&target_path);
    if target.exists() && target.read_dir().is_ok_and(|mut d| d.next().is_some()) {
        return Err(AppError::BadRequest(format!(
            "目标目录已存在且非空：{target_path}"
        )));
    }

    let target_for_clone = target.clone();
    tokio::task::spawn_blocking(move || {
        git::GitService::clone_repository(&url, &target_for_clone, None)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| AppError::Internal(format!("clone task panicked: {e}")))?
    .map_err(|e| AppError::Internal(format!("git clone failed: {e}")))?;

    let repo = state
        .deployment
        .repo()
        .register(
            &state.deployment.db().pool,
            &target_path,
            display_name.as_deref(),
        )
        .await?;
    Ok(repo)
}

#[tauri::command]
pub async fn add_repo_remote(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    name: String,
    url: String,
) -> Result<(), AppError> {
    let path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .add_remote(&path, name.trim(), url.trim())
        .map_err(|e| AppError::Internal(format!("git remote add failed: {e}")))
}

#[tauri::command]
pub async fn remove_repo_remote(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    name: String,
) -> Result<(), AppError> {
    let path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .remove_remote(&path, name.trim())
        .map_err(|e| AppError::Internal(format!("git remote remove failed: {e}")))
}

#[tauri::command]
pub async fn set_repo_remote_url(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    name: String,
    url: String,
) -> Result<(), AppError> {
    let path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .set_remote_url(&path, name.trim(), url.trim())
        .map_err(|e| AppError::Internal(format!("git remote set-url failed: {e}")))
}

#[tauri::command]
pub async fn init_repo_at_path(
    state: tauri::State<'_, AppState>,
    path: String,
    display_name: Option<String>,
) -> Result<Repo, AppError> {
    let repo = state
        .deployment
        .repo()
        .init_repo_at_path(
            &state.deployment.db().pool,
            state.deployment.git(),
            &path,
            display_name.as_deref(),
        )
        .await?;
    Ok(repo)
}

#[tauri::command]
pub async fn get_repos_batch(
    state: tauri::State<'_, AppState>,
    ids: Vec<Uuid>,
) -> Result<Vec<Repo>, AppError> {
    let repos = Repo::find_by_ids(&state.deployment.db().pool, &ids).await?;
    Ok(repos)
}

#[tauri::command]
pub async fn get_repo(state: tauri::State<'_, AppState>, repo_id: Uuid) -> Result<Repo, AppError> {
    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;
    Ok(repo)
}

#[tauri::command]
pub async fn update_repo(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    payload: UpdateRepo,
) -> Result<Repo, AppError> {
    let repo = Repo::update(&state.deployment.db().pool, repo_id, &payload).await?;
    Ok(repo)
}

#[tauri::command]
pub async fn get_repo_branches(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
) -> Result<Vec<GitBranch>, AppError> {
    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;
    let branches = state.deployment.git().get_all_branches(&repo.path)?;
    Ok(branches)
}

#[tauri::command]
pub async fn get_repo_remotes(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
) -> Result<Vec<GitRemote>, AppError> {
    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;
    let remotes = state.deployment.git().list_remotes(&repo.path)?;
    Ok(remotes)
}

#[tauri::command]
pub async fn list_open_prs(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    remote: Option<String>,
) -> Result<Vec<OpenPrInfo>, AppError> {
    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;

    let remote = match remote {
        Some(name) => GitRemote {
            url: state.deployment.git().get_remote_url(&repo.path, &name)?,
            name,
        },
        None => state.deployment.git().get_default_remote(&repo.path)?,
    };

    let git_host = GitHostService::from_url(&remote.url)?;
    match git_host.list_open_prs(&repo.path, &remote.url).await {
        Ok(prs) => Ok(prs),
        Err(err) => {
            let Some(spec) = parse_github_remote_spec(&remote.url) else {
                return Err(err.into());
            };

            tracing::warn!(
                "Falling back to GitHub REST API for open PRs after CLI error: {}",
                err
            );
            list_open_prs_via_github_api(&spec).await
        }
    }
}

#[tauri::command]
pub async fn list_repo_issues(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    issue_state: Option<String>,
    remote: Option<String>,
) -> Result<Vec<GitHubIssueInfo>, AppError> {
    use services::services::git_host::github::GhCli;

    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;

    let remote = match remote {
        Some(name) => GitRemote {
            url: state.deployment.git().get_remote_url(&repo.path, &name)?,
            name,
        },
        None => state.deployment.git().get_default_remote(&repo.path)?,
    };

    let repo_path = std::path::PathBuf::from(&repo.path);
    let remote_url = remote.url.clone();

    let state_filter = issue_state.unwrap_or_else(|| "open".to_string());
    let state_filter_for_cli = state_filter.clone();
    let gh_result = tokio::task::spawn_blocking(move || {
        let cli = GhCli::new();
        let repo_info = cli
            .get_repo_info(&remote_url, &repo_path)
            .map_err(|e| e.to_string())?;
        cli.list_issues(
            &repo_info.owner,
            &repo_info.repo_name,
            &state_filter_for_cli,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    match gh_result {
        Ok(issues) => Ok(issues),
        Err(err) => {
            let Some(spec) = parse_github_remote_spec(&remote.url) else {
                return Err(AppError::BadRequest(format!(
                    "Failed to load GitHub issues: {err}"
                )));
            };

            tracing::warn!(
                "Falling back to GitHub REST API for issues after CLI error: {}",
                err
            );
            list_issues_via_github_api(&spec, &state_filter).await
        }
    }
}

#[tauri::command]
pub async fn search_repo(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    q: String,
    mode: Option<SearchMode>,
) -> Result<Vec<SearchResult>, AppError> {
    if q.trim().is_empty() {
        return Err(AppError::BadRequest(
            "Query parameter 'q' is required and cannot be empty".to_string(),
        ));
    }

    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;

    let search_mode = mode.unwrap_or_default();

    state
        .deployment
        .file_search_cache()
        .search_repo(&repo.path, &q, search_mode)
        .await
        .map_err(|e| {
            tracing::error!("Failed to search files in repo {}: {}", repo_id, e);
            AppError::Internal(format!("Failed to search files: {}", e))
        })
}

#[tauri::command]
pub async fn open_repo_in_editor(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    payload: Option<OpenEditorRequest>,
) -> Result<OpenEditorResponse, AppError> {
    let repo = state
        .deployment
        .repo()
        .get_by_id(&state.deployment.db().pool, repo_id)
        .await?;

    let editor_config = {
        let config = state.deployment.config().read().await;
        let editor_type_str = payload.as_ref().and_then(|req| req.editor_type.as_deref());
        config.editor.with_override(editor_type_str)
    };

    match editor_config.open_file(&repo.path).await {
        Ok(url) => {
            tracing::info!(
                "Opened editor for repo {} at path: {}{}",
                repo_id,
                repo.path.to_string_lossy(),
                if url.is_some() { " (remote mode)" } else { "" }
            );
            Ok(OpenEditorResponse { url })
        }
        Err(e) => {
            tracing::error!("Failed to open editor for repo {}: {:?}", repo_id, e);
            Err(AppError::Internal(format!("Failed to open editor: {}", e)))
        }
    }
}

// ─── Repo-level Git operations ───────────────────────────────────────────────

#[tauri::command]
pub async fn get_repo_git_status(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
) -> Result<git::DetailedGitStatus, AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .get_detailed_status(&repo_path)
        .map_err(|e| AppError::Internal(format!("git status failed: {e}")))
}

#[tauri::command]
pub async fn get_repo_file_diffs(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
) -> Result<Vec<git::GitFileDiffEntry>, AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .get_file_diffs(&repo_path)
        .map_err(|e| AppError::Internal(format!("get file diffs failed: {e}")))
}

#[tauri::command]
pub async fn stage_repo_file(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    file_path: String,
) -> Result<(), AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .stage_file(&repo_path, &file_path)
        .map_err(|e| AppError::Internal(format!("stage file failed: {e}")))
}

#[tauri::command]
pub async fn unstage_repo_file(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    file_path: String,
) -> Result<(), AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .unstage_file(&repo_path, &file_path)
        .map_err(|e| AppError::Internal(format!("unstage file failed: {e}")))
}

#[tauri::command]
pub async fn revert_repo_file(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    file_path: String,
) -> Result<(), AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .revert_file(&repo_path, &file_path)
        .map_err(|e| AppError::Internal(format!("revert file failed: {e}")))
}

#[tauri::command]
pub async fn stage_repo_all(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
) -> Result<(), AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .stage_all(&repo_path)
        .map_err(|e| AppError::Internal(format!("stage all failed: {e}")))
}

#[tauri::command]
pub async fn revert_repo_all(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
) -> Result<(), AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .revert_all(&repo_path)
        .map_err(|e| AppError::Internal(format!("revert all failed: {e}")))
}

#[tauri::command]
pub async fn commit_repo_changes(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    message: String,
) -> Result<(), AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .commit_changes(&repo_path, &message)
        .map_err(|e| AppError::Internal(format!("commit failed: {e}")))
}

#[tauri::command]
pub async fn push_repo(state: tauri::State<'_, AppState>, repo_id: Uuid) -> Result<(), AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    let git = state.deployment.git();
    let head = git
        .get_head_info(&repo_path)
        .map_err(|e| AppError::Internal(format!("get head info failed: {e}")))?;
    git.push_to_remote(&repo_path, &head.branch, false)
        .map_err(|e| AppError::Internal(format!("git push failed: {e}")))
}

#[tauri::command]
pub async fn pull_repo(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
) -> Result<git::PullResult, AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .pull(&repo_path)
        .map_err(|e| AppError::Internal(format!("git pull failed: {e}")))
}

#[tauri::command]
pub async fn fetch_repo(state: tauri::State<'_, AppState>, repo_id: Uuid) -> Result<(), AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .fetch_all(&repo_path)
        .map_err(|e| AppError::Internal(format!("git fetch failed: {e}")))
}

#[tauri::command]
pub async fn get_repo_git_log(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
) -> Result<git::GitLogStatus, AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .get_log_status(&repo_path)
        .map_err(|e| AppError::Internal(format!("git log failed: {e}")))
}

#[tauri::command]
pub async fn get_repo_commit_detail(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    sha: String,
) -> Result<git::CommitDetail, AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .get_commit_detail(&repo_path, &sha)
        .map_err(|e| AppError::Internal(format!("get commit detail failed: {e}")))
}

#[tauri::command]
pub async fn get_repo_commit_diffs(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    sha: String,
) -> Result<Vec<utils::diff::Diff>, AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .get_diffs(
            git::DiffTarget::Commit {
                repo_path: &repo_path,
                commit_sha: &sha,
            },
            None,
        )
        .map_err(|e| AppError::Internal(format!("get commit diffs failed: {e}")))
}

#[tauri::command]
pub async fn checkout_repo_branch(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    branch_name: String,
) -> Result<(), AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .checkout_branch(&repo_path, &branch_name)
        .map_err(|e| AppError::Internal(format!("git checkout failed: {e}")))
}

#[tauri::command]
pub async fn create_repo_branch(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    branch_name: String,
    from_ref: Option<String>,
) -> Result<(), AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .create_branch(&repo_path, &branch_name, from_ref.as_deref())
        .map_err(|e| AppError::Internal(format!("git create branch failed: {e}")))
}

#[tauri::command]
pub async fn delete_repo_branch(
    state: tauri::State<'_, AppState>,
    repo_id: Uuid,
    branch_name: String,
) -> Result<(), AppError> {
    let repo_path = resolve_repo_path(&state, repo_id).await?;
    state
        .deployment
        .git()
        .delete_branch(&repo_path, &branch_name)
        .map_err(|e| AppError::Internal(format!("git delete branch failed: {e}")))
}
