# Headless Server Deployment (`vibex-server`)

`vibex-server` is a headless composition root over the exact same Application Core, SQLite data directory, ACP `AgentRuntime`, Delegation & Collaboration Space companion, Plugin Kernel, Artifact service, and Automation Engine used by desktop VibeX (`vibex`). It does not load Tauri.

See [`ADR-0054`](../adr/0054-host-family-distribution-and-client-surfaces.md) and [`docs/architecture.md`](../architecture.md) for the Host-family model.

---

## 1. Host Family Distribution & Quick Start

The Server distribution ships a unified Host-family directory containing `vibex-server`, sibling `vibex-mcp` and `vibex-workflow-mcp`, production `web/` (`frontend/dist`), and `vibex-plugin.json`. Assemble locally with:

```bash
node scripts/package-host-family.js \
  --server target/release/vibex-server \
  --mcp target/release/vibex-mcp \
  --workflow-mcp target/release/vibex-workflow-mcp \
  --web frontend/dist \
  --plugins assets/plugins \
  --output dist/host-family
```

`npx @omnione/vibex`, `install.sh`, and `install.ps1` download `VibeX-${VERSION}-{linux-x86_64,linux-aarch64,darwin-aarch64,windows-x86_64,windows-aarch64}-server.tar.gz` from the matching GitHub Release, verify both the outer `.sha256` sidecar and inner `SHA256SUMS`, and launch `vibex-server` with `VIBEX_STATIC_ROOT` pointed at `web/` (asset names derive from [`npx-cli/bin/release-assets.js`](../../npx-cli/bin/release-assets.js)).

### Launching WebUI & Pairing

```bash
npx @omnione/vibex serve                 # Bind 0.0.0.0:17891, list origins, print long-lived host token
npx @omnione/vibex serve --local         # Bind 127.0.0.1:17891 (loopback-only WebUI)
npx @omnione/vibex serve --rotate-token  # Issue a new host token and invalidate old admin token
```

- `serve` (alias `web`) persists the long-lived admin token in `<VIBEX_DATA_DIR>/host.token` (`0600` on Unix) so subsequent `serve` runs print the same token, while SQLite stores only its SHA-256 digest.
- Plain `npx @omnione/vibex` and `docker compose up -d` bind `127.0.0.1:17891` by default. Public internet exposure requires an external TLS reverse proxy (Caddy, Traefik, Nginx, or Tailscale Serve).

### Installing Coding Agents on a Headless Host

Install ACP runtimes and adapters into the Host machine's user environment without starting the HTTP server:

```bash
npx @omnione/vibex list
npx @omnione/vibex list --refresh
npx @omnione/vibex install claude_code --yes
```

`list` groups VibeX's 20 Built-in Agents above ACP Official Registry entries. `install` installs `npm` / `uv` / binary distributions into the user environment and records the verified `InstallationLock` used by subsequent `serve` sessions (`npx @omnione/vibex agent list` queries an already-running Host instead).

---

## 2. Environment Variables & Network Policy

| Variable | Default | Policy |
| --- | --- | --- |
| `VIBEX_DATA_DIR` | Platform VibeX data directory | Only one Desktop or `vibex-server` owner may run against a data directory at a time. |
| `VIBEX_SERVER_LISTEN` | `127.0.0.1:17891` | Non-loopback bind requires `VIBEX_SERVER_ALLOW_LAN=1` (set automatically by `vibex serve`). |
| `VIBEX_SERVER_ALLOW_LAN` | Unset | Enable only behind a trusted LAN or external TLS/auth boundary. |
| `VIBEX_SERVER_TOKEN` | Generated once | Optional override: ≥ 32 bytes with ≥ 12 distinct byte values. Supply via secret manager/env, never URL query strings. |
| `VIBEX_STATIC_ROOT` | Unset | Path to production `frontend/dist` (`web/`). |
| `VIBEX_SERVER_ALLOWED_ORIGINS` | Empty | Comma-separated exact browser origins for CORS (wildcards and reflected origins are rejected; same-origin needs no entry). |

### Security Boundaries

- **Credentials**: HTTP requests pass `Authorization: Bearer <token>`; WebSocket `/api/v1/ws` negotiates `Sec-WebSocket-Protocol: vibex.token.<base64url>`. Query-string tokens are unconditionally rejected.
- **Artifact & Preview Proxies**: Preview URLs carry a short-lived, capability-scoped lease pinned to a registered loopback upstream port and never forward host credentials.
- **Scope**: `vibex-server` targets single-owner workstation/team-box deployments (`Server owner` in [`CONTEXT.md`](../../CONTEXT.md)); it does not implement multi-tenant user isolation, Kubernetes HA clustering, or built-in ACME public TLS termination.

