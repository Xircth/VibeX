-- Plugins: "Skill + Web console" integrations (e.g. dashi-ppt, vibe-motion).
-- A plugin is a manifest describing how to install its agent skill and the
-- hook message prefilled into the session composer when the plugin is
-- activated. The AGENT starts the web console itself (the hook hands it the
-- start command, port and URL); VibeX only watches the agreed URL and opens
-- it in the Web Preview once reachable.
CREATE TABLE plugins (
    id              BLOB PRIMARY KEY,
    name            TEXT NOT NULL,
    skill_name      TEXT NOT NULL,
    console_command TEXT NOT NULL,
    -- Optional console URL template; supports the {{port}} placeholder.
    console_url     TEXT,
    -- Hook message template; supports {{pluginName}}/{{skillName}}/{{consoleUrl}}.
    hook_message    TEXT NOT NULL,
    install_command TEXT NOT NULL,
    author          TEXT,
    -- Emoji/short text, or a data: URL for an uploaded image.
    icon            TEXT,
    expires_at      TEXT,
    notes           TEXT,
    install_status  TEXT NOT NULL DEFAULT 'pending'
                       CHECK (install_status IN ('pending','installing','installed','failed')),
    install_error   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
