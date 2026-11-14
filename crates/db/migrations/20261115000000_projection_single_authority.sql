-- Phase 1.1: SQLite single-authority projection schema foundation.

-- 1. Soft-delete tombstone column on materialized timeline rows
ALTER TABLE conversation_timeline_rows ADD COLUMN deleted_sequence INTEGER NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_timeline_rows_deleted
  ON conversation_timeline_rows (conversation_id, deleted_sequence)
  WHERE deleted_sequence IS NOT NULL;

-- 2. Revision index for incremental catch-up (rows_since)
CREATE INDEX IF NOT EXISTS idx_conversation_timeline_rows_revision
  ON conversation_timeline_rows (conversation_id, revision);

-- 3. Per-turn event index for lossless single-turn cache-miss recovery
CREATE INDEX IF NOT EXISTS idx_conversation_events_turn_seq
  ON conversation_events (conversation_id, turn_id, sequence);

-- 4. Active turn partial index
CREATE INDEX IF NOT EXISTS idx_conversation_turns_active
  ON conversation_turns (conversation_id, status)
  WHERE status IN ('pending', 'queued', 'running', 'blocked');

-- 5. Monotonic non-regressing sequence watermark
ALTER TABLE conversation_projection_snapshots
  ADD COLUMN last_allocated_sequence INTEGER NOT NULL DEFAULT 0;

UPDATE conversation_projection_snapshots
   SET last_allocated_sequence = MAX(
       last_sequence,
       COALESCE(
           (SELECT MAX(e.sequence)
              FROM conversation_events e
             WHERE e.conversation_id = conversation_projection_snapshots.conversation_id),
           0
       )
   );

-- 6. Legacy JSONL lazy backfill state: all pre-existing sessions become 0, while newly created sessions default to 1
ALTER TABLE sessions ADD COLUMN legacy_jsonl_migrated INTEGER NOT NULL DEFAULT 1;
UPDATE sessions SET legacy_jsonl_migrated = 0;

-- 7. Rebuild row-level FTS5 table (replaces whole-conversation single-row FTS5)
DROP TABLE IF EXISTS conversation_fts;
CREATE VIRTUAL TABLE conversation_fts USING fts5(
  conversation_id UNINDEXED,
  row_id UNINDEXED,
  role UNINDEXED,
  text,
  tokenize = 'trigram'
);
