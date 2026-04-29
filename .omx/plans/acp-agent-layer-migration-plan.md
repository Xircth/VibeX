# ACP-Only Agent Invocation Migration Plan

## Goal

Make the VibeX/VibeUltra agent invocation layer non-backward-compatible and ACP-only for:

- Codex
- Claude Code
- OpenCode

This migration explicitly fixes the root architectural problem: the product-specific protocol split currently leaks into executor selection, session continuity, review/follow-up semantics, setup flows, profile/config UX, and log normalization. The target state is not "keep three executors and swap transport"; it is "one ACP execution boundary with provider adapters".

## Current Evidence

Observed in repo:

- `crates/executors/src/executors/mod.rs`
  - `CodingAgent` still enumerates `ClaudeCode`, `Codex`, `Opencode`.
  - `StandardCodingAgentExecutor` is the central spawn/follow-up/review/log-normalization boundary.
- `crates/executors/src/executors/acp/`
  - ACP foundation already exists: `AcpAgentHarness`, `AcpClient`, `SessionManager`, `normalize_logs`, `terminal`.
- `crates/executors/Cargo.toml`
  - Still depends on `agent-client-protocol = 0.8` plus pinned Codex app-server crates:
    - `codex-protocol`
    - `codex-app-server-protocol`
    - `codex-core`
- `crates/executors/src/executors/codex.rs`
  - Codex still runs `npx -y @openai/codex@0.98.0 app-server`.
  - The pin is compensating for upstream protocol drift (`newConversation` vs `thread/start` / `turn/start`), not solving the architectural boundary issue.
- `crates/executors/src/executors/claude.rs`
  - Claude Code still uses stream-json + control protocol.
- `crates/executors/src/executors/opencode.rs`
  - OpenCode still uses `opencode serve` HTTP SDK path.
- `src-tauri/src/commands/sessions.rs`
  - Session continuity is hardcoded by executor name:
    - `CODEX` / `OPENCODE` => `ForkSnapshot`
    - others => `ResumeInPlace`
- `src-tauri/src/commands/workspaces.rs`
  - Agent setup helper is hardcoded to `CodingAgent::Codex`.
- `crates/executors/default_profiles.json`, `crates/executors/src/profile.rs`, `src-tauri/src/commands/config.rs`, `src-tauri/src/commands/agent_settings.rs`, `src-tauri/src/commands/sessions.rs`, `src-tauri/src/commands/workspaces.rs`
  - Executor/profile identity is deeply wired through settings, persistence, session creation, and workspace actions.
- Frontend
  - Selector and presentation layers depend on executor/profile identity and agent-specific UX assumptions:
    - `frontend/src/components/dialogs/global/OnboardingDialog.tsx`
    - `frontend/src/components/agents/AgentIcon.tsx`
    - `frontend/src/components/kanban/...`

## Decision

Adopt ACP as the single invocation protocol and delete the direct app-server/private-protocol/HTTP-SDK transport implementations from the runtime path.

### Why ACP is the right target

`ACP > app-server/private protocol/SDK` for this repo because:

1. ACP matches the existing abstraction direction.
   - The repo already has a reusable ACP harness, session manager, approval plumbing, terminal registry, and log normalization entrypoint.
2. ACP removes protocol-drift ownership from VibeUltra.
   - Codex app-server version pinning is currently a symptom patch for upstream breaking changes.
   - ACP lets this repo target a stable interop contract instead of product-specific message schemas.
3. ACP gives one place to model approvals, terminal, tool calls, slash commands, session lifecycle, and follow-up semantics.
4. ACP aligns better with multi-provider support.
   - Codex, Claude Code, and OpenCode can all be reduced to provider descriptors + adapter-specific launch config instead of bespoke protocol stacks.

### Why not keep app-server / private protocols as fallback

- It preserves the exact root cause we are trying to remove: provider-specific transport logic leaking upward.
- It forces every higher layer to remain aware of executor-specific quirks.
- It keeps dependency drag (`codex-*` crates, custom Claude control protocol, OpenCode HTTP SDK code) alive indefinitely.

## Target Architecture

### Runtime shape

Replace the specialized runtime implementations with:

1. `AcpProviderId`
   - `Codex`
   - `ClaudeCode`
   - `OpenCode`

