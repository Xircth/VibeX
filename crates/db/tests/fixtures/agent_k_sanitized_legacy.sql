-- Sanitized from the shape of a pre-Automation-v2 desktop data directory.
-- All names, paths, prompts, and identifiers are synthetic.
INSERT INTO plugins (
    id, name, skill_name, console_command, console_url, hook_message,
    install_command, author, icon, expires_at, notes, install_status,
    install_error, enabled, builtin, created_at, updated_at
) VALUES (
    X'11111111111141118111111111111111',
    'Sanitized external plugin',
    'sanitized-skill',
    'node [redacted]/console.js',
    'http://127.0.0.1:43111',
    'Open the sanitized console',
    'touch __MIGRATION_MARKER__',
    '[redacted]',
    NULL,
    NULL,
    'No production data',
    'installed',
    NULL,
    1,
    0,
    '2026-01-02T03:04:05Z',
    '2026-01-02T03:04:05Z'
);

INSERT INTO automations (
    id, name, project_id, executor, prompt, isolation, trigger_kind, cron,
    enabled, next_run_at, created_at, updated_at, plugin_action_json
) VALUES (
    X'22222222222242228222222222222222',
    'Sanitized in-place automation',
    X'33333333333343338333333333333333',
    'CODEX',
    'Summarize [redacted] without publishing',
    'in_place',
    'cron',
    '15 9 * * 1-5',
    1,
    '2026-01-02T09:15:00Z',
    '2026-01-02T03:04:05Z',
    '2026-01-02T03:04:05Z',
    '{"pluginId":"legacy.office","actionId":"create-document"}'
);

INSERT INTO automation_runs (
    id, automation_id, status, conversation_id, summary, error, seen,
    started_at, finished_at
) VALUES (
    X'44444444444444448444444444444444',
    X'22222222222242228222222222222222',
    'running',
    NULL,
    NULL,
    NULL,
    0,
    '2026-01-02T03:04:05Z',
    NULL
);
