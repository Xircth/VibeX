//! Incremental protocol-usage read model (ADR-0075).
//!
//! Folded from `conversation_events.event_kind = "usage_updated"` so the
//! dashboard never replays the full event log. Token fields stay missing when
//! the Agent did not provide a breakdown. `context_used` is occupancy and is
//! never written into token totals.

use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};

use agents::conversation::{ConversationEvent, ConversationUsage};
use db::models::{
    conversation_usage::{
        ConversationUsageAttributionRow, ConversationUsageSnapshotRecord, StaleUsageEventRow,
    },
    vendor_usage::{
        VendorUsageFileRecord, VendorUsageFileUpdate, VendorUsageSessionRecord,
        apply_vendor_usage_scan,
    },
};
use services::services::usage::{
    ProjectUsageProviderStatus, ProjectUsageSessionSummary, ProjectUsageSourcedTokens,
    ProjectUsageStatistics, ProjectUsageTokenCounts, VendorLogRoots, VendorLogUsage,
    align_vendor_usage, build_project_usage_statistics, scan_changed_vendor_logs,
};
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;

static VENDOR_SYNC: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn apply_usage_updated(
    conn: &mut SqliteConnection,
    conversation_id: Uuid,
    sequence: i64,
    usage: &ConversationUsage,
    occurred_at: chrono::DateTime<chrono::Utc>,
) -> Result<(), sqlx::Error> {
    let existing = ConversationUsageSnapshotRecord::find(&mut *conn, conversation_id).await?;
    if existing
        .as_ref()
        .is_some_and(|row| sequence <= row.last_sequence)
    {
        return Ok(());
    }

    let next = merge_usage_snapshot(existing, conversation_id, sequence, usage, occurred_at);
    ConversationUsageSnapshotRecord::upsert(conn, &next).await
}

pub async fn catch_up_usage_snapshots(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let pending = StaleUsageEventRow::list_pending(pool).await?;
    if pending.is_empty() {
        return Ok(());
    }

    let mut conn = pool.acquire().await?;
    for row in pending {
        let Some(usage) = usage_from_normalized_json(&row.normalized_json) else {
            continue;
        };
        apply_usage_updated(
            &mut conn,
            row.conversation_id,
            row.sequence,
            &usage,
            row.created_at,
        )
        .await?;
    }
    Ok(())
}

fn usage_from_normalized_json(normalized_json: &str) -> Option<ConversationUsage> {
    let event: ConversationEvent = serde_json::from_str(normalized_json).ok()?;
    match event {
        ConversationEvent::UsageUpdated { usage } => Some(usage),
        _ => None,
    }
}

fn merge_usage_snapshot(
    existing: Option<ConversationUsageSnapshotRecord>,
    conversation_id: Uuid,
    sequence: i64,
    usage: &ConversationUsage,
    occurred_at: chrono::DateTime<chrono::Utc>,
) -> ConversationUsageSnapshotRecord {
    let tokens_provided = usage.input_tokens > 0
        || usage.output_tokens > 0
        || usage.cache_creation_input_tokens > 0
        || usage.cache_read_input_tokens > 0;

    let (input, output, cache_write, cache_read, total) = if tokens_provided {
        let input = i64::try_from(usage.input_tokens).unwrap_or(i64::MAX);
        let output = i64::try_from(usage.output_tokens).unwrap_or(i64::MAX);
        let cache_write = i64::try_from(usage.cache_creation_input_tokens).unwrap_or(i64::MAX);
        let cache_read = i64::try_from(usage.cache_read_input_tokens).unwrap_or(i64::MAX);
        (
            Some(input),
            Some(output),
            Some(cache_write),
            Some(cache_read),
            Some(
                input
                    .saturating_add(output)
                    .saturating_add(cache_write)
                    .saturating_add(cache_read),
            ),
        )
    } else {
        (
            existing.as_ref().and_then(|row| row.protocol_input_tokens),
            existing.as_ref().and_then(|row| row.protocol_output_tokens),
            existing
                .as_ref()
                .and_then(|row| row.protocol_cache_write_tokens),
            existing
                .as_ref()
                .and_then(|row| row.protocol_cache_read_tokens),
            existing.as_ref().and_then(|row| row.protocol_total_tokens),
        )
    };

    ConversationUsageSnapshotRecord {
        conversation_id,
        last_sequence: sequence,
        protocol_input_tokens: input,
        protocol_output_tokens: output,
        protocol_cache_write_tokens: cache_write,
        protocol_cache_read_tokens: cache_read,
        protocol_total_tokens: total,
        context_used: usage
            .context_used
            .filter(|used| *used > 0)
            .and_then(|used| i64::try_from(used).ok())
            .or_else(|| existing.as_ref().and_then(|row| row.context_used)),
        context_window_max: usage
            .context_window_max
            .filter(|limit| *limit > 0)
            .and_then(|limit| i64::try_from(limit).ok())
            .or_else(|| existing.as_ref().and_then(|row| row.context_window_max)),
        protocol_cost_amount: usage
            .cost_amount
            .or_else(|| existing.as_ref().and_then(|row| row.protocol_cost_amount)),
        protocol_cost_currency: usage.cost_currency.clone().or_else(|| {
            existing
                .as_ref()
                .and_then(|row| row.protocol_cost_currency.clone())
        }),
        model: existing.as_ref().and_then(|row| row.model.clone()),
        last_usage_at: Some(occurred_at.to_rfc3339()),
    }
}

