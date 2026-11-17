//! Internal SQLite row projections and JSON/enum codecs for `SqlitePulseStore`.

use api_types::pulse::{
    PulseEventSchemaView, PulseObservedCandidateView, PulseRuleView, PulseSourceView,
    PulseSubscriptionView, PulseUserInteractionView,
};
use serde::{Serialize, de::DeserializeOwned};
use sqlx::FromRow;

use super::{
    PulseBotMailboxItem, PulseObservedCandidateRecord, PulseOutboxRecord, PulseSourceRecord,
    PulseUserInteractionRecord,
};

#[derive(FromRow)]
pub(super) struct SourceRow {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) title: String,
    pub(super) enabled: bool,
    pub(super) healthy: bool,
    pub(super) status_message: Option<String>,
    pub(super) cursor_watermark: Option<String>,
    pub(super) public_webhook_path: Option<String>,
    pub(super) config_json: String,
    pub(super) signing_secret: Option<String>,
    pub(super) received_count_24h: i64,
    pub(super) rejected_count_24h: i64,
    pub(super) created_at: String,
    pub(super) updated_at: String,
}

#[derive(FromRow)]
pub(super) struct RuleRow {
    pub(super) id: String,
    pub(super) revision: i64,
    pub(super) enabled: bool,
    pub(super) draft_only: bool,
    pub(super) mandate_origin: String,
    pub(super) spec_json: String,
    pub(super) webhook_route_id: Option<String>,
    pub(super) next_fire_at: Option<String>,
    pub(super) matched_count: i64,
    pub(super) observed_count: i64,
    pub(super) created_at: String,
    pub(super) updated_at: String,
}

#[derive(FromRow)]
pub(super) struct SubscriptionRow {
    pub(super) id: String,
    pub(super) thread_key: String,
    pub(super) subscriber_kind: String,
    pub(super) subscriber_id: String,
    pub(super) active: bool,
    pub(super) created_at: String,
}

#[derive(FromRow)]
pub(super) struct ObservedCandidateRow {
    pub(super) id: String,
    pub(super) rule_id: String,
    pub(super) rule_name: String,
    pub(super) event_id: String,
    pub(super) event_type: String,
    pub(super) source_kind: String,
    pub(super) thread_key: Option<String>,
    pub(super) summary: String,
    pub(super) envelope_json: String,
    pub(super) occurred_at: String,
    pub(super) promoted: bool,
}

#[derive(FromRow)]
pub(super) struct BotMailboxRow {
    pub(super) id: String,
    pub(super) member_id: String,
    pub(super) conversation_scope: String,
    pub(super) mailbox_policy: String,
    pub(super) thread_key: Option<String>,
    pub(super) event_id: String,
    pub(super) prompt_text: String,
    pub(super) status: String,
    pub(super) created_at: String,
    pub(super) claimed_at: Option<String>,
}

#[derive(FromRow)]
pub(super) struct UserInteractionRow {
    pub(super) id: String,
    pub(super) rule_id: Option<String>,
    pub(super) workflow_run_id: Option<String>,
    pub(super) step_id: Option<String>,
    pub(super) kind: String,
    pub(super) severity: String,
    pub(super) title: String,
    pub(super) body: String,
    pub(super) approval_options_json: String,
    pub(super) form_schema_json: Option<String>,
    pub(super) resolution_json: Option<String>,
    pub(super) status: String,
    pub(super) sla_deadline_at: Option<String>,
    pub(super) created_at: String,
    pub(super) resolved_at: Option<String>,
}

#[derive(FromRow)]
pub(super) struct OutboxRow {
    pub(super) id: String,
    pub(super) dedupe_key: String,
    pub(super) target_kind: String,
    pub(super) payload_json: String,
    pub(super) status: String,
    pub(super) attempts: i64,
    pub(super) next_attempt_at: String,
    pub(super) last_error: Option<String>,
    pub(super) created_at: String,
    pub(super) updated_at: String,
}

