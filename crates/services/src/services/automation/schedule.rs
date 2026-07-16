//! A dependency-free 5-field cron evaluator (minute hour day-of-month month
//! day-of-week) over wall-clock `NaiveDateTime`. The caller decides which clock
//! (UTC or a fixed offset) the schedule is evaluated in.
//!
//! Supported per field: `*`, `N`, `a-b` ranges, `a,b,c` lists, `*/n` and
//! `a-b/n` steps. Day-of-week is `0..=6` with `0`/`7` = Sunday. Day-of-month and
//! day-of-week follow the classic Vixie-cron OR rule: when both are restricted a
//! day matches if *either* matches; when only one is restricted, only it applies.

use chrono::{Datelike, NaiveDateTime, Timelike};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronParseError(pub String);

impl std::fmt::Display for CronParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid cron expression: {}", self.0)
    }
}

impl std::error::Error for CronParseError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronSchedule {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days_of_month: Vec<u32>,
    months: Vec<u32>,
    days_of_week: Vec<u32>,
    dom_restricted: bool,
    dow_restricted: bool,
}

impl CronSchedule {
    pub fn parse(expr: &str) -> Result<Self, CronParseError> {
        let fields: Vec<&str> = expr.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(CronParseError(format!(
                "expected 5 fields, got {}",
                fields.len()
            )));
        }
        let minutes = parse_field(fields[0], 0, 59)?;
        let hours = parse_field(fields[1], 0, 23)?;
        let days_of_month = parse_field(fields[2], 1, 31)?;
        let months = parse_field(fields[3], 1, 12)?;
        let days_of_week = parse_dow(fields[4])?;
        Ok(CronSchedule {
            minutes,
            hours,
            days_of_month,
            months,
            days_of_week,
            dom_restricted: fields[2] != "*",
            dow_restricted: fields[4] != "*",
        })
    }

    /// Whether `dt` (truncated to the minute) satisfies the schedule.
    pub fn matches(&self, dt: NaiveDateTime) -> bool {
        if !self.minutes.contains(&dt.minute())
            || !self.hours.contains(&dt.hour())
            || !self.months.contains(&dt.month())
        {
            return false;
        }
        let dom_match = self.days_of_month.contains(&dt.day());
        // chrono weekday: Mon=0..Sun=6 → cron 0=Sun..6=Sat.
        let cron_dow = (dt.weekday().num_days_from_sunday()) % 7;
        let dow_match = self.days_of_week.contains(&cron_dow);
        match (self.dom_restricted, self.dow_restricted) {
            (true, true) => dom_match || dow_match,
            (true, false) => dom_match,
            (false, true) => dow_match,
            (false, false) => true,
        }
    }

    /// The next minute strictly after `after` that matches, searching up to ~366
    /// days ahead. `None` means no match within that horizon (e.g. Feb-30).
    pub fn next_after(&self, after: NaiveDateTime) -> Option<NaiveDateTime> {
        // Start at the next whole minute after `after`.
        let mut candidate = after
            .with_second(0)?
            .with_nanosecond(0)?
            .checked_add_signed(chrono::Duration::minutes(1))?;
        let horizon_minutes = 366 * 24 * 60;
        for _ in 0..horizon_minutes {
            if self.matches(candidate) {
                return Some(candidate);
            }
            candidate = candidate.checked_add_signed(chrono::Duration::minutes(1))?;
        }
        None
    }
}

fn parse_dow(field: &str) -> Result<Vec<u32>, CronParseError> {
    // Normalize 7 → 0 (both mean Sunday) before/after range parsing.
    let values = parse_field(field, 0, 7)?;
    let mut normalized: Vec<u32> = values
        .into_iter()
        .map(|v| if v == 7 { 0 } else { v })
        .collect();
    normalized.sort_unstable();
    normalized.dedup();
    Ok(normalized)
}

