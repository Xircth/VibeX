# Platform Capability Expansion — Final Plan Audit

- Reviewed base: `6316622c7ecf9e1cea779ab7e7a9b3e923352812`
- Review date: 2026-07-31
- Specification state: `approved-for-implementation`
- Scope: ADR-0030 through ADR-0033 and tasks T0.1 through T7.4

## Milestone traceability

| Milestone | Tasks | Completion evidence |
|---|---|---|
| M0 contracts and attribution | T0.1–T0.3 | Approved public seams; `remote-protocol` ids/errors/schema; Codeg adoption validator and Apache-2.0 notice |
| M1 Plugin, Tool, Artifact, Office | T1.1–T1.11 | `plugins`, `tool-runtime`, `artifacts`, `office-runtime`; safe v1 migration; shared PluginAction UI; Office provider lifecycle and preview leases |
| M2 Delegation and Mention | T2.1–T2.8 | capability-driven Broker/companion, bounded IPC, first-terminal-wins, durable child projections, token-boundary `&Agent`, cards/navigation and two-child recovery journey |
| M3 Automation v2 | T3.1–T3.10 | versioned TurnLaunchSpec, DST scheduling, owner/claim locks, isolated launch, terminal reconciliation, cancellation windows, migration/templates/settings/history and Office journey |
| M4 Application and Transport | T4.1–T4.5 | Tauri/Axum-free Application Core, closed command registry, BackendTransport implementations and durable sequence attach |
| M5 Server and Web | T5.1–T5.8 | headless composition, hashed auth, HTTP/WS session path, product domain commands, preview proxy, owner takeover, isolated Remote Desktop profiles and optimized static E2E |
| M6 mobile protocol reservation | T6.1–T6.3 | versioned JSON Schema/OpenAPI, TS/Swift/Kotlin smoke, one-time pairing/revocation, QR affordance, notification summary and read-only unknown-event cache; no mobile app |
| M7 release hardening | T7.1–T7.4 | real v1 DB rehearsal, crash/race and attack matrices, dependency/license/advisory gates, operator docs and complete release/rollback checks |

## Final gap closures

The final audit found and closed five cross-milestone gaps:

1. `conversation.question` now has a dedicated Application Core use case,
   registered local/HTTP command and device/admin scope.
2. Web settings can create a five-minute pairing challenge and render an
   accessible one-time QR without placing either secret in a URL.
3. Automation terminal history/worktrees now have a shared 30-day/10-GiB
   retention service, SQLite adapter, symlink-safe accounting and desktop/
   Server lifecycle integration.
4. Non-owner Automation hosts expose an explicit read-only status and disable
   mutation rather than failing only after a click.
5. Production browser evidence now covers authenticated pairing, two
   Delegations with refresh recovery, Office Automation through worktree/
   Conversation/Turn/Artifact evidence, permission response, replay reconnect
   and opaque-origin preview. The fake Agent is injected only through the
   approved BackendTransport test seam.
6. Protocol generation now keeps TypeScript/Swift/Kotlin compiler outputs out
   of the checked-in schema directory, and CI rejects unknown or disallowed
   dependency licenses across pnpm and Cargo metadata.

## Platform evidence boundary

Tauri does not provide a macOS WebDriver backend. The desktop journeys therefore
run the production React components from an optimized multi-page build in
Chromium. Native Tauri command, Application Core, Remote Desktop and lifecycle
boundaries are verified separately by Rust and Transport integration tests.
No product route or handler contains an E2E-only behavior branch.

The exact final command results are recorded in
`docs/verification/agent-k-release-hardening.md`.

## Completion verdict

All planned T0.1–T7.4 implementation seams and repository-verifiable release
gates are complete on this worktree. `cargo test --workspace`, 203 frontend
test files (1009 tests), strict check/lint, generated type/database/protocol
checks, production frontend build, headless Server package smoke, dependency
and attribution gates, and four optimized Playwright journeys pass.

The only environment boundary is native macOS desktop WebDriver automation:
Tauri does not supply a supported macOS driver. The same production React
components are exercised from optimized assets, while native command,
Application Core, persistence, IPC and lifecycle behavior is covered at the
Rust/Transport integration seams. This is a documented evidence boundary, not
an unimplemented product branch.
