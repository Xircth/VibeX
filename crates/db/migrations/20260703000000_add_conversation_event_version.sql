-- Event schema versioning.
--
-- Every conversation event now records the app's event-schema version at write
-- time. Today there is exactly one schema (v1); the column exists so a future
-- reader can *detect* an event written by a newer app version and degrade
-- gracefully (fault-tolerant read-side wrapping in
-- `conversation_projection::conversation_event_from_record`) instead of failing
-- the whole timeline. Existing rows default to 1 — they were all written under v1.
ALTER TABLE conversation_events ADD COLUMN event_version INTEGER NOT NULL DEFAULT 1;
