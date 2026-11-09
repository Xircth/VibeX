CREATE TABLE IF NOT EXISTS server_device_connect_requests (
    id TEXT PRIMARY KEY NOT NULL,
    device_name TEXT NOT NULL,
    client_kind TEXT NOT NULL,
    ip_address TEXT,
    public_key_ed25519 TEXT,
    sas_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    issued_credential_json TEXT,
    created_at_unix INTEGER NOT NULL,
    expires_at_unix INTEGER NOT NULL,
    responded_at_unix INTEGER
);

CREATE INDEX IF NOT EXISTS server_device_connect_requests_status_expiry
ON server_device_connect_requests (status, expires_at_unix);
