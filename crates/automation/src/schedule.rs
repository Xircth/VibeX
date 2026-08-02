use chrono::{DateTime, Datelike, LocalResult, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScheduleSpec {
    Manual,
    Schedule { cron: String, timezone: String },
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ScheduleError {
    #[error("invalid cron expression: {0}")]
    InvalidCron(String),
    #[error("invalid IANA timezone: {0}")]
    InvalidTimezone(String),
}

pub trait Clock: Clone + Send + Sync + 'static {
    fn now(&self) -> DateTime<Utc>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

#[derive(Clone, Debug)]
pub struct ScheduleService<C> {
    clock: C,
}

impl<C> ScheduleService<C>
where
    C: Clock,
{
    pub fn new(clock: C) -> Self {
        Self { clock }
    }

    pub fn preview(
        &self,
        spec: &ScheduleSpec,
        count: usize,
    ) -> Result<Vec<DateTime<Utc>>, ScheduleError> {
        let mut cursor = self.clock.now();
        let mut occurrences = Vec::with_capacity(count.min(100));
        for _ in 0..count.min(100) {
            let Some(next) = next_run_after(spec, cursor)? else {
                break;
            };
            occurrences.push(next);
            cursor = next;
        }
        Ok(occurrences)
    }

    pub fn preview_if_enabled(
        &self,
        spec: &ScheduleSpec,
        enabled: bool,
        count: usize,
    ) -> Result<Vec<DateTime<Utc>>, ScheduleError> {
        if !enabled {
            return Ok(Vec::new());
        }
        self.preview(spec, count)
    }
}

impl ScheduleError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidCron(_) => "automation_invalid_cron",
            Self::InvalidTimezone(_) => "automation_invalid_timezone",
        }
    }
}

pub fn next_run_after(
    spec: &ScheduleSpec,
    after: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, ScheduleError> {
    let ScheduleSpec::Schedule { cron, timezone } = spec else {
        return Ok(None);
    };
    let schedule = CronSchedule::parse(cron)?;
    let timezone = timezone
        .parse::<Tz>()
        .map_err(|_| ScheduleError::InvalidTimezone(timezone.clone()))?;
    let mut cursor = after.with_timezone(&timezone).naive_local();

    for _ in 0..8 {
        let Some(next_local) = schedule.next_after(cursor) else {
            return Ok(None);
        };
        match timezone.from_local_datetime(&next_local) {
            LocalResult::Single(next) => return Ok(Some(next.with_timezone(&Utc))),
            LocalResult::Ambiguous(first, second) => {
                let first = first.with_timezone(&Utc);
                let second = second.with_timezone(&Utc);
                return Ok(Some(first.min(second)));
            }
            LocalResult::None => cursor = next_local,
        }
    }
    Ok(None)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CronSchedule {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days_of_month: Vec<u32>,
    months: Vec<u32>,
    days_of_week: Vec<u32>,
    dom_restricted: bool,
    dow_restricted: bool,
}

impl CronSchedule {
    fn parse(expression: &str) -> Result<Self, ScheduleError> {
        let fields = expression.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 5 {
            return Err(ScheduleError::InvalidCron(format!(
                "expected 5 fields, got {}",
                fields.len()
            )));
        }
        Ok(Self {
            minutes: parse_field(fields[0], 0, 59)?,
            hours: parse_field(fields[1], 0, 23)?,
            days_of_month: parse_field(fields[2], 1, 31)?,
            months: parse_field(fields[3], 1, 12)?,
            days_of_week: parse_day_of_week(fields[4])?,
            dom_restricted: fields[2] != "*",
            dow_restricted: fields[4] != "*",
        })
    }

    fn matches(&self, candidate: NaiveDateTime) -> bool {
        if !self.minutes.contains(&candidate.minute())
            || !self.hours.contains(&candidate.hour())
            || !self.months.contains(&candidate.month())
        {
            return false;
        }
        let day_of_month = self.days_of_month.contains(&candidate.day());
        let day_of_week = self
            .days_of_week
            .contains(&candidate.weekday().num_days_from_sunday());
        match (self.dom_restricted, self.dow_restricted) {
            (true, true) => day_of_month || day_of_week,
            (true, false) => day_of_month,
            (false, true) => day_of_week,
            (false, false) => true,
        }
    }

    fn next_after(&self, after: NaiveDateTime) -> Option<NaiveDateTime> {
        const GREGORIAN_SEARCH_YEARS: usize = 8;
        const MINUTES_PER_LEAP_YEAR: usize = 366 * 24 * 60;
        let mut candidate = after
            .with_second(0)?
            .with_nanosecond(0)?
            .checked_add_signed(chrono::Duration::minutes(1))?;
        for _ in 0..(GREGORIAN_SEARCH_YEARS * MINUTES_PER_LEAP_YEAR) {
            if self.matches(candidate) {
                return Some(candidate);
            }
            candidate = candidate.checked_add_signed(chrono::Duration::minutes(1))?;
        }
        None
    }
}

fn parse_day_of_week(field: &str) -> Result<Vec<u32>, ScheduleError> {
    let values = parse_field(field, 0, 7)?;
    let mut normalized = values
        .into_iter()
        .map(|value| if value == 7 { 0 } else { value })
        .collect::<Vec<_>>();
    normalized.sort_unstable();
    normalized.dedup();
    Ok(normalized)
}

fn parse_field(field: &str, min: u32, max: u32) -> Result<Vec<u32>, ScheduleError> {
    let mut values = Vec::new();
    for part in field.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((range, raw_step)) => {
                let step = raw_step.parse::<u32>().map_err(|_| {
                    ScheduleError::InvalidCron(format!("invalid step `{raw_step}`"))
                })?;
                if step == 0 {
                    return Err(ScheduleError::InvalidCron(
                        "step must be greater than zero".to_string(),
                    ));
                }
                (range, step)
            }
            None => (part, 1),
        };
        let (start, end) = if range == "*" {
            (min, max)
        } else if let Some((raw_start, raw_end)) = range.split_once('-') {
            (
                parse_value(raw_start, "range start")?,
                parse_value(raw_end, "range end")?,
            )
        } else {
            let value = parse_value(range, "value")?;
            (value, value)
        };
        if start < min || end > max || start > end {
            return Err(ScheduleError::InvalidCron(format!(
                "value out of range [{min}, {max}] in `{part}`"
            )));
        }
        let mut value = start;
        while value <= end {
            values.push(value);
            value += step;
        }
    }
    values.sort_unstable();
    values.dedup();
    if values.is_empty() {
        return Err(ScheduleError::InvalidCron("empty field".to_string()));
    }
    Ok(values)
}

fn parse_value(raw: &str, label: &str) -> Result<u32, ScheduleError> {
    raw.parse::<u32>()
        .map_err(|_| ScheduleError::InvalidCron(format!("invalid {label} `{raw}`")))
}
