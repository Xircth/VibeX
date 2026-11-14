# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and other coding agents when working in this repository.

VibeX is an all-in-one **Agent-Native Development Platform & Vibe Coding Toolkit** powered by a Single-Seam Rust Host (`vibex` Tauri v2 desktop app + `vibex-server` headless daemon). It orchestrates **20+ built-in coding agents** (**dedicated native Agent engine adapters first**, with **ACP + Official ACP Registry as secondary compatibility fallback**) across a **Dual-Stage Workbench** (Dockview IDE ↔ 24-window Infinite Spatial Canvas), Git-worktree-isolated workspaces, Collaboration Space, `&Agent` delegation, versioned DAG Workflows, full-trust v4 plugins, WebUI, E2EE WebRTC remote workstations, native iOS/Android companions, and 6 IM channels.

## Required task bootstrap

Before every task, read and apply [`maiden-skill`](.agents/skills/maiden-skill/SKILL.md) for complete, root-cause-driven, non-bloated engineering and concise UI copy. Then follow the bootstrap steps in [`AGENTS.md`](AGENTS.md) (including [`CONTEXT.md`](CONTEXT.md), [`docs/architecture.md`](docs/architecture.md), and relevant [`docs/adr/`](docs/adr/) records).

## Commands

Run from the repo root unless noted (`pnpm` workspace + `cargo` workspace; Rust toolchain pinned in `rust-toolchain.toml`):

```bash
pnpm install                 # install JS workspace deps
pnpm run dev                 # launch the Tauri desktop app with Vite HMR (== dev:desktop)
pnpm run check               # frontend tsc --noEmit + cargo check (fast pre-flight)
pnpm run lint                # eslint (max-warnings 0) + clippy -D warnings (--features qa-mode)
pnpm run format              # cargo fmt --all + prettier
```

Frontend (`frontend/`, or via `pnpm --filter ./frontend <script>`):

```bash
pnpm --filter ./frontend test                                                                    # vitest run (all)
pnpm --dir frontend exec vitest run src/components/NormalizedConversation/messageTurnTool.test.ts # single file
pnpm --dir frontend exec vitest run -t "renders tool card"                                       # by test name
pnpm --filter ./frontend run check                                                               # tsc --noEmit
pnpm --filter ./frontend run lint                                                                # eslint
```

Backend (`cargo` workspace):

```bash
cargo test --workspace                       # all Rust tests
cargo test -p agents                         # single crate
cargo test -p agents acp_session_resume      # single test by name filter
cargo check                                  # == pnpm run backend:check
cargo clippy --workspace --all-targets --features qa-mode -- -D warnings
```

Code-generation, protocol & architecture gates (CI enforces these):

```bash
pnpm run generate-types                 # regenerate shared/types.ts from Rust #[derive(TS)]
pnpm run generate-types:check           # CI check — fails if shared/types.ts is stale
pnpm run prepare-db                     # regenerate crates/db/.sqlx offline query cache
pnpm run prepare-db:check               # CI check — fails if .sqlx is stale
pnpm run remote-protocol-schema:check   # verify docs/protocol/v1/ matches crates/remote-protocol
pnpm run arch:check                     # verify architectural invariants
pnpm run plugin:no-privilege            # verify official plugins use zero private Host APIs
```

Install supporting cargo tools once: `cargo install sqlx-cli --no-default-features --features sqlite` (required by `prepare-db`), optionally `cargo install cargo-watch`.

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full diagram and 26-crate map. Key boundaries:

### 1. Single-Seam Host & Frontend `BackendTransport`

- **Single-Seam Host ([ADR-0078](docs/adr/0078-host-command-registry-single-seam.md))**: Product commands are registered once in `HostCommandRegistry` (`crates/application`, mirrored in `shared/hostCommands.ts`), and push streams flow through `HostEventBus`. Both the Tauri desktop binary (`src-tauri`) and the headless HTTP/WS binary (`crates/server` → `vibex-server`) are thin adapters over `HostRuntime` and the `Deployment` trait (`crates/deployment`, implemented by `crates/local-deployment`).
- **Transport-agnostic Frontend (`frontend/src/lib/transport/`)**: UI code talks to `BackendTransport` (`TauriTransport` on local desktop, `WebTransport` on browser WebUI `:17891`, `RemoteDesktopTransport` over HTTPS/WS or E2EE WebRTC DataChannels for paired remote Hosts) — never hardcode Tauri-only calls for shared product features. Path aliases: `@` → `frontend/src`, `shared` → `shared/`.

### 2. Agent Subsystems — Dedicated Agent Engine First, ACP Fallback

> **Standing rule ([ADR-0087](docs/adr/0087-dedicated-agent-engine-first-acp-fallback.md)): Dedicated Agent engine adaptation is primary; ACP is the secondary compatibility fallback.** Route all agent, conversation, and session work through `crates/agents` (`AgentRuntime`) + `crates/conversations`. Never reintroduce coding-agent execution into `crates/executors`.

