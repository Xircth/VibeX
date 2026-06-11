# Spec: `crates/agents` ACP Runtime

## Objective

Create `crates/agents`, the sole backend runtime for live coding agents. It
provides a Codeg-style ACP connection manager and exposes a product-facing Rust
API for Tauri commands.

## Acceptance Criteria

1. WHEN an agent is launched THEN `crates/agents` SHALL build the command from
   registry metadata and connect to it as an ACP client over stdio.
2. WHEN ACP initialize succeeds THEN runtime state SHALL record capabilities,
   auth methods where available, session capabilities, and connection status.
3. WHEN a session is created or loaded THEN the runtime SHALL store ACP session
   state keyed by VibeX workspace and agent connection identifiers.
4. WHEN prompts are sent concurrently to one session THEN a prompt lock or queue
   SHALL serialize them without relying on frontend-only state.
5. WHEN cancellation is requested THEN the runtime SHALL send ACP cancellation
   and mark the active prompt as cancelling until terminal completion/error.
6. WHEN the agent sends notifications THEN the runtime SHALL emit typed
   `AgentEvent` values for frontend consumption.
7. WHEN the agent sends requests THEN the runtime SHALL handle permission,
   terminal, file read/write, and extension requests through explicit host
   bridges.
8. WHEN a connection exits or panics THEN cleanup SHALL remove stale connection
   entries.

## Runtime Modules

- `lib.rs`: public crate API.
- `registry.rs`: shared agent type and metadata references.
- `distribution.rs`: Npx, Binary, Uvx, System command launch specs.
- `connection.rs`: connection manager, command channel, prompt lock, cleanup.
- `session.rs`: ACP session lifecycle and queue state.
- `events.rs`: frontend-safe event DTOs.
- `permissions.rs`: permission request/response state.
- `terminal.rs`: ACP terminal session bridge.
- `filesystem.rs`: file read/write request bridge.
- `host.rs`: trait boundary to VibeX workspace, file, terminal, and settings
  services.
- `error.rs`: structured runtime errors.

## Code Style

Runtime state transitions should be explicit:

```rust
pub enum AgentPromptStatus {
    Queued,
    Running,
    Cancelling,
    Completed { stop_reason: Option<String> },
    Failed { message: String },
}

pub struct AgentSessionState {
    pub session_id: AgentSessionId,
    pub acp_session_id: String,
    pub active_prompt: Option<AgentPromptId>,
    pub queue: VecDeque<AgentPromptId>,
}
```

Avoid JSON-shaped state unless the ACP schema itself requires raw passthrough.

## Boundaries

- Always: keep ACP protocol details in `crates/agents`.
- Always: return typed errors with agent id, connection id, and session id where
  available.
- Always: keep raw ACP payloads available for diagnostics.
- Never: depend on `executors::SpawnedChild`, `MsgStore`, provider runtime
  events, or frontend heuristics.
- Never: launch provider-specific native runtimes outside ACP.

## Testing Strategy

- Fake ACP process tests for initialize/new_session/prompt/cancel.
- Unit tests for queue serialization and cleanup guards.
- Unit tests for request handling without starting real terminals.
- Windows command construction tests for `.cmd` and hidden process behavior.

