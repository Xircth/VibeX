# Design: Agent Tauri API And Storage

## Command Boundary

Tauri commands should be thin:

```rust
#[tauri::command]
pub async fn agent_send_prompt(
    state: tauri::State<'_, AppState>,
    input: SendAgentPromptInput,
) -> Result<AgentPromptSnapshot, AppError> {
    state.agent_runtime().send_prompt(input).await.map_err(Into::into)
}
```

Business logic remains in `crates/agents`; app-specific host services are
implemented in `src-tauri`.

## Event Transport

Events are emitted under one namespace:

```text
agent:event
```

The payload is:

```rust
pub struct AgentEventEnvelope {
    pub sequence: i64,
    pub workspace_id: Uuid,
    pub connection_id: AgentConnectionId,
    pub session_id: Option<AgentSessionId>,
    pub event: AgentEvent,
    pub created_at: DateTime<Utc>,
}
```

Sequence numbers are backend-owned so the frontend can ignore duplicates and
detect gaps.

## Persistence Policy

Persist:

- connection lifecycle snapshots;
- session creation/loading;
- prompt start/completion/error/cancel;
- permission request/response;
- terminal lifecycle summaries;
- raw ACP diagnostics when support logging is enabled.

Do not persist every terminal output byte by default. Store bounded summaries and
allow live terminal buffers to remain ephemeral.

## Generated Types

All exported agent DTOs use `ts-rs`. `shared/types.ts` is regenerated through:

```powershell
pnpm run generate-types
pnpm run generate-types:check
```

Provider-runtime types should disappear from `shared/types.ts` unless some
non-agent legacy UI still explicitly needs archived data.

## Migration

Because this is a big-bang replacement, migration code is limited to database
schema changes and explicit history import. There is no transparent conversion
from old `ExecutionProcess` rows into new live agent prompts.

