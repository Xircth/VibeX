# ProblemMap: Rust Backend And Runtime

Scope: `crates/**`, excluding `target`, vendored code, and frontend code. Findings are intentionally not downgraded for size or effort.

## Problems

### RB-001: Container runtime abstraction is a god trait with one real implementation

- Category: over-abstraction, complex implementation, weak boundary, missing tests
- Severity: high
- Confidence: high
- Files: `crates/services/src/services/container.rs`, `crates/local-deployment/src/container.rs`
- Evidence: `ContainerService` owns substantial workflow logic such as finalization, reset, stop, and action scheduling, while the inspected repo has one real implementor: `LocalContainerService`.
- Risk: the trait looks like a portability boundary but carries orchestration logic itself, making behavior harder to test or replace.
- Suggested behavior lock: service-level tests around finalize/reset/stop/start-next transitions before extracting pure workflow helpers or collapsing false abstraction.

### RB-002: Workspace/worktree path rules are duplicated across service and local runtime layers

- Category: duplication, historical baggage, weak boundary
- Severity: high
- Confidence: high
- Files: `crates/services/src/services/container.rs`, `crates/local-deployment/src/container.rs`
- Evidence: generic service helpers and local runtime helpers both encode `use_worktree`, repo-root detection, workspace base, and `agent_working_dir` rules.
- Risk: path derivation can diverge between scheduling/orchestration and local deployment.
- Suggested behavior lock: table-driven tests for `use_worktree=false`, app-owned workspace dirs, direct external worktrees, and `agent_working_dir` that starts with the repo name.
- Cleanup status: pass 1 completed.
- Fix: extracted `crates/services/src/services/workspace_paths.rs` for pure workspace path policy covering service workspace base-dir derivation, agent working-dir normalization, and local runtime repo path derivation.
- Behavior lock: added table-driven unit coverage for non-worktree repo path use, container refs pointing at repo roots, agent working-dir repo prefix strip/add behavior, direct checkout roots, agent dirs targeting repo folders, and agent dirs targeting subdirectories.
- Verification: `cargo test -p services workspace_paths --lib`; `cargo check -p services -p local-deployment`; `pnpm run check`; `pnpm run backend:lint`.
- Remaining cleanup: `local-deployment` still owns direct external worktree discovery and `normalized_workspace_base_dir` because its current direct-checkout base-dir semantics differ from the service-side execution base-dir helper. Do not collapse those until direct external worktree behavior is locked with integration coverage.

### RB-003: Git service remains a split-brain facade over CLI and libgit2

- Category: complex implementation, duplication, weak boundary
- Severity: high
- Confidence: high
- Files: `crates/git/src/lib.rs`, `crates/git/src/cli.rs`
- Evidence: `cli.rs` documents CLI-for-mutation policy, while `GitService` remains a large facade that wraps CLI mutations and keeps libgit2/network logic.
- Risk: command behavior, auth/network behavior, and service policy are hard to reason about as separate concerns.
- Suggested behavior lock: focused tests around mutation command construction, read/network behavior, and worktree operations before splitting facade responsibilities.
- Cleanup status: pass 2 completed.
- Fix: extracted public DTOs, option/result structs, `GitServiceError`, and `DiffTarget`/`Commit` wrappers into `crates/git/src/types.rs`, re-exported from `crates/git/src/lib.rs`. This removes UI/API response type declarations and corrupted historical banner comments from the service implementation file without changing public imports.
- Fix: extracted Git panel/staging/log/commit operations into `crates/git/src/panel_ops.rs`, including the related status formatting, binary/image detection, numstat parsing, and untracked-file line counting helpers. `GitService::read_file_to_string` is now `pub(crate)` so the helper remains internal to the crate while allowing the panel module to reuse the existing repository-relative file read policy.
- Behavior lock: used the existing Git crate regression suite before and after the move; it covers branch/worktree status, dirty-worktree safety, merge/rebase safety, push/fetch behavior, sparse-checkout diffs, and workflow operations.
- Verification: `cargo test -p git`; `cargo check -p git`; `pnpm run check`; `pnpm run lint`.
- Remaining cleanup: service implementation is still broad. Next slice should separate branch/worktree workflow helpers from read-only graph/diff queries after adding narrower tests around the selected method group.

### RB-004: ACP log normalization does parsing, formatting, task inference, and stream state in one file

