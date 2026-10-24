-- Member session config. A member is an aggregate of sessions (one per
-- direct or group thread); every session the member gets *after* this row is
-- written is created from the member's agent (existing `agent` column) plus
-- the mode, config selection (model, permissions, ...) and persona below.
-- Editing these columns never touches sessions that already exist.
--
-- Rollback: the columns are additive and ignored by older builds.

ALTER TABLE collaboration_members ADD COLUMN mode_id TEXT;
ALTER TABLE collaboration_members ADD COLUMN config_values TEXT;
ALTER TABLE collaboration_members ADD COLUMN persona_prompt TEXT;
