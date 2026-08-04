CREATE TABLE server_pairing_challenges (
    id TEXT PRIMARY KEY NOT NULL,
    token_hash BLOB NOT NULL UNIQUE,
    scopes_json TEXT NOT NULL,
    created_by_token_id TEXT NOT NULL,
    created_at_unix INTEGER NOT NULL,
    expires_at_unix INTEGER NOT NULL,
    redeemed_at_unix INTEGER
);

CREATE TABLE server_device_credentials (
    id TEXT PRIMARY KEY NOT NULL,
    token_hash BLOB NOT NULL UNIQUE,
    device_name TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    created_at_unix INTEGER NOT NULL,
    revoked_at_unix INTEGER
);

CREATE INDEX server_pairing_challenges_expiry
ON server_pairing_challenges (expires_at_unix, redeemed_at_unix);

CREATE INDEX server_device_credentials_active
ON server_device_credentials (revoked_at_unix);

CREATE TABLE server_auth_audit_events (
    id TEXT PRIMARY KEY NOT NULL,
    event_kind TEXT NOT NULL
        CHECK (event_kind IN ('pairing_created', 'pairing_redeemed', 'device_revoked')),
    actor_credential_id TEXT,
    actor_device_id TEXT,
    target_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded')),
    occurred_at_unix INTEGER NOT NULL
);

CREATE INDEX server_auth_audit_events_time
ON server_auth_audit_events (occurred_at_unix);

UPDATE server_access_tokens
SET scopes_json =
    '["conversation.read","conversation.write","conversation.attach","conversation.permission","conversation.cancel","application.call","plugin.read","plugin.write","artifact.read","artifact.preview","automation.read","automation.write","delegation.read","delegation.cancel","device.pair","device.revoke","notification.summary","offline.read"]';
