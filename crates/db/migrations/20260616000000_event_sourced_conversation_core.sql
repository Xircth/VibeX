-- Event-sourced conversation core.
--
-- `sessions.id` remains the physical VibeX conversation id during the cutover.
-- The new conversation_* tables own durable turns, events, projections, side
-- effects, import/export metadata, and ACP binding state. Agent transcript files
-- are no longer the intended conversation-detail source.

ALTER TABLE sessions ADD COLUMN active_turn_id BLOB;

CREATE TABLE conversation_agent_bindings (
    id BLOB PRIMARY KEY,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL,
    working_dir TEXT NOT NULL,
    acp_session_id TEXT,
    acp_protocol_version TEXT,
    load_supported INTEGER NOT NULL DEFAULT 0,
    resume_supported INTEGER NOT NULL DEFAULT 0,
    close_supported INTEGER NOT NULL DEFAULT 0,
    terminal_supported INTEGER NOT NULL DEFAULT 0,
    additional_directories_supported INTEGER NOT NULL DEFAULT 0,
    prompt_capabilities_json TEXT NOT NULL DEFAULT '{}',
    session_capabilities_json TEXT NOT NULL DEFAULT '{}',
    client_capabilities_json TEXT NOT NULL DEFAULT '{}',
    mcp_servers_json TEXT NOT NULL DEFAULT '[]',
    modes_json TEXT NOT NULL DEFAULT '[]',
    config_options_json TEXT NOT NULL DEFAULT '[]',
    current_mode TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','connecting','ready','recovering','failed','closed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_conversation_agent_bindings_conversation
    ON conversation_agent_bindings(conversation_id, created_at DESC);

CREATE INDEX idx_conversation_agent_bindings_acp_session
    ON conversation_agent_bindings(agent_type, acp_session_id)
    WHERE acp_session_id IS NOT NULL;

CREATE TABLE conversation_turns (
    id BLOB PRIMARY KEY,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    prompt_id TEXT,
    role TEXT NOT NULL DEFAULT 'user_prompt'
        CHECK (role IN ('user_prompt')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','queued','running','blocked','completed','failed','cancelled')),
    text_preview TEXT,
    input_blocks_json TEXT NOT NULL DEFAULT '[]',
    stop_reason TEXT,
    model TEXT,
    usage_json TEXT,
    error_json TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE(conversation_id, ordinal)
);

CREATE INDEX idx_conversation_turns_conversation_status
    ON conversation_turns(conversation_id, status, ordinal);

CREATE INDEX idx_conversation_turns_prompt
    ON conversation_turns(prompt_id)
    WHERE prompt_id IS NOT NULL;

CREATE TABLE conversation_events (
    id BLOB PRIMARY KEY,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id BLOB REFERENCES conversation_turns(id) ON DELETE SET NULL,
    binding_id BLOB REFERENCES conversation_agent_bindings(id) ON DELETE SET NULL,
    connection_id TEXT,
    prompt_id TEXT,
    sequence INTEGER NOT NULL,
    source TEXT NOT NULL
        CHECK (source IN ('user','acp','host','runtime','system','import')),
    event_kind TEXT NOT NULL,
    normalized_json TEXT NOT NULL,
    raw_json TEXT,
    idempotency_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE(conversation_id, sequence),
    UNIQUE(conversation_id, idempotency_key)
        ON CONFLICT IGNORE
);

CREATE INDEX idx_conversation_events_conversation_sequence
    ON conversation_events(conversation_id, sequence);

CREATE INDEX idx_conversation_events_turn_sequence
    ON conversation_events(turn_id, sequence);

CREATE INDEX idx_conversation_events_kind
    ON conversation_events(event_kind);

CREATE TABLE conversation_tool_calls (
    id BLOB PRIMARY KEY,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id BLOB NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
    tool_call_id TEXT NOT NULL,
    title TEXT,
    kind TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','completed','failed','cancelled')),
    raw_input_json TEXT,
    raw_output_json TEXT,
    content_json TEXT,
    locations_json TEXT,
    metadata_json TEXT,
    images_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE(conversation_id, tool_call_id)
);

CREATE INDEX idx_conversation_tool_calls_turn
    ON conversation_tool_calls(turn_id);

CREATE TABLE conversation_file_changes (
    id BLOB PRIMARY KEY,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id BLOB NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
    source TEXT NOT NULL
        CHECK (source IN ('acp_tool','checkpoint_diff','imported')),
    path TEXT NOT NULL,
    change_kind TEXT NOT NULL DEFAULT 'unknown'
        CHECK (change_kind IN ('added','modified','deleted','renamed','unknown')),
    additions INTEGER,
    deletions INTEGER,
    old_path TEXT,
    diff_summary_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_conversation_file_changes_turn
    ON conversation_file_changes(turn_id, path);

CREATE TABLE conversation_permissions (
    id BLOB PRIMARY KEY,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id BLOB NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
    permission_id TEXT NOT NULL,
    title TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    options_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','responded','cancelled')),
    response_json TEXT,
    auto INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    responded_at TEXT,
    UNIQUE(conversation_id, permission_id)
);

CREATE INDEX idx_conversation_permissions_turn_status
    ON conversation_permissions(turn_id, status);

CREATE TABLE conversation_terminals (
    id BLOB PRIMARY KEY,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id BLOB NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
    terminal_id TEXT NOT NULL,
    command TEXT,
    args_json TEXT NOT NULL DEFAULT '[]',
    cwd TEXT,
    status TEXT NOT NULL DEFAULT 'created'
        CHECK (status IN ('created','running','exited','released','failed')),
    output_summary TEXT,
    output_truncated INTEGER NOT NULL DEFAULT 0,
    exit_status_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE(conversation_id, terminal_id)
);

CREATE INDEX idx_conversation_terminals_turn
    ON conversation_terminals(turn_id, status);

CREATE TABLE conversation_attachments (
    id BLOB PRIMARY KEY,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id BLOB REFERENCES conversation_turns(id) ON DELETE SET NULL,
    kind TEXT NOT NULL
        CHECK (kind IN ('image','resource','file','generated_image')),
    uri TEXT NOT NULL,
    title TEXT,
    mime_type TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_conversation_attachments_conversation
    ON conversation_attachments(conversation_id, created_at);

CREATE TABLE conversation_checkpoints (
    id BLOB PRIMARY KEY,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id BLOB REFERENCES conversation_turns(id) ON DELETE SET NULL,
    ordinal INTEGER NOT NULL,
    before_snapshot_json TEXT,
    after_snapshot_json TEXT,
    diff_summary_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    finalized_at TEXT,
    UNIQUE(conversation_id, ordinal)
);

CREATE INDEX idx_conversation_checkpoints_turn
    ON conversation_checkpoints(turn_id);

CREATE TABLE conversation_imports (
    id BLOB PRIMARY KEY,
    source TEXT NOT NULL
        CHECK (source IN ('vibex_bundle','agent_transcript')),
    source_agent TEXT,
    external_session_id TEXT,
    bundle_version TEXT,
    raw_source_path TEXT,
    imported_conversation_id BLOB REFERENCES sessions(id) ON DELETE SET NULL,
    raw_json TEXT NOT NULL DEFAULT '{}',
    imported_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_conversation_imports_imported_conversation
    ON conversation_imports(imported_conversation_id);

CREATE TABLE conversation_exports (
    id BLOB PRIMARY KEY,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    bundle_version TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    manifest_json TEXT NOT NULL DEFAULT '{}',
    exported_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_conversation_exports_conversation
    ON conversation_exports(conversation_id, exported_at DESC);
