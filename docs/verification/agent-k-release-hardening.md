# Agent K — Mobile Protocol Reservation and Release Hardening

- Worktree: `.worktrees/plugin-v2-tool-runtime`
- Branch: `codex/agent-k-release-hardening`
- Base SHA: `650164ebf7afd1ec8ae0b258fc422e28e9d31c47`
- Final completion-audit SHA: `6316622c7ecf9e1cea779ab7e7a9b3e923352812`
- Scope: M6 and M7 only; no mobile product implementation

## Baseline

The worktree was clean and already isolated. `pnpm install`,
`cargo test --workspace`, both generated checks, `pnpm run check`,
`pnpm run lint`, production frontend build and Web production E2E passed.
An initial Rust/frontend parallel run caused two Vitest timeouts; both targeted
tests and the complete frontend suite then passed serially (202 files, 1005
tests), proving resource contention rather than an inherited product failure.

## M6 traceability

| Requirement | Stable public seam and evidence |
|---|---|
| MOB-001 versioned client protocol | `remote_protocol::protocol_schema_bundle`, `docs/protocol/v1/schema.json`, OpenAPI 3.1 |
| MOB-002 generated models | Schema-derived TypeScript, Swift and Kotlin models compile and execute an unknown-event JSON round trip |
| MOB-003 pairing/revocation/summary | public pairing and notification HTTP routes, `ServerAuth`, device-scoped `Principal`, secret-free `NotificationProjector` |
| MOB-004 offline/unknown events | public offline HTTP route; `OfflineConversationCache` enforces read-only; open `RemoteEvent.kind/payload` round-trips |

Pairing tokens are five-minute, one-time secrets. Concurrent redemption yields
one credential. Revocation is checked on HTTP and periodically on existing
WebSockets. The Server stores only hashes.

The repository contains generated model fixtures, not Xcode/Gradle mobile
projects. Existing `src-tauri/icons/ios` and `src-tauri/icons/android`
directories are Tauri packaging icons, not product source.

## RED / GREEN record

1. RED: no schema exporter/generator existed. GREEN: deterministic
   Schema/OpenAPI and checked-in three-language compile fixtures.
2. RED: pairing routes/DTO/store were absent. GREEN: shared `ServerAuth`,
   atomic one-time redemption, expiry, scope filtering and HTTP/WS revocation.
3. RED: device identity was lost when entering Application Core. GREEN:
   credential/device ids remain on the remote `Principal`.
4. RED: notification evidence could carry private detail. GREEN: a structural
   projector emits only stable ids, terminal outcome, operation and time.
5. RED: offline cache accepted no explicit forward-compatible contract.
   GREEN: read-only enforcement, sequence cursor and unknown-event round trip.
6. RED: Tool Runtime accepted dangerous distribution URLs and the HTTP adapter
   followed redirects. GREEN: authoritative HTTPS/no-secret syntax policy,
   public-only pinned DNS, no redirects and bounded streaming.
7. RED: WebSocket accepted an oversized frame into JSON processing. GREEN:
   shared 1 MiB frame/message boundary.
8. RED: exported OpenAPI references still targeted JSON Schema `$defs`.
   GREEN: the exporter rewrites every reference into OpenAPI
   `components/schemas`, with a fixture that rejects dangling references.
9. RED: advertised device scopes were not independently enforced at the
   Application Core boundary. GREEN: attach, permission, cancel, offline read
   and notification summary each require their narrow scope.
10. RED: offline and notification capabilities had DTOs but no public Server
    seam. GREEN: authenticated HTTP routes use the real Application Core and
    SQLite projection.
11. RED: an initial one-time redemption test reused one SQLite connection and
    did not exercise a real race. GREEN: a WAL-backed multi-connection fixture
    proves `BEGIN IMMEDIATE` yields exactly one credential and one conflict.
