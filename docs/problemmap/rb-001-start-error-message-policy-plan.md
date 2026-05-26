# RB-001 Start Error Message Policy Cleanup Plan

Scope: executor startup failure message construction in `crates/services/src/services/container.rs`.

## Problem

`start_execution` handles executor startup failure persistence and log writes, but it also constructs the normalized setup-required conversation entry inline when the executor binary is missing. The log append belongs in `start_execution`; the display entry shape is pure workflow/presentation policy.

## Behavior Lock

- Missing executor binaries produce an error entry with `SetupRequired`.
- The entry text remains `The required executable `<program>` is not installed.`
- The entry has no timestamp or metadata.

## Cleanup

- Add a pure `container_workflow` helper for setup-required start-error entries.
- Replace the inline `NormalizedEntry` construction in `start_execution`.
- Do not move `ExecutionProcessLogs::append_log_line`, `ConversationPatch::add_normalized_entry`, process failure persistence, or session/task status updates.

## Verification

- `cargo test -p services container_workflow --lib`
- `cargo check -p services -p local-deployment`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
