# Spec: Open ACP Registry Agent Management

## Objective

Replace the closed, hard-coded seven-Agent management model with an open,
local-first ACP Registry platform. A user can add any compatible Agent from the
official ACP Registry, install its local Runtime and ACP process under a
repeatable installation lock, and manage it through the same settings and
session pipeline as a built-in Agent.

Claude Code, Codex, Gemini, OpenClaw, OpenCode, Cline, Hermes, CodeBuddy,
Kimi Code, Pi, Grok and Cursor are Built-in Agents only in presentation and
default-membership policy: they are visible by default, pinned in the
Registry's installed/uninstalled lists, cannot be removed, and proactively
inspect official local Runtime candidates. They do not receive a different
installation or session state machine. Profile-declared configuration,
dependency checks and account actions are capability-driven sections of the
shared settings page.

This specification is the implementation authority for Agent management. It
applies ADR-0010 through ADR-0029 and replaces the closed Agent-setting and
hard-coded settings contracts described in the earlier registry/install phase.

## First-principles product contract

1. **Identity is not a Rust enum.** An Agent is identified by an open, stable
   `AgentId`. Built-in Profile bindings and Registry entries can refer to the
   same `AgentId`; display names and Registry ids are metadata, not identity.
2. **Membership is not installation.** Added, enabled, installed, ready,
   needs-auth, needs-repair, installing, unsupported, and retired are distinct
   facts. A failed or interrupted install never removes a previously added
   Agent.
3. **Running is local and locked.** Every live ACP process is a local `stdio`
   command derived from an Installation lock. Generic Registry Agents cannot
   fall back to PATH discovery, arbitrary commands, remote endpoints, or a
   temporary package execution.
4. **Built-in is declarative, not bespoke.** Built-in Profiles supply only
   extra data unavailable in the Registry: Runtime topology, verified hashes,
   official path candidates, dependencies, recognized configuration-file
   fields, and fixed official account/subscription actions.
5. **The Agent owns persistent configuration.** VibeX edits only profile-known
   Agent-native configuration files. After an explicit user action, it may
   launch Profile-whitelisted official browser/CLI login, device-code or logout
   flows; it never accepts arbitrary commands or sends ACP persistent-
   configuration writes. API Key values are
   local plaintext in the native file, masked in the UI and redacted from logs.
   The configuration surface offers a version-checked, format-validating raw
   editor for non-sensitive Profile-known files. Credential-bearing files never
   cross IPC and remain editable only through masked structured fields. Field
   edits and removals share the page-level bottom save action.
6. **The Registry is discovery, not runtime authority.** A cached official
   snapshot supports browsing while offline; adding or updating a generic Agent
   requires a successful current refresh. Existing locks and sessions work
   independently of Registry availability.

## User-visible requirements

### Agent bar and detail view

- Settings → Agent has one flat, user-orderable horizontal Agent bar. It starts
  as Claude Code → Codex → Gemini → OpenClaw → OpenCode → Cline → Hermes →
  CodeBuddy → Kimi Code → Pi → Grok → Cursor, accepts added generic Agents before a
  permanently visible `+`, and lets built-in and generic Agents intermix.
- The bar scrolls only Agent icons; `+` is sticky at the right edge. Focused
  items are scrolled into view. While the icons fit, their available horizontal
  space is distributed between the first and last icon instead of accumulating
  at the left. A health badge and a separate disabled overlay communicate actual
  state without using the selection state as a status.
- Selecting an Agent opens one state-driven detail page: summary and enable
  control; preflight; Runtime/installation; authentication/account status;
  configuration; diagnostics/advanced actions. Optional capability sections are
  absent, not failed.
- Manual update and uninstall controls sit directly to the right of the enable
  control in the Agent summary header. They are not repeated inside preflight.
- Preflight expands automatically while an Agent is non-ready or operating and
  otherwise collapses to a summary. Check is read-only; repair is explicit.
- A user-initiated operation reports success or failure by Toast. Failure Toasts
  remain until dismissed and can focus the failing preflight item. Full output
  is only in Diagnostics, where the last 20 operation records are retained and
  can be cleared.

### Registry view

- Clicking `+` swaps the content area in-place to the Registry; it is not a
  modal. The Agent bar remains visible. Escape/back/choosing an Agent restores
  its detail view.
- `已安装` and `未安装` have independent ordering. Built-ins are first in each
  applicable tab; all other rows sort alphabetically. Together the tabs show
  every current Registry entry, with compact row metadata and installation
  status, inline disclosure, a single-surface search control, refresh state and
  snapshot time.
