-- Pulse AI-Native Event-Driven Automation Engine core persistence schema.

CREATE TABLE IF NOT EXISTS pulse_sources (
    id                  TEXT PRIMARY KEY NOT NULL,
    kind                TEXT NOT NULL,
    title               TEXT NOT NULL,
    enabled             INTEGER NOT NULL DEFAULT 1,
    healthy             INTEGER NOT NULL DEFAULT 1,
    status_message      TEXT,
    cursor_watermark    TEXT,
    public_webhook_path TEXT,
    config_json         TEXT NOT NULL DEFAULT '{}',
    signing_secret      TEXT,
    received_count_24h  INTEGER NOT NULL DEFAULT 0,
    rejected_count_24h  INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pulse_sources_kind_enabled
    ON pulse_sources (kind, enabled);

CREATE INDEX IF NOT EXISTS idx_pulse_sources_webhook_path
    ON pulse_sources (public_webhook_path)
    WHERE public_webhook_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS pulse_event_receipts (
    source_id     TEXT NOT NULL,
    delivery_id   TEXT NOT NULL,
    event_id      TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    thread_key    TEXT,
    envelope_json TEXT NOT NULL,
    received_at   TEXT NOT NULL,
    PRIMARY KEY (source_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_pulse_event_receipts_received_at
    ON pulse_event_receipts (received_at DESC, event_id DESC);

CREATE INDEX IF NOT EXISTS idx_pulse_event_receipts_thread_key
    ON pulse_event_receipts (thread_key, received_at DESC)
    WHERE thread_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_event_receipts_event_id
    ON pulse_event_receipts (event_id);

CREATE TABLE IF NOT EXISTS pulse_rules (
    id               TEXT PRIMARY KEY NOT NULL,
    revision         INTEGER NOT NULL DEFAULT 1,
    enabled          INTEGER NOT NULL DEFAULT 1,
    draft_only       INTEGER NOT NULL DEFAULT 0,
    mandate_origin   TEXT NOT NULL,
    project_id       TEXT,
    workspace_id     TEXT,
    eval_mode        TEXT NOT NULL,
    spec_json        TEXT NOT NULL,
    webhook_route_id TEXT,
    next_fire_at     TEXT,
    matched_count    INTEGER NOT NULL DEFAULT 0,
    observed_count   INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pulse_rules_enabled_eval
    ON pulse_rules (enabled, draft_only, eval_mode);

CREATE INDEX IF NOT EXISTS idx_pulse_rules_project_id
    ON pulse_rules (project_id)
    WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_rules_next_fire_at
    ON pulse_rules (enabled, draft_only, next_fire_at)
    WHERE next_fire_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_rules_webhook_route_id
    ON pulse_rules (webhook_route_id)
    WHERE webhook_route_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pulse_thread_subscriptions (
    id              TEXT PRIMARY KEY NOT NULL,
    thread_key      TEXT NOT NULL,
    subscriber_kind TEXT NOT NULL,
    subscriber_id   TEXT NOT NULL,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    UNIQUE (thread_key, subscriber_kind, subscriber_id)
);

CREATE INDEX IF NOT EXISTS idx_pulse_thread_subscriptions_lookup
    ON pulse_thread_subscriptions (thread_key, active);

CREATE TABLE IF NOT EXISTS pulse_observed_candidates (
    id            TEXT PRIMARY KEY NOT NULL,
    rule_id       TEXT NOT NULL,
    rule_name     TEXT NOT NULL,
    event_id      TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    source_kind   TEXT NOT NULL,
    thread_key    TEXT,
    summary       TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    occurred_at   TEXT NOT NULL,
    promoted      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pulse_observed_candidates_occurred
    ON pulse_observed_candidates (promoted, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_pulse_observed_candidates_rule
    ON pulse_observed_candidates (rule_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS pulse_bot_mailbox (
    id                 TEXT PRIMARY KEY NOT NULL,
    member_id          TEXT NOT NULL,
    conversation_scope TEXT NOT NULL,
    mailbox_policy     TEXT NOT NULL,
    thread_key         TEXT,
    event_id           TEXT NOT NULL,
    prompt_text        TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'queued',
    created_at         TEXT NOT NULL,
    claimed_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_pulse_bot_mailbox_member_status
    ON pulse_bot_mailbox (member_id, status, created_at ASC);

CREATE TABLE IF NOT EXISTS pulse_user_interactions (
    id                    TEXT PRIMARY KEY NOT NULL,
    rule_id               TEXT,
    workflow_run_id       TEXT,
    step_id               TEXT,
    kind                  TEXT NOT NULL,
    severity              TEXT NOT NULL,
    title                 TEXT NOT NULL,
    body                  TEXT NOT NULL,
    approval_options_json TEXT NOT NULL DEFAULT '[]',
    form_schema_json      TEXT,
    resolution_json       TEXT,
    status                TEXT NOT NULL DEFAULT 'pending',
    sla_deadline_at       TEXT,
    created_at            TEXT NOT NULL,
    resolved_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_pulse_user_interactions_status
    ON pulse_user_interactions (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pulse_user_interactions_sla
    ON pulse_user_interactions (status, sla_deadline_at)
    WHERE sla_deadline_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS pulse_outbox (
    id              TEXT PRIMARY KEY NOT NULL,
    dedupe_key      TEXT NOT NULL UNIQUE,
    target_kind     TEXT NOT NULL,
    payload_json    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pulse_outbox_due
    ON pulse_outbox (status, next_attempt_at ASC);

CREATE TABLE IF NOT EXISTS pulse_event_schemas (
    event_type  TEXT PRIMARY KEY NOT NULL,
    summary     TEXT NOT NULL,
    json_schema TEXT NOT NULL,
    built_in    INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL
);