- Category: complex implementation, weak boundary, missing tests
- Severity: high
- Confidence: medium-high
- Files: `crates/executors/src/executors/acp/normalize_logs.rs`
- Evidence: normalization entry points sit beside markdown formatting, tool-result extraction, task-create inference, partial tool-call state, and parser machinery.
- Risk: pure formatting changes can accidentally alter parser semantics, and helper-oriented tests do not prove real ACP event sequences end to end.
- Suggested behavior lock: one end-to-end ACP fixture for `normalize_logs*`, plus explicit assertions for task-create extraction, cumulative streaming text replacement, and image/resource markdown rendering.
- Cleanup candidate: split pure formatting/extraction helpers first, before touching parser behavior.
- Cleanup status: fixed in this pass for pure formatting, task inference, parser, streaming-text, and partial tool-call state boundaries.
- Fix: extracted `crates/executors/src/executors/acp/formatting.rs` for ACP plan/content-block Markdown rendering, `crates/executors/src/executors/acp/task_inference.rs` for task-create/subagent inference, `crates/executors/src/executors/acp/parser.rs` for ACP line parsing plus execute-command title normalization, `crates/executors/src/executors/acp/streaming.rs` for streaming text state/merge policy, and `crates/executors/src/executors/acp/tool_state.rs` for partial tool-call state accumulation. `normalize_logs.rs` now adapts event-loop data through narrow helper inputs instead of owning every policy.
- Behavior lock: added an end-to-end stdout ACP event sequence test that drives `MsgStore` through `normalize_logs_with_context_window_override` and asserts cumulative assistant replacement, task-create inference, completed tool status, raw output preservation, and token context fallback. Added parser tests for serialized ACP event lines, invalid lines, raw command precedence, and known execute-title suffix stripping. Added a tool-update sequence test proving title-less updates reuse existing tool state, replace the same normalized entry, preserve execute command semantics, and surface completed output.
- Correctness fix: replaced the old execute-title suffix parsing based on `split(...).next()` because it made the parenthetical suffix branch unreachable; the parser now uses `split_once` for the known suffixes.
- Verification: `cargo test -p executors acp::parser --lib`; `cargo test -p executors acp::normalize_logs --lib`; `cargo check -p executors`; `pnpm run check`; `pnpm run backend:lint`; `pnpm run lint`.

### RB-005: Notification and DB update surfaces contain stale no-op or dead seams

- Category: dead code, historical baggage
- Severity: medium
- Confidence: high
- Files: `crates/db/src/models/execution_process.rs`, `crates/services/src/services/notification.rs`
- Evidence: `UpdateExecutionProcess` is marked `#[allow(dead_code)]` and appears unreferenced. `NotificationService` carries a no-op `send_push_notification` plus OS-specific notification helpers that appear unused in the current flow.
- Risk: stale seams obscure the real notification contract and invite future work to integrate with dead APIs.
- Cleanup status: fixed in this pass.
- Fix: removed the unreferenced `UpdateExecutionProcess` DTO, removed no-op push notification dispatch, and deleted private unused OS-native push helper functions plus their `#[allow(dead_code)]` suppressions.
- Behavior lock: reference search proved the removed symbols had no callers outside the no-op internal dispatch; `generate-types:check` proved shared generated TypeScript did not drift after deleting the `TS`-derived DTO.
- Verification: `cargo check -p db -p services`; `pnpm run generate-types:check`; `pnpm run check`; `pnpm run lint`.

## Safest Cleanup Candidates

1. RB-002 workspace-path helper consolidation. It can be protected with pure table-driven tests and then used from both layers.
2. RB-003 Git service split pass 3. Type definitions and Git panel operations are separated; next safe backend cleanup is to split branch/worktree workflow helpers from read-only graph/diff queries with targeted tests around the selected method group.

## Uncertainties

- RB-001 should not be collapsed until external/deployment extension plans are checked. If future non-local implementations are planned, the cleanup should move workflow logic out of the trait instead of deleting the abstraction.
- RB-002 direct external worktree base-dir semantics remain intentionally unresolved in pass 1; they need stronger tests before consolidation.
- RB-004 still has a large event loop, but its helper policies are now separated. Further event-loop splitting should wait for broader approval-response and request-permission fixtures, not because the work is too large, but because current evidence would be too indirect to prove event ordering unchanged.
