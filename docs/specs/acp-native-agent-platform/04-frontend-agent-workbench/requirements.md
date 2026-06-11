# Spec: ACP-Native Frontend Agent Workbench

## Objective

Rebuild frontend agent input, output, settings, permissions, terminal, queue, and
history surfaces around the new ACP-native `agent_*` API.

## Acceptance Criteria

1. WHEN the user selects an agent THEN the UI SHALL use registry metadata, not
   provider-runtime contracts.
2. WHEN the user sends a prompt THEN the composer SHALL call `agent_send_prompt`.
3. WHEN the backend emits `agent:event` THEN the frontend SHALL update the agent
   session store without reading old execution logs.
4. WHEN an agent is running THEN stop, continue, queue, and status controls SHALL
   derive from agent session state.
5. WHEN a permission request is active THEN the UI SHALL show choices and submit
   `agent_respond_permission`.
6. WHEN terminal events occur THEN the UI SHALL display ACP terminal sessions
   using the new terminal snapshots.
7. WHEN settings render Agent configuration THEN they SHALL support all registry
   agents and expose install/config/MCP/skills surfaces.

## Frontend Modules

- `frontend/src/features/agents/api.ts`
- `frontend/src/features/agents/events.ts`
- `frontend/src/features/agents/store.ts`
- `frontend/src/features/agents/registry.ts`
- `frontend/src/features/agents/permissions.ts`
- `frontend/src/features/agents/history.ts`
- `frontend/src/components/agents/AgentWorkbench.tsx`
- `frontend/src/components/agents/AgentComposer.tsx`
- `frontend/src/components/agents/AgentTranscript.tsx`
- `frontend/src/components/agents/AgentPermissionPanel.tsx`
- `frontend/src/components/agents/AgentTerminalPanel.tsx`
- `frontend/src/components/agents/AgentRegistrySettings.tsx`

## UX Principles

- Agent status must be visible: disconnected, connecting, ready, running,
  queued, cancelling, failed.
- Permission requests must be impossible to miss.
- Queue state must show which prompt is running and which prompts are waiting.
- Imported history must be visibly different from live ACP sessions.
- Agent configuration must feel like plugin management, not hard-coded provider
  settings.

## Boundaries

- Always: render from `AgentEvent` and agent snapshots.
- Always: preserve VibeX design tokens and dense workbench UI.
- Always: test store reducers with event fixtures.
- Never: parse provider-runtime raw JSON in React.
- Never: call `sendProviderRuntimeTurn`.
- Never: infer running state from old execution processes.

## Testing Strategy

- Vitest store tests for event reduction.
- Component tests for composer, transcript, queue, permissions, and terminal.
- Regression tests for stop/continue after cancellation.
- Frontend typecheck, lint, and build after route-level changes.

