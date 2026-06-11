# Spec: Legacy Runtime Removal And Verification

## Objective

Delete or detach every old live-agent runtime path in the same cutover that
introduces the ACP-native platform. This spec prevents accidental compatibility
layers from surviving.

## Removal Targets

- `src-tauri/src/commands/provider_runtime/**`
- provider runtime command registrations and generated exports.
- `frontend/src/features/provider-runtime/**`
- `frontend/src/components/settings/ProviderRuntimePanel.tsx`
- `scripts/claude-agent-sdk-provider.mjs`
- `scripts/opencode-sdk-provider.mjs`
- `crates/executors/src/executors/acp/**` live runtime modules.
- old Claude/Codex/OpenCode executor code paths that only exist to launch ACP
  agents through `StandardCodingAgentExecutor`.
- provider runtime DTOs in `shared/types.ts`.
- ACP fallback environment variables and UI copy.

## Acceptance Criteria

1. WHEN the replacement is complete THEN `rg "provider_runtime|ProviderRuntime"`
   SHALL find no live product code.
2. WHEN the replacement is complete THEN `rg "AcpBackedExecutor|AcpAgentHarness"`
   SHALL find no live product runtime code.
3. WHEN the replacement is complete THEN SDK bridge scripts SHALL not exist.
4. WHEN the replacement is complete THEN frontend live-agent code SHALL import
   only `features/agents` APIs.
5. WHEN verification runs THEN backend, frontend, generated types, and full check
   commands SHALL pass or document unrelated failures.

## Boundaries

- Always: delete dead code instead of leaving no-op wrappers.
- Always: remove tests that only assert old architecture behavior.
- Always: replace behavior tests with new ACP-native equivalents.
- Never: keep old modules behind feature flags for later cleanup.
- Never: keep compatibility aliases for command names.
- Never: preserve native-provider docs as current architecture docs.

## Testing Strategy

- Static search gates for removed identifiers.
- Compile gates for Rust and TypeScript.
- Unit tests for new runtime and frontend stores.
- Manual smoke tests with at least one installed ACP agent.

