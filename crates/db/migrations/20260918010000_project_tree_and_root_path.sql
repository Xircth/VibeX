-- Project identity is a folder. Git is optional.
-- Tree membership is parent_project_id. Hidden projects stay in the DB
-- with sessions intact so the same path can be reopened.

ALTER TABLE projects ADD COLUMN root_path TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN parent_project_id BLOB REFERENCES projects(id);
ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

UPDATE projects
SET root_path = COALESCE(
    (
        SELECT r.path
        FROM project_repos pr
        JOIN repos r ON r.id = pr.repo_id
        WHERE pr.project_id = projects.id
        ORDER BY pr.rowid
        LIMIT 1
    ),
    ''
)
WHERE root_path = '';

CREATE INDEX idx_projects_parent_project_id ON projects(parent_project_id);
CREATE INDEX idx_projects_hidden ON projects(hidden);

CREATE UNIQUE INDEX idx_projects_visible_root_path
ON projects(root_path)
WHERE hidden = 0 AND root_path != '';
