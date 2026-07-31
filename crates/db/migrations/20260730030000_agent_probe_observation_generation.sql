ALTER TABLE agent_probe
    ADD COLUMN observation_generation INTEGER NOT NULL DEFAULT 0
        CHECK (observation_generation >= 0);

-- Existing rows already represent one completed observation.
UPDATE agent_probe
SET observation_generation = 1;
