# Plan: ACP-only agent scheduling — verified status & actions

## Verified finding (supersedes the spec's initial assumption)

Two parallel investigation passes (5-facet understand + 4-group keep/remove classification) **plus first-hand verification of the load-bearing facts** establish:

1. **Agent scheduling is already 100% ACP.** Every coding-agent turn (task start `tasks.rs::create_task_and_start`, conversation turn / retry `conversation_service.rs::start_turn`, delegation, PR import) runs through `crates/agents` `AgentRuntime.ensure_session` + `send_prompt`. There is **no** code that spawns a `CodingAgent`/`BaseCodingAgent` CLI. `ExecutorActionType` has only `ScriptRequest` — an agent `ExecutorAction` cannot even be constructed. `ExecutionProcessRunReason::CodingAgent` is a historical-row marker; no new rows use it.

2. **The classifier agents were WRONG about the biggest "removable" item.** They flagged `CodingAgent` + `claude.rs`/`codex.rs`/`opencode.rs` as dead and "low risk to delete." Direct reading of `crates/executors/src/profile.rs` disproves this:
   - `ExecutorProfile.configurations: HashMap<String, CodingAgent>` (profile.rs:217)
   - `ExecutorConfigs::from_defaults()` deserializes `default_profiles.json` **into** `CodingAgent` values (profile.rs:504-509)
   - `validate_merged()` calls `BaseCodingAgent::from(&CodingAgent)` (profile.rs:485)
   - These drive the **config UI** (`UserSystemInfo.profiles`), the profile **override/merge/save** system, and the ACP path's model/variant/reasoning overrides.
   → `CodingAgent` and the per-agent config structs are **live config schema, not dead code.** Deleting them would break `default_profiles.json` parsing, the config UI, config-version migrations (v6–v9), scratch persistence, and `shared/types.ts`. **Do not remove.**

3. **`crates/executors` today = three non-agent concerns**, all live:
   - **Script execution** — `ScriptRequest`/`ExecutorAction`/`Executable`/`env`/`approvals` → spawned by `local-deployment` for setup/cleanup/archive/dev-server. Shell, not agents. KEEP.
   - **Executor config schema** — `BaseCodingAgent`, `ExecutorProfileId`, `ExecutorConfig(s)`, `CodingAgent` + per-agent structs, `model_selector::PermissionPolicy`, `command::CommandBuilder` (also used by the editor). KEEP.
   - **Log normalization** — `NormalizedEntry`/`NormalizedEntryType`/`ToolStatus`/`ActionType`/`ConversationPatch` reused by ACP event projection + `services` (approvals/diff_stream). KEEP.

## Decision

The migration **goal is already met**. There is **no dead CLI-agent run code left to retire** — it was removed in prior work. The only verified, safe, non-breaking dead-code removal is:

- **`crates/executors/src/stdout_dup.rs`** — referenced only by its own `pub mod` line; zero users anywhere. **Removed** (file + `lib.rs` declaration); `cargo check -p executors` green.

Everything else the classifiers proposed (per-agent config structs, `CodingAgent`, `qa-mode`/`QaMock`, `command.rs`) is **live or high-blast-radius** and is intentionally **left in place** — removing it is out of scope ("agent scheduling", not "config/feature flags") and would break the build/config/lint.

`latest_executor_profile_for_session()` is **kept** — it has a real caller (`pull_requests.rs:266`) and safely returns `Ok(None)`.

## Remaining actions (documentation + verification only)

1. **CLAUDE.md** — correct the `crates/executors` description: it no longer runs agents; it retains script execution + executor config schema + log normalization. Keep the standing "ACP-only for agents" rule.
2. **spec.md** — mark status COMPLETE; record that success criterion #1 ("no coding-agent spawning code") was already satisfied and is re-confirmed.
3. **Structural guard already exists** — `ExecutorActionType { ScriptRequest }` makes an agent `ExecutorAction` unconstructable; no new guard needed.

## Verification

`cargo check --workspace`, `cargo test --workspace`, `cargo clippy --workspace --all-targets --features qa-mode -- -D warnings`, `pnpm run generate-types:check`. Manual smoke unchanged (agent flows already ACP; only a dead module was deleted).
