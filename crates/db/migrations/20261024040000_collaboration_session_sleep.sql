-- Phase 2: idle member sessions go to sleep; deliveries that wake a sleeping
-- session are capped per originating turn.
--
-- Rollback: drop collaboration_wake_ledger; the two columns are ignored by
-- older builds.

ALTER TABLE collaboration_thread_members ADD COLUMN last_active_at TEXT;
ALTER TABLE collaboration_thread_members ADD COLUMN asleep_since TEXT;

-- One row per (originating turn, woken conversation). turn_key is
-- `turn:<turn id>` for an agent sender with an active turn, otherwise
-- `message:<space message id>`.
CREATE TABLE collaboration_wake_ledger (
  turn_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  space_message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (turn_key, conversation_id)
);
