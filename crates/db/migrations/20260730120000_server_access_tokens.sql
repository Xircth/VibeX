CREATE TABLE server_access_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    token_hash BLOB NOT NULL,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE UNIQUE INDEX server_access_tokens_one_active
ON server_access_tokens ((revoked_at IS NULL))
WHERE revoked_at IS NULL;