12. RED: the oversized-frame test assumed the peer could not reject while the
    client was still flushing. GREEN: the public-seam assertion accepts both
    legal close timings and passed ten consecutive focused runs.
13. RED: protocol generation compiled language smoke fixtures inside the
    checked-in protocol directory and left binaries behind. GREEN: generation
    still updates deterministic sources, while all compile/runtime artifacts
    are emitted beneath a temporary directory.
14. RED: the final audit had no dependency-license gate and no user-facing
    device pairing affordance. GREEN: CI validates both ecosystems' license
    metadata, and capability-gated settings create an accessible short-lived
    QR whose payload contains no URL or long-lived credential.
15. RED: routing every question response through the generic desktop
    Application adapter bypassed the established Delegation companion ask
    responder. GREEN: Web uses the transport-neutral command while desktop
    retains its explicit companion-aware Tauri adapter; a Transport test fixes
    that dispatch boundary.

## M7 recovery matrix

One serial focused run covered:

- Tool Runtime: 13 install/upgrade/cancel/lock/release tests, one controlled-DNS
  downloader test and five local lock
  adapter tests.
- Artifact/Office: 13 preview lifecycle tests, five record/path/outbox tests,
  and a real fake-executable adapter test.
- Delegation: 65 broker/listener/token/teardown tests plus four protocol-frame
  tests.
- Automation: owner/claim, cancellation/recovery, terminal projection,
  schedule/DST, isolation and template suites.
- Replay/Server: atomic attach/high-water, reconnect, device auth, CORS, static
  root, proxy, headless takeover and WebSocket tests.

All passed with no permanent running state, double terminal, double schedule,
unverified probe/execution or replay gap.

## Reports and operator material

- Protocol: `docs/protocol/v1/README.md`
- Migration: `docs/migrations/agent-k-migration-rehearsal.md`
- Security: `docs/security/agent-k-security-report.md`
- Deployment: `docs/deployment/headless-server.md`
- Troubleshooting: `docs/troubleshooting/headless-server.md`
- Release/rollback: `docs/release/platform-capability-v2.md`
- Attribution: `docs/third-party/codeg-adoption.md`

## Final gate record

Final serial results from this worktree:

| Gate | Result |
|---|---|
| `pnpm run generate-types:check` | PASS; `shared/types.ts` current |
| `pnpm run prepare-db:check` | PASS; all migrations through `20260731100000` and SQLx metadata current |
| `pnpm run remote-protocol-schema:check` | PASS; schema/OpenAPI and TypeScript/Swift/Kotlin compile/runtime smoke current |
| `cargo test --workspace -q` | PASS; only explicitly opt-in live ACP/PTY tests ignored |
| `cd frontend && pnpm test` | PASS; 203 files, 1009 tests |
| `pnpm run check` | PASS |
| `pnpm run lint` | PASS with Clippy warnings denied |
| `pnpm run frontend:build` | PASS; optimized production assets |
| `pnpm run server:package-smoke` | PASS; release binary, loopback auth/capabilities, no token output |
| `pnpm run test:web:e2e` | PASS; four production-build Playwright journeys |
| Desktop journey fixtures | PASS: Agent E and Agent G production components plus Agent J transport/preview journey |
| `node --test scripts/check-third-party-adoption.test.js` | PASS; 6 tests |
| `node --test scripts/check-dependency-licenses.test.mjs` | PASS; 4 tests |
| `pnpm run dependency:licenses` | PASS; 480 JavaScript groups and 883 Rust packages |
| `pnpm audit --prod --audit-level high` | PASS; 0 high findings after patched transitive resolutions |
| `cargo fmt --all -- --check` and `git diff --check` | PASS |
| Mobile product-source scan | PASS; no Xcode, CocoaPods, Gradle, Android manifest or mobile application project |

The production build reports existing chunk-size and mixed static/dynamic
import warnings; they are non-failing and are recorded as a release
optimization limitation, not a protocol or security failure.
