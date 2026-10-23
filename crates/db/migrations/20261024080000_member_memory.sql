-- Phase 4 memory layer.
-- member_activity: one short "what I did" line per member turn. `private`
-- marks entries from direct (private) threads; they never surface in group
-- threads. `turn_id` makes recording idempotent per turn.
ALTER TABLE member_activity ADD COLUMN conversation_id TEXT;
ALTER TABLE member_activity ADD COLUMN turn_id TEXT;
ALTER TABLE member_activity ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
UPDATE member_activity SET private = 1
  WHERE thread_id IN (SELECT id FROM collaboration_threads WHERE kind = 'direct');
CREATE UNIQUE INDEX member_activity_turn
  ON member_activity(turn_id) WHERE turn_id IS NOT NULL;

ALTER TABLE member_facts ADD COLUMN created_at TEXT;
ALTER TABLE member_facts ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'
  CHECK (origin IN ('agent', 'user', 'distilled'));

-- Distillation cursor: last activity id folded into facts per member.
CREATE TABLE member_memory_distill_state (
  member_id TEXT PRIMARY KEY REFERENCES collaboration_members(id) ON DELETE CASCADE,
  last_activity_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
