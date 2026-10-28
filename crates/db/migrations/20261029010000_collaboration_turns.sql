-- Collaboration turn ledger (P0-1) and 7-state receipts (P0-2).
-- A turn is created only after a delivery obtains an input_id. Sweeper
-- finishes overdue running turns as timed_out so in-flight slots free.
--
-- receipt_state CHECK cannot be ALTER'd on SQLite: drop the processing
-- trigger, rebuild collaboration_space_deliveries with the expanded
-- CHECK, then recreate indexes and the trigger. `failed` is not stored
-- in receipt_state; list_message_receipts derives it from status='failed'.
--
-- Rollback: DROP TABLE collaboration_turns; rebuild
-- collaboration_space_deliveries without turn_id and with the original
-- receipt_state CHECK ('queued','processing','replied'); recreate
-- collaboration_receipt_processing as in 20261024030000.

CREATE TABLE collaboration_turns (
  id                TEXT PRIMARY KEY NOT NULL,
  space_id          TEXT NOT NULL,
  space_message_id  TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('pending','running','finished')),
  outcome           TEXT CHECK (outcome IN ('sent','pass','timed_out','cancelled','error')),
  deadline_at       TEXT NOT NULL,
  parent_turn_id    TEXT,
  root_turn_id      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Same delivery has at most one unfinished turn; finished rows stay auditable.
CREATE UNIQUE INDEX collaboration_turns_open
  ON collaboration_turns(space_message_id, conversation_id)
  WHERE state <> 'finished';
CREATE INDEX collaboration_turns_due ON collaboration_turns(state, deadline_at);
CREATE INDEX collaboration_turns_conversation ON collaboration_turns(conversation_id, state);

ALTER TABLE collaboration_space_deliveries ADD COLUMN turn_id TEXT;
CREATE INDEX collaboration_space_deliveries_turn
  ON collaboration_space_deliveries(turn_id);

DROP TRIGGER IF EXISTS collaboration_receipt_processing;

PRAGMA foreign_keys = OFF;

CREATE TABLE collaboration_space_deliveries_new (
  space_message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  input_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','dispatched','failed')),
  receipt_state TEXT NOT NULL DEFAULT 'queued'
    CHECK (receipt_state IN ('queued','processing','replied','passed','timed_out','cancelled')),
  receipt_updated_at TEXT,
  context_from_seq INTEGER,
  wake_deferred_turn_key TEXT,
  wake_deferred_at TEXT,
  turn_id TEXT,
  PRIMARY KEY (space_message_id, conversation_id)
);

INSERT INTO collaboration_space_deliveries_new (
  space_message_id,
  conversation_id,
  operation_id,
  input_id,
  status,
  receipt_state,
  receipt_updated_at,
  context_from_seq,
  wake_deferred_turn_key,
  wake_deferred_at,
  turn_id
)
SELECT
  space_message_id,
  conversation_id,
  operation_id,
  input_id,
  status,
  receipt_state,
  receipt_updated_at,
  context_from_seq,
  wake_deferred_turn_key,
  wake_deferred_at,
  turn_id
FROM collaboration_space_deliveries;

DROP TABLE collaboration_space_deliveries;
ALTER TABLE collaboration_space_deliveries_new RENAME TO collaboration_space_deliveries;

CREATE INDEX IF NOT EXISTS collaboration_space_deliveries_input
  ON collaboration_space_deliveries(input_id);
CREATE INDEX IF NOT EXISTS collaboration_space_deliveries_turn
  ON collaboration_space_deliveries(turn_id);

CREATE TRIGGER collaboration_receipt_processing
AFTER UPDATE OF status ON conversation_inputs
WHEN NEW.status = 'dispatched'
BEGIN
  UPDATE collaboration_space_deliveries
    SET receipt_state = 'processing',
        receipt_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE receipt_state = 'queued'
      AND input_id = lower(
        substr(hex(NEW.id), 1, 8) || '-' || substr(hex(NEW.id), 9, 4) || '-' ||
        substr(hex(NEW.id), 13, 4) || '-' || substr(hex(NEW.id), 17, 4) || '-' ||
        substr(hex(NEW.id), 21, 12));
END;

PRAGMA foreign_keys = ON;
