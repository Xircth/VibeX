-- Multi-agent delegation: link a child (delegated) session back to its parent.
--   parent_session_id  : the parent `sessions.id` that delegated this child (NULL = root session)
--   parent_tool_use_id : the parent's `delegate_to_agent` tool-call id (UI lookup key)
--   delegation_call_id : the broker's internal task UUID (status-recovery lookup key)
-- All nullable: a regular (non-delegated) session leaves them NULL. ON DELETE SET NULL
-- orphans children to roots rather than destroying their work when a parent is removed.
ALTER TABLE sessions ADD COLUMN parent_session_id BLOB REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN parent_tool_use_id TEXT;
ALTER TABLE sessions ADD COLUMN delegation_call_id TEXT;

CREATE INDEX idx_sessions_parent_session_id
    ON sessions(parent_session_id)
    WHERE parent_session_id IS NOT NULL;

CREATE INDEX idx_sessions_delegation_call_id
    ON sessions(delegation_call_id)
    WHERE delegation_call_id IS NOT NULL;
