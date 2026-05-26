# RU-003 Process Command Construction Test Plan

## Scope

- `crates/utils/src/process.rs`
- `docs/problemmap/rust-utils.md`
- `docs/problemmap/README.md`

## Smell

`new_hidden_tokio_command` and `new_hidden_std_command` are the shared process-launch boundary used by multiple crates, but ordinary executable command construction is only covered indirectly by Windows-only runtime tests. That leaves argument preservation and program selection weakly proven on non-Windows platforms.

## Behavior Lock

Add platform-neutral construction tests for:
- `new_hidden_std_command` preserves the requested program and all arguments in order.
- `new_hidden_tokio_command` preserves the requested program and all arguments in order via `as_std()`.

The existing Windows-only `.cmd` runtime tests remain the authority for Windows batch-wrapper behavior.

## Cleanup

This pass is test reinforcement only. Do not change process-launch behavior.

## Verification

- `cargo test -p utils process --lib`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
