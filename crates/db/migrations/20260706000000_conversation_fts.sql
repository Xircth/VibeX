-- Full-text search index over conversation message text (P1-2).
-- Standalone FTS5 table: `body` is the only indexed column; the rest are stored
-- but UNINDEXED so hits can be filtered by workspace and labelled by title.
-- The `trigram` tokenizer gives case-insensitive SUBSTRING matching that works
-- for CJK (the default unicode61 tokenizer treats a Chinese run as one token);
-- queries must be at least 3 characters to match anything.
-- Kept in sync from the projection (turn settle / truncate / delete) plus a
-- startup backfill; see crates/conversations/src/search.rs.
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
    body,
    conversation_id UNINDEXED,
    workspace_id UNINDEXED,
    title UNINDEXED,
    tokenize = 'trigram'
);
