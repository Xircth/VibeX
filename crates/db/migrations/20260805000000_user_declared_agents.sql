PRAGMA foreign_keys = OFF;

CREATE TABLE agent_membership_new (
    agent_id TEXT PRIMARY KEY NOT NULL,
    source TEXT NOT NULL CHECK (source IN (
        'built_in_profile', 'official_registry', 'user_definition', 'retired_legacy'
    )),
    built_in INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1)),
    retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    position INTEGER NOT NULL CHECK (position >= 0),
    retained_metadata_json TEXT,
    retained_icon_svg TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO agent_membership_new (
    agent_id, source, built_in, retired, enabled, position,
    retained_metadata_json, retained_icon_svg, created_at, updated_at
)
SELECT agent_id, source, built_in, retired, enabled, position,
       retained_metadata_json, retained_icon_svg, created_at, updated_at
FROM agent_membership;

DROP TABLE agent_membership;
ALTER TABLE agent_membership_new RENAME TO agent_membership;

CREATE INDEX idx_agent_membership_position
    ON agent_membership(position, agent_id);

CREATE TABLE agent_user_definition (
    agent_id TEXT PRIMARY KEY NOT NULL
        REFERENCES agent_membership(agent_id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL,
    version TEXT NOT NULL,
    distribution_kind TEXT NOT NULL
        CHECK (distribution_kind IN ('binary', 'npx', 'uvx')),
    distributions_json TEXT NOT NULL,
    definition_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

PRAGMA foreign_keys = ON;
