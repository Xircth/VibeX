# Spec: Native Provider Runtime Hardening

## Assumptions

1. This work hardens the current provider runtime in `src-tauri/src/commands/provider_runtime/`; it does not replace the session, execution process, or conversation log systems.
2. Claude, Codex, and OpenCode remain the only native-provider IDs in this scope.
3. Native runtimes remain provider-specific: Claude uses the Node SDK bridge, Codex uses `codex app-server`, and OpenCode uses the Node SDK bridge that starts/connects to OpenCode.
4. No new runtime dependency is introduced unless a later task explicitly documents why existing Rust/Node utilities cannot solve the problem.
5. Database persistence for provider events may require a migration; if implemented, it must be a dedicated task with generated SQLx metadata/checks.

## Objective

Make native provider execution inspectable, deterministic, and hard to accidentally route through the wrong runtime. The user should be able to tell whether a turn ran through the primary native runtime or ACP fallback, recover useful history after restart, and see stable conversation output regardless of provider-specific raw event shape.

## User Stories

1. As a user sending a native-provider turn, I want native runtime failures to be visible and actionable, so I do not unknowingly continue a session through a different fallback adapter.
2. As a user reopening VibeX, I want provider runtime history and normalized conversation state to remain inspectable, so prior native turns are not limited to in-memory events.
3. As a maintainer adding or updating a provider protocol, I want provider-specific event mapping to be owned by provider adapters, so parser changes do not regress unrelated providers.
4. As a user interrupting a native-provider turn, I want VibeX to stop the whole owned runtime tree, so helper processes do not survive after cancellation.
5. As a developer reviewing this code, I want Claude/OpenCode bridge execution to share one runner, so lifecycle fixes land once.

## Acceptance Criteria

1. WHEN a native runtime fails before a turn starts THEN `provider_runtime_send_turn` SHALL return a native failure event/status by default and SHALL NOT silently start ACP fallback unless the request or profile explicitly requests fallback.
2. WHEN ACP fallback is used THEN the resulting event SHALL include `runtime_source = "acp_fallback"` and a structured fallback reason that references the native error.
3. WHEN a provider raw event is processed THEN provider-specific code SHALL map it to a shared normalized event shape before conversation rendering or frontend thread operations consume it.
4. WHEN frontend provider runtime UI receives provider events THEN it SHALL rely on the shared backend-normalized event shape for status and text, not on duplicate frontend raw-event heuristics.
5. WHEN provider history is loaded after an app restart THEN native provider events needed for diagnostics SHALL be available from persistent storage, or the history API SHALL explicitly report that only normalized execution logs are retained.
6. WHEN a Claude or OpenCode SDK turn runs THEN shared bridge-runner code SHALL own temp input files, stdout/stderr JSONL reading, child wait, active-turn registration, process completion, and message-store cleanup.
7. WHEN a native turn is interrupted THEN VibeX SHALL terminate the owned process tree or provider-native turn where available, and SHALL mark the associated execution process as killed.
8. WHEN Codex app-server instances are reused THEN the runtime registry SHALL evict unhealthy or completed workspace servers through an explicit lifecycle policy.
9. WHEN provider dependency status is probed THEN status SHALL distinguish missing Node/SDK bridge, missing provider CLI/runtime, auth/config missing, and primary runtime unavailable where the current code can detect them.
10. WHEN these changes touch shared TypeScript types THEN generated files SHALL be regenerated from Rust source, not edited manually.

## Commands

- Backend focused tests: `cargo test -p vibex provider_runtime --lib`
- Backend check: `pnpm run backend:check`
- Backend lint: `pnpm run backend:lint`
- Type generation: `pnpm run generate-types`
- Type generation check: `pnpm run generate-types:check`
- Frontend focused tests: `cd frontend && pnpm vitest run src/features/provider-runtime`
- Frontend check: `pnpm run frontend:check`
- Frontend lint: `pnpm run frontend:lint`
- Full check: `pnpm run check`
- Full lint: `pnpm run lint`

## Project Structure

