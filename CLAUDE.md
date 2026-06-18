# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

VibeX is a local-first Tauri desktop app that orchestrates AI coding agents (Claude Code, OpenCode, Codex, and more) across projects, git-worktree-isolated workspaces, sessions, terminals, previews, and diffs. Frontend is React + TypeScript + Vite; backend is a Rust workspace exposed to the webview through Tauri IPC commands.

## Commands

Run from the repo root unless noted. The repo is pnpm-workspace + cargo-workspace; the Rust toolchain is pinned to a nightly in `rust-toolchain.toml`.

```bash
pnpm install                 # install JS deps (also needed before any pnpm script)
pnpm run dev                 # launch the Tauri desktop app with Vite HMR (== dev:desktop)
pnpm run check               # frontend tsc --noEmit + cargo check  (fast pre-flight)
pnpm run lint                # eslint (max-warnings 0) + clippy -D warnings (--features qa-mode)
pnpm run format              # cargo fmt + prettier
```

Frontend (in `frontend/`, or via `pnpm --filter ./frontend <script>`):

```bash
cd frontend
pnpm test                    # vitest run (all)
pnpm exec vitest run src/components/NormalizedConversation/messageTurnTool.test.ts   # single file
pnpm exec vitest run -t "renders tool card"                                          # by test name
pnpm run check               # tsc --noEmit (type-check only)
pnpm run lint                # eslint
```

Backend (cargo workspace):

```bash
cargo test --workspace                       # all Rust tests
cargo test -p agents                         # single crate
cargo test -p agents acp_session_resume      # single test by name filter
cargo check                                  # == pnpm run backend:check
cargo clippy --workspace --all-targets --features qa-mode -- -D warnings
```

Code-generation / DB (must be re-run when their inputs change — CI enforces this):

```bash
pnpm run generate-types          # regenerate shared/types.ts from Rust #[derive(TS)] types
pnpm run generate-types:check    # CI check — fails if shared/types.ts is stale
pnpm run prepare-db              # regenerate crates/db/.sqlx offline query cache (needs cargo sqlx-cli)
pnpm run prepare-db:check        # CI check — fails if .sqlx is stale
```

Install the supporting cargo tools once: `cargo install sqlx-cli --no-default-features --features sqlite` (required by `prepare-db`), optionally `cargo install cargo-watch`.

## Architecture

### Process & layering

Three layers, top to bottom:

1. **Frontend** (`frontend/src`) — React app. Talks to the backend exclusively through Tauri `invoke(...)` commands and event subscriptions; never imports Rust directly. Path aliases: `@` → `frontend/src`, `shared` → `shared/`.
2. **Tauri shell** (`src-tauri/src`) — the desktop binary (`vibex`). [lib.rs](src-tauri/src/lib.rs) registers every IPC command in one giant `invoke_handler!` and holds `AppState` ([state.rs](src-tauri/src/state.rs)). Commands live under [src-tauri/src/commands/](src-tauri/src/commands/) grouped by domain (projects, tasks, workspaces, sessions, conversations, agents, repos, config, …). This layer also owns extra windows (project rail, desktop toast, settings) and the preview proxy.
3. **Rust workspace crates** (`crates/*`) — the actual logic, kept Tauri-agnostic and reusable.

### Dependency injection via the `Deployment` trait

Backend services are accessed through the [`Deployment`](crates/deployment/src/lib.rs) trait — it exposes `db()`, `git()`, `container()`, `project()`, `repo()`, `image()`, `filesystem()`, `events()`, `config()`, `approvals()`, etc. `LocalDeployment` (`crates/local-deployment`) is the concrete impl, wrapped in `AppState.deployment`. When adding backend capabilities, prefer extending a service crate and reaching it through `Deployment` rather than putting logic in command handlers.

### Two distinct agent subsystems (do not conflate them)

