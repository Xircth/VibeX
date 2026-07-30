# Agent I — Application Core and BackendTransport

Base SHA: `391e0138ac23d410ae45affa91ed123ae6108fd6`

## Stable public API

- `remote_protocol::ErrorEnvelope`:
  `code/message/retryable/operation_id/details`.
- `remote_protocol::CommandResponse<T>`:
  `operation_id/data`.
- `remote_protocol::ServerCapabilities` uses open string capability ids.
- `remote_protocol::SubscriptionRequest` attaches a Conversation with a
  persisted `after_sequence`.
- `remote_protocol::SubscriptionBootstrap` returns `ready`, optional snapshot,
  replay, and `high_water_mark`; `RemoteEvent.kind` and JSON payload are open
  for forward compatibility.
- `application::ApplicationCore` exposes `list_conversations` and
  `attach_conversation` without Tauri/Axum types.
- `application::CommandRegistry` accepts only `RegisteredCommand`; unknown
  string commands return a stable `not_found` envelope without dispatch.
- Frontend feature facades depend on `BackendTransport`, `backendCall`, or
  `backendListen`. Only the desktop `TauriTransport` adapter loads
  `@tauri-apps/api`, and it does so lazily.

## Migration notes

`conversation_list` and `conversation_attach` are thin Tauri adapters over the
same Application Core used by a future server. Existing API facades retain
their feature-facing signatures; their invocation dependency moved from
`tauriApi` to the transport boundary. No Axum server or WebTransport was added.

The initial attach reads the high-water mark and replay from one SQLite
transaction. Desktop live delivery registers its notification listener before
the bootstrap call, then re-attaches from the last durable sequence after each
notification. A notification racing with bootstrap therefore causes another
durable replay rather than a gap.

## RED / GREEN log

1. RED: Codeg transport source paths were missing from the adoption record.
   GREEN: pinned-source and Apache-2.0 validation test.
2. RED: `ErrorEnvelope`, stable ids, capability and subscription fixtures did
   not compile. GREEN: versioned `remote-protocol` DTOs and serde round trips.
3. RED: `ApplicationCore::list_conversations` did not exist. GREEN: temp SQLite
   tracer bullet without `AppHandle`; Tauri command reduced to an adapter.
4. RED: a fake frontend transport still imported Tauri through the Conversation
   facade. GREEN: injected facade plus lazy `TauriTransport` and provider.
5. RED: arbitrary command names and the local serde contract were unhandled.
   GREEN: closed `CommandRegistry` and stable success/error operation ids.
6. RED: durable attach/replay, unknown events and sequence de-duplication were
   absent. GREEN: transactional bootstrap and public `EventCursor`.

## Focused verification

- `node --test scripts/check-third-party-adoption.test.js`
- `cargo test -p remote-protocol`
- `cargo test -p application`
- `pnpm run generate-types:check`
- Transport and affected feature Vitest suites
- Frontend typecheck and lint
