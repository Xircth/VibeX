-- Hot-path index shape for conversation_events.
-- UNIQUE(conversation_id, sequence) already covers sequence lookups, so the
-- extra composite is redundant write cost. The global event_kind index is
-- updated on every token and is the wrong shape for latest_of_kind.
DROP INDEX IF EXISTS idx_conversation_events_conversation_sequence;
DROP INDEX IF EXISTS idx_conversation_events_kind;

CREATE INDEX IF NOT EXISTS idx_conversation_events_conversation_kind_sequence
    ON conversation_events(conversation_id, event_kind, sequence DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_file_changes_conversation
    ON conversation_file_changes(conversation_id, path);
