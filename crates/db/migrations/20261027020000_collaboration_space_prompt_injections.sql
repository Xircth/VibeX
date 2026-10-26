-- Records that this conversation already received the collaboration
-- opening (persona, rules, tool summary) for a given group. Keyed by
-- conversation × space. `acp_session_id` is the bound ACP thread so a
-- rebuild or resume (new or restored ACP session) can re-inject.

CREATE TABLE collaboration_space_prompt_injections (
  conversation_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  acp_session_id TEXT NOT NULL,
  injected_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, space_id)
);

CREATE INDEX IF NOT EXISTS collaboration_space_prompt_injections_acp
  ON collaboration_space_prompt_injections (conversation_id, acp_session_id);
