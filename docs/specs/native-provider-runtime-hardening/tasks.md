# Native Provider Runtime Hardening Tasks

## Task 1: Lock Fallback Policy Semantics

- [x] Task: Add tests proving native provider send-turn does not silently ACP fallback by default.
  - Acceptance: A simulated native startup failure returns a native error event/status unless fallback is explicitly allowed.
  - Verify: `cargo test -p vibex provider_runtime --lib`
  - Files: `src-tauri/src/commands/provider_runtime/tests*.rs`, `provider_turns.rs`, `history_commands.rs`, `runtime_config.rs`, `contract.rs`

- [x] Task: Implement explicit fallback policy resolution.
  - Acceptance: `force_acp_fallback` still bypasses native; auto fallback only occurs through an explicit request/profile/env policy; fallback events include structured `fallback_reason`.
  - Verify: `cargo test -p vibex provider_runtime --lib`
  - Files: `runtime_config.rs`, `provider_turns.rs`, `history_commands.rs`, `contract.rs`

## Task 2: Introduce Backend Normalized Provider Events

- [x] Task: Add shared normalized provider event types without changing frontend behavior yet.
  - Acceptance: Types cover turn started/completed/error, assistant text delta/snapshot, tool update, token usage, diagnostic, and raw passthrough.
  - Verify: `cargo test -p vibex provider_runtime --lib`
  - Files: `provider_runtime/contract.rs` or new `provider_events.rs`, `provider_runtime/mod.rs`

- [x] Task: Implement Codex event adapter first.
  - Acceptance: Codex adapter maps representative `turn/started`, `item/agentMessage/delta`, `turn/completed`, `turn/error`, token usage, and tool/file events to normalized events.
  - Verify: `cargo test -p vibex provider_runtime --lib`
  - Files: new `codex_events.rs`, existing `provider_text.rs`, `provider_tools.rs`, `native_conversation.rs`, tests

- [x] Task: Implement Claude event adapter.
  - Acceptance: Claude adapter maps `sdk_event`, `sdk_context_usage`, and `sdk_error` fixtures without relying on broad cross-provider recursive extraction.
  - Verify: `cargo test -p vibex provider_runtime --lib`
  - Files: new `claude_events.rs`, `provider_text.rs`, `native_conversation.rs`, tests

- [x] Task: Implement OpenCode event adapter.
  - Acceptance: OpenCode adapter maps `opencode_sdk_event`, `opencode_sdk_response`, and `opencode_sdk_error` fixtures; message part deltas do not create duplicate assistant entries.
  - Verify: `cargo test -p vibex provider_runtime --lib`
  - Files: new `opencode_events.rs`, `provider_text.rs`, `provider_tools.rs`, `native_conversation.rs`, tests

## Task 3: Extract Shared Node Bridge Runner

- [x] Task: Add bridge-runner behavior tests using fake JSONL stdout/stderr fixtures or isolated runner helpers.
  - Acceptance: Tests cover stdout JSON event routing, stderr diagnostic routing, temp input cleanup, completion status, and active-turn removal.
  - Verify: `cargo test -p vibex provider_runtime --lib`
  - Files: new `bridge_runner.rs`, provider runtime tests

- [x] Task: Move Claude SDK turn execution to the bridge runner.
  - Acceptance: Claude-specific code only builds bridge input/args and delegates process lifecycle; visible events and persisted logs remain behaviorally equivalent.
  - Verify: `cargo test -p vibex provider_runtime --lib`; `pnpm run backend:check`
  - Files: `provider_turns.rs`, `bridge_runner.rs`, `claude_sdk.rs`

- [x] Task: Move OpenCode SDK turn execution to the bridge runner.
  - Acceptance: OpenCode-specific code only builds bridge input/args and delegates process lifecycle; child cleanup behavior remains equivalent or stronger.
  - Verify: `cargo test -p vibex provider_runtime --lib`; `pnpm run backend:check`
  - Files: `provider_turns.rs`, `bridge_runner.rs`, `opencode_sdk.rs`

## Task 4: Decide And Implement Provider Event History Policy

- [x] Task: Choose persistence policy before code changes.
  - Acceptance: `design.md` is updated to mark either Option A persistent raw events or Option B normalized-logs-only history as selected.
  - Verify: Review spec diff.
  - Files: `docs/specs/native-provider-runtime-hardening/design.md`

