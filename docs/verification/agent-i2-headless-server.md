# Agent I-2 — Headless Server and Web Session Path

Base SHA: `f1db8932296f918ffb68fb43a26560e80dd99cbc`

## Stable public API

- `server::HeadlessServer::bootstrap` owns the headless composition root and
  does not require a Tauri runtime.
- `ServerConfig` defaults to `127.0.0.1:3080`; non-loopback binding requires an
  explicit opt-in. Cross-origin browser access requires an exact allowlist.
- `/api/v1/capabilities`, `/api/v1/call/{command}`, and `/api/v1/ws` require a
  bearer token. Only its SHA-256 digest is persisted.
- `ApplicationCore` exposes list, create, start Turn, permission response,
  cancel, and durable attach/replay. Axum routes only authenticate, decode DTOs,
  invoke the closed command registry, and map stable errors.
- `WebTransport` uses one authenticated WebSocket for multiple Conversation
  subscriptions and reattaches from the last durable sequence after reconnect.
- `HeadlessServer::owns_automation_engine` and `automation_recovery` expose the
  per-data-directory owner result and startup reconciliation evidence.
- `conversations::ConversationAgentEventRecorder` is the transport-neutral
  durable seam for AgentRuntime output, permission, terminal, and Delegation
  events. WebSocket delivery observes that same persisted sequence.

## Composition and migration notes

The Server opens the selected data directory, constructs `LocalDeployment`,
`ApplicationCore`, the ACP `AgentRuntime`, `ConversationSessionService`,
Plugin and Artifact services, and a real Delegation companion runtime. The
companion uses capability-driven MCP injection, a bounded framed listener,
token registry, child resolver, and parent-teardown cancellation.

The Server acquires the same file-backed Automation owner lease as the desktop.
A competing host does not reconcile or tick. The owner performs startup
catch-up, transactional due claims, workspace preparation, real Turn launches,
and terminal reconciliation. After it exits, its successor acquires the lease
and marks orphaned `running` runs `interrupted`.

The desktop and Server share `DefaultConversationHost`. Agent execution paths
come only from the persisted installation lock and must be absolute; image
paths remain workspace-relative. No `tauri::AppHandle` enters Application Core.

Static assets are optional (`VIBEX_STATIC_ROOT`). When configured, real files
and SPA routes share the production root; `/api` paths never fall back to
`index.html`.

## RED / GREEN log

1. RED: authenticated capabilities and token persistence did not exist.
   GREEN: hashed token store, loopback policy, protocol-major negotiation, and
   stable unauthorized/conflict envelopes.
2. RED: remote calls and attach/replay had no HTTP/WebSocket adapter.
   GREEN: closed command route, one multiplexed socket, ready/high-water/replay,
   and reconnect from the durable cursor.
3. RED: create/start/permission/cancel reached an unavailable execution port.
   GREEN: public Application use cases and a real
   `ConversationSessionExecutionPort` in the headless composition root.
4. RED: the Server could acquire no Automation ownership or recovery evidence.
   GREEN: two-host contention, owner exit takeover, and orphaned-run
   interruption integration coverage.
5. RED: arbitrary origins and static SPA delivery were unspecified.
   GREEN: exact CORS allowlisting, same-origin access, API fallback exclusion,
   production asset content types, and SPA fallback tests.
6. RED: owning the Automation lock did not run schedules.
   GREEN: the headless owner now ticks the shared Engine and a public test
   observes a due Run move through a real failed launch rather than remain
   unclaimed.
7. RED: AgentRuntime output was only broadcast in memory, so WebSocket replay
   could not observe a real headless Turn.
   GREEN: the transport-neutral recorder persists runtime envelopes and
   checkpoint terminal evidence; the headless test observes assistant output in
   the durable event log.
8. RED: headless composition did not initialize the Delegation companion.
   GREEN: Server now owns the broker/listener/injector/resolver lifecycle and
   uses per-process UDS or named-pipe addresses.
9. RED: a caller could supply a weak server token and an image symlink could
   escape its workspace after the lexical check.
   GREEN: supplied tokens require at least 32 bytes and prompt image targets
   must remain under the canonical workspace root.

## Focused verification

- `node --test scripts/check-third-party-adoption.test.js`
- `cargo test -p server`
- `cargo test -p application`
- `cargo test -p remote-protocol`
- `cargo test -p automation`
- frontend WebTransport and Conversation facade Vitest suites
- `pnpm run generate-types:check`
- `pnpm run prepare-db:check`
- `cargo test --workspace`
- `pnpm run check`
- `pnpm run lint`
