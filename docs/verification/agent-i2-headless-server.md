# Agent I-2 — Headless Server and Web Session Path

Base SHA: `f1db8932f663efffd91ab0f8a6c93e69e70ea17f`

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

## Composition and migration notes

The Server opens the selected data directory, constructs `LocalDeployment`,
`ApplicationCore`, the ACP `AgentRuntime`, `ConversationSessionService`,
Plugin and Artifact services, and acquires the same file-backed Automation
owner lease as the desktop. A competing host does not reconcile. After the
owner exits, its successor acquires the lease, marks orphaned `running` runs
`interrupted`, and performs at-most-once catch-up claiming.

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

## Focused verification

- `node --test scripts/check-third-party-adoption.test.js`
- `cargo test -p server`
- `cargo test -p application`
- `cargo test -p remote-protocol`
- `cargo test -p automation`
- frontend WebTransport and Conversation facade Vitest suites
- `pnpm run generate-types:check`
- `cargo test --workspace`
- `pnpm run check`
- `pnpm run lint`
