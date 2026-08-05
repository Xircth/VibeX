ALTER TABLE agent_user_definition
ADD COLUMN skills_shared_store INTEGER NOT NULL DEFAULT 0
    CHECK (skills_shared_store IN (0, 1));

ALTER TABLE agent_user_definition
ADD COLUMN skills_directory TEXT;
