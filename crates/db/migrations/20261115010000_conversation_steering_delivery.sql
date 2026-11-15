-- Phase 1.3a: Persist steering execution mode and restarted turn id for idempotent steering receipts.
ALTER TABLE conversation_steering ADD COLUMN delivery_mode TEXT NULL;
ALTER TABLE conversation_steering ADD COLUMN restarted_turn_id TEXT NULL;
