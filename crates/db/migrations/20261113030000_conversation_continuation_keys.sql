-- Stage C: continuation key and resume head for native session restoration.
ALTER TABLE conversation_agent_bindings ADD COLUMN continuation_key TEXT;
ALTER TABLE conversation_agent_bindings ADD COLUMN is_resume_head INTEGER NOT NULL DEFAULT 0 CHECK (is_resume_head IN (0, 1));

-- Backfill continuation_key from agent_id + working_dir for existing bindings.
UPDATE conversation_agent_bindings
SET continuation_key = lower(hex(
    -- Simple hash: agent_id || '|' || working_dir. Not cryptographic; identity match only.
    -- SQLite lacks a built-in hash; store the raw composite key and compare by equality.
    agent_id || '|' || working_dir
));

-- Mark the active binding as resume head for each conversation+key.
UPDATE conversation_agent_bindings
SET is_resume_head = 1
WHERE id IN (
    SELECT b.id FROM conversation_agent_bindings b
    INNER JOIN sessions s ON s.id = b.conversation_id
    WHERE s.active_agent_binding_id = b.id
      AND b.resume_allowed = 1
);
