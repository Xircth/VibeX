# Design: Legacy Removal And Verification

## Removal Approach

Deletion is part of the replacement, not a cleanup follow-up. Implementation may
temporarily stage files locally, but the completed commit must not include old
live-agent paths.

## Static Gates

Run these searches before finalizing:

```powershell
rg "provider_runtime|ProviderRuntime|sendProviderRuntimeTurn" src-tauri frontend shared crates
rg "AcpBackedExecutor|AcpAgentHarness|executors::acp" crates src-tauri frontend
rg "claude-agent-sdk-provider|opencode-sdk-provider|codex_app_server" .
rg "force_acp_fallback|allow_acp_fallback|ACP_FALLBACK" .
```

Expected result: no live product references. Archived specs may mention old
terms only as historical context.

## Replacement Map

| Old concept | New concept |
| --- | --- |
| ProviderRuntimeContract | AgentRegistryEntry |
| ProviderRuntimeEvent | AgentEvent |
| provider_runtime_send_turn | agent_send_prompt |
| provider_runtime_interrupt | agent_cancel_prompt |
| providerFrontendAdapters | Agent event reducers |
| SDK bridge scripts | ACP registry distribution |
| Codex app-server native-provider | Codex ACP registry entry |
| ExecutionProcess for agent turn | AgentPromptSnapshot |
| MsgStore for agent stream | AgentEvent stream |

## Verification Gates

Minimum final gate:

```powershell
cargo fmt --all
pnpm run generate-types
pnpm run generate-types:check
pnpm run backend:check
pnpm run frontend:check
pnpm run frontend:lint
pnpm run frontend:build
cargo test --workspace
pnpm run check
pnpm run lint
```

Manual smoke gate:

1. Install or detect Codex ACP.
2. Start a live session.
3. Send a prompt.
4. Stop while running.
5. Send another prompt in the same session.
6. Trigger a permission or terminal request if available.
7. Import at least one historical session source.

## Documentation Updates

Remove or rewrite docs that describe native-provider, provider runtime fallback,
SDK bridge execution, or Codex app-server native-provider as current behavior.
Add user-facing docs for Agent plugin registry, install/update, auth/config, MCP,
skills, history import, stop/continue, and queue behavior.

