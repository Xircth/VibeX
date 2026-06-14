# Spec: ACP Event-Sourced Conversation Core

## Assumptions

1. VibeX conversation history must be independent from each Agent's own transcript
   files. Agent transcript files are import or repair inputs, not the product
   rendering source of truth.
2. This is a breaking refactor. The implementation does not need to preserve the
   current transcript-reparse path, the current frontend live-message bridge, or
   compatibility adapters for old provider runtimes.
3. ACP remains the only live coding-agent protocol. Non-ACP provider bridges,
   `ExecutionProcess` conversation logs, and provider-specific frontend
   transcript adapters stay outside the new live path.
4. The current `sessions.id` may be reused as the VibeX conversation id during
   implementation, but its meaning must change: it identifies a VibeX-owned
   conversation, not an Agent transcript row. A new `conversations` table is also
   acceptable if the implementation chooses a clean rename.
5. SQLite remains the local persistence engine. All exported Tauri DTOs continue
   to be generated through `ts-rs` into `shared/types.ts`.
6. Current dirty WIP code is not a constraint for this spec. The target design is
   allowed to delete and replace those paths directly.

## Objective

Build a canonical, event-sourced conversation core for ACP Agent sessions.

The goal is to make every conversation observable, recoverable, exportable, and
renderable from VibeX-owned data:

- sending a message always creates a local turn record before the ACP call;
- every ACP `session/update`, host request, permission response, error, and
  terminal state is persisted as a conversation event;
- the frontend renders a backend-projected timeline from that event log;
- missed realtime events, app refresh, Agent transcript parser failure, or Agent
  process restart cannot produce an empty conversation;
- file changes, process folding, tool calls, usage, and errors are derived from
  the same conversation facts.

## Protocol References

- ACP overview and JSON-RPC flow:
  <https://agentclientprotocol.com/protocol/v1/overview>
- ACP session setup, `session/new`, `session/load`, `session/resume`, and
  `session/close`: <https://agentclientprotocol.com/protocol/v1/session-setup>
- ACP prompt turns and `session/update` streaming:
  <https://agentclientprotocol.com/protocol/v1/prompt-turn>
- ACP tool calls and realtime updates:
  <https://agentclientprotocol.com/protocol/v1/tool-calls>
- ACP session modes and config options:
  <https://agentclientprotocol.com/protocol/v1/session-modes>
- ACP v2 RFDs to keep the internal model forward-compatible:
  <https://agentclientprotocol.com/rfds/v2/tool-call-updates> and
  <https://agentclientprotocol.com/rfds/message-id>

## Local Implementation Reference

Codeg remains the implementation reference for ACP runtime hardening, not for
conversation history ownership. The comparison decision is documented in
`codeg-comparison-adoption.md`.

Adopt from Codeg:

- ACP event coverage for tool updates, questions, feedback, delegation,
  capabilities, config-stale state, session load failure, and visible errors;
- backend-owned live session state for the active connection;
- per-session prompt locks, spawn locks, handshake timeout, and in-flight turn
  protection;
- snapshot plus recent-event replay for realtime transport;
- renderer coverage for tool, plan, permission, question, feedback, delegation,
  usage, and error states.

Reject from Codeg:

- Agent transcript files as completed-history truth;
- `external_id + agent_type` as the product history key;
- frontend transcript/live merge as the main conversation model;
- markdown/html/image transcript export as the portable backup format.

## Tech Stack

- Backend: Rust 2024, Tauri 2, Tokio, sqlx SQLite, `ts-rs`, `serde`.
- Agent runtime: `crates/agents` owns ACP process, connection, session, prompt,
  permission, terminal, and raw protocol translation.
- Storage: `crates/db` owns schema, query models, event append, and projections.
- App boundary: `src-tauri` owns Tauri commands, app services, event forwarding,
  workspace/git/checkpoint integration, and export/import IO.
- Frontend: React 18, Vite, TypeScript, Zustand/reducer state where already used,
  `@tanstack/react-query`, `@tanstack/react-virtual`, existing
  `NormalizedConversation` renderer.

## Commands

```powershell
pnpm run dev
pnpm run frontend:check
pnpm run frontend:lint
pnpm run frontend:build
pnpm run backend:check
pnpm run backend:lint
pnpm run prepare-db
pnpm run prepare-db:check
pnpm run generate-types
pnpm run generate-types:check
cargo test -p db
cargo test -p agents
cargo test --workspace
cd frontend; pnpm exec vitest run
```

## Project Structure

