# Phase 2 T2.16 Renderer Entry Audit

Date: 2026-06-13

## Scope

This audit verifies that Phase 2 conversation rendering has one active renderer path:

`Entries/AgentEvents -> VirtualizedList -> DisplayConversationEntry -> NormalizedConversation/*`

Kanban session conversations and IDE/log dock panels both mount `VirtualizedList`. Phase 3 imported conversation preview has no separate UI entry yet; its adapter path is covered by `ContentPartsRenderer` and `adaptContentParts`.

## Search Results

Command:

```powershell
rg -n "ReactMarkdown|ToolCallCard|AggregatedThinkingCard|ConversationThread" frontend/src -S
```

Findings:

- `ReactMarkdown` is only imported by `frontend/src/components/NormalizedConversation/Markdown.tsx`.
- `ToolCallCard` and its wrappers are only imported within `frontend/src/components/NormalizedConversation/DisplayConversationEntry.tsx` and tests/fixtures.
- `AggregatedThinkingCard` is defined under `NormalizedConversation` and consumed by `VirtualizedList` as the unified aggregated-thinking row renderer.
- No separate `ConversationThread` implementation exists outside the current `VirtualizedList` route.

Additional search:

```powershell
rg -n "NormalizedConversation|DisplayConversationEntry|ContentPartsRenderer|VirtualizedList" frontend/src/components frontend/src/pages frontend/src/features -S
```

Findings:

- Kanban route: `KanbanSessionConversationView.tsx` mounts `VirtualizedList`.
- IDE/logs route: `DockviewLogsPanel.tsx` mounts `VirtualizedList`.
- Preview panel imports only `NormalizedConversation/Markdown` and `FileContentView` for document/file preview, not a second conversation renderer.
- Imported-agent types exist in `features/agents/types.ts`; rendering is routed through `adaptContentParts`/`ContentPartsRenderer` until Phase 3 adds the full import UI.

## Verification

```powershell
cd frontend
pnpm exec vitest run src/components/kanban/KanbanSessionConversationView.test.tsx src/components/panels/DockviewLogsPanel.test.tsx src/lib/conversation-rendering/adaptContentParts.test.ts
```

Result: 3 files, 25 tests passed.

The test run emitted existing React Router future-flag warnings only.
