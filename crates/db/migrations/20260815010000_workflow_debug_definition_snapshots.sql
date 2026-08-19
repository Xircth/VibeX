ALTER TABLE workflow_definition_versions
    ADD COLUMN publication_kind TEXT NOT NULL DEFAULT 'published'
    CHECK (publication_kind IN ('published', 'debug'));

CREATE INDEX idx_workflow_versions_publication
    ON workflow_definition_versions (publication_kind, definition_id, version DESC);
