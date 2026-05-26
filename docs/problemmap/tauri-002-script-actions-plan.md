# TAURI-002 Script Action Cleanup Plan

Scope: `services::container_actions` and the Tauri workspace script command
callers that still construct `ScriptRequest` directly.

## Problem

RB-001 pass 4 moved setup/cleanup/archive repo-script actions out of
`ContainerService`, but Tauri workspace script commands still hand-build
dev-server and tool-install `ExecutorAction` chains. That leaves script action
shape split between service helpers and command handlers.

## Behavior Locks Before Edits

- generic script actions preserve script text, Bash language, context,
  working-dir, and next-action chaining;
- dev-server callers keep using `ScriptContext::DevServer` and the resolved repo
  script working directory, and missing repo dev scripts produce no action
  instead of being unwrapped in command code;
- GitHub CLI setup keeps install then auth action order and
  `ScriptContext::ToolInstallScript`.

## Implementation Slice

1. Add a public generic script-action builder to
   `crates/services/src/services/container_actions.rs`.
2. Reuse it from existing repo-script builders.
3. Add a repo-aware dev-server action helper.
4. Replace direct dev-server and GitHub CLI tool-install `ScriptRequest`
   construction in `src-tauri/src/commands/workspaces/workspace_scripts.rs`.
5. Keep command-level platform checks, session creation, container startup, and
   execution scheduling unchanged.

## Verification

- `cargo test -p services container_actions --lib`
- `pnpm run check`
- `pnpm run lint`
