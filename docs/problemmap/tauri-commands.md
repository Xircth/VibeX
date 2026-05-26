# ProblemMap: Tauri Command Layer

Scope: `src-tauri/src/**`, especially `src-tauri/src/commands/**`.

## Problems

### TAURI-001: Workspace command modules use textual `include!` composition

- Category: complex implementation, weak boundary, historical baggage
- Severity: high
- Confidence: high
- Files: `src-tauri/src/commands/workspaces.rs`, `src-tauri/src/commands/workspaces/*.rs`, `src-tauri/src/commands/provider_runtime/mod.rs`
- Evidence: `workspaces.rs` and `provider_runtime/mod.rs` pull many sibling files into one module with `include!`, so each included file depends on imports from the parent module rather than explicit module imports.
- Risk: dependencies are hidden, compiler errors surface far from the owning file, and helper extraction is harder because included files share one namespace.
- Suggested behavior lock: compile-level checks plus targeted tests around exported commands before converting included files to real `mod` modules.
- Cleanup status: workspace command include cleanup completed; provider runtime include cleanup completed.
- Fix: converted `src-tauri/src/commands/workspaces/types.rs` from a textual include to a real `mod types; pub use types::*;` module with explicit imports, removing its dependency on parent-module `Deserialize` and `ProviderKind` imports.
- Fix: converted `src-tauri/src/commands/workspaces/commit_commands.rs` from a textual include to a real `mod commit_commands; pub use commit_commands::*;` module with explicit imports while preserving the existing worktree resolver call.
- Fix: converted `src-tauri/src/commands/workspaces/pr_import.rs` from a textual include to a real `mod pr_import; pub use pr_import::*;` module with explicit imports, and removed its stale trailing commit-operations marker now that commit commands live in their own module.
- Fix: converted `src-tauri/src/commands/workspaces/workspace_crud.rs` from a textual include to a real `mod workspace_crud; pub use workspace_crud::*;` module with explicit imports while keeping workspace sync/recovery helpers in the parent module for now.
- Fix: converted `src-tauri/src/commands/workspaces/workspace_queries.rs` from a textual include to a real `mod workspace_queries; pub use workspace_queries::*;` module with explicit imports, and made its worktree resolver `pub(super)` for sibling command modules.
- Fix: converted `src-tauri/src/commands/workspaces/workspace_sync.rs` from a textual include to a real `mod workspace_sync;` module with explicit imports, exposing only the two CRUD-needed sync helpers as `pub(super)`.
- Fix: converted `src-tauri/src/commands/workspaces/pull_requests.rs` from a textual include to a real `mod pull_requests; pub use pull_requests::*;` module with explicit imports while keeping PR auto-description follow-up private to that module.
- Fix: converted `src-tauri/src/commands/workspaces/workspace_scripts.rs` from a textual include to a real `mod workspace_scripts; pub use workspace_scripts::*;` module with explicit imports, including platform-gated `ScriptContext` import for macOS-only GitHub CLI setup.
- Fix: converted `src-tauri/src/commands/workspaces/git_operations.rs` from the final workspace textual include to a real `mod git_operations; pub use git_operations::*;` module with explicit imports, reducing `src-tauri/src/commands/workspaces.rs` to module declarations/re-exports.
- Verification: `cargo check -p vibex`; `pnpm run check`; `pnpm run lint`.
- Remaining cleanup: production command shards no longer use textual `include!`; provider runtime test fixture includes remain in `tests.rs`.

### TAURI-002: Workspace script commands mix command orchestration with script-action construction

