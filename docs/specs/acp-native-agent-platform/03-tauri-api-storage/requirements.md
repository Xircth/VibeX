# Spec: Agent Tauri API And Storage

## Objective

Expose the new `crates/agents` runtime to the desktop frontend through a clean
Tauri command and event surface. Replace provider-runtime commands and generated
types with agent-native APIs.

## Acceptance Criteria

1. WHEN the frontend needs live agent state THEN it SHALL subscribe to agent
   events and query agent snapshots through `agent_*` commands.
2. WHEN the backend emits an agent event THEN it SHALL be serializable to shared
   TypeScript types generated from Rust.
3. WHEN connection/session/prompt state changes THEN persistent storage SHALL
   record durable state needed for app restart and diagnostics.
4. WHEN old provider-runtime commands are removed THEN frontend and generated
   type references SHALL also be removed.
5. WHEN database migrations are required THEN SQLx metadata SHALL be prepared and
   checked.

## Command Surface

- `agent_registry_list`
- `agent_install`
- `agent_update`
- `agent_preflight`
- `agent_connect`
- `agent_disconnect`
- `agent_connection_snapshot`
- `agent_new_session`
- `agent_load_session`
- `agent_send_prompt`
- `agent_cancel_prompt`
- `agent_respond_permission`
- `agent_list_permissions`
- `agent_terminal_snapshot`
- `agent_history_sources`
- `agent_history_import`
- `agent_config_read`
- `agent_config_write`
- `agent_mcp_list`
- `agent_mcp_write`
- `agent_skills_list`
- `agent_skills_write`

## Storage Ownership

New tables may include:

- `agent_connections`
- `agent_sessions`
- `agent_prompts`
- `agent_events`
- `agent_permissions`
- `agent_installs`
- `agent_history_imports`
- `agent_config_profiles`

`ExecutionProcess` is not the source of truth for live agent prompts.

## Boundaries

- Always: generate shared types from Rust.
- Always: emit state snapshots after command mutations.
- Always: keep raw ACP diagnostics available for support.
- Never: persist only UI-rendered markdown as the canonical event.
- Never: reuse provider-runtime DTOs under new names.
- Never: keep old `provider_runtime_*` commands alive as aliases.

## Testing Strategy

- Tauri command unit tests with fake `AgentRuntime`.
- DB migration tests and `prepare-db` checks for schema changes.
- Type generation checks after every exported DTO change.
- Event serialization tests for representative ACP events.