2. `AcpProviderDescriptor`
   - launch command / transport
   - install/preflight strategy
   - setup-helper capability
   - session continuity mode
   - review support
   - model/mode/permission mapping rules
   - native config paths
   - slash-command discovery policy
   - availability detection policy

3. `AcpBackedExecutor`
   - the only concrete `StandardCodingAgentExecutor` implementation used by these three agents
   - delegates to `AcpAgentHarness` + descriptor

4. Capability-driven behavior above the transport
   - stop branching on `CODEX` / `OPENCODE` / `CLAUDE_CODE` in Tauri/service layers where the behavior is really:
     - snapshot-fork vs resume-in-place
     - has setup helper vs not
     - supports review continuation vs not
     - supports slash-command discovery vs static-only

### Boundary rule

Higher layers may know which agent the user selected, but they must not know the transport/protocol specifics.

Allowed:

- display name / icon
- availability / installation / native config UX
- profile defaults

Not allowed after migration:

- branching on provider protocol semantics in `sessions.rs`, `workspaces.rs`, `container.rs`, or frontend session UX

## Scope

### In scope

- Remove direct Codex app-server invocation path.
- Remove direct Claude private control/stream-json invocation path.
- Remove direct OpenCode HTTP SDK invocation path.
- Move all three agents onto ACP-backed descriptors/harness.
- Refactor session/review/setup/profile behavior to capability-driven semantics.
- Rework config/default profile plumbing to describe ACP-backed providers cleanly.
- Update frontend/profile/settings UX to reflect ACP-backed agent definitions.
- Delete no-longer-needed pinned Codex protocol dependencies if ACP path fully replaces them.

### Out of scope

- Backward compatibility for saved runtime behavior.
- Supporting mixed ACP + legacy transports.
- Adding new providers beyond Codex / Claude Code / OpenCode.

## Phases

### Phase 1: Freeze the migration contract

Deliverables:

1. Define the ACP-only provider model in `crates/executors`.
2. Explicitly document provider capabilities and continuity semantics.
3. Identify all name-based branching that must be converted to capability-based branching.

Code landing zones:

- `crates/executors/src/executors/mod.rs`
- `crates/executors/src/executors/acp/`
- `crates/executors/src/profile.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/commands/workspaces.rs`
- `crates/services/src/services/container.rs`

Acceptance criteria:

- There is one written capability matrix for Codex / Claude Code / OpenCode covering:
  - follow-up mode
  - review mode
  - approvals
  - setup helper
  - terminal support
  - slash commands
  - native config paths
- Every current executor-name branch in upper layers is mapped to a capability replacement.

### Phase 2: Introduce ACP-backed descriptors and shared executor

Deliverables:

1. Create a shared ACP-backed executor implementation.
2. Define one provider descriptor per agent.
3. Move launch/config/session/review hooks behind descriptor methods.

Code landing zones:

- `crates/executors/src/executors/acp/`
- `crates/executors/src/executors/mod.rs`
- new ACP provider modules under `crates/executors/src/executors/acp/` or adjacent descriptor modules

Required refactor direction:

- `StandardCodingAgentExecutor` remains the boundary unless a narrower ACP-specific boundary clearly reduces duplication.
- Codex/Claude/OpenCode should become thin data declarations or disappear entirely from runtime execution code.
- `AcpAgentHarness` must become the default spawn/follow-up path for all three providers.

Acceptance criteria:

- No runtime spawn path for these three providers bypasses ACP.
- Launch configuration for each provider is expressed as data/descriptor logic, not bespoke executor protocol code.

### Phase 3: Remove protocol-specific implementations and dependencies

Deliverables:

1. Delete the direct Codex app-server protocol path.
2. Delete the direct Claude private protocol path.
3. Delete the direct OpenCode HTTP SDK path.
4. Remove obsolete dependencies if they are no longer referenced.

Primary code landing zones:

- `crates/executors/src/executors/codex.rs`
- `crates/executors/src/executors/claude.rs`
- `crates/executors/src/executors/opencode.rs`
- `crates/executors/Cargo.toml`

Dependency review target:

- remove `codex-protocol`
- remove `codex-app-server-protocol`
- remove `codex-core`
- review whether any Claude/OpenCode-specific protocol modules become dead code and should also be removed

