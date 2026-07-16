-- agent_setting was seeded with two-word keys (open_code / open_claw) while the
-- system-wide AgentKind canonical keys are one-word (opencode / openclaw). The
-- registry IPC serializes canonical keys and the frontend joins settings rows by
-- string equality, so the legacy rows never matched (settings page showed the
-- agents as unmanaged while pickers fell back to permissive defaults).
-- Converge stored rows on the canonical keys; if a canonical row already exists,
-- keep it and drop the legacy row instead of violating the UNIQUE constraint.
DELETE FROM agent_setting
WHERE agent_type = 'open_code'
  AND EXISTS (SELECT 1 FROM agent_setting WHERE agent_type = 'opencode');
UPDATE agent_setting
SET agent_type = 'opencode', updated_at = datetime('now')
WHERE agent_type = 'open_code';

DELETE FROM agent_setting
WHERE agent_type = 'open_claw'
  AND EXISTS (SELECT 1 FROM agent_setting WHERE agent_type = 'openclaw');
UPDATE agent_setting
SET agent_type = 'openclaw', updated_at = datetime('now')
WHERE agent_type = 'open_claw';
