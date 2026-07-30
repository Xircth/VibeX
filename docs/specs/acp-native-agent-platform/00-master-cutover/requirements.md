# Spec: ACP-Native Agent Platform Big-Bang Cutover

## Objective

Replace VibeX's old agent execution model with a single ACP-native agent platform.
Users should experience agents as installable runtime plugins, while VibeX owns a
clear ACP client surface for sessions, prompts, events, permissions, terminals,
filesystem requests, MCP, skills, and history import.

This replacement is intentionally not incremental. After the cutover, live coding
agent execution no longer flows through `SpawnedChild`, `MsgStore`,
`ExecutionProcess`, provider runtime events, SDK bridges, or Codex app-server
native-provider code.

## Assumptions

1. ACP is the only live protocol for coding agents in the new architecture.
2. Registry shape, distribution variants, connection lifecycle, and history
   parser separation follow the contracts defined in this spec set.
4. Existing VibeX workspace, Git, file tree, preview, project rail, and settings
   shell remain product infrastructure, but no longer own coding-agent runtime
   state.
5. Old sessions may be abandoned or imported through explicit history import; the
   new runtime does not need transparent old-session compatibility.

## User Stories

1. As a user, I want every supported coding agent to appear as an installable
   plugin-like entry, so adding Gemini, Cline, Hermes, or future ACP agents does
   not require rebuilding VibeX's core runtime.
2. As a user, I want start, stop, continue, permission, terminal, MCP, and skill
   behavior to be driven by the same ACP session state, so controls do not drift
   between old execution logs and new agent events.
3. As a maintainer, I want one agent runtime crate, so provider-specific native
   code, SDK bridge code, and fallback policy do not multiply maintenance paths.
4. As a maintainer, I want old agent runtime paths deleted in the same cutover,
   so regressions cannot silently route through abandoned systems.

## Acceptance Criteria

1. WHEN VibeX starts a live coding-agent session THEN it SHALL create or attach an
   ACP connection through `crates/agents`, not through `executors` or
   `provider_runtime`.
2. WHEN a user sends a prompt THEN the frontend SHALL call a new `agent_*` API and
   the backend SHALL issue ACP `prompt` against an ACP session.
3. WHEN a user clicks stop THEN the backend SHALL issue ACP cancellation for the
   active session/prompt and update the new agent session state.
4. WHEN an agent requests permission THEN VibeX SHALL surface the ACP permission
   request and respond through the ACP connection.
5. WHEN an agent requests terminal or filesystem operations THEN the request SHALL
   be handled by the new agent runtime boundary, not by old ACP executor helpers.
6. WHEN the cutover is complete THEN code paths for provider runtime, native
   provider fallback, SDK bridges, and old ACP executor runtime SHALL be removed
   or unreachable from product builds.
7. WHEN shared TypeScript types change THEN they SHALL be generated from Rust
   source, not edited by hand.

## Commands

- Format Rust: `cargo fmt --all`
- Rust check: `pnpm run backend:check`
- Rust tests: `cargo test --workspace`
- Type generation: `pnpm run generate-types`
- Type generation check: `pnpm run generate-types:check`
- Frontend check: `pnpm run frontend:check`
- Frontend lint: `pnpm run frontend:lint`
- Frontend build: `pnpm run frontend:build`
- Full checks: `pnpm run check`
- Full lint: `pnpm run lint`

## Project Structure

- `crates/agents/`: new ACP-native agent runtime crate.
- `src-tauri/src/commands/agents/`: new Tauri command boundary over
  `crates/agents`.
- `frontend/src/features/agents/`: new frontend agent runtime API, stores, and
  event models.
- `frontend/src/components/agents/`: new agent workbench UI surfaces.
- `docs/specs/acp-native-agent-platform/`: this replacement spec set.
- Removed after cutover: provider runtime frontend/backend modules and old ACP
  executor runtime modules.

## Boundaries

- Always: treat ACP session state as the live agent source of truth.
- Always: preserve upstream license notices for copied third-party code.
- Always: make deletion of old runtime paths part of the same architectural
  change.
- Always: keep non-agent infrastructure available to the new runtime through
  explicit boundaries.
- Never: add a compatibility adapter from new ACP sessions back into
  `ExecutionProcess` or provider runtime events.
- Never: keep ACP fallback or native-provider fallback policy.
- Never: keep SDK bridge scripts as live agent paths.
- Never: silently route an unsupported agent through legacy executors.

## Success Criteria

1. Product live-agent execution works through `crates/agents` only.
2. Claude Code, Codex, OpenCode, Gemini, OpenClaw, Cline, and Hermes are modeled
   by the registry, even if some require installed external tools to run.
3. The frontend has no dependency on provider-runtime adapters for live agent
   input/output.
4. Old agent runtime modules are deleted or compile-unreachable.
5. A full verification pass proves no product command still calls the removed
   runtime.
