-- Phase 2: three-state delivery receipts, message origin, and a stable
-- "missed context" window per delivery.
--
-- receipt_state: queued (accepted, waiting for the member's session),
-- processing (the input was handed to a turn), replied (the member posted
-- back into the thread afterwards). Transport `status` is unchanged.
--
-- Rollback: drop the trigger; the added columns are ignored by older builds.

ALTER TABLE collaboration_space_deliveries
  ADD COLUMN receipt_state TEXT NOT NULL DEFAULT 'queued'
  CHECK (receipt_state IN ('queued', 'processing', 'replied'));
ALTER TABLE collaboration_space_deliveries ADD COLUMN receipt_updated_at TEXT;
-- Lower bound (exclusive seq) of group messages packed into this delivery,
-- fixed at first attempt so a retry sends byte-identical text.
ALTER TABLE collaboration_space_deliveries ADD COLUMN context_from_seq INTEGER;

UPDATE collaboration_space_deliveries
  SET receipt_state = 'processing'
  WHERE status = 'dispatched';

CREATE INDEX IF NOT EXISTS collaboration_space_deliveries_input
  ON collaboration_space_deliveries(input_id);

-- A queued input that the conversation queue later dispatches moves its
-- receipt to processing, whatever code path dispatched it.
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

ALTER TABLE collaboration_space_messages
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
  CHECK (origin IN ('user', 'agent'));

UPDATE collaboration_space_messages
  SET origin = 'agent'
  WHERE json_extract(envelope_json, '$.actor') LIKE 'vibex://space/%/member/%';