fn datetime_to_ms(value: chrono::DateTime<chrono::Utc>) -> i64 {
    value.timestamp_millis()
}

pub fn attributed_sessions_from_rows(
    rows: Vec<ConversationUsageAttributionRow>,
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

pub async fn assemble_project_usage_statistics(
    pool: &SqlitePool,
    scope: String,
    project_id: String,
    project_name: String,
    project_uuid: Option<Uuid>,
    cutoff_time: i64,
    now_ms: i64,
) -> Result<ProjectUsageStatistics, sqlx::Error> {
    catch_up_usage_snapshots(pool).await?;
    let provider_status = sync_vendor_usage_logs(pool).await?;
    let vendor_logs = load_vendor_usage_logs(pool).await?;
    let rows = ConversationUsageSnapshotRecord::list_attributed(pool, project_uuid).await?;
    let mut sessions = attributed_sessions_from_rows(rows, cutoff_time);
    let unattributed_vendor_sessions = align_vendor_usage(&mut sessions, &vendor_logs);
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(build_project_usage_statistics(
        scope,
        project_id,
        project_name,
        sessions,
        provider_status,
        unattributed_vendor_sessions,
        now_ms,
    ))
}

pub async fn sync_vendor_usage_logs(
    pool: &SqlitePool,
) -> Result<Vec<ProjectUsageProviderStatus>, sqlx::Error> {
    sync_vendor_usage_logs_with_roots(pool, VendorLogRoots::local()).await
}

pub async fn sync_vendor_usage_logs_with_roots(
    pool: &SqlitePool,
    roots: VendorLogRoots,
) -> Result<Vec<ProjectUsageProviderStatus>, sqlx::Error> {
    let _guard = VENDOR_SYNC.lock().await;
    let known = VendorUsageFileRecord::list(pool).await?;
    let known_map: HashMap<String, (i64, i64)> = known
        .into_iter()
        .map(|row| (row.path, (row.mtime_ms, row.size)))
        .collect();
    let scan = tokio::task::spawn_blocking(move || scan_changed_vendor_logs(&roots, &known_map))
        .await
        .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let updates: Vec<VendorUsageFileUpdate> = scan
        .updates
        .into_iter()
        .map(|update| VendorUsageFileUpdate {
            path: update.path,
            provider: update.provider,
            mtime_ms: update.mtime_ms,
            size: update.size,
            session: update.session.map(|session| VendorUsageSessionRecord {
                provider: session.provider,
                external_session_id: session.external_session_id,
                source_path: String::new(),
                timestamp: session.timestamp,
                model: (!session.model.is_empty()).then_some(session.model),
                input_tokens: session.tokens.input_tokens,
                output_tokens: session.tokens.output_tokens,
                cache_write_tokens: session.tokens.cache_write_tokens,
                cache_read_tokens: session.tokens.cache_read_tokens,
                total_tokens: session.tokens.total_tokens,
                cost: session.cost,
                summary: session.summary,
                scanned_at_ms: now_ms,
            }),
        })
        .collect();
    apply_vendor_usage_scan(
        pool,
        &updates,
        &scan.live_paths,
        &scan.successful_providers,
        now_ms,
    )
    .await?;

    let counts: HashMap<String, i64> = VendorUsageSessionRecord::count_by_provider(pool)
        .await?
        .into_iter()
        .collect();
    let mut provider_status = scan.provider_status;
    for status in &mut provider_status {
        if status.success {
            status.sessions_scanned = counts.get(&status.provider).copied().unwrap_or(0);
        }
    }
    Ok(provider_status)
}

async fn load_vendor_usage_logs(pool: &SqlitePool) -> Result<Vec<VendorLogUsage>, sqlx::Error> {
    Ok(VendorUsageSessionRecord::list_all(pool)
        .await?
        .into_iter()
        .map(|row| VendorLogUsage {
            external_session_id: row.external_session_id,
            timestamp: row.timestamp,
            model: row.model.unwrap_or_default(),
            tokens: ProjectUsageTokenCounts {
                input_tokens: row.input_tokens,
                output_tokens: row.output_tokens,
                cache_write_tokens: row.cache_write_tokens,
                cache_read_tokens: row.cache_read_tokens,
                total_tokens: row.total_tokens,
            },
            cost: row.cost,
            summary: row.summary,
            provider: row.provider,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use agents::conversation::ConversationUsage;
    use chrono::Utc;

    use super::*;

    fn usage(
        input: u64,
        output: u64,
        cache_write: u64,
        cache_read: u64,
        context_used: Option<u64>,
    ) -> ConversationUsage {
        ConversationUsage {
            input_tokens: input,
            output_tokens: output,
            cache_creation_input_tokens: cache_write,
            cache_read_input_tokens: cache_read,
            context_used,
            context_window_max: Some(200_000),
            cost_amount: None,
            cost_currency: None,
        }
    }

    #[test]
    fn occupancy_only_update_leaves_tokens_missing() {
        let next = merge_usage_snapshot(
            None,
            Uuid::nil(),
            4,
            &usage(0, 0, 0, 0, Some(12_000)),
            Utc::now(),
        );

        assert_eq!(next.protocol_input_tokens, None);
        assert_eq!(next.protocol_total_tokens, None);
        assert_eq!(next.context_used, Some(12_000));
        assert_eq!(next.context_window_max, Some(200_000));
    }

    #[test]
    fn token_totals_never_include_context_used() {
        let next = merge_usage_snapshot(
            None,
            Uuid::nil(),
            8,
            &usage(10, 6, 2, 4, Some(99_000)),
            Utc::now(),
        );

        assert_eq!(next.protocol_total_tokens, Some(22));
        assert_eq!(next.context_used, Some(99_000));
        assert_ne!(next.protocol_total_tokens, next.context_used);
    }

    #[test]
    fn later_occupancy_keeps_previously_provided_tokens() {
        let first =
            merge_usage_snapshot(None, Uuid::nil(), 1, &usage(20, 10, 0, 0, None), Utc::now());
        let next = merge_usage_snapshot(
            Some(first),
            Uuid::nil(),
            2,
            &usage(0, 0, 0, 0, Some(8_000)),
            Utc::now(),
        );

        assert_eq!(next.protocol_input_tokens, Some(20));
        assert_eq!(next.protocol_output_tokens, Some(10));
        assert_eq!(next.protocol_total_tokens, Some(30));
        assert_eq!(next.context_used, Some(8_000));
    }

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

#[cfg(test)]
mod vendor_sync_tests {
    use std::str::FromStr;

    use db::models::vendor_usage::VendorUsageSessionRecord;
    use sqlx::{
        SqlitePool,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };

    use super::*;

    async fn pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn vendor_sync_persists_sessions_and_skips_unchanged_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
        let path = sessions_dir.join("rollout.jsonl");
        std::fs::write(
            &path,
            r#"{"timestamp":"2026-08-31T14:23:27Z","type":"session_meta","payload":{"session_id":"persist-1"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}}}
"#,
        )
        .expect("write");

        let pool = pool().await;
        let roots = VendorLogRoots {
            claude_projects: None,
            codex_sessions: Some(sessions_dir),
        };
        let first = sync_vendor_usage_logs_with_roots(&pool, roots.clone())
            .await
            .expect("sync");
        let stored = VendorUsageSessionRecord::list_all(&pool)
            .await
            .expect("list");
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].external_session_id, "persist-1");
        assert_eq!(stored[0].total_tokens, Some(15));
        assert_eq!(
            first
                .iter()
                .find(|status| status.provider == "codex")
                .map(|status| status.sessions_scanned),
            Some(1)
        );

        let second = sync_vendor_usage_logs_with_roots(&pool, roots)
            .await
            .expect("second sync");
        assert_eq!(
            VendorUsageSessionRecord::list_all(&pool)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            second
                .iter()
                .find(|status| status.provider == "codex")
                .map(|status| status.sessions_scanned),
            Some(1)
        );
    }
}
