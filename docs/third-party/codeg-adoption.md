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
- `src-tauri/src/office_runtime.rs` and
  `src-tauri/src/commands/office_tools.rs`: replaced the legacy global watch
  map and remote shell installer with a thin adapter over Artifact Service and
  Agent A's managed Tool Runtime.

The Codeg web proxy was studied for its security invariants. No Axum route was
ported in this slice. VibeX exposes only the lease data needed by a future web
proxy: Artifact id, provider id, watch key, loopback port, high-entropy
capability token, expiry, and reference count.

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
- `src-tauri/src/web/router.rs`
- `src-tauri/src/web/event_bridge.rs`

VibeX adopted the observable transport separation and attach lifecycle:
transport-neutral calls and subscriptions, capability discovery, snapshot or
replay catch-up, a high-water mark, and an explicit ready boundary before live
delivery. VibeX-specific changes replace Codeg's arbitrary string dispatch
with a typed command registry and replace the in-memory ACP ring buffer as the
recovery authority with persisted Conversation event sequences.

No Codeg Web router or Axum server implementation was ported. The Application
Core is independent of Tauri and Axum, and the local Tauri command is only an
adapter over the same use case used by future remote transports.

## Verification

- `node --test scripts/check-codeg-adoption.test.js`
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

## Apache-2.0 obligations

VibeX preserves the upstream license and attribution in
`THIRD_PARTY_NOTICES.md`. A complete copy of Apache License 2.0 is in
`docs/third-party/licenses/Apache-2.0.txt`. Modified files carry VibeX-specific
documentation and this adoption record identifies the changes.
