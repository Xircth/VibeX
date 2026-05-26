# RB-009 executor action working-dir cleanup plan

## Scope

- Files:
  - `crates/executors/src/actions/mod.rs`
  - `crates/executors/src/actions/coding_agent_initial.rs`
  - `crates/executors/src/actions/coding_agent_follow_up.rs`
  - `crates/executors/src/actions/review.rs`
  - `crates/executors/src/actions/script.rs`
- Smell: duplication, weak execution boundary, missing tests.
- Current issue: four executor action spawn paths each derive the effective execution directory with the same `current_dir.join(working_dir)` / `current_dir` fallback policy. This is an execution boundary and should not drift per action type.

## Behavior lock first

Add focused unit coverage for the shared policy:

- `None` uses the container/current directory directly;
- `Some(relative)` resolves below the current directory;
- nested relative paths preserve path components.

The test should fail before the helper exists.

## Cleanup order

1. Add the failing action helper test.
2. Add a small `effective_working_dir` helper in `actions::mod`.
3. Replace the four local match blocks / request methods with the helper.
4. Keep executor profile selection, approval wiring, QA mock behavior, and script command construction unchanged.

## Verification

- `cargo test -p executors actions --lib`
- `cargo check -p executors`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
