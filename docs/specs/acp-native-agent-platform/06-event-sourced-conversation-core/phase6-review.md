# Phase 6 Review: Frontend Store and Rendering

## Scope Reviewed

- `frontend/src/features/conversation/*`
- `frontend/src/features/agents/sendAgentRuntimeTurn.ts`
- `frontend/src/hooks/useFollowUpSend.ts`
- `frontend/src/components/logs/AgentTimelineConversation.tsx`
- `frontend/src/App.tsx`
- deleted live bridge files under `frontend/src/features/agents/`

## Result

Phase 6 is complete for the canonical conversation data path and renderer
coverage required by the event-sourced conversation core.

Implemented:

- `conversationApi` wraps start, detail, paging, permission, cancel, close,
  export, and import commands.
- `conversation-events` subscription is independent from `agent-events`.
- `conversationStore` hydrates projected detail, applies ordered events, detects
  gaps, reconciles optimistic user turns, and exposes side rows.
- `useConversationTimeline` provides loading, timeline rows, side rows, active
  turn, pending permissions, send/cancel/respond actions, and error state.
- Follow-up send uses `conversation_start_turn`.
- `AgentTimelineConversation` renders canonical timeline rows instead of the old
  transcript/live merge bridge.
- Canonical side rows now cover question requests, feedback requests,
  delegation start/completion, session notices, terminal/file-change summaries,
  usage, and errors.
- `ConversationRuntimeContext`, `useConversationRuntimeBridge`, and `liveMessage`
  were deleted.

## Verification Performed

```powershell
pnpm run frontend:check
cd frontend; pnpm exec vitest run src/features/agents/sendAgentRuntimeTurn.test.ts src/features/conversation/conversationApi.test.ts src/features/conversation/events.test.ts src/features/conversation/conversationStore.test.ts src/features/conversation/UseConversationTimeline.test.tsx
cd frontend; pnpm exec vitest run src/features/conversation
cd frontend; pnpm exec vitest run src/components/NormalizedConversation
rg -n "ConversationRuntimeContext|useConversationRuntimeBridge|buildLiveMessageFromEvents|liveMessage" frontend/src
```

All executed checks passed.

## Known Risk

No Phase 6 blocking risk remains.