- Category: duplication, complex implementation, weak boundary, missing tests
- Severity: high
- Confidence: high
- Files: `src-tauri/src/commands/workspaces/workspace_scripts.rs`, `src-tauri/src/commands/workspaces/pr_import.rs`, `src-tauri/src/commands/sessions.rs`
- Evidence: command handlers construct dev-server, setup, cleanup, archive, tool-install, and follow-up action chains while also resolving DB rows, sessions, workspaces, and container startup.
- Risk: script action semantics can drift between manual script runs, PR import setup, queued follow-up cleanup, and workspace startup.
- Cleanup status: pass 1 completed.
- Fix: setup/cleanup/archive repo-script action chains now use `services::services::container_actions` instead of `ContainerService` trait methods.
- Fix: dev-server and GitHub CLI tool-install actions now use the same generic script-action builder instead of constructing `ScriptRequest` directly in command handlers.
- Fix: dev-server repo-script action construction now uses `dev_server_action_for_repo`, so missing/empty dev scripts are handled at the builder boundary instead of unwrapped in the command handler.
- Behavior lock: `cargo test -p services container_actions --lib` covers repo-order preservation, script context, working directory, no-script cases, standalone setup, dev-server action absence/presence, and sequential setup-to-coding chains.
- Verification: `cargo test -p services container_actions --lib`; `cargo check -p services -p local-deployment`; `pnpm run check`; `pnpm run lint`.
- Remaining cleanup: command handlers still own session lookup/creation and execution scheduling; do not move those side effects without command-level behavior tests.

### TAURI-003: File tree command is a broad filesystem boundary with narrow coverage

- Category: complex implementation, weak boundary, missing tests
- Severity: high
- Confidence: high
- Files: `src-tauri/src/commands/file_tree.rs`
- Evidence: one command file owns preview parsing for text/docx/binary assets, directory traversal, file write/delete/copy/move, duplicate naming, search, and command response shaping.
- Risk: path traversal, binary/text detection, docx parsing, and mutation behavior can regress independently, while existing tests cover only a small portion of helper behavior.
- Suggested behavior lock: path-boundary tests for read/write/copy/move/delete plus preview classification tests before splitting filesystem mutation and preview parsing modules.
- Cleanup status: pass 7 completed.
- Fix: added [tauri-003-file-tree-plan.md](tauri-003-file-tree-plan.md), extracted read/write/delete/copy/move/create filesystem helpers, and made Tauri commands delegate to them without changing command signatures.
- Fix: moved the covered filesystem helpers into `src-tauri/src/commands/file_tree/filesystem_ops.rs`, leaving `file_tree.rs` focused on Tauri command wiring plus the still-unsplit preview/traversal/search concerns.
- Fix: moved document/binary preview responses, binary asset reading, DOC/DOCX extraction, DOCX XML-to-HTML/text parsing, and parser tests into `src-tauri/src/commands/file_tree/preview.rs`; only preview response types are re-exported for Tauri command signatures.
- Fix: moved file-tree traversal, git-status mapping, directory listing, scan budget, and special-directory classification into `src-tauri/src/commands/file_tree/listing.rs`, leaving the public commands as thin delegators.
- Fix: moved text search response types, query/glob compilation, match previews, and workspace search walking into `src-tauri/src/commands/file_tree/search.rs`, with public search command forwarding only.
- Fix: moved `get_file_at_head` git blob reads into `src-tauri/src/commands/file_tree/git_head.rs` and canonicalized the git workdir before `strip_prefix`, fixing a Windows short-path/long-path false boundary failure.
- Fix: resolved the `create_directory` command contract mismatch by giving directory creation a dedicated sanitizer that rejects relative paths and `..`, canonicalizes the nearest existing ancestor, and permits missing child parents for `create_dir_all` without loosening save/move semantics.
- Plan: [tauri-003-file-tree-dead-sandbox-helper-plan.md](tauri-003-file-tree-dead-sandbox-helper-plan.md) documents the dead sandbox helper cleanup after active file-tree path-boundary behavior was locked.
- Fix: deleted unused `validate_path_within_sandbox`, removing a future-facing `#[allow(dead_code)]` path-safety helper that had no callers, and replaced garbled section banners in `file_tree.rs` with readable ASCII comments.
- Behavior lock: `cargo test -p vibex file_tree --lib` covers relative/parent path rejection, UTF-8 read/write, missing save parent behavior, file/directory delete, unique copy names, recursive directory copy, move conflict handling, self-move rejection, leaf directory creation, missing parent directory creation, binary rejection, docx parsing helpers, listing invalid-relative-path rejection, root-relative listing, special-directory non-recursion, dependency-directory tree skipping, search empty-query rejection, include/exclude filtering, binary-file skipping, search special-directory pruning, whole-word matching, HEAD-vs-worktree git reads, and binary git blob rejection.
- Verification: `cargo test -p vibex file_tree --lib`; `cargo fmt --check`; `cargo check -p vibex`; `pnpm run check`; `pnpm run lint`.
- Remaining cleanup: the remaining `file_tree.rs` code is now active path normalization/sanitization, shared text-file read, thin Tauri command forwarding, and the existing test harness; the unused sandbox-helper stub is gone.

