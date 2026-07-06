-- Automations (P0-3): a saved "start a turn" configuration that runs headlessly,
-- on a cron schedule or on demand, plus a log of each run.
CREATE TABLE IF NOT EXISTS automations (
    id            BLOB PRIMARY KEY NOT NULL,
    name          TEXT NOT NULL,
    project_id    BLOB NOT NULL,
    executor      TEXT,                       -- executor profile id (session.executor)
    prompt        TEXT NOT NULL,
    isolation     TEXT NOT NULL DEFAULT 'in_place'
                    CHECK (isolation IN ('in_place','new_worktree')),
    trigger_kind  TEXT NOT NULL DEFAULT 'manual'
                    CHECK (trigger_kind IN ('manual','cron')),
    cron          TEXT,                        -- 5-field cron, evaluated in local time
    enabled       INTEGER NOT NULL DEFAULT 1,  -- boolean
    next_run_at   TEXT,                        -- RFC3339; recomputed on save/fire
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automations_due
    ON automations(enabled, trigger_kind, next_run_at);

CREATE TABLE IF NOT EXISTS automation_runs (
    id              BLOB PRIMARY KEY NOT NULL,
    automation_id   BLOB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','completed','failed','interrupted')),
    conversation_id BLOB,
    summary         TEXT,
    error           TEXT,
    seen            INTEGER NOT NULL DEFAULT 0,  -- boolean: failure badge dismissed
    started_at      TEXT NOT NULL,
    finished_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
    ON automation_runs(automation_id, started_at);
