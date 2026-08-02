-- Automation v2 replaces the legacy cron/prompt/executor scheduler. The old
-- tables remain as immutable evidence; no v1 row is executed by the v2 engine.
ALTER TABLE automations RENAME TO automation_v1_legacy;
ALTER TABLE automation_runs RENAME TO automation_run_v1_legacy;

CREATE TABLE automations (
    id                      BLOB PRIMARY KEY NOT NULL,
    name                    TEXT NOT NULL,
    enabled                 INTEGER NOT NULL DEFAULT 0,
    spec_version            INTEGER NOT NULL DEFAULT 1,
    trigger_kind            TEXT NOT NULL
                              CHECK (trigger_kind IN ('manual','schedule')),
    cron                    TEXT,
    timezone                TEXT NOT NULL DEFAULT 'UTC',
    next_run_at             TEXT,
    turn_launch_spec_json   TEXT NOT NULL,
    isolation               TEXT NOT NULL DEFAULT 'worktree_per_run'
                              CHECK (isolation IN ('worktree_per_run','shared_in_root')),
    project_id              BLOB NOT NULL,
    root_folder             TEXT NOT NULL DEFAULT '',
    branch                  TEXT,
    legacy_migration_status TEXT NOT NULL DEFAULT 'ready'
                              CHECK (legacy_migration_status IN ('ready','migration_required')),
    last_run_at             TEXT,
    last_run_status         TEXT,
    last_run_conversation_id BLOB,
    unseen_failure_count    INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
);

CREATE TABLE automation_runs (
    id                       BLOB PRIMARY KEY NOT NULL,
    automation_id            BLOB NOT NULL,
    trigger                   TEXT NOT NULL
                               CHECK (trigger IN ('manual','schedule','catch_up')),
    scheduled_for             TEXT,
    status                    TEXT NOT NULL DEFAULT 'running'
                               CHECK (status IN (
                                   'running','completed','failed','cancelled',
                                   'interrupted','skipped'
                               )),
    conversation_id           BLOB,
    turn_id                   BLOB,
    connection_id             TEXT,
    worktree_workspace_id     BLOB,
    resolved_versions_json    TEXT NOT NULL DEFAULT '{}',
    cancellation_requested    INTEGER NOT NULL DEFAULT 0,
    stop_reason               TEXT,
    summary                   TEXT,
    error                     TEXT,
    seen                      INTEGER NOT NULL DEFAULT 0,
    started_at                TEXT NOT NULL,
    finished_at               TEXT
);

CREATE TABLE automation_legacy_evidence (
    automation_id BLOB PRIMARY KEY NOT NULL,
    evidence_json TEXT NOT NULL,
    captured_at   TEXT NOT NULL
);

CREATE TABLE automation_shared_root_locks (
    root_folder TEXT PRIMARY KEY NOT NULL,
    run_id      BLOB NOT NULL UNIQUE,
    acquired_at TEXT NOT NULL
);

INSERT INTO automation_legacy_evidence (automation_id, evidence_json, captured_at)
SELECT id,
       json_object(
           'id', lower(hex(id)),
           'name', name,
           'project_id', lower(hex(project_id)),
           'executor', executor,
           'prompt', prompt,
           'plugin_action_json', plugin_action_json,
           'isolation', isolation,
           'trigger_kind', trigger_kind,
           'cron', cron,
           'enabled', json(CASE WHEN enabled THEN 'true' ELSE 'false' END),
           'next_run_at', next_run_at,
           'timezone_resolution', 'legacy_local_pending',
           'created_at', created_at,
           'updated_at', updated_at
       ),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM automation_v1_legacy;

INSERT INTO automations (
    id, name, enabled, spec_version, trigger_kind, cron, timezone, next_run_at,
    turn_launch_spec_json, isolation, project_id, root_folder, branch,
    legacy_migration_status, last_run_at, last_run_status,
    last_run_conversation_id, unseen_failure_count, created_at, updated_at
)
SELECT
    id,
    name,
    0,
    1,
    CASE WHEN trigger_kind = 'cron' THEN 'schedule' ELSE 'manual' END,
    cron,
    'UTC',
    NULL,
    json_object(
        'specVersion', 1,
        'promptBlocks', json_array(json_object('type', 'text', 'text', prompt)),
        'displayText', prompt,
        'agent', json_object(
            'agentId', lower(COALESCE(NULLIF(executor, ''), 'codex')),
            'executorProfileId', NULL
        ),
        'modeId', NULL,
        'configValues', json_array(),
        'pluginActions', json_array(),
        'skills', json_array(),
        'workspace', json_object(
            'projectId',
            lower(
                substr(hex(project_id), 1, 8) || '-' ||
                substr(hex(project_id), 9, 4) || '-' ||
                substr(hex(project_id), 13, 4) || '-' ||
                substr(hex(project_id), 17, 4) || '-' ||
                substr(hex(project_id), 21, 12)
            ),
            'rootFolder', '',
            'branch', NULL,
            'isolation',
            CASE
                WHEN isolation = 'new_worktree' THEN 'worktree_per_run'
                ELSE 'shared_in_root'
            END
        ),
        'labelSnapshot', name
    ),
    CASE
        WHEN isolation = 'new_worktree' THEN 'worktree_per_run'
        ELSE 'shared_in_root'
    END,
    project_id,
    '',
    NULL,
    'migration_required',
    NULL,
    NULL,
    NULL,
    0,
    created_at,
    updated_at
FROM automation_v1_legacy;

INSERT INTO automation_runs (
    id, automation_id, trigger, scheduled_for, status, conversation_id,
    turn_id, connection_id, worktree_workspace_id, resolved_versions_json,
    cancellation_requested, stop_reason, summary, error, seen, started_at, finished_at
)
SELECT
    id,
    automation_id,
    'manual',
    NULL,
    CASE WHEN status = 'running' THEN 'interrupted' ELSE status END,
    conversation_id,
    NULL,
    NULL,
    NULL,
    '{}',
    0,
    CASE WHEN status = 'running' THEN 'host_restarted' ELSE NULL END,
    summary,
    error,
    seen,
    started_at,
    CASE
        WHEN status = 'running'
            THEN COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ELSE finished_at
    END
FROM automation_run_v1_legacy;

CREATE INDEX idx_automations_due_v2
    ON automations(enabled, trigger_kind, next_run_at);
CREATE INDEX idx_automation_runs_history_v2
    ON automation_runs(automation_id, started_at DESC);
CREATE UNIQUE INDEX idx_automation_runs_one_active_v2
    ON automation_runs(automation_id)
    WHERE status = 'running';
