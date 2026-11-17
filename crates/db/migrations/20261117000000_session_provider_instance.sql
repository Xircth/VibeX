-- Persist the selected agent provider instance on each session (`NULL` = implicit "local" instance).
ALTER TABLE sessions ADD COLUMN provider_instance_id TEXT;