Acceptance criteria:

- No production code path imports product-specific protocol crates for Codex.
- No production code path depends on Claude stream-json/control protocol implementation.
- No production code path depends on OpenCode HTTP SDK session transport.

### Phase 4: Rework profiles, config, and persisted agent identity

Deliverables:

1. Recast default profiles around ACP-backed provider descriptors.
2. Remove settings that only made sense for legacy transports.
3. Preserve user-facing agent choice while simplifying transport-specific knobs.

Code landing zones:

- `crates/executors/default_profiles.json`
- `crates/executors/src/profile.rs`
- `src-tauri/src/commands/config.rs`
- `src-tauri/src/commands/agent_settings.rs`
- config version migrations under `crates/services/src/services/config/versions/`

Refactor guidance:

- Keep `BaseCodingAgent` only if it remains a clean user-facing provider ID.
- Remove variant/defaults that encode legacy transport behavior rather than durable user intent.
- Revisit `agent_settings` install/fix logic so it targets ACP adapters / provider launchers instead of the legacy CLI contract where needed.

Acceptance criteria:

- Profiles no longer encode legacy transport assumptions.
- Config migrations exist for any persisted shape changes.
- Agent preflight/install/fix flows point to the ACP-backed launch path.

### Phase 5: Rework session, review, and setup semantics around capabilities

Deliverables:

1. Replace executor-name continuity logic with capability-driven logic.
2. Replace Codex-only setup helper branching with capability-driven setup.
3. Ensure review/follow-up handling uses ACP semantics consistently.

Code landing zones:

- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/commands/workspaces.rs`
- `crates/services/src/services/container.rs`
- `crates/executors/src/actions/`

Key required changes:

- Replace `derive_session_continuity_mode(executor: Option<&str>, ...)` with logic derived from provider capabilities or persisted continuity metadata.
- Replace `CodingAgent::Codex` setup helper branch with `supports_setup_helper` capability.
- Ensure queued follow-up, retry/reset, and review resume use one ACP-native model instead of executor-specific comments/assumptions.

Acceptance criteria:

- No upper-layer behavioral branch depends on `"CODEX"` / `"OPENCODE"` / `"CLAUDE_CODE"` where a capability should decide.
- Retry/reset/follow-up semantics are defined once and applied consistently.

### Phase 6: Frontend and generated type alignment

Deliverables:

1. Update settings/profile selector UI for ACP-backed provider model.
2. Remove legacy wording that implies protocol-specific behavior.
3. Regenerate shared types if type surfaces changed.

Code landing zones:

- `frontend/src/components/dialogs/global/OnboardingDialog.tsx`
- `frontend/src/components/agents/AgentIcon.tsx`
- `frontend/src/components/kanban/...`
- `shared/types.ts` via generator
- `src-tauri/src/bin/generate_types.rs`

Acceptance criteria:

- The frontend can create sessions, select profiles, inspect availability, and display continuity/setup/review affordances using the new model.
- No UI flow depends on removed legacy transport settings.

### Phase 7: Verification and cleanup

Deliverables:

1. Remove dead code, dead tests, and obsolete comments.
2. Run full verification on backend + frontend + migration paths.
3. Validate install/preflight flows for all three providers.

Acceptance criteria:

- All compile/test/typecheck gates pass.
- There is no remaining dead import/module tied to removed protocols.
- A fresh install path can launch each ACP-backed provider through the intended entrypoint.

## Testing Strategy

### Unit tests

Add or update tests for:

- provider descriptor mapping
- capability matrix resolution
- session continuity derivation
- profile resolution and override application
- native config path resolution
- preflight/install command resolution

Likely files:

- `crates/executors/src/profile.rs`
- new ACP provider descriptor modules
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/commands/agent_settings.rs`

### Integration tests

Focus on the seams that are most likely to regress:

1. Initial session -> follow-up -> retry/reset -> follow-up
2. Review on an existing session
3. Queued message replay
4. Setup helper dispatch
5. Slash command discovery availability

Suggested integration approach:

- use ACP fixture processes / mock ACP servers where possible
- avoid provider real-network dependence in CI
- keep one adapter-contract test per provider that validates launch + session + prompt + done events

### Manual verification

Must manually validate on desktop app:

