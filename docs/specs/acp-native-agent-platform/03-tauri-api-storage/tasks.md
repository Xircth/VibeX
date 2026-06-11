# Tasks: Agent Tauri API And Storage

- [ ] Task: Add Tauri agent command module.
  - Acceptance: Commands compile against `crates/agents` and are registered in
    `src-tauri/src/lib.rs`.
  - Verify: `pnpm run backend:check`
  - Files: `src-tauri/src/commands/agents/**`, `src-tauri/src/commands/mod.rs`,
    `src-tauri/src/lib.rs`.

- [ ] Task: Add event envelope and emitter.
  - Acceptance: Backend emits sequenced `agent:event` payloads; tests cover
    ordering and serialization.
  - Verify: `cargo test -p vibex agent_event`
  - Files: Tauri agent command/event modules.

- [ ] Task: Add persistence schema.
  - Acceptance: New tables store sessions, prompts, events, permissions, and
    import records; old `ExecutionProcess` is not referenced by agent runtime.
  - Verify: `pnpm run prepare-db`; `pnpm run prepare-db:check`
  - Files: `crates/db/**`, migrations, SQLx metadata.

- [ ] Task: Generate shared TypeScript types.
  - Acceptance: `shared/types.ts` contains agent DTOs and no live provider
    runtime DTO dependencies.
  - Verify: `pnpm run generate-types`; `pnpm run generate-types:check`
  - Files: Rust DTO definitions, `shared/types.ts`.

- [ ] Task: Remove provider-runtime command exports.
  - Acceptance: Tauri no longer registers `provider_runtime_*` commands.
  - Verify: `rg "provider_runtime_" src-tauri frontend shared`
  - Files: command registration and frontend API modules.

