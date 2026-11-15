//! SQLite persistence and atomic queue operations for the Pulse event engine.

#[path = "pulse_rows.rs"]
mod pulse_rows;

use std::sync::LazyLock;

use api_types::pulse::{
    ApprovalOptionSpec, BotConversationScope, BotMailboxPolicy, EventEnvelope, EventSourceKind,
    MandateOrigin, PulseEvalMode, PulseEventSchemaView, PulseObservedCandidateView, PulseRuleSpec,
    PulseRuleView, PulseSourceView, PulseSubscriptionView, PulseUserInteractionView,
    UserInteractionKind, UserInteractionSeverity,
};
use pulse_rows::*;
use sqlx::SqlitePool;

const PULSE_MIGRATION_SQL: &str =
    include_str!("../../migrations/20261116000000_pulse_event_engine.sql");

static PULSE_SCHEMA_DDL_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

static PULSE_OUTBOX_WAKE: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);

/// Shared wakeup handle notified whenever a new row is inserted into `pulse_outbox`.
pub fn pulse_outbox_wake() -> &'static tokio::sync::Notify {
    &PULSE_OUTBOX_WAKE
}

/// Wakes any background outbox delivery worker waiting on `pulse_outbox_wake()`.
pub fn notify_pulse_outbox() {
    PULSE_OUTBOX_WAKE.notify_waiters();
}