- `src-tauri/src/commands/provider_runtime/contract.rs`: provider IDs, capability/status/runtime contracts, shared event DTOs.
- `src-tauri/src/commands/provider_runtime/history_commands.rs`: Tauri command entry points for status, send turn, interrupt, history, and Codex control surfaces.
- `src-tauri/src/commands/provider_runtime/provider_turns.rs`: native turn orchestration and ACP fallback policy.
- `src-tauri/src/commands/provider_runtime/codex_app_server.rs`: Codex app-server lifecycle and JSON-RPC request handling.
- `src-tauri/src/commands/provider_runtime/claude_sdk.rs`: Claude SDK bridge input/metadata helpers only.
- `src-tauri/src/commands/provider_runtime/opencode_sdk.rs`: OpenCode SDK bridge input/metadata helpers only.
- `src-tauri/src/commands/provider_runtime/provider_text.rs`: current provider raw text/id extraction; target is to shrink this into shared helpers plus provider-specific adapters.
- `src-tauri/src/commands/provider_runtime/provider_tools.rs`: current provider raw tool extraction; target is to consume normalized provider events where practical.
- `src-tauri/src/commands/provider_runtime/native_conversation.rs`: normalized conversation log projection.
- `frontend/src/features/provider-runtime/providerFrontendAdapters.ts`: frontend provider runtime adapter; target is to remove duplicated raw-event parsing.
- `shared/types.ts`: generated only; never edit manually.

## Code Style

Provider-specific mapping should be explicit and typed at the boundary:

```rust
pub(super) enum NormalizedProviderEvent {
    TurnStarted { thread_id: Option<String>, turn_id: Option<String> },
    TurnCompleted { thread_id: Option<String>, turn_id: Option<String> },
    AssistantTextDelta { id: Option<String>, text: String },
    ToolUpdate(NativeToolUpdate),
    Diagnostic { level: ProviderDiagnosticLevel, message: String },
    Raw { event: serde_json::Value },
}

pub(super) trait ProviderEventAdapter {
    fn normalize_event(&self, event: &serde_json::Value) -> Vec<NormalizedProviderEvent>;
}
```

Keep provider protocol knowledge inside `codex_*`, `claude_*`, and `opencode_*` adapters. Shared orchestration code may route by `ProviderId`, but it must not infer provider semantics from broad recursive JSON key searches.

## Testing Strategy

- Unit-test each provider event adapter with compact raw event fixtures.
- Unit-test fallback policy independently from process spawning.
- Unit-test bridge-runner behavior with fake JSONL stdout/stderr where possible.
- Unit-test interrupt/lifecycle registry behavior without launching real provider CLIs.
- Keep existing `cargo test -p vibex provider_runtime --lib` green after each slice.
- Add frontend tests only where frontend behavior changes; frontend should mostly become thinner after backend normalization.

## Boundaries

- Always: preserve existing `Session`, `ExecutionProcess`, `CodingAgentTurn`, and normalized log ownership.
- Always: make runtime source visible in events and diagnostics.
- Always: add behavior-lock tests before moving lifecycle or event-normalization code.
- Always: keep changes provider-scoped unless a shared helper removes real duplication.
- Ask first: adding a new crate or npm dependency.
- Ask first: changing database schema outside provider event persistence.
- Ask first: changing public session/execution process semantics unrelated to native providers.
- Never: manually edit `shared/types.ts`.
- Never: remove ACP fallback support entirely; this plan changes fallback policy, not compatibility availability.
- Never: make frontend heuristics mask backend protocol mismatches.
- Never: rewrite `code-reference/` or `code-referance/`.

## Success Criteria

1. Native failure and ACP fallback are distinguishable in API results, persisted logs, and UI-facing events.
2. Provider event mapping has provider-owned tests and no longer relies on one broad shared recursive parser for all provider semantics.
3. Provider runtime history survives app restart or explicitly reports retained history scope.
4. Claude/OpenCode bridge process lifecycle is implemented once and reused.
5. Interrupt marks native execution processes killed and terminates owned process trees.
6. Codex app-server lifecycle has explicit health, eviction, and shutdown behavior.
7. Verification commands listed in the implemented tasks pass or document unrelated pre-existing failures.

## Open Questions

1. Should ACP fallback be opt-in per request only, or configurable per provider/profile with a default of disabled?
2. Should provider raw events be persisted in a new table, or should the history API intentionally expose normalized execution logs only?
3. Should Node be treated as a packaged application dependency for Claude/OpenCode bridges, or as a user-installed dependency surfaced in runtime status?
