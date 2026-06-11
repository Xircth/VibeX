# Tasks: ACP-Native Frontend Agent Workbench

- [x] Task: Add frontend agent API client and event subscription.
  - Acceptance: Frontend can list registry entries, connect, send prompt,
    cancel, respond to permissions, and subscribe to events.
  - Verify: `pnpm run frontend:check`
  - Files: `frontend/src/features/agents/api.ts`, `events.ts`.

- [x] Task: Add agent state store and event reducers.
  - Acceptance: Reducers handle connection, session, prompt, message, tool,
    permission, terminal, usage, done, and error events.
  - Verify: `pnpm --dir frontend exec vitest run src/features/agents`
  - Files: `frontend/src/features/agents/store.ts`, tests.

- [x] Task: Replace composer submit path.
  - Acceptance: Sending and queueing prompts no longer calls old session
    follow-up or provider-runtime APIs.
  - Verify: `rg "sendProviderRuntimeTurn|provider_runtime_send_turn|follow_up" frontend/src`
  - Files: composer hooks and `AgentComposer`.

- [x] Task: Replace transcript rendering.
  - Acceptance: Live agent output renders from `AgentEvent` items; old execution
    log parsing is not used for live agent sessions.
  - Verify: focused component tests and `pnpm run frontend:check`
  - Files: `AgentTranscript`, rendering helpers, tests.

- [x] Task: Add permission and terminal panels.
  - Acceptance: ACP permission choices and terminal output are actionable from
    the new UI.
  - Verify: component tests for permission response and terminal snapshots.
  - Files: `AgentPermissionPanel`, `AgentTerminalPanel`.

- [x] Task: Replace settings Agent pages.
  - Acceptance: Settings show registry-driven install/preflight/config/MCP/skills
    for all target agents.
  - Verify: `pnpm --dir frontend exec vitest run src/pages/settings`
  - Files: settings pages and agent registry components.
