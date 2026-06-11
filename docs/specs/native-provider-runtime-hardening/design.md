# Native Provider Runtime Hardening Design

## Overview

The current native provider runtime has the right high-level shape:

```text
provider_runtime_send_turn
  -> ensure_provider_session
  -> try_native_provider_turn
  -> provider-specific runtime
  -> ProviderRuntimeEvent + ExecutionProcess logs
```

The hardening work keeps that shape and tightens the weak boundaries:

1. fallback policy becomes explicit;
2. raw provider events are normalized behind provider-owned adapters;
3. provider event history is not silently memory-only;
4. bridge process lifecycle is shared;
5. interrupt and app-server lifecycle are owned by a runtime registry.

## Target Runtime Flow

```text
provider_runtime_send_turn
  -> validate_provider_executor_profile
  -> ensure_provider_session
  -> resolve fallback policy
  -> native runtime start
     -> provider-specific raw events
     -> ProviderEventAdapter::normalize_event
     -> persist raw/envelope event if configured
     -> project normalized events to conversation log
  -> return execution_started or native_error event
```

ACP fallback is not a hidden second start path. It is a visible runtime choice:

```text
native start fails
  -> return native_error unless fallback policy says auto
  -> if auto fallback is enabled, start ACP fallback and include fallback_reason
```

## Components And Ownership

### 1. Fallback Policy

Owning files:

- `src-tauri/src/commands/provider_runtime/runtime_config.rs`
- `src-tauri/src/commands/provider_runtime/provider_turns.rs`
- `src-tauri/src/commands/provider_runtime/history_commands.rs`
- `src-tauri/src/commands/provider_runtime/contract.rs`

Current code:

- `provider_runtime_send_turn` catches any native error and calls `fallback_acp_turn`.
- `acp_fallback_config` defaults to enabled when no env var is set.
- `ProviderRuntimeContract.fallback_enabled_by_default` is `true`.

Target change:

- Add a small fallback policy resolver, for example:

```rust
pub(super) enum ProviderFallbackPolicy {
    Disabled,
    Manual,
    Auto,
}
```

- Default policy for primary native provider sends should be `Manual` or `Disabled`, not `Auto`.
- Keep existing `force_acp_fallback` request option as an explicit request to bypass native.
- Add an explicit `allow_acp_fallback` or `fallback_policy = "auto"` provider option if auto fallback remains needed for compatibility.
- `provider_runtime_send_turn` must return a `ProviderRuntimeEvent` with `method = "turn/error"` or `type = "native_runtime_error"` when native fails and fallback is not auto.
- `fallback_acp_turn` remains the only function that starts ACP fallback.

Do not:

- remove ACP fallback adapters;
- change legacy executor ACP behavior outside provider runtime;
- start fallback from inside provider-specific native runner functions.

### 2. Provider Event Normalization

Owning files:

- New: `src-tauri/src/commands/provider_runtime/provider_events.rs`
- New: `src-tauri/src/commands/provider_runtime/codex_events.rs`
- New: `src-tauri/src/commands/provider_runtime/claude_events.rs`
- New: `src-tauri/src/commands/provider_runtime/opencode_events.rs`
- Existing: `provider_text.rs`, `provider_tools.rs`, `native_conversation.rs`
- Existing frontend: `frontend/src/features/provider-runtime/providerFrontendAdapters.ts`

Current code:

- `provider_text.rs` recursively searches raw JSON for thread IDs, turn IDs, assistant text, status, and snapshots.
- `provider_tools.rs` performs provider-specific tool inference from raw JSON.
- `native_conversation.rs` consumes raw provider events directly.
- `providerFrontendAdapters.ts` repeats raw JSON parsing for status/text.

Target change:

