# TAURI-005 Provider SDK Output Detail Cleanup Plan

## Scope

- Keep this pass limited to Claude/OpenCode SDK metadata discovery process-output failures.
- Do not change metadata bridge commands, arguments, timeouts, temp-file cleanup, JSON-line parsing, or streaming turn process handling.
- Do not fold Codex app-server or native turn stderr readers into this helper; those are long-running stream surfaces with different semantics.

## Behavior Locks

- Add provider-runtime SDK unit coverage for metadata discovery failure messages:
  - stderr detail is preferred over stdout
  - stdout detail is used when stderr is empty
  - empty stderr/stdout keeps the current generic `SDK metadata discovery failed` fallback

## Edit Plan

1. Add a provider-runtime helper for SDK metadata discovery failure errors.
2. Reuse `utils::process::command_output_detail` inside that helper.
3. Wire Claude and OpenCode metadata discovery through the helper while preserving provider-specific native runtime error wrapping.

## Verification

- `cargo test -p vibex provider_sdk_metadata_failure_error --lib`
- `cargo test -p vibex provider_runtime --lib`
- `cargo test -p utils command_output_detail --lib`
- `cargo fmt --check`
- `cargo check -p vibex`
- `pnpm run check`
- `pnpm run lint`
