-- Rename stored plugin ids from the previous brand (`vibex.*`) to `dimo.*`.
--
-- Installed plugins, activation intents, generations and user state are keyed by
-- plugin id. Without this migration an upgrade would see every previously
-- installed plugin as missing and start from an empty catalog, orphaning the
-- user's activation choices, KV storage and secrets.
--
-- The rename is a prefix substitution. Manifest ids were `vibex.<name>` and are
-- now `dimo.<name>`; the one hyphenated id (`vibex-plugin-computer-use`) became
-- `dimo-plugin-computer-use`. Third-party ids that never used the brand prefix
-- are untouched.

UPDATE plugin_v2_registry
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_v2_registry
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_v2_activation
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_v2_activation
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_v2_dependency_state
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_v2_skill_state
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_v2_provider_state
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_control_registry
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_control_activation
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_control_shell_trust
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_control_runtime_refs
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_control_agent_bindings
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_control_mcp_bindings
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_control_audit
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_packages_v4
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_installations_v4
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_activation_intents_v4
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_generations_v4
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_runtime_locks_v4
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_agent_bindings_v4
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_mcp_bindings_v4
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_operations_v4
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_audit_v4
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_conversation_bindings
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_scratch_workspaces
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_kv_storage
SET plugin_id = 'dimo.' || substr(plugin_id, 7)
WHERE plugin_id LIKE 'vibex.%';

UPDATE plugin_v2_dependency_state
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_v2_skill_state
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_v2_provider_state
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_control_registry
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_control_activation
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_control_shell_trust
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_control_runtime_refs
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_control_agent_bindings
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_control_mcp_bindings
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_control_audit
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_packages_v4
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_installations_v4
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_activation_intents_v4
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_generations_v4
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_runtime_locks_v4
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_agent_bindings_v4
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_mcp_bindings_v4
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_operations_v4
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_audit_v4
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_conversation_bindings
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_scratch_workspaces
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_kv_storage
SET plugin_id = 'dimo-plugin-computer-use'
WHERE plugin_id = 'vibex-plugin-computer-use';
