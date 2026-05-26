# RB-008 filesystem watcher path-kind cleanup plan

## Scope

- File: `crates/services/src/services/filesystem_watcher.rs`
- Smell: weak boundary, missing tests, stale FIXME.
- Current issue: `path_allowed` falls back to an extension heuristic when an event path no longer exists. Deleted extensionless files can therefore be treated as directories, so directory-only `.gitignore` rules may suppress file removal events incorrectly.

## Behavior lock first

Add focused Rust tests that prove:

- a deleted extensionless file event with `EventKind::Remove(RemoveKind::File)` is not matched by a directory-only gitignore rule;
- a deleted directory event with `EventKind::Remove(RemoveKind::Folder)` is still matched by the same directory-only rule.

The first test should fail before the cleanup because the current path filter has no event-kind hint and guesses from the missing path shape.

## Cleanup order

1. Add the regression tests against `debounced_should_forward`.
2. Introduce a narrow file/directory hint derived from precise notify event kinds.
3. Use the hint only when filesystem metadata is unavailable; existing paths still rely on real metadata.
4. Remove the stale FIXME and leave unknown event kinds on the existing conservative fallback.

## Verification

- `cargo test -p services filesystem_watcher --lib`
- `cargo check -p services`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
