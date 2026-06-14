-- Conversation metadata alignment (codeg model): the `sessions` row IS the
-- conversation. Transcript turns are NOT stored here -- they are re-parsed from
-- the agent CLI session file keyed by (external_session_id, agent_type). These
-- additive columns carry the conversation-level metadata codeg keeps on its
-- `conversation` table: title-lock, pinning, soft-delete, message count, model,
-- and delegation links.

ALTER TABLE sessions ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN pinned_at TEXT;
ALTER TABLE sessions ADD COLUMN deleted_at TEXT;
ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN model TEXT;
ALTER TABLE sessions ADD COLUMN parent_session_id BLOB REFERENCES sessions(id);
ALTER TABLE sessions ADD COLUMN parent_tool_use_id TEXT;
ALTER TABLE sessions ADD COLUMN delegation_call_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_deleted_at ON sessions (deleted_at);
CREATE INDEX IF NOT EXISTS idx_sessions_pinned_at ON sessions (pinned_at);
CREATE INDEX IF NOT EXISTS idx_sessions_parent_session ON sessions (parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_delegation_call ON sessions (delegation_call_id);