- Add-and-install immediately creates membership, selects the new icon, then
  begins noninteractive installation. It pauses at missing authentication or
  user-entered configuration. The current row version becomes the install target
  even if refresh subsequently completes.
- Registry refresh renders the cached snapshot first. A snapshot is fresh for
  24 hours; later opens refresh in the background. A full schema-valid response
  atomically replaces the cache and incrementally updates the view without
  losing search, disclosure, scroll anchor, or selection. Failure retains the
  last valid snapshot and disables generic add/update.

### Runtime, configuration, and lifecycle

- Generic Agents use only Registry-declared Binary/npx/uvx distributions.
  Binary is preferred, then a verified Node or Python environment, then npx
  before uvx. The selected distribution, resolved version, platform, source and
  fingerprints are locked; repair may change distribution only after explicit
  user confirmation.
- Managed Runtime components are installed in VibeX-owned versioned locations.
  Built-in Runtime may automatically attach a verified external installation;
  VibeX never modifies or removes external components. Built-in Profiles and
  VibeX-managed base Runtime require expected SHA-256; Registry Binary uses
  visible TOFU fingerprinting.
- Installation attempts are bounded to two globally, serialize changes to the
  same Agent, and lock shared Node/Python/uv/cache resources. Failed, cancelled,
  or interrupted attempts preserve membership and require an explicit retry.
- Update is manual, preflights side-by-side, atomically changes the current
  lock, and preserves the previous verified version for rollback. New work uses
  the current lock; live processes finish on their existing lock.
- Uninstall/remove is unavailable while the Agent has an active ACP process,
  in-flight turn, or installation attempt, with the exact explanation “此 Agent
  还有正在执行的进程，暂时无法卸载／移除”. No operation implicitly kills a process.
- Account status reports account, API Key, or not logged in. Built-in Profiles
  may expose explicit login, logout and subscription actions. Presence of a
  profile-known API Key displays “已通过 API Key 登录”; the user is responsible
  for its validity. If account and key coexist, Profile-defined official
  precedence determines status; an unknown precedence blocks new sessions.
- Codex device authorization can complete inside the settings page. OAuth tokens
  never cross IPC and are written only to the official Codex credential file.
  OpenCode Provider selection uses the full cached `models.dev` catalog, writes
  SDK/API adapter/endpoint/model configuration, controls enabled/disabled lists,
  and its plugin section reconciles declared plugins with the OpenCode package cache.
- Claude Code, Codex, Gemini, Grok and Cursor expose explicit authentication
  modes matching their official subscription/OAuth, API-key, Vertex, custom
  endpoint and Model Provider choices. Preflight reports the selected mode and
  missing dependencies or credentials; launch scrubs conflicting inherited
  credential variables before the child process starts.
- Only Built-in Profiles with known file schemas expose persistent configuration
  fields. VibeX reads latest state, writes user-submitted known fields
  atomically, preserves unknown data, detects same-field external conflicts,
  and applies saved values only to future/newly rebound sessions.
- Non-sensitive raw-file saves are restricted to the exact resolved Profile
  path, capped at 1 MiB, parsed as the declared JSON/TOML/YAML/dotenv format,
  guarded by an exact file revision and committed atomically. Sensitive mixed
  configuration/authentication files cannot be read or written through this API.
- Profile fields include the complete Codeg structured surfaces that map to
  stable native schemas: Claude advanced model/traffic flags; Codex transport,
  Skills and workspace-write details; Kimi reasoning/provider environment;
  Pi custom providers; Grok documented UI/model/session keys; and the full
  Hermes provider registry. Provider-specific Hermes credentials are disclosed
  only for the selected provider. Cursor, Grok and OpenClaw launch-only choices
  are translated to their required CLI argument positions at session startup.

### Migration and session eligibility

- The migration idempotently promotes/adds the complete twelve-Agent Built-in
  catalog while preserving existing enabled state and relative order.
- Existing sessions for all migrated Agent identities retain their history.
  Runtime, credentials and config files are not deleted by membership migration.
- Every built-in declares a read-only official history source. SQLite and
  agent-specific event-stream formats use dedicated adapters instead of being
  silently treated as generic JSON files.
- An Agent may be disabled while remaining fully manageable. Disabled Agents
  cannot start a new session or submit a new turn, while an in-flight turn
  finishes naturally. Ready and enabled are both required at the session gate.
- Conversation records store the stable AgentId and the Runtime/ACP versions
  used by each turn. Session rebind remains explicit, never replays history,
  and preserves the event-history boundary.

