# Provider Runtime Contract Spec

Date: 2026-05-19

## Requirements

### User Story

As a VibeX maintainer, I want each provider runtime to expose one stable contract for its primary execution path, local dependencies, fallback policy, command visibility, and history behavior, so SDK/CLI/ACP decisions are visible, testable, and do not drift between backend code, frontend settings, and documentation.

### Acceptance Criteria

1. WHEN the frontend asks for provider runtime status THEN VibeX SHALL return a provider-scoped `ProviderRuntimeContract` together with live native/fallback probe results.
2. WHEN Claude is selected THEN the contract SHALL state that the primary runtime is the Claude Agent SDK bridge and the ACP adapter is only the provider-scoped compatibility fallback.
3. WHEN Codex is selected THEN the contract SHALL state that the primary runtime is Codex app-server through the local `codex` CLI and the ACP adapter is only the provider-scoped compatibility fallback.
4. WHEN OpenCode is selected THEN the contract SHALL state that the primary runtime is the OpenCode SDK bridge, that the SDK still requires a local OpenCode CLI/server runtime, and the ACP adapter is only the provider-scoped compatibility fallback.
5. WHEN a provider has local dependency checks THEN the contract SHALL distinguish hidden SDK package checks from user-visible CLI/runtime checks.
6. WHEN native execution fails THEN VibeX SHALL try ACP fallback only when the provider fallback contract says fallback is enabled by default or the matching fallback environment variable is enabled.
7. WHEN the user forces ACP fallback through provider options THEN VibeX SHALL skip the primary runtime and report the ACP path as the explicit runtime source.
8. WHEN provider slash commands are listed THEN VibeX SHALL hide commands whose only effect is TUI state/config display unless VibeX implements an equivalent visible UI effect.
9. WHEN provider runtime events are stored or replayed THEN native SDK/app-server events SHALL use the provider runtime event envelope, while ACP fallback SHALL remain labeled as `acp_fallback`.
10. WHEN tests validate provider runtime behavior THEN they SHALL prove the contract documents the primary runtime, fallback environment, local dependencies, and command visibility policy for all providers.

## Design

### Contract Shape

Rust owns the canonical contract and exports it to TypeScript:

- `ProviderRuntimeKind` identifies the primary execution implementation.
- `ProviderRuntimeDependency` documents local tools or packages used by that implementation.
- `ProviderRuntimeContract` documents:
  - provider id
  - primary runtime kind, source, and label
  - local dependencies
  - fallback source, default policy, provider-specific env var, and force-fallback option
  - command visibility policy
  - event history policy

The existing `provider_runtime_get_status` command returns this contract next to the live `native` and `fallback` capability statuses. The contract is static and testable; probes remain live and environment-dependent.

### Provider Decisions

Claude:

- Primary runtime: Node bridge using `@anthropic-ai/claude-agent-sdk`.
- Required local package: hidden `claude_agent_sdk` check.
- User-visible companion runtime: `claude_cli`, because account/config and Claude Code installation state are still operationally relevant.
- Fallback: provider-scoped ACP adapter, controlled by `VIBEX_CLAUDE_ACP_FALLBACK` or the global fallback env.

Codex:

- Primary runtime: `codex app-server`.
- Required local runtime: visible `codex_cli` check.
- Fallback: provider-scoped ACP adapter, controlled by `VIBEX_CODEX_ACP_FALLBACK` or the global fallback env.

OpenCode:

- Primary runtime: Node bridge using `@opencode-ai/sdk`.
- Required local package: hidden `opencode_sdk` check.
- Required local runtime: visible `opencode_cli`, because the SDK launches or connects to the OpenCode server/CLI runtime.
- Fallback: provider-scoped ACP adapter, controlled by `VIBEX_OPENCODE_ACP_FALLBACK` or the global fallback env.

### Command Visibility

Provider slash command catalogs expose only commands that can produce a visible VibeX chat/result effect. Commands such as `/mcp`, `/config`, `/model`, `/theme`, and Claude `/permissions` remain hidden until VibeX owns an equivalent visible settings or permission UI for them.

### Runtime Flow

1. Resolve and validate provider/profile/workspace.
2. Unless `force_acp_fallback` is set, start the provider contract primary runtime.
3. If the primary runtime fails, consult provider fallback config.
4. If fallback is enabled, route through ACP and emit `runtime_source: "acp_fallback"` with the native failure reason.
5. If fallback is disabled, return the primary runtime failure.

## Tasks

- [x] 1. Write Provider Runtime Contract spec.
  - _Requirements: 1-10_
- [x] 2. Add exported runtime contract types and provider contract helper.
  - _Requirements: 1-5, 10_
- [x] 3. Include the contract in provider runtime status and consume it in the settings panel.
  - _Requirements: 1, 5_
- [x] 4. Align command source/visibility and fallback status with the contract helper.
  - _Requirements: 6-9_
- [x] 5. Regenerate shared TypeScript types and run targeted tests.
  - _Requirements: 10_
