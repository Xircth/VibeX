# Headless Server Deployment

`vibex-server` is a headless composition root over the same Application Core,
SQLite data directory, Agent runtime, Delegation companion, Plugin/Artifact
services, and Automation Engine used by desktop VibeX. It does not load Tauri.

## Distribution status

P0 ships a Host family directory: `vibex-server`, sibling `vibex-mcp`,
`vibex-workflow-mcp`, production `web/`, and `plugins/bundled/`. Assemble it with:

```bash
node scripts/package-host-family.js \
  --server target/release/vibex-server \
  --mcp target/release/vibex-mcp \
  --workflow-mcp target/release/vibex-workflow-mcp \
  --web frontend/dist \
  --plugins assets/plugins \
  --output dist/host-family
```

Apple Developer ID and Windows Authenticode are not required for this family.
Publish SHA-256 checksums; attach a minisign `.sig` only when the updater key is
present.

`npx vibex` downloads
`vibex-host-family-{linux-x64,linux-arm64,macos-x64,macos-arm64,windows-x64,windows-arm64}.tar.gz`
from the matching GitHub Release, verifies the sidecar `.sha256` and the inner
`SHA256SUMS`, then runs `vibex-server` with `VIBEX_STATIC_ROOT` set to `web/`.

Start the Web UI on the LAN and print the long-lived host token:

```bash
npx vibex serve
```

`serve` (alias `web`) is the opt-in. It binds `0.0.0.0:17891`, lists reachable
HTTP origins, and prints the host token. Loopback-only Web UI is
`npx vibex serve --local`. Replace the token with `npx vibex serve --rotate-token`.
The token is stored as `host.token` in the data directory (mode `0600` on Unix)
so later `serve` runs print the same value. SQLite still stores only the hash.

Plain `npx vibex` stays on loopback. Docker Compose still publishes
`127.0.0.1:17891`. Public exposure still needs an external TLS proxy.

Install Agent Runtime and ACP into the Host machine's user environment
without starting the HTTP server:

```bash
npx vibex list
npx vibex list --refresh
npx vibex install claude_code --yes
```

`list` groups Built-in Agents above other ACP Registry entries. `install`
writes `npm` / `uv` / Binary packages into the user environment, then binds
the Installation lock used by later `serve` sessions. Pass `--yes` to skip
the confirmation prompt. The remote control command `npx vibex agent list`
still talks to a running Host and is not this installer.

In-place upgrade: verify `SHA256SUMS`, snapshot the data directory, then replace
`vibex-server`, `vibex-mcp`, and `web/`. See `server::apply_host_upgrade`.

See [ADR-0054](../adr/0054-host-family-distribution-and-client-surfaces.md).

## P1 distribution contract

- Publish official Linux `amd64` and `arm64` container images to GHCR and provide
  a Compose deployment with a persistent data volume, health check, graceful
  shutdown, and a documented pre-upgrade backup step.
- Publish signed, checksummed standalone `vibex-server` binaries for Windows x64,
  macOS arm64/x64, and Linux amd64/arm64.
- Installation helpers may download only an explicit release artifact and must
  verify its signature or checksum before installation. They must not silently
  select and execute an unverified latest build.
- Keep loopback as the default. LAN or public exposure remains explicit and uses
  an external TLS termination layer such as Caddy, Traefik, or Nginx.
- Release documentation must cover first start, device pairing, upgrade, backup,
  restore, rollback, and device revocation.

P1 does not promise Kubernetes, multi-node or high-availability operation,
managed cloud hosting, or built-in public TLS termination.

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
| `VIBEX_SERVER_LISTEN` | `127.0.0.1:17891` | Non-loopback is rejected unless LAN exposure is acknowledged. |
| `VIBEX_SERVER_ALLOW_LAN` | unset | Set to `1` only with an external TLS/auth boundary and reviewed network policy. |
| `VIBEX_SERVER_TOKEN` | generated once | Prefer generated credentials. Supplied values must be at least 32 bytes with at least 12 distinct byte values; use a secret manager, never a URL or command argument. |
| `VIBEX_STATIC_ROOT` | unset | Point to the production `frontend/dist` tree. |
| `VIBEX_SERVER_ALLOWED_ORIGINS` | empty | Comma-separated exact browser origins; same-origin requests need no entry. |

SQLite stores only the SHA-256 digest. `serve` also writes `host.token` in the
data directory so the same long-lived token can be printed again. Routine logs
do not contain it.

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