### TAURI-004: Provider runtime command layer remains broad despite good fixture coverage

- Category: complex implementation, weak boundary
- Severity: medium-high
- Confidence: medium-high
- Files: `src-tauri/src/commands/provider_runtime/*.rs`
- Evidence: provider runtime code is split by included files but still shares parent-module imports and state, with large files for app-server, provider tools, text/event conversion, and turn lifecycle.
- Risk: state-machine changes can cross text formatting, tool event conversion, and runtime session lifecycle without explicit module boundaries.
- Suggested behavior lock: preserve existing provider runtime fixture coverage, then convert include-based files to real modules one group at a time.
- Cleanup status: completed.
- Fix: added [tauri-004-provider-runtime-plan.md](tauri-004-provider-runtime-plan.md) and converted `src-tauri/src/commands/provider_runtime/token_usage.rs` from a textual include to a real `mod token_usage;` module with explicit imports and parent-private extractor imports.
- Fix: converted `src-tauri/src/commands/provider_runtime/provider_text.rs` from a textual include to a real `mod provider_text;` module with explicit imports and `pub(super)` helper visibility for sibling runtime shards.
- Fix: converted `src-tauri/src/commands/provider_runtime/opencode_sdk.rs` from a textual include to a real `mod opencode_sdk;` module with explicit bridge input, metadata discovery, command mapping, and model mapping imports.
- Fix: converted `src-tauri/src/commands/provider_runtime/claude_sdk.rs` from a textual include to a real `mod claude_sdk;` module with explicit bridge input, model alias, metadata discovery, command mapping, and model mapping imports.
- Fix: converted `src-tauri/src/commands/provider_runtime/runtime_config.rs` from a textual include to a real `mod runtime_config;` module with explicit profile, fallback, commit-reminder, and hidden-process imports.
- Fix: converted `src-tauri/src/commands/provider_runtime/provider_tools.rs` from a textual include to a real `mod provider_tools;` module with explicit provider tool update, action mapping, file-change, command-result, and base64 imports.
- Fix: converted `src-tauri/src/commands/provider_runtime/native_conversation.rs` from a textual include to a real `mod native_conversation;` module with explicit sink, assistant/tool state, log patch, token/error, and DB completion imports.
- Fix: converted `src-tauri/src/commands/provider_runtime/runtime_core.rs` from a textual include to a real `mod runtime_core;` module with explicit provider session, workspace resolution, execution process, prompt image, and runtime probe imports.
- Fix: converted `src-tauri/src/commands/provider_runtime/history_commands.rs` from a textual include to a real `mod history_commands; pub use history_commands::*;` module with explicit history DB, status, send-turn, interrupt, session, and Codex control imports.
- Fix: converted `src-tauri/src/commands/provider_runtime/provider_turns.rs` from a textual include to a real `mod provider_turns;` module with explicit Claude/OpenCode SDK turn, ACP fallback, process IO, active-turn, and conversation sink imports.
- Fix: converted `src-tauri/src/commands/provider_runtime/codex_app_server.rs` from a textual include to a real `mod codex_app_server;` module with explicit JSON-RPC, app-server process, auto-compaction, model discovery, steer, and native turn imports; preserved the public `interrupt_codex_native_execution_process` re-export for workspace cleanup callers.
- Fix: converted the remaining provider-runtime test fixture composition from `include!` to explicit `events` and `sdk` test submodules using `#[path]`, and made each fixture file import parent test helpers explicitly.
- Verification: `cargo test -p vibex provider_runtime --lib`; `cargo fmt --check`; `rg -n "include!" src-tauri/src/commands/provider_runtime`; `cargo check -p vibex`; `pnpm run check`; `pnpm run lint`.
- Remaining cleanup: provider-runtime production and test shards no longer use textual `include!`.

