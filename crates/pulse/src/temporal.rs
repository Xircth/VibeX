//! Temporal event evaluator (`Cron`, `Once`, `Interval`, `InactivitySla`) and SLA tracker.

use std::collections::BTreeMap;

use api_types::pulse::{
    EventActor, EventEnvelope, EventSourceKind, EventSourceMeta, EventTrace, EventTrustLevel,
    PulseEvalMode, PulseRuleView, PulseTemporalSpec, ReplyChannelAddress,
};
use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc,
    Weekday,
};
use chrono_tz::Tz;
use serde_json::json;
use thiserror::Error;
use uuid::Uuid;

/// Maximum clock skew before a non-catch-up cron slot is treated as a missed downtime slot.
pub const CRON_ON_TIME_GRACE_SECONDS: i64 = 90;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TemporalError {
    #[error("invalid cron expression: {0}")]
    InvalidCron(String),
    #[error("invalid IANA timezone: {0}")]
    InvalidTimezone(String),
    #[error("invalid RFC 3339 timestamp: {0}")]
    InvalidTimestamp(String),
    #[error("invalid interval seconds: {0}")]
    InvalidInterval(u32),
}

#[derive(Debug, Clone, PartialEq)]
pub struct TemporalTickOutcome {
    pub emitted_envelope: Option<EventEnvelope>,
    pub next_fire_at: Option<DateTime<Utc>>,
    pub disable_after_fire: bool,
}

pub fn validate_cron_expression(expression: &str) -> Result<(), TemporalError> {
    CronSchedule::parse(expression).map(|_| ())
}

pub struct TemporalEvaluator;

impl TemporalEvaluator {
    /// Computes the initial or next scheduled fire timestamp strictly after `after` (or at `fire_at` for `Once`).
    pub fn compute_next_fire_at(
        spec: &PulseTemporalSpec,
        after: DateTime<Utc>,
    ) -> Result<Option<DateTime<Utc>>, TemporalError> {
        match spec {
            PulseTemporalSpec::Cron {
                expression,
                timezone,
                weekdays_only,
                ..
            } => next_cron_occurrence(expression, timezone, *weekdays_only, after),
            PulseTemporalSpec::Once { fire_at } => {
                let parsed = DateTime::parse_from_rfc3339(fire_at)
                    .map_err(|_| TemporalError::InvalidTimestamp(fire_at.clone()))?
                    .with_timezone(&Utc);
                Ok(Some(parsed))
            }
            PulseTemporalSpec::Interval { every_seconds, .. } => {
                if *every_seconds == 0 {
                    return Err(TemporalError::InvalidInterval(0));
                }
                Ok(Some(after + Duration::seconds(i64::from(*every_seconds))))
            }
            PulseTemporalSpec::InactivitySla { .. } => Ok(None),
        }
    }

