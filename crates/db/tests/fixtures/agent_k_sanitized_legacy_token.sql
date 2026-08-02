-- Sanitized server credential fixture. Only the irreversible SHA-256-shaped
-- digest is retained; no plaintext bearer credential is present.
INSERT INTO server_access_tokens (
    id, token_hash, scopes_json, created_at, revoked_at
) VALUES (
    'sanitized-server-token',
    X'5555555555555555555555555555555555555555555555555555555555555555',
    '["conversation.read","conversation.write"]',
    '2026-01-02T03:04:05Z',
    NULL
);
