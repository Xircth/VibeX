//! Tauri command + AppState/DB coordination for local usage statistics.
//!
//! Attribution comes from `sessions` × `workspaces` × the usage snapshot
//! (ADR-0075). Vendor logs are optional token-breakdown supplements aligned by
//! `external_session_id`.

use std::time::{SystemTime, UNIX_EPOCH};

use conversations::assemble_project_usage_statistics;
use db::models::project::Project;
pub use services::services::usage::{
    ProjectUsageAgentUsage, ProjectUsageDailyUsage, ProjectUsageFolderUsage,
    ProjectUsageModelUsage, ProjectUsageProviderStatus, ProjectUsageSessionSummary,
    ProjectUsageSourcedTokens, ProjectUsageStatistics, ProjectUsageTokenCounts, ProjectUsageTrends,
    ProjectUsageUsageData, ProjectUsageWeekData, ProjectUsageWeeklyComparison,
};
use uuid::Uuid;

use crate::state::AppState;

#[derive(Clone, Copy, PartialEq, Eq)]
enum UsageScope {
    Global,
    Project,
}

struct UsageScopeContext {
    scope: UsageScope,
    project_id: String,
    project_uuid: Option<Uuid>,
    project_name: String,
}

fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
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
            project_uuid: None,
            project_name: "全局".to_string(),
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

    Ok(UsageScopeContext {
        scope,
        project_id: raw_project_id,
        project_uuid: Some(project_uuid),
        project_name: project.name,
    })
}

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

    let pool = &state.deployment.db().pool;
    assemble_project_usage_statistics(
        pool,
        match scope_ctx.scope {
            UsageScope::Global => "global".to_string(),
            UsageScope::Project => "project".to_string(),
        },
        scope_ctx.project_id,
        scope_ctx.project_name,
        scope_ctx.project_uuid,
        cutoff_time,
        now_ms,
    )
    .await
    .map_err(|error| error.to_string())
}