---

## 3. Build Smoke, Upgrades & Rollback

### Build & Package Smoke

```bash
pnpm run server:package-smoke
```

Builds production `frontend/dist` and release `vibex-server`, boots against an isolated temporary data directory on loopback, validates authenticated/unauthenticated `/api/v1/capabilities`, and verifies zero token leakage in stdout/stderr logs.

### Safe Upgrade & Rollback Procedure

1. **Quiesce**: Stop every Desktop (`vibex`) and `vibex-server` process using `VIBEX_DATA_DIR`.
2. **Consistent Backup**: Snapshot `db.sqlite`, `db.sqlite-wal`, `db.sqlite-shm`, `host.token`, managed tool locks, and Artifact files together before replacing binaries.
3. **Replace & Verify**: For automated upgrades, `server::apply_host_upgrade` verifies `SHA256SUMS`, snapshots the data directory, and swaps `vibex-server`, `vibex-mcp`, `vibex-workflow-mcp`, and `web/`.
4. **Post-Start Check**: Boot a single Host, check `/health` and authenticated `/api/v1/capabilities`, and verify Automation startup reconciliation before connecting remote clients.
5. **Rollback**: Stop the upgraded binary, restore the pre-upgrade data-directory snapshot alongside the previous Host-family release archive, and restart. Never run an older binary against a post-migration SQLite file without restoring the matching snapshot.

---

## 4. Operational Troubleshooting

### Authentication (`401`), Device Pairing & Revocation

- **`401 Unauthorized` on HTTP or WebSocket close**: Confirm the token is sent in `Authorization: Bearer <token>` (or `Sec-WebSocket-Protocol: vibex.token.<base64url>`), never `?token=...`. Check whether `serve --rotate-token` rotated the admin token or whether the Paired Device was revoked in the Host Console.
- **Pairing Invitation Rejected or Expired**: Pairing secrets are **single-redeem** and expire after **30 minutes** by default (configurable via `--ttl`, bounded up to 30 days). Already-paired devices merge updated `Reachability` origins from a fresh invitation without re-redeeming the secret; unpaired devices need a freshly issued invitation if the secret was already consumed or expired.
- **Immediate Revocation**: Revoking a Paired Device invalidates both new HTTP calls and open `/api/v1/ws` streams immediately.

### WebSocket Attach, Replay & Frame Limits

- **Durable Reconnect (`after_sequence`)**: `/api/v1/ws` follows `ready → snapshot/replay → live`. Clients reconnect with their highest persisted `sequence`; if the gap exceeds the in-memory ring, the Host sends a fresh `snapshot` before resuming `live` events.
- **`1 MiB` Frame Cap**: Oversized client frames are rejected by the WebSocket transport. Keep command payloads concise and attach large files via workspace paths or artifact uploads.
- **Offline Cache**: When the Host is unreachable, Companion and Workstation clients surface cached timelines strictly as `read_only: true` and never queue blind offline mutations.

### Automation Lease & Crash Recovery

- **Single-Owner Engine Lease**: Only one Host process holds the SQLite Automation lease for a data directory. If Automation runs appear paused, check whether another Desktop or `vibex-server` instance still holds the directory.
- **Orphaned Runs Marked `Interrupted`**: If the Host crashes or restarts mid-turn, startup recovery marks orphaned direct-Turn runs `interrupted` and reconciles in-progress Workflow runs **without re-triggering** side-effecting prompts. At most one missed schedule window is caught up after downtime.

### Plugins, Runtime Locks & Preview Leases

- **Runtime Lock Failures (e.g., `vibex.office` / `vibex.open-connector`)**: Plugins declaring `depends/runtimes/*.json` require HTTPS downloads matching their pinned `sha256` and a passing bounded `--version` probe before their Activation Generation can publish. Behind corporate proxies or offline hosts, pre-populate or verify outbound GitHub Release access and inspect `/plugins/<id>` diagnostics.
- **Preview Stopped Responding**: `ArtifactPreviewLease` instances (such as `officecli watch`) shut down automatically after `idleTimeoutMinutes` or when the last preview tab closes; reopening the file acquires a fresh lease.
- **Redacted Diagnostics**: Host logs and diagnostic bundles scrub bearer tokens, pairing secrets, and Model Provider API keys by design.
