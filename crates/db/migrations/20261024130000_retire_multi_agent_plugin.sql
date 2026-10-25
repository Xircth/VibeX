-- Retire standalone multi-agent collaboration plugins ('vibex.multi-agent' and 'vibex.collaboration').
-- Collaboration is now a built-in Host component ('vibex.core.delegation').

DELETE FROM plugin_contributions_v4
WHERE plugin_id IN ('vibex.multi-agent', 'vibex.collaboration');

DELETE FROM plugin_generations_v4
WHERE plugin_id IN ('vibex.multi-agent', 'vibex.collaboration');

DELETE FROM plugin_activation_intents_v4
WHERE plugin_id IN ('vibex.multi-agent', 'vibex.collaboration');

DELETE FROM plugin_runtime_locks_v4
WHERE plugin_id IN ('vibex.multi-agent', 'vibex.collaboration');

DELETE FROM plugin_packages_v4
WHERE plugin_id IN ('vibex.multi-agent', 'vibex.collaboration');

DELETE FROM plugin_kv_storage
WHERE plugin_id IN ('vibex.multi-agent', 'vibex.collaboration');

DELETE FROM plugin_conversation_bindings
WHERE plugin_id IN ('vibex.multi-agent', 'vibex.collaboration');

DELETE FROM plugin_installations_v4
WHERE plugin_id IN ('vibex.multi-agent', 'vibex.collaboration');