#[derive(FromRow)]
pub(super) struct EventSchemaRow {
    pub(super) event_type: String,
    pub(super) summary: String,
    pub(super) json_schema: String,
    pub(super) built_in: bool,
    pub(super) updated_at: String,
}

pub(super) const SOURCE_COLUMNS: &str = "id,kind,title,enabled,healthy,status_message,cursor_watermark,\
    public_webhook_path,config_json,signing_secret,received_count_24h,rejected_count_24h,\
    created_at,updated_at";
pub(super) const RULE_COLUMNS: &str = "id,revision,enabled,draft_only,mandate_origin,spec_json,\
    webhook_route_id,next_fire_at,matched_count,observed_count,created_at,updated_at";
pub(super) const SUBSCRIPTION_COLUMNS: &str =
    "id,thread_key,subscriber_kind,subscriber_id,active,created_at";
pub(super) const CANDIDATE_COLUMNS: &str = "id,rule_id,rule_name,event_id,event_type,source_kind,thread_key,\
    summary,envelope_json,occurred_at,promoted";
pub(super) const MAILBOX_COLUMNS: &str = "id,member_id,conversation_scope,mailbox_policy,thread_key,event_id,\
    prompt_text,status,created_at,claimed_at";
pub(super) const INTERACTION_COLUMNS: &str = "id,rule_id,workflow_run_id,step_id,kind,severity,title,body,\
    approval_options_json,form_schema_json,resolution_json,status,sla_deadline_at,\
    created_at,resolved_at";
pub(super) const OUTBOX_COLUMNS: &str = "id,dedupe_key,target_kind,payload_json,status,attempts,\
    next_attempt_at,last_error,created_at,updated_at";

pub(super) fn encode_enum_str<T: Serialize>(value: &T) -> Result<String, sqlx::Error> {
    match serde_json::to_value(value).map_err(protocol_error)? {
        serde_json::Value::String(s) => Ok(s),
        other => Err(sqlx::Error::Protocol(format!(
            "expected string-encoded enum, got {other}"
        ))),
    }
}

pub(super) fn decode_enum_str<T: DeserializeOwned>(raw: &str) -> Result<T, sqlx::Error> {
    serde_json::from_value(serde_json::Value::String(raw.to_string())).map_err(protocol_error)
}

pub(super) fn decode_json<T: DeserializeOwned>(raw: &str) -> Result<T, sqlx::Error> {
    serde_json::from_str(raw).map_err(protocol_error)
}

pub(super) fn decode_json_opt<T: DeserializeOwned>(
    raw: Option<&str>,
) -> Result<Option<T>, sqlx::Error> {
    raw.map(serde_json::from_str)
        .transpose()
        .map_err(protocol_error)
}

pub(super) fn parse_source_row(row: SourceRow) -> Result<PulseSourceRecord, sqlx::Error> {
    let config_json: serde_json::Value = decode_json(&row.config_json)?;
    let has_signing_secret = row
        .signing_secret
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty());
    Ok(PulseSourceRecord {
        view: PulseSourceView {
            id: row.id,
            kind: decode_enum_str(&row.kind)?,
            title: row.title,
            enabled: row.enabled,
            healthy: row.healthy,
            status_message: row.status_message,
            cursor_watermark: row.cursor_watermark,
            public_webhook_path: row.public_webhook_path,
            received_count_24h: u64::try_from(row.received_count_24h.max(0)).unwrap_or(0),
            rejected_count_24h: u64::try_from(row.rejected_count_24h.max(0)).unwrap_or(0),
            updated_at: row.updated_at,
            config_json: config_json.clone(),
            has_signing_secret,
        },
        config_json,
        signing_secret: row.signing_secret,
        created_at: row.created_at,
    })
}

