-- Workspace supervisor (主管 / 总管) identity flag on collaboration_members.
-- At most one active member per workspace is marked `is_supervisor = 1`.
-- Backfill the earliest created `Master` member in each workspace that does not
-- yet have a supervisor.

ALTER TABLE collaboration_members
  ADD COLUMN is_supervisor INTEGER NOT NULL DEFAULT 0;

UPDATE collaboration_members
SET is_supervisor = 1
WHERE id IN (
  SELECT (
    SELECT m.id
    FROM collaboration_members m
    JOIN collaboration_thread_members tm ON tm.member_id = m.id AND tm.status = 'active'
    JOIN collaboration_threads t ON t.id = tm.thread_id
    WHERE t.workspace_id = ws.workspace_id
      AND LOWER(TRIM(m.name)) = 'master'
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT 1
  )
  FROM (
    SELECT DISTINCT workspace_id
    FROM collaboration_threads
    WHERE workspace_id IS NOT NULL
  ) ws
  WHERE NOT EXISTS (
    SELECT 1
    FROM collaboration_members m2
    JOIN collaboration_thread_members tm2 ON tm2.member_id = m2.id AND tm2.status = 'active'
    JOIN collaboration_threads t2 ON t2.id = tm2.thread_id
    WHERE t2.workspace_id = ws.workspace_id AND m2.is_supervisor = 1
  )
);
