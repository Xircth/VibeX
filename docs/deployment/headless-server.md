# Headless Server Deployment

`vibex-server` is a headless composition root over the same Application Core,
SQLite data directory, Agent runtime, Delegation companion, Plugin/Artifact
services, and Automation Engine used by desktop VibeX. It does not load Tauri.

## Build and package smoke

```bash
pnpm run server:package-smoke
```

The smoke builds the production React tree and release Server binary, starts it
against a temporary data directory on loopback, verifies authenticated and
unauthenticated capability responses, and asserts that the supplied token does
not appear in process output.

## Configuration

| Variable | Default | Policy |
|---|---|---|
| `VIBEX_DATA_DIR` | platform VibeX data directory | One desktop/Server owner at a time runs Automation for this directory. |
| `VIBEX_SERVER_LISTEN` | `127.0.0.1:3080` | Non-loopback is rejected unless LAN exposure is acknowledged. |
| `VIBEX_SERVER_ALLOW_LAN` | unset | Set to `1` only with an external TLS/auth boundary and reviewed network policy. |
| `VIBEX_SERVER_TOKEN` | generated once | Prefer generated credentials. Supplied values must be at least 32 bytes with at least 12 distinct byte values; use a secret manager, never a URL or command argument. |
| `VIBEX_STATIC_ROOT` | unset | Point to the production `frontend/dist` tree. |
| `VIBEX_SERVER_ALLOWED_ORIGINS` | empty | Comma-separated exact browser origins; same-origin requests need no entry. |

Tokens are persisted only as SHA-256 digests. If the Server generates the first
token, stdout shows it exactly once; capture it as a secret, then remove the
bootstrap output. Routine logs do not contain it.

## Network boundary

- Keep the default loopback bind whenever the browser runs on the same host.
- Terminate TLS before enabling LAN access; do not publish raw loopback-oriented
  preview providers.
- Allowlist exact CORS origins. Wildcards and reflected origins are unsupported.
- Bearer tokens belong in `Authorization`; WebSocket tokens use the negotiated
  subprotocol header. Query tokens are rejected.
- Preview URLs contain a separate short-lived lease capability. The proxy pins
  the upstream to the registered loopback port and never forwards credentials.

## Upgrade

1. Stop every desktop and Server process using the data directory.
2. Back up `db.sqlite`, `db.sqlite-wal`, `db.sqlite-shm`, managed tools, and
   Artifact files as one consistent snapshot.
3. Run the migration rehearsal and release gates documented in
   `docs/verification/agent-k-release-hardening.md`.
4. Start one host, verify `/health`, authenticate `/api/v1/capabilities`, and
   inspect Automation reconciliation before starting another desktop.

Rollback is documented in `docs/release/platform-capability-v2.md`.
