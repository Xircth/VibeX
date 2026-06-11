# Tasks: ACP-Native Agent Platform Cutover

- [x] Task: Remove old live-agent ownership from the target architecture.
  - Acceptance: Specs and implementation tasks identify every old live-agent
    entry point to delete or detach.
  - Verify: `rg "provider_runtime|ProviderRuntime|AcpBackedExecutor|claude-agent-sdk-provider|opencode-sdk-provider" crates src-tauri frontend scripts`
  - Files: specs first, then old runtime modules during implementation.

- [x] Task: Add `crates/agents` to the workspace as the only live agent runtime.
  - Acceptance: `Cargo.toml` includes `crates/agents`; Tauri depends on it;
    no product code calls old executor ACP for live sessions.
  - Verify: `pnpm run backend:check`
  - Files: `Cargo.toml`, `crates/agents/**`, `src-tauri/Cargo.toml`.

- [x] Task: Replace Tauri command surface.
  - Acceptance: Frontend live-agent operations call `agent_*` commands only.
  - Verify: `rg "provider_runtime_|sendProviderRuntimeTurn|follow_up\\(" frontend src-tauri`
  - Files: `src-tauri/src/commands/agents/**`, frontend API modules.

- [x] Task: Replace frontend agent workbench.
  - Acceptance: Prompt, stop, continue, queue, permission, terminal, config, MCP,
    and skills UI all consume new agent state.
  - Verify: `pnpm run frontend:check`; `pnpm run frontend:lint`.
  - Files: `frontend/src/features/agents/**`,
    `frontend/src/components/agents/**`, composer and conversation surfaces.

- [x] Task: Delete old runtime modules and generated types.
  - Acceptance: Product build has no provider-runtime, SDK bridge, or old ACP
    executor live path.
  - Verify: `pnpm run generate-types:check`; `pnpm run check`; `pnpm run lint`.
  - Files: old runtime modules, `shared/types.ts`, generated Rust export list.
