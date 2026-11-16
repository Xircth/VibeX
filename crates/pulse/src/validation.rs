//! Exhaustive (No Fail-Fast) validator for Pulse rule specifications.

use api_types::pulse::{
    GateFilterCondition, GroupDispatchMode, PulseDryRunViolation, PulseRuleSpec, PulseTargetSpec,
    PulseTemporalSpec, SessionTargetMode, UserInteractionKind,
};
use chrono::DateTime;
use chrono_tz::Tz;
use regex::{Regex, RegexBuilder};

use crate::temporal::validate_cron_expression;

pub const MAX_FILTER_CONDITIONS: usize = 128;
pub const REGEX_SIZE_LIMIT_BYTES: usize = 256 * 1024;
pub const MIN_INTERVAL_SECONDS: u32 = 5;
pub const MAX_INTERVAL_SECONDS: u32 = 86_400 * 30;
pub const MIN_SLA_TIMEOUT_SECONDS: u32 = 10;

pub fn compile_bounded_regex(pattern: &str) -> Result<Regex, regex::Error> {
    RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT_BYTES)
        .dfa_size_limit(REGEX_SIZE_LIMIT_BYTES)
        .build()
}

/// Validates an RFC 6901 JSON Pointer used in filter conditions.
pub fn validate_json_pointer(pointer: &str) -> Result<(), (&'static str, &'static str)> {
    let trimmed = pointer.trim();
    if trimmed.is_empty() {
        return Err(("empty_pointer", "JSON Pointer cannot be empty."));
    }
    if !pointer.starts_with('/') {
        return Err((
            "invalid_pointer",
            "RFC 6901 JSON Pointer must begin with '/'.",
        ));
    }

    let mut chars = pointer.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '~' {
            match chars.next() {
                Some('0' | '1') => {}
                _ => {
                    return Err((
                        "invalid_pointer",
                        "Invalid RFC 6901 escape sequence in JSON Pointer (expected ~0 or ~1).",
                    ));
                }
            }
        }
    }

    Ok(())
}

/// Exhaustively validates a `PulseRuleSpec` in a single pass without fail-fast short-circuiting.
pub fn validate_rule_spec(spec: &PulseRuleSpec) -> Vec<PulseDryRunViolation> {
    let mut violations = Vec::new();

    if spec.name.trim().is_empty() {
        violations.push(violation("name", "empty_name", "Rule name is required."));
    }

    if spec.filter.conditions.len() > MAX_FILTER_CONDITIONS {
        violations.push(violation(
            "filter.conditions",
            "too_many_conditions",
            format!(
                "Filter conditions exceed maximum of {MAX_FILTER_CONDITIONS} (got {}).",
                spec.filter.conditions.len()
            ),
        ));
    }

    for (index, condition) in spec.filter.conditions.iter().enumerate() {
        let base = format!("filter.conditions[{index}]");
        match condition {
            GateFilterCondition::Eq { pointer, .. }
            | GateFilterCondition::Neq { pointer, .. }
            | GateFilterCondition::Contains { pointer, .. }
            | GateFilterCondition::Exists { pointer } => {
                check_pointer(&mut violations, &format!("{base}.pointer"), pointer);
            }
            GateFilterCondition::Lt { pointer, value }
            | GateFilterCondition::Lte { pointer, value }
            | GateFilterCondition::Gt { pointer, value }
            | GateFilterCondition::Gte { pointer, value } => {
                check_pointer(&mut violations, &format!("{base}.pointer"), pointer);
                if !value.is_finite() {
                    violations.push(violation(
                        format!("{base}.value"),
                        "non_finite_number",
                        "Comparison threshold must be a finite number.",
                    ));
                }
            }
            GateFilterCondition::InSet { pointer, values } => {
                check_pointer(&mut violations, &format!("{base}.pointer"), pointer);
                if values.is_empty() {
                    violations.push(violation(
                        format!("{base}.values"),
                        "empty_in_set",
                        "InSet condition requires at least one candidate value.",
                    ));
                }
            }
            GateFilterCondition::Regex { pointer, pattern } => {
                check_pointer(&mut violations, &format!("{base}.pointer"), pointer);
                if pattern.is_empty() {
                    violations.push(violation(
                        format!("{base}.pattern"),
                        "invalid_regex",
                        "Regular expression pattern cannot be empty.",
                    ));
                } else if let Err(err) = compile_bounded_regex(pattern) {
                    violations.push(violation(
                        format!("{base}.pattern"),
                        "invalid_regex",
                        err.to_string(),
                    ));
                }
            }
            GateFilterCondition::NotBotActor => {}
        }
    }

    if let Some(temporal) = &spec.temporal {
        validate_temporal_spec(&mut violations, temporal);
    }

    let has_active_callback = spec
        .callback
        .as_ref()
        .is_some_and(|cb| cb.enabled && !cb.destination.trim().is_empty());
    if spec.targets.is_empty() && !has_active_callback {
        violations.push(violation(
            "targets",
            "empty_targets",
            "At least one target or enabled callback is required.",
        ));
    }

    for (index, target) in spec.targets.iter().enumerate() {
        validate_target_spec(&mut violations, index, target);
    }

    violations
}

