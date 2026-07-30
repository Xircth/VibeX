# Agent J — Web Product, Preview Proxy, and Remote Desktop

Integration SHA: `37a34f25ee5ee399f836d1034c0265746222c699`

## Stable public seams

- `application::ApplicationDomainPort` and the closed `DomainCommand` registry
  expose Plugin, Artifact, Automation, Delegation, project, and Agent support
  operations without Axum or Tauri types.
- `server::HeadlessServer` composes the shared `office-runtime`, real
  Application Core, Automation owner, Agent runtime, Delegation companion, and
  SQLite repositories for the Web product.
- `server::PreviewProxyRegistry` accepts only a live Artifact lease, registered
  loopback port, SHA-256 capability digest, and expiry.
- Frontend `WebTransport`, `RemoteDesktopTransport`, and
  `BackendTransportProvider` drive the same production React feature facades.
  Remote Desktop credentials cross IPC once and remain in the Rust registry
  keyed by `(window, profile)`.

## Security and capability behavior

- Production Server defaults to loopback and exact-origin CORS. Web login keeps
  its bearer token in React memory; it is absent from URLs and browser storage.
- Preview routes never accept an upstream host, never forward Server auth,
  capability, cookie, or origin headers, reject traversal/SSRF paths, expire
  capabilities, and stream rewritten SSE without waiting for provider exit.
- Web preview iframes use an opaque origin and `referrerPolicy="no-referrer"`.
- Plugin, Artifact, Automation, and Delegation controls are shown only for
  advertised capabilities. Desktop-only Tauri and CEF/CDP settings stay hidden
  rather than claiming remote equivalence.
- Remote Desktop only permits HTTPS except for loopback HTTP, rejects
  credential/path/query/fragment URL forms, redacts credential debug output,
  and removes all profiles owned by a destroyed desktop window.

## RED / GREEN log

1. RED: product commands were absent from the closed Application registry.
   GREEN: the public domain port, per-capability scopes, and stable error
   operation ids.
2. RED: headless Plugin, Artifact, Automation, and Delegation calls had no real
   composition. GREEN: one authenticated Server test observes the Office
   catalog, Artifact list, and seven Automation templates.
3. RED: preview requests accepted no registered Web capability.
   GREEN: missing, wrong, expired, unknown-port, traversal, credential-leak,
   HTML, and SSE proxy tests.
4. RED: an SSE proxy that buffered the response could never return a live
   Office event stream. GREEN: a public HTTP test holds the upstream open and
   observes the first rewritten event immediately.
5. RED: two desktop windows had no isolated Server profiles.
   GREEN: Rust and TypeScript tests observe distinct profiles, tokens, calls,
   events, teardown, and token-redacted serialized state.
6. RED: production Web mounted desktop startup services and settings.
   GREEN: authenticated bootstrap, Transport-backed project/product facades,
   and capability-gated settings tests.
7. RED: Delegation cancel and Artifact preview lifecycle bypassed the active
   transport. GREEN: user-click tests observe `delegation_cancel` and
   Artifact list/open/close through mock `BackendTransport`.
8. RED: production static resources and SPA navigation had no browser journey.
   GREEN: Playwright boots the real `vibex-server`, authenticates, opens
   Automation and Plugin settings, checks desktop capability absence, and
   verifies that the token is not persisted.

## Verification

- `cargo test -p server`
- `cargo test -p application`
- `cargo test -p remote-protocol`
- `cargo test -p automation`
- `cargo test -p artifacts`
- `cargo test -p delegation`
- `cargo test -p vibex remote_desktop`
- `cargo test --workspace`
- `cd frontend && pnpm test` — 202 files, 1005 tests passed
- `pnpm run test:web:e2e` — production build and one Chromium journey passed
- `pnpm run prepare-db:check`
- `pnpm run generate-types:check`
- `node --test scripts/check-third-party-adoption.test.js`
- `pnpm run check`
- `pnpm run lint`

Successful local Playwright evidence:

- `frontend/test-results/web-production/web-product-production-Web-48ec8-es-only-Server-capabilities/test-finished-1.png`
- `frontend/test-results/web-production/web-product-production-Web-48ec8-es-only-Server-capabilities/video.webm`

Codeg source, adaptation, and Apache-2.0 obligations are recorded in
`docs/third-party/codeg-adoption.md`.
