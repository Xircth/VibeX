# Local Agent Runtime Discovery Design

**Date:** 2026-08-09
**Status:** Implemented
**Scope:** First-run Agent selection and Agent settings preflight on Windows,
Linux, and macOS compatibility paths

## Problem

A user can have an official Agent CLI such as Claude Code or Codex installed and
authenticated before launching VibeX for the first time. VibeX currently shows
that Agent as uninstalled during onboarding and reports both the local Runtime
and ACP preflight items as failed in Settings.

The authentication result can still be correct because it is projected from the
Agent's native account/configuration files. The apparently healthy “launch
entry” item is also not executable evidence: it currently means only that the
Agent is present in the local membership list and has not been retired.

The root cause is that the current read model exposes Runtime evidence only from
a complete installation lock. External adoption requires every topology
component, version evidence, integrity evidence, and a successful ACP handshake.
When ACP is absent or its version probe/handshake fails, otherwise valid CLI
Runtime evidence is discarded.

## Product Contract

The first-run and Settings behavior must follow these independent facts:

1. Native authentication evidence may be available without VibeX installation.
2. A locally executable official CLI is sufficient to discover the Agent's
   Runtime.
3. Runtime discovery does not mean ACP is installed, healthy, or authorized for
   session launch.
4. During first-run, Runtime-discovered Agents are placed first and selected by
   default.
5. Continuing first-run starts the existing background installation flow to
   supply the required ACP integration. Completion or failure is reported after
   entering the home screen through the existing Toast flow.
6. Settings preflight reports Runtime and ACP independently. A discovered CLI
   Runtime passes even when ACP is missing; ACP passes only after its component
   and handshake are valid.
7. First-run does not add an ACP-missing warning or other redundant explanatory
   UI.

## Domain Model

The design separates four terms that must not be used interchangeably:

- **Native authentication:** account/configuration evidence owned by the Agent.
- **Local Runtime discovery:** best-effort, refreshable evidence that a
  Profile-declared Runtime executable resolves and can be invoked locally.
- **ACP readiness:** an ACP executable is present and successfully completes the
  required handshake/capability probe.
- **Installation lock:** the authoritative, integrity-checked component set used
  to authorize session launch.

Runtime discovery is evidence for onboarding and diagnostics, not installation
truth. It must never create a partial installation lock or bypass the existing
session launch gate.

The management API will expose an optional local Runtime evidence object rather
than overloading `runtime_version`:

```text
local_runtime?: {
  path: absolute path
  version?: best-effort version text
}
```

The object is absent when no runnable Profile-declared Runtime is found.
`runtime_version` and `acp_version` retain their existing meaning as versions
from the current installation lock.

## Runtime Discovery

### Responsiveness boundary

First-run Runtime discovery is a separate, lightweight readiness phase. The
Agent list may wait for this phase, but it must not wait for external-install
adoption, ACP handshake, integrity reconciliation, or Registry network refresh.
Those checks continue in the existing background management warmup and publish
an invalidation event when their projection changes.

Runtime discovery has both a per-command timeout and an overall inventory
budget. Completed evidence is retained when the overall budget expires; an
unresponsive candidate cannot keep the first-run page in its loading state.
Child processes are terminated when a timed-out probe is dropped.

The onboarding Registry input is cache-first. A stale or empty cache is still
refreshed, but the network request runs after the local list is rendered and
must never be represented as a local Agent check.

### Candidate selection

For each supported built-in Profile, discovery examines only candidates declared
as `agent_runtime` or `combined_runtime`. An adapter-backed Profile does not need
an `acp_adapter` candidate for Runtime discovery to succeed.

The resolver must:

1. Resolve the Profile-declared executable through the current process PATH.
2. Search known user-level binary locations.
3. Refresh the desktop process PATH using the existing platform mechanism and
   try again.
4. Resolve the result to an absolute file path.
5. Invoke the Profile-declared version command with a bounded timeout.

A successfully invoked executable is valid discovery evidence. Version output
is retained when non-empty but is not required for discovery, because some valid
wrappers do not print a version. This permissive evidence cannot authorize a
session; the installation gate remains strict.

### Platform paths

Existing PATH behavior remains the first choice. User-bin fallback covers common
desktop-launch gaps:

- Windows: `PNPM_HOME`, `%APPDATA%\npm`, `%LOCALAPPDATA%\pnpm`,
  `%USERPROFILE%\.bun\bin`, `%USERPROFILE%\.cargo\bin`, and an explicit npm
  prefix when configured.
