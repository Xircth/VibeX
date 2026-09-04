-- Aggregated protocol usage read model (ADR-0075).
-- Incrementally upserted from conversation_events.event_kind = 'usage_updated'.
-- Token columns stay NULL when the Agent did not provide a breakdown.
-- context_used / context_window_max are occupancy, never summed into tokens.

CREATE TABLE conversation_usage_snapshots (
    conversation_id BLOB PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    last_sequence INTEGER NOT NULL,
    protocol_input_tokens INTEGER,
    protocol_output_tokens INTEGER,
    protocol_cache_write_tokens INTEGER,
    protocol_cache_read_tokens INTEGER,
    protocol_total_tokens INTEGER,
    context_used INTEGER,
    context_window_max INTEGER,
    protocol_cost_amount REAL,
    protocol_cost_currency TEXT,
    model TEXT,
    last_usage_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_conversation_usage_snapshots_last_usage
    ON conversation_usage_snapshots(last_usage_at);