pub(super) fn parse_rule_row(row: RuleRow) -> Result<PulseRuleView, sqlx::Error> {
    Ok(PulseRuleView {
        id: row.id,
        revision: u32::try_from(row.revision.max(1)).unwrap_or(u32::MAX),
        enabled: row.enabled,
        draft_only: row.draft_only,
        mandate_origin: decode_enum_str(&row.mandate_origin)?,
        spec: decode_json(&row.spec_json)?,
        webhook_route_id: row.webhook_route_id,
        next_fire_at: row.next_fire_at,
        matched_count: u64::try_from(row.matched_count.max(0)).unwrap_or(0),
        observed_count: u64::try_from(row.observed_count.max(0)).unwrap_or(0),
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub(super) fn parse_subscription_row(row: SubscriptionRow) -> PulseSubscriptionView {
    PulseSubscriptionView {
        id: row.id,
        thread_key: row.thread_key,
        subscriber_kind: row.subscriber_kind,
        subscriber_id: row.subscriber_id,
        active: row.active,
        created_at: row.created_at,
    }
}

pub(super) fn parse_candidate_row(
    row: ObservedCandidateRow,
) -> Result<PulseObservedCandidateRecord, sqlx::Error> {
    Ok(PulseObservedCandidateRecord {
        view: PulseObservedCandidateView {
            id: row.id,
            rule_id: row.rule_id,
            rule_name: row.rule_name,
            event_id: row.event_id,
            event_type: row.event_type,
            source_kind: decode_enum_str(&row.source_kind)?,
            thread_key: row.thread_key,
            summary: row.summary,
            occurred_at: row.occurred_at,
            promoted: row.promoted,
        },
        envelope: decode_json(&row.envelope_json)?,
    })
}

pub(super) fn parse_mailbox_row(row: BotMailboxRow) -> Result<PulseBotMailboxItem, sqlx::Error> {
    Ok(PulseBotMailboxItem {
        id: row.id,
        member_id: row.member_id,
        conversation_scope: decode_enum_str(&row.conversation_scope)?,
        mailbox_policy: decode_enum_str(&row.mailbox_policy)?,
        thread_key: row.thread_key,
        event_id: row.event_id,
        prompt_text: row.prompt_text,
        status: row.status,
        created_at: row.created_at,
        claimed_at: row.claimed_at,
    })
}

pub(super) fn parse_interaction_row(
    row: UserInteractionRow,
) -> Result<PulseUserInteractionRecord, sqlx::Error> {
    Ok(PulseUserInteractionRecord {
        view: PulseUserInteractionView {
            id: row.id,
            rule_id: row.rule_id,
            workflow_run_id: row.workflow_run_id,
            step_id: row.step_id,
            kind: decode_enum_str(&row.kind)?,
            severity: decode_enum_str(&row.severity)?,
            title: row.title,
            body: row.body,
            approval_options: decode_json(&row.approval_options_json)?,
            form_schema: decode_json_opt(row.form_schema_json.as_deref())?,
            status: row.status,
            created_at: row.created_at,
            resolved_at: row.resolved_at,
        },
        resolution: decode_json_opt(row.resolution_json.as_deref())?,
        sla_deadline_at: row.sla_deadline_at,
    })
}

pub(super) fn parse_outbox_row(row: OutboxRow) -> Result<PulseOutboxRecord, sqlx::Error> {
    Ok(PulseOutboxRecord {
        id: row.id,
        dedupe_key: row.dedupe_key,
        target_kind: row.target_kind,
        payload: decode_json(&row.payload_json)?,
        status: row.status,
        attempts: u32::try_from(row.attempts.max(0)).unwrap_or(u32::MAX),
        next_attempt_at: row.next_attempt_at,
        last_error: row.last_error,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub(super) fn parse_event_schema_row(
    row: EventSchemaRow,
) -> Result<PulseEventSchemaView, sqlx::Error> {
    Ok(PulseEventSchemaView {
        event_type: row.event_type,
        summary: row.summary,
        json_schema: decode_json(&row.json_schema)?,
        built_in: row.built_in,
        updated_at: row.updated_at,
    })
}

pub(super) fn protocol_error(error: impl std::fmt::Display) -> sqlx::Error {
    sqlx::Error::Protocol(error.to_string())
}
