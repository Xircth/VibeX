# TAURI-003 File Tree Dead Sandbox Helper Cleanup Plan

## Scope

- Keep this pass limited to `src-tauri/src/commands/file_tree.rs`.
- Remove only the unused future-facing sandbox helper and meaningless banner comments.
- Preserve all active file-tree path sanitizers, filesystem operations, preview handling, listing, search, git-head reads, and command signatures.

## Behavior Lock

- Run the existing file-tree command test suite before editing to prove the active path-boundary behavior is already covered:
  - relative and parent path rejection
  - UTF-8 read/write and binary rejection
  - create/delete/copy/move semantics
  - directory listing/search/git-head/preview behavior

## Edit Plan

1. Delete `validate_path_within_sandbox`, which has no callers and is guarded only by `#[allow(dead_code)]`.
2. Replace garbled banner comments in the same file with plain ASCII section comments.
3. Re-run the file-tree suite plus full project gates.

## Verification

- `cargo test -p vibex file_tree --lib`
- `cargo check -p vibex`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
