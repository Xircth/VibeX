# Phase 4 Review: ACP Runtime Integration

## Scope Reviewed

- `src-tauri/src/conversation_service.rs`
- `src-tauri/src/commands/conversations.rs`
- `src-tauri/src/commands/agents.rs`
- `src-tauri/src/events.rs`
- `crates/agents/src/events.rs`
- `crates/agents/src/runtime.rs`
- `crates/agents/src/manager.rs`

## Result

Phase 4 is functionally complete for the send/no-response path and checkpoint
file-change path.

Implemented:

- `ConversationSessionService` owns start-turn, active runtime state,
  permission response, cancel, and close behavior.
- Public workspace send moved to `conversation_start_turn`.
- The old `agent_send_workspace_prompt` command and frontend wrapper were
  removed.
- Local conversation ids and external ACP session ids are kept distinct.
- Initialize/session capability snapshots are persisted to bindings.
- ACP notifications and host requests are mapped into normalized
  `ConversationEvent` values.
- Failed sends map to visible terminal events such as `TurnFailed`,
  `TurnCancelled`, `TurnBlocked`, or recovery notices.
- Terminal turn events trigger checkpoint diff finalization, producing
  authoritative `FileChangeSummaryUpdated` events from before/after workspace
  snapshots.

## Verification Performed

```powershell
cargo check -p vibex
cargo test -p vibex conversation_start_turn_maps_agent_blocks_to_input_blocks
cargo test -p agents acp_session_identity
cargo test -p agents capability_snapshot
cargo test -p agents acp_notification_mapping
cargo test -p agents acp_host_request_mapping
cargo test -p vibex failed_prompt_emits_terminal_event
cargo test -p vibex conversation_checkpoint_file_changes
rg -n "agent_send_workspace_prompt|sendWorkspacePrompt|AgentSendWorkspacePromptRequest" src-tauri frontend/src crates
rg -n "conversation_start_turn|TurnFailed|FileChangeSummaryUpdated|turn_in_flight|AgentBindingLoadFailed" src-tauri crates
```

All executed checks passed. The legacy workspace send path no longer appears in
product code.

## Known Risk

No Phase 4 blocking risk remains.
