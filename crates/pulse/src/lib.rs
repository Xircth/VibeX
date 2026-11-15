//! VibeX AI-Native Event-Driven Automation Engine ("Pulse") domain crate.

pub mod engine;
pub mod filter;
pub mod guard;
pub mod sources;
pub mod temporal;
pub mod validation;
pub mod webhook;

pub use engine::{
    PulseDispatchAction, PulseDispatchPlan, PulseEngine, PulseError, PulseIngestOutcome,
    PulseTemporalTickReport,
};
pub use filter::{
    FilterEvalOutcome, dry_run_rule, evaluate_condition, evaluate_filter_ast, render_template,
    resolve_json_pointer,
};
pub use guard::{
    ChainRateBreaker, DEFAULT_CHAIN_WINDOW_SECS, DEFAULT_MAX_HOP_COUNT,
    DEFAULT_MAX_TRIGGERS_PER_WINDOW, EnvelopeGuardVerdict, GuardError, RateBreakerDecision,
    check_envelope_guard, derive_child_trace, enforce_mandate_origin,
};
pub use sources::{
    CustomSdkEventInput, CustomSdkEventNormalizer, FeishuSourceNormalizer, GitHubSourceNormalizer,
    JiraIssueDigest, JiraPollWatermark, JiraSourceNormalizer, SourceNormalizeError,
};
pub use temporal::{
    ArmedSlaDeadline, InactivitySlaTracker, TemporalError, TemporalEvaluator, TemporalTickOutcome,
    validate_cron_expression,
};
pub use validation::{
    MAX_FILTER_CONDITIONS, REGEX_SIZE_LIMIT_BYTES, compile_bounded_regex, validate_json_pointer,
    validate_rule_spec,
};
pub use webhook::{
    MAX_WEBHOOK_PAYLOAD_BYTES, StandardWebhookHeaders, VerifiedWebhookPayload,
    WEBHOOK_REPLAY_WINDOW_SECS, WEBHOOK_SECRET_PREFIX, WebhookVerifyError, sign_standard_webhook,
    verify_standard_webhook,
};
