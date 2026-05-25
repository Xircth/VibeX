# VibeX ProblemMap

This directory is the working map for the repo-wide code-review-and-quality pass.
It is intentionally stricter than a normal "clean enough" review.

## Review Standard

- Do not avoid a problem because it is large.
- Do not downgrade a problem because the current implementation appears to work.
- Do not accept accidental complexity when the same behavior can be implemented more directly.
- Do not treat cleanup as feature cutting. A simplification is valid only when it preserves behavior, unless the feature is proven dead.
- Mark uncertainty explicitly. Do not delete uncertain code without evidence or user confirmation.
- Every optimization module must have behavior-lock evidence before edits and verification evidence after edits.

## Issue Categories

- Complex implementation: same behavior can be expressed with a simpler data flow or API boundary.
- Historical baggage: old paths, shims, compatibility layers, or naming that no longer matches the current system.
- Duplication: repeated logic, repeated CSS/import surfaces, or parallel helpers doing the same job.
- Dead code: unreachable, unused, stale, or intentionally disabled code.
- Weak boundary: shell/process, filesystem, IPC, provider, UI, or persistence boundary leaks responsibility or trusts unvalidated data.
- Over-abstraction: single-use wrappers, speculative indirection, or layers hiding a simpler primitive.
- Missing tests: behavior, security property, or regression path is not protected.

## Module Documents

| Module | Document | Status |
| --- | --- | --- |
| Frontend app | [frontend.md](frontend.md) | FE-001 cleanup completed |
| Rust backend/runtime | [rust-backend.md](rust-backend.md) | RB-002 pass 1, RB-003 pass 2, RB-004 helper/parser/streaming/tool-state split, and RB-005 cleanup completed |
| Rust utils/process boundary | [rust-utils.md](rust-utils.md) | cleanup pass 1 completed |

## Current Verification Ledger

| Date | Scope | Evidence |
| --- | --- | --- |
| 2026-05-25 | `crates/utils/src/browser.rs` WSL browser command construction | `cargo test -p utils browser --lib` passed after red/green TDD cycle |
| 2026-05-25 | project-level type/backend check after Rust utils cleanup | `pnpm run check` passed: frontend `tsc --noEmit`, backend `cargo check` |
| 2026-05-25 | FE-001 Dockview group policy extraction | `pnpm vitest run src/utils/dockviewGroupPolicy.test.ts` passed; `pnpm run check` passed; `pnpm run frontend:lint` passed |
| 2026-05-25 | RB-002 workspace path policy extraction | `cargo test -p services workspace_paths --lib` passed; `cargo check -p services -p local-deployment` passed; `pnpm run check` passed; `pnpm run backend:lint` passed |
| 2026-05-25 | RB-005 stale notification/DB dead-code cleanup | `rg` found no remaining stale symbols; `cargo check -p db -p services` passed; `pnpm run generate-types:check` passed; `pnpm run check` passed; `pnpm run lint` passed |
| 2026-05-25 | RB-004 ACP formatting/task-inference/parser/streaming/tool-state split | `cargo test -p executors acp::parser --lib` passed; `cargo test -p executors acp::normalize_logs --lib` passed; `cargo check -p executors` passed; `pnpm run check` passed; `pnpm run lint` passed |
| 2026-05-25 | RB-003 Git DTO/type boundary extraction | `cargo test -p git` passed; `cargo check -p git` passed; `pnpm run check` passed; `pnpm run lint` passed |
| 2026-05-25 | RB-003 Git panel operation extraction | `cargo test -p git` passed; `cargo check -p git` passed; `pnpm run check` passed; `pnpm run lint` passed |
