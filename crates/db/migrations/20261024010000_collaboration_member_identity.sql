-- Member identity (phase 1). A member is an identity; each (member x thread)
-- owns exactly one underlying conversation, so the same member can sit in a
-- direct thread and many group threads without sharing a turn queue.
--
-- Existing rows are backfilled by the idempotent Rust step
-- `db::models::collaboration_identity::MemberIdentityMigration::run`, which
-- runs right after the SQL migrations.
--
-- Rollback: the tables below are purely additive. Dropping them (in reverse
-- order) restores the previous schema. The backfill only rewrites
-- collaboration_space_members.conversation_id for a conversation that sat in
-- more than one space; those rows then point at ordinary, valid sessions, so
-- older builds keep working. See docs/collaboration-member-identity.md.

CREATE TABLE IF NOT EXISTS collaboration_members (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT,
  role_id TEXT,
  agent TEXT,
  model TEXT,
  created_at TEXT NOT NULL
);

-- Group threads reuse the collaboration space id, so messages, deliveries and
-- collection items stay keyed by the same string.
CREATE TABLE IF NOT EXISTS collaboration_threads (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  title TEXT NOT NULL DEFAULT '',
  workspace_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collaboration_thread_members (
  thread_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL UNIQUE,
  last_seen_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, member_id)
);

CREATE INDEX IF NOT EXISTS collaboration_thread_members_member
  ON collaboration_thread_members(member_id);

CREATE TABLE IF NOT EXISTS member_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS member_activity_member_created
  ON member_activity(member_id, created_at);

CREATE TABLE IF NOT EXISTS member_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL,
  content TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'private') OR scope LIKE 'thread:_%'),
  source_thread_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS member_facts_member_scope
  ON member_facts(member_id, scope);
