# Deletion Map: Event-Sourced Conversation Core

This map lists the old product paths that must disappear from the live Agent
workbench or become explicit import/debug-only paths during Phase 06.

## Live Transcript Detail Loading

Target state: `conversation_detail` reads VibeX conversation tables and backend
projection only.

Delete or isolate:

- backend calls that load Agent transcript/session files for product
  conversation detail;
- direct use of `parsers::loader` from Tauri conversation commands;
- assumptions that `external_session_id`, provider transcript id, or ACP
  `session_id` can rebuild product history;
- comments in DB models that describe transcript reparse as normal history
  loading.

Allowed replacement:

- explicit Agent transcript import command that converts external history into
  synthetic `ConversationEvent` rows;
- debug-only raw transcript inspection outside the conversation page.

## Frontend Live-Message Bridge

Target state: the conversation page renders `ConversationTimelineRow[]` returned
by backend projection and reconciled by ordered `conversation-events`.

Delete or replace:

- `ConversationRuntimeContext` as transcript/live merge authority;
- `useConversationRuntimeBridge`;
- `buildLiveMessageFromEvents` and equivalent raw Agent event folding in page
  components;
- local logic that merges parsed transcript turns, optimistic turns, local
  turns, and live messages as the canonical timeline.

Allowed replacement:

- a small realtime cache that applies already-normalized
  `ConversationEventEnvelope` values by sequence;
- optimistic user rows that reconcile with persisted `UserTurnCreated`.

## Legacy Event Folding

Target state: protocol folding happens in Rust projection or a shared typed
projector, not inside React pages.

Delete or replace:

- frontend folding over raw `AgentEventEnvelope[]` after `prompt_started`;
- process-message folding that exists only in UI state;
- filesChanged derivation from rendered text;
- code that treats `agent_events` as the product conversation event store.

Allowed replacement:

- `ConversationProjector`;
- `conversation_events_since`;
- fixture-tested frontend selectors over canonical timeline DTOs.

## Provider Runtime Conversation Adapters

Target state: ACP is the only live coding-agent protocol.

Delete or isolate:

- `ExecutionProcess` conversation logs as Agent workbench history;
- provider runtime commands that can create live Agent conversation rows;
- SDK bridge scripts and native-provider fallback concepts;
- old normalized conversation logs that bypass the ACP conversation service.

Allowed replacement:

- runtime/debug diagnostics;
- one-time importers that create event-sourced conversations.

## Verification Queries

Use these queries during implementation reviews:

```powershell
rg -n "parsers::loader|load_conversation_detail|load_transcript" src-tauri crates
rg -n "ConversationRuntimeContext|useConversationRuntimeBridge|buildLiveMessageFromEvents|liveMessage" frontend/src
rg -n "ExecutionProcess|provider runtime|agent_events" src-tauri crates frontend/src
```