- Linux: `PNPM_HOME`, `$NPM_CONFIG_PREFIX/bin`, `~/.local/bin`,
  `~/.local/share/pnpm`, `~/.npm-global/bin`, `~/.bun/bin`, and `~/.cargo/bin`.
- macOS keeps the existing login-shell and user-bin behavior; the shared
  discovery semantics apply without regressing it.

The resolver uses platform-native path handling and Windows executable suffix
resolution. It does not parse shell command strings or trust relative paths as
installation identity.

### Lifetime

Discovery evidence is refreshable runtime state, not durable installation state.
It is populated during the existing management warmup and refreshed by explicit
management refresh/preflight actions. This prevents a stale path from surviving
an uninstall across application restarts.

## Read-Model Projection

The Agent management list/detail responses overlay current local Runtime evidence
onto their persisted management projections. No installation lifecycle state is
promoted merely because a CLI is found.

Onboarding computes its discovered state from either:

- current local Runtime evidence, or
- an already complete/persisted installation.

It then preserves the current behavior: discovered Agents sort before other
Agents, are selected automatically, and the first discovered Agent becomes the
default unless an already configured valid default is selected.

The visible installed/discovered badge keeps the current concise onboarding UI;
no ACP warning is added there.

## Settings Preflight

Preflight evaluates evidence in this order:

1. A healthy Runtime component in the current installation lock.
2. Otherwise, current local Runtime discovery evidence.

When either succeeds, the Runtime item passes and displays the available version
and absolute path. A missing or damaged installed Runtime may therefore be
diagnosed separately from a still-available external CLI; the detail must make
the evidence source unambiguous when needed.

ACP remains strict:

- A locked ACP component must pass integrity checks.
- Its configured launch must complete the ACP probe/handshake.
- A bare adapter executable on PATH does not by itself make ACP pass.

Authentication remains independent and continues to use native configuration
plus ACP observations where available.

The “launch entry” item remains membership evidence in this change. Its copy can
be clarified separately; it must not be used as proof of executable discovery.

## Installation After Selection

First-run continues to persist the selection and enter the home screen before
waiting for installation. Selected Agents that lack a complete installation
still call the existing `addAndInstall` operation, and operation events feed the
existing Toast notification path.

For this bug fix, Runtime discovery does not weaken or fabricate the installation
plan. The installer may use its existing managed, pinned Runtime and ACP
components. Reusing a user-owned Runtime inside a mixed-ownership installation
would change installation, update, rollback, and uninstall semantics and is
therefore intentionally outside this detection fix. The user-owned CLI remains
untouched.

## Failure Handling

- A missing executable produces no local Runtime evidence.
- A resolved executable that cannot be invoked produces no evidence and is
  logged at debug level without failing the entire management list.
- A successful invocation with empty version output records path-only evidence.
- Failure of one Agent candidate does not block discovery for other Agents.
- ACP discovery, version, integrity, or handshake failure cannot erase valid
  Runtime evidence.
- Explicit refresh replaces the previous evidence snapshot so removed CLIs do
  not remain detected.

## Test Strategy

Implementation follows vertical TDD slices through public behavior:

1. Cross-platform resolver tests prove known Windows and Linux user-bin paths are
   included without removing current PATH precedence.
2. A management projection test proves a runnable local CLI is returned as local
   Runtime evidence even when no ACP/install lock exists.
3. An onboarding model/component test proves that evidence causes automatic
   selection and first-group ordering while installation remains required.
4. A preflight behavior test proves Runtime passes from local evidence while ACP
   remains failed without a valid installation/handshake.
5. Regression tests prove authentication remains independently projected and a
   detected Runtime cannot authorize session launch.

Targeted frontend and Rust tests run after each vertical slice. Final verification
includes frontend type checking, relevant Vitest suites, targeted Rust tests,
`cargo check` for affected crates, and formatting/lint checks proportional to the
changed surface.

## Acceptance Criteria

- On Windows and Linux, locally installed Claude Code and Codex CLIs are detected
  when launched from the desktop even if the inherited PATH is incomplete.
- On first-run, detected Agents no longer show as uninstalled, are selected
  automatically, and appear before undetected Agents.
- Continuing first-run starts background installation for the missing ACP
  integration and reports through the existing home-screen Toast.
- In Settings, local Runtime passes with path/version evidence independently of
  ACP state.
- ACP stays failed until a valid locked component completes its probe.
- Native subscription/login status remains correct and independent.
- No partial installation lock is created from discovery evidence, and session
  launch authorization remains fail-closed.
