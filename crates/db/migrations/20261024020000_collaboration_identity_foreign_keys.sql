-- Member identity: cascade bindings, activity and facts with their member /
-- thread. SQLite cannot add a FOREIGN KEY to an existing table, so the three
-- child tables are rebuilt. Rows that already point at a missing member or
-- thread are orphans and are dropped during the copy.
--
-- Rollback: rebuild the three tables without the REFERENCES clauses (same
-- columns), i.e. the definitions in 20261024010000.

CREATE TABLE collaboration_thread_members_v2 (
  thread_id TEXT NOT NULL REFERENCES collaboration_threads(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES collaboration_members(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL UNIQUE,
  last_seen_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, member_id)
);
INSERT INTO collaboration_thread_members_v2
  SELECT tm.thread_id, tm.member_id, tm.conversation_id, tm.last_seen_message_id, tm.status, tm.joined_at
  FROM collaboration_thread_members tm
  WHERE EXISTS (SELECT 1 FROM collaboration_threads t WHERE t.id = tm.thread_id)
    AND EXISTS (SELECT 1 FROM collaboration_members m WHERE m.id = tm.member_id);
DROP TABLE collaboration_thread_members;
ALTER TABLE collaboration_thread_members_v2 RENAME TO collaboration_thread_members;
CREATE INDEX collaboration_thread_members_member
  ON collaboration_thread_members(member_id);

CREATE TABLE member_activity_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL REFERENCES collaboration_members(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES collaboration_threads(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO member_activity_v2
  SELECT a.id, a.member_id, a.thread_id, a.summary, a.created_at
  FROM member_activity a
  WHERE EXISTS (SELECT 1 FROM collaboration_threads t WHERE t.id = a.thread_id)
    AND EXISTS (SELECT 1 FROM collaboration_members m WHERE m.id = a.member_id);
DROP TABLE member_activity;
ALTER TABLE member_activity_v2 RENAME TO member_activity;
CREATE INDEX member_activity_member_created
  ON member_activity(member_id, created_at);

CREATE TABLE member_facts_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id TEXT NOT NULL REFERENCES collaboration_members(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'private') OR scope LIKE 'thread:_%'),
  source_thread_id TEXT REFERENCES collaboration_threads(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL
);
INSERT INTO member_facts_v2
  SELECT f.id, f.member_id, f.content, f.scope, f.source_thread_id, f.updated_at
  FROM member_facts f
  WHERE EXISTS (SELECT 1 FROM collaboration_members m WHERE m.id = f.member_id)
    AND (f.source_thread_id IS NULL
         OR EXISTS (SELECT 1 FROM collaboration_threads t WHERE t.id = f.source_thread_id));
DROP TABLE member_facts;
ALTER TABLE member_facts_v2 RENAME TO member_facts;
CREATE INDEX member_facts_member_scope
  ON member_facts(member_id, scope);
