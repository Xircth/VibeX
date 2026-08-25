-- Gemini CLI is retired. The built-in slot is Google Antigravity.
-- Child tables reference agent_membership(agent_id) without ON UPDATE CASCADE,
-- so renaming the membership primary key in place fails with SQLITE_CONSTRAINT_FOREIGNKEY.
-- Insert the destination identity first, retarget children, then delete gemini.

DELETE FROM agent_setting
WHERE agent_type = 'gemini'
  AND EXISTS (SELECT 1 FROM agent_setting WHERE agent_type = 'antigravity');
UPDATE agent_setting
SET agent_type = 'antigravity', updated_at = datetime('now')
WHERE agent_type = 'gemini';

INSERT INTO agent_membership (
    agent_id, source, built_in, retired, enabled, position,
    retained_metadata_json, retained_icon_svg, created_at, updated_at
)
SELECT
    'antigravity', source, 1, 0, enabled, position,
    retained_metadata_json, retained_icon_svg, created_at, datetime('now')
FROM agent_membership
WHERE agent_id = 'gemini'
  AND NOT EXISTS (SELECT 1 FROM agent_membership WHERE agent_id = 'antigravity');

DELETE FROM agent_installation
WHERE agent_id = 'gemini'
  AND EXISTS (SELECT 1 FROM agent_installation WHERE agent_id = 'antigravity');
UPDATE agent_installation
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';

DELETE FROM agent_probe
WHERE agent_id = 'gemini'
  AND EXISTS (SELECT 1 FROM agent_probe WHERE agent_id = 'antigravity');
UPDATE agent_probe
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';

DELETE FROM agent_user_definition
WHERE agent_id = 'gemini'
  AND EXISTS (SELECT 1 FROM agent_user_definition WHERE agent_id = 'antigravity');
UPDATE agent_user_definition
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';

DELETE FROM agent_config_binding
WHERE agent_id = 'gemini'
  AND EXISTS (
    SELECT 1 FROM agent_config_binding AS keep
    WHERE keep.agent_id = 'antigravity'
      AND keep.provider_id = agent_config_binding.provider_id
  );
UPDATE agent_config_binding
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';

DELETE FROM agent_session_default
WHERE agent_id = 'gemini'
  AND EXISTS (
    SELECT 1 FROM agent_session_default AS keep
    WHERE keep.agent_id = 'antigravity'
      AND keep.option_id = agent_session_default.option_id
  );
UPDATE agent_session_default
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';

DELETE FROM agent_install_operation
WHERE agent_id = 'gemini'
  AND status IN ('queued', 'running')
  AND EXISTS (
    SELECT 1 FROM agent_install_operation
    WHERE agent_id = 'antigravity' AND status IN ('queued', 'running')
  );
UPDATE agent_install_operation
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';

UPDATE agent_install_lock
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';

UPDATE agent_diagnostic
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';

DELETE FROM agent_membership
WHERE agent_id = 'gemini';

UPDATE sessions
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';
UPDATE sessions
SET agent_type = 'antigravity'
WHERE lower(agent_type) IN ('gemini', 'googleantigravity');

UPDATE conversation_agent_bindings
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';
UPDATE conversation_agent_bindings
SET agent_type = 'antigravity'
WHERE lower(agent_type) IN ('gemini', 'googleantigravity');

DELETE FROM retired_agent_history
WHERE agent_id = 'gemini'
  AND EXISTS (SELECT 1 FROM retired_agent_history WHERE agent_id = 'antigravity');
UPDATE retired_agent_history
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';

DELETE FROM agent_capability_catalog
WHERE agent_type = 'gemini'
  AND EXISTS (
    SELECT 1 FROM agent_capability_catalog AS keep
    WHERE keep.agent_type = 'antigravity'
      AND keep.fingerprint = agent_capability_catalog.fingerprint
  );
UPDATE agent_capability_catalog
SET agent_type = 'antigravity'
WHERE agent_type = 'gemini';

DELETE FROM plugin_agent_bindings_v4
WHERE agent_id = 'gemini'
  AND EXISTS (
    SELECT 1 FROM plugin_agent_bindings_v4 AS keep
    WHERE keep.plugin_id = plugin_agent_bindings_v4.plugin_id
      AND keep.agent_id = 'antigravity'
  );
UPDATE plugin_agent_bindings_v4
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';

DELETE FROM plugin_mcp_bindings_v4
WHERE agent_id = 'gemini'
  AND EXISTS (
    SELECT 1 FROM plugin_mcp_bindings_v4 AS keep
    WHERE keep.plugin_id = plugin_mcp_bindings_v4.plugin_id
      AND keep.mcp_id = plugin_mcp_bindings_v4.mcp_id
      AND keep.agent_id = 'antigravity'
  );
UPDATE plugin_mcp_bindings_v4
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';

DELETE FROM plugin_control_agent_bindings
WHERE agent_id = 'gemini'
  AND EXISTS (
    SELECT 1 FROM plugin_control_agent_bindings AS keep
    WHERE keep.plugin_id = plugin_control_agent_bindings.plugin_id
      AND keep.agent_id = 'antigravity'
  );
UPDATE plugin_control_agent_bindings
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';

DELETE FROM plugin_control_mcp_bindings
WHERE agent_id = 'gemini'
  AND EXISTS (
    SELECT 1 FROM plugin_control_mcp_bindings AS keep
    WHERE keep.plugin_id = plugin_control_mcp_bindings.plugin_id
      AND keep.mcp_id = plugin_control_mcp_bindings.mcp_id
      AND keep.agent_id = 'antigravity'
  );
UPDATE plugin_control_mcp_bindings
SET agent_id = 'antigravity'
WHERE agent_id = 'gemini';
