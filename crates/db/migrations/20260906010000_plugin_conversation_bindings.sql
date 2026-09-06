-- Plugin-owned Conversation grants. A plugin may only use Conversations it
-- created or that the Host granted (MCP session injection). Deleting the
-- Conversation drops the grant; uninstalling the plugin leaves the Conversation.
CREATE TABLE plugin_conversation_bindings (
    plugin_id TEXT NOT NULL,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    PRIMARY KEY (plugin_id, conversation_id)
);

CREATE INDEX idx_plugin_conversation_bindings_conversation
    ON plugin_conversation_bindings (conversation_id);
