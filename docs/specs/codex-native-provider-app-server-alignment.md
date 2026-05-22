# Codex Native Provider App-Server Alignment Spec

## Requirements

**User Story:** As a VibeX user running Codex through the native provider, I want the provider to match the official `codex app-server` protocol, so that supported Codex features behave predictably instead of appearing available but failing at runtime.

### Acceptance Criteria

1. WHEN VibeX sends a JSON-RPC request to `codex app-server` THEN the native provider SHALL treat a JSON-RPC `error` response as a failed request, not as a healthy success.
2. WHEN VibeX checks a reusable Codex app-server process THEN the health probe SHALL only pass on a successful `model/list` response.
3. WHEN VibeX lists Codex models THEN the native provider SHALL query `model/list` from `codex app-server` and only fall back to local defaults when the app-server cannot provide models.
4. WHEN VibeX reports Codex provider capabilities THEN capabilities SHALL reflect the currently implemented native-provider surface, not the full upstream app-server surface.
5. WHEN a user sends a follow-up while a Codex turn is running THEN the native provider SHALL use the official `turn/steer` path when a thread id and turn id are available.
6. WHEN a Codex executor profile defines prompt/instruction fields THEN the native provider SHALL pass official `turn/start` instruction fields where the app-server supports them.
7. IF an upstream app-server feature is intentionally not wired yet THEN the spec SHALL mark it as out of this implementation slice rather than advertising it as fully available.
8. WHEN Codex emits token usage around context compaction THEN zero-valued transient `last` snapshots SHALL NOT be displayed as real 0% context usage while a non-zero `total` snapshot or no trustworthy usage is available.

## Design

### Overview

The native-provider already owns the Codex app-server process lifecycle and basic `thread/start`, `thread/resume`, `thread/fork`, `thread/compact/start`, `turn/start`, and `turn/interrupt` calls. This change tightens the protocol boundary and adds small, official app-server features that map cleanly to the current VibeX backend.

This implementation slice adds the official skills/apps/hooks app-server surfaces requested for VibeX. It does not build account login, dynamic tools, or full Codex history browsing.

### Components and Interfaces

- `codex_app_server.rs`
  - Add a success/error helper for JSON-RPC responses.
  - Reuse that helper for health checks and turn control calls.
  - Add `model/list` loading and robust response parsing.
  - Add `turn/steer` helper for mid-turn follow-up.
  - Pass `baseInstructions` from Codex profile/request options.
  - Add narrow wrappers for `skills/list`, `skills/config/write`, `hooks/list`, `config/batchWrite`, and `app/list`.
  - Accept `skill` and `mention` input items through `provider_options` for official skill/app invocation hints.
- `history_commands.rs`
  - Route Codex model listing through the app-server helper.
  - Prefer `turn/steer` in `provider_runtime_send_turn` when continuing an active Codex turn.
- `contract.rs`
  - Downgrade Codex `approvals` and `user_input_requests` to partial until server-initiated request UI is connected.
- `runtime_config.rs`
  - Extend resolved Codex runtime options with profile-backed instruction fields.
- Tests
  - Cover JSON-RPC error classification, model response parsing, capability truthfulness, and turn steer request shape where practical.
- `token_usage.rs`
  - Consume Codex context meter values only from the normal `thread/tokenUsage/updated` path.
  - Treat `thread/compacted` as a lifecycle signal, not a token usage source.
  - Treat a zero Codex `last` usage snapshot as missing for context-meter purposes, without falling back to cumulative `total` usage when `last` is present.
  - Preserve non-zero `last` usage for normal turn updates so the meter still reflects current model-visible context.
- `TokenUsageIndicator.tsx`
  - Do not render a 0% context indicator from an absent or non-positive usage snapshot; wait for a trustworthy backend usage value.

### Data Models

No shared TypeScript type changes are required for this slice. Existing `provider_options` can carry advanced options such as `base_instructions`, `baseInstructions`, or `developer_instructions`.

### Error Handling

- JSON-RPC responses containing `error` are converted to an `Err` with the server message.
- `model/list` failures fall back to a small local model list to preserve settings-page resilience, but the model source detail remains app-server-oriented in code comments and tests.
- `turn/steer` is best-effort only when both `thread_id` and `turn_id` are supplied. If unavailable, VibeX falls back to the existing `turn/start` continuation path.

### Out Of Scope For This Slice

- Full server-initiated approval/request UI for `item/*/requestApproval`.
- `account/*` login/rate-limit UI.
- `thread/list`, `thread/read`, `thread/turns/list`, archive/unarchive UX.
- Dynamic tools.
- Host command/process/fs app-server APIs as standalone VibeX surfaces.

## Tasks

- [x] 1. Foundation: strict JSON-RPC success handling
  - Add helpers for response error extraction and success assertion.
  - Use them in app-server health checks and existing Codex request paths.
  - _Requirements: 1, 2_

- [x] 2. Model listing
  - Add Codex app-server `model/list` loader with resilient response parsing.
  - Route `provider_runtime_list_models(Codex)` through it.
  - _Requirements: 3_

- [x] 3. Capability truthfulness
  - Change Codex approvals and user-input capability states from available to partial.
  - Explain missing server-initiated request UI in details.
  - _Requirements: 4, 7_

- [x] 4. Mid-turn steering
  - Add `turn/steer` helper.
  - Use it when a Codex request includes both thread id and active turn id through provider options.
  - _Requirements: 5_

- [x] 5. Instruction passthrough
  - Resolve Codex profile `base_instructions` / `developer_instructions`.
  - Pass supported instruction text to `turn/start`.
  - _Requirements: 6_

- [x] 6. Verification
  - Run `cargo fmt`.
  - Run targeted provider-runtime tests.
  - Run backend check or explain unrelated failures.
  - _Requirements: 1-7_

- [x] 7. Skills/apps/hooks app-server support
  - Expose `skills/list` and `skills/config/write` through provider-runtime commands.
  - Expose `app/list` through provider-runtime commands.
  - Expose `hooks/list` and hook state writes through provider-runtime commands.
  - Support official `skill` and `mention` turn input items.
  - _Requirements: 4, 7_

- [x] 8. Context-compaction token usage correctness
  - Compare official app-server compaction/token-usage docs with the native-provider event parser.
  - Stop synthesizing usage entries from `thread/compacted`.
  - Ignore zero transient Codex `last` snapshots instead of treating cumulative `total` usage as context-window usage.
  - Add backend and frontend regression coverage for "unknown/pending is not 0%".
  - _Requirements: 8_