fn parse_field(field: &str, min: u32, max: u32) -> Result<Vec<u32>, CronParseError> {
    let mut values = Vec::new();
    for part in field.split(',') {
        let (range_spec, step) = match part.split_once('/') {
            Some((range, step)) => {
                let step: u32 = step
                    .parse()
                    .map_err(|_| CronParseError(format!("invalid step `{step}`")))?;
                if step == 0 {
                    return Err(CronParseError("step must be > 0".into()));
                }
                (range, step)
            }
            None => (part, 1),
        };

        let (lo, hi) = if range_spec == "*" {
            (min, max)
        } else if let Some((a, b)) = range_spec.split_once('-') {
            let a: u32 = a
                .parse()
                .map_err(|_| CronParseError(format!("invalid range start `{a}`")))?;
            let b: u32 = b
                .parse()
                .map_err(|_| CronParseError(format!("invalid range end `{b}`")))?;
            (a, b)
        } else {
            let v: u32 = range_spec
                .parse()
                .map_err(|_| CronParseError(format!("invalid value `{range_spec}`")))?;
            (v, v)
        };

        if lo < min || hi > max || lo > hi {
            return Err(CronParseError(format!(
                "value out of range [{min}, {max}] in `{part}`"
            )));
        }
        let mut v = lo;
        while v <= hi {
            values.push(v);
            v += step;
        }
    }
    values.sort_unstable();
    values.dedup();
    Ok(values)
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;

    use super::*;

    fn dt(y: i32, m: u32, d: u32, h: u32, min: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, min, 0)
            .unwrap()
    }

    #[test]
    fn wrong_field_count_is_error() {
        assert!(CronSchedule::parse("* * * *").is_err());
        assert!(CronSchedule::parse("* * * * * *").is_err());
    }

    #[test]
    fn out_of_range_is_error() {
        assert!(CronSchedule::parse("60 * * * *").is_err());
        assert!(CronSchedule::parse("* 24 * * *").is_err());
        assert!(CronSchedule::parse("* * 0 * *").is_err());
    }

    #[test]
    fn step_matches_every_n_minutes() {
        let s = CronSchedule::parse("*/15 * * * *").unwrap();
        assert!(s.matches(dt(2026, 7, 4, 10, 0)));
        assert!(s.matches(dt(2026, 7, 4, 10, 15)));
        assert!(s.matches(dt(2026, 7, 4, 10, 45)));
        assert!(!s.matches(dt(2026, 7, 4, 10, 20)));
    }

    #[test]
    fn daily_at_fixed_time() {
        let s = CronSchedule::parse("0 9 * * *").unwrap();
        assert!(s.matches(dt(2026, 7, 4, 9, 0)));
        assert!(!s.matches(dt(2026, 7, 4, 9, 1)));
        assert!(!s.matches(dt(2026, 7, 4, 10, 0)));
    }

    #[test]
    fn hour_range() {
        let s = CronSchedule::parse("0 9-17 * * *").unwrap();
        assert!(s.matches(dt(2026, 7, 4, 9, 0)));
        assert!(s.matches(dt(2026, 7, 4, 17, 0)));
        assert!(!s.matches(dt(2026, 7, 4, 18, 0)));
    }

    #[test]
    fn day_of_month_list() {
        let s = CronSchedule::parse("0 0 1,15 * *").unwrap();
        assert!(s.matches(dt(2026, 7, 1, 0, 0)));
        assert!(s.matches(dt(2026, 7, 15, 0, 0)));
        assert!(!s.matches(dt(2026, 7, 2, 0, 0)));
    }

    #[test]
    fn day_of_week_monday() {
        let s = CronSchedule::parse("0 0 * * 1").unwrap();
        // 2026-07-06 is a Monday.
        assert!(s.matches(dt(2026, 7, 6, 0, 0)));
        assert!(!s.matches(dt(2026, 7, 7, 0, 0)));
    }

    #[test]
    fn sunday_accepts_zero_and_seven() {
        let zero = CronSchedule::parse("0 0 * * 0").unwrap();
        let seven = CronSchedule::parse("0 0 * * 7").unwrap();
        // 2026-07-05 is a Sunday.
        assert!(zero.matches(dt(2026, 7, 5, 0, 0)));
        assert!(seven.matches(dt(2026, 7, 5, 0, 0)));
    }

    // Vixie OR-rule: with both DOM and DOW restricted, either match qualifies.
    #[test]
    fn dom_and_dow_both_restricted_is_or() {
        let s = CronSchedule::parse("0 0 13 * 5").unwrap();
        // 2026-07-13 is a Monday → matches via DOM.
        assert!(s.matches(dt(2026, 7, 13, 0, 0)));
        // 2026-07-10 is a Friday → matches via DOW.
        assert!(s.matches(dt(2026, 7, 10, 0, 0)));
        // 2026-07-14 is a Tuesday, not the 13th → no match.
        assert!(!s.matches(dt(2026, 7, 14, 0, 0)));
    }

    #[test]
    fn next_after_within_hour() {
        let s = CronSchedule::parse("0 * * * *").unwrap();
        assert_eq!(
            s.next_after(dt(2026, 7, 4, 10, 30)),
            Some(dt(2026, 7, 4, 11, 0))
        );
    }

    #[test]
    fn next_after_rolls_to_next_day() {
        let s = CronSchedule::parse("0 9 * * *").unwrap();
        assert_eq!(
            s.next_after(dt(2026, 7, 4, 10, 0)),
            Some(dt(2026, 7, 5, 9, 0))
        );
    }

    #[test]
    fn next_after_is_strict() {
        let s = CronSchedule::parse("0 9 * * *").unwrap();
        // Exactly on a matching minute returns the NEXT occurrence, not itself.
        assert_eq!(
            s.next_after(dt(2026, 7, 4, 9, 0)),
            Some(dt(2026, 7, 5, 9, 0))
        );
    }
}
