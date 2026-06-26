# Spec: ACP-only agent scheduling (retire the legacy CLI-executor agent path)

## Objective

Make **ACP the single agent subsystem in code, not just at runtime**, per the CLAUDE.md standing rule.

Investigation (see `understand.md` findings, 2026-06) established that **agent execution is already 100% ACP**: every coding-agent turn (task start, conversation turn, retry, delegation, PR import) runs through `crates/agents` `AgentRuntime`. The legacy CLI-executor agent-run path in `crates/executors` is **dead code** — `ExecutorActionType` has only `ScriptRequest`, nothing constructs/spawns a `CodingAgent`, and `ExecutionProcessRunReason::CodingAgent` is a historical-only marker.

So this is **not a behavioral migration** — it is **structural cleanup**: remove the dead CLI coding-agent executor implementations from `crates/executors`, leaving a crate that does only (a) **script execution** (setup/cleanup/archive/dev-server shell scripts) and (b) **shared types + log normalization** consumed by the ACP path. Scripts are shell commands, NOT agents, and stay where they are (they cannot and should not become ACP).

Success = no coding-agent spawning code remains anywhere outside `crates/agents`; the whole workspace builds/tests/lints green; all agent flows still work end-to-end over ACP.

## Status: COMPLETE (verified) — see `plan.md`

Investigation + first-hand verification confirmed the migration is **already done**: agent scheduling is 100% ACP, and the CLI agent-run code was removed in prior work (`ExecutorActionType` has only `ScriptRequest`). Success criterion #1 was already satisfied. The only verified, safe dead-code removal performed here is `crates/executors/src/stdout_dup.rs` (zero users). The items an automated classifier flagged as "removable" (`CodingAgent` + per-agent config structs, `qa-mode`, `command.rs`) were verified to be **live config/log/script infrastructure** (e.g. `ExecutorProfile.configurations: HashMap<String, CodingAgent>` is deserialized from `default_profiles.json` and drives the config UI) and are intentionally kept — deleting them would break the config system, not advance the ACP goal. CLAUDE.md now describes `crates/executors`'s actual (non-agent) role accurately.

## Tech Stack

Rust workspace (nightly per `rust-toolchain.toml`) + Tauri + React/TS. Relevant crates: `crates/executors` (target of cleanup), `crates/agents` (ACP runtime, canonical), `crates/services`, `crates/local-deployment`, `crates/db`, `src-tauri`. SQLx offline (`.sqlx`); TS types generated from `#[derive(TS)]`.

## Commands

```bash
cargo check --workspace
cargo test --workspace
cargo clippy --workspace --all-targets --features qa-mode -- -D warnings
pnpm run check                  # tsc + cargo check
pnpm run generate-types:check   # shared/types.ts not stale
pnpm run prepare-db:check       # .sqlx not stale (only if a query!/migration changes)
cd frontend && pnpm exec vitest run
```

## Project Structure (touch map)

```
crates/executors/src/executors/{claude,codex,opencode,qa_mock,utils}.rs  → per-agent CLI executors (dead agent-run code — REMOVE the agent-spawn parts)
crates/executors/src/executors/mod.rs                                     → CodingAgent trait + dispatch (REMOVE agent-run; keep ExecutorError, CancellationToken, SpawnedChild used by scripts)
crates/executors/src/{command,model_selector,stdout_dup}.rs               → agent-CLI command building / model picking (REMOVE if only agent-run used them)
crates/executors/src/{actions,actions/script}.rs                          → script execution (KEEP)
crates/executors/src/{profile}.rs                                         → BaseCodingAgent / ExecutorProfileId / ExecutorConfigs (KEEP — shared config/types)
crates/executors/src/logs/**                                              → NormalizedEntry / ConversationPatch (KEEP — ACP projections reuse them)
crates/executors/src/{env,approvals}.rs                                   → script env + script approvals (KEEP what scripts use)
crates/db/src/models/execution_process.rs                                 → run_reason=CodingAgent historical marker (KEEP variant for old rows; remove dead stub fns if unused)
CLAUDE.md                                                                  → update executors description to "scripts + shared types only"
```

## Code Style

Match existing crate conventions (terse doc-comments explaining *why*; runtime `sqlx::query(...)` not macros where the crate already does so). Example — a kept, narrowed module header:

```rust
//! Script execution + shared executor types/logs. Coding agents run through the
//! ACP-native `crates/agents` runtime; this crate no longer spawns agent CLIs.
```

## Testing Strategy

Per-step compiler/lint gate: after each removal run `cargo check -p executors` then `cargo check --workspace`. Keep/clean unit tests that target kept code (scripts, profile, logs); delete tests that only covered removed agent-run code. Full gate before "done": the Commands block above, plus a manual smoke (start a task / send a conversation turn / retry) confirming ACP still drives agents.

## Boundaries

- **Always:** verify with `cargo check --workspace` + `cargo clippy ... --features qa-mode -D warnings` after each task; preserve script execution and the ACP path; keep `BaseCodingAgent`/`ExecutorProfileId`/`ExecutorConfigs`/`NormalizedEntry`/`ConversationPatch` (shared); keep `ExecutionProcessRunReason::CodingAgent` enum variant (historical-row deserialization); update CLAUDE.md when the crate's role changes.
- **Ask first:** (autonomous run — no human gate) but treat as high-caution: removing a public type that crosses a crate boundary, any DB migration, splitting `executors` into new crates.
- **Never:** break setup/cleanup/archive/dev-server script execution; remove a type still referenced by kept code; delete a failing test to make the build pass; change generated `shared/types.ts` by hand.

## Success Criteria

1. `crates/executors` contains **no coding-agent spawning/run code** (no `CodingAgent` trait impls, no per-agent CLI launch, no agent-CLI stdout parsers used only for agent runs). `rg "CodingAgent"` over the crate returns only `BaseCodingAgent` (the shared enum) — no agent-execution trait.
2. Script execution, `BaseCodingAgent`/`ExecutorProfileId`/`ExecutorConfigs`, and `NormalizedEntry`/`ConversationPatch` remain and are unchanged in behavior.
3. Green: `cargo check --workspace`, `cargo test --workspace`, `cargo clippy --workspace --all-targets --features qa-mode -- -D warnings`, `pnpm run check`, `pnpm run generate-types:check`, frontend `vitest run`.
4. Manual smoke: create-task-and-start, a conversation follow-up turn, and reset-to-here retry all still run agents via ACP.
5. CLAUDE.md's agent-subsystems section reflects the narrowed `crates/executors` role.

## Open Questions (resolved during PLAN by reading the crate)

- Does `qa_mock` / the `qa-mode` feature still serve a purpose once the `CodingAgent` trait is gone (it gates clippy/lint today)? → classify in PLAN; remove only if fully dead, else keep the minimal gate.
- Do `claude.rs/codex.rs/opencode.rs` also hold **kept** config/default data (`ExecutorConfigs` variants/models surfaced by the config UI) mixed with dead run-code? → if so, preserve the config data, remove only the run-code.
- Should shared types/logs eventually move to their own crate to fully decouple from `executors`? → **out of scope** here (defer); this spec only removes dead agent-run code.
