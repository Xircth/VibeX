# Projection Fixture Format

Projection fixtures define how a persisted VibeX event log becomes a stable
conversation timeline. They are the contract for backend projector tests and
frontend renderer fixtures.

## File Layout

```text
crates/db/fixtures/conversation-projection/
  happy-path.json
  no-assistant-output-error.json
  permission-blocked.json
  tool-heavy.json
  terminal.json
  file-change.json
  question-feedback-delegation.json
  session-recovery.json
```

Each fixture contains:

```json
{
  "name": "happy-path",
  "projectionVersion": 1,
  "conversation": {
    "id": "00000000-0000-0000-0000-000000000001",
    "title": "Fixture conversation",
    "status": "completed"
  },
  "events": [],
  "expectedTimeline": [],
  "expectedState": {}
}
```

## Event Envelope Shape

```json
{
  "id": "00000000-0000-0000-0000-000000000101",
  "conversationId": "00000000-0000-0000-0000-000000000001",
  "turnId": "00000000-0000-0000-0000-000000000201",
  "sequence": 1,
  "source": "user",
  "createdAt": "2026-06-14T00:00:00Z",
  "event": {
    "kind": "user_turn_created",
    "blocks": [{ "kind": "text", "text": "Implement the change" }]
  }
}
```

Rules:

- `sequence` is strictly increasing per conversation.
- `turnId` is required for turn-scoped events and absent for global session
  notices.
- `raw` ACP payloads may be included for diagnostics, but expected timelines
  assert normalized event behavior only.

## Required Fixture Cases

### Happy Path

Events:

- `ConversationCreated`
- `AgentBindingReady`
- `UserTurnCreated`
- `UserTurnStarted`
- `AssistantTextDelta`
- `UsageUpdated`
- `TurnCompleted`

Expected:

- one `message_turn` row;
- user text visible;
- assistant text folded into the same turn;
- status `completed`;
- usage attached to the turn.

### No Assistant Output Error

Events:

- `UserTurnCreated`
- `UserTurnStarted`
- `TurnFailed`

Expected:

- user message remains visible;
- one `turn_error` row is rendered;
- no empty assistant placeholder is treated as success.

### Permission Blocked

Events:

- `UserTurnCreated`
- `UserTurnStarted`
- `PermissionRequested`
- `TurnBlocked`
- `PermissionResponded`
- `AssistantTextDelta`
- `TurnCompleted`

Expected:

- pending permission row appears before response;
- turn status changes from `blocked` to `completed`;
- permission response remains auditable.

### Tool Heavy

Events:

- `ToolCallUpsert` with raw input;
- `ToolCallUpsert` with appended output;
- `ToolCallUpsert` with locations/images/metadata;
- `AssistantTextDelta`;
- `TurnCompleted`.

Expected:

- tool card updates in place by `tool_call_id`;
- raw output append does not create duplicate tools;
- assistant text after a tool can start a new display group inside the same
  turn.

### Terminal

Events:

- `TerminalUpdated` created/running;
- `TerminalUpdated` output summary;
- `TerminalUpdated` exited;
- `TurnCompleted` or `TurnFailed`.

Expected:

- terminal summary row is folded by terminal id;
- truncated output is represented explicitly;
- exit status is visible.

### File Change

Events:

- `ToolCallUpsert` with file hints;
- `FileChangeSummaryUpdated` from checkpoint diff;
- `TurnCompleted`.

Expected:

- checkpoint diff wins conflicts with unstructured tool text;
- `filesChanged` attaches to the turn;
- added/modified/deleted/renamed paths are stable.

### Question, Feedback, Delegation

Events:

- `QuestionRequested` / `QuestionResponded`;
- `FeedbackRequested` / `FeedbackSubmitted`;
- `DelegationStarted` / `DelegationCompleted`.

Expected:

- rows render with stable ids;
- responses update existing rows;
- delegated activity is visible without becoming a separate transcript source.

### Session Recovery

Events:

- `AgentBindingLoadFailed`;
- `AgentBindingRecovered` or `AgentBindingRecoveryFailed`;
- optional new `AgentBindingReady`.

Expected:

- stale or missing ACP session never renders as an empty conversation;
- recovery result is visible as a session notice;
- existing VibeX timeline remains intact.

## Self-Review Rules

Every fixture must assert:

- timeline row count;
- row order;
- turn status;
- tool/permission/question/delegation idempotency;
- file change attachment;
- visible terminal error for failed send paths.