    /// Evaluates a due rule (`scheduled_fire_at <= now`) and advances its schedule.
    ///
    /// - `Cron`: enforces `weekdays_only` and `catch_up_once` (if `now - scheduled > grace`:
    ///   fires a single catch-up event when `catch_up_once` is `true`, or skips missed downtime
    ///   slots when `catch_up_once` is `false`, always advancing `next_fire_at` past `now`).
    /// - `Once`: emits one event and marks `disable_after_fire = true` (`next_fire_at = None`).
    /// - `Interval`: skips firing when `skip_if_busy && is_busy`, advancing `next_fire_at = now + every_seconds`.
    pub fn evaluate_due_rule(
        rule_id: &str,
        spec: &PulseTemporalSpec,
        scheduled_fire_at: DateTime<Utc>,
        now: DateTime<Utc>,
        is_busy: bool,
    ) -> Result<TemporalTickOutcome, TemporalError> {
        if scheduled_fire_at > now {
            return Ok(TemporalTickOutcome {
                emitted_envelope: None,
                next_fire_at: Some(scheduled_fire_at),
                disable_after_fire: false,
            });
        }

        match spec {
            PulseTemporalSpec::Cron {
                expression,
                timezone,
                weekdays_only,
                catch_up_once,
            } => {
                let next_fire_at = next_cron_occurrence(expression, timezone, *weekdays_only, now)?;
                let lateness = (now - scheduled_fire_at).num_seconds();
                let should_fire = lateness <= CRON_ON_TIME_GRACE_SECONDS || *catch_up_once;

                let emitted_envelope = if should_fire {
                    let event_id = Uuid::new_v4().to_string();
                    let delivery_id = format!("cron:{rule_id}:{}", scheduled_fire_at.timestamp());
                    Some(EventEnvelope {
                        event_id: event_id.clone(),
                        delivery_id,
                        source: EventSourceMeta {
                            kind: EventSourceKind::TimeCron,
                            instance_id: format!("temporal:{rule_id}"),
                            trust_level: EventTrustLevel::TrustedInternal,
                        },
                        event_type: "time.cron.tick".to_string(),
                        occurred_at: now.to_rfc3339(),
                        actor: system_temporal_actor(),
                        thread_key: Some(format!("time:cron:{rule_id}")),
                        correlations: Vec::new(),
                        reply_channels: Vec::new(),
                        trace: EventTrace {
                            root_event_id: event_id,
                            parent_run_id: None,
                            hop_count: 0,
                        },
                        payload: json!({
                            "ruleId": rule_id,
                            "expression": expression,
                            "timezone": timezone,
                            "scheduledFor": scheduled_fire_at.to_rfc3339(),
                            "caughtUp": lateness > CRON_ON_TIME_GRACE_SECONDS,
                        }),
                    })
                } else {
                    None
                };

                Ok(TemporalTickOutcome {
                    emitted_envelope,
                    next_fire_at,
                    disable_after_fire: false,
                })
            }
            PulseTemporalSpec::Once { fire_at } => {
                let event_id = Uuid::new_v4().to_string();
                let delivery_id = format!("once:{rule_id}:{}", scheduled_fire_at.timestamp());
                let envelope = EventEnvelope {
                    event_id: event_id.clone(),
                    delivery_id,
                    source: EventSourceMeta {
                        kind: EventSourceKind::TimeOnce,
                        instance_id: format!("temporal:{rule_id}"),
                        trust_level: EventTrustLevel::TrustedInternal,
                    },
                    event_type: "time.once.fired".to_string(),
                    occurred_at: now.to_rfc3339(),
                    actor: system_temporal_actor(),
                    thread_key: Some(format!("time:once:{rule_id}")),
                    correlations: Vec::new(),
                    reply_channels: Vec::new(),
                    trace: EventTrace {
                        root_event_id: event_id,
                        parent_run_id: None,
                        hop_count: 0,
                    },
                    payload: json!({
                        "ruleId": rule_id,
                        "fireAt": fire_at,
                        "scheduledFor": scheduled_fire_at.to_rfc3339(),
                    }),
                };

                Ok(TemporalTickOutcome {
                    emitted_envelope: Some(envelope),
                    next_fire_at: None,
                    disable_after_fire: true,
                })
            }
            PulseTemporalSpec::Interval {
                every_seconds,
                skip_if_busy,
            } => {
                if *every_seconds == 0 {
                    return Err(TemporalError::InvalidInterval(0));
                }
                let next_fire_at = Some(now + Duration::seconds(i64::from(*every_seconds)));
                if *skip_if_busy && is_busy {
                    return Ok(TemporalTickOutcome {
                        emitted_envelope: None,
                        next_fire_at,
                        disable_after_fire: false,
                    });
                }

                let event_id = Uuid::new_v4().to_string();
                let delivery_id = format!("interval:{rule_id}:{}", now.timestamp());
                let envelope = EventEnvelope {
                    event_id: event_id.clone(),
                    delivery_id,
                    source: EventSourceMeta {
                        kind: EventSourceKind::TimeInterval,
                        instance_id: format!("temporal:{rule_id}"),
                        trust_level: EventTrustLevel::TrustedInternal,
                    },
                    event_type: "time.interval.tick".to_string(),
                    occurred_at: now.to_rfc3339(),
                    actor: system_temporal_actor(),
                    thread_key: Some(format!("time:interval:{rule_id}")),
                    correlations: Vec::new(),
                    reply_channels: Vec::new(),
                    trace: EventTrace {
                        root_event_id: event_id,
                        parent_run_id: None,
                        hop_count: 0,
                    },
                    payload: json!({
                        "ruleId": rule_id,
                        "everySeconds": every_seconds,
                        "scheduledFor": scheduled_fire_at.to_rfc3339(),
                    }),
                };

                Ok(TemporalTickOutcome {
                    emitted_envelope: Some(envelope),
                    next_fire_at,
                    disable_after_fire: false,
                })
            }
            PulseTemporalSpec::InactivitySla { .. } => Ok(TemporalTickOutcome {
                emitted_envelope: None,
                next_fire_at: None,
                disable_after_fire: false,
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArmedSlaDeadline {
    pub rule_id: String,
    pub thread_key: String,
    pub timeout_seconds: u32,
    pub armed_at: DateTime<Utc>,
    pub deadline_at: DateTime<Utc>,
    pub last_event_id: String,
    pub last_event_type: String,
    pub root_event_id: String,
    pub hop_count: u32,
    pub reply_channels: Vec<ReplyChannelAddress>,
}

/// Tracks per-`(rule_id, thread_key)` inactivity SLA deadlines and emits `time.sla.expired`
/// `EventEnvelope`s when no expected follow-up event arrives before the deadline.
#[derive(Debug, Clone, Default)]
pub struct InactivitySlaTracker {
    deadlines: BTreeMap<(String, String), ArmedSlaDeadline>,
}

impl InactivitySlaTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn armed_count(&self) -> usize {
        self.deadlines.len()
    }

    pub fn get_deadline(&self, rule_id: &str, thread_key: &str) -> Option<&ArmedSlaDeadline> {
        self.deadlines
            .get(&(rule_id.to_string(), thread_key.to_string()))
    }

    /// Observes an incoming `EventEnvelope` against all enabled `InactivitySla` rules:
    /// - Ignores `time.sla.expired` self-emissions so SLA expirations do not re-arm themselves.
    /// - If `expected_event_types` contains `envelope.event_type`, disarms the pending SLA timer.
    /// - Otherwise arms or resets the deadline to `now + timeout_seconds`.
    pub fn observe_event(
        &mut self,
        rules: &[PulseRuleView],
        envelope: &EventEnvelope,
        now: DateTime<Utc>,
    ) {
        if envelope.source.kind == EventSourceKind::TimeSla
            || envelope.event_type == "time.sla.expired"
        {
            return;
        }
        let Some(thread_key) = envelope.thread_key.as_deref() else {
            return;
        };

        for rule in rules {
            if !rule.enabled || rule.draft_only || rule.spec.eval_mode == PulseEvalMode::Off {
                continue;
            }
            let Some(PulseTemporalSpec::InactivitySla {
                thread_key_prefix,
                timeout_seconds,
                expected_event_types,
            }) = &rule.spec.temporal
            else {
                continue;
            };

            if !thread_key.starts_with(thread_key_prefix.as_str()) {
                continue;
            }

            let key = (rule.id.clone(), thread_key.to_string());
            if !expected_event_types.is_empty()
                && expected_event_types.contains(&envelope.event_type)
            {
                self.deadlines.remove(&key);
                continue;
            }

            let deadline_at = now + Duration::seconds(i64::from(*timeout_seconds));
            self.deadlines.insert(
                key,
                ArmedSlaDeadline {
                    rule_id: rule.id.clone(),
                    thread_key: thread_key.to_string(),
                    timeout_seconds: *timeout_seconds,
                    armed_at: now,
                    deadline_at,
                    last_event_id: envelope.event_id.clone(),
                    last_event_type: envelope.event_type.clone(),
                    root_event_id: if envelope.trace.root_event_id.is_empty() {
                        envelope.event_id.clone()
                    } else {
                        envelope.trace.root_event_id.clone()
                    },
                    hop_count: envelope.trace.hop_count,
                    reply_channels: envelope.reply_channels.clone(),
                },
            );
        }
    }

    /// Collects and removes all overdue SLA timers (`deadline_at <= now`), producing
    /// canonical `time.sla.expired` `EventEnvelope`s.
    pub fn collect_expired(&mut self, now: DateTime<Utc>) -> Vec<EventEnvelope> {
        let expired_keys: Vec<(String, String)> = self
            .deadlines
            .iter()
            .filter(|(_, entry)| entry.deadline_at <= now)
            .map(|(k, _)| k.clone())
            .collect();

        let mut emitted = Vec::with_capacity(expired_keys.len());
        for key in expired_keys {
            let Some(entry) = self.deadlines.remove(&key) else {
                continue;
            };
            let event_id = Uuid::new_v4().to_string();
            let delivery_id = format!(
                "sla:{}:{}:{}",
                entry.rule_id,
                entry.thread_key,
                entry.deadline_at.timestamp()
            );

            emitted.push(EventEnvelope {
                event_id,
                delivery_id,
                source: EventSourceMeta {
                    kind: EventSourceKind::TimeSla,
                    instance_id: format!("sla:{}", entry.rule_id),
                    trust_level: EventTrustLevel::TrustedInternal,
                },
                event_type: "time.sla.expired".to_string(),
                occurred_at: now.to_rfc3339(),
                actor: system_temporal_actor(),
                thread_key: Some(entry.thread_key.clone()),
                correlations: vec![entry.last_event_id.clone()],
                reply_channels: entry.reply_channels,
                trace: EventTrace {
                    root_event_id: entry.root_event_id,
                    parent_run_id: None,
                    hop_count: entry.hop_count.saturating_add(1),
                },
                payload: json!({
                    "ruleId": entry.rule_id,
                    "threadKey": entry.thread_key,
                    "timeoutSeconds": entry.timeout_seconds,
                    "armedAt": entry.armed_at.to_rfc3339(),
                    "deadlineAt": entry.deadline_at.to_rfc3339(),
                    "lastEventId": entry.last_event_id,
                    "lastEventType": entry.last_event_type,
                }),
            });
        }

        emitted
    }
}

fn system_temporal_actor() -> EventActor {
    EventActor {
        id: "system:pulse-temporal".to_string(),
        display_name: Some("Pulse Scheduler".to_string()),
        roles: vec!["system".to_string()],
        is_bot: false,
        is_self: false,
    }
}

// -----------------------------------------------------------------------------
// 5-field & 6-field Cron parser and evaluator
// -----------------------------------------------------------------------------

fn next_cron_occurrence(
    expression: &str,
    timezone_str: &str,
    weekdays_only: bool,
    after: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, TemporalError> {
    let schedule = CronSchedule::parse(expression)?;
    let tz: Tz = timezone_str
        .parse()
        .map_err(|_| TemporalError::InvalidTimezone(timezone_str.to_string()))?;

    let mut cursor = after.with_timezone(&tz).naive_local();
    for _ in 0..2048 {
        let Some(next_local) = schedule.next_after(cursor, weekdays_only) else {
            return Ok(None);
        };
        match tz.from_local_datetime(&next_local) {
            LocalResult::Single(dt) => {
                let next_utc = dt.with_timezone(&Utc);
                if next_utc > after {
                    return Ok(Some(next_utc));
                }
                cursor = next_local;
            }
            LocalResult::Ambiguous(first, second) => {
                let first_utc = first.with_timezone(&Utc);
                let second_utc = second.with_timezone(&Utc);
                let chosen = match (first_utc > after, second_utc > after) {
                    (true, true) => Some(first_utc.min(second_utc)),
                    (true, false) => Some(first_utc),
                    (false, true) => Some(second_utc),
                    (false, false) => None,
                };
                if let Some(next_utc) = chosen {
                    return Ok(Some(next_utc));
                }
                cursor = next_local;
            }
            LocalResult::None => {
                cursor = next_local;
            }
        }
    }

    Ok(None)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CronSchedule {
    seconds: Vec<u32>,
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days_of_month: Vec<u32>,
    months: Vec<u32>,
    days_of_week: Vec<u32>,
    dom_restricted: bool,
    dow_restricted: bool,
    years: Vec<u32>,
}

impl CronSchedule {
    fn parse(expression: &str) -> Result<Self, TemporalError> {
        let fields: Vec<&str> = expression.split_whitespace().collect();
        if !(5..=6).contains(&fields.len()) {
            return Err(TemporalError::InvalidCron(format!(
                "expected 5 or 6 fields, got {}",
                fields.len()
            )));
        }

        if fields.len() == 5 {
            return Ok(Self {
                seconds: vec![0],
                minutes: parse_numeric_field(fields[0], 0, 59, None)?,
                hours: parse_numeric_field(fields[1], 0, 23, None)?,
                days_of_month: parse_numeric_field(fields[2], 1, 31, None)?,
                months: parse_numeric_field(fields[3], 1, 12, Some(month_alias))?,
                days_of_week: normalize_dow(parse_numeric_field(fields[4], 0, 7, Some(dow_alias))?),
                dom_restricted: fields[2] != "*" && fields[2] != "?",
                dow_restricted: fields[4] != "*" && fields[4] != "?",
                years: Vec::new(),
            });
        }

        // 6-field Cron: distinguish `min hour dom month dow year` (year >= 1970)
        // from standard 6-field `sec min hour dom month dow`.
        if looks_like_year_field(fields[5]) {
            Ok(Self {
                seconds: vec![0],
                minutes: parse_numeric_field(fields[0], 0, 59, None)?,
                hours: parse_numeric_field(fields[1], 0, 23, None)?,
                days_of_month: parse_numeric_field(fields[2], 1, 31, None)?,
                months: parse_numeric_field(fields[3], 1, 12, Some(month_alias))?,
                days_of_week: normalize_dow(parse_numeric_field(fields[4], 0, 7, Some(dow_alias))?),
                dom_restricted: fields[2] != "*" && fields[2] != "?",
                dow_restricted: fields[4] != "*" && fields[4] != "?",
                years: parse_numeric_field(fields[5], 1970, 2199, None)?,
            })
        } else {
            Ok(Self {
                seconds: parse_numeric_field(fields[0], 0, 59, None)?,
                minutes: parse_numeric_field(fields[1], 0, 59, None)?,
                hours: parse_numeric_field(fields[2], 0, 23, None)?,
                days_of_month: parse_numeric_field(fields[3], 1, 31, None)?,
                months: parse_numeric_field(fields[4], 1, 12, Some(month_alias))?,
                days_of_week: normalize_dow(parse_numeric_field(fields[5], 0, 7, Some(dow_alias))?),
                dom_restricted: fields[3] != "*" && fields[3] != "?",
                dow_restricted: fields[5] != "*" && fields[5] != "?",
                years: Vec::new(),
            })
        }
    }

    fn matches_date(&self, date: NaiveDate, weekdays_only: bool) -> bool {
        if !self.years.is_empty() && !self.years.contains(&(date.year() as u32)) {
            return false;
        }
        if !self.months.contains(&date.month()) {
            return false;
        }
        if weekdays_only && matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
            return false;
        }
        let dom_ok = self.days_of_month.contains(&date.day());
        let dow_ok = self
            .days_of_week
            .contains(&date.weekday().num_days_from_sunday());
        match (self.dom_restricted, self.dow_restricted) {
            (true, true) => dom_ok || dow_ok,
            (true, false) => dom_ok,
            (false, true) => dow_ok,
            (false, false) => true,
        }
    }

    fn next_after(&self, after: NaiveDateTime, weekdays_only: bool) -> Option<NaiveDateTime> {
        let mut cursor = after
            .with_nanosecond(0)?
            .checked_add_signed(Duration::seconds(1))?;

        let min_year = self.years.first().copied();
        let max_year = self.years.last().copied().unwrap_or(2199);

        if let Some(min_y) = min_year
            && (cursor.year() as u32) < min_y
        {
            cursor = NaiveDate::from_ymd_opt(min_y as i32, 1, 1)?.and_hms_opt(0, 0, 0)?;
        }

        // Fast hierarchical search by day -> hour -> minute -> second (O(days) instead of O(seconds)).
        for _ in 0..(366 * 8) {
            if (cursor.year() as u32) > max_year {
                return None;
            }
            let date = cursor.date();
            if !self.matches_date(date, weekdays_only) {
                cursor = date.succ_opt()?.and_hms_opt(0, 0, 0)?;
                continue;
            }

            let start_hour = cursor.hour();
            for &hour in &self.hours {
                if hour < start_hour {
                    continue;
                }
                let start_min = if hour == start_hour {
                    cursor.minute()
                } else {
                    0
                };
                for &minute in &self.minutes {
                    if minute < start_min {
                        continue;
                    }
                    let start_sec = if hour == start_hour && minute == start_min {
                        cursor.second()
                    } else {
                        0
                    };
                    if let Some(&second) = self.seconds.iter().find(|&&s| s >= start_sec) {
                        return date.and_hms_opt(hour, minute, second);
                    }
                }
            }

            cursor = date.succ_opt()?.and_hms_opt(0, 0, 0)?;
        }

        None
    }
}

fn looks_like_year_field(field: &str) -> bool {
    field
        .split([',', '-', '/'])
        .filter_map(|part| part.parse::<u32>().ok())
        .any(|num| (1970..=2199).contains(&num))
}

fn normalize_dow(values: Vec<u32>) -> Vec<u32> {
    let mut out: Vec<u32> = values
        .into_iter()
        .map(|v| if v == 7 { 0 } else { v })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

fn month_alias(token: &str) -> Option<u32> {
    match token.to_ascii_uppercase().as_str() {
        "JAN" => Some(1),
        "FEB" => Some(2),
        "MAR" => Some(3),
        "APR" => Some(4),
        "MAY" => Some(5),
        "JUN" => Some(6),
        "JUL" => Some(7),
        "AUG" => Some(8),
        "SEP" => Some(9),
        "OCT" => Some(10),
        "NOV" => Some(11),
        "DEC" => Some(12),
        _ => None,
    }
}

fn dow_alias(token: &str) -> Option<u32> {
    match token.to_ascii_uppercase().as_str() {
        "SUN" => Some(0),
        "MON" => Some(1),
        "TUE" => Some(2),
        "WED" => Some(3),
        "THU" => Some(4),
        "FRI" => Some(5),
        "SAT" => Some(6),
        _ => None,
    }
}

fn parse_numeric_field(
    field: &str,
    min: u32,
    max: u32,
    alias: Option<fn(&str) -> Option<u32>>,
) -> Result<Vec<u32>, TemporalError> {
    if field == "?" {
        return Ok((min..=max).collect());
    }
    let mut values = Vec::new();
    for part in field.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, raw_step)) => {
                let step = raw_step.parse::<u32>().map_err(|_| {
                    TemporalError::InvalidCron(format!("invalid step `{raw_step}`"))
                })?;
                if step == 0 {
                    return Err(TemporalError::InvalidCron(
                        "cron step must be greater than zero".to_string(),
                    ));
                }
                (r, step)
            }
            None => (part, 1),
        };

        let (start, end) = if range == "*" || range == "?" {
            (min, max)
        } else if let Some((raw_start, raw_end)) = range.split_once('-') {
            (parse_atom(raw_start, alias)?, parse_atom(raw_end, alias)?)
        } else {
            let single = parse_atom(range, alias)?;
            (single, single)
        };

        if start < min || end > max || start > end {
            return Err(TemporalError::InvalidCron(format!(
                "value out of range [{min}, {max}] in `{part}`"
            )));
        }

        let mut cursor = start;
        while cursor <= end {
            values.push(cursor);
            cursor += step;
        }
    }

    values.sort_unstable();
    values.dedup();
    if values.is_empty() {
        return Err(TemporalError::InvalidCron("empty cron field".to_string()));
    }
    Ok(values)
}

fn parse_atom(raw: &str, alias: Option<fn(&str) -> Option<u32>>) -> Result<u32, TemporalError> {
    if let Some(mapper) = alias
        && let Some(mapped) = mapper(raw)
    {
        return Ok(mapped);
    }
    raw.parse::<u32>()
        .map_err(|_| TemporalError::InvalidCron(format!("invalid cron token `{raw}`")))
}
