-- Add 'interrupted' as a fourth terminal turn status (alongside completed / failed
-- / cancelled). A turn is Interrupted when the host process died while it was
-- in-flight (crash / kill / restart): not an agent error (Failed), not a user
-- request (Cancelled). See ADR-0001 and CONTEXT.md.
--
-- SQLite can't alter a column CHECK in place, so swap the column following the
-- established pattern (see 20250720000000_add_cleanupscript_to_process_type_constraint).

-- 1. Add the replacement column with the widened CHECK.
ALTER TABLE conversation_turns
  ADD COLUMN status_new TEXT NOT NULL DEFAULT 'pending'
    CHECK (status_new IN ('pending','queued','running','blocked',
                          'completed','failed','cancelled',
                          'interrupted'));   -- new terminal state 🎉

-- 2. Copy existing values across.
UPDATE conversation_turns SET status_new = status;

-- 3. Drop the index that mentions the old column.
DROP INDEX IF EXISTS idx_conversation_turns_conversation_status;

-- 4. Remove the old column (requires SQLite 3.35+).
ALTER TABLE conversation_turns DROP COLUMN status;

-- 5. Rename the new column back to the canonical name.
ALTER TABLE conversation_turns RENAME COLUMN status_new TO status;

-- 6. Re-create the index.
CREATE INDEX idx_conversation_turns_conversation_status
    ON conversation_turns(conversation_id, status, ordinal);
