ALTER TABLE sessions ADD COLUMN active_agent_binding_id BLOB REFERENCES conversation_agent_bindings(id);
ALTER TABLE sessions ADD COLUMN binding_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN history_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_agent_bindings ADD COLUMN resume_allowed INTEGER NOT NULL DEFAULT 1 CHECK (resume_allowed IN (0, 1));
ALTER TABLE conversation_agent_bindings ADD COLUMN invalidated_reason TEXT;
ALTER TABLE conversation_agent_bindings ADD COLUMN connection_id TEXT;
ALTER TABLE conversation_turns ADD COLUMN agent_binding_id BLOB REFERENCES conversation_agent_bindings(id);

-- A cleared latest binding is a rebind barrier, never an invitation to resume an older row.
UPDATE conversation_agent_bindings SET resume_allowed = 0, invalidated_reason = 'legacy_rebind'
WHERE acp_session_id IS NULL AND status = 'recovering';
UPDATE sessions SET active_agent_binding_id = (
    SELECT b.id FROM conversation_agent_bindings b
    WHERE b.conversation_id = sessions.id
      AND (sessions.agent_id IS NULL OR b.agent_id = sessions.agent_id)
    ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1
);

UPDATE sessions SET external_session_id = NULL
WHERE active_agent_binding_id IN (SELECT id FROM conversation_agent_bindings WHERE resume_allowed = 0);

CREATE TABLE conversation_transcript_segments (
    id BLOB PRIMARY KEY NOT NULL,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    binding_id BLOB REFERENCES conversation_agent_bindings(id),
    state TEXT NOT NULL CHECK (state IN ('active', 'sealed')),
    sealed_length INTEGER,
    digest TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE (conversation_id, ordinal)
);
CREATE UNIQUE INDEX conversation_transcript_one_active
ON conversation_transcript_segments(conversation_id) WHERE state = 'active';
