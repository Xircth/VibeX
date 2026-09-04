//! Tauri command + AppState/DB coordination for local usage statistics.
//!
//! Attribution comes from `sessions` × `workspaces` × the usage snapshot
//! (ADR-0075). Vendor logs are optional token-breakdown supplements aligned by
//! `external_session_id`.

use std::time::{SystemTime, UNIX_EPOCH};

use conversations::catch_up_usage_snapshots;
use db::models::{conversation_usage::ConversationUsageSnapshotRecord, project::Project};
pub use services::services::usage::{
    ProjectUsageAgentUsage, ProjectUsageDailyUsage, ProjectUsageFolderUsage,
    ProjectUsageModelUsage, ProjectUsageProviderStatus, ProjectUsageSessionSummary,
    ProjectUsageSourcedTokens, ProjectUsageStatistics, ProjectUsageTokenCounts, ProjectUsageTrends,
    ProjectUsageUsageData, ProjectUsageWeekData, ProjectUsageWeeklyComparison,
};
use services::services::usage::{
    VendorLogUsage, align_vendor_usage, build_project_usage_statistics, scan_claude_sessions,
    scan_codex_sessions,
};
use uuid::Uuid;

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
    project_uuid: Option<Uuid>,
    project_name: String,
}

fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn datetime_to_ms(value: chrono::DateTime<chrono::Utc>) -> i64 {
    value.timestamp_millis()
}

async fn scan_vendor_logs(
    state: &tauri::State<'_, AppState>,
    now_ms: i64,
) -> (Vec<VendorLogUsage>, Vec<ProjectUsageProviderStatus>) {
    {
        let cache = state.local_usage_cache.lock().await;
        if let Some(entry) = cache.get("vendor")
            && now_ms - entry.scanned_at_ms <= LOCAL_USAGE_SCAN_CACHE_TTL_MS
        {
            return (entry.vendor_sessions.clone(), entry.provider_status.clone());
        }
    }

    let mut all_sessions = Vec::new();
    let mut provider_status = Vec::new();

    match scan_claude_sessions() {
        Ok(sessions) => {
            provider_status.push(ProjectUsageProviderStatus {
                provider: "claude".to_string(),
                success: true,
                error: None,
                sessions_scanned: sessions.len() as i64,
            });
            all_sessions.extend(sessions);
        }
        Err(error) => {
            provider_status.push(ProjectUsageProviderStatus {
                provider: "claude".to_string(),
                success: false,
                error: Some(error),
                sessions_scanned: 0,
            });
        }
    }

    match scan_codex_sessions() {
        Ok(sessions) => {
            provider_status.push(ProjectUsageProviderStatus {
                provider: "codex".to_string(),
                success: true,
                error: None,
                sessions_scanned: sessions.len() as i64,
            });
            all_sessions.extend(sessions);
        }
        Err(error) => {
            provider_status.push(ProjectUsageProviderStatus {
                provider: "codex".to_string(),
                success: false,
                error: Some(error),
                sessions_scanned: 0,
            });
        }
    }

    let mut cache = state.local_usage_cache.lock().await;
    cache.insert(
        "vendor".to_string(),
        crate::state::LocalUsageCacheEntry {
            vendor_sessions: all_sessions.clone(),
            provider_status: provider_status.clone(),
            scanned_at_ms: now_ms,
        },
    );

    (all_sessions, provider_status)
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

fn attributed_sessions_from_rows(
    rows: Vec<db::models::conversation_usage::ConversationUsageAttributionRow>,
    cutoff_time: i64,
) -> Vec<ProjectUsageSessionSummary> {
    rows.into_iter()
        .filter(|row| cutoff_time <= 0 || datetime_to_ms(row.session_updated_at) >= cutoff_time)
        .map(|row| {
            let protocol = match (
                row.protocol_input_tokens,
                row.protocol_output_tokens,
                row.protocol_cache_write_tokens,
                row.protocol_cache_read_tokens,
                row.protocol_total_tokens,
            ) {
                (None, None, None, None, None) => None,
                (input, output, cache_write, cache_read, total) => Some(ProjectUsageTokenCounts {
                    input_tokens: input,
                    output_tokens: output,
                    cache_write_tokens: cache_write,
                    cache_read_tokens: cache_read,
                    total_tokens: total,
                }),
            };
            let timestamp = row
                .last_usage_at
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.timestamp_millis())
                .unwrap_or_else(|| datetime_to_ms(row.session_updated_at));
            ProjectUsageSessionSummary {
                session_id: row.session_id.to_string(),
                workspace_id: row.workspace_id.to_string(),
                folder: row.container_ref,
                agent_id: row.agent_id,
                timestamp,
                model: row.snapshot_model.or(row.model),
                tokens: ProjectUsageSourcedTokens {
                    protocol,
                    vendor_log: None,
                    sources_disagree: false,
                },
                context_used: row.context_used,
                context_window_max: row.context_window_max,
                cost: row.protocol_cost_amount,
                summary: row.session_name,
                external_session_id: row.external_session_id,
            }
        })
        .collect()
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
    catch_up_usage_snapshots(pool)
        .await
        .map_err(|error| error.to_string())?;

    let rows = ConversationUsageSnapshotRecord::list_attributed(pool, scope_ctx.project_uuid)
        .await
        .map_err(|error| error.to_string())?;
    let mut sessions = attributed_sessions_from_rows(rows, cutoff_time);
    let (vendor_logs, provider_status) = scan_vendor_logs(&state, now_ms).await;
    let unattributed_vendor_sessions = align_vendor_usage(&mut sessions, &vendor_logs);
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    Ok(build_project_usage_statistics(
        match scope_ctx.scope {
            UsageScope::Global => "global".to_string(),
            UsageScope::Project => "project".to_string(),
        },
        scope_ctx.project_id,
        scope_ctx.project_name,
        sessions,
        provider_status,
        unattributed_vendor_sessions,
        now_ms,
    ))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use db::models::conversation_usage::ConversationUsageAttributionRow;

    use super::*;

    #[test]
    fn attributed_rows_keep_missing_tokens_and_workspace_identity() {
        let row = ConversationUsageAttributionRow {
            session_id: Uuid::nil(),
            workspace_id: Uuid::from_u128(2),
            project_id: Uuid::from_u128(3),
            container_ref: Some("/repo/.worktrees/feature".to_string()),
            agent_id: Some("kimi".to_string()),
            model: None,
            external_session_id: Some("acp-1".to_string()),
            session_name: Some("Ask".to_string()),
            session_created_at: Utc::now(),
            session_updated_at: Utc::now(),
            protocol_input_tokens: None,
            protocol_output_tokens: None,
            protocol_cache_write_tokens: None,
            protocol_cache_read_tokens: None,
            protocol_total_tokens: None,
            context_used: Some(12_000),
            context_window_max: Some(200_000),
            protocol_cost_amount: None,
            protocol_cost_currency: None,
            snapshot_model: None,
            last_usage_at: None,
        };

        let sessions = attributed_sessions_from_rows(vec![row], 0);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].workspace_id, Uuid::from_u128(2).to_string());
        assert_eq!(sessions[0].tokens.protocol, None);
        assert_eq!(sessions[0].context_used, Some(12_000));
        assert_eq!(sessions[0].cost, None);
    }
}
