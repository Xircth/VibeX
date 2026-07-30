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
  `attach_conversation` without Tauri/Axum types. Attach accepts a
  `ConversationSubscriptionRegistrar` port and registers live delivery before
  reading the durable high-water mark.
- `application::CommandRegistry` accepts only `RegisteredCommand`; unknown
  string commands return a stable `not_found` envelope without dispatch.
- Frontend feature facades depend on `BackendTransport`, `backendCall`, or
  `backendListen`/`backendEmit`. `BackendTransportProvider` replaces the
  configured adapter before descendant effects run. Only the desktop
  `TauriTransport` adapter loads
  `@tauri-apps/api`, and it does so lazily.

## Migration notes

`application_call` is the thin, closed Tauri adapter over
`application::CommandRegistry`; the conversation-list tracer uses it in
production and receives the same success/error envelope as a future remote
adapter. `conversation_attach` remains a thin adapter over the same
Application Core. Existing API facades retain their feature-facing signatures;
their invocation dependency moved from `tauriApi` to the transport boundary.
No Axum server or WebTransport was added.

Application Core asks its live-registration port to make future events
observable, then reads the high-water mark and replay from one SQLite
transaction. Desktop live delivery also installs its notification listener
before the bootstrap call, then re-attaches from the last durable sequence
after each notification. A turn racing with bootstrap is therefore present in
the captured snapshot/replay or causes another durable replay rather than a
gap.

## RED / GREEN log

1. RED: Codeg transport source paths were missing from the adoption record.
   GREEN: pinned-source and Apache-2.0 validation test, including negative
   fixtures for missing commit, source, notice, and license evidence.
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
7. RED: `ready` was asserted without an application-level live registration,
   and the production tracer bypassed the registry. GREEN: explicit
   subscription registrar, attach-race test, and `application_call` production
   wiring.
8. RED: generated protocol sequence types drifted from handwritten frontend
   copies and provider-selected transports did not reach legacy facades.
   GREEN: generated DTO reuse, checked bigint/number wire conversion, and a
   replaceable transport registry exercised through public calls/listeners.

## Focused verification

- `node --test scripts/check-third-party-adoption.test.js`
- `cargo test -p remote-protocol`
- `cargo test -p application`
- `pnpm run generate-types:check`
- Transport and affected feature Vitest suites
- Frontend typecheck and lint
