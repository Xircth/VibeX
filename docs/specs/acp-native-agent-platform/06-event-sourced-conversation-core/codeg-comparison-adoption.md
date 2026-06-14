# Codeg Comparison and Adoption Decision

## Decision

Use VibeX's event-sourced conversation core as the target architecture. Use
Codeg as the runtime hardening reference for ACP connection management, live
session state, prompt serialization, event transport, and renderer coverage.

Do not copy Codeg's completed-history model. In VibeX, Agent transcript files
are import inputs and diagnostics only. They are not the source for
`conversation_detail`.

## Codeg Sources Reviewed

- `C:\Users\Administrator\Documents\Projects\codeg-main\src-tauri\src\db\entities\conversation.rs`
- `C:\Users\Administrator\Documents\Projects\codeg-main\src-tauri\src\commands\conversations.rs`
- `C:\Users\Administrator\Documents\Projects\codeg-main\src-tauri\src\models\conversation.rs`
- `C:\Users\Administrator\Documents\Projects\codeg-main\src-tauri\src\models\message.rs`
- `C:\Users\Administrator\Documents\Projects\codeg-main\src-tauri\src\acp\types.rs`
- `C:\Users\Administrator\Documents\Projects\codeg-main\src-tauri\src\acp\session_state.rs`
- `C:\Users\Administrator\Documents\Projects\codeg-main\src-tauri\src\acp\manager.rs`
- `C:\Users\Administrator\Documents\Projects\codeg-main\src-tauri\src\acp\connection.rs`
- `C:\Users\Administrator\Documents\Projects\codeg-main\src-tauri\src\acp\event_stream.rs`
- `C:\Users\Administrator\Documents\Projects\codeg-main\src\contexts\conversation-runtime-context.tsx`
- `C:\Users\Administrator\Documents\Projects\codeg-main\src\lib\export-conversation.ts`

## What Codeg Does Better

### ACP Event Coverage

Codeg's `AcpEvent` model covers more runtime cases than the current VibeX
implementation. VibeX's normalized `ConversationEvent` contract must include
equivalent coverage for:

- content deltas and thinking deltas;
- tool call creation and incremental updates;
- raw input, raw output, appended raw output, locations, metadata, and images;
- permission request and resolution;
- question request and resolution;
- feedback request and submission;
- plan updates;
- usage updates;
- session modes, config options, prompt capabilities, fork support, and
  available commands;
- session load failure and config-stale notices;
- delegation start/completion;
- connection status and visible errors.

### Live Session State

Codeg keeps a backend-owned live `SessionState` for the active connection. VibeX
should keep the same concept, but treat it as a runtime snapshot over the
durable event log, not as history.

The VibeX runtime snapshot should track:

- `conversation_id`;
- `agent_binding_id`;
- `acp_session_id`;
- active `turn_id`;
- live assistant message;
- active tool calls keyed by tool call id;
- pending permission;
- pending question;
- active delegations;
- session modes/config/options;
- usage;
- event sequence;
- pending user message;
- `turn_in_flight`;
- config-stale state;
- connection/load/recovery status.

### Send Lifecycle

Codeg's prompt path has important protections that must be part of VibeX's
implementation:

- reject empty prompts before side effects;
- use a per-session prompt lock across turn linking, event append, and ACP send;
- prevent two simultaneous prompts from entering the same ACP session;
- use spawn locks keyed by agent, working directory, and session identity;
- apply a handshake timeout for ACP process startup;
- persist or emit the user message before the agent request is sent;
- roll the conversation/turn to a visible failed state if send fails;
- never leave a turn in `running` without a terminal event.

### Session Load/New Policy

Codeg distinguishes session load outcomes well. VibeX should adopt the same
behavioral shape:

- `ResourceNotFound` during `session/load` is a visible recovery failure, not an
  invisible empty transcript fallback.
- Authentication-required results stop the send path with a visible actionable
  state.
- Unsupported `session/load` or `session/resume` degrades to a new ACP session
  only when capabilities say that is the valid path.
- A newly created ACP session must be recorded as a binding event before the
  prompt lifecycle continues.

### Event Transport

Codeg's snapshot plus recent-event replay model is a good live transport
pattern. VibeX should use it as an accelerator:

- attach subscribers using a backend snapshot plus current sequence;
- retain a bounded recent-event ring buffer per active conversation;
- replay recent events by cursor when possible;
- fall back to `conversation_events_since` or `conversation_detail` when the
  cursor is too old, the process restarted, or a gap cannot be filled.

The ring buffer is not durable history. SQLite `conversation_events` remains the
source of truth.

### Frontend Renderer Coverage

Codeg has useful renderer coverage for optimistic turns, tool state, delegation,
questions, feedback, and live messages. VibeX may reuse those view ideas, but
the frontend must render backend-projected `ConversationTimelineRow` values
instead of owning transcript/live folding.

## What VibeX Must Not Copy

- Do not make `external_id + agent_type` the key used to reconstruct product
  conversation history.
- Do not call provider transcript parsers from `conversation_detail`.
- Do not treat Agent transcript files as the completed-turn source of truth.
- Do not make in-memory recent events the only recovery mechanism.
- Do not export only markdown/html/image transcript artifacts as the portable
  backup format.
- Do not keep a frontend context whose primary job is merging parsed history,
  local turns, optimistic turns, and live runtime messages.

## Resulting Implementation Strategy

The updated implementation strategy is hybrid:

1. Build the VibeX-owned event log, projector, and import/export bundle exactly
   as the target architecture.
2. Harden the ACP runtime by adopting Codeg's event coverage, session state,
   prompt locks, spawn locks, session load/new failure policy, and live replay
   buffer.
3. Keep Agent transcript support only behind explicit import/repair commands.
4. Make the backend projection the only data contract used by the conversation
   page.
