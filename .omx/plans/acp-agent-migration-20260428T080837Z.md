# ACP Agent Invocation Migration Plan

Timestamp: 2026-04-28T08:08:37Z

## Decision

Use ACP as the only production invocation protocol for Codex, Claude Code, and
OpenCode.

This is intentionally non-backward-compatible. The migration should remove the
old Codex app-server SDK path, Claude Code private stream-json/control path, and
OpenCode HTTP SDK path from production execution rather than preserving them as
fallbacks.

## Why ACP Instead Of SDK/App-Server Per Agent

ACP is the better maintenance boundary for this project because the current
failure is architectural, not just a stale dependency:

- Codex broke because VibeX owns an old app-server schema (`newConversation`)
  while the newer CLI speaks `thread/start` and `turn/start`.
- Claude Code and OpenCode are also implemented as separate transport stacks,
  so each provider leaks protocol-specific behavior into session, review,
  approval, setup, and rendering code.
- The repo already has a reusable ACP foundation under
  `crates/executors/src/executors/acp/`.
- External adapters exist for the target agents:
  - `agentclientprotocol/claude-agent-acp`
  - `zed-industries/codex-acp`, listed by the ACP registry
  - OpenCode's `opencode acp`

Rejected approach: keep SDK/app-server/private-protocol integrations and add
version branches. That preserves the root cause and guarantees future drift.

## Target Architecture

### Core Types

Introduce or promote these concepts in `crates/executors`:

- `AcpProviderId`: stable user-facing provider identity (`Codex`,
  `ClaudeCode`, `OpenCode`).
- `AcpProviderDescriptor`: provider data and behavior contract.
- `AcpProviderCapabilities`: explicit capability matrix.
- `AcpBackedExecutor`: the single concrete executor for all ACP-backed agents.

`AcpBackedExecutor` should satisfy the existing `StandardCodingAgentExecutor`
boundary unless a narrower refactor is proven necessary. The user-facing agent
identity can remain `BaseCodingAgent`, but transport behavior must stop being
encoded by `CodingAgent::Codex`, `CodingAgent::ClaudeCode`, or
`CodingAgent::Opencode` branches.

### Provider Descriptor Fields

Each provider descriptor should define:

- launch command and args
- model/mode/permission mapping
- installation and version detection strategy
- native config path
- ACP adapter capability probes
- session continuity mode
- review support
- slash command discovery policy
- setup helper support
- MCP config strategy
- terminal/tool/file-edit support expectations

Important: do not assume all ACP adapters have identical capabilities. The app
must detect or declare capability gaps explicitly and present unsupported
features as unsupported, not silently emulate them with legacy transports.

## Implementation Phases

### Phase 0: Repository Hygiene Gate

Do this before implementation commits:

- Keep `code-reference/` and `code-referance/` ignored.
- Do not mix ACP migration with unrelated tracked deletions under reference or
  backup directories.
- If reference directories are still tracked, remove them from tracking in a
  separate explicit commit or restore them before the ACP branch.

Acceptance:

- `git status` for the ACP branch only contains ACP-related changes.

### Phase 1: Capability Contract And Inventory

Add a provider capability matrix before changing runtime behavior.

Code areas:

- `crates/executors/src/executors/mod.rs`
- `crates/executors/src/executors/acp/`
- `crates/executors/src/profile.rs`
- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/commands/workspaces.rs`
- `crates/services/src/services/container.rs`

Inventory and replace these name-based decisions:

- session continuity (`ForkSnapshot` vs `ResumeInPlace`)
- setup helper support
- review continuation support
- approval policy mapping
- model and reasoning override mapping
- slash command discovery
- MCP config format/path

Acceptance:

- Every current `CODEX` / `OPENCODE` / `CLAUDE_CODE` behavior branch has a
  capability replacement or an explicit remaining display-only reason.

### Phase 2: ACP Conformance Harness

Before deleting legacy code, add tests around the ACP boundary.

Deliverables:

- fake ACP server fixture for deterministic tests
- provider descriptor unit tests
- launch-command construction tests
- event normalization golden tests
- permission request/response tests
- terminal lifecycle tests
- session start/prompt/done tests

Acceptance:

- A fake provider can run initial prompt, follow-up, denial feedback, terminal
  events, file edit events, and completion through `AcpBackedExecutor`.

### Phase 3: Shared ACP Executor Cutover

Create `AcpBackedExecutor` and make Codex, Claude Code, and OpenCode runtime
spawn through ACP descriptors.

Expected launch defaults:

- Codex: `codex-acp` adapter, preferably registry-resolved or configured
  command, with a safe built-in default such as `npx -y @zed-industries/codex-acp`.
- Claude Code: `claude-agent-acp` adapter command.
- OpenCode: `opencode acp`.

Do not hardcode a single package version as the protocol fix unless packaging
requires a temporary install default. Version checks should report the adapter
version separately from the underlying agent CLI version.

Acceptance:

- Initial prompt and follow-up use ACP for all three providers.
- No production spawn path for these providers bypasses ACP.
- Legacy files may still exist temporarily, but they are not selected by
  profile/config/runtime.

### Phase 4: Session, Review, Setup, And Approval Semantics

Move upper layers to capabilities.

Code areas:

- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/commands/workspaces.rs`
- `crates/services/src/services/container.rs`
- `crates/executors/src/actions/`
- `crates/executors/src/approvals*`