## Commands

- Focused Rust: `cargo test -p agents <name>` and `cargo test -p db <name>`
- Focused frontend: `pnpm --dir frontend exec vitest run <test-file>`
- Type generation: `pnpm run generate-types && pnpm run generate-types:check`
- DB metadata: `pnpm run prepare-db && pnpm run prepare-db:check`
- Full validation: `pnpm run check && pnpm run lint && cargo test --workspace`

## Project structure

- `crates/api-types/` — open AgentId and management DTOs exported to TypeScript.
- `crates/agents/` — Profile catalog, Registry parser/cache client, install
  planner/orchestrator, probe, native config providers, and runtime resolver.
- `crates/db/` — normalized membership, lock, snapshot, diagnostic and
  preference repositories plus the evidence-based migration.
- `src-tauri/src/commands/` — thin Agent-management commands and event bridge.
- `frontend/src/features/agent-management/` — IPC client, query keys, view
  model and operation state.
- `frontend/src/pages/settings/` and `frontend/src/components/agents/` — Agent
  bar, Registry, detail sections and accessible interaction components.

## Code style

- Rust uses explicit state/value types, `Result` errors and `snake_case` API
  fields. It does not serialize management policy as ad-hoc JSON strings.

```rust
pub fn can_start_session(snapshot: &AgentManagementSnapshot) -> Result<(), AgentGateError> {
    if !snapshot.enabled {
        return Err(AgentGateError::Disabled);
    }
    snapshot.readiness.require_session_ready()
}
```

- TypeScript uses generated DTOs and discriminated status unions; UI components
  render server snapshots rather than reimplementing installation policy.
- Formatting remains `cargo fmt` and Prettier; generated `shared/types.ts` is
  never manually edited.

## TDD seams

Tests are written at these public boundaries, in this order:

1. **Domain seam** — pure Rust `AgentId`, Profile binding, Registry validation,
   state reduction, distribution choice and install-lock validation.
2. **Repository seam** — public DB repositories against a migrated SQLite test
   database, including legacy evidence migration.
3. **Service seam** — `AgentManagementService` with fakes only for HTTP,
   filesystem/process runner, clock and ACP handshake; its observable commands
   return snapshots and diagnostic records.
4. **Runtime seam** — `crates/agents` integration tests launch a fixture ACP
   stdio process and assert locked absolute command resolution, initialize and
   session gating.
5. **IPC seam** — Tauri command tests invoke public commands with a test App
   state and assert serialized DTOs/events; no frontend-only recreation of
   policy.
6. **UI seam** — Vitest/Testing Library tests use mock IPC and real React
   components to assert bar/Registry/detail behavior and accessible controls.
7. **Release seam** — generated-type, static-removal, full check/lint/test, and
   manual real-agent smoke gates.

Mocks are permitted only at HTTP, clock, filesystem/process and ACP-process
boundaries. Application services, repositories and UI reducers are exercised
through their public interfaces; tests must not assert private calls or exact
internal collaborator order. New domain/services code targets at least 80%
line coverage when `cargo-llvm-cov` is available; coverage never substitutes
for the named behavior tests.

## Boundaries

- Always: write and run the named failing test before each minimal production
  change; retain it as a behavioral regression test.
- Always: regenerate `shared/types.ts`; never hand edit it.
- Always: delete superseded closed-Agent code once the replacement slice is
  green; do not retain compatibility aliases or feature flags.
- Ask first: adding an external dependency, changing Tauri capabilities,
  changing the official Registry source, or altering existing conversation data
  outside the stated migration.
- Never: reintroduce a fixed Agent enum into new management/session APIs;
  accept user-supplied commands, custom Registry URLs, PATH auto-takeover,
  remote ACP endpoints, implicit process termination, or ACP persistent
  configuration writes. Interactive account actions must remain Profile-
  whitelisted and user-initiated per ADR-0037.

## Success criteria

1. The product has no user-visible hard-coded seven-Agent list; a compatible
   official Registry Agent can be added, installed, repaired, updated and
   removed through the universal pipeline.
2. The twelve built-ins exhibit only their approved Profile/default-detection
   differences and remain on the universal implementation path.
3. A current local Runtime plus ACP lock is required for every new session;
   all lifecycle and migration edge cases above are covered by red-green tests.
4. The Agent settings UI meets the specified bar, Registry, detail, feedback,
   accessibility and Tahoe surface requirements at light and dark themes.
5. The obsolete enum/seeding/hard-coded provider panels and their dead tests are
   deleted, and all release seams pass.
