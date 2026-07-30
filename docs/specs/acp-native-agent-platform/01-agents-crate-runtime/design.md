# Design: `crates/agents` ACP Runtime

## Public API

The crate exposes a small runtime handle:

```rust
pub struct AgentRuntime<H: AgentHost> {
    registry: AgentRegistry,
    connections: AgentConnectionManager<H>,
}

impl<H: AgentHost> AgentRuntime<H> {
    pub async fn connect(&self, input: ConnectAgentInput) -> Result<AgentConnectionSnapshot>;
    pub async fn new_session(&self, input: NewAgentSessionInput) -> Result<AgentSessionSnapshot>;
    pub async fn send_prompt(&self, input: SendAgentPromptInput) -> Result<AgentPromptSnapshot>;
    pub async fn cancel_prompt(&self, input: CancelAgentPromptInput) -> Result<()>;
}
```

`AgentHost` is implemented by Tauri-side code and supplies workspace paths,
terminal spawning, permission persistence, and event emission.

## Connection Model

Each connection has:

- `connection_id`
- `agent_type`
- `workspace_id`
- `working_dir`
- `status`
- command sender
- session map
- prompt lock per ACP session
- config fingerprint
- event sink
- cleanup guard

Connection state is inserted before the async run task starts, and a cleanup
guard removes the map entry on normal exit or panic.

## Event Model

`AgentEvent` is the only live frontend event format:

```rust
pub enum AgentEvent {
    ConnectionStatusChanged(AgentConnectionSnapshot),
    SessionCreated(AgentSessionSnapshot),
    PromptStarted(AgentPromptSnapshot),
    MessageChunk(AgentContentBlock),
    ThoughtChunk(AgentContentBlock),
    ToolCall(AgentToolCall),
    ToolCallUpdate(AgentToolCallUpdate),
    Plan(AgentPlan),
    Usage(AgentUsage),
    PermissionRequested(AgentPermissionRequest),
    TerminalCreated(AgentTerminalSnapshot),
    TerminalOutput(AgentTerminalOutput),
    PromptFinished(AgentPromptFinished),
    Error(AgentErrorEvent),
    RawAcpDiagnostic(serde_json::Value),
}
```

Raw ACP is diagnostic metadata, not the rendering contract.

## Prompt Queue

The runtime serializes prompts per ACP session:

```text
send_prompt
  -> if prompt lane idle: start immediately
  -> else enqueue
  -> on prompt done/error/cancelled: start next queued prompt
```

The frontend may display the queue but does not own queue correctness.

## Request Handling

ACP requests are converted into host bridge calls:

- `RequestPermissionRequest` -> `AgentHost::request_permission`
- `CreateTerminalRequest` -> `AgentHost::create_terminal`
- `TerminalOutputRequest` -> `AgentHost::terminal_output`
- `WaitForTerminalExitRequest` -> `AgentHost::wait_terminal_exit`
- `KillTerminalRequest` -> `AgentHost::kill_terminal`
- `ReadTextFileRequest` -> `AgentHost::read_text_file`
- `WriteTextFileRequest` -> `AgentHost::write_text_file`

Unsupported extension methods return structured ACP errors and emit diagnostics.

## Dependencies

Preferred dependency direction:

```text
src-tauri -> crates/agents -> crates/utils
src-tauri -> crates/db/services/git/workspace infrastructure
crates/agents must not depend on src-tauri
```

The ACP protocol dependency belongs in `crates/agents`, not `crates/executors`.