- [ ] Task: If Option A, add provider runtime event persistence.
  - Acceptance: Provider events survive app restart and `provider_runtime_load_history` loads them from DB.
  - Verify: `pnpm run prepare-db`; `pnpm run prepare-db:check`; `cargo test -p vibex provider_runtime --lib`
  - Files: `crates/db/migrations/*`, `crates/db/src/models/*`, `provider_text.rs`, `history_commands.rs`

- [x] Task: If Option B, make live-only raw history explicit.
  - Acceptance: History API response marks raw provider events as live-only and does not imply complete persisted raw history.
  - Verify: `cargo test -p vibex provider_runtime --lib`; `pnpm run generate-types:check` if shared types change
  - Files: `history_commands.rs`, `contract.rs`, tests

## Task 5: Harden Runtime Registry And Interrupt

- [x] Task: Add active native runtime registry tests.
  - Acceptance: Tests cover register, lookup by turn/process, provider mismatch, completion removal, and killed completion.
  - Verify: `cargo test -p vibex provider_runtime --lib`
  - Files: new `runtime_registry.rs` or `mod.rs` state helpers, tests

- [x] Task: Route bridge interrupts through registry-owned process termination.
  - Acceptance: Interrupt marks the associated execution process `Killed`, removes active registry entry, and finishes msg store.
  - Verify: `cargo test -p vibex provider_runtime --lib`; manual desktop interrupt check when implementing visible behavior
  - Files: `history_commands.rs`, `bridge_runner.rs`, `native_conversation.rs`, `runtime_registry.rs`

- [x] Task: Add Codex app-server lifecycle policy.
  - Acceptance: Dead app-server entries are evicted on health failure; idle or workspace-cleanup shutdown is explicit; interrupt still targets turn-level `turn/interrupt`.
  - Verify: `cargo test -p vibex provider_runtime --lib`
  - Files: `codex_app_server.rs`, `mod.rs` or `runtime_registry.rs`, tests

## Task 6: Thin Frontend Raw Event Heuristics

- [x] Task: Add frontend tests for backend-normalized event consumption.
  - Acceptance: Frontend maps normalized status/text/tool diagnostics without recursive provider raw-event parsing.
  - Verify: `cd frontend && pnpm vitest run src/features/provider-runtime`
  - Files: `frontend/src/features/provider-runtime/providerFrontendAdapters.test.ts`

- [x] Task: Replace frontend raw-event text/status heuristics with normalized event handling.
  - Acceptance: `providerFrontendAdapters.ts` no longer owns broad `assistantPayloadText` / `eventText` provider protocol parsing for native events; backend remains source of truth.
  - Verify: `cd frontend && pnpm vitest run src/features/provider-runtime`; `pnpm run frontend:check`; `pnpm run frontend:lint`
  - Files: `frontend/src/features/provider-runtime/providerFrontendAdapters.ts`, tests, generated shared types if needed

## Task 7: Improve Runtime Status Detail

- [x] Task: Refine runtime dependency probes.
  - Acceptance: Status can distinguish missing `node`, missing SDK bridge package, missing `codex`, missing `opencode`, and available primary runtime where detectable without heavy startup.
  - Verify: `cargo test -p vibex provider_runtime --lib`
  - Files: `runtime_core.rs`, `contract.rs`, `scripts/claude-agent-sdk-provider.mjs`, `scripts/opencode-sdk-provider.mjs`, tests

- [x] Task: Surface status detail through existing UI without redesigning settings.
  - Acceptance: Provider runtime panel displays clearer dependency details using existing design tokens/components.
  - Verify: `pnpm run frontend:check`; `pnpm run frontend:lint`; `npx impeccable detect --fast --json frontend/src/components frontend/src/styles` if UI styling changes
  - Files: `frontend/src/components/settings/ProviderRuntimePanel.tsx`, tests if present

## Final Verification

- [x] Run `cargo test -p vibex provider_runtime --lib`
- [x] Run `pnpm run backend:check`
- [ ] Run `pnpm run backend:lint` - blocked: current `nightly-2025-12-04-x86_64-pc-windows-msvc` toolchain reports `cargo-clippy.exe` is not applicable.
- [x] Run `pnpm run frontend:check`
- [x] Run `pnpm run frontend:lint`
- [x] Run `pnpm run generate-types:check`
- [ ] Run `pnpm run prepare-db:check` if DB persistence is selected
- [x] Run `pnpm run check`
- [ ] Run `pnpm run lint` - blocked by the same unavailable backend clippy component after frontend lint passes.
