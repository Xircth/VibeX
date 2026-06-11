# Design: ACP-Native Frontend Agent Workbench

## State Model

```ts
type AgentWorkbenchState = {
  registry: Record<AgentType, AgentRegistryEntry>;
  connections: Record<AgentConnectionId, AgentConnectionSnapshot>;
  sessions: Record<AgentSessionId, AgentSessionState>;
  permissions: Record<AgentPermissionId, AgentPermissionRequest>;
  terminals: Record<AgentTerminalId, AgentTerminalSnapshot>;
  importedHistory: Record<string, ImportedAgentSession>;
};
```

The store is event-sourced from backend snapshots and `agent:event`. It does not
consume old conversation history or execution process streams.

## Composer

The composer submits structured prompt input:

```ts
type AgentComposerSubmit = {
  workspaceId: string;
  connectionId: string;
  sessionId?: string;
  text: string;
  attachments: AgentAttachment[];
  mode?: string;
  model?: string;
};
```

Existing rich input capabilities may be reused, but the submit target and queue
state are replaced.

## Transcript Rendering

Transcript items map directly from ACP-native events:

- user prompt;
- assistant message chunks;
- thoughts;
- tool calls and updates;
- plans;
- usage;
- permission requests;
- terminal references;
- completion/error/cancelled markers.

Folding and grouping are allowed, but they operate on `AgentEvent` kinds, not
paragraph-shape heuristics or provider-specific raw JSON.

## Settings

Agent settings become registry-driven:

```text
AgentRegistrySettings
  -> agent_registry_list
  -> install/update/preflight actions
  -> config/auth status
  -> MCP strategy panel
  -> Skills strategy panel
```

Per-agent panels can exist, but they must be generated from registry metadata and
strategy types where possible.

## History UI

Imported history is read-only by default. A user may create a new live session
from imported context only through an explicit action that calls the new runtime.

## Styling

Use existing VibeX product tokens. Avoid hero/card marketing patterns. Use dense
panels, tabs, segmented controls, icon buttons, and status labels.

