-- Historical DM messages only exist in conversation_events. Intervals before
-- cutover continue projecting from conversation_events; intervals after cutover
-- project from collaboration_space_messages.
ALTER TABLE collaboration_threads ADD COLUMN space_cutover_seq INTEGER;
ALTER TABLE collaboration_threads ADD COLUMN space_cutover_at TEXT;

CREATE INDEX collaboration_space_messages_direct
  ON collaboration_space_messages(space_id, seq);
