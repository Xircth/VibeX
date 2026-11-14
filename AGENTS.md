# Repository Guidelines

## Required Context Bootstrap

Before planning, searching, editing files, or running commands:

1. Read root [`CONTEXT.md`](CONTEXT.md) for Ubiquitous Language and [`docs/architecture.md`](docs/architecture.md) for system boundaries.
2. Read every ADR in [`docs/adr/`](docs/adr/) relevant to the task.
3. Fully read [`maiden-skill`](.agents/skills/maiden-skill/SKILL.md) and apply it on every task.
4. For any user-visible UI work, read [`DESIGN.md`](DESIGN.md) and [`frontend/CLAUDE.md`](frontend/CLAUDE.md) first.
5. Match the task against repository skills under `.agents/skills/` and fully read the smallest set of directly applicable `SKILL.md` files before taking action.

## Project Structure & Module Organization

VibeX is an all-in-one **Agent-Native Development Platform & Vibe Coding Toolkit** built around a Single-Seam Rust Host (`vibex` Tauri desktop app + `vibex-server` headless daemon):

- `frontend/src/` — React + TypeScript workbench (`Dockview` IDE stage + `@xyflow/react` Spatial Canvas, `BackendTransport` over Tauri / HTTP+WS / WebRTC E2EE).
- `src-tauri/` — Native Tauri v2 desktop shell, multi-window host, CEF integration, and IPC adapter over `HostRuntime`.
- `crates/` — 25 Tauri-agnostic Rust workspace crates (`application`, `server`, `remote-protocol`, `agents`, `conversations`, `delegation`, `delegation-proto`, `vibex-mcp`, `workflows`, `vibex-workflow-mcp`, `automation`, `plugins`, `plugin-sdk`, `tool-runtime`, `artifacts`, `browser-host`, `git`, `services`, `db`, `deployment`, `local-deployment`, `executors`, `review`, `api-types`, `utils`). **Agent integration rule ([ADR-0087](docs/adr/0087-dedicated-agent-engine-first-acp-fallback.md))**: inside `crates/agents`, prioritize **dedicated native Agent engine adapters** (official SDKs / native `app-server` protocols & native state/auth) first; treat **ACP (v1/v2 + Registry)** as the secondary compatibility fallback. Never run coding agents through `crates/executors`.
- `shared/` — Generated Rust→TS contracts (`shared/types.ts`) and Host command definitions (`shared/hostCommands.ts`).
- `packages/` & `plugins/` — `@vibex/plugin-sdk`, `vibex-plugin` CLI, `@vibex/plugin-contract`, Python Worker SDK, and 17 official full-trust v4 plugins.
- `npx-cli/` & `mobile/` — `@omnione/vibex` CLI (`serve`, `list/install`, headless control, `plugin`) and native iOS (`mobile/ios`) & Android (`mobile/android`) Companion apps.
- `docs/` — Consolidated documentation (`docs/README.md`), protocol schemas (`docs/protocol/v1/`), specs (`docs/specs/`), and ADRs (`docs/adr/`).

## Build, Test, and Development Commands

- `pnpm install`: install JavaScript workspace dependencies.
- `pnpm run dev`: launch the Tauri desktop app with Vite HMR.
- `pnpm run check`: run frontend `tsc --noEmit` and `cargo check`.
- `pnpm run lint`: run frontend ESLint (`--max-warnings 0`) and `cargo clippy --workspace --all-targets --features qa-mode -- -D warnings`.
- `pnpm run format`: run `cargo fmt --all` and Prettier.
- `pnpm --filter ./frontend test`: run Vitest unit tests.
- `cargo test --workspace`: run all Rust tests.
- `pnpm run generate-types`: refresh `shared/types.ts` after Rust `#[derive(TS)]` changes (`generate-types:check` in CI).
- `pnpm run prepare-db`: refresh `crates/db/.sqlx` offline query metadata (`prepare-db:check` in CI).
- `pnpm run remote-protocol-schema:check`: verify `docs/protocol/v1/` schemas match `crates/remote-protocol`.
- `pnpm run arch:check` & `pnpm run plugin:no-privilege`: verify architectural invariants and zero official-plugin privilege.

## Coding Style & Naming Conventions

Frontend formatting uses Prettier (2 spaces, semicolons, single quotes, ES5 trailing commas, 80-column print width). ESLint enforces no unused imports, exhaustive switches, and file naming: React `.tsx` components are `PascalCase`, hooks start with `use`, and utility/config files are `camelCase`. Rust uses edition 2024 with `rustfmt.toml`. Never hand-edit generated files such as `shared/types.ts` or `docs/protocol/v1/*.json`.

## Testing & Documentation Hygiene

- Place frontend unit tests beside source files (`*.test.ts`, `*.test.tsx`); Vitest runs them in `jsdom`. Rust integration tests live under each crate's `tests/` directory. Prefer targeted runs first, then run relevant full checks before submitting.
- Keep `docs/` evergreen: domain terms go in `CONTEXT.md`, permanent decisions in `docs/adr/`, architecture in `docs/architecture.md`. `docs/plans/` holds active WIP plans only — delete finished plans once merged and never commit QA screenshot dumps or temporary audit logs into `docs/`.

## Commit, PR & Security Guidelines

Use Conventional Commits (`feat:`, `fix(scope):`, `refactor(scope):`, `docs(scope):`, `chore(scope):`). Keep secrets in local `.env` files only; `.dev-ports.json` and `src-tauri/tauri.dev.generated.conf.json` are local runtime artifacts. Mention regenerated `shared/types.ts`, `.sqlx`, or protocol schemas explicitly in PR summaries.