- Introduce a backend shared normalized provider event enum, exported to TypeScript only if the frontend must consume it directly.
- Each provider gets its own adapter module:
  - `codex_events.rs`: maps app-server JSON-RPC notifications/results.
  - `claude_events.rs`: maps `sdk_event`, `sdk_context_usage`, `sdk_error`.
  - `opencode_events.rs`: maps `opencode_sdk_event`, `opencode_sdk_response`, `opencode_sdk_error`.
- `native_conversation.rs` consumes normalized events first. It may keep raw event metadata for inspection.
- `provider_text.rs` becomes a compatibility helper during migration, then shrinks to shared primitive helpers only.
- Frontend `mapProviderRuntimeEvent` should read a backend-normalized status/text payload instead of using `assistantPayloadText` and `eventText` heuristics.

Do not:

- introduce a single new giant `match all provider JSON` function;
- move provider protocol quirks into React components;
- remove raw metadata from logs while diagnostics still need it.

### 3. Provider Event Persistence

Owning files:

- Existing: `src-tauri/src/commands/provider_runtime/provider_text.rs`
- Existing: `src-tauri/src/commands/provider_runtime/history_commands.rs`
- New or existing DB model/migration under `crates/db/`

Current code:

- `PROVIDER_EVENT_HISTORY` is an in-memory `HashMap`.
- `provider_runtime_load_history` combines in-memory provider events with DB execution log previews.

Selected policy:

- Option B is selected for this hardening pass. Raw provider runtime events remain live-only
  diagnostics, while persisted history is represented by normalized execution logs and log
  previews. This avoids adding a DB migration before the product needs raw event replay as a
  durable history feature.

Target options:

Option A, preferred if raw diagnostics matter:

- Add a provider runtime events table with fields:
  - `id`
  - `session_id`
  - `execution_process_id` nullable
  - `provider`
  - `workspace_id`
  - `thread_id` nullable
  - `turn_id` nullable
  - `runtime_source`
  - `event_kind`
  - `raw_event_json`
  - `normalized_event_json` nullable
  - `created_at`
- Replace `push_provider_event` memory-only storage with append-to-DB plus small optional live cache.
- `provider_runtime_load_history` reads persisted events.

Option B, acceptable if raw diagnostics are intentionally not product history:

- Remove the implication that `events` is complete after restart.
- Keep `events` as live-only and return a `raw.history_retention = "normalized_logs_only"` marker.
- Document that persisted history is execution logs, not raw provider event streams.

Do not:

- persist only the first 24 log entries and call it complete raw history;
- add DB schema changes without `prepare-db` verification.

### 4. Shared Node Bridge Runner

Owning files:

- Existing: `src-tauri/src/commands/provider_runtime/provider_turns.rs`
- New: `src-tauri/src/commands/provider_runtime/bridge_runner.rs`
- Existing: `claude_sdk.rs`, `opencode_sdk.rs`

Current code:

- `start_claude_sdk_native_turn` and `start_opencode_sdk_native_turn` duplicate process setup, stdout/stderr readers, temp file cleanup, active-turn registration, process completion, session status update, and message-store finish.

Target change:

- Create `bridge_runner.rs` for line-delimited JSON bridge processes.
- Suggested input:

```rust
pub(super) struct BridgeRunSpec {
    provider: ProviderId,
    runtime_source: &'static str,
    program: &'static str,
    args: Vec<String>,
    input_path: PathBuf,
    workspace_id: Uuid,
    workspace_dir: PathBuf,
    session_id: Uuid,
    process_id: Uuid,
    initial_thread_id: Option<String>,
    turn_id: String,
}
```

- The runner owns:
  - `new_provider_hidden_command`
  - stdout/stderr JSONL loops
  - `NATIVE_ACTIVE_TURNS`
  - temp file cleanup
  - `ExecutionProcess::update_completion`
  - `Session::update_status`
  - `msg_store.push_finished`
- Provider-specific functions only build input JSON and call the shared runner.

Do not:

- move Codex app-server into the bridge runner;
- change SDK bridge JS protocol in the same task unless a test proves it is required.