Rules:

- Session IDs must distinguish UI session IDs from ACP adapter session IDs.
- Follow-up/retry/reset must be defined once and backed by provider
  capabilities, not executor names.
- Review must use ACP when supported; unsupported review must fail clearly in
  Chinese UI text rather than falling back to old Codex review APIs.
- Permission policies must map through ACP permission options, with provider
  gaps surfaced during preflight.

Acceptance:

- queued follow-up, retry/reset, review, cancellation, and approvals work
  through capability-driven code.

### Phase 5: Profiles, Settings, Version Checks, And Install/Update

Update profile/config surfaces around ACP providers.

Code areas:

- `crates/executors/default_profiles.json`
- `crates/executors/src/profile.rs`
- `src-tauri/src/commands/config.rs`
- `src-tauri/src/commands/agent_settings.rs`
- `src-tauri/src/commands/config/agent_native.rs`
- config migrations under `crates/services/src/services/config/versions/`

Required changes:

- Remove profile fields that only apply to removed transports.
- Keep durable user intent fields: provider, model, reasoning, permission
  policy, mode/agent where supported.
- Detect and update ACP adapters and underlying CLIs separately.
- Explain Codex version mismatch as:
  - local terminal may call the globally installed latest Codex
  - current app may launch a pinned or bundled command
  - ACP migration will make the launched adapter/CLI explicit and checkable

Acceptance:

- settings can check/update Claude ACP adapter, Codex ACP adapter, OpenCode ACP
  mode, and the underlying provider CLI where applicable.
- no settings page points users at removed legacy transport assumptions.

### Phase 6: Delete Legacy Runtime Code And Dependencies

After ACP paths pass tests, delete old production transports.

Remove or quarantine:

- `crates/executors/src/executors/codex.rs` app-server runtime
- `crates/executors/src/executors/codex/*` app-server client/protocol code
- Claude Code private stream-json/control runtime modules
- OpenCode HTTP SDK runtime modules
- stale normalizers that are no longer used

Dependency cleanup:

- remove `codex-protocol`
- remove `codex-app-server-protocol`
- remove `codex-core`
- remove unused provider-specific HTTP/protocol dependencies

Acceptance:

- `cargo check` has no unused modules/imports from removed transports.
- production execution cannot accidentally select a removed legacy path.

### Phase 7: Frontend And Shared Types

Update UI around the new provider model.

Code areas:

- `frontend/src/components/dialogs/global/OnboardingDialog.tsx`
- `frontend/src/components/agents/AgentIcon.tsx`
- `frontend/src/components/kanban/`
- settings Agent page components
- `src-tauri/src/bin/generate_types.rs`
- `shared/types.ts` via generator only

Acceptance:

- agent selector still shows Codex, Claude Code, and OpenCode.
- settings display ACP adapter status and provider CLI status clearly.
- unsupported ACP capabilities are disabled or explained, not hidden until
  runtime failure.

### Phase 8: Full Verification

Required automated checks:

- `pnpm run check`
- `pnpm run lint`
- `pnpm run backend:check`
- `cargo test --workspace`
- `pnpm run generate-types:check`

Manual desktop smoke tests:

- create session with Codex ACP
- create session with Claude ACP
- create session with OpenCode ACP
- follow-up on each provider
- retry/reset on each provider
- review flow on providers that declare review support
- approval denial with feedback
- file edit rendering
- `files changed` summary after turn completion
- terminal output rendering
- settings version/update/preflight checks

## Highest-Risk Points

- Session continuity: existing behavior differs by executor and may not map
  directly to every ACP adapter.
- ACP adapter capability gaps: review, slash commands, edit review, TODO, and
  terminal support must be probed or declared.
- Log normalization: losing tool/file-edit metadata would regress UI even if
  the agent runs successfully.
- Settings/update semantics: adapter version and underlying CLI version are not
  the same thing.
- Stored sessions: old session IDs may not resume under ACP. Since no backward
  compatibility is required, the migration should mark pre-ACP sessions as
  legacy/unresumable with a clear message rather than attempting silent resume.

## Minimal Safe Slice

The first implementation slice should not touch all providers at once.

Recommended slice:

1. Build `AcpProviderDescriptor` and fake ACP conformance tests.
2. Move one provider, preferably OpenCode via `opencode acp`, to
   `AcpBackedExecutor`.
3. Prove initial prompt, follow-up, approval, terminal, file edit, and files
   changed summary.
4. Move Codex and Claude after the shared path is verified.
5. Delete legacy transports only after all three providers pass the same
   conformance suite.

This prevents a big-bang rewrite while still honoring the no-backward-
compatibility requirement: old transports can remain in the branch temporarily
as non-selected code until the hard-delete phase, but they must not be exposed
as fallback behavior.

## Definition Of Done

- Codex, Claude Code, and OpenCode all execute exclusively through ACP.
- No production path uses old Codex app-server, Claude private protocol, or
  OpenCode HTTP SDK transport.
- Session/review/setup/approval behavior is capability-driven.
- Old Codex pinned protocol dependencies are removed.
- Settings can check and update the ACP adapters and relevant underlying CLIs.
- Old sessions that cannot resume are clearly labeled instead of failing with
  transport errors.
- Full automated checks pass.
