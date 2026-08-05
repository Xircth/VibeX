# Codeg Adoption

## Source

- Project: Codeg
- Repository: sibling checkout `codeg`
- Pinned commit: `549add8d3ba07f31464c9cddde8ba7a7478eed14`
- License: Apache License 2.0
- Upstream files reviewed:
  - `src-tauri/src/office_watch/mod.rs`
  - `src-tauri/src/commands/office_tools.rs`
  - `src-tauri/src/web/handlers/office_watch_proxy.rs`

## VibeX targets and adaptations

- `crates/artifacts/src/office.rs`: retained the one-file/one-process,
  reference-count, readiness, process-limit, crash-recovery, explicit-close,
  and idle-reaping behavior behind `ArtifactToolProvider`.
- `crates/artifacts/src/adapters.rs`: moved child process and loopback TCP
  handling behind testable ports. The executable is an absolute path from
  `ToolInstallationLock`; PATH lookup and provider-owned installation were
  deliberately removed.
- `crates/artifacts/src/service.rs`: added Artifact revision records,
  provider selection, preview leases, per-lease capabilities, and Conversation
  event references.
- `crates/office-runtime/src/lib.rs`,
  `src-tauri/src/office_runtime.rs`, and
  `src-tauri/src/commands/office_tools.rs`: replaced the legacy global watch
  map and remote shell installer with a shared, transport-neutral composition
  over Artifact Service and Agent A's managed Tool Runtime. Desktop and
  headless Server now use the same runtime.

The Codeg web proxy was studied for its security invariants. Agent J
reimplemented the public preview capability seam in
`crates/server/src/preview_proxy.rs`. VibeX accepts only Artifact Service
leases registered in the Server process, stores only the SHA-256 digest of
the short-lived capability, pins the upstream to its registered loopback
port, rejects traversal and host input, and never forwards bearer,
capability, cookie, or origin headers. HTML base/SSE references are rewritten
to the capability path; the production UI embeds the result in an opaque
origin iframe without `allow-same-origin`.

The resulting Rust is substantially reorganized for VibeX's ports-and-adapters
architecture and TDD seams. It is not a byte-identical vendor copy.

## Delegation and companion parity

The Agent D slice reviewed these additional files at the same pinned commit:

- `src-tauri/src/acp/delegation/{broker,companion,listener,parent_watcher,transport,types}.rs`
- `src-tauri/src/acp/delegation/tool_schema.json`
- `src-tauri/src/bin/codeg_mcp.rs`

VibeX reimplemented the observable behavior within its existing
`delegation`, `delegation-proto`, and `vibex-mcp` crates. Adopted behavior
includes asynchronous task ids, batched status waits, first-terminal-wins
setup races, per-parent cache isolation, bounded framing, parent teardown,
feedback pull/commit, blocking questions, independent feature groups, and
read-only session information. The tool schema was adapted from Codeg's
`@Agent`/`codeg://agent` convention to VibeX's structured `&Agent` and
`vibex://agent` contract. VibeX-specific changes include open `AgentId`,
Conversation UUIDs, event-sourced projection rebuild, token scope binding,
and a 256 KiB result cap.

No Codeg source file was copied byte-for-byte. This record and the project
notice preserve attribution for the adapted design, schema language, and
behavioral tests.

## Automation v2 parity

The Agent F slice reviewed these additional files at the same pinned commit:

- `src-tauri/src/models/automation.rs`
- `src-tauri/src/automation/engine.rs`
- `src-tauri/src/db/automation.rs`

VibeX reimplemented the observable scheduling behavior in the
transport-neutral `automation` crate and a SQLite adapter. Adopted behavior
includes manual and cron triggers, next-run advancement before execution,
run history, isolated workspaces, startup recovery, and ordinary built-in
templates. VibeX-specific changes include a versioned canonical
`TurnLaunchSpec`, explicit IANA timezones and deterministic DST handling, a
single data-directory owner lease, transactional due claims, durable
Conversation/Turn correlation, four terminal states, cancellation
checkpoints, resolved Agent/Plugin/Tool lock evidence, and safe migration of
legacy in-place rows to disabled shared-root drafts.

No Codeg Automation source file was copied byte-for-byte. The model, engine,
ports, migrations, and tests were rewritten around VibeX's event-sourced
Conversation authority and local-first SQLite schema.

## Application and transport contracts

The Agent I slice reviewed these additional files at the same pinned commit:

- `src/lib/transport/types.ts`
- `src/lib/transport/tauri-transport.ts`
- `src/lib/transport/remote-desktop-transport.ts`
- `src/lib/transport/web-event-stream.ts`
- `src/lib/transport/web-transport.ts`
- `src-tauri/src/bin/codeg_server.rs`
- `src-tauri/src/web/auth.rs`
- `src-tauri/src/web/router.rs`
- `src-tauri/src/web/event_bridge.rs`
- `src-tauri/src/web/ws.rs`

VibeX adopted the observable transport separation and attach lifecycle:
transport-neutral calls and subscriptions, capability discovery, snapshot or
replay catch-up, a high-water mark, and an explicit ready boundary before live
delivery. VibeX-specific changes replace Codeg's arbitrary string dispatch
with a typed command registry and replace the in-memory ACP ring buffer as the
recovery authority with persisted Conversation event sequences.

No Codeg Web router or Axum server file was copied byte-for-byte. VibeX adapted
the observable authenticated headless-server boundary, one WebSocket carrying
multiple durable subscriptions, and static SPA hosting. VibeX-specific changes
use a hashed bearer-token store, stable `remote-protocol` envelopes, a closed
Application command registry, persisted Conversation sequence replay, explicit
CORS allowlists, and one Automation owner lock per data directory. The
Application Core remains independent of Tauri and Axum; both local and remote
adapters invoke the same use cases.

