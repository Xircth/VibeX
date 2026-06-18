-- Materialized conversation projection snapshot.
--
-- Root-cause fix for the event-sourcing read amplification (架构报告 A-3 / 代码报告 §5.1):
-- timeline reads previously replayed the full event log (O(events)) on every call,
-- so "the longer the conversation, the slower it gets". This table stores the folded
-- projection state up to `last_sequence`, letting reads load the snapshot and replay
-- only the tail (events_since last_sequence) instead of the whole log.
--
-- One snapshot per conversation. `fold_json` is the serialized projection fold state
-- (turns + side rows + last_sequence). `projection_version` lets a version bump
-- invalidate stale snapshots and trigger a rebuild from the authoritative event log.

CREATE TABLE conversation_projection_snapshots (
    conversation_id BLOB PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    projection_version INTEGER NOT NULL,
    last_sequence INTEGER NOT NULL,
    fold_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);