### TAURI-005: Command layer still owns direct process-launch surfaces

- Category: weak boundary, duplication
- Severity: medium-high
- Confidence: medium
- Files: `src-tauri/src/commands/config.rs`, `src-tauri/src/commands/filesystem.rs`, `src-tauri/src/commands/system_maintenance.rs`, `src-tauri/src/commands/workspaces/workspace_scripts.rs`
- Evidence: command handlers directly call `tokio::process::Command`, `new_hidden_std_command`, package-manager executables, and shell resolver helpers.
- Risk: Windows hidden-window policy and process failure reporting can drift across command families.
- Suggested behavior lock: command-construction tests or wrapper-level tests before centralizing process launch policy further.
- Cleanup status: pass 1 completed.
- Fix: added [tauri-005-process-launch-plan.md](tauri-005-process-launch-plan.md), extended `utils::process` tests so normal executable hidden-command builders are covered alongside Windows batch wrappers, and routed notification sound player launches through `utils::process::new_hidden_tokio_command`.
- Cleanup status: pass 2 completed.
- Fix: added `utils::process::command_output_detail` for the repeated stderr-first/stdout-fallback failure-detail policy, with tests for stderr precedence, stdout fallback, and empty output.
- Fix: replaced duplicated failure-detail extraction in `system_maintenance.rs`, `agent_settings.rs`, and `workspaces/workspace_scripts.rs` while preserving each command's existing fallback message text.
- Verification: `cargo test -p utils command_output_detail --lib`; `cargo test -p utils process --lib`; `cargo fmt --check`; `cargo check -p vibex`; `pnpm run check`; `pnpm run lint`.
- Cleanup status: pass 3 completed.
- Plan: [tauri-005-file-preview-output-detail-plan.md](tauri-005-file-preview-output-detail-plan.md) documents the file-preview command-output detail cleanup while keeping provider-runtime SDK errors out of scope.
- Fix: added a file-preview failure-message helper in `src-tauri/src/commands/file_tree/preview.rs` and routed failed preview extractor output through `utils::process::command_output_detail`, preserving the existing generic fallback while adding stdout fallback when stderr is empty.
- Behavior lock: red `cargo test -p vibex preview_extraction_failure_message --lib` first failed on the missing helper; after implementation, file-preview tests prove stderr detail is preferred, stdout detail is used when stderr is empty, and empty output keeps the generic preview failure message.
- Verification: `cargo test -p vibex preview_extraction_failure_message --lib`; `cargo test -p vibex file_tree --lib`; `cargo test -p utils command_output_detail --lib`; `cargo check -p vibex`; `cargo fmt --check`; `pnpm run check`; `pnpm run lint`.
- Cleanup status: pass 4 completed.
- Plan: [tauri-005-provider-sdk-output-detail-plan.md](tauri-005-provider-sdk-output-detail-plan.md) documents the provider SDK metadata discovery failure-detail cleanup while keeping long-running app-server/native-turn stderr readers out of scope.
- Fix: added `provider_sdk_metadata_failure_error` in `src-tauri/src/commands/provider_runtime/runtime_core.rs` and routed Claude/OpenCode SDK metadata discovery failures through `utils::process::command_output_detail`, preserving provider-native error wrapping and the generic `SDK metadata discovery failed` fallback while adding stdout fallback when stderr is empty.
- Behavior lock: red `cargo test -p vibex provider_sdk_metadata_failure_error --lib` first failed on the missing helper; after implementation, provider SDK tests prove stderr detail is preferred, stdout detail is used when stderr is empty, empty output keeps the generic SDK metadata discovery message, and the existing Claude Code/OpenCode provider labels are preserved.
- Verification: `cargo test -p vibex provider_sdk_metadata_failure_error --lib`; `cargo test -p vibex provider_runtime --lib`; `cargo test -p utils command_output_detail --lib`; `cargo check -p vibex`; `cargo fmt --check`; `pnpm run check`; `pnpm run lint`.
- Remaining cleanup: Codex app-server and native-turn stderr readers are intentionally separate long-running stream surfaces; do not fold them into the metadata/helper path without fresh stream-surface behavior tests.