### 5. Runtime Registry And Interrupt

Owning files:

- Existing: `src-tauri/src/commands/provider_runtime/mod.rs`
- Existing: `history_commands.rs`
- Existing: `codex_app_server.rs`
- New: `runtime_registry.rs` if it reduces global-state spread.

Current code:

- `NATIVE_ACTIVE_TURNS` maps `turn_id -> child`.
- Codex app-server registry is a static map keyed by workspace/runtime key.
- Generic interrupt kills only the stored child.
- Codex interrupt sends `turn/interrupt` when thread and turn IDs exist.

Target change:

- Track active native turns by `process_id`, `provider`, `session_id`, `thread_id`, `turn_id`, and owned process/group handle.
- For bridge providers, terminate the process group where platform support exists.
- Interrupt updates `ExecutionProcess` to `Killed` through a shared completion helper.
- Codex app-server registry stores health state and last-used timestamps.
- Add explicit eviction:
  - remove dead processes on failed health check;
  - remove idle app-server after a configured duration or on workspace cleanup;
  - expose shutdown helper for tests and workspace cleanup.

Do not:

- kill all app-server processes to interrupt one Codex turn;
- rely on frontend-only state to decide whether a turn is active.

### 6. Runtime Status And Dependencies

Owning files:

- `contract.rs`
- `runtime_core.rs`
- `scripts/claude-agent-sdk-provider.mjs`
- `scripts/opencode-sdk-provider.mjs`

Current code:

- Runtime status reports native/fallback availability.
- Claude/OpenCode probes run `node bridge --probe`.
- Codex probe runs `codex app-server --help`.

Target change:

- Keep `ProviderRuntimeContract.dependencies` user-readable.
- Improve status detail so missing `node`, missing npm SDK package, missing `codex`, missing `opencode`, and auth/config missing are separate where detectable.
- Avoid probing heavy metadata APIs from status checks.

Do not:

- make status probing start a long-lived app-server except for Codex paths that already require it for model/control surfaces;
- require network access for status.

## Implementation Order

1. Fallback policy behavior lock and explicit native-error event.
2. Provider event normalization types and one provider adapter, starting with Codex because it already has the richest app-server protocol.
3. Move Claude/OpenCode bridge runner duplication behind `bridge_runner.rs`.
4. Add provider event persistence or explicitly narrow history semantics.
5. Harden interrupt/runtime registry.
6. Thin frontend raw-event parsing after backend normalized events are available.
7. Improve runtime status dependency reporting.

## Risk And Mitigation

- Risk: changing fallback default surprises users who relied on transparent compatibility fallback.
  - Mitigation: support explicit `allow_acp_fallback` or provider/profile policy and surface the fallback option in status/error detail.
- Risk: normalized event model becomes too abstract and loses provider detail.
  - Mitigation: keep raw event metadata attached; normalize only status/text/tool/error/token lifecycle concepts.
- Risk: DB persistence increases migration and compatibility scope.
  - Mitigation: make provider event persistence its own task; choose Option B if product does not need raw event replay yet.
- Risk: process-group kill differs across Windows/macOS/Linux.
  - Mitigation: use existing `utils::process` helpers where possible and add unit tests for registry state transitions; manual desktop verification remains required.

## Verification Checkpoints

- After fallback policy: `cargo test -p vibex provider_runtime --lib`
- After normalized event adapter introduction: `cargo test -p vibex provider_runtime --lib`
- After bridge runner extraction: `cargo test -p vibex provider_runtime --lib` and `pnpm run backend:check`
- After DB persistence: `pnpm run prepare-db`, `pnpm run prepare-db:check`, `cargo test -p vibex provider_runtime --lib`
- After shared type changes: `pnpm run generate-types`, `pnpm run generate-types:check`, `pnpm run frontend:check`
- After frontend adapter thinning: `cd frontend && pnpm vitest run src/features/provider-runtime`, `pnpm run frontend:lint`
