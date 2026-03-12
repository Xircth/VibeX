-- Add default_main_branch to projects table
-- This allows projects to specify their default main branch for worktree operations
ALTER TABLE projects ADD COLUMN default_main_branch TEXT DEFAULT NULL;