### TAURI-006: Prompt enhancement model parser test fixture is corrupted

- Category: historical baggage, test clarity
- Severity: low-medium
- Confidence: high
- Files: `src-tauri/src/commands/config/prompt_enhancement.rs`
- Evidence: `parses_opencode_models_from_stdout_lines` used a mojibake stdout line with a damaged newline marker, obscuring the model-token parsing behavior the test protects.
- Risk: future parser changes would be reviewed against an unreadable fixture rather than a representative CLI output sample.
- Cleanup status: fixed in this pass.
- Plan: [tauri-006-prompt-enhancement-model-fixture-plan.md](tauri-006-prompt-enhancement-model-fixture-plan.md) documents the fixture-only cleanup.
- Fix: replaced the corrupted stdout line with readable representative opencode output that still wraps an `opencode/...` token in punctuation.
- Behavior lock: pre-edit and post-edit `cargo test -p vibex parses_opencode_models_from_stdout_lines --lib` passed with the same expected parsed model list.
- Verification: `cargo test -p vibex parses_opencode_models_from_stdout_lines --lib`; `cargo check -p vibex`; `cargo fmt --check`; `pnpm run check`; `pnpm run lint`; `git diff --check`.

### TAURI-007: MCP config server-path writer panics on invalid path contracts

- Category: weak boundary, panic-prone config mutation, missing tests
- Severity: medium
- Confidence: high
- Files: `src-tauri/src/commands/config/mcp_servers.rs`
- Evidence: `set_mcp_servers_in_config_path` used `path.len() - 1`, `path.last().unwrap()`, and object `unwrap()` calls while mutating user config JSON from an `McpConfig.servers_path` contract.
- Risk: a malformed or future MCP config path can panic inside a Tauri command instead of returning an actionable error.
- Cleanup status: fixed in this pass.
- Plan: [tauri-007-mcp-config-path-boundary-plan.md](tauri-007-mcp-config-path-boundary-plan.md) documents the checked config-path traversal cleanup.
- Fix: added an explicit empty-path error and replaced unwrap-based nested mutation with checked object traversal plus object creation/replacement for intermediate path segments.
- Behavior lock: red `cargo test -p vibex mcp_servers --lib` first failed with an empty-path subtraction overflow panic; after implementation, tests prove empty paths return an MCP path error and non-object intermediate values are replaced before writing server maps.
- Verification: `cargo test -p vibex mcp_servers --lib`; `cargo check -p vibex`; `cargo fmt --check`; `pnpm run check`; `pnpm run lint`; `git diff --check`.

## Safest Cleanup Candidates

1. Continue module-level ProblemMap review outside Tauri command layer; the currently documented Tauri command include/process/file-tree/provider-runtime SDK/prompt-enhancement fixture/MCP path-boundary issues have concrete cleanup passes and verification.

## Uncertainties

- TAURI-005 generic process-launch, generic failure-detail, file-preview output-detail, and provider SDK metadata output-detail cleanup is covered. Long-running provider runtime stream stderr readers remain separate until their stream-specific behavior is locked.
