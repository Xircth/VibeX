use automation::{Clock, ScheduleError, ScheduleService, ScheduleSpec, next_run_after};
use chrono::{DateTime, TimeZone, Utc};

#[derive(Clone)]
struct FixedClock(DateTime<Utc>);

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

#[test]
fn schedule_preview_and_engine_share_the_same_utc_result() {
    let schedule = ScheduleSpec::Schedule {
        cron: "0 9 * * *".to_string(),
        timezone: "Asia/Shanghai".to_string(),
    };
    let now = Utc
        .with_ymd_and_hms(2026, 7, 30, 0, 15, 0)
        .single()
        .expect("fixed instant");

    let preview = next_run_after(&schedule, now).expect("preview");
    let scheduler = next_run_after(&schedule, now).expect("scheduler");

    assert_eq!(preview, scheduler);
    assert_eq!(
        preview,
        Some(Utc.with_ymd_and_hms(2026, 7, 30, 1, 0, 0).single().unwrap())
    );
}

#[test]
fn dst_spring_gap_skips_the_nonexistent_wall_clock_occurrence() {
    let clock = FixedClock(Utc.with_ymd_and_hms(2026, 3, 8, 6, 0, 0).single().unwrap());
    let service = ScheduleService::new(clock);
    let schedule = ScheduleSpec::Schedule {
        cron: "30 2 * * *".to_string(),
        timezone: "America/New_York".to_string(),
    };

    let preview = service.preview(&schedule, 1).expect("preview");

    assert_eq!(
        preview,
        vec![Utc.with_ymd_and_hms(2026, 3, 9, 6, 30, 0).single().unwrap()]
    );
}

#[test]
fn dst_fall_ambiguity_chooses_one_deterministic_occurrence() {
    let clock = FixedClock(Utc.with_ymd_and_hms(2026, 11, 1, 4, 0, 0).single().unwrap());
    let service = ScheduleService::new(clock);
    let schedule = ScheduleSpec::Schedule {
        cron: "30 1 * * *".to_string(),
        timezone: "America/New_York".to_string(),
    };

    let preview = service.preview(&schedule, 2).expect("preview");

    assert_eq!(
        preview,
        vec![
            Utc.with_ymd_and_hms(2026, 11, 1, 5, 30, 0)
                .single()
                .unwrap(),
            Utc.with_ymd_and_hms(2026, 11, 2, 6, 30, 0)
                .single()
                .unwrap(),
        ]
    );
}

#[test]
fn manual_and_disabled_automations_have_no_preview() {
    let service = ScheduleService::new(FixedClock(
        Utc.with_ymd_and_hms(2026, 7, 30, 0, 0, 0).single().unwrap(),
    ));
    let scheduled = ScheduleSpec::Schedule {
        cron: "0 9 * * *".to_string(),
        timezone: "UTC".to_string(),
    };

    assert!(
        service
            .preview_if_enabled(&ScheduleSpec::Manual, true, 3)
            .expect("manual preview")
            .is_empty()
    );
    assert!(
        service
            .preview_if_enabled(&scheduled, false, 3)
            .expect("disabled preview")
            .is_empty()
    );
}

#[test]
fn invalid_iana_timezone_returns_a_stable_error() {
    let service = ScheduleService::new(FixedClock(
        Utc.with_ymd_and_hms(2026, 7, 30, 0, 0, 0).single().unwrap(),
    ));
    let schedule = ScheduleSpec::Schedule {
        cron: "0 9 * * *".to_string(),
        timezone: "Local/MachineGuess".to_string(),
    };

    let error = service.preview(&schedule, 1).expect_err("invalid timezone");

    assert!(matches!(error, ScheduleError::InvalidTimezone(_)));
    assert_eq!(error.code(), "automation_invalid_timezone");
}

#[test]
fn leap_day_schedule_searches_beyond_one_year() {
    let clock = FixedClock(Utc.with_ymd_and_hms(2025, 3, 1, 0, 0, 0).single().unwrap());
    let service = ScheduleService::new(clock);
    let schedule = ScheduleSpec::Schedule {
        cron: "0 0 29 2 *".to_string(),
        timezone: "UTC".to_string(),
    };

    assert_eq!(
        service.preview(&schedule, 1).expect("leap-day preview"),
        vec![Utc.with_ymd_and_hms(2028, 2, 29, 0, 0, 0).single().unwrap()]
    );
}
