# TAURI-003 File Tree Cleanup Plan

Scope: `src-tauri/src/commands/file_tree.rs`

## Problem

`file_tree.rs` is the Tauri boundary for unrelated filesystem concerns:
tree traversal, file preview, binary asset reads, text search, and direct
mutations. The highest-risk part is mutation plus path resolution because it
can lose data or cross workspace boundaries if behavior drifts.

## Behavior Lock First

- Add focused unit coverage for the synchronous filesystem operations behind
  `read_file_content`, `save_file_content`, `delete_file`, `copy_item`,
  `move_item`, and `create_directory`.
- Cover absolute-path acceptance, relative/parent traversal rejection, missing
  parents, copy naming, recursive directory copy, move conflicts, and
  directory self-move rejection.
- Keep tests in `file_tree.rs` for this pass so they can protect an eventual
  module split without changing the public Tauri command contract.

## Cleanup Pass 1

- Extract mutation and read-path helpers inside `file_tree.rs`.
- Make Tauri commands delegate to those helpers without changing signatures,
  return payloads, or error wording.
- Do not introduce sandbox-root policy in this pass; existing commands do not
  receive `AppState`, so changing that contract would be a behavior change.

## Cleanup Pass 2

- Move the covered filesystem helpers into a `file_tree/filesystem_ops.rs`
  submodule.
- Keep path sanitization in the parent command module for now because preview,
  asset, git-head, and search-adjacent paths still use it.
- Keep command signatures and tests unchanged; this pass is a module-boundary
  move, not a behavior change.

## Cleanup Pass 3

- Move document/binary preview helpers into `file_tree/preview.rs`.
- Re-export only the response types needed by public Tauri command signatures.
- Move docx/binary preview tests with the preview helpers so parser behavior is
  owned by the module that implements it.

## Cleanup Pass 4

- Move file-tree traversal, git-status mapping, and directory listing into
  `file_tree/listing.rs`.
- Keep only public Tauri command forwarding in `file_tree.rs`.
- Add listing behavior locks for relative-path rejection, root-relative
  directory output, special-directory pruning, and tree skipping of dependency
  directories.

## Cleanup Pass 5

- Move text search response types, query/glob compilation, match previews, and
  workspace search walking into `file_tree/search.rs`.
- Add search behavior locks for empty queries, include/exclude filtering,
  binary-file skipping, special-directory pruning, and whole-word matching.

## Cleanup Pass 6

- Move `get_file_at_head` git blob reading into `file_tree/git_head.rs`.
- Add git-head behavior locks for reading committed HEAD content rather than
  worktree content and rejecting binary blobs.
- Canonicalize the git workdir before `strip_prefix` so Windows short-path and
  long-path representations do not falsely fail the repository-boundary check.

## Verification

- `cargo test -p vibex file_tree --lib`
- `cargo check -p vibex`
- `pnpm run check`
- `pnpm run lint`

## Deferred

- Split preview parsing and mutation commands into separate modules only after
  helper-level coverage is in place.
- Add AppState-backed allowed-root validation as a separate design/change set,
  because it changes the command boundary and requires frontend/runtime
  contract decisions.
