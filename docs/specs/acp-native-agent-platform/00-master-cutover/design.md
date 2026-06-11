# ACP-Native Agent Platform Cutover Design

## Architecture

The new architecture has one live agent runtime:

```text
Frontend Agent Workbench
  -> Tauri agent_* commands/events
  -> crates/agents
     -> registry/install/config/history
     -> ACP connection manager
     -> ACP session state
     -> ACP request handlers
     -> workspace/git/file/terminal services through explicit host bridges
  -> ACP agent process
```

The old architecture is removed from the live path:

```text
Frontend provider runtime adapters      removed
provider_runtime_* commands             removed
Claude/OpenCode SDK bridge scripts      removed
Codex app-server native-provider        removed
ACP-backed StandardCodingAgentExecutor  removed
ExecutionProcess as agent source        removed
MsgStore as agent event source          removed
```

## Big-Bang Rule

The cutover branch may be large and temporarily red while implementation is in
progress. The completed change must not expose two agent stacks. The product
must compile with the new stack only.

This means implementation tasks can be ordered internally, but the final merge
unit is a single architectural replacement. There is no production state where
both old and new agent systems are first-class.

## System Ownership

`crates/agents` owns:

- supported agent registry;
- install/update/preflight metadata;
- ACP process launch;
- ACP initialize/new/load/fork/prompt/cancel;
- active connection state;
- prompt lock and queue state;
- event normalization only to the ACP-native frontend DTO;
- permission responses;
- terminal and filesystem request handling;
- history import adapters.

VibeX app infrastructure still owns:

- workspace records and selected workspace paths;
- Git operations and worktree management;
- file tree browsing;
- preview proxy;
- global settings shell;
- ordinary non-agent terminal panels.

## Rejected Designs

- Keep provider runtime as a fallback: rejected because it preserves the
  maintenance burden the replacement is intended to remove.
- Keep `executors::acp` and wrap it from `crates/agents`: rejected because it
  keeps `SpawnedChild` and `MsgStore` in the live agent path.
- Preserve old session compatibility through hidden adapters: rejected because
  it makes the new source of truth ambiguous.
- Keep Codex app-server native-provider for advanced Codex features: rejected
  because feature depth is less important than one maintainable ACP-native
  platform.

## Data Flow

```text
User prompt
  -> AgentComposer submits AgentPromptInput
  -> agent_send_prompt
  -> AgentConnectionManager locks session prompt lane
  -> ACP prompt request
  -> ACP session notifications
  -> AgentEventBus emits AgentEvent
  -> frontend AgentSessionStore renders stream
```

Cancellation:

```text
Stop click
  -> agent_cancel_prompt(connection_id, session_id, prompt_id)
  -> ACP cancel notification/request according to protocol support
  -> state becomes Cancelling
  -> terminal event updates or done/error event closes active prompt
```

Permission:

```text
ACP RequestPermissionRequest
  -> AgentPermissionStore
  -> frontend permission UI
  -> agent_respond_permission
  -> ACP response
```

## Testing Strategy

- Unit-test `crates/agents` registry, command building, connection state, queue
  state, and event mapping with fake transports.
- Integration-test Tauri commands against a fake ACP agent process.
- Frontend unit-test stores and renderers with ACP event fixtures.
- E2E smoke-test at least one real ACP agent after the replacement compiles.

