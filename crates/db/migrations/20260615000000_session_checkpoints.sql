-- Per-prompt git checkpoints for ACP agent sessions.
--
-- Before each agent prompt is sent, the worktree HEAD of every repo is recorded
-- here under the next `ordinal` for the session. A retry can then restore the
-- worktree to the checkpoint taken before the Nth user message (the Nth ordinal)
-- and resend it. ACP transcripts are append-only, so this restores files only --
-- it does not truncate the conversation.
CREATE TABLE IF NOT EXISTS session_checkpoints (
    id BLOB PRIMARY KEY,
    session_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    repo_id BLOB NOT NULL,
    before_head_commit TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX IF NOT EXISTS idx_session_checkpoints_session_ordinal
    ON session_checkpoints (session_id, ordinal);
