# Agent K Security and Recovery Report

Review scope: remote/server auth, durable replay, Plugin/Tool migration and
installation, Artifact/Office preview, Delegation companion, Automation owner
and recovery, static production assets.

## Fixed findings

### K-SEC-001 — Tool distribution URL policy

Before this review, URL checks existed only in deterministic Plugin resolution,
so a direct `ToolRuntime.ensure` caller could bypass them. The reqwest adapter
also followed redirects and buffered an unbounded body.

The policy now lives at the authoritative Tool Runtime boundary and is shared
by Plugin resolution. It rejects non-HTTPS, IP/special-use hosts, trailing-dot
localhost, userinfo, query and fragment before fetch. The downloader resolves
every A/AAAA answer, rejects any private/loopback/link-local/multicast/reserved
address, pins the approved answers into a fresh HTTPS-only client, disables
redirects, redacts network errors and streams through a 256 MiB bound.

### K-SEC-002 — WebSocket frame bound

The Web subscription adapter previously parsed arbitrarily large text frames.
`ws_handler` now limits both frame and assembled message size to 1 MiB before
JSON decoding. Delegation companion framing independently remains capped at
16 MiB and individual Delegation results at 256 KiB.

## Attack matrix

| Attack | Public evidence | Result |
|---|---|---|
| Parent/path traversal | Tool Runtime `rejects_managed_path_escape_before_download`; Artifact `rejects_parent_path_before_reading_content` | Rejected before download/read |
| Symlink escape | Artifact canonical path test; Server static asset symlink test; Delegation working-root symlink test | No outside content/process |
| SSRF | Tool Runtime controlled-DNS test, malicious URL tests, preview unknown-port/host-path tests | DNS answers pinned public-only; redirects disabled; preview loopback registration only |
| Preview capability replay | revoke/expiry/wrong/unknown lease HTTP tests | Revoked/expired caps fail |
| CORS | exact same-origin/allowlist Server test | Unlisted origins rejected |
| Token URL/log/store | query-token rejection, redacted `Debug`, package-output smoke, hash-only SQLite test | No bearer token in URL/log/state |
| Oversized input/result | WebSocket 1 MiB, Delegation frame 16 MiB, result 256 KiB | Fail closed |
| Malicious manifest | unknown major/field, legacy `install_command`, URL, platform/hash tests | No command execution/probe |
| Replay race | atomic attach/high-water test and WebSocket reconnect test | No gap or duplicate application |
| Scheduler race | owner lease, transactional concurrent ticks, one-active-run index | No double scheduling |
| Terminal race | Delegation early complete/cancel/parent close and Automation four terminal projections | First terminal wins; no permanent running |
| Dependency/license drift | deterministic pnpm/Cargo metadata audit plus RustSec and pnpm advisory CI jobs | Unknown or non-approved licenses fail; high-severity advisories fail CI |

## Secret and scope properties

- Pairing secrets expire after five minutes, are stored only as SHA-256, and
  atomic concurrent redemption produces one winner.
- Device credentials carry an explicit allowlisted scope set and Application
  principals retain credential/device identity. Pair/create/redeem/revoke
  success is appended to a secret-free auth audit table.
- Revocation invalidates both subsequent HTTP and an established WebSocket.
- Notification summaries structurally discard private detail and contain no
  prompt/output/path/token fields.
- Preview capabilities are distinct from Server/device credentials and are
  never forwarded upstream.
- The Web pairing QR contains only the five-minute one-time pairing secret,
  pairing id and expiry. It contains neither the Server URL nor the
  administrator bearer token.

## Random/property testing

No randomized/property test was introduced in this release gate. Crash windows
use deterministic barriers, fake clocks and transaction races, so there is no
failure seed to preserve. Any future randomized suite must print and commit its
minimal failing seed before a fix.

## Residual limitations

- This Server is loopback-first and does not provide TLS termination. LAN
  exposure requires explicit opt-in plus an external reviewed TLS boundary.
- Notification DTOs do not send APNs/FCM messages.
- Offline data is read-only and does not queue commands.
- Device pairing has a capability-gated Web QR affordance, but there is no
  mobile product application.
- Native macOS WebDriver is not provided by Tauri. Desktop journey components
  are exercised as optimized multi-page builds in Chromium, while native
  Tauri commands and transports remain covered by Rust/TypeScript integration
  tests.