Agent J extended this adaptation through the production React application.
`WebTransport` now drives the same Plugin, Artifact, Automation, and Delegation
facades through the closed registry. The Web bootstrap keeps its token only in
memory and authenticates before mounting the product UI. Capability-gated
settings omit desktop-only CEF/CDP and Tauri surfaces. The desktop-side
`RemoteDesktopTransport` sends credentials across IPC once, retains them only
in a redacted Rust registry keyed by window and Server profile, and performs
remote HTTP calls outside the WebView. Production Playwright tests boot the
actual `vibex-server`, serve the built static tree, authenticate, exercise SPA
navigation, and retain a video and screenshot.

## Agent K release review

Agent K reviewed the complete pinned Codeg adoption record while hardening the
mobile-ready protocol and release boundary. No Codeg iOS/Android source,
generated model, pairing implementation, migration fixture, security test or
operator document was copied or adapted. The TypeScript/Swift/Kotlin fixtures
are generated from VibeX's own `remote-protocol` Rust DTOs.

The schema smoke may download the official pinned Kotlin command-line compiler
and Eclipse Temurin JRE into ignored `target/tools` cache directories, verifies
both archives by SHA-256, and does not package either tool with VibeX. This adds
no Codeg attribution obligation and no mobile product source.

## Agent settings parity

The Agent settings implementation was audited separately against Codeg commit
`fa230248d285c3f4fa541a737fc93f209820512e` (2026-08-05). The review covered:

- `src/components/settings/acp-agent-settings.tsx`
- `src/components/settings/agent-diagnostics-dialog.tsx`
- `src/components/settings/{pi,kimi-code,codebuddy,cursor}-config-panel.tsx`
- `src/components/settings/{opencode-connect-dialog,opencode-plugins-modal}.tsx`
- `src/components/settings/{model-provider-settings,codex-model-list-editor}.tsx`
- `src/components/settings/{mcp-settings,custom-skills-settings}.tsx`
- `src-tauri/src/acp/{registry,preflight,manager,codex_model_catalog}.rs`
- `src-tauri/src/acp/{opencode_catalog,opencode_plugins}.rs`
- `src-tauri/src/commands/{acp,mcp,custom_skills,model_provider}.rs`
- `src-tauri/src/parsers/{opencode,kimi_code,grok,pi,cursor}.rs`

VibeX adopted the complete default Agent catalog and the observable settings
capabilities: pinned installation plans, validated specific-version installs,
bounded redacted live installation logs, dependency preflight, official account
actions, subscription links, authentication modes, native configuration,
Codex device authentication and model catalogs, reusable Model Providers,
OpenCode Provider/plugin management, Pi configuration, MCP, Skills, and local
history import. The final surface audit also covered Codeg's generic per-Agent
environment editor and install-log/diagnostics dialog. VibeX exposes equivalent
environment overrides with secret redaction and compare-and-set revisions, and
bootstraps Codeg's pinned uv release from official archives with per-platform
SHA-256 verification when Hermes cannot use a system uv. It also
shows bounded redacted operation diagnostics directly in Agent details while
retaining full diagnostic export. Its separate read-only environment report
compares the GUI process PATH with the login shell, probes the profile's exact
dependencies and launch target, and copies only a safe environment whitelist.
The final OpenCode audit added structured per-model ID/name editing and rename-safe
preservation of unknown model fields without returning saved credentials to the UI.
VibeX retains its own open `AgentId`, managed-install lock,
event-sourced Conversation model, optimistic native-file revisions, structured
Tauri DTOs, and fixed action whitelist. No Codeg command string is accepted from
the UI or configuration. Sensitive native files and credentials remain redacted
at the IPC boundary.

The capability contract and the exact pinned baseline are recorded in ADR-0037.
The implementation is reorganized around VibeX's `agents`, `services`, `db`, and
Tauri adapter layers; Codeg source files were not copied byte-for-byte.

## Verification

- `node --test scripts/check-third-party-adoption.test.js`
- `cargo test -p artifacts`
- `cargo test -p artifacts --test local_adapters`
- `cargo test -p conversations artifact_revision_event_projects_reference_without_file_bytes`
- `cargo test -p vibex office`
- `cargo test -p delegation-proto`
- `cargo test -p delegation`
- `cargo test -p vibex-mcp`
- `cargo test -p conversations delegation_events_rebuild_child_binding`
- `cargo test -p automation`
- `cargo test -p db automation`
- `cargo test -p conversations`
- `cargo test -p server --test web_domains`
- `cargo test -p server --test preview_proxy`
- `cargo test -p server --test static_assets`
- `cargo test -p vibex remote_desktop`
- `cd frontend && pnpm test -- src/lib/transport/remoteDesktopTransport.test.ts`
- `pnpm run frontend:build`
- `pnpm run test:web:e2e`
- `cargo test -p agents`
- `cargo test -p services agent_management`
- `cargo test -p vibex --features qa-mode agent_management::tests`
- `cd frontend && pnpm exec vitest run src/pages/settings/Agent*.test.tsx`

## Apache-2.0 obligations

VibeX preserves the upstream license and attribution in
`THIRD_PARTY_NOTICES.md`. A complete copy of Apache License 2.0 is in
`docs/third-party/licenses/Apache-2.0.txt`. Modified files carry VibeX-specific
documentation and this adoption record identifies the changes.