fn check_pointer(violations: &mut Vec<PulseDryRunViolation>, path: &str, pointer: &str) {
    if let Err((code, msg)) = validate_json_pointer(pointer) {
        violations.push(violation(path, code, msg));
    }
}

fn validate_temporal_spec(
    violations: &mut Vec<PulseDryRunViolation>,
    temporal: &PulseTemporalSpec,
) {
    match temporal {
        PulseTemporalSpec::Cron {
            expression,
            timezone,
            ..
        } => {
            if expression.trim().is_empty() {
                violations.push(violation(
                    "temporal.expression",
                    "empty_cron",
                    "Cron expression is required.",
                ));
            } else if let Err(err) = validate_cron_expression(expression) {
                violations.push(violation(
                    "temporal.expression",
                    "invalid_cron",
                    err.to_string(),
                ));
            }

            if timezone.trim().is_empty() {
                violations.push(violation(
                    "temporal.timezone",
                    "empty_timezone",
                    "IANA timezone is required.",
                ));
            } else if timezone.parse::<Tz>().is_err() {
                violations.push(violation(
                    "temporal.timezone",
                    "invalid_timezone",
                    format!("Unknown IANA timezone '{timezone}'."),
                ));
            }
        }
        PulseTemporalSpec::Once { fire_at } => {
            if fire_at.trim().is_empty() {
                violations.push(violation(
                    "temporal.fireAt",
                    "empty_fire_at",
                    "One-shot fireAt timestamp is required.",
                ));
            } else if DateTime::parse_from_rfc3339(fire_at).is_err() {
                violations.push(violation(
                    "temporal.fireAt",
                    "invalid_fire_at",
                    format!("Invalid RFC 3339 timestamp '{fire_at}'."),
                ));
            }
        }
        PulseTemporalSpec::Interval { every_seconds, .. } => {
            if *every_seconds < MIN_INTERVAL_SECONDS {
                violations.push(violation(
                    "temporal.everySeconds",
                    "interval_too_short",
                    format!("Interval must be at least {MIN_INTERVAL_SECONDS} seconds."),
                ));
            } else if *every_seconds > MAX_INTERVAL_SECONDS {
                violations.push(violation(
                    "temporal.everySeconds",
                    "interval_too_long",
                    format!("Interval cannot exceed {MAX_INTERVAL_SECONDS} seconds."),
                ));
            }
        }
        PulseTemporalSpec::InactivitySla {
            thread_key_prefix,
            timeout_seconds,
            ..
        } => {
            if thread_key_prefix.trim().is_empty() {
                violations.push(violation(
                    "temporal.threadKeyPrefix",
                    "empty_thread_key_prefix",
                    "Inactivity SLA requires a non-empty threadKeyPrefix.",
                ));
            }
            if *timeout_seconds < MIN_SLA_TIMEOUT_SECONDS {
                violations.push(violation(
                    "temporal.timeoutSeconds",
                    "sla_timeout_too_short",
                    format!("SLA timeout must be at least {MIN_SLA_TIMEOUT_SECONDS} seconds."),
                ));
            }
        }
    }
}

