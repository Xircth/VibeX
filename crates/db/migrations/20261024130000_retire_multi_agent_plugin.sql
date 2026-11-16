-- Retire standalone multi-agent collaboration plugins ('dimo.multi-agent' and 'dimo.collaboration').
-- Collaboration is now a built-in Host component ('dimo.core.delegation').

DELETE FROM plugin_contributions_v4
WHERE plugin_id IN ('dimo.multi-agent', 'dimo.collaboration');

DELETE FROM plugin_generations_v4
WHERE plugin_id IN ('dimo.multi-agent', 'dimo.collaboration');

DELETE FROM plugin_activation_intents_v4
WHERE plugin_id IN ('dimo.multi-agent', 'dimo.collaboration');

DELETE FROM plugin_runtime_locks_v4
WHERE plugin_id IN ('dimo.multi-agent', 'dimo.collaboration');

DELETE FROM plugin_packages_v4
WHERE plugin_id IN ('dimo.multi-agent', 'dimo.collaboration');

DELETE FROM plugin_kv_storage
WHERE plugin_id IN ('dimo.multi-agent', 'dimo.collaboration');

DELETE FROM plugin_conversation_bindings
WHERE plugin_id IN ('dimo.multi-agent', 'dimo.collaboration');

DELETE FROM plugin_installations_v4
WHERE plugin_id IN ('dimo.multi-agent', 'dimo.collaboration');