```text
crates/agents/
  src/events.rs                 ACP-to-domain event contracts
  src/manager.rs                ACP process and JSON-RPC bridge
  src/runtime.rs                connection/session/prompt runtime facade
  src/conversation.rs           shared conversation DTOs, to be replaced or moved

crates/db/
  migrations/                   canonical conversation schema migrations
  src/models/conversation*.rs    conversation metadata, events, turns, projections
  src/models/agent_runtime.rs    runtime snapshots only after refactor

src-tauri/src/
  commands/agents.rs            send/cancel/permission/runtime commands
  commands/conversations.rs     conversation detail, event paging, import/export
  events.rs                     persistent event sink and Tauri event forwarding

frontend/src/features/agents/
  api.ts                        generated command wrappers
  events.ts                     realtime subscription
  store.ts                      runtime snapshot reducer, narrowed after refactor

frontend/src/features/conversation/
  conversationApi.ts            new conversation event/timeline API wrapper
  conversationStore.ts          canonical frontend timeline cache
  useConversationTimeline.ts    page + realtime reconciliation hook

frontend/src/components/NormalizedConversation/
  MessageTurnView.tsx           render canonical timeline turns
  tools/*                       tool/file/plan/permission/process cards

docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core/
  requirements.md
  design.md
  tasks.md
  codeg-comparison-adoption.md
```

## Code Style

Backend event writes must be explicit and typed. Do not pass loosely-shaped JSON
through the product path unless it is stored as raw diagnostic metadata beside a
typed normalized event.

```rust
pub async fn append_conversation_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    input: AppendConversationEvent<'_>,
) -> Result<ConversationEventRecord, sqlx::Error> {
    let normalized_json = serde_json::to_string(&input.event)?;
    let raw_json = input.raw.map(serde_json::to_string).transpose()?;

    sqlx::query_as::<_, ConversationEventRecord>(
        r#"INSERT INTO conversation_events (
               id, conversation_id, turn_id, sequence, source, event_kind,
               normalized_json, raw_json, created_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, conversation_id, turn_id, sequence, source,
                     event_kind, normalized_json, raw_json, created_at"#,
    )
    .bind(input.id)
    .bind(input.conversation_id)
    .bind(input.turn_id)
    .bind(input.sequence)
    .bind(input.source.as_str())
    .bind(input.event.kind())
    .bind(normalized_json)
    .bind(raw_json)
    .bind(input.created_at)
    .fetch_one(&mut **tx)
    .await
}
```

TypeScript rendering code must consume projected timeline DTOs, not raw ACP
events:

```ts
export function renderConversationRow(row: ConversationTimelineRow) {
  switch (row.kind) {
    case 'message_turn':
      return <MessageTurnView turn={row.turn} />;
    case 'permission_request':
      return <PermissionRequestCard request={row.request} />;
    case 'turn_error':
      return <TurnErrorCard error={row.error} />;
  }
}
```

## Requirements

### R1. Conversation Identity

- The product owns a stable `conversation_id`.
- ACP `session_id` is stored only as an external binding.
- Runtime `connection_id` is ephemeral and must not be required to render
  history.
- Every user send creates a local `turn_id` before calling `session/prompt`.

### R2. Event Persistence

- Every user turn, ACP notification, host request, permission response, terminal
  lifecycle event, error, usage update, mode/config update, file change summary,
  and prompt terminal state is persisted.
- Events have a monotonic per-conversation sequence.
- Raw ACP payloads are retained for diagnostics, but normalized typed events are
  the rendering contract.
- Persisted events are sufficient to rebuild the full conversation timeline
  after restart.

### R3. Turn State Machine

- A turn moves through `pending -> running -> blocked|completed|failed|cancelled`.
- Permission requests make the turn `blocked` without losing the active prompt.
- Prompt response, ACP error, process exit, cancellation, and timeout all create
  visible terminal events.
- Empty UI silence is invalid. A failure must render as a conversation error.

### R4. Backend Projection

- Backend projection folds conversation events into stable timeline rows.
- `conversation_detail` returns metadata plus projected timeline, not re-parsed
  Agent transcript files.
- Event paging and `events_since` APIs allow cold open and realtime gap recovery.
- Projection output includes folded thinking, plan entries, tool call state,
  filesChanged, terminal summaries, usage, and stop reason.

### R5. Frontend Rendering

- Frontend renders backend-projected timeline rows.
- Live Tauri events are only a realtime delivery path; DB projection remains
  authoritative.
- Existing renderer components may be reused, but raw event folding belongs in
  backend projection or a shared typed projector, not page components.
- The UI must support text, image/resource placeholders, reasoning, plans, tool
  calls, tool updates, permissions, terminal output summaries, usage, file
  changes, and errors.

### R6. filesChanged

- `filesChanged` is derived per turn from two sources:
  1. structured ACP tool call update data such as diffs, locations, and raw
     output when available;
  2. git/workspace checkpoint diff before and after the turn as the authoritative
     fallback.
- Retry and rollback use checkpoint identity, not legacy process IDs.

### R7. ACP Capability Support

- Initialize response capabilities are persisted per binding or session.
- UI behavior is capability-gated for text/image/resource blocks,
  `loadSession`, `resume`, `close`, additional directories, MCP servers,
  terminal support, modes, config options, commands, and permissions.
- Unsupported capabilities have explicit disabled or degraded states.

### R8. Import and Export

