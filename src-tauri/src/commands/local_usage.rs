//! Tauri command + AppState/DB coordination for local usage statistics.
//!
//! The pure scanning / cost / aggregation logic and the `ProjectUsage*` output types
//! were sunk into `services::services::usage` (架构报告 A-1). This module keeps the
//! command plus the parts that need AppState (the scan cache) or the DB (scope
//! resolution), and re-exports the output types so existing imports keep resolving.

use std::{
    collections::HashSet,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use db::models::{project::Project, project_repo::ProjectRepo, workspace::Workspace};
use uuid::Uuid;

use services::services::usage::{
    build_project_usage_statistics, scan_claude_sessions, scan_codex_sessions,
};
// Re-export the output types so `crate::commands::local_usage::ProjectUsage*` (used by
// state.rs) and any frontend-facing reference keep resolving from here.
pub use services::services::usage::{
    ProjectUsageDailyUsage, ProjectUsageModelUsage, ProjectUsageProviderStatus,
    ProjectUsageSessionSummary, ProjectUsageStatistics, ProjectUsageTrends, ProjectUsageUsageData,
    ProjectUsageWeekData, ProjectUsageWeeklyComparison,
};

use crate::state::AppState;

const LOCAL_USAGE_SCAN_CACHE_TTL_MS: i64 = 2 * 60_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum UsageScope {
    Global,
    Project,
}

struct UsageScopeContext {
    scope: UsageScope,
    project_id: String,
    project_name: String,
    workspace_paths: Vec<PathBuf>,
}

fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn build_usage_cache_key(scope_ctx: &UsageScopeContext) -> String {
    match scope_ctx.scope {
        UsageScope::Global => "global".to_string(),
        UsageScope::Project => format!("project:{}", scope_ctx.project_id),
    }
}

fn filter_sessions_by_cutoff(
    sessions: &[ProjectUsageSessionSummary],
    cutoff_time: i64,
) -> Vec<ProjectUsageSessionSummary> {
    let mut filtered = if cutoff_time > 0 {
        sessions
            .iter()
            .filter(|session| session.timestamp >= cutoff_time)
            .cloned()
            .collect::<Vec<_>>()
    } else {
        sessions.to_vec()
    };

    filtered.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    filtered
}

async fn scan_usage_sessions(
    state: &tauri::State<'_, AppState>,
    scope_ctx: &UsageScopeContext,
    now_ms: i64,
) -> (
    Vec<ProjectUsageSessionSummary>,
    Vec<ProjectUsageProviderStatus>,
) {
    let cache_key = build_usage_cache_key(scope_ctx);
    {
        let cache = state.local_usage_cache.lock().await;
        if let Some(entry) = cache.get(&cache_key)
            && now_ms - entry.scanned_at_ms <= LOCAL_USAGE_SCAN_CACHE_TTL_MS
        {
            return (entry.sessions.clone(), entry.provider_status.clone());
        }
    }

    let mut all_sessions = Vec::new();
    let mut provider_status = Vec::new();

    let claude_result = scan_claude_sessions(&scope_ctx.workspace_paths);
    match claude_result {
        Ok(sessions) => {
            provider_status.push(ProjectUsageProviderStatus {
                provider: "claude".to_string(),
                success: true,
                error: None,
                sessions_scanned: sessions.len() as i64,
            });
            all_sessions.extend(sessions);
        }
        Err(e) => {
            provider_status.push(ProjectUsageProviderStatus {
                provider: "claude".to_string(),
                success: false,
                error: Some(e),
                sessions_scanned: 0,
            });
        }
    }

    let codex_result = scan_codex_sessions(&scope_ctx.workspace_paths);
    match codex_result {
        Ok(sessions) => {
            provider_status.push(ProjectUsageProviderStatus {
                provider: "codex".to_string(),
                success: true,
                error: None,
                sessions_scanned: sessions.len() as i64,
            });
            all_sessions.extend(sessions);
        }
        Err(e) => {
            provider_status.push(ProjectUsageProviderStatus {
                provider: "codex".to_string(),
                success: false,
                error: Some(e),
                sessions_scanned: 0,
            });
        }
    }

    let mut cache = state.local_usage_cache.lock().await;
    cache.insert(
        cache_key,
        crate::state::LocalUsageCacheEntry {
            sessions: all_sessions.clone(),
            provider_status: provider_status.clone(),
            scanned_at_ms: now_ms,
        },
    );

    (all_sessions, provider_status)
}

fn collect_project_scope_paths(repo_paths: &[PathBuf], workspaces: &[Workspace]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    for path in repo_paths {
        if !path.as_os_str().is_empty() && seen.insert(path.clone()) {
            paths.push(path.clone());
        }
    }

    for workspace in workspaces {
        let Some(container_ref) = workspace.container_ref.as_deref() else {
            continue;
        };
        let path = PathBuf::from(container_ref);
        if !path.as_os_str().is_empty() && seen.insert(path.clone()) {
            paths.push(path);
        }
    }

    paths
}

async fn resolve_usage_scope(
    state: &tauri::State<'_, AppState>,
    scope: Option<String>,
    project_id: Option<String>,
) -> Result<UsageScopeContext, String> {
    let scope = match scope.as_deref() {
        Some("project") => UsageScope::Project,
        Some("global") | None => UsageScope::Global,
        Some(other) => return Err(format!("Unsupported usage scope: {other}")),
    };

    if scope == UsageScope::Global {
        return Ok(UsageScopeContext {
            scope,
            project_id: "global".to_string(),
            project_name: "全局".to_string(),
            workspace_paths: Vec::new(),
        });
    }

    let raw_project_id =
        project_id.ok_or_else(|| "Project scope requires projectId".to_string())?;
    let project_uuid = Uuid::parse_str(&raw_project_id)
        .map_err(|_| format!("Invalid project id: {raw_project_id}"))?;
    let pool = &state.deployment.db().pool;
    let project = Project::find_by_id(pool, project_uuid)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Project {raw_project_id} not found"))?;
    let repos = ProjectRepo::find_repos_for_project(pool, project_uuid)
        .await
        .map_err(|error| error.to_string())?;
    let workspaces = Workspace::fetch_by_project_id(pool, project_uuid)
        .await
        .map_err(|error| error.to_string())?;
    let repo_paths: Vec<PathBuf> = repos.iter().map(|repo| repo.path.clone()).collect();

    Ok(UsageScopeContext {
        scope,
        project_id: raw_project_id,
        project_name: project.name,
        workspace_paths: collect_project_scope_paths(&repo_paths, &workspaces),
    })
}

// ============= Tauri Command =============

#[tauri::command]
pub async fn get_project_usage_statistics(
    state: tauri::State<'_, AppState>,
    scope: Option<String>,
    project_id: Option<String>,
    date_range: Option<String>,
) -> Result<ProjectUsageStatistics, String> {
    let date_range = date_range.unwrap_or_else(|| "7d".to_string());
    let scope_ctx = resolve_usage_scope(&state, scope, project_id).await?;
    let now_ms = current_time_ms();

    let cutoff_time = match date_range.as_str() {
        "7d" => now_ms - 7 * 24 * 60 * 60 * 1000,
        "30d" => now_ms - 30 * 24 * 60 * 60 * 1000,
        _ => 0,
    };
    let (all_sessions, provider_status) = scan_usage_sessions(&state, &scope_ctx, now_ms).await;
    let filtered_sessions = filter_sessions_by_cutoff(&all_sessions, cutoff_time);

    Ok(build_project_usage_statistics(
        match scope_ctx.scope {
            UsageScope::Global => "global".to_string(),
            UsageScope::Project => "project".to_string(),
        },
        scope_ctx.project_id,
        scope_ctx.project_name,
        filtered_sessions,
        provider_status,
        now_ms,
    ))
}

// ============= Tests =============

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    fn fake_session(
        session_id: &str,
        model: &str,
        tokens: i64,
        cost: f64,
        timestamp: i64,
    ) -> ProjectUsageSessionSummary {
        ProjectUsageSessionSummary {
            session_id: session_id.to_string(),
            timestamp,
            model: model.to_string(),
            usage: ProjectUsageUsageData {
                input_tokens: tokens / 2,
                output_tokens: tokens / 2,
                cache_write_tokens: 0,
                cache_read_tokens: 0,
                total_tokens: tokens,
            },
            cost,
            summary: None,
            provider: "test".to_string(),
        }
    }

    #[test]
    fn project_scope_paths_include_repos_and_workspaces_without_duplicates() {
        let repo_root = PathBuf::from("C:/repo");
        let workspace_root = PathBuf::from("C:/repo/.worktrees/feature-a");
        let workspaces = vec![
            Workspace {
                id: Uuid::nil(),
                project_id: Uuid::nil(),
                task_id: Uuid::nil(),
                parent_workspace_id: None,
                container_ref: Some(repo_root.to_string_lossy().to_string()),
                branch: "main".to_string(),
                use_worktree: false,
                agent_working_dir: None,
                setup_completed_at: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                archived: false,
                pinned: false,
                name: None,
            },
            Workspace {
                id: Uuid::nil(),
                project_id: Uuid::nil(),
                task_id: Uuid::nil(),
                parent_workspace_id: None,
                container_ref: Some(workspace_root.to_string_lossy().to_string()),
                branch: "feature-a".to_string(),
                use_worktree: true,
                agent_working_dir: None,
                setup_completed_at: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                archived: false,
                pinned: false,
                name: None,
            },
        ];

        let paths =
            collect_project_scope_paths(&[repo_root.clone(), repo_root.clone()], &workspaces);

        assert_eq!(paths, vec![repo_root, workspace_root]);
    }

    #[test]
    fn filter_sessions_by_cutoff_keeps_recent_entries_sorted_descending() {
        let filtered = filter_sessions_by_cutoff(
            &[
                fake_session("old", "gpt-5.4", 100, 1.0, 100),
                fake_session("newest", "gpt-5.4", 100, 1.0, 500),
                fake_session("mid", "gpt-5.4", 100, 1.0, 300),
            ],
            250,
        );

        let ids = filtered
            .iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["newest", "mid"]);
    }
}
