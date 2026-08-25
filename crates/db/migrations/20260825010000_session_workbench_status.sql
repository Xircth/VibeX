-- Workbench grouping is derived from the latest turn, queued inputs, and
-- whether that turn was viewed in the execution or monitor area.
ALTER TABLE sessions ADD COLUMN last_viewed_turn_id BLOB;

-- Sessions that finished a turn but were left in `inprogress` (the previous
-- start-turn write never moved them on) belong in review, unless the user
-- cancelled the latest turn with nothing queued.
UPDATE sessions
SET status = CASE
    WHEN (
        SELECT t.status
        FROM conversation_turns t
        WHERE t.conversation_id = sessions.id
        ORDER BY t.ordinal DESC
        LIMIT 1
    ) = 'cancelled'
    AND NOT EXISTS (
        SELECT 1
        FROM conversation_inputs i
        WHERE i.conversation_id = sessions.id
          AND i.status = 'queued'
    ) THEN 'done'
    ELSE 'inreview'
END
WHERE status = 'inprogress'
  AND deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM conversation_turns t
      WHERE t.conversation_id = sessions.id
        AND t.status IN ('pending', 'queued', 'running', 'blocked')
  )
  AND EXISTS (
      SELECT 1
      FROM conversation_turns t
      WHERE t.conversation_id = sessions.id
  );
