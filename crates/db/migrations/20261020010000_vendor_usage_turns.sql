-- Parser generation 2 records usage-bearing turn counts and reads ACP,
-- Kimi, Qoder, and CodeBuddy transcripts. Rows stamped with an older
-- generation are parsed again once, then skipped until the file changes.

ALTER TABLE vendor_usage_files ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;

ALTER TABLE vendor_usage_sessions ADD COLUMN turns INTEGER;