- **Priority order in `crates/agents`**:
  1. **Dedicated Agent Engine Adapters (Primary)**: Core and deep-integration Coding Agents bind directly to their official SDKs, native protocols (e.g., `app-server` JSON-RPC), and native config/session authorities to preserve full first-party control-plane capabilities (accurate token & Prompt Cache TTL accounting, rate-limit reset recovery, native steering, coordinated session/git rewind, subagent streams, and native auth/status). Native/dedicated state and management capabilities take precedence over generic ACP advertisements.
  2. **ACP Compatibility Pipeline (Secondary)**: Agents without a dedicated engine driver—including remaining built-in profiles, Official ACP Registry entries, and user-declared distributions—connect via the shared ACP v1/v2 adapter pipeline.
  3. **Unified Surface**: Both tiers project into the same `crates/conversations` Turn control plane and render exclusively through `AgentTimelineConversation`.
- **`crates/executors`** — **Does not run coding agents** (`ExecutorActionType` only has `ScriptRequest`). Retains three live responsibilities: (1) workspace setup/cleanup/dev-server shell scripts, (2) `BaseCodingAgent` / `ExecutorConfig` profile identity schemas, and (3) shared `NormalizedEntry` log structures.

### 3. Event-Sourced Conversations & Transcript Authority

- User-visible history is anchored in append-only JSONL or native vendor session files ([ADR-0082](docs/adr/0082-jsonl-transcript-window.md)).
- `crates/conversations` and `src-tauri/src/conversation_service.rs` drive Turn control (`Completed | Failed | Cancelled | Interrupted`), revisioned drafts, queued/delayed inputs, in-flight **Turn Steering**, and monotonic `TimelineRow` (`row_id` + `revision`) projections in `crates/db`.

### 4. Multi-Agent Orchestration & Plugin Platform v4

- **Collaboration Space & `&Agent` Delegation**: `crates/delegation` + `crates/delegation-proto` + `crates/vibex-mcp` implement built-in Collaboration Space (persistent Bot identities in `collaboration_members` owning hidden `direct:<member_id>` and per-group seat conversations) and LLM-mediated `delegate_to_agent` / `create_conversation`.
- **Workflows & Automations**: `crates/workflows` + `crates/vibex-workflow-mcp` run immutable published DAG definitions with checkpoints, pause/resume, and step debugging; `crates/automation` runs lease-owned scheduled/manual triggers in isolated Git worktrees.
- **Plugin Platform v4 ([ADR-0069](docs/adr/0069-everything-is-a-plugin-platform.md))**: `crates/plugins` + `crates/tool-runtime` + `crates/artifacts` + `packages/*` host full-trust v4 packages (`plugins/*`) across 23 contribution kinds with atomic Activation Generations and zero official-plugin privilege.

## Cross-cutting rules & gotchas

- **`shared/types.ts` is generated, never hand-edited.** Produced by [`generate_types.rs`](src-tauri/src/bin/generate_types.rs), which merges `replacement_declarations()` and drops `removed_declarations()`. Add `insert_declaration::<T>()` there, then run `pnpm run generate-types`.
- **SQLx is offline.** Any change to `sqlx::query!` / `query_as!` or migrations requires `pnpm run prepare-db` to refresh `crates/db/.sqlx`.
- **`qa-mode` feature** enables `QaMock` and is required for clippy (`pnpm run lint` passes `--features qa-mode`).
- **TLS:** `install_rustls_crypto_provider` runs once at process startup (`reqwest` is built in no-provider mode) — never construct TLS clients before startup initialization.
- **Dev ports** are allocated dynamically into `.dev-ports.json`; `scripts/run-tauri-dev-desktop.js` writes `src-tauri/tauri.dev.generated.conf.json` per run (Windows-aware).

## Frontend design system

[`DESIGN.md`](DESIGN.md) is the **single source of truth** for visual design (macOS Tahoe Liquid-Glass chrome over opaque content surfaces, tokenized colors, accessibility fallbacks). [`frontend/CLAUDE.md`](frontend/CLAUDE.md) covers CSS implementation: routes wrap in `LegacyDesignScope`, tokens live in `frontend/src/styles/legacy/index.css`, and Tailwind uses `frontend/tailwind.legacy.config.js`. Always use design tokens (`--surface-*`, `--text-*`, `.settings-surface`) rather than ad-hoc hex palettes.

## Local tracker & domain docs

- **Issue tracker**: Local Markdown files under `.scratch/` using state labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) and [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).
- **Domain & Architecture**: Root [`CONTEXT.md`](CONTEXT.md) (Ubiquitous Language), [`docs/architecture.md`](docs/architecture.md) (system map), and [`docs/adr/`](docs/adr/) (ADRs).
