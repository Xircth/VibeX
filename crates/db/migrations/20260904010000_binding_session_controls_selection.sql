-- Persist the user's explicit session-control selection on the Agent binding.
-- `current_mode` already existed but only ever mirrored what the Agent broadcast,
-- so a cold `session/new` (crash, rebind, lost connection) silently reverted the
-- conversation to the Agent's default mode. Recording the selection lets the Host
-- replay it after any session (re)establishment.
ALTER TABLE conversation_agent_bindings
    ADD COLUMN config_selection_json TEXT NOT NULL DEFAULT '{}';