fn validate_target_spec(
    violations: &mut Vec<PulseDryRunViolation>,
    index: usize,
    target: &PulseTargetSpec,
) {
    let base = format!("targets[{index}]");
    match target {
        PulseTargetSpec::Session {
            mode,
            agent_id,
            existing_session_id,
            prompt_template,
            ..
        } => {
            if agent_id.trim().is_empty() {
                violations.push(violation(
                    format!("{base}.agentId"),
                    "missing_agent_id",
                    "Session target requires an agentId.",
                ));
            }
            if *mode == SessionTargetMode::ExistingSession
                && existing_session_id
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
            {
                violations.push(violation(
                    format!("{base}.existingSessionId"),
                    "missing_existing_session_id",
                    "Existing session mode requires existingSessionId.",
                ));
            }
            if prompt_template.trim().is_empty() {
                violations.push(violation(
                    format!("{base}.promptTemplate"),
                    "empty_prompt_template",
                    "Prompt template is required.",
                ));
            }
        }
        PulseTargetSpec::Bot {
            member_id,
            prompt_template,
            ..
        } => {
            if member_id.trim().is_empty() {
                violations.push(violation(
                    format!("{base}.memberId"),
                    "missing_member_id",
                    "Bot target requires a memberId.",
                ));
            }
            if prompt_template.trim().is_empty() {
                violations.push(violation(
                    format!("{base}.promptTemplate"),
                    "empty_prompt_template",
                    "Prompt template is required.",
                ));
            }
        }
        PulseTargetSpec::Group {
            space_id,
            dispatch_mode,
            message_template,
        } => {
            if space_id.trim().is_empty() {
                violations.push(violation(
                    format!("{base}.spaceId"),
                    "missing_space_id",
                    "Group target requires a spaceId.",
                ));
            }
            match dispatch_mode {
                GroupDispatchMode::SpecificSeat { member_id } => {
                    if member_id.trim().is_empty() {
                        violations.push(violation(
                            format!("{base}.dispatchMode.memberId"),
                            "missing_member_id",
                            "SpecificSeat dispatch requires a memberId.",
                        ));
                    }
                }
                GroupDispatchMode::MentionSeats { member_id_list, .. } => {
                    if member_id_list.is_empty()
                        || member_id_list.iter().any(|m| m.trim().is_empty())
                    {
                        violations.push(violation(
                            format!("{base}.dispatchMode.memberIds"),
                            "empty_mention_seats",
                            "MentionSeats dispatch requires one or more non-empty memberIds.",
                        ));
                    }
                }
                GroupDispatchMode::ModeratorTriage {
                    moderator_member_id,
                } => {
                    if moderator_member_id.trim().is_empty() {
                        violations.push(violation(
                            format!("{base}.dispatchMode.moderatorMemberId"),
                            "missing_moderator_member_id",
                            "ModeratorTriage dispatch requires a moderatorMemberId.",
                        ));
                    }
                }
                GroupDispatchMode::BroadcastLogOnly => {}
            }
            if message_template.trim().is_empty() {
                violations.push(violation(
                    format!("{base}.messageTemplate"),
                    "empty_message_template",
                    "Message template is required.",
                ));
            }
        }
        PulseTargetSpec::User {
            interaction_kind,
            title_template,
            approval_options,
            form_schema,
            sla_timeout_seconds,
            ..
        } => {
            if title_template.trim().is_empty() {
                violations.push(violation(
                    format!("{base}.titleTemplate"),
                    "empty_title_template",
                    "Title template is required.",
                ));
            }
            if *interaction_kind == UserInteractionKind::Approval {
                if approval_options.is_empty() {
                    violations.push(violation(
                        format!("{base}.approvalOptions"),
                        "empty_approval_options",
                        "Approval interaction requires at least one approval option.",
                    ));
                }
                for (opt_idx, option) in approval_options.iter().enumerate() {
                    if option.id.trim().is_empty() {
                        violations.push(violation(
                            format!("{base}.approvalOptions[{opt_idx}].id"),
                            "empty_option_id",
                            "Approval option id is required.",
                        ));
                    }
                    if option.label.trim().is_empty() {
                        violations.push(violation(
                            format!("{base}.approvalOptions[{opt_idx}].label"),
                            "empty_option_label",
                            "Approval option label is required.",
                        ));
                    }
                }
            }
            if *interaction_kind == UserInteractionKind::AskForm && form_schema.is_none() {
                violations.push(violation(
                    format!("{base}.formSchema"),
                    "missing_form_schema",
                    "AskForm interaction requires a formSchema.",
                ));
            }
            if matches!(sla_timeout_seconds, Some(0)) {
                violations.push(violation(
                    format!("{base}.slaTimeoutSeconds"),
                    "invalid_sla_timeout",
                    "SLA timeout must be greater than zero when specified.",
                ));
            }
        }
        PulseTargetSpec::Workflow {
            workflow_id,
            pinned_version,
            ..
        } => {
            if workflow_id.trim().is_empty() {
                violations.push(violation(
                    format!("{base}.workflowId"),
                    "missing_workflow_id",
                    "Workflow target requires a workflowId.",
                ));
            }
            if *pinned_version == 0 {
                violations.push(violation(
                    format!("{base}.pinnedVersion"),
                    "invalid_pinned_version",
                    "Workflow pinnedVersion must be >= 1.",
                ));
            }
        }
    }
}

fn violation(
    path: impl Into<String>,
    code: impl Into<String>,
    message: impl Into<String>,
) -> PulseDryRunViolation {
    PulseDryRunViolation {
        path: path.into(),
        code: code.into(),
        message: message.into(),
    }
}
