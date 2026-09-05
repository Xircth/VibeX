-- Clear dangling conversation_events.turn_id values that survived while
-- foreign_keys was off, or that raced a turn delete. The column is ON DELETE
-- SET NULL; this backfill restores that invariant for existing rows.
UPDATE conversation_events
SET turn_id = NULL
WHERE turn_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM conversation_turns
    WHERE conversation_turns.id = conversation_events.turn_id
  );
