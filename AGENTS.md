# Repository Guidelines

## Required Context Bootstrap

Before planning, searching, editing files, or running commands:

1. Read root `CONTEXT.md` in full.
2. Read every ADR in `docs/adr/` relevant to the task.
3. Match the task against the Agent Skill rules in `CONTEXT.md`.
4. Fully read each directly applicable `SKILL.md` before taking task actions.

Use the smallest set of Skills that fully covers the task. For cross-layer work,
combine the applicable Skills (for example, Tauri IPC + frontend integration +
testing). If a required Skill cannot be read, state why and use the closest safe
alternative.

## Project Structure & Module Organization

VibeX is a local-first Tauri desktop app. `frontend/src/` holds the React + TypeScript UI, with folders such as `components/`, `features/`, `hooks/`, `lib/`, `styles/`, and `utils/`. `src-tauri/` contains the Tauri shell and IPC command wiring. Reusable Rust logic lives in workspace crates under `crates/` (`agents`, `db`, `executors`, `git`, `services`, etc.). Generated TypeScript types are in `shared/types.ts`. Assets live in `assets/`, `frontend/public/`, and `src-tauri/icons/`. Docs and specs belong in `docs/`.

## Build, Test, and Development Commands

- `pnpm install`: install JavaScript dependencies.
- `pnpm run dev`: launch the Tauri desktop app with the Vite dev server.
- `pnpm run check`: run frontend type checking and `cargo check`.
- `pnpm run lint`: run frontend ESLint and Rust clippy with warnings denied.
- `pnpm run format`: run `cargo fmt --all` and frontend Prettier.
- `cd frontend && pnpm test`: run Vitest tests.
- `cargo test --workspace`: run all Rust tests.
- `pnpm run generate-types`: refresh `shared/types.ts` after Rust type changes.
- `pnpm run prepare-db`: refresh SQLx offline metadata after query changes.

## Coding Style & Naming Conventions

Frontend formatting is Prettier: 2 spaces, semicolons, single quotes, ES5 trailing commas, and 80-column print width. ESLint enforces no unused imports, exhaustive switches, and file naming: React `.tsx` components are PascalCase, hooks start with `use`, and utility/config files are camelCase. Rust uses edition 2024 plus `rustfmt.toml`; keep imports grouped. Do not hand-edit generated files such as `shared/types.ts`.

## Testing Guidelines

Place frontend unit tests beside source files as `*.test.ts`, `*.test.tsx`, `*.spec.ts`, or `*.spec.tsx`; Vitest runs them in `jsdom`. Broader regression tests live in `frontend/tests/`. Rust integration tests live under each crate's `tests/` directory. Prefer targeted runs, for example `pnpm exec vitest run src/path/file.test.ts` or `cargo test -p agents test_name`, then run the relevant full check before a PR.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit style: `feat:`, `fix(scope):`, `chore(scope):`, `docs(scope):`, plus explicit merge commits. Keep commits focused and imperative. Pull requests should include a short summary, linked issue or spec, test results, and screenshots or recordings for visible UI changes. Mention generated updates such as `shared/types.ts` or SQLx metadata explicitly.

## Security & Configuration Tips

Keep secrets in local `.env` files only. `.dev-ports.json` and generated Tauri dev config are local runtime artifacts. When changing database queries, generated types, or agent configuration schemas, run the matching check command so CI catches no stale artifacts.
