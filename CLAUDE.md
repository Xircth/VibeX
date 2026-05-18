# Claude Code Guidance

Claude Code must follow the repository contract in `AGENTS.md`.

## Required Reading
- Read `AGENTS.md` before making code changes.
- Treat `AGENTS.md` as the source of truth for project structure, build and test commands, coding style, testing, security, and workflow rules.
- Keep this file aligned with `AGENTS.md`; do not add conflicting guidance here.

## Local Reference Directories
- `code-reference/` and `code-referance/` are local comparison/reference directories.
- Do not commit, push, or upload either directory.
- Both directories are intentionally ignored by `.gitignore`.

## Shared Types
- Do not edit `shared/types.ts` directly.
- Edit the Rust source types and regenerate TypeScript bindings with `pnpm run generate-types`.
- The generator entry point is `src-tauri/src/bin/generate_types.rs`.

## Verification
- For frontend changes, run `pnpm run frontend:check` and `pnpm run frontend:lint` when relevant.
- For Rust or Tauri changes, run `pnpm run backend:check` and relevant Rust tests.
- For generated type changes, run `pnpm run generate-types:check` when relevant.
