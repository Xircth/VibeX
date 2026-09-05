-- Incremental vendor-log read model (ADR-0075).
-- File stamps skip unchanged Claude / Codex jsonl; session rows are the
-- dashboard's vendor_log supplement, aligned later by external_session_id.

CREATE TABLE vendor_usage_files (
    path TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    scanned_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_vendor_usage_files_provider
    ON vendor_usage_files(provider);

CREATE TABLE vendor_usage_sessions (
    provider TEXT NOT NULL,
    external_session_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_write_tokens INTEGER,
    cache_read_tokens INTEGER,
    total_tokens INTEGER,
    cost REAL,
    summary TEXT,
    scanned_at_ms INTEGER NOT NULL,
    PRIMARY KEY (provider, external_session_id)
);

CREATE INDEX idx_vendor_usage_sessions_path
    ON vendor_usage_sessions(source_path);

CREATE INDEX idx_vendor_usage_sessions_timestamp
    ON vendor_usage_sessions(timestamp);
