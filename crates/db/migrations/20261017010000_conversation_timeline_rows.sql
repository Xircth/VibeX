-- Derived timeline rows for O(window) open and pagination.
--
-- Events remain authoritative. `conversation_projection_snapshots.fold_json`
-- still resumes IncrementalRowProjector. This table is the read model for
-- `project_open` / `project_row_window` so those paths do not deserialize the
-- full fold. Rebuild from the event log when the projection version misses.

CREATE TABLE conversation_timeline_rows (
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sort_index INTEGER NOT NULL,
    row_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    row_json TEXT NOT NULL,
    PRIMARY KEY (conversation_id, row_id)
);

CREATE UNIQUE INDEX idx_conversation_timeline_rows_sort
    ON conversation_timeline_rows (conversation_id, sort_index);

ALTER TABLE conversation_projection_snapshots
    ADD COLUMN total_rows INTEGER NOT NULL DEFAULT 0;

ALTER TABLE conversation_projection_snapshots
    ADD COLUMN session_stats_json TEXT;