- VibeX exports a portable conversation bundle containing metadata, bindings,
  turns, events, projections, attachments, checkpoints, and capability snapshots.
- VibeX bundle import restores renderable conversations without requiring any
  Agent transcript file.
- Agent transcript import remains available only as an importer that converts
  external history into VibeX-owned conversations/events.

### R9. Legacy Removal

- Remove product dependency on `parsers::loader` for live conversation detail.
- Remove transcript reparse comments and assumptions from conversation DB models.
- Remove frontend runtime code whose job is to merge parsed transcript history
  with live ACP events.
- Remove or isolate old provider-runtime and `ExecutionProcess` conversation
  paths from the active Agent workbench.

### R10. Observability

- Every send returns either a prompt snapshot or a structured error event that
  the conversation view can render.
- Event persistence failures are surfaced in logs and health diagnostics.
- The app can report event gap, projection failure, lost connection, and ACP
  session recovery state.

### R11. Codeg-Hardened ACP Runtime

- The active ACP connection has a backend-owned runtime snapshot containing the
  active conversation, binding, ACP session, active turn, live assistant message,
  tool calls, pending permission, pending question, delegations, usage,
  capabilities, event sequence, and connection/recovery status.
- The runtime snapshot is an accelerator only. Persisted conversation events are
  authoritative after refresh, restart, import, and export.
- Prompt sending is serialized per active ACP session. Empty prompts are rejected
  before side effects. In-flight prompts are either queued with a local queued
  turn or rejected with a typed UI-visible error; they are never silently sent
  concurrently into the same ACP session.
- ACP process startup uses spawn de-duplication and a handshake timeout.
- `session/load`, `session/resume`, and `session/new` outcomes are explicit
  conversation events. Missing sessions, authentication failures, unsupported
  methods, process exits, closed command channels, and prompt errors all produce
  visible terminal rows.
- Realtime transport uses a snapshot plus bounded recent-event replay buffer,
  then falls back to durable `conversation_events_since` or
  `conversation_detail` for old cursors and process restarts.
- The normalized event contract covers Codeg-equivalent cases for content,
  thinking, tool update, permission, question, feedback, plan, usage, mode,
  config, prompt capability, fork support, command, delegation, config-stale,
  session-load-failed, and error events.

## Testing Strategy

- `crates/db`: schema migration tests, event append tests, projector fixture
  tests, import/export roundtrip tests.
- `crates/agents`: fake ACP fixtures for initialize, session/new,
  session/load fallback, session/prompt, message chunks, tool calls, permission
  requests, terminal requests, cancellation, and process failure.
- `src-tauri`: command-level tests for send, cancel, detail, events_since,
  export/import, and checkpoint file-change summary.
- Frontend: Vitest tests for API mapping, timeline hook reconciliation,
  renderer fixtures for every row/message type, and event gap recovery.
- Manual verification: send text-only prompt, prompt with image, tool-heavy
  prompt, permission-blocked prompt, cancelled prompt, failed Agent process,
  app refresh during streaming, export/import restore.

## Boundaries

- Always:
  - write or update the spec before implementation changes;
  - treat VibeX event log as canonical;
  - append visible error events for every failed send path;
  - regenerate SQLx cache and shared TypeScript types after schema or DTO
    changes;
  - keep ACP raw payloads out of UI rendering contracts.
- Ask first:
  - changing the app-level navigation model beyond conversation routes;
  - adding large new frontend dependencies;
  - changing non-agent workspace, git, file tree, or settings behavior outside
    the conversation requirements;
  - deleting user data migrations instead of providing an explicit destructive
    cutover path.
- Never:
  - reintroduce transcript files as the main conversation detail source;
  - silently swallow ACP send/prompt errors;
  - infer filesChanged only from UI text parsing;
  - make frontend page components own protocol folding;
  - add compatibility adapters back to old provider runtime events.

## Success Criteria

- Creating a new Agent conversation and sending a prompt always renders either
  assistant output or a visible error row.
- Refreshing the app during or after a turn reconstructs the same timeline from
  persisted events.
- Removing or corrupting the external Agent transcript file does not remove the
  VibeX conversation timeline.
- Tool calls update in place by ID and preserve raw diagnostics.
- Process/thinking messages fold correctly and can be expanded.
- `filesChanged` appears for file-modifying turns using checkpoint diff fallback
  even if ACP tool output is unstructured.
- Exporting and re-importing a conversation produces an equivalent renderable
  timeline.
- Capability-gated UI states match the ACP initialize/session responses.
- Missed realtime events can be recovered from either recent replay or durable
  event paging without duplicating timeline rows.
- A stale or missing ACP session creates a visible recovery event instead of an
  empty transcript-like conversation.
- Old transcript-reparse live path is deleted or no longer reachable by the
  Agent workbench.

## Open Questions

No blocking product question remains. The implementation may choose whether to
rename `sessions` to `conversations` immediately or keep the physical table name
temporarily while replacing its model semantics. The acceptance condition is the
same: VibeX event data, not Agent transcript files, must be canonical.
