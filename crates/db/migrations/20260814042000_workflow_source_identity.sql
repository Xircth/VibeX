ALTER TABLE workflow_definition_versions ADD COLUMN source_path TEXT;

CREATE INDEX idx_workflow_versions_source_path
    ON workflow_definition_versions (source_path, created_at DESC);
