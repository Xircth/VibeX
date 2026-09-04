//! Incremental protocol-usage read model (ADR-0075).
//!
//! Folded from `conversation_events.event_kind = "usage_updated"` so the
//! dashboard never replays the full event log. Token fields stay missing when
//! the Agent did not provide a breakdown. `context_used` is occupancy and is
//! never written into token totals.

use agents::conversation::{ConversationEvent, ConversationUsage};
use db::models::conversation_usage::{ConversationUsageSnapshotRecord, StaleUsageEventRow};
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;

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
}
