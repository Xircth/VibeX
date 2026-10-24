-- Sidebar (flat group + direct chat list). Additive only.
-- * collaboration_spaces.tag_color: label colour of a group chat.
-- * collaboration_members.color: accent colour of a member avatar.
-- * collaboration_thread_reads: how far the user has read each thread
--   (space message seq), used for the sidebar unread badge.
--
-- Rollback: drop collaboration_thread_reads; the two columns are ignored by
-- older builds.

ALTER TABLE collaboration_spaces ADD COLUMN tag_color TEXT;
ALTER TABLE collaboration_members ADD COLUMN color TEXT;

CREATE TABLE IF NOT EXISTS collaboration_thread_reads (
  thread_id TEXT PRIMARY KEY NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);