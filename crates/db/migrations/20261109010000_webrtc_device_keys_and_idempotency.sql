ALTER TABLE server_device_credentials
    ADD COLUMN public_key_ed25519 TEXT;

CREATE UNIQUE INDEX server_device_credentials_ed25519_active
ON server_device_credentials (public_key_ed25519)
WHERE public_key_ed25519 IS NOT NULL AND revoked_at_unix IS NULL;

CREATE TABLE webrtc_signaling_nonces (
    session_nonce TEXT PRIMARY KEY NOT NULL,
    sender_device_id TEXT NOT NULL,
    expires_at_unix INTEGER NOT NULL
);

CREATE INDEX webrtc_signaling_nonces_expiry
ON webrtc_signaling_nonces (expires_at_unix);

CREATE TABLE companion_idempotency_ledger (
    credential_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    command TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at_unix INTEGER NOT NULL,
    expires_at_unix INTEGER NOT NULL,
    PRIMARY KEY (credential_id, operation_id)
);

CREATE INDEX companion_idempotency_ledger_expiry
ON companion_idempotency_ledger (expires_at_unix);