- **`crates/executors`** — the legacy CLI-executor path. `BaseCodingAgent` enum (ClaudeCode, Codex, Opencode, Gemini, Openclaw, Cline, Hermes, + `QaMock` behind `qa-mode`) spawns and parses agent CLIs as child processes. Used by the task/execution-process flow.
- **`crates/agents`** — the newer **ACP-native** agent runtime (`AgentRuntime`, `AgentConnectionManager`). It deliberately does **not** depend on the legacy executor / `ExecutionProcess` / `MsgStore` systems. It owns live agent connections, sessions, prompts, permissions, terminals, MCP/skills/config surfaces, and conversation streaming. `AppState.agent_runtime` is the entry point; commands are under `commands::agents`.

`AgentType` (registry) ↔ `BaseCodingAgent` (executor key) bridge via `agent_type_from_executor_key` / `executor_key_for`.

### Event-sourced conversation core

Conversations are event-sourced. [conversation_service.rs](src-tauri/src/conversation_service.rs) drives a turn lifecycle over the ACP runtime; events are appended (`conversation_event`) and folded into projections (`conversation_projection`) in `crates/db`. The frontend renders a timeline from these events (`frontend/src/features/conversation`, `frontend/src/components/NormalizedConversation`). `ConversationRuntimeState` (per-conversation, held in `AppState.conversation_runtime_states`) tracks the in-flight turn, live message, pending permission/question, and event sequence.

### Multi-agent delegation

`crates/delegation` + `crates/delegation-proto` + `crates/vibex-mcp` implement agent-to-agent delegation: a broker/listener/spawner stack plus an MCP server (`vibex-mcp` binary) that agents call to spawn sub-agents. Wired up in `AppState` via `build_delegation(...)` and `src-tauri/src/delegation`.

### Other key crates

- `crates/services` — workspace/worktree management, git host (PR monitoring), file search/ranking, diff streaming, filesystem watching, config, approvals, events. Worktree isolation per workspace is core to the product.
- `crates/git` — git operations split by concern (branch/diff/remote/worktree/conflict/stats ops) over `git2` + a CLI fallback.
- `crates/db` — SQLx + SQLite. Models in `crates/db/src/models/`, migrations in `crates/db/migrations/`. Uses **offline** query verification (`.sqlx`).
- `crates/review` — standalone code-review tooling (own `main.rs`).
- `crates/local-deployment` — process/PTY/container execution backing `LocalDeployment`.

## Cross-cutting rules & gotchas

- **`shared/types.ts` is generated, never hand-edited.** It is produced by [generate_types.rs](src-tauri/src/bin/generate_types.rs), which **merges** rather than overwrites: the generator preserves declarations it doesn't manage, applies a `replacement_declarations()` list of `#[derive(TS)]` types, and drops names in `removed_declarations()` (tombstones). To export a new Rust type to the frontend, add `insert_declaration::<T>()` there, then run `pnpm run generate-types`.
- **SQLx is offline.** Any change to a `sqlx::query!`/`query_as!` macro or a migration requires `pnpm run prepare-db` to refresh `crates/db/.sqlx`, or CI (`prepare-db:check`) fails. `generate-types` itself runs with `SQLX_OFFLINE=true`.
- **`qa-mode` feature** enables the `QaMock` executor and is required for `clippy`/lint to pass (`pnpm run lint` passes `--features qa-mode`).
- **TLS:** the process installs a single rustls crypto provider at startup (`install_rustls_crypto_provider`) because reqwest is built in no-provider mode — don't build TLS clients before it runs.
- **Dev ports** are allocated dynamically and written to `.dev-ports.json`; `run-tauri-dev-desktop.js` generates `src-tauri/tauri.dev.generated.conf.json` per run. Dev scripts under `scripts/` are Windows-aware (this is a Windows-primary dev environment).

## Frontend design system

`DESIGN.md` is the **single source of truth** for frontend visual design (macOS Tahoe target, Liquid-Glass-chrome / opaque-content two-layer model, tokenized colors, accessibility fallbacks). `frontend/CLAUDE.md` covers the concrete CSS architecture: all routes are wrapped in `LegacyDesignScope` (historical name, treat as the active design scope), tokens live in `src/styles/legacy/index.css`, Tailwind config is `tailwind.legacy.config.js`. Use design tokens / shell classes (`--surface-*`, `--text-*`, `.settings-surface`) rather than hard-coded colors or new local palettes.
