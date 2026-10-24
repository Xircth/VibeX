-- Phase 2: structured agent-to-agent handoffs {done, inputs_constraints, ask}
-- with depth and per-turn limits. Every attempt is recorded, including
-- rejected (over-limit) and failed (delivery error) ones.
--
-- Rollback: DROP TABLE collaboration_handoffs.

CREATE TABLE collaboration_handoffs (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL,
  from_conversation_id TEXT NOT NULL,
  to_nickname TEXT NOT NULL,
  to_conversation_id TEXT,
  parent_handoff_id TEXT,
  depth INTEGER NOT NULL CHECK (depth >= 1),
  turn_key TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected', 'failed')),
  reason TEXT,
  message_id TEXT,
  report_message_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX collaboration_handoffs_turn
  ON collaboration_handoffs(turn_key, from_conversation_id, status);
CREATE INDEX collaboration_handoffs_target
  ON collaboration_handoffs(space_id, to_conversation_id, created_at);