1. Create session with Codex ACP adapter
2. Create session with Claude ACP adapter
3. Create session with OpenCode ACP adapter
4. Follow-up and retry/reset semantics for each
5. Review flow for each
6. Agent setup / availability UI
7. Onboarding profile selection
8. Workspace and kanban session hub flows

### Required repo commands before merge

- `pnpm run check`
- `pnpm run lint`
- `pnpm run backend:check`
- `cargo test --workspace`
- `pnpm run generate-types:check`

If new tests are added under frontend:

- run the relevant frontend/Vitest targets too

## Risks

### High risk

1. Session continuity regression
   - Current behavior is executor-specific.
   - If ACP descriptors do not model snapshot-fork vs resume-in-place correctly, retry/reset and queued follow-up will break.

2. Approval/permission behavior drift
   - Claude, Codex, and OpenCode currently express approvals differently.
   - ACP unifies the transport, but not automatically the intended policy semantics.

3. Setup-helper regression
   - `workspaces.rs` currently assumes only Codex supports setup helper.
   - A naive removal will silently break setup UX.

4. Log normalization regressions
   - Current normalizers are provider/protocol-specific.
   - If ACP event normalization loses detail, the timeline/UI can regress even if execution still works.

### Medium risk

1. Profile migration churn
   - Existing variants may no longer map cleanly to ACP-backed semantics.
2. Agent preflight/install UX drift
   - `agent_settings.rs` currently assumes direct CLI install/version detection patterns.
3. Frontend type drift
   - shared type generation and UI assumptions may lag the backend contract.

### Low risk

1. Icon/display-name adjustments
2. Default profile ordering changes

## Rollback Points

Because this is intentionally non-backward-compatible, rollback should be phase-bounded in git, not runtime-config-based.

Recommended rollback points:

1. After Phase 1
   - safe checkpoint before runtime changes
2. After Phase 2
   - ACP shared executor introduced, but legacy implementations may still exist
3. After Phase 3
   - hard cutover point; if this fails, revert the full Phase 3 commit range rather than adding fallback branches
4. After Phase 5
   - semantics migrated; if regressions remain, revert to the pre-capability branch rather than patching special cases

Rollback rule:

- Do not reintroduce app-server/private-protocol fallback branches as an emergency fix.
- If ACP cutover fails, revert the migration slice and correct the descriptor/capability model, then re-land.

## Recommended Execution Order

1. Land the capability model and descriptor contract first.
2. Move all three providers to ACP-backed execution while legacy code still exists.
3. Convert upper-layer semantics to capabilities.
4. Delete legacy protocol code and dependencies.
5. Migrate profiles/settings/UI.
6. Run full verification and dead-code cleanup.

## Concrete File Watchlist

Highest-probability edit set:

- `crates/executors/src/executors/mod.rs`
- `crates/executors/src/executors/acp/mod.rs`
- `crates/executors/src/executors/acp/harness.rs`
- `crates/executors/src/executors/acp/client.rs`
- `crates/executors/src/executors/acp/session.rs`
- `crates/executors/src/executors/acp/normalize_logs.rs`
- `crates/executors/src/executors/codex.rs`
- `crates/executors/src/executors/claude.rs`
- `crates/executors/src/executors/opencode.rs`
- `crates/executors/src/profile.rs`
- `crates/executors/default_profiles.json`
- `crates/executors/Cargo.toml`
- `crates/services/src/services/container.rs`
- `src-tauri/src/commands/config.rs`
- `src-tauri/src/commands/agent_settings.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/commands/workspaces.rs`
- `src-tauri/src/bin/generate_types.rs`
- `frontend/src/components/dialogs/global/OnboardingDialog.tsx`
- `frontend/src/components/agents/AgentIcon.tsx`
- `frontend/src/components/kanban/`

## Definition of Done

- Codex, Claude Code, and OpenCode all launch exclusively through ACP-backed runtime code.
- No direct app-server/private-protocol/HTTP-SDK execution path remains in production use.
- Session continuity, setup helper, review, approvals, and slash commands are capability-driven rather than executor-name-driven.
- Codex pinned app-server dependencies are removed if no longer required.
- Backend checks, frontend checks, shared type generation checks, and workspace/session flows pass.
- No "temporary version pin" remains as the fix for protocol drift.