/// Applies the Pulse SQLite schema once per database, avoiding repeated multi-statement DDL locks.
pub async fn ensure_pulse_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let initialized: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pulse_event_schemas' LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    if initialized.is_some() {
        return Ok(());
    }
    let _guard = PULSE_SCHEMA_DDL_LOCK.lock().await;
    let recheck: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pulse_event_schemas' LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    if recheck.is_none() {
        sqlx::raw_sql(PULSE_MIGRATION_SQL).execute(pool).await?;
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct SqlitePulseStore {
    pool: SqlitePool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PulseSourceRecord {
    pub view: PulseSourceView,
    pub config_json: serde_json::Value,
    pub signing_secret: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct PulseSourceUpsert {
    pub id: String,
    pub kind: EventSourceKind,
    pub title: String,
    pub enabled: bool,
    pub healthy: bool,
    pub status_message: Option<String>,
    pub cursor_watermark: Option<String>,
    pub public_webhook_path: Option<String>,
    pub config_json: serde_json::Value,
    pub signing_secret: Option<String>,
    pub now: String,
}

#[derive(Clone, Debug)]
pub struct PulseRuleUpsert {
    pub id: String,
    pub enabled: bool,
    pub draft_only: bool,
    pub mandate_origin: MandateOrigin,
    pub spec: PulseRuleSpec,
    pub webhook_route_id: Option<String>,
    pub next_fire_at: Option<String>,
    pub now: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PulseObservedCandidateRecord {
    pub view: PulseObservedCandidateView,
    pub envelope: EventEnvelope,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PulseBotMailboxItem {
    pub id: String,
    pub member_id: String,
    pub conversation_scope: BotConversationScope,
    pub mailbox_policy: BotMailboxPolicy,
    pub thread_key: Option<String>,
    pub event_id: String,
    pub prompt_text: String,
    pub status: String,
    pub created_at: String,
    pub claimed_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PulseClaimedBotTurn {
    pub primary: PulseBotMailboxItem,
    pub coalesced_items: Vec<PulseBotMailboxItem>,
    pub combined_prompt: String,
}

#[derive(Clone, Debug)]
pub struct PulseCreateUserInteraction {
    pub id: String,
    pub rule_id: Option<String>,
    pub workflow_run_id: Option<String>,
    pub step_id: Option<String>,
    pub kind: UserInteractionKind,
    pub severity: UserInteractionSeverity,
    pub title: String,
    pub body: String,
    pub approval_options: Vec<ApprovalOptionSpec>,
    pub form_schema: Option<serde_json::Value>,
    pub sla_deadline_at: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PulseUserInteractionRecord {
    pub view: PulseUserInteractionView,
    pub resolution: Option<serde_json::Value>,
    pub sla_deadline_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PulseOutboxRecord {
    pub id: String,
    pub dedupe_key: String,
    pub target_kind: String,
    pub payload: serde_json::Value,
    pub status: String,
    pub attempts: u32,
    pub next_attempt_at: String,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl SqlitePulseStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    // --- Sources (`pulse_sources`) ---

    pub async fn upsert_source(
        &self,
        input: PulseSourceUpsert,
    ) -> Result<PulseSourceRecord, sqlx::Error> {
        let kind_str = encode_enum_str(&input.kind)?;
        let config_str = serde_json::to_string(&input.config_json).map_err(protocol_error)?;

        sqlx::query(
            "INSERT INTO pulse_sources (
                id, kind, title, enabled, healthy, status_message, cursor_watermark,
                public_webhook_path, config_json, signing_secret, received_count_24h,
                rejected_count_24h, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind,
                title = excluded.title,
                enabled = excluded.enabled,
                healthy = excluded.healthy,
                status_message = COALESCE(excluded.status_message, pulse_sources.status_message),
                cursor_watermark = COALESCE(excluded.cursor_watermark, pulse_sources.cursor_watermark),
                public_webhook_path = COALESCE(excluded.public_webhook_path, pulse_sources.public_webhook_path),
                config_json = excluded.config_json,
                signing_secret = COALESCE(excluded.signing_secret, pulse_sources.signing_secret),
                updated_at = excluded.updated_at",
        )
        .bind(&input.id)
        .bind(kind_str)
        .bind(&input.title)
        .bind(input.enabled)
        .bind(input.healthy)
        .bind(&input.status_message)
        .bind(&input.cursor_watermark)
        .bind(&input.public_webhook_path)
        .bind(config_str)
        .bind(&input.signing_secret)
        .bind(&input.now)
        .bind(&input.now)
        .execute(&self.pool)
        .await?;

        self.get_source(&input.id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn get_source(&self, id: &str) -> Result<Option<PulseSourceRecord>, sqlx::Error> {
        self.fetch_source_by("id", id).await
    }

    pub async fn get_source_by_webhook_path(
        &self,
        webhook_path: &str,
    ) -> Result<Option<PulseSourceRecord>, sqlx::Error> {
        self.fetch_source_by("public_webhook_path", webhook_path)
            .await
    }

    async fn fetch_source_by(
        &self,
        column: &str,
        value: &str,
    ) -> Result<Option<PulseSourceRecord>, sqlx::Error> {
        let sql = format!("SELECT {SOURCE_COLUMNS} FROM pulse_sources WHERE {column} = ?");
        sqlx::query_as::<_, SourceRow>(&sql)
            .bind(value)
            .fetch_optional(&self.pool)
            .await?
            .map(parse_source_row)
            .transpose()
    }

    pub async fn list_sources(&self) -> Result<Vec<PulseSourceView>, sqlx::Error> {
        Ok(self
            .list_source_records()
            .await?
            .into_iter()
            .map(|r| r.view)
            .collect())
    }

    pub async fn list_source_records(&self) -> Result<Vec<PulseSourceRecord>, sqlx::Error> {
        let sql =
            format!("SELECT {SOURCE_COLUMNS} FROM pulse_sources ORDER BY created_at ASC, id ASC");
        sqlx::query_as::<_, SourceRow>(&sql)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(parse_source_row)
            .collect()
    }

    pub async fn update_source_watermark(
        &self,
        id: &str,
        cursor_watermark: Option<&str>,
        healthy: bool,
        status_message: Option<&str>,
        now: &str,
    ) -> Result<bool, sqlx::Error> {
        let sql = "UPDATE pulse_sources SET cursor_watermark = ?, healthy = ?, status_message = ?, updated_at = ? WHERE id = ?";
        let res = sqlx::query(sql)
            .bind(cursor_watermark)
            .bind(healthy)
            .bind(status_message)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn increment_source_received(&self, id: &str, now: &str) -> Result<(), sqlx::Error> {
        let sql = "UPDATE pulse_sources SET received_count_24h = received_count_24h + 1, updated_at = ? WHERE id = ?";
        sqlx::query(sql)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn increment_source_rejected(
        &self,
        id: &str,
        status_message: Option<&str>,
        now: &str,
    ) -> Result<(), sqlx::Error> {
        let sql = "UPDATE pulse_sources SET rejected_count_24h = rejected_count_24h + 1, status_message = COALESCE(?, status_message), updated_at = ? WHERE id = ?";
        sqlx::query(sql)
            .bind(status_message)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_source(&self, id: &str) -> Result<bool, sqlx::Error> {
        self.exec_affected("DELETE FROM pulse_sources WHERE id = ?", id)
            .await
    }

    // --- Event Receipts (`pulse_event_receipts`) ---

    /// Atomically deduplicates `(source_id, delivery_id)` and persists the captured envelope.
    pub async fn insert_receipt_if_new(
        &self,
        source_id: &str,
        envelope: &EventEnvelope,
        received_at: &str,
    ) -> Result<bool, sqlx::Error> {
        let envelope_json = serde_json::to_string(envelope).map_err(protocol_error)?;
        let mut tx = self.pool.begin().await?;

        let result = sqlx::query(
            "INSERT OR IGNORE INTO pulse_event_receipts
             (source_id, delivery_id, event_id, event_type, thread_key, envelope_json, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(source_id)
        .bind(&envelope.delivery_id)
        .bind(&envelope.event_id)
        .bind(&envelope.event_type)
        .bind(&envelope.thread_key)
        .bind(envelope_json)
        .bind(received_at)
        .execute(&mut *tx)
        .await?;

        let inserted = result.rows_affected() == 1;
        if inserted {
            sqlx::query(
                "UPDATE pulse_sources
                 SET received_count_24h = received_count_24h + 1, updated_at = ?
                 WHERE id = ?",
            )
            .bind(received_at)
            .bind(source_id)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(inserted)
    }

    pub async fn list_recent_envelopes(
        &self,
        limit: u32,
    ) -> Result<Vec<EventEnvelope>, sqlx::Error> {
        let raw_rows: Vec<String> = sqlx::query_scalar(
            "SELECT envelope_json FROM pulse_event_receipts
             ORDER BY received_at DESC, rowid DESC LIMIT ?",
        )
        .bind(i64::from(limit.clamp(1, 500)))
        .fetch_all(&self.pool)
        .await?;

        raw_rows
            .into_iter()
            .map(|raw| serde_json::from_str::<EventEnvelope>(&raw).map_err(protocol_error))
            .collect()
    }

    pub async fn get_envelope_by_event_id(
        &self,
        event_id: &str,
    ) -> Result<Option<EventEnvelope>, sqlx::Error> {
        let raw: Option<String> = sqlx::query_scalar(
            "SELECT envelope_json FROM pulse_event_receipts WHERE event_id = ? LIMIT 1",
        )
        .bind(event_id)
        .fetch_optional(&self.pool)
        .await?;

        raw.map(|s| serde_json::from_str::<EventEnvelope>(&s).map_err(protocol_error))
            .transpose()
    }

    pub async fn prune_receipts_before(&self, cutoff_iso: &str) -> Result<u64, sqlx::Error> {
        let res = sqlx::query("DELETE FROM pulse_event_receipts WHERE received_at < ?")
            .bind(cutoff_iso)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected())
    }

    // --- Rules (`pulse_rules`) ---

    pub async fn save_rule(&self, input: PulseRuleUpsert) -> Result<PulseRuleView, sqlx::Error> {
        let mandate_str = encode_enum_str(&input.mandate_origin)?;
        let eval_mode_str = encode_enum_str(&input.spec.eval_mode)?;
        let spec_json = serde_json::to_string(&input.spec).map_err(protocol_error)?;

        sqlx::query(
            "INSERT INTO pulse_rules (
                id, revision, enabled, draft_only, mandate_origin, project_id, workspace_id,
                eval_mode, spec_json, webhook_route_id, next_fire_at, matched_count,
                observed_count, created_at, updated_at
             ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                revision = pulse_rules.revision + 1,
                enabled = excluded.enabled,
                draft_only = excluded.draft_only,
                mandate_origin = excluded.mandate_origin,
                project_id = excluded.project_id,
                workspace_id = excluded.workspace_id,
                eval_mode = excluded.eval_mode,
                spec_json = excluded.spec_json,
                webhook_route_id = COALESCE(excluded.webhook_route_id, pulse_rules.webhook_route_id),
                next_fire_at = excluded.next_fire_at,
                updated_at = excluded.updated_at",
        )
        .bind(&input.id)
        .bind(input.enabled)
        .bind(input.draft_only)
        .bind(mandate_str)
        .bind(&input.spec.project_id)
        .bind(&input.spec.workspace_id)
        .bind(eval_mode_str)
        .bind(spec_json)
        .bind(&input.webhook_route_id)
        .bind(&input.next_fire_at)
        .bind(&input.now)
        .bind(&input.now)
        .execute(&self.pool)
        .await?;

        self.get_rule(&input.id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn get_rule(&self, id: &str) -> Result<Option<PulseRuleView>, sqlx::Error> {
        self.fetch_rule_by("id", id).await
    }

    pub async fn get_rule_by_webhook_route(
        &self,
        route_id: &str,
    ) -> Result<Option<PulseRuleView>, sqlx::Error> {
        self.fetch_rule_by("webhook_route_id", route_id).await
    }

    async fn fetch_rule_by(
        &self,
        column: &str,
        value: &str,
    ) -> Result<Option<PulseRuleView>, sqlx::Error> {
        let sql = format!("SELECT {RULE_COLUMNS} FROM pulse_rules WHERE {column} = ?");
        sqlx::query_as::<_, RuleRow>(&sql)
            .bind(value)
            .fetch_optional(&self.pool)
            .await?
            .map(parse_rule_row)
            .transpose()
    }

    pub async fn list_rules(
        &self,
        project_id: Option<&str>,
    ) -> Result<Vec<PulseRuleView>, sqlx::Error> {
        let sql = format!(
            "SELECT {RULE_COLUMNS} FROM pulse_rules WHERE (? IS NULL OR project_id = ? OR project_id IS NULL) ORDER BY created_at DESC, id ASC"
        );
        sqlx::query_as::<_, RuleRow>(&sql)
            .bind(project_id)
            .bind(project_id)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(parse_rule_row)
            .collect()
    }

    pub async fn list_enabled_rules(&self) -> Result<Vec<PulseRuleView>, sqlx::Error> {
        let sql = format!(
            "SELECT {RULE_COLUMNS} FROM pulse_rules WHERE enabled = 1 AND draft_only = 0 AND eval_mode != 'off' ORDER BY created_at ASC, id ASC"
        );
        sqlx::query_as::<_, RuleRow>(&sql)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(parse_rule_row)
            .collect()
    }

    pub async fn list_due_temporal_rules(
        &self,
        now_iso: &str,
    ) -> Result<Vec<PulseRuleView>, sqlx::Error> {
        let sql = format!(
            "SELECT {RULE_COLUMNS} FROM pulse_rules WHERE enabled = 1 AND draft_only = 0 AND eval_mode != 'off' AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at ASC, id ASC"
        );
        sqlx::query_as::<_, RuleRow>(&sql)
            .bind(now_iso)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(parse_rule_row)
            .collect()
    }

    pub async fn set_rule_mode(
        &self,
        id: &str,
        eval_mode: PulseEvalMode,
        now: &str,
    ) -> Result<Option<PulseRuleView>, sqlx::Error> {
        let Some(mut current) = self.get_rule(id).await? else {
            return Ok(None);
        };
        current.spec.eval_mode = eval_mode;
        let eval_mode_str = encode_enum_str(&eval_mode)?;
        let spec_json = serde_json::to_string(&current.spec).map_err(protocol_error)?;
        let sql = "UPDATE pulse_rules SET eval_mode = ?, spec_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?";
        sqlx::query(sql)
            .bind(eval_mode_str)
            .bind(spec_json)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        self.get_rule(id).await
    }

    pub async fn set_rule_enabled(
        &self,
        id: &str,
        enabled: bool,
        next_fire_at: Option<Option<&str>>,
        now: &str,
    ) -> Result<Option<PulseRuleView>, sqlx::Error> {
        let Some(current) = self.get_rule(id).await? else {
            return Ok(None);
        };
        let promote_draft = current.draft_only && enabled;
        let fire_value = next_fire_at.flatten();
        let update_fire = if promote_draft {
            fire_value.is_some()
        } else {
            next_fire_at.is_some()
        };
        let sql = "UPDATE pulse_rules SET enabled = ?, draft_only = CASE WHEN ? THEN 0 ELSE draft_only END, mandate_origin = CASE WHEN ? THEN 'explicit_human' ELSE mandate_origin END, next_fire_at = CASE WHEN ? THEN ? ELSE next_fire_at END, revision = revision + 1, updated_at = ? WHERE id = ?";
        sqlx::query(sql)
            .bind(enabled)
            .bind(promote_draft)
            .bind(promote_draft)
            .bind(update_fire)
            .bind(fire_value)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        self.get_rule(id).await
    }

    pub async fn update_rule_schedule(
        &self,
        id: &str,
        next_fire_at: Option<&str>,
        disable_rule: bool,
        now: &str,
    ) -> Result<bool, sqlx::Error> {
        let sql = "UPDATE pulse_rules SET next_fire_at = ?, enabled = CASE WHEN ? THEN 0 ELSE enabled END, updated_at = ? WHERE id = ?";
        let res = sqlx::query(sql)
            .bind(next_fire_at)
            .bind(disable_rule)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn increment_rule_matched(&self, id: &str, now: &str) -> Result<(), sqlx::Error> {
        self.increment_rule_counter("matched_count", id, now).await
    }

    pub async fn increment_rule_observed(&self, id: &str, now: &str) -> Result<(), sqlx::Error> {
        self.increment_rule_counter("observed_count", id, now).await
    }

    async fn increment_rule_counter(
        &self,
        col: &str,
        id: &str,
        now: &str,
    ) -> Result<(), sqlx::Error> {
        let sql = format!("UPDATE pulse_rules SET {col} = {col} + 1, updated_at = ? WHERE id = ?");
        sqlx::query(&sql)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_rule(&self, id: &str) -> Result<bool, sqlx::Error> {
        self.exec_affected("DELETE FROM pulse_rules WHERE id = ?", id)
            .await
    }

    // --- Thread Subscriptions (`pulse_thread_subscriptions`) ---

    pub async fn subscribe_thread(
        &self,
        id: &str,
        thread_key: &str,
        subscriber_kind: &str,
        subscriber_id: &str,
        now: &str,
    ) -> Result<PulseSubscriptionView, sqlx::Error> {
        let upsert_sql = "INSERT INTO pulse_thread_subscriptions (id, thread_key, subscriber_kind, subscriber_id, active, created_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(thread_key, subscriber_kind, subscriber_id) DO UPDATE SET active = 1";
        sqlx::query(upsert_sql)
            .bind(id)
            .bind(thread_key)
            .bind(subscriber_kind)
            .bind(subscriber_id)
            .bind(now)
            .execute(&self.pool)
            .await?;

        let sql = format!(
            "SELECT {SUBSCRIPTION_COLUMNS} FROM pulse_thread_subscriptions WHERE thread_key = ? AND subscriber_kind = ? AND subscriber_id = ?"
        );
        let row = sqlx::query_as::<_, SubscriptionRow>(&sql)
            .bind(thread_key)
            .bind(subscriber_kind)
            .bind(subscriber_id)
            .fetch_one(&self.pool)
            .await?;
        Ok(parse_subscription_row(row))
    }

    pub async fn unsubscribe_thread(&self, subscription_id: &str) -> Result<bool, sqlx::Error> {
        let sql = "UPDATE pulse_thread_subscriptions SET active = 0 WHERE id = ? AND active = 1";
        self.exec_affected(sql, subscription_id).await
    }

    /// O(1) indexed lookup by `(thread_key, active)`.
    pub async fn list_active_subscriptions_for_thread(
        &self,
        thread_key: &str,
    ) -> Result<Vec<PulseSubscriptionView>, sqlx::Error> {
        let sql = format!(
            "SELECT {SUBSCRIPTION_COLUMNS} FROM pulse_thread_subscriptions WHERE thread_key = ? AND active = 1 ORDER BY created_at ASC, id ASC"
        );
        let rows = sqlx::query_as::<_, SubscriptionRow>(&sql)
            .bind(thread_key)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(parse_subscription_row).collect())
    }

    pub async fn bind_session_thread_subscription(
        &self,
        thread_key: &str,
        session_id: &str,
        now: &str,
    ) -> Result<PulseSubscriptionView, sqlx::Error> {
        sqlx::query(
            "DELETE FROM pulse_thread_subscriptions
             WHERE thread_key = ? AND subscriber_kind = 'session' AND subscriber_id LIKE 'session:%'",
        )
        .bind(thread_key)
        .execute(&self.pool)
        .await?;
        let sub_id = format!("sub-session-{thread_key}-{session_id}");
        self.subscribe_thread(&sub_id, thread_key, "session", session_id, now)
            .await
    }

    pub async fn list_active_subscriptions(
        &self,
    ) -> Result<Vec<PulseSubscriptionView>, sqlx::Error> {
        let sql = format!(
            "SELECT {SUBSCRIPTION_COLUMNS} FROM pulse_thread_subscriptions WHERE active = 1 ORDER BY created_at DESC, id ASC LIMIT 200"
        );
        let rows = sqlx::query_as::<_, SubscriptionRow>(&sql)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(parse_subscription_row).collect())
    }

    pub async fn count_active_subscriptions(&self) -> Result<u32, sqlx::Error> {
        self.count_u32("SELECT COUNT(*) FROM pulse_thread_subscriptions WHERE active = 1")
            .await
    }

    // --- Observed Candidates (`pulse_observed_candidates`) ---

    pub async fn insert_observed_candidate(
        &self,
        id: &str,
        rule_id: &str,
        rule_name: &str,
        summary: &str,
        envelope: &EventEnvelope,
    ) -> Result<PulseObservedCandidateView, sqlx::Error> {
        let source_kind_str = encode_enum_str(&envelope.source.kind)?;
        let envelope_json = serde_json::to_string(envelope).map_err(protocol_error)?;

        sqlx::query(
            "INSERT INTO pulse_observed_candidates (
                id, rule_id, rule_name, event_id, event_type, source_kind,
                thread_key, summary, envelope_json, occurred_at, promoted
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        )
        .bind(id)
        .bind(rule_id)
        .bind(rule_name)
        .bind(&envelope.event_id)
        .bind(&envelope.event_type)
        .bind(source_kind_str)
        .bind(&envelope.thread_key)
        .bind(summary)
        .bind(envelope_json)
        .bind(&envelope.occurred_at)
        .execute(&self.pool)
        .await?;

        Ok(PulseObservedCandidateView {
            id: id.to_string(),
            rule_id: rule_id.to_string(),
            rule_name: rule_name.to_string(),
            event_id: envelope.event_id.clone(),
            event_type: envelope.event_type.clone(),
            source_kind: envelope.source.kind,
            thread_key: envelope.thread_key.clone(),
            summary: summary.to_string(),
            occurred_at: envelope.occurred_at.clone(),
            promoted: false,
        })
    }

    pub async fn get_observed_candidate(
        &self,
        id: &str,
    ) -> Result<Option<PulseObservedCandidateRecord>, sqlx::Error> {
        let sql = format!("SELECT {CANDIDATE_COLUMNS} FROM pulse_observed_candidates WHERE id = ?");
        sqlx::query_as::<_, ObservedCandidateRow>(&sql)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .map(parse_candidate_row)
            .transpose()
    }

    /// Atomically transitions `promoted = 0 -> 1` so concurrent callers cannot double-promote.
    pub async fn mark_candidate_promoted(
        &self,
        id: &str,
    ) -> Result<Option<PulseObservedCandidateRecord>, sqlx::Error> {
        let res = sqlx::query(
            "UPDATE pulse_observed_candidates SET promoted = 1 WHERE id = ? AND promoted = 0",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;

        if res.rows_affected() == 0 {
            return Ok(None);
        }
        self.get_observed_candidate(id).await
    }

    pub async fn list_observed_candidates(
        &self,
        include_promoted: bool,
        limit: u32,
    ) -> Result<Vec<PulseObservedCandidateView>, sqlx::Error> {
        let sql = format!(
            "SELECT {CANDIDATE_COLUMNS} FROM pulse_observed_candidates
             WHERE (? OR promoted = 0)
             ORDER BY occurred_at DESC, rowid DESC LIMIT ?"
        );
        sqlx::query_as::<_, ObservedCandidateRow>(&sql)
            .bind(include_promoted)
            .bind(i64::from(limit.clamp(1, 500)))
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|r| parse_candidate_row(r).map(|rec| rec.view))
            .collect()
    }

    // --- Bot Turn Mailbox (`pulse_bot_mailbox`) ---

    pub async fn enqueue_bot_mailbox(
        &self,
        item: &PulseBotMailboxItem,
    ) -> Result<PulseBotMailboxItem, sqlx::Error> {
        let scope_str = encode_enum_str(&item.conversation_scope)?;
        let policy_str = encode_enum_str(&item.mailbox_policy)?;

        sqlx::query(
            "INSERT INTO pulse_bot_mailbox (
                id, member_id, conversation_scope, mailbox_policy, thread_key,
                event_id, prompt_text, status, created_at, claimed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL)",
        )
        .bind(&item.id)
        .bind(&item.member_id)
        .bind(scope_str)
        .bind(policy_str)
        .bind(&item.thread_key)
        .bind(&item.event_id)
        .bind(&item.prompt_text)
        .bind(&item.created_at)
        .execute(&self.pool)
        .await?;

        let sql = format!("SELECT {MAILBOX_COLUMNS} FROM pulse_bot_mailbox WHERE id = ?");
        let row = sqlx::query_as::<_, BotMailboxRow>(&sql)
            .bind(&item.id)
            .fetch_one(&self.pool)
            .await?;
        parse_mailbox_row(row)
    }

    /// Idempotent mailbox insert (`INSERT OR IGNORE`) used by workflow `Bot` steps so retries reuse the same row.
    pub async fn enqueue_bot_turn(
        &self,
        item: &PulseBotMailboxItem,
    ) -> Result<PulseBotMailboxItem, sqlx::Error> {
        let scope_str = encode_enum_str(&item.conversation_scope)?;
        let policy_str = encode_enum_str(&item.mailbox_policy)?;

        sqlx::query(
            "INSERT OR IGNORE INTO pulse_bot_mailbox (
                id, member_id, conversation_scope, mailbox_policy, thread_key,
                event_id, prompt_text, status, created_at, claimed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL)",
        )
        .bind(&item.id)
        .bind(&item.member_id)
        .bind(scope_str)
        .bind(policy_str)
        .bind(&item.thread_key)
        .bind(&item.event_id)
        .bind(&item.prompt_text)
        .bind(&item.created_at)
        .execute(&self.pool)
        .await?;

        let sql = format!("SELECT {MAILBOX_COLUMNS} FROM pulse_bot_mailbox WHERE id = ?");
        let row = sqlx::query_as::<_, BotMailboxRow>(&sql)
            .bind(&item.id)
            .fetch_one(&self.pool)
            .await?;
        parse_mailbox_row(row)
    }

    pub async fn peek_next_bot_turn(
        &self,
        member_id: &str,
    ) -> Result<Option<PulseBotMailboxItem>, sqlx::Error> {
        let sql = format!(
            "SELECT {MAILBOX_COLUMNS} FROM pulse_bot_mailbox
             WHERE member_id = ? AND status = 'queued'
             ORDER BY created_at ASC, rowid ASC LIMIT 1"
        );
        sqlx::query_as::<_, BotMailboxRow>(&sql)
            .bind(member_id)
            .fetch_optional(&self.pool)
            .await?
            .map(parse_mailbox_row)
            .transpose()
    }

    pub async fn list_queued_bot_member_ids(&self) -> Result<Vec<String>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT DISTINCT member_id FROM pulse_bot_mailbox WHERE status = 'queued' ORDER BY member_id ASC",
        )
        .fetch_all(&self.pool)
        .await
    }

    pub async fn list_claimed_bot_member_ids(&self) -> Result<Vec<String>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT DISTINCT member_id FROM pulse_bot_mailbox WHERE status = 'claimed' ORDER BY member_id ASC",
        )
        .fetch_all(&self.pool)
        .await
    }

    /// Single-flight FIFO claim & batch coalesce per `member_id`.
    pub async fn claim_next_bot_turn(
        &self,
        member_id: &str,
        now: &str,
    ) -> Result<Option<PulseClaimedBotTurn>, sqlx::Error> {
        let mut tx = self.pool.begin().await?;

        let in_flight: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pulse_bot_mailbox WHERE member_id = ? AND status = 'claimed'",
        )
        .bind(member_id)
        .fetch_one(&mut *tx)
        .await?;

        if in_flight > 0 {
            tx.commit().await?;
            return Ok(None);
        }

        let head_sql = format!(
            "SELECT {MAILBOX_COLUMNS} FROM pulse_bot_mailbox
             WHERE member_id = ? AND status = 'queued'
             ORDER BY created_at ASC, rowid ASC LIMIT 1"
        );
        let Some(head_row) = sqlx::query_as::<_, BotMailboxRow>(&head_sql)
            .bind(member_id)
            .fetch_optional(&mut *tx)
            .await?
        else {
            tx.commit().await?;
            return Ok(None);
        };

        let mut head_item = parse_mailbox_row(head_row)?;
        sqlx::query("UPDATE pulse_bot_mailbox SET status = 'claimed', claimed_at = ? WHERE id = ?")
            .bind(now)
            .bind(&head_item.id)
            .execute(&mut *tx)
            .await?;
        head_item.status = "claimed".to_string();
        head_item.claimed_at = Some(now.to_string());

        let mut coalesced_items = Vec::new();
        if head_item.mailbox_policy == BotMailboxPolicy::CoalesceBatch {
            let scope_str = encode_enum_str(&head_item.conversation_scope)?;
            let fixed_scope = head_item.conversation_scope == BotConversationScope::FixedPrimary;
            let batch_sql = format!(
                "SELECT {MAILBOX_COLUMNS} FROM pulse_bot_mailbox
                 WHERE member_id = ? AND status = 'queued'
                   AND mailbox_policy = 'coalesce_batch'
                   AND conversation_scope = ?
                   AND (? OR thread_key IS ?)
                 ORDER BY created_at ASC, rowid ASC"
            );
            let batch_rows = sqlx::query_as::<_, BotMailboxRow>(&batch_sql)
                .bind(member_id)
                .bind(scope_str)
                .bind(fixed_scope)
                .bind(&head_item.thread_key)
                .fetch_all(&mut *tx)
                .await?;

            for row in batch_rows {
                let mut item = parse_mailbox_row(row)?;
                sqlx::query(
                    "UPDATE pulse_bot_mailbox SET status = 'coalesced', claimed_at = ? WHERE id = ?",
                )
                .bind(now)
                .bind(&item.id)
                .execute(&mut *tx)
                .await?;
                item.status = "coalesced".to_string();
                item.claimed_at = Some(now.to_string());
                coalesced_items.push(item);
            }
        }

        tx.commit().await?;

        let mut prompts = Vec::with_capacity(1 + coalesced_items.len());
        prompts.push(head_item.prompt_text.clone());
        prompts.extend(coalesced_items.iter().map(|i| i.prompt_text.clone()));
        let combined_prompt = prompts.join("\n\n---\n\n");

        Ok(Some(PulseClaimedBotTurn {
            primary: head_item,
            coalesced_items,
            combined_prompt,
        }))
    }

    pub async fn complete_bot_turn(&self, id: &str) -> Result<bool, sqlx::Error> {
        self.finish_bot_turn(id, "completed").await
    }

    pub async fn fail_bot_turn(&self, id: &str) -> Result<bool, sqlx::Error> {
        self.finish_bot_turn(id, "failed").await
    }

    async fn finish_bot_turn(&self, id: &str, next_status: &str) -> Result<bool, sqlx::Error> {
        let res = sqlx::query(
            "UPDATE pulse_bot_mailbox SET status = ? WHERE id = ? AND status = 'claimed'",
        )
        .bind(next_status)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn list_bot_mailbox(
        &self,
        member_id: &str,
    ) -> Result<Vec<PulseBotMailboxItem>, sqlx::Error> {
        let sql = format!(
            "SELECT {MAILBOX_COLUMNS} FROM pulse_bot_mailbox
             WHERE member_id = ? ORDER BY created_at ASC, rowid ASC"
        );
        sqlx::query_as::<_, BotMailboxRow>(&sql)
            .bind(member_id)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(parse_mailbox_row)
            .collect()
    }

    // --- User Interactions (`pulse_user_interactions`) ---

    pub async fn create_user_interaction(
        &self,
        input: PulseCreateUserInteraction,
    ) -> Result<PulseUserInteractionView, sqlx::Error> {
        let kind_str = encode_enum_str(&input.kind)?;
        let severity_str = encode_enum_str(&input.severity)?;
        let options_json =
            serde_json::to_string(&input.approval_options).map_err(protocol_error)?;
        let form_schema_json = input
            .form_schema
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(protocol_error)?;

        sqlx::query(
            "INSERT INTO pulse_user_interactions (
                id, rule_id, workflow_run_id, step_id, kind, severity, title, body,
                approval_options_json, form_schema_json, resolution_json, status,
                sla_deadline_at, created_at, resolved_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, NULL)",
        )
        .bind(&input.id)
        .bind(&input.rule_id)
        .bind(&input.workflow_run_id)
        .bind(&input.step_id)
        .bind(kind_str)
        .bind(severity_str)
        .bind(&input.title)
        .bind(&input.body)
        .bind(options_json)
        .bind(form_schema_json)
        .bind(&input.sla_deadline_at)
        .bind(&input.created_at)
        .execute(&self.pool)
        .await?;

        Ok(self
            .get_user_interaction(&input.id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?
            .view)
    }

    pub async fn get_user_interaction(
        &self,
        id: &str,
    ) -> Result<Option<PulseUserInteractionRecord>, sqlx::Error> {
        let sql = format!("SELECT {INTERACTION_COLUMNS} FROM pulse_user_interactions WHERE id = ?");
        sqlx::query_as::<_, UserInteractionRow>(&sql)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .map(parse_interaction_row)
            .transpose()
    }

    pub async fn resolve_user_interaction(
        &self,
        id: &str,
        resolution: &serde_json::Value,
        resolved_at: &str,
    ) -> Result<Option<PulseUserInteractionRecord>, sqlx::Error> {
        let resolution_json = serde_json::to_string(resolution).map_err(protocol_error)?;
        sqlx::query(
            "UPDATE pulse_user_interactions
             SET status = 'resolved', resolution_json = ?, resolved_at = ?
             WHERE id = ? AND status = 'pending'",
        )
        .bind(resolution_json)
        .bind(resolved_at)
        .bind(id)
        .execute(&self.pool)
        .await?;

        self.get_user_interaction(id).await
    }

    pub async fn expire_overdue_interactions(
        &self,
        now_iso: &str,
    ) -> Result<Vec<PulseUserInteractionView>, sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        let sql = format!(
            "SELECT {INTERACTION_COLUMNS} FROM pulse_user_interactions
             WHERE status = 'pending' AND sla_deadline_at IS NOT NULL AND sla_deadline_at <= ?
             ORDER BY sla_deadline_at ASC"
        );
        let overdue_rows = sqlx::query_as::<_, UserInteractionRow>(&sql)
            .bind(now_iso)
            .fetch_all(&mut *tx)
            .await?;

        let mut expired = Vec::with_capacity(overdue_rows.len());
        for row in overdue_rows {
            sqlx::query(
                "UPDATE pulse_user_interactions
                 SET status = 'expired', resolved_at = ?
                 WHERE id = ? AND status = 'pending'",
            )
            .bind(now_iso)
            .bind(&row.id)
            .execute(&mut *tx)
            .await?;
            let mut parsed = parse_interaction_row(row)?.view;
            parsed.status = "expired".to_string();
            parsed.resolved_at = Some(now_iso.to_string());
            expired.push(parsed);
        }

        tx.commit().await?;
        Ok(expired)
    }

    pub async fn list_pending_user_interactions(
        &self,
    ) -> Result<Vec<PulseUserInteractionView>, sqlx::Error> {
        let sql = format!(
            "SELECT {INTERACTION_COLUMNS} FROM pulse_user_interactions
             WHERE status = 'pending' ORDER BY created_at DESC, id ASC LIMIT 200"
        );
        sqlx::query_as::<_, UserInteractionRow>(&sql)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|r| parse_interaction_row(r).map(|rec| rec.view))
            .collect()
    }

    pub async fn count_pending_user_interactions(&self) -> Result<u32, sqlx::Error> {
        self.count_u32("SELECT COUNT(*) FROM pulse_user_interactions WHERE status = 'pending'")
            .await
    }

    // --- Durable Outbox (`pulse_outbox`) ---

    pub async fn enqueue_outbox(
        &self,
        id: &str,
        dedupe_key: &str,
        target_kind: &str,
        payload: &serde_json::Value,
        now: &str,
    ) -> Result<bool, sqlx::Error> {
        let payload_json = serde_json::to_string(payload).map_err(protocol_error)?;
        let sql = "INSERT OR IGNORE INTO pulse_outbox (id, dedupe_key, target_kind, payload_json, status, attempts, next_attempt_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)";
        let res = sqlx::query(sql)
            .bind(id)
            .bind(dedupe_key)
            .bind(target_kind)
            .bind(payload_json)
            .bind(now)
            .bind(now)
            .bind(now)
            .execute(&self.pool)
            .await?;
        let inserted = res.rows_affected() == 1;
        if inserted {
            notify_pulse_outbox();
        }
        Ok(inserted)
    }

    pub async fn claim_due_outbox(
        &self,
        now_iso: &str,
        limit: u32,
    ) -> Result<Vec<PulseOutboxRecord>, sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        let sql = format!(
            "SELECT {OUTBOX_COLUMNS} FROM pulse_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC, rowid ASC LIMIT ?"
        );
        let rows = sqlx::query_as::<_, OutboxRow>(&sql)
            .bind(now_iso)
            .bind(i64::from(limit.clamp(1, 100)))
            .fetch_all(&mut *tx)
            .await?;

        let mut claimed = Vec::with_capacity(rows.len());
        let claim_sql = "UPDATE pulse_outbox SET status = 'in_flight', attempts = attempts + 1, updated_at = ? WHERE id = ?";
        for row in rows {
            sqlx::query(claim_sql)
                .bind(now_iso)
                .bind(&row.id)
                .execute(&mut *tx)
                .await?;
            let mut parsed = parse_outbox_row(row)?;
            parsed.status = "in_flight".to_string();
            parsed.attempts = parsed.attempts.saturating_add(1);
            parsed.updated_at = now_iso.to_string();
            claimed.push(parsed);
        }

        tx.commit().await?;
        Ok(claimed)
    }

    pub async fn mark_outbox_delivered(&self, id: &str, now: &str) -> Result<bool, sqlx::Error> {
        let sql = "UPDATE pulse_outbox SET status = 'delivered', last_error = NULL, updated_at = ? WHERE id = ?";
        let res = sqlx::query(sql)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn mark_outbox_failed(
        &self,
        id: &str,
        error: &str,
        retry_at: Option<&str>,
        now: &str,
    ) -> Result<bool, sqlx::Error> {
        let next_status = if retry_at.is_some() {
            "pending"
        } else {
            "failed"
        };
        let sql = "UPDATE pulse_outbox SET status = ?, last_error = ?, next_attempt_at = COALESCE(?, next_attempt_at), updated_at = ? WHERE id = ?";
        let res = sqlx::query(sql)
            .bind(next_status)
            .bind(error)
            .bind(retry_at)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected() > 0)
    }

    // --- Event Schemas (`pulse_event_schemas`) ---

    pub async fn upsert_event_schema(
        &self,
        event_type: &str,
        summary: &str,
        json_schema: &serde_json::Value,
        built_in: bool,
        now: &str,
    ) -> Result<PulseEventSchemaView, sqlx::Error> {
        let schema_str = serde_json::to_string(json_schema).map_err(protocol_error)?;
        let sql = "INSERT INTO pulse_event_schemas (event_type, summary, json_schema, built_in, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_type) DO UPDATE SET summary = excluded.summary, json_schema = excluded.json_schema, built_in = excluded.built_in, updated_at = excluded.updated_at";
        sqlx::query(sql)
            .bind(event_type)
            .bind(summary)
            .bind(schema_str)
            .bind(built_in)
            .bind(now)
            .execute(&self.pool)
            .await?;

        self.get_event_schema(event_type)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn get_event_schema(
        &self,
        event_type: &str,
    ) -> Result<Option<PulseEventSchemaView>, sqlx::Error> {
        let sql = "SELECT event_type, summary, json_schema, built_in, updated_at FROM pulse_event_schemas WHERE event_type = ?";
        sqlx::query_as::<_, EventSchemaRow>(sql)
            .bind(event_type)
            .fetch_optional(&self.pool)
            .await?
            .map(parse_event_schema_row)
            .transpose()
    }

    pub async fn list_event_schemas(&self) -> Result<Vec<PulseEventSchemaView>, sqlx::Error> {
        let sql = "SELECT event_type, summary, json_schema, built_in, updated_at FROM pulse_event_schemas ORDER BY built_in DESC, event_type ASC";
        sqlx::query_as::<_, EventSchemaRow>(sql)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(parse_event_schema_row)
            .collect()
    }

    async fn exec_affected(&self, sql: &str, id: &str) -> Result<bool, sqlx::Error> {
        let res = sqlx::query(sql).bind(id).execute(&self.pool).await?;
        Ok(res.rows_affected() > 0)
    }

    async fn count_u32(&self, sql: &str) -> Result<u32, sqlx::Error> {
        let count: i64 = sqlx::query_scalar(sql).fetch_one(&self.pool).await?;
        Ok(u32::try_from(count.max(0)).unwrap_or(u32::MAX))
    }
}
