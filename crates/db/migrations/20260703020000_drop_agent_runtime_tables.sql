-- Retire the first-generation `agent_*` ACP shadow tables (批次D / ADR-0002).
--
-- `conversation_events` is the single authoritative log; the shadow event sink and
-- the `agent_permissions` snapshot merge are gone. The only durable data worth
-- keeping is `agent_history_imports`, which moves into the canonical
-- `conversation_imports` table (import functionality is retained).

-- Preserve history-import records. New random BLOB ids (the old TEXT ids are not
-- referenced); title / workspace_path / message_count have no column here but are
-- preserved inside raw_json.
INSERT INTO conversation_imports (
    id, source, source_agent, external_session_id, bundle_version,
    raw_source_path, imported_conversation_id, raw_json, imported_at
)
SELECT
    randomblob(16),
    'agent_transcript',
    source_agent,
    external_session_id,
    NULL,
    raw_source_path,
    NULL,
    raw_json,
    imported_at
FROM agent_history_imports;

DROP TABLE IF EXISTS agent_events;
DROP TABLE IF EXISTS agent_permissions;
DROP TABLE IF EXISTS agent_terminals;
DROP TABLE IF EXISTS agent_prompts;
DROP TABLE IF EXISTS agent_sessions;
DROP TABLE IF EXISTS agent_connections;
DROP TABLE IF EXISTS agent_history_imports;
DROP TABLE IF EXISTS agent_installs;
DROP TABLE IF EXISTS agent_config_profiles;
