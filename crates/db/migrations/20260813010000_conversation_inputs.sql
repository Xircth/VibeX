-- Durable conversation input queue (ADR-0044).
--
-- The event log remains authoritative. This table is the rebuildable claim/read
-- projection used to coordinate dispatchers without holding an in-memory queue.

CREATE TABLE conversation_inputs (
    id BLOB PRIMARY KEY,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    operation_id BLOB NOT NULL,
    payload_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    principal_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    sort_key INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','claimed','dispatched','cancelled')),
    claim_token BLOB,
    claim_deadline TEXT,
    turn_id BLOB REFERENCES conversation_turns(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE(conversation_id, operation_id)
);

CREATE INDEX idx_conversation_inputs_queue
    ON conversation_inputs(conversation_id, status, sort_key, created_at);

CREATE INDEX idx_conversation_inputs_stale_claim
    ON conversation_inputs(status, claim_deadline)
    WHERE status = 'claimed' AND turn_id IS NULL;
